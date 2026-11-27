// The questions a plan asks before an issue is implemented (implement.plan with ready false). A fact only the reporter
// knows goes to the author as one comment on the issue from the bot, when the repo approves comments; a product, design or
// scope choice (or a size split) goes to the maintainers as the issue's workflow recommendation, with the plan's options as
// its numbered parts and its recommended option. Every question is one `question` round with its audience, so the planner
// waits on the newest one and plans again on the answer after it (an `answer` round, written when a maintainer answers the
// recommendation, or the author's comment). After QUESTION_ROUNDS_MAX rounds of questions the maintainers are asked instead
// whether to go on with stated assumptions; closing the issue or leaving it in the backlog are commands of their own.
import type { Db } from "../db/index.ts";
import { addRounds, attemptNow, writeStep, type NewRound } from "./attempt.ts";
import { PLAN_QUESTION_CHARS, QUESTION_ROUNDS_MAX, type PlanAsked } from "./plan-types.ts";
import type { AnswerRound, Implementation, ImplementationRound, PlanQuestion, PlanReply, QuestionRound } from "./types.ts";

/** The audit and GitHub writer login of the implement stage's own writes. */
export const IMPLEMENT_ASKER = "implement";
export type QuestionOption = NonNullable<QuestionRound["options"]>[number];
/** The option of the question asked after QUESTION_ROUNDS_MAX rounds of questions. */
export const LIMIT_IMPLEMENT: QuestionOption = { key: "implement", label: "Implement with the stated assumptions", hint: "Plan again without asking; the plan states each assumption it makes and the PR lists them." };

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The comment that asks the author: their questions, numbered when there are several. */
export function authorComment(qs: readonly PlanQuestion[]): string {
  const texts = qs.map((q) => cut(q.text.trim(), PLAN_QUESTION_CHARS));
  const body = texts.length === 1 ? texts[0]! : texts.map((t, i) => `${i + 1}. ${t}`).join("\n");
  return `Before this can be implemented, a few details are needed:\n\n${body}`;
}

export type QuestionDeps = {
  /** Comments are approved on the repo: author questions can be posted. */
  commentsApproved: boolean;
  /** Posts the comment on the issue (write.ts via the caller's grant); returns the comment's id, or throws. */
  postComment(text: string): Promise<string | null>;
  log(line: string): void;
  now?: () => string;
};

/** The maintainers' question as a round: its options keyed o1..o3 (none for a question that only words answer) and the recommended one. */
function maintainerRound(q: PlanQuestion): QuestionRound {
  const options = q.options.slice(0, 3).map((o, i) => ({ key: `o${i + 1}`, label: cut(o.label, 80), hint: cut(o.hint, 200) }));
  const usable = options.length >= 2 ? options : [];
  const rec = q.recommended === null ? -1 : q.options.findIndex((o) => o.label === q.recommended);
  return { audience: "maintainer", text: cut(q.text, PLAN_QUESTION_CHARS), options: usable, recommended: rec >= 0 && rec < usable.length ? usable[rec]!.key : null };
}

/**
 * Asks what the reply's questions need and moves the attempt to `asked`. `planRound` is the id of the plan round the reply
 * is stored in (its questions are counted with the earlier ones). Running it again on the same plan round writes only what
 * an earlier run did not: a comment or question already recorded in a question round after the plan round is not made again.
 * Returns the rounds written.
 */
export async function askQuestions(db: Db, impl: Implementation, reply: PlanReply, deps: QuestionDeps, planRound: number): Promise<QuestionRound[]> {
  const at = deps.now?.() ?? new Date().toISOString();
  const ref = `${impl.repo}#${impl.number}`;
  const rounds = (await attemptNow(db, impl))?.rounds ?? [];
  const asked = rounds.filter((r) => r.kind === "plan" && r.id <= planRound && (r.result as { ready?: unknown } | null)?.ready === false).length;
  const before = rounds.filter((r) => r.kind === "question" && r.id > planRound).map((r) => r.result as Partial<QuestionRound> | null);
  const did = (audience: QuestionRound["audience"]): boolean => before.some((q) => q?.audience === audience);
  const written: QuestionRound[] = [];
  // The attempt moves on, and records which plan round it moved on from (plan_call_id), with the maintainers' rounds in one write.
  const moveOn = async (maintainer: QuestionRound[]): Promise<void> => {
    await writeStep(db, impl, { to: "asked", patch: { planCallId: impl.planCallId }, rounds: maintainer.map((q): NewRound => ({ kind: "question", callId: impl.planCallId, result: q })), at });
    written.push(...maintainer);
  };

  // Past the limit (this reply's round included): the maintainers choose whether to go on.
  if (asked > QUESTION_ROUNDS_MAX) {
    const text = `Implement ${ref} with the stated assumptions? The plan still has open questions after ${QUESTION_ROUNDS_MAX} rounds.`;
    await moveOn(did("maintainer") ? [] : [{ audience: "maintainer", text, options: [LIMIT_IMPLEMENT], recommended: LIMIT_IMPLEMENT.key, limit: true }]);
    deps.log(`${ref}: ${asked - 1} rounds of questions; asked the maintainers whether to go on`);
    return written;
  }

  let author = reply.questions.filter((q) => q.audience === "author");
  const maintainer = reply.questions.filter((q) => q.audience === "maintainer");
  if (author.length && !deps.commentsApproved) {
    deps.log(`${ref}: comments are not approved on ${impl.repo}; the author question goes to the maintainers`);
    maintainer.push(...author.map((q) => ({ ...q, audience: "maintainer" as const })));
    author = [];
  }

  if (author.length && !did("author")) {
    const text = authorComment(author);
    const commentId = await deps.postComment(text);
    // Recorded at once: a rerun after the post does not post again.
    const qs = author.map((q): QuestionRound => ({ audience: "author", text: q.text, ...(commentId !== null && { commentId }) }));
    await addRounds(db, impl.id, qs.map((q) => ({ kind: "question", callId: impl.planCallId, result: q })), at);
    written.push(...qs);
    deps.log(`${ref}: asked the author${commentId !== null ? ` (comment ${commentId})` : ""}`);
  }

  // The question with options is the newest round, so it is the one the recommendation shows; the others are also open.
  const [first, ...rest] = maintainer;
  const toAsk = first && !did("maintainer") ? [...rest.map((q): QuestionRound => ({ audience: "maintainer", text: cut(q.text, PLAN_QUESTION_CHARS), options: [], recommended: null })), maintainerRound(first)] : [];
  await moveOn(toAsk);
  if (toAsk.length) deps.log(`${ref}: asked the maintainers`);
  return written;
}

/** The newest question round and the newest answer after it, or nulls. */
export function openQuestion(rounds: readonly ImplementationRound[]): { question: ImplementationRound | null; answer: AnswerRound | null } {
  const question = rounds.filter((r) => r.kind === "question").at(-1) ?? null;
  const a = rounds.filter((r) => r.kind === "answer" && r.id > (question?.id ?? 0)).at(-1);
  return { question, answer: a?.result && typeof a.result === "object" ? a.result as AnswerRound : null };
}

/** An answer as the plan reads it: the option's label, then the words the person wrote. */
function answerText(a: AnswerRound, q: Partial<QuestionRound> | null): string | null {
  const label = a.option !== undefined ? q?.options?.find((o) => o.key === a.option)?.label ?? a.option : null;
  const words = a.text?.trim() || null;
  return label && words ? `${label}: ${words}` : label ?? words;
}

/**
 * The attempt's earlier questions with what answered them: a maintainers' question carries the first answer after it (one
 * answer settles every question of one ask); an author question's answer is in the comments.
 */
export function askedSoFar(rounds: readonly ImplementationRound[]): PlanAsked[] {
  const out: PlanAsked[] = [];
  for (const r of rounds) {
    if (r.kind !== "question") continue;
    const q = r.result as Partial<QuestionRound> | null;
    if (!q || (q.audience !== "author" && q.audience !== "maintainer") || typeof q.text !== "string") continue;
    let answer: string | null = null;
    if (q.audience === "maintainer") {
      const a = rounds.find((x) => x.kind === "answer" && x.id > r.id);
      // The answer's label comes from the options of the question round it names.
      const named = a ? rounds.find((x) => x.id === (a.result as Partial<AnswerRound> | null)?.question) : undefined;
      if (a?.result && typeof a.result === "object") answer = answerText(a.result as AnswerRound, (named?.result ?? q) as Partial<QuestionRound> | null);
    }
    out.push({ audience: q.audience, text: q.text, at: r.at, answer });
  }
  return out;
}
