// A stuck implementation is a workflow blocker (a step failing twice): the attempt moves to `stuck` with a `question` round
// that says why and what AutoCraft can do next: Try again (a new attempt; on our open PR, the same revision again) and Open as
// draft PR (only when the change passes the PR step's diff check). Try again is recommended when it is offered. A maintainer's
// answer is an `answer` round after it, which the next build job carries out (applyStuckAnswer); closing the issue or PR,
// stopping and the backlog are commands of their own. Three attempts per issue text version at most get Try again. Three
// implementations in a row on a repo that end stuck or failed without a PR trip the repo's Implement breaker (`implement:<repo>`).
import type { Db } from "../db/index.ts";
import { addAudit, loadTrip, tripStage } from "../data/control/index.ts";
import { loadImplementFacts, loadStuckStreaks, restartAttempt, retryRevision } from "../data/implement/index.ts";
import { loadItems } from "../data/mirror/index.ts";
import { tripKey } from "../core/push-outcome.ts";
import { textHash } from "../core/open-prs.ts";
import { queuerOf } from "./gate.ts";
import { addRounds, writeStep, type Attempt } from "./attempt.ts";
import { IMPLEMENT_ASKER, openQuestion, type QuestionOption } from "./questions.ts";
import { ENDED_STATES, IMPLEMENTATION_STATES, type Implementation, type ImplementationRound, type QuestionRound } from "./types.ts";

const ACTOR = IMPLEMENT_ASKER;
const OPEN_STATES = IMPLEMENTATION_STATES.filter((s) => !ENDED_STATES.has(s));

/** Why an implementation got stuck, and the line the blocker and the row's reason start with. */
export const STUCK_CAUSES = {
  "plan-unparseable": "The plan call's reply could not be read, twice",
  "plan-failed": "The plan call failed",
  "plan-flagged": "The plan still mentions or quotes the reference documentation",
  "question-failed": "The plan's questions could not be posted or asked",
  "reset-failed": "The workspace tree could not be reset after the plan",
  "session-failed": "The implementation session failed twice",
  "session-lost": "The Task Runner kept losing the session before the checks",
  "no-report": "The session did not reply with its report",
  blocked: "The session could not finish",
  "needs-dependency": "The change needs a dependency the workspace does not have",
  "checks-failing": "AutoCraft's checks still fail after three follow-up rounds",
  "checks-no-verdict": "AutoCraft's checks gave no verdict twice (timeout, killed or did not run)",
  "no-change": "The session finished without changing anything",
  "diff-refused": "The change touches what an implementation may not change",
  "push-failed": "Pushing the branch failed repeatedly",
  "workspace-lost": "The workspace could not be started again",
  "revision-limit": "The pull request went back to the session too many times",
} as const;
export type StuckCause = keyof typeof STUCK_CAUSES;

/** Attempts per issue text version that may end stuck and still be offered Try again. */
export const MAX_ATTEMPTS_PER_TEXT = 3;
/** Implementations in a row on a repo that end stuck or failed without a PR before the repo's Implement breaker trips. */
export const STUCK_IN_A_ROW = 3;

export const STUCK_OPTIONS = {
  tryAgain: { key: "try-again", label: "Try again", hint: "Plan and implement it again in a new attempt. Text you add goes to the model as guidance." },
  draft: { key: "draft-pr", label: "Open as draft PR", hint: "Open the change as it is as a draft pull request for a person to finish." },
  reviseAgain: { key: "try-again", label: "Try again", hint: "Send the pull request back to the session for the same revision. Text you add goes to the model as guidance." },
} as const satisfies Record<string, QuestionOption>;

/** The `question` round of a stuck attempt: the blocker's options, and why it stopped. */
export type StuckQuestion = QuestionRound & { stuck: true; cause: StuckCause; facts: string[] };
export const isStuckQuestion = (r: ImplementationRound | null | undefined): boolean => r?.kind === "question" && (r.result as Partial<StuckQuestion> | null)?.stuck === true;

/**
 * Whether the attempt's change would pass the PR step's diff check (validateImplementation), so Open as draft PR can be offered.
 * The PR step provides it; without one the option is never offered.
 */
export type DiffCheck = (db: Db, impl: Implementation) => Promise<{ ok: boolean; reason?: string }>;
export const noDiffCheck: DiffCheck = async () => ({ ok: false, reason: "the diff check is not available" });

/** The hash of the issue's current title and body (or the attempt's when the issue is not in the mirror), and the attempts made on it. */
async function textTries(db: Db, impl: Implementation): Promise<{ hash: string; tries: number }> {
  const ref = `${impl.repo}#${impl.number}` as const;
  const [facts, items] = await db.together(() => Promise.all([loadImplementFacts(db, [impl]), loadItems(db, [impl], "text")]));
  const it = items.get(ref);
  const hash = it ? textHash(it.title ?? "", it.body ?? "") : impl.textHash;
  // The loader leaves out an only attempt that is not stuck yet: it is the one try.
  const counts = facts.byIssue.get(ref)?.textCounts ?? {};
  const tries = Object.keys(counts).length ? counts[hash] ?? 0 : impl.textHash === hash ? 1 : 0;
  return { hash, tries };
}

/** The blocker's question: the options that can be carried out for this attempt now, Try again recommended when offered. */
async function stuckQuestion(db: Db, impl: Implementation, cause: StuckCause, reason: string, diffCheck: DiffCheck, head?: string): Promise<StuckQuestion> {
  // A revision of our open PR is tried again on the same PR; the PR stays open, so there is no draft.
  const revising = impl.prNumber !== null;
  const { tries } = revising ? { tries: 0 } : await textTries(db, impl);
  const draft = revising || cause === "diff-refused" || cause === "no-change" ? { ok: false } : await diffCheck(db, impl);
  const options: QuestionOption[] = revising ? [STUCK_OPTIONS.reviseAgain] : [
    ...(tries < MAX_ATTEMPTS_PER_TEXT ? [STUCK_OPTIONS.tryAgain] : []),
    ...(draft.ok ? [STUCK_OPTIONS.draft] : []),
  ];
  const facts = revising ? [`revising pull request #${impl.prNumber}`, ...(impl.diffStat ? [`change: ${impl.diffStat}`] : [])] : [
    `attempt ${impl.attempt}; ${tries} of ${MAX_ATTEMPTS_PER_TEXT} on this issue text`,
    ...(impl.diffStat ? [`change: ${impl.diffStat}`] : []),
    ...(tries >= MAX_ATTEMPTS_PER_TEXT ? [`no Try again: ${MAX_ATTEMPTS_PER_TEXT} attempts were made on this issue text; editing the issue allows more`] : []),
  ];
  const text = `${head ? `${head}. ` : ""}The implementation is stuck: ${reason}.${impl.report?.summary ? ` The session's last report: ${impl.report.summary}` : ""}`.slice(0, 2000);
  return { audience: "maintainer", text, options, recommended: options.some((o) => o.key === STUCK_OPTIONS.tryAgain.key) ? STUCK_OPTIONS.tryAgain.key : null, stuck: true, cause, facts };
}

/** Moves the attempt to `stuck` with its blocker question, records it, then checks the repo's breaker. Returns the reason. */
export async function markStuck(db: Db, impl: Implementation, cause: StuckCause, detail: string | null, o: { diffCheck?: DiffCheck; at?: string } = {}): Promise<string> {
  const at = o.at ?? new Date().toISOString();
  const reason = `${STUCK_CAUSES[cause]}${detail ? `: ${detail}` : ""}`.replace(/\s+/g, " ").slice(0, 300);
  const q = await stuckQuestion(db, impl, cause, reason, o.diffCheck ?? noDiffCheck);
  const moved = await db.write(async () => {
    // An attempt that ended meanwhile (a cancel, its PR merged) keeps its end.
    if (!await writeStep(db, impl, { to: "stuck", patch: { reason }, expect: OPEN_STATES, rounds: [{ kind: "question", result: q }], at })) return false;
    await addAudit(db, [{ login: ACTOR, action: "implement-stuck", target: `${impl.repo}#${impl.number}`, details: { implementation: impl.id, cause, reason }, at }]);
    return true;
  });
  if (moved) await tripIfStuckInARow(db, impl.repo, at);
  return reason;
}

/** Trips `implement:<repo>` when the repo's last STUCK_IN_A_ROW finished implementations since its last resume all ended stuck or failed without a PR. */
export async function tripIfStuckInARow(db: Db, repo: string, at = new Date().toISOString()): Promise<boolean> {
  const key = tripKey("implement", repo);
  const t = await loadTrip(db, key);
  if (t?.active) return false;
  const rows = (await loadStuckStreaks(db, new Map([[repo, t?.clearedAt ?? ""]]), STUCK_IN_A_ROW)).get(repo) ?? [];
  if (rows.length < STUCK_IN_A_ROW || rows.some((r) => r.prNumber !== null)) return false;
  const tripped = await tripStage(db, [{ key, reason: `${STUCK_IN_A_ROW} implementations in a row in ${repo} ended stuck or failed without a PR`, evidence: rows.map((r) => `${repo}#${r.number} attempt ${r.attempt}`), at }]);
  return tripped.length > 0;
}

/** A Try again note for the attempt: who answered, when, and the text. */
export type AttemptGuidance = { by: string | null; at: string; text: string };

/** The guidance people gave the attempt (Try again notes) with who gave it, oldest first. */
export function attemptGuidance(rounds: readonly ImplementationRound[]): AttemptGuidance[] {
  return rounds.filter((r) => r.kind === "guidance").flatMap((r) => {
    const g = r.result as { text?: unknown; by?: unknown } | null;
    return typeof g?.text === "string" && g.text.trim() ? [{ by: typeof g.by === "string" ? g.by : null, at: r.at, text: g.text.trim() }] : [];
  });
}

/** The PR step opens the attempt's PR as a draft: its stuck blocker was answered Open as draft PR. */
export function opensAsDraft(rounds: readonly ImplementationRound[]): boolean {
  const { question, answer } = openQuestion(rounds);
  return isStuckQuestion(question) && answer?.option === STUCK_OPTIONS.draft.key;
}

export type StuckOutcome = { did: string; next: Implementation | null };

/**
 * Carries out the answer to a stuck attempt's blocker: Try again ends the attempt and starts a new one (the answer's words become
 * the new attempt's guidance), or sends our open PR's revision back to the session; Open as draft PR hands the attempt to the PR
 * step. An answer that cannot be carried out is asked again with the reason (a new question round, so the answer no longer
 * stands). Returns null when there is no answer to carry out.
 */
export async function applyStuckAnswer(db: Db, a: Attempt, o: { at?: string } = {}): Promise<StuckOutcome | null> {
  const at = o.at ?? new Date().toISOString();
  const impl = a.impl, ref = `${impl.repo}#${impl.number}`;
  if (impl.state !== "stuck") return null;
  const { question, answer } = openQuestion(a.rounds);
  if (!question || !isStuckQuestion(question) || !answer) return null;
  const q = question.result as StuckQuestion;
  const offered = (key: string) => (q.options ?? []).some((x) => x.key === key);
  const note = answer.text?.trim();
  const guidance = note ? { by: answer.by, text: note } : undefined;
  const again = async (why: string): Promise<StuckOutcome> => {
    const next = await stuckQuestion(db, impl, q.cause, impl.reason ?? STUCK_CAUSES[q.cause], noDiffCheck, `Not carried out: ${why}`.replace(/\s+/g, " ").slice(0, 400));
    // Open as draft PR stays offered when it was: the diff check that allowed it ran on the same change.
    const keep = offered(STUCK_OPTIONS.draft.key) && !next.options!.some((x) => x.key === STUCK_OPTIONS.draft.key) ? [...next.options!, STUCK_OPTIONS.draft] : next.options!;
    await db.write(async () => {
      await addRounds(db, impl.id, [{ kind: "question", result: { ...next, options: keep } satisfies StuckQuestion }], at);
      await addAudit(db, [{ login: ACTOR, action: "implement-reask", target: ref, details: { implementation: impl.id, answer: answer.option ?? null, by: answer.by, why }, at }]);
    });
    return { did: `not carried out (${why}); asked again`, next: null };
  };
  if (answer.option === STUCK_OPTIONS.tryAgain.key && offered(answer.option) && impl.prNumber !== null) {
    const ok = await db.write(async () => {
      if (!await retryRevision(db, { id: impl.id, guidance, at })) return false;
      await addAudit(db, [{ login: ACTOR, action: "implement-retry", target: ref, details: { from: impl.id, to: impl.id, pr: impl.prNumber, by: answer.by }, at }]);
      return true;
    });
    return ok ? { did: `revision of #${impl.prNumber} started again`, next: null } : await again("the attempt has no revision to try again");
  }
  if (answer.option === STUCK_OPTIONS.tryAgain.key && offered(answer.option)) {
    const { hash, tries } = await textTries(db, impl);
    if (tries >= MAX_ATTEMPTS_PER_TEXT) return await again(`${MAX_ATTEMPTS_PER_TEXT} attempts were made on this issue text, so Try again is not available; editing the issue allows more`);
    const queuedBy = await queuerOf(db, impl.repo, impl.number) ?? impl.queuedBy;
    const next = await db.write(async () => {
      const n = await restartAttempt(db, { id: impl.id, reason: impl.reason ?? "stuck", queuedBy, textHash: hash, guidance, at });
      await addAudit(db, [{ login: ACTOR, action: "implement-retry", target: ref, details: { from: impl.id, to: n.id, by: answer.by }, at }]);
      return n;
    });
    return { did: `attempt ${next.attempt} started`, next };
  }
  if (answer.option === STUCK_OPTIONS.draft.key && offered(answer.option)) {
    if (!await writeStep(db, impl, { to: "opening", expect: ["stuck"], at })) return { did: "left stuck meanwhile", next: null };
    return { did: "handed to the PR step as a draft", next: null };
  }
  return await again(answer.option ? `${answer.option} is not one of its options` : "the answer names none of its options");
}
