// The plan bucket of the implement step: one Opus call (implement.plan) in a workspace at the default branch head, on the
// queuer's Task Runner, that reads the issue, its comments and the thread's guidance and either plans the change or asks
// (questions.ts). The reply is parsed strictly; an unusable reply, or an author question that the reference lint flags,
// gets one follow-up turn in the same session. After the reply the tree is reset, so the session starts clean.
import { createHash } from "node:crypto";
import type { Db } from "../db/index.ts";
import { exec } from "../fixup/git.ts";
import { guardItem } from "../core/guard.ts";
import { byOfJob } from "../core/gates.ts";
import { commentApprovalOf } from "../act/approval.ts";
import { textHash } from "../core/open-prs.ts";
import { actionable } from "../decisions.ts";
import { ghComment } from "../github/write.ts";
import { ownLoginTest } from "../github/identity.ts";
import { ITEM_SERVER, itemTools } from "../itemtools/index.ts";
import { claudeParts, CLAUDE_PROMPTS } from "../prompts/index.ts";
import { referenceDir } from "../reference.ts";
import { defaultSemanticDeps, referenceProblems, type PublicText } from "../reference-lint.ts";
import { REFERENCE_SERVER, promptTier } from "../remote/bundle.ts";
import { fixTurnMessage, mergeFixFields } from "../replylint.ts";
import { isBotLogin } from "../review/bots.ts";
import { settleMemo, settlesNow } from "../settlers.ts";
import { endWorkspace } from "../build/workspaces.ts";
import type { StepContext } from "../runner/steps.ts";
import { queuerOf } from "./gate.ts";
import { repoWorkflow } from "../workflow/store.ts";
import {
  PLAN_ACCEPTANCE_MAX, PLAN_BODY_CHARS, PLAN_COMMENT_CHARS, PLAN_COMMENTS_MAX, PLAN_GUIDANCE_CHARS, PLAN_GUIDANCE_MAX, PLAN_ITEM_CHARS, PLAN_ITEMS_MAX, PLAN_MAX_TURNS,
  PLAN_OPTIONS_MAX, PLAN_PART_FILES_MAX, PLAN_PART_TITLE_CHARS, PLAN_PARTS_MAX, PLAN_QUESTION_CHARS, PLAN_QUESTIONS_MAX, PLAN_RECOMMENDATION_CHARS, PLAN_SUMMARY_CHARS,
  PLAN_TEXT_CHARS, PLAN_TIMEOUT_SEC,
  type PlanAsked, type PlanGuidance, type PlanInput, type PlanIssue,
} from "./plan-types.ts";
import { closeOnAnswer } from "./close.ts";
import { askedSoFar, askQuestions, IMPLEMENT_ASKER, isLimitDecision, LIMIT_CLOSE, LIMIT_CLOSE_COMMENT, LIMIT_IMPLEMENT, settleQuestions, type QuestionDeps } from "./questions.ts";
import { addRound, currentImplementation, roundsOf, setImplementationState, startImplementation, updateImplementation } from "./store.ts";
import { attemptGuidance, markStuck, STUCK_CAUSES, type StuckCause } from "./stuck.ts";
import type { AskFailedRound, Implementation, PlanQuestion, PlanReply, PlanWorkflow } from "./types.ts";
import { mainHeadOf, readyWorkspace, resetTree, runBoundCall, WorkspaceUnavailable, type CallResult } from "./workspace.ts";

export const PLAN_PROMPT_ID = "implement.plan";
const PROMPT = CLAUDE_PROMPTS[PLAN_PROMPT_ID];
export const PLAN_PROMPT_VERSION = createHash("sha256").update(PROMPT.template).digest("hex").slice(0, 10);

// ---- the reply -------------------------------------------------------------------------------------------------

const KINDS = ["bugfix", "feature", "change"] as const;
const SIZES = ["S", "M", "L", "XL"] as const;
const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const texts = (v: unknown, what: string, max = PLAN_ITEMS_MAX): string[] => {
  if (!Array.isArray(v) || v.length > max || !v.every((x) => typeof x === "string")) throw new Error(`${what} must be a list of at most ${max} texts`);
  const out = (v as string[]).map((s) => s.trim()).filter(Boolean);
  if (out.some((s) => s.length > PLAN_ITEM_CHARS)) throw new Error(`each item of ${what} must be at most ${PLAN_ITEM_CHARS} characters`);
  return out;
};

/** The JSON text of a reply: the whole content of its one fenced block, or the text from the first "{" to the last "}". */
function jsonOf(text: string): string {
  const fences = [...text.matchAll(/```[a-z]*\s*\n([\s\S]*?)\n\s*```/g)];
  if (fences.length > 1) throw new Error("the reply holds more than one fenced block");
  if (fences.length === 1) return fences[0]![1]!;
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("the reply holds no JSON object");
  return text.slice(a, b + 1);
}

function question(v: unknown, i: number): PlanQuestion {
  const q = v as Partial<Record<keyof PlanQuestion, unknown>> | null;
  const at = `questions[${i}]`;
  if (!q || typeof q !== "object") throw new Error(`${at} must be an object`);
  if (q.audience !== "author" && q.audience !== "maintainer") throw new Error(`${at}.audience must be author or maintainer`);
  if (!isText(q.text) || q.text.length > PLAN_QUESTION_CHARS) throw new Error(`${at}.text must be text of at most ${PLAN_QUESTION_CHARS} characters`);
  const raw = q.options ?? [];
  if (!Array.isArray(raw)) throw new Error(`${at}.options must be a list`);
  const options = raw.map((o: unknown, k) => {
    const x = o as { label?: unknown; hint?: unknown } | null;
    if (!x || !isText(x.label) || (x.hint !== undefined && typeof x.hint !== "string")) throw new Error(`${at}.options[${k}] needs a label and a hint`);
    return { label: x.label.trim(), hint: typeof x.hint === "string" ? x.hint.trim() : "" };
  });
  if (q.audience === "author" && options.length) throw new Error(`${at} asks the author and has options: an author question has none`);
  if (q.audience === "maintainer" && (options.length < 2 || options.length > PLAN_OPTIONS_MAX)) throw new Error(`${at} asks the maintainers and needs 2 to ${PLAN_OPTIONS_MAX} options`);
  if (new Set(options.map((o) => o.label)).size !== options.length) throw new Error(`${at} repeats an option label`);
  const rec = q.recommended ?? null;
  if (rec !== null && (typeof rec !== "string" || !options.some((o) => o.label === rec))) throw new Error(`${at}.recommended must be one of its option labels or null`);
  return { audience: q.audience, text: q.text.trim(), options, recommended: rec };
}

/**
 * The maintainer-workflow fields of a reply (`parts`, `recommendation`); null when it has neither. Anything malformed reads as
 * absent, so these fields never make a reply unusable: a part without a title is left out, a path is kept relative to the root.
 */
export function parsePlanWorkflow(o: Record<string, unknown>): PlanWorkflow | null {
  if (!("parts" in o) && !("recommendation" in o)) return null;
  const parts: PlanWorkflow["parts"] = [];
  for (const p of Array.isArray(o.parts) ? o.parts.slice(0, PLAN_PARTS_MAX) : []) {
    const x = p as { title?: unknown; files?: unknown } | null;
    if (!x || typeof x !== "object" || !isText(x.title)) continue;
    const files = (Array.isArray(x.files) ? x.files : []).filter(isText).map((f) => f.trim().replace(/^(\.\/|\/+)/, "")).filter(Boolean).slice(0, PLAN_PART_FILES_MAX);
    parts.push({ title: x.title.replace(/\s+/g, " ").trim().slice(0, PLAN_PART_TITLE_CHARS), files: [...new Set(files)] });
  }
  return { parts, recommendation: isText(o.recommendation) ? o.recommendation.replace(/\s+/g, " ").trim().slice(0, PLAN_RECOMMENDATION_CHARS) : null };
}

/** Reads a plan reply; throws with what is wrong. `assume`: a maintainer chose to go on, so the reply must be ready. */
export function parsePlanReply(text: string, assume = false): PlanReply {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(jsonOf(text)) as Record<string, unknown>;
  } catch (e) {
    throw new Error(e instanceof SyntaxError ? "the JSON does not parse" : (e as Error).message);
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("the reply must be one JSON object");
  if (typeof o.ready !== "boolean") throw new Error("ready must be true or false");
  if (!KINDS.includes(o.kind as never)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
  if (!SIZES.includes(o.size as never)) throw new Error(`size must be one of ${SIZES.join(", ")}`);
  if (!isText(o.summary) || o.summary.length > PLAN_SUMMARY_CHARS) throw new Error(`summary must be text of at most ${PLAN_SUMMARY_CHARS} characters`);
  if (!isText(o.plan) || o.plan.length > PLAN_TEXT_CHARS) throw new Error(`plan must be text of at most ${PLAN_TEXT_CHARS} characters`);
  const v = o.verification as { tests?: unknown; app?: unknown } | null | undefined;
  if (!v || typeof v !== "object") throw new Error("verification must be an object with tests and app");
  if (v.app !== null && v.app !== undefined && (typeof v.app !== "string" || v.app.length > PLAN_ITEM_CHARS)) throw new Error(`verification.app must be text of at most ${PLAN_ITEM_CHARS} characters, or null`);
  if (!Array.isArray(o.questions ?? [])) throw new Error("questions must be a list");
  const reply: PlanReply = {
    ready: o.ready, kind: o.kind as PlanReply["kind"], summary: o.summary.trim(), plan: o.plan.trim(),
    acceptance: texts(o.acceptance ?? [], "acceptance", PLAN_ACCEPTANCE_MAX),
    verification: { tests: texts(v.tests ?? [], "verification.tests"), app: isText(v.app) ? v.app.trim() : null },
    size: o.size as PlanReply["size"], risks: texts(o.risks ?? [], "risks"),
    questions: ((o.questions ?? []) as unknown[]).map(question),
  };
  const workflow = parsePlanWorkflow(o);
  if (workflow) reply.workflow = workflow;
  if (reply.ready && (!reply.acceptance.length || reply.questions.length)) throw new Error(`a ready reply needs 1 to ${PLAN_ACCEPTANCE_MAX} acceptance criteria and no questions`);
  // An XL change does not fit one PR: it is not ready, and asks the maintainers how to split it.
  if (reply.ready && reply.size === "XL") throw new Error("a ready reply cannot be size XL: a change of that size does not fit one pull request, so set ready to false and ask the maintainers how to split it");
  if (!reply.ready && (!reply.questions.length || reply.questions.length > PLAN_QUESTIONS_MAX)) throw new Error(`a reply that is not ready needs 1 to ${PLAN_QUESTIONS_MAX} questions`);
  if (!reply.ready && assume) throw new Error("assume is true: the maintainers chose to go on, so the reply must be ready, with each assumption as a risk");
  return reply;
}

/** The reply's texts that go public: the plan in the PR body (summary, plan, acceptance, verification, risks) and the author questions on the issue. */
export function publicTexts(r: PlanReply): PublicText[] {
  return [
    { field: "summary", text: r.summary }, { field: "plan", text: r.plan },
    ...r.acceptance.map((text, i) => ({ field: `acceptance[${i}]`, text })), ...r.risks.map((text, i) => ({ field: `risks[${i}]`, text })),
    ...r.verification.tests.map((text, i) => ({ field: `verification.tests[${i}]`, text })), ...(r.verification.app ? [{ field: "verification.app", text: r.verification.app }] : []),
    ...r.questions.flatMap((q, i) => (q.audience === "author" ? [{ field: `questions[${i}].text`, text: q.text }] : [])),
    // The status comment on GitHub shows the parts and the recommendation.
    ...(r.workflow?.parts ?? []).map((p, i) => ({ field: `parts[${i}].title`, text: p.title })),
    ...(r.workflow?.recommendation ? [{ field: "recommendation", text: r.workflow.recommendation }] : []),
  ];
}

/** The plan as Markdown, for the item page and the PR body. */
export function planMarkdown(r: PlanReply): string {
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
  return [
    `**${r.kind}, size ${r.size}.** ${r.summary}`, r.plan,
    r.acceptance.length ? `**Acceptance**\n\n${list(r.acceptance)}` : "",
    r.verification.tests.length || r.verification.app ? `**Verification**\n\n${list([...r.verification.tests.map((t) => `\`${t.replace(/`/g, "'")}\``), ...(r.verification.app ? [r.verification.app] : [])])}` : "",
    r.risks.length ? `**Risks**\n\n${list(r.risks)}` : "",
  ].filter(Boolean).join("\n\n");
}

// ---- the input ---------------------------------------------------------------------------------------------------

const cut = (s: string | null | undefined, n: number): string => (s ?? "").slice(0, n);

/**
 * The issue, its comments (bots and our own left out: our questions come in as `asked`), the thread's guidance by operators and write-maintainers and
 * the attempt's Try again notes, and the earlier questions.
 */
export async function planInput(db: Db, o: { repo: string; number: number; sha: string; asked: PlanAsked[]; assume: boolean; implementationId: number | null }): Promise<PlanInput> {
  const it = await db.get(db.k.selectFrom("items").select(["title", "body", "author", "labels"]).where("repo", "=", o.repo).where("number", "=", o.number));
  if (!it) throw new Error(`${o.repo}#${o.number} is not in the mirror`);
  const own = await ownLoginTest(db, o.repo);
  const comments = (await db.all(db.k.selectFrom("comments").select(["author", "created_at", "body"]).where("repo", "=", o.repo).where("number", "=", o.number).orderBy("created_at").orderBy("id")))
    .filter((c) => c.author === null || (!own(c.author) && !isBotLogin(c.author)))
    .slice(-PLAN_COMMENTS_MAX).map((c) => ({ author: c.author, at: c.created_at ?? "", body: cut(c.body, PLAN_COMMENT_CHARS) }));
  let labels: string[] = [];
  try { labels = (JSON.parse(it.labels ?? "[]") as unknown[]).map(String); } catch { /* none */ }
  const issue: PlanIssue = { number: o.number, title: it.title ?? "", body: cut(it.body, PLAN_BODY_CHARS), author: it.author, labels, comments };
  const memo = settleMemo();
  const guidance: PlanGuidance[] = [];
  for (const t of await db.all(db.k.selectFrom("conversation_turns").select(["kind", "login", "at", "body"]).where("repo", "=", o.repo).where("number", "=", o.number)
    .where("kind", "in", ["operator", "maintainer"]).orderBy("at").orderBy("id"))) {
    // A maintainer's message counts while they settle on the repo (write access where the app acts for them).
    if (t.kind === "maintainer" && !await settlesNow(db, t.login, [o.repo], memo)) continue;
    guidance.push({ from: t.kind as PlanGuidance["from"], login: t.login, at: t.at, text: cut(t.body, PLAN_GUIDANCE_CHARS) });
  }
  if (o.implementationId !== null) {
    for (const g of await attemptGuidance(db, o.implementationId)) guidance.push({ from: "try-again", login: g.by ?? "", at: g.at, text: cut(g.text, PLAN_GUIDANCE_CHARS) });
    guidance.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }
  return {
    ref: `${o.repo}#${o.number}`, repo: o.repo, sha: o.sha, issue, guidance: guidance.slice(-PLAN_GUIDANCE_MAX), asked: o.asked, assume: o.assume,
    ...(await repoWorkflow(db, o.repo) === "new" ? { workflow: true } : {}),
  };
}

// ---- recording a reply -------------------------------------------------------------------------------------------

/** Stores a parsed reply on the attempt (plan_json, plan_md and a `plan` round) before anything is posted or asked. Returns the round's id. */
export async function storePlan(db: Db, impl: Implementation, r: { callId: number | null; reply: PlanReply }, at = new Date().toISOString()): Promise<number> {
  await updateImplementation(db, impl.id, { plan: r.reply, planMd: planMarkdown(r.reply) }, at);
  return await addRound(db, impl.id, "plan", { callId: r.callId, result: r.reply }, at);
}

/**
 * Moves the attempt on from its stored plan round: `planned` when ready, else `asked` with its questions (questions.ts).
 * plan_call_id records the round it moved on from, so a plan round stored but not moved on from is carried out again
 * (unfinishedPlan) without a new plan call. Running it again on the same round does not post or ask twice.
 */
export async function finishPlan(db: Db, impl: Implementation, p: { round: number; callId: number | null; reply: PlanReply }, q: QuestionDeps): Promise<Implementation["state"]> {
  const at = q.now?.() ?? new Date().toISOString();
  if (p.reply.ready) {
    await settleQuestions(db, impl, null, at);
    await setImplementationState(db, impl.id, "planned", { decisionId: null, planCallId: p.callId }, at);
    return "planned";
  }
  await askQuestions(db, { ...impl, planCallId: p.callId }, p.reply, q, p.round);
  return "asked";
}

/** Stores a parsed reply and moves the attempt on (storePlan, then finishPlan). */
export async function recordPlan(db: Db, impl: Implementation, r: { callId: number | null; reply: PlanReply }, q: QuestionDeps): Promise<Implementation["state"]> {
  const round = await storePlan(db, impl, r, q.now?.());
  return await finishPlan(db, impl, { round, ...r }, q);
}

/** The attempt's newest plan round when the attempt has not moved on from it (its plan_call_id is another call's), or null. */
export async function unfinishedPlan(db: Db, impl: Implementation): Promise<{ round: number; callId: number | null; reply: PlanReply } | null> {
  if (impl.state !== "planning") return null;
  const last = (await roundsOf(db, impl.id)).filter((r) => r.kind === "plan").at(-1);
  if (!last || last.callId === impl.planCallId) return null;
  try {
    return { round: last.id, callId: last.callId, reply: parsePlanReply(JSON.stringify(last.result)) };
  } catch {
    return null;
  }
}

// ---- the job -----------------------------------------------------------------------------------------------------

export type PlanOptions = { repo: string; number: number; /** Nothing is written but the workspace and the call: no implementation row, no GitHub write, no decision. */ dry: boolean };

/** What one plan call and its follow-up turn came to. */
type Planned = { callId: number; reply: PlanReply } | { callId: number | null; error: string; cause: StuckCause };

/** Failed tries at posting or asking one stored plan round's questions before the attempt is stuck. */
const ASK_TRIES = 3;

/** Runs the plan call, with one follow-up turn on an unusable reply or on flagged public text. */
async function callPlan(ctx: StepContext, o: { repo: string; number: number; sha: string; workspaceId: number; forLogin: string; input: PlanInput }): Promise<Planned> {
  const parts = claudeParts(PLAN_PROMPT_ID, [o.input], false);
  const dir = referenceDir(o.repo);
  const servers = [...(itemTools() ? [ITEM_SERVER] : []), ...(dir ? [REFERENCE_SERVER] : [])];
  const base = {
    workspaceId: o.workspaceId, repo: o.repo, number: o.number, baseSha: o.sha, forLogin: o.forLogin, promptId: PLAN_PROMPT_ID, promptVersion: PLAN_PROMPT_VERSION,
    model: PROMPT.models[0]!, tier: promptTier(PLAN_PROMPT_ID), effort: PROMPT.effort, system: parts.system, timeoutSeconds: PLAN_TIMEOUT_SEC, maxTurns: PLAN_MAX_TURNS,
    items: [{ repo: o.repo, number: o.number }], servers, ...(dir && { referenceRepo: dir.split("/").pop()! }), keepSession: true,
  };
  const turn = async (stdin: string, parentId?: number): Promise<CallResult> => await runBoundCall(ctx, { ...base, stdin, ...(parentId !== undefined && { parentId }) });
  const failed = (r: CallResult): Planned => ({ callId: r.callId, cause: "plan-failed", error: r.outcome.state === "failed" ? r.outcome.error.replace(/\s+/g, " ").slice(0, 200) : "the call was not taken" });
  const lint = async (reply: PlanReply) => await referenceProblems(publicTexts(reply), dir, dir ? defaultSemanticDeps(ctx.db, `${o.repo}#${o.number}`) : undefined);

  let r = await turn(parts.stdin);
  if (r.outcome.state !== "done") return failed(r);
  let reply: PlanReply;
  let followed = false;
  try {
    reply = parsePlanReply(r.outcome.text, o.input.assume);
  } catch (e) {
    ctx.log(`${o.repo}#${o.number}: follow-up turn on plan call ${r.callId}: the reply could not be used`);
    r = await turn(`Your reply could not be used: ${(e as Error).message}. Reply again with ONLY the whole JSON object as the instructions describe.`, r.callId);
    if (r.outcome.state !== "done") return failed(r);
    try {
      reply = parsePlanReply(r.outcome.text, o.input.assume);
    } catch (e2) {
      return { callId: r.callId, cause: "plan-unparseable", error: (e2 as Error).message };
    }
    followed = true;
  }
  let flagged = await lint(reply);
  if (flagged.length && !followed) {
    // The follow-up sends only the corrected fields; they go into the reply, which stays as it was otherwise.
    ctx.log(`${o.repo}#${o.number}: follow-up turn on plan call ${r.callId}: ${flagged.length} lint problem(s)`);
    const first = reply;
    r = await turn(fixTurnMessage(flagged), r.callId);
    if (r.outcome.state !== "done") return failed(r);
    // The reply as the model wrote it: the maintainer-workflow fields are top-level there, as parsePlanReply reads them.
    const { workflow: own, ...plain } = first;
    const merged = mergeFixFields(JSON.stringify(own ? { ...plain, ...own } : plain), r.outcome.text, flagged);
    if (merged !== null) {
      try {
        const fixed = parsePlanReply(merged, o.input.assume);
        flagged = await lint(fixed);
        reply = fixed;
      } catch (e) {
        ctx.log(`${o.repo}#${o.number}: the corrected fields could not be used (${(e as Error).message}); the first reply stands`);
      }
    }
  }
  if (!flagged.length) return { callId: r.callId, reply };
  // Still flagged after the follow-up: a flagged author question goes to the maintainers instead of being posted;
  // flagged plan text would reach the PR body, so the attempt stops.
  const fields = flagged.map((p) => p.field);
  if (fields.some((f) => !f.startsWith("questions["))) return { callId: r.callId, cause: "plan-flagged", error: [...new Set(fields)].join(", ") };
  const bad = new Set(flagged.map((p) => p.text));
  ctx.log(`${o.repo}#${o.number}: ${bad.size} author question(s) still flagged by the reference lint; asking the maintainers instead`);
  return { callId: r.callId, reply: { ...reply, questions: reply.questions.map((q) => (q.audience === "author" && bad.has(q.text) ? { ...q, audience: "maintainer" as const } : q)) } };
}

/** Whether the attempt's limit decision is answered, by someone who settles on the repo (actionable()), with Close or to go on with assumptions, or neither. */
async function limitAnswer(db: Db, impl: Implementation): Promise<"close" | "implement" | null> {
  if (!isLimitDecision(impl.decisionId)) return null;
  const a = (await actionable(db)).find((x) => x.id === impl.decisionId);
  return a?.answer === LIMIT_CLOSE.key ? "close" : a?.answer === LIMIT_IMPLEMENT.key ? "implement" : null;
}

/** Makes the attempt stuck and asks its decision (stuck.ts). */
async function stuck(db: Db, impl: Implementation, cause: StuckCause, detail: string): Promise<string> {
  const id = await markStuck(db, impl, cause, detail);
  return `${impl.repo}#${impl.number}: stuck (${cause}: ${detail}); decision ${id}`;
}

/** Carries out a Close answer on the limit decision (close.ts). A close that cannot be made as it stands makes the attempt stuck with the reason. */
async function closeOnLimit(ctx: StepContext, impl: Implementation): Promise<string> {
  const ref = `${impl.repo}#${impl.number}`;
  const r = await closeOnAnswer(ctx.db, impl, { decisionId: impl.decisionId!, answer: LIMIT_CLOSE.key, bucket: "plan", comment: LIMIT_CLOSE_COMMENT }, { by: byOfJob(ctx.job.requestedBy) });
  if ("done" in r) return r.done;
  if ("waiting" in r) return `${ref}: not closed yet: ${r.waiting}`;
  return await stuck(ctx.db, impl, "close-failed", r.refused);
}

/**
 * Moves the attempt on from a stored plan round (finishPlan) with the job's GitHub grant. A failed post or ask is recorded
 * and the job fails, so the next job tries the write again from the stored round; after ASK_TRIES failures the attempt is stuck.
 */
async function moveOn(ctx: StepContext, impl: Implementation, p: { round: number; callId: number | null; reply: PlanReply }): Promise<string> {
  const db = ctx.db, ref = `${impl.repo}#${impl.number}`;
  const g = await guardItem(db, { repo: impl.repo, number: impl.number }, { kind: "implement", bucket: "plan" }, byOfJob(ctx.job.requestedBy));
  let state: Implementation["state"];
  try {
    state = await finishPlan(db, impl, p, {
      commentsApproved: await commentApprovalOf(db, impl.repo) !== null && !("refused" in g),
      postComment: async (text) => {
        if ("refused" in g) throw new Error(g.refused);
        const r = await ghComment({ db, login: IMPLEMENT_ASKER }, g, exec, "implement-question", { repo: impl.repo, number: impl.number, pr: false }, { by: "model", kind: "comment", model: PROMPT.models[0] }, text, { call: p.callId, round: p.round });
        if (r.code !== 0) throw new Error(`the question comment failed: ${r.stderr.replace(/\s+/g, " ").slice(0, 200)}`);
        return /#issuecomment-(\d+)/.exec(r.stdout)?.[1] ?? null;
      },
      log: ctx.log,
    });
  } catch (e) {
    const error = (e as Error).message.replace(/\s+/g, " ").slice(0, 300);
    await addRound(db, impl.id, "ask-failed", { callId: p.callId, result: { planRound: p.round, error } satisfies AskFailedRound });
    const tries = (await roundsOf(db, impl.id)).filter((r) => r.kind === "ask-failed" && (r.result as Partial<AskFailedRound> | null)?.planRound === p.round).length;
    if (tries >= ASK_TRIES) return await stuck(db, impl, "question-failed", `${tries} tries: ${error}`);
    throw new Error(`${ref}: the questions of plan round ${p.round} were not posted (try ${tries} of ${ASK_TRIES}); the next job tries again from the stored plan: ${error}`);
  }
  ctx.acted(1);
  const rounds = (await roundsOf(db, impl.id)).filter((x) => x.kind === "plan").length;
  return `${ref}: plan round ${rounds}: ${state === "planned" ? "planned" : "asked"} (call ${p.callId}, size ${p.reply.size})`;
}

/** The `implement` job's plan bucket. Returns the one-line summary. */
export async function runPlan(ctx: StepContext, o: PlanOptions): Promise<string> {
  const db = ctx.db, ref = `${o.repo}#${o.number}`;
  const queuer = await queuerOf(db, o.repo, o.number);
  if (!queuer) throw new Error(`${ref} is not queued`);
  const item = await db.get(db.k.selectFrom("items").select(["title", "body", "state"]).where("repo", "=", o.repo).where("number", "=", o.number));
  if (!item || item.state !== "OPEN") throw new Error(`${ref} is not an open issue in the mirror`);
  const hash = textHash(item.title ?? "", item.body ?? "");

  let impl: Implementation | null = null;
  let assume = false;
  let stored: { round: number; callId: number | null; reply: PlanReply } | null = null;
  if (!o.dry) {
    impl = await currentImplementation(db, o.repo, o.number) ?? await startImplementation(db, { repo: o.repo, number: o.number, queuedBy: queuer, textHash: hash });
    if (impl.state !== "planning" && impl.state !== "asked") return `${ref}: nothing to plan (implementation ${impl.id} is ${impl.state})`;
    const limit = await limitAnswer(db, impl);
    if (limit === "close") return await closeOnLimit(ctx, impl);
    assume = limit === "implement";
    // A plan round stored by an earlier job of this text that never moved on: its questions or plan are carried out
    // without a new plan call.
    stored = impl.textHash === hash ? await unfinishedPlan(db, impl) : null;
    if (stored) ctx.log(`${ref}: plan round ${stored.round} is stored and was not carried out; going on from it without a new plan call`);
    // The current text is what this round plans; a later edit plans again (issue-facts.ts textChanged).
    await setImplementationState(db, impl.id, "planning", { textHash: hash });
    impl = { ...impl, state: "planning", textHash: hash };
  }
  const forLogin = impl?.queuedBy ?? queuer;
  const sha = await mainHeadOf(db, o.repo) ?? impl?.baseSha ?? null;
  if (!sha) throw new Error(`${ref}: no head commit for the default branch of ${o.repo}`);
  ctx.log(`${ref}: planning at ${sha.slice(0, 8)} on ${forLogin}'s Task Runner${o.dry ? " (dry run: nothing is stored or posted)" : ""}`);

  // A dry run's workspace is its own and ends with the job, also when it does not get ready.
  let dryWs: number | null = null;
  const endDry = async () => { if (dryWs !== null && await endWorkspace(db, dryWs)) ctx.log(`workspace ${dryWs} ended`); dryWs = null; };
  let wsId: number;
  try {
    wsId = await readyWorkspace(ctx, {
      repo: o.repo, baseSha: sha, have: impl && impl.baseSha === sha ? impl.workspaceId : null,
      adopt: async (id) => {
        if (!impl) { dryWs = id; return; }
        await updateImplementation(db, impl.id, { workspaceId: id, baseSha: sha });
        // A re-plan on a newer head leaves the attempt's earlier workspace behind.
        if (impl.workspaceId !== null && impl.workspaceId !== id && await endWorkspace(db, impl.workspaceId)) ctx.log(`workspace ${impl.workspaceId} (at ${impl.baseSha?.slice(0, 8)}) ended`);
      },
    });
  } catch (e) {
    await endDry();
    if (e instanceof WorkspaceUnavailable && impl) return await stuck(db, impl, "workspace-lost", e.message);
    throw e;
  }
  ctx.handled(1);

  let planned: Planned;
  if (stored) planned = { callId: stored.callId ?? 0, reply: stored.reply };
  else {
    await ctx.progress(`${ref}: plan call in workspace ${wsId}`);
    const input = await planInput(db, { repo: o.repo, number: o.number, sha, asked: impl ? await askedSoFar(db, impl) : [], assume, implementationId: impl?.id ?? null });
    try {
      planned = await callPlan(ctx, { repo: o.repo, number: o.number, sha, workspaceId: wsId, forLogin, input });
    } finally {
      await endDry();
    }
    // Stored at once: a restart from here on goes on from the stored round instead of calling again.
    if (impl && "reply" in planned) stored = { round: await storePlan(db, impl, planned), callId: planned.callId, reply: planned.reply };
  }
  const reset = o.dry ? null : await resetTree(db, wsId);
  if (reset) ctx.log(`${ref}: the tree of workspace ${wsId} was not reset: ${reset}`);

  if (o.dry) {
    if ("error" in planned) throw new Error(`${ref}: ${STUCK_CAUSES[planned.cause]}: ${planned.error}`);
    const r = planned.reply;
    return `${ref}: plan call ${planned.callId}: ${r.ready ? "ready" : `${r.questions.length} question(s) (${[...new Set(r.questions.map((q) => q.audience))].join(", ")})`}, size ${r.size}; \`implement show ${ref} --call ${planned.callId}\` prints it`;
  }
  impl = impl!;
  if ("error" in planned) return await stuck(db, impl, planned.cause, planned.error);
  if (reset) return await stuck(db, impl, "reset-failed", reset);
  return await moveOn(ctx, impl, stored!);
}
