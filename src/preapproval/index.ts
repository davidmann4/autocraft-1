// Pipeline steps of a resolution card (review again, fix-up, fix-up then merge) and the pre-approved merge they can start.
//
// A pre-approved merge is an operator's Merge answer given ahead of a fix-up. States (see Preapproval in web/src/api/types.ts):
//   fixup   -> the fix-up step works the operator's instructions (source 'operator' in its fixups rows)
//   review  -> the fix-up pushed; waiting for the Opus review of the pushed head. A row with no fix-up (a Merge answer carried across a
//              base merge, or "Queue items") starts here at its head.
//   ci      -> that review says take (sure or unsure, not stale); waiting for CI of the pushed head, then for a clean pre-merge review of it.
//              A take-fix review keeps the row in review while the pipeline's fix-up of its fixes runs; that push is reviewed again.
//   queued  -> CI is green and the pre-merge review is clean: the PR's Merge? decision at the head is answered Merge by the operator,
//              exactly as a dashboard answer would be, in the same transaction that moves the row from ci to queued; the merge queue
//              then merges it with every check it always makes (safe-merge included)
//   merged / asked / cancelled / failed end it.
// Every transition is a pure reaction to rows other steps write (fixups, opus_reviews, pr_checks, items, merges), evaluated by
// advancePreapprovals on each runner tick: no timer and no wait of its own; the one time comparison (the start of the mirror's last sync against the push) is made when the tick runs anyway. Merging itself is never called from here.
import { settleMemo, settlesNow } from "../settlers.ts";
import type { Preapproval } from "../../web/src/api/types.ts";
import type { Step } from "../conversations/cards.ts";
import { conversationOf, insertTurn, systemBlock } from "../conversations/store.ts";
import { cifixBucket, decidePr, fixupOf, ownImplementation, reviseOf } from "../core/decide.ts";
import { loadPrFact, loadPrFacts } from "../core/facts.ts";
import { withSettingsSnapshot } from "../settings-read.ts";
import { HEAD_FACT, MERGE_OPTIONS, PREMERGE_MAX_TRIES, mergeDecisionId } from "../core/rules.ts";
import { audit } from "../dash/audit.ts";
import { ask, getDecision, replaceProposedCards } from "../decisions.ts";
import { ensureAuthorWrites } from "../fixup/author-permission.ts";
import { longLivedOf, pushable } from "../fixup/pushable.ts";
import { pushApprovalOf } from "../fixup/approval.ts";
import { mergeApprovalOf } from "../merge/approval.ts";
import { repoHasNoCi } from "../merge/no-ci.ts";
import { setAsideSupersededQuestions, withdrawMergeQuestion, withdrawOtherHeadQuestions } from "../merge/withdraw.ts";
import { findingsOf, premergeAt } from "../premerge/store.ts";
import { releaseMerge, removeFromBatch } from "../merge/controls.ts";
import type { Exec } from "../fixup/git.ts";
import { markReviewsStale, staleReviews } from "../review/discussion.ts";
import { reviewHold } from "../review/gate.ts";
import type { PrFacts } from "../core/plan.ts";
import { openOperatorFixups, operatorTriesLeft, queuedOperatorFix } from "./state.ts";
import { refreshSettlers, type RefreshDeps } from "./permissions.ts";
import { lockLiveExpr } from "../answers/hold.ts";
import type { Db } from "../db/index.ts";
import type { NotNull } from "kysely";
import * as kx from "../db/kx.ts";
import { readSeqs } from "../live.ts";
import { INPUT_TOPICS } from "../runner/autopilot.ts";

/** What bypass checks does, for the PR's thread. */
const BYPASS_LINE = "the reviews take its scope and design as settled, the pipeline makes the fixes they ask for and merges or resolves conflicts itself, and each of its pushes is reviewed again.";

export type PipelineStep = Extract<Step, { kind: "review" | "fixup" }>;

const ACTOR = "pipeline";
export const INSTRUCTIONS_MAX = 1500;
const ACTIVE = ["fixup", "review", "ci", "queued"] as const;
/** Plan states in which the PR gets no review, so a pre-approved merge cannot go on. A label never stops one: a live pre-approval lifts the label gate (src/core/decide.ts). */
const NOT_REVIEWABLE = ["out-of-scope", "integration", "backlog", "duplicate", "draft", "scope"];
const iso = () => new Date().toISOString();
const short = (sha: string | null) => (sha ?? "").slice(0, 7);
const oneLine = (s: string, n = 200) => s.replace(/\s+/g, " ").trim().slice(0, n);

type Row = { id: number; repo: string; number: number; by: string; at: string; instructions: string; state: Preapproval["state"]; from_head: string; head: string | null; reason: string | null; updated_at: string; fix_id: number | null; /** 1: queued with bypass checks. */ bypass: number };
type PrRow = { state: string; head_oid: string | null; kind: string; head_repo: string | null; head_ref: string | null };

const prRow = async (db: Db, repo: string, n: number): Promise<PrRow | undefined> =>
  await db.get(db.k.selectFrom("items").select(["state", "head_oid", "kind", "head_repo", "head_ref"]).where("repo", "=", repo).where("number", "=", n));

const preapprovalRows = (db: Db) => db.k.selectFrom("preapprovals").select(kx.cols("preapprovals")).$narrowType<{ state: Row["state"] }>();

/** The PR's plan state as it would be with a live pre-approved merge, which lifts the label gate: what a new pre-approval can count on. */
function preapprovedState(f: PrFacts | null): string | null {
  return f ? decidePr({ ...f, operator: { fix: null, hold: false, premerge: false, ...f.operator, preapproved: true } }).state : null;
}

const toView = (r: Row): Preapproval => ({ id: r.id, by: r.by, at: r.at, instructions: r.instructions, state: r.state, fromHead: r.from_head, head: r.head, reason: r.reason, updatedAt: r.updated_at });

/** The newest pre-approved merge of the PR, or null. */
export async function preapprovalOf(db: Db, repo: string, n: number): Promise<Preapproval | null> {
  const r = await db.get(preapprovalRows(db).where("repo", "=", repo).where("number", "=", n).orderBy("id", "desc").limit(1));
  return r ? toView(r) : null;
}

/** Every pre-approved merge of the PR, oldest first. */
export async function preapprovalsOf(db: Db, repo: string, n: number): Promise<Preapproval[]> {
  return (await db.all(preapprovalRows(db).where("repo", "=", repo).where("number", "=", n).orderBy("id"))).map(toView);
}

/** The system line of the item's thread (when it has a conversation). Not inside a transaction: the thread writes its own. */
async function say(db: Db, repo: string, n: number, text: string): Promise<void> {
  if (await conversationOf(db, repo, n)) await insertTurn(db, repo, n, { kind: "system", login: "system", body: text, block: systemBlock(text) });
}

/** Moves the row to `to` when it is still in its state; audits the transition (the trace shows it). Callable inside a transaction. */
async function moveRaw(db: Db, p: Row, to: Row["state"], o: { head?: string | null; reason?: string | null; by?: string; via?: string }): Promise<boolean> {
  // A head the call does not give leaves the row's head as it is.
  const r = await db.run(db.k.updateTable("preapprovals").set({ state: to, reason: o.reason ?? null, updated_at: iso(), ...(o.head != null ? { head: o.head } : {}) })
    .where("id", "=", p.id).where("state", "=", p.state));
  if (r.changes !== 1) return false;
  // A fix-up request that has no try yet must not start after the pre-approval ended; a push that is already running is recorded by the fix-up step as usual.
  if (["asked", "cancelled", "failed", "merged"].includes(to) && p.fix_id !== null) await db.run(db.k.updateTable("operator_fixups").set({ state: "ended" }).where("id", "=", p.fix_id));
  const head = o.head ?? p.head;
  await audit(db, o.by ?? ACTOR, "preapproval", `${p.repo}#${p.number}`, { id: p.id, from: p.state, state: to, ...(head ? { head } : {}), ...(o.reason ? { reason: o.reason } : {}), ...(o.via ? { via: o.via } : {}) });
  return true;
}

/** `moveRaw`, then says it in the thread. Not inside a transaction: the thread writes its own. */
async function move(db: Db, p: Row, to: Row["state"], o: { head?: string | null; reason?: string | null; by?: string; line: string }): Promise<boolean> {
  if (!await moveRaw(db, p, to, o)) return false;
  await say(db, p.repo, p.number, o.line);
  return true;
}

/**
 * An operator, or a maintainer who still settles on the repo (src/settlers.ts): their Merge answer and approval count. `held` is the pass's
 * `refreshSettlers` result: a maintainer's write permission the pipeline is reading again still counts until GitHub answers.
 */
const isOperator = async (db: Db, login: string | null, repo: string, held?: ReadonlySet<string>): Promise<boolean> => await settlesNow(db, login, [repo], { ...settleMemo(), held });

/** Takes back the Merge answer the hand-over wrote at the row's head (an answer anyone else wrote, or one already applied, stays). Inside the caller's transaction. */
export async function revertAnswer(db: Db, p: Row, by: string): Promise<boolean> {
  if (!p.head) return false;
  const id = mergeDecisionId(p.repo, p.number, p.head);
  if (!await db.get(db.k.selectFrom("audit").select((eb) => eb.lit(1).as("one")).where("action", "=", "answer").where("target", "=", id).where((w) => kx.like(db, "details", w.val('%"source":"preapproval"%'))))) return false;
  const r = await db.run(db.k.updateTable("main.decisions").set({ answer: null, answer_note: null, exceptions: null, answered_by: null, answered_at: null, applied_at: null, adopted_opinion: null, exec_state: null, exec_reason: null, dispute_by: null, dispute_reason: null, dispute_at: null })
    .where("id", "=", id).where("answer", "=", "merge").where("applied_at", "is", null).where("answered_by", "=", p.by));
  if (r.changes !== 1) return false;
  await audit(db, by, "undo", id, { answer: "merge", source: "preapproval" });
  return true;
}

/** Cancels the row and takes the hand-over answer back in one transaction, whatever state the caller read. False when the row had ended meanwhile. */
async function cancelRow(db: Db, id: number, by: string, reason: string, line: string, guard = false, via?: string): Promise<boolean> {
  // Nothing is written before an early return, so committing leaves the database as a rollback would.
  const p = await db.write(async () => {
    const p = await db.get(preapprovalRows(db).where("id", "=", id));
    if (!p || !(ACTIVE as readonly string[]).includes(p.state)) return null;
    // Past the guard of the merge queue, a cancel cannot stop the merge: a batch holds the PR, or it is merged.
    if (guard && p.state === "queued") {
      if (await inActiveBatch(db, p.repo, p.number)) throw new Error("the PR is still in an integration batch");
      if (await mergeRunning(db, p.repo)) throw new Error("a merge of the repo is running: it may be merging this PR");
      if (p.head && await db.get(db.k.selectFrom("merges").select((eb) => eb.lit(1).as("one")).where("repo", "=", p.repo).where("number", "=", p.number).where("head_oid", "=", p.head).where("outcome", "=", "merged"))) throw new Error("the PR is already merged");
    }
    if (!await moveRaw(db, p, "cancelled", { by, reason, via })) return null;
    await revertAnswer(db, p, by);
    return p;
  });
  if (!p) return false;
  await say(db, p.repo, p.number, line);
  return true;
}

// ---- starting a step ----------------------------------------------------------------------------------------------------

/** Queues a card's pipeline step for the PR; `label` is the done line the card shows. Throws when the step cannot start. */
/** `preapproval`: the id of the pre-approved merge a fix-up that merges started. */
export async function runPipelineStep(db: Db, o: { repo: string; number: number; step: PipelineStep; by: string }): Promise<{ label: string; preapproval?: number }> {
  const { repo, number, step, by } = o;
  const ref = `${repo}#${number}`;
  const it = await prRow(db, repo, number);
  if (!it || it.kind !== "pr") throw new Error(`${ref} is not a pull request`);
  if (it.state !== "OPEN") throw new Error(`${ref} is not open`);
  if (step.kind === "review") {
    await markReviewsStale(db, by, repo, number);
    return { label: "Queued a new review of the current head" };
  }
  // The fix-up step and the review of its push only see PRs the planner works: out of scope, integration and unreviewable PRs would wait for ever.
  const fact = await loadPrFact(db, repo, number);
  const planState = step.merge === true ? preapprovedState(fact) : fact ? decidePr(fact).state : null;
  if (!planState || planState === "out-of-scope" || planState === "integration") throw new Error(`${ref} is outside the pipeline's scope: no fix-up runs on it`);
  if (step.merge === true && NOT_REVIEWABLE.filter((x) => x !== "scope").includes(planState)) throw new Error(`${ref} cannot be reviewed (${planState}): a merge after the fix-up could not follow`);
  const instructions = step.instructions.trim();
  if (!instructions) throw new Error("the fix-up needs instructions");
  if (instructions.length > INSTRUCTIONS_MAX) throw new Error(`the instructions are over ${INSTRUCTIONS_MAX} characters`);
  const head = it.head_oid;
  if (!head) throw new Error(`${ref} has no head commit in the mirror yet`);
  const checks = await db.get(db.k.selectFrom("pr_checks").select(["head_oid", "mergeable", "maintainer_can_modify"]).where("repo", "=", repo).where("number", "=", number));
  if (checks?.mergeable === "CONFLICTING") throw new Error(`${ref} conflicts with its base branch: the conflict merge comes first`);
  if (!await pushApprovalOf(db, repo)) throw new Error(`pushing is not approved for ${repo}`);
  const writes = await ensureAuthorWrites(db, repo, number, it.head_repo);
  if (writes === "unknown") throw new Error("the author's permission on the repository could not be read yet; try again");
  if (!pushable(it.head_repo, repo, checks?.head_oid === head ? checks.maintainer_can_modify : null, it.head_ref, await longLivedOf(db, repo), false, writes === "yes")) throw new Error("can't push to the contributor's branch");
  if (!await operatorTriesLeft(db, repo, number)) throw new Error("the fix-up tries for this PR are used up");
  if (await queuedOperatorFix(db, repo, number, head)) throw new Error(`a fix-up of ${ref} is already queued`);
  const merge = step.merge === true;
  const activeCheck = async () => {
    if (await db.get(db.k.selectFrom("preapprovals").select((eb) => eb.lit(1).as("one")).where("repo", "=", repo).where("number", "=", number).where("state", "in", ACTIVE))) throw new Error(`${ref} already has a pre-approved merge in progress`);
  };
  if (merge) {
    if (!await mergeApprovalOf(db, repo)) throw new Error(`merging is not approved for ${repo}`);
    await activeCheck();
  }
  const at = iso();
  let id: number | null = null;
  await db.write(async () => {
    // Checked again under the write lock: another writer may have started one since the first check.
    if (merge) await activeCheck();
    const fix = (await db.get(db.k.insertInto("operator_fixups").values({ repo, number, from_head: head, instructions, by, at }).returning("id")))!.id;
    if (merge) {
      id = (await db.get(db.k.insertInto("preapprovals").values({ repo, number, by, at, instructions, state: "fixup", from_head: head, updated_at: at, fix_id: fix }).returning("id")))!.id;
      await db.run(db.k.updateTable("operator_fixups").set({ preapproval_id: id }).where("id", "=", fix));
    }
    await audit(db, by, merge ? "preapproval" : "operator-fixup", ref, merge ? { id, state: "fixup", head } : { head, queued: true });
  });
  await say(db, repo, number, merge
    ? `${by} approved a merge after a fix-up: a fix-up of ${short(head)} is queued; if its review says take and CI is green, the PR goes to the merge queue.`
    : `${by} queued a fix-up of ${short(head)}.`);
  return { label: merge ? "Queued the fix-up; the PR merges if its review says take and CI is green" : "Queued the fix-up", ...(id !== null && { preapproval: id }) };
}

/** Why a PR in a NOT_REVIEWABLE plan state gets no code review, in words a commenter can act on. */
function notReviewableWhy(state: string, scopeAnswer: string | null): string {
  switch (state) {
    case "backlog": return "it is in the backlog";
    case "duplicate": return "it is held as a duplicate";
    case "draft": return "it is a draft";
    case "scope": return scopeAnswer === null ? "its scope question is still open" : `its scope answer (${scopeAnswer}) keeps it out of core`;
    default: return state;
  }
}

/** Why a pre-approval pinned to a head (a comment's) was refused: the PR has another head now. */
export const HEAD_CHANGED = "the PR changed after your comment; comment again";

/** preapproveMerge's refusal by rule (the PR, its state or the repo's approval); other errors may pass on a later try. `active`: one is in progress already. */
export class PreapprovalRefused extends Error {
  readonly active: boolean;
  constructor(message: string, active = false) { super(message); this.active = active; }
}

/**
 * "Queue items" (a PR line): an operator's Merge answer given ahead, with no fix-up. A row starts in `review` at the current head,
 * the way a carried answer does, so the PR merges only after a take review, a clean pre-merge review and green CI there. The approval
 * says the change is wanted, so an unsure review does not stop it, and a take-fix review's fixes are made by the pipeline's fix-up,
 * whose push is reviewed again; a pre-merge defect, a red head the CI fix cannot repair or a fix-up that cannot run asks the
 * Merge? question instead. Throws when it cannot start.
 *
 * The PR's label does not matter (the pre-approval lifts the label gate); a draft, the backlog, a duplicate hold or a scope question still refuse it.
 * `head`, when given, is the only head it may pre-approve: the head the person saw (a command's comment-time head).
 */
export async function preapproveMerge(db: Db, o: { repo: string; number: number; by: string; via?: string; head?: string; bypass?: boolean }): Promise<{ label: string }> {
  const { repo, number, by, via } = o;
  const ref = `${repo}#${number}`;
  const it = await prRow(db, repo, number);
  if (!it || it.kind !== "pr") throw new PreapprovalRefused(`${ref} is not a pull request`);
  if (it.state !== "OPEN") throw new PreapprovalRefused(`${ref} is not open`);
  const fact = await loadPrFact(db, repo, number);
  const planState = preapprovedState(fact);
  if (!planState || planState === "out-of-scope" || planState === "integration") throw new PreapprovalRefused(`${ref} is outside the pipeline's scope`);
  if (NOT_REVIEWABLE.includes(planState)) throw new PreapprovalRefused(`${ref} cannot be reviewed yet: ${notReviewableWhy(planState, fact?.scopeAnswer ?? null)}`);
  const head = it.head_oid;
  if (!head) throw new Error(`${ref} has no head commit in the mirror yet`);
  if (o.head !== undefined && head !== o.head) throw new Error(HEAD_CHANGED);
  if (!await mergeApprovalOf(db, repo)) throw new PreapprovalRefused(`merging is not approved for ${repo}`);
  const active = async () => await db.get(db.k.selectFrom("preapprovals").select(["id", "bypass"]).where("repo", "=", repo).where("number", "=", number).where("state", "in", ACTIVE));
  const running = await active();
  // Queuing again with bypass checks turns it on for the merge already in progress.
  if (running && o.bypass && !running.bypass) {
    await db.run(db.k.updateTable("preapprovals").set({ bypass: 1 }).where("id", "=", running.id));
    await audit(db, by, "preapproval-bypass", ref, { id: running.id, ...(via ? { via } : {}) });
    await say(db, repo, number, `${by} set the merge already in progress to bypass checks: ${BYPASS_LINE}`);
    return { label: "The merge already in progress now bypasses checks" };
  }
  if (running) throw new PreapprovalRefused(`${ref} already has a pre-approved merge in progress`, true);
  const at = iso();
  await db.write(async () => {
    // Checked again under the write lock: another writer may have started one since the first check.
    if (await active()) throw new PreapprovalRefused(`${ref} already has a pre-approved merge in progress`, true);
    const id = (await db.get(db.k.insertInto("preapprovals").values({ repo, number, by, at, instructions: "", state: "review", from_head: head, head, updated_at: at, fix_id: null, bypass: o.bypass ? 1 : 0 }).returning("id")))!.id;
    await audit(db, by, "preapproval", ref, { id, state: "review", head, queued: "merge-queue", ...(o.bypass ? { bypass: true } : {}), ...(via ? { via } : {}) });
  });
  await say(db, repo, number, `${by} added the PR to the merge queue at ${short(head)}: it merges once the review there says take, the pre-merge review is clean and CI is green.${o.bypass ? ` It bypasses checks: ${BYPASS_LINE}` : ""}`);
  return { label: `Added to the merge queue${o.bypass ? " with bypass checks" : ""}; it merges once the review says take and CI is green` };
}

// ---- the state machine ---------------------------------------------------------------------------------------------------

/**
 * What the thread calls the row's head: the fix-up's push; for a row without a fix-up, the pipeline's push it went on with (a base merge,
 * an autorepin or the fix-up of a review's fixes) or, for one added to the merge queue and not pushed to since, the PR's own head.
 */
function headName(p: Row): string {
  return p.fix_id !== null ? "the pushed head" : p.head !== p.from_head ? "the new head" : "the PR's head";
}

/** The fact line naming the review a stop or hand-over rests on. */
const reviewFact = (p: Row, what: string) => `review of ${p.fix_id !== null ? "the fix-up" : headName(p)}: ${what}`;

/** Asks a Merge? question at `head` the normal way (Prepare writes its options and recommendation); an answered one is left as it is. */
async function askMerge(db: Db, p: Row, head: string, why: string, facts: string[]): Promise<void> {
  const id = mergeDecisionId(p.repo, p.number, head);
  if ((await getDecision(db, id))?.answer) return;
  const at = iso();
  await ask(db, [{
    id, kind: "merge", repo: p.repo, number: p.number, question: "Merge this PR?",
    context: p.fix_id !== null ? `${p.by} approved a merge after a fix-up, but it stopped: ${why}.` : `${p.by} approved the merge ahead of its review and CI, but it stopped: ${why}.`,
    facts: [...facts.slice(0, 4), `${HEAD_FACT}${head}`], options: Object.values(MERGE_OPTIONS).map((x) => ({ ...x })), asked_by: ACTOR, asked_at: at,
  }]);
  await withdrawOtherHeadQuestions(db, p.repo, p.number, head, at);
  await setAsideSupersededQuestions(db, at, p.repo);
}

type Hand = { done: true } | { gone: true } | { wait: true } | { stop: string };

/**
 * Moves the row from ci to queued and answers the PR's Merge? decision at `head` with Merge for the operator, as the dashboard would,
 * in one transaction: a cancel that ran first leaves the row cancelled and nothing answered. Idempotent.
 */
async function handOver(db: Db, p: Row, head: string, held: ReadonlySet<string>): Promise<Hand> {
  const id = mergeDecisionId(p.repo, p.number, head);
  const at = iso();
  // Nothing is written before an early return, so committing leaves the database as a rollback would.
  const stopped = await db.write(async (): Promise<Hand | null> => {
    if (!await isOperator(db, p.by, p.repo, held)) return { stop: `${p.by} no longer settles decisions on ${p.repo}` };
    // A hand-over waits for a running verification and never answers Merge over a failed one: the operator is asked.
    if (await db.get(db.k.selectFrom("verifications").select((eb) => eb.lit(1).as("one")).where("repo", "=", p.repo).where("number", "=", p.number).where("head_sha", "=", head).where("state", "in", ["planned", "running"]))) return { wait: true };
    if (await db.get(db.k.selectFrom("verifications").select((eb) => eb.lit(1).as("one")).where("repo", "=", p.repo).where("number", "=", p.number).where("head_sha", "=", head).where("state", "in", ["failed", "error"]))) return { stop: `verification failed at ${headName(p)}` };
    const d0 = await getDecision(db, id);
    if (d0 && d0.answer !== null && d0.answer !== "merge") return { stop: `the Merge? question at this head was answered ${d0.answer}` };
    // A conversation card is settling the question right now: the hand-over waits for it instead of answering over it.
    if (d0 && d0.answer === null && await db.get(db.k.selectFrom("main.decisions").select((eb) => eb.lit(1).as("one")).where("id", "=", id).where((eb) => lockLiveExpr(db, eb, "decisions")))) return { wait: true };
    if (!await moveRaw(db, p, "queued", { head })) return { gone: true };
    if (!await getDecision(db, id)) {
      await ask(db, [{
        id, kind: "merge", repo: p.repo, number: p.number, question: "Merge this PR?",
        context: p.fix_id !== null
          ? `${p.by} approved this merge ahead of a fix-up; the fix-up was pushed, its review says take, CI is green and its pre-merge review is clean.`
          : `${p.by} approved this merge ahead of its review and CI; the review says take, CI is green and the pre-merge review is clean.`,
        facts: [
          ...(p.fix_id !== null ? [`fix-up pushed by the pipeline from ${short(p.from_head)} to ${short(head)}`] : head !== p.from_head ? [`base merge pushed by the pipeline from ${short(p.from_head)} to ${short(head)}`] : []),
          `${HEAD_FACT}${head}`,
        ],
        options: Object.values(MERGE_OPTIONS).map((x) => ({ ...x })), asked_by: ACTOR, asked_at: at,
      }], true);
    }
    if ((await getDecision(db, id))!.answer === null) {
      await db.run(db.k.updateTable("main.decisions").set({ answer: "merge", answer_note: null, exceptions: null, answered_by: p.by, answered_at: at, adopted_opinion: null, snoozed_by: null, snoozed_at: null })
        .where("id", "=", id).where("answer", "is", null).where((eb) => eb.not(lockLiveExpr(db, eb, "decisions"))));
      await db.run(db.k.deleteFrom("main.decision_claims").where("decision_id", "=", id));
      await replaceProposedCards(db, p.repo, p.number, id);
      await audit(db, p.by, "answer", id, { answer: "merge", source: "preapproval" });
    }
    return null;
  });
  if (stopped) return stopped;
  await say(db, p.repo, p.number, "CI is green and the pre-merge review is clean: the PR is in the merge queue, which checks it as for any Merge answer.");
  return { done: true };
}

type ReviewRead = { kind: "none" | "stale" | "take" | "takefix" | "bad"; why: string; unsure: boolean };

/**
 * The Opus review at `head`. A take or take-fix that is not stale goes on, sure or unsure: the merge approval says the change is wanted,
 * so a take-fix is the pipeline's own fix-up to make and the pre-approval goes on with its push. Any other verdict stops it.
 */
async function reviewAt(db: Db, p: Row, head: string, wake?: Wake): Promise<ReviewRead> {
  const r = await db.get(db.k.selectFrom("opus_reviews").select(["verdict", "sure", "reason"]).$narrowType<{ verdict: NotNull }>()
    .where("repo", "=", p.repo).where("number", "=", p.number).where("head_oid", "=", head).where("verdict", "is not", null));
  if (!r) return { kind: "none", why: "", unsure: false };
  const ref = `${p.repo}#${p.number}`;
  if ((await staleReviews(db, p.repo, false, { refresh: (r, at) => (r === ref ? wake?.(at) : undefined) })).has(`${ref}@${head}`)) return { kind: "stale", why: "", unsure: false };
  const unsure = r.sure !== 1;
  if (r.verdict === "take") return { kind: "take", why: "", unsure };
  if (r.verdict === "take-fix") return { kind: "takefix", why: r.reason ? oneLine(r.reason, 160) : "", unsure };
  return { kind: "bad", why: `the review says ${r.verdict}${unsure ? " (unsure)" : ""}${r.reason ? `: ${oneLine(r.reason, 160)}` : ""}`, unsure };
}

/** Why an unsure review or a take-fix does not stop the row, for its thread line. */
const approvedAhead = (p: Row) => (p.fix_id !== null ? "the merge was approved with a fix-up" : "the PR was queued to merge");

/** Says `line` in the thread once per row, head and note (the audit entry is the memory): for a wait that moves the row nowhere. */
async function noteOnce(db: Db, p: Row, head: string, note: string, line: string): Promise<void> {
  const ref = `${p.repo}#${p.number}`;
  if (await db.get(db.k.selectFrom("audit").select((eb) => eb.lit(1).as("one")).where("action", "=", "preapproval").where("target", "=", ref)
    .where(kx.jsonNum(db, "details", "$.id"), "=", p.id).where(kx.jsonText(db, "details", "$.note"), "=", note).where(kx.jsonText(db, "details", "$.head"), "=", head).limit(1))) return;
  await audit(db, ACTOR, "preapproval", ref, { id: p.id, head, note });
  await say(db, p.repo, p.number, line);
}

/**
 * "base merge", "autorepin", "fix-up for the review's fixes" or the implementation session's revision when the pipeline itself pushed `cur` on top of the row's head, else null.
 * The review's fix-up counts for every row: the merge approval says the change is wanted, and the fix-up's push gets a fresh review.
 * A row queued with bypass checks also goes on across the pipeline's other model-written pushes (a conflict resolution, a CI fix, a
 * fix-up of the pre-merge review's fixes): each gets a fresh review, a clean pre-merge review and green CI, so none merges unseen.
 */
async function ownPush(db: Db, p: Row, cur: string): Promise<string | null> {
  const fix = await db.get(db.k.selectFrom("fixups").select((eb) => eb.fn.coalesce("source", eb.val("review")).as("source")).where("repo", "=", p.repo).where("number", "=", p.number).where("from_head", "=", p.head).where("to_head", "=", cur)
    .where((eb) => eb(eb.fn.coalesce("source", eb.val("review")), "in", p.bypass ? ["review", "premerge"] : ["review"])).where("state", "in", ["pushing", "pushed"]));
  if (fix) return fix.source === "premerge" ? "fix-up for the pre-merge review's fixes" : "fix-up for the review's fixes";
  // Without bypass checks only a base merge that left the PR's own diff unchanged continues an answer; a CI fix or a resolved conflict is model-written code nobody saw.
  const merge = await db.get(db.k.selectFrom("conflict_merges").select("own_diff").where("repo", "=", p.repo).where("number", "=", p.number).where("from_head", "=", p.head).where("to_head", "=", cur).where("state", "=", "merged")
    .$if(!p.bypass, (q) => q.where("own_diff", "=", "same")));
  if (merge) return merge.own_diff === "same" ? "base merge" : "conflict resolution";
  if (p.bypass && await db.get(db.k.selectFrom("ci_fixes").select((eb) => eb.lit(1).as("one")).where("repo", "=", p.repo).where("number", "=", p.number).where("head", "=", p.head).where("to_head", "=", cur).where("state", "in", ["pushing", "pushed"]))) return "CI fix";
  // A revision of our implementation PR by the session that wrote it: the PR is the queuer's implementation, and the push gets a fresh review.
  if (await db.get(db.k.selectFrom("push_outcomes").select((eb) => eb.lit(1).as("one")).where("repo", "=", p.repo).where("number", "=", p.number).where("action", "=", "implement-push").where("from_oid", "=", p.head).where("to_oid", "=", cur))) return "implementation session's revision";
  // An autorepin (src/repin) is no model's code either: the revs of a dependency moved to a merge commit on its default branch, as someone who may queue the PR asked.
  if (await db.get(db.k.selectFrom("main.autorepins").select((eb) => eb.lit(1).as("one")).where("repo", "=", p.repo).where("number", "=", p.number).where("head", "=", p.head).where("to_head", "=", cur).where("state", "in", ["waiting", "locking", "pushed"]))) return "autorepin";
  return null;
}

/** Our implementation PR whose revision by its session is planned or running: the review's fixes and red CI are its to repair. */
const revisesNow = (f: PrFacts): boolean => !!reviseOf(f) || ownImplementation(f)?.state === "revising";

/** Why the planner does not list the operator's fix-up for the PR now; null when it does. */
async function whyNotPlanned(db: Db, f: PrFacts): Promise<string | null> {
  if (decidePr(f).actions.some((a) => a.kind === "fixup" && a.params?.source === "operator")) return null;
  if (f.draft) return "the PR is a draft";
  if (f.heldBacklog) return "the PR is held in the backlog";
  if (f.mergeable === "CONFLICTING") return "the PR conflicts with its base branch";
  if (!f.pushable) return "the PR's branch cannot be pushed to";
  if (!f.repoFacts.pushApproved) return "pushing is not approved for the repo";
  if (!await operatorTriesLeft(db, f.repo, f.number)) return "the fix-up tries are used up";
  return "the pipeline does not plan the fix-up";
}

/** Whether the CI fix or conflict step is working the PR now or the planner lists it: a wait for it ends. A step the planner does not list (not approved, held, merge blocked) and that has no task in flight never moves the PR on. */
function stepRuns(f: PrFacts, step: "cifix" | "conflict"): boolean {
  const acts = decidePr(f).actions;
  if (step === "conflict") return f.conflict?.bucket === "linting" || acts.some((a) => a.kind === "conflict" && a.params?.bucket === "merge");
  const b = cifixBucket(f);
  return (b !== null && ["formatting", "linting", "rerun-wait"].includes(b)) || acts.some((a) => a.kind === "cifix" && !["capped", "ask"].includes(String(a.params?.bucket)));
}

const FAILED_FIXUP = ["failed", "refused", "rejected", "cannot-push", "too-large", "push-denied", "asked", "comment-failed", "superseded"];

/** One pre-approved merge: reads what the other steps recorded and makes at most one transition. */
async function advance(db: Db, p: Row, held: ReadonlySet<string>, factOf: () => Promise<PrFacts | null>, wake: Wake): Promise<void> {
  const it = await prRow(db, p.repo, p.number);
  const cancel = async (reason: string) => void await cancelRow(db, p.id, ACTOR, reason, `The pre-approved merge was cancelled: ${reason}.`);
  const stop = async (to: "asked" | "failed", why: string, head: string, facts: string[] = [why]) => {
    if (await move(db, p, to, { reason: why, line: `The pre-approved merge stopped: ${why}. A Merge? question was asked.` })) await askMerge(db, p, head, why, facts);
  };
  if (!it) return cancel("the PR is gone");
  const cur = it.head_oid;
  const mergedByQueue = !!p.head && !!await db.get(db.k.selectFrom("merges").select((eb) => eb.lit(1).as("one")).where("repo", "=", p.repo).where("number", "=", p.number).where("head_oid", "=", p.head).where("outcome", "=", "merged"));
  if (p.state === "queued" && (it.state === "MERGED" || mergedByQueue)) return void await move(db, p, "merged", { line: "The pre-approved merge went through: the PR is merged." });
  if (it.state === "MERGED") return cancel(p.fix_id !== null ? "the PR was merged before the fix-up finished" : "the PR was merged before the pre-approved merge reached the merge queue");
  if (it.state !== "OPEN") return cancel("the PR was closed");

  // The fix-up and the review that follows run on the maker's authority; the queued state re-checks the Merge answer below.
  if (p.state !== "queued" && !await isOperator(db, p.by, p.repo, held)) return cancel(`${p.by} no longer settles decisions on ${p.repo}`);

  if (p.state === "fixup") {
    const fx = await db.get(db.k.selectFrom("fixups").select(["state", "to_head", "reason"]).where("operator_fix", "=", p.fix_id).where("source", "=", "operator").orderBy(kx.rowid("fixups"), "desc").limit(1));
    if (fx?.state === "pushed" && fx.to_head) return void await move(db, p, "review", { head: fx.to_head, line: `The fix-up pushed ${short(fx.to_head)}; Opus reviews it next.` });
    if (fx && FAILED_FIXUP.includes(fx.state)) {
      const why = `the fix-up ${fx.state}${fx.reason ? `: ${oneLine(fx.reason, 120)}` : ""}`;
      return await stop("failed", why, cur ?? p.from_head);
    }
    // A push written before it ran: when the head is its commit, it landed.
    if (fx?.state === "pushing" && fx.to_head && cur === fx.to_head) return void await move(db, p, "review", { head: fx.to_head, line: `The fix-up pushed ${short(fx.to_head)}; Opus reviews it next.` });
    // Whatever the fix-up row says (none yet, linting, pushing), a head that is neither its start nor its push is someone else's.
    if (cur !== null && cur !== p.from_head && cur !== fx?.to_head) return cancel(`another push moved the head to ${short(cur)}`);
    // No try yet and the planner would not work the request (not pushable, conflicting, a draft, ...): it would wait for ever.
    if (!fx) {
      const f = await factOf();
      const why = f ? await whyNotPlanned(db, f) : null;
      if (why) await stop("asked", `the fix-up cannot run: ${why}`, cur ?? p.from_head);
    }
    return;
  }

  // Every later state: the head is the fix-up's push (or, with no fix-up, the row's starting head). Until a review exists at it, the mirror may still show the head the push started from, for a short time.
  const head = p.head!;
  if (cur !== null && cur !== head) {
    // The mirror row shows the old head until a sync that started after the push has finished (synced_at is the sync's start; the row's state entry follows the push); a review at the pushed head also shows the mirror saw it.
    const synced = (await db.get(db.k.selectFrom("repos").select("synced_at").where("name", "=", p.repo)))?.synced_at ?? null;
    const lag = p.state === "review" && cur === p.from_head && (synced === null || synced <= p.updated_at)
      && !await db.get(db.k.selectFrom("opus_reviews").select((eb) => eb.lit(1).as("one")).where("repo", "=", p.repo).where("number", "=", p.number).where("head_oid", "=", head));
    // Once queued, only a row with bypass checks goes on across the pipeline's own push: the Merge answer at the old head is taken back with the move.
    if (!lag && (p.state !== "queued" || p.bypass)) {
      // The pipeline's own CI fix or conflict merge on the pushed head carries the pre-approval on: the new head needs the whole chain again.
      const own = await ownPush(db, p, cur);
      const line = `The ${own} pushed ${short(cur)}; it needs a fresh review, a clean pre-merge review and green CI before the PR goes to the merge queue.`;
      if (own && p.state !== "queued") return void await move(db, p, "review", { head: cur, line });
      if (own) {
        const moved = await db.write(async () => {
          if (!await moveRaw(db, p, "review", { head: cur })) return false;
          await revertAnswer(db, p, ACTOR);
          return true;
        });
        if (moved) await say(db, p.repo, p.number, line);
        return;
      }
    }
    if (!lag) return cancel(cur === p.from_head ? `the head went back to ${short(cur)}` : `another push moved the head to ${short(cur)}`);
  }

  if (p.state === "review") {
    const r = await reviewAt(db, p, head, wake);
    if (r.kind === "stale") return;
    if (r.kind === "none") {
      // No review is coming for a PR the planner does not review (an open scope question, a draft, a hold).
      const f = cur === head ? await factOf() : null;
      const state = f ? decidePr(f).state : null;
      if (state && NOT_REVIEWABLE.includes(state)) return await stop("asked", `${headName(p)} cannot be reviewed (${state})`, head);
      // The gate lifts every hold for a pre-approved head except a review that failed for good, which only a new request or push ends.
      const hold = cur === head ? await reviewHold(db, p.repo, p.number, head) : null;
      if (hold?.kind === "failed" && hold.until === undefined) return await stop("asked", `the review of ${headName(p)} waits on ${hold.wait}`, head);
      return;
    }
    const name = p.fix_id !== null ? "the fix-up" : headName(p);
    if (r.kind === "take") {
      return void await move(db, p, "ci", { line: r.unsure ? `The review of ${name} says take but is unsure; ${approvedAhead(p)}, so it goes on: waiting for CI.` : `The review of ${name} says take; waiting for CI.` });
    }
    if (r.kind === "takefix") {
      // The planner's fix-up of the review's fixes runs next, sure or unsure (fixupOf). Its push is our own (ownPush), so the row stays and the new head is reviewed; when no fix-up can run, a person decides.
      const f = cur === head ? await factOf() : null;
      const fx = f ? fixupOf(f) : null;
      // Our implementation PR goes back to the session that wrote it instead; its push is our own as well.
      if (f && revisesNow(f)) return await noteOnce(db, p, head, "review-revise", `The review of ${name} ${r.unsure ? "is unsure and asks" : "asks"} for fixes; ${approvedAhead(p)}, so the implementation session makes them.`);
      if (fx && ((fx.bucket === "fix" && !fx.done) || fx.bucket === "hold")) {
        return await noteOnce(db, p, head, "review-fixup", `The review of ${name} ${r.unsure ? "is unsure and asks" : "asks"} for fixes; ${approvedAhead(p)}, so the fix-up runs.`);
      }
      return await stop("asked", `the review of ${name} asks for fixes and its fix-up cannot run${fx ? ` (${fx.bucket})` : ""}`, head,
        [reviewFact(p, `take-fix${r.unsure ? " (unsure)" : ""}${r.why ? `: ${r.why}` : ""}`), "Recommended: Fix up first, then merge"]);
    }
    return await stop("asked", r.why, head, [reviewFact(p, r.why)]);
  }

  if (!await mergeApprovalOf(db, p.repo)) return p.state === "queued" ? cancel("merging is no longer approved for the repo") : await stop("asked", "merging is no longer approved for the repo", head);

  if (p.state === "ci") {
    // A re-review since the move to ci counts: the hand-over needs a take at this head now.
    const r = await reviewAt(db, p, head, wake);
    if (r.kind === "none" || r.kind === "stale") return void await move(db, p, "review", { line: `The review of ${headName(p)} is out of date; Opus reviews it again.` });
    if (r.kind === "takefix") return void await move(db, p, "review", { line: `The review of ${headName(p)} now asks for fixes; the pipeline's fix-up comes first.` });
    if (r.kind === "bad") return await stop("asked", r.why, head, [reviewFact(p, r.why)]);
    const c = await db.get(db.k.selectFrom("pr_checks").select(["overall", "mergeable"]).where("repo", "=", p.repo).where("number", "=", p.number).where("head_oid", "=", head));
    if (!c || c.overall === "pending") return;
    if (c.overall === "failure") {
      // The CI fix step works the red head as it would for any PR; its push is a head the operator did not see, so the row ends and the Merge? question is asked there. The operator decides when the step has given up.
      const f = await factOf();
      if (f && revisesNow(f)) return;
      const bucket = f ? cifixBucket(f) : null;
      if (bucket !== null && ["work", "formatting", "linting", "collect", "rerun", "rerun-wait"].includes(bucket) && stepRuns(f!, "cifix")) return;
      return await stop("asked", `CI failed at ${headName(p)} and the CI fix did not repair it`, head, [reviewFact(p, "take"), `CI failed at ${headName(p)}`]);
    }
    if (c.overall === "none" && !await repoHasNoCi(db, p.repo)) return;
    if (c.mergeable === "CONFLICTING") {
      // The conflict step merges the base into the PR when it can; its push is a new head that continues this pre-approval.
      const f = await factOf();
      if (f?.conflict?.baseOk && ["merge", "linting"].includes(f.conflict.bucket) && stepRuns(f, "conflict")) return;
      return await stop("asked", "the PR conflicts with its base branch", head);
    }
    // The pre-merge review of this head must be clean; the planner runs it (src/core/decide.ts) and retries a failed one.
    const pm = await premergeAt(db, p.repo, p.number, head);
    if (!pm || (pm.findings === null && pm.tries < PREMERGE_MAX_TRIES)) return;
    if (pm.findings === null) return await stop("asked", `the pre-merge review of ${headName(p)} failed`, head);
    const defects = findingsOf(pm).filter((x) => x.severity === "defect").length;
    if (defects && !p.bypass) return await stop("asked", `the pre-merge review found ${defects} defect${defects === 1 ? "" : "s"}`, head);
    if (pm.unsure === 1 && !p.bypass) return await stop("asked", "the pre-merge review is unsure", head);
    if (defects) {
      // Defects with fixes are the pipeline's fix-up to make, as a take-fix review's are; its push is reviewed again (ownPush). Only defects it cannot fix stop the row.
      const f = await factOf();
      const acts = f ? decidePr(f).actions : [];
      if (acts.some((a) => a.kind === "fixup" && a.params?.source === "premerge")) return await noteOnce(db, p, head, "premerge-fixup", `The pre-merge review of ${headName(p)} found ${defects} defect${defects === 1 ? "" : "s"} with fixes; ${approvedAhead(p)}, so the fix-up makes them.`);
      // Its patch is linted, then collected and pushed.
      if (f?.lint.some((l) => l.source === "premerge" && !l.ended) || acts.some((a) => a.kind === "lint" && a.params?.source === "premerge")) return;
      // Its push may not be in the mirror yet: the new head then carries the row on (ownPush).
      if (await db.get(db.k.selectFrom("fixups").select((eb) => eb.lit(1).as("one")).where("repo", "=", p.repo).where("number", "=", p.number).where("from_head", "=", head)
        .where("source", "=", "premerge").where("state", "in", ["pushing", "pushed"]))) return;
      return await stop("asked", `the pre-merge review found ${defects} defect${defects === 1 ? "" : "s"} the fix-up cannot make`, head);
    }
    // An unsure pre-merge review with no defect is no reason to stop a queued PR: queuing it accepted the change, and the review found nothing wrong.
    if (pm.unsure === 1) await noteOnce(db, p, head, "premerge-unsure", `The pre-merge review of ${headName(p)} is unsure but found no defect; ${approvedAhead(p)}, so it goes on.`);
    const h = await handOver(db, p, head, held);
    if ("stop" in h) {
      if (await move(db, p, "asked", { reason: h.stop, line: `The pre-approved merge stopped: ${h.stop}.` }) && !h.stop.includes("was answered")) await askMerge(db, p, head, h.stop, [h.stop]);
    }
    return;
  }

  // queued: the merge queue owns it now; only an answer that stops counting ends it here.
  const d = await getDecision(db, mergeDecisionId(p.repo, p.number, head));
  if (!d || d.answer !== "merge") return cancel("its Merge answer was withdrawn");
  if (!await isOperator(db, d.answered_by ?? p.by, p.repo, held)) await cancel(`${d.answered_by ?? p.by} no longer settles decisions on ${p.repo}, so the Merge answer no longer counts`);
}

/** Ends fix-up requests the planner can no longer work (the PR's head moved, it closed, the push is not possible), with the reason in the thread. Requests of a pre-approved merge end with it. */
async function endStaleRequests(db: Db, held: ReadonlySet<string>, wake: Wake): Promise<void> {
  // A request whose maker stopped settling (a maintainer after the setting went off, the repo left the app identity, a demotion) is dropped before the planner can push it.
  for (const o of await db.all(db.k.selectFrom("operator_fixups").select(["id", "repo", "number", "from_head", "by", "preapproval_id"]).where("state", "=", "queued").orderBy("id"))) {
    if (o.preapproval_id !== null || await isOperator(db, o.by, o.repo, held)) continue;
    if ((await db.run(db.k.updateTable("operator_fixups").set({ state: "ended" }).where("id", "=", o.id).where("state", "=", "queued"))).changes !== 1) continue;
    await audit(db, ACTOR, "operator-fixup", `${o.repo}#${o.number}`, { id: o.id, ended: true, reason: "the requester no longer settles here" });
    await say(db, o.repo, o.number, `The queued fix-up of ${short(o.from_head)} was dropped: ${o.by} no longer settles decisions on ${o.repo}.`);
  }
  for (const o of await openOperatorFixups(db)) {
    if (o.preapprovalId !== null) continue;
    const f = await loadPrFact(db, o.repo, o.number);
    if (f?.refreshAt !== undefined) wake(f.refreshAt);
    const why = !f ? "the PR is no longer open" : f.head !== o.head ? `the head moved to ${short(f.head)}` : o.started ? null : await whyNotPlanned(db, f);
    if (!why) continue;
    if ((await db.run(db.k.updateTable("operator_fixups").set({ state: "ended" }).where("id", "=", o.id).where("state", "=", "queued"))).changes !== 1) continue;
    await audit(db, ACTOR, "operator-fixup", `${o.repo}#${o.number}`, { id: o.id, ended: true, reason: why });
    await say(db, o.repo, o.number, `The queued fix-up of ${short(o.head)} was dropped: ${why}.`);
  }
}

/** A cancel that came too late for a merge already past its guard: the merge row that appears at the head turns the row into merged. */
async function settleCancelled(db: Db): Promise<void> {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const rows = await db.all(preapprovalRows(db).$narrowType<{ head: NotNull }>().where("state", "=", "cancelled").where("head", "is not", null).where("updated_at", ">", since).orderBy("id"));
  for (const p of rows) {
    if (await db.get(db.k.selectFrom("merges").select((eb) => eb.lit(1).as("one")).where("repo", "=", p.repo).where("number", "=", p.number).where("head_oid", "=", p.head).where("outcome", "=", "merged").where("at", ">=", p.at))) await move(db, p, "merged", { line: "The merge went through before the cancel took effect: the PR is merged." });
  }
}

/**
 * An operator's Merge answer at head H carries across the pipeline's own base merge to H2 that left the PR's diff unchanged: when the answer
 * still stands and the PR has no pre-approved merge, a row starts in `review` at H2 with no fix-up, and the chain of review, pre-merge
 * review and CI runs again before the hand-over answers the Merge? question at H2. One row per (PR, H2); the row's existence is the memory.
 */
async function carryAnswers(db: Db, held: ReadonlySet<string>): Promise<void> {
  const pushes = await db.all(db.k.selectFrom("conflict_merges as m").select(["m.repo", "m.number", "m.from_head", "m.to_head", (eb) => eb.val("base merge").as("what")]).$narrowType<{ to_head: NotNull }>()
    .where("m.state", "=", "merged").where("m.own_diff", "=", "same").where("m.to_head", "is not", null)
    .where((eb) => eb("m.repo", "in", eb.selectFrom("main.tracked_repos").select("name"))));
  for (const x of pushes) {
    const it = await prRow(db, x.repo, x.number);
    if (!it || it.kind !== "pr" || it.state !== "OPEN" || it.head_oid !== x.to_head) continue;
    const d = await getDecision(db, mergeDecisionId(x.repo, x.number, x.from_head));
    if (!d || d.answer !== "merge" || !d.answered_by || !await isOperator(db, d.answered_by, x.repo, held)) continue;
    if (await db.get(db.k.selectFrom("preapprovals").select((eb) => eb.lit(1).as("one")).where("repo", "=", x.repo).where("number", "=", x.number).where((eb) => eb.or([eb("head", "=", x.to_head), eb("state", "in", ACTIVE)])))) continue;
    // An answer the hand-over of a row wrote is that row's own; its ownPush handling carries it while the row is active.
    if (await db.get(db.k.selectFrom("audit").select((eb) => eb.lit(1).as("one")).where("action", "=", "answer").where("target", "=", d.id).where((w) => kx.like(db, "details", w.val('%"source":"preapproval"%'))))
      && await db.get(db.k.selectFrom("preapprovals").select((eb) => eb.lit(1).as("one")).where("repo", "=", x.repo).where("number", "=", x.number).where("head", "=", x.from_head).where("state", "in", ACTIVE))) continue;
    if (!await mergeApprovalOf(db, x.repo)) continue;
    const at = iso();
    const carried = await db.write(async () => {
      // Re-check under the write lock: another tick may have created it.
      if (await db.get(db.k.selectFrom("preapprovals").select((eb) => eb.lit(1).as("one")).where("repo", "=", x.repo).where("number", "=", x.number).where("head", "=", x.to_head))) return false;
      const id = (await db.get(db.k.insertInto("preapprovals").values({ repo: x.repo, number: x.number, by: d.answered_by!, at, instructions: "", state: "review", from_head: x.from_head, head: x.to_head, updated_at: at, fix_id: null }).returning("id")))!.id;
      await audit(db, ACTOR, "preapproval", `${x.repo}#${x.number}`, { id, state: "review", head: x.to_head, carried: x.from_head });
      return true;
    });
    if (!carried) continue;
    await say(db, x.repo, x.number, `${d.answered_by}'s Merge answer at ${short(x.from_head)} carries to the pipeline's ${x.what} ${short(x.to_head)} once the review, the pre-merge review and CI there are clean.`);
  }
}

/** The reasons of rows that stopped only on their review under the earlier rule: an unsure take or take-fix, or a take-fix of a row without a fix-up. */
const REVIEW_ONLY_STOP = /^the review says take(-fix)? \(unsure\)|^the review of (the PR's head|the merged head) asks for fixes$/;

/**
 * A row that stopped in asked only because of a review the rule now goes on with, at the head that is still the PR's, goes back to review
 * while its Merge? question there is still open, and that question is withdrawn: the next evaluation takes it on from the review.
 */
async function resumeReviewStops(db: Db, held: ReadonlySet<string>, wake: Wake): Promise<void> {
  const rows = await db.all(preapprovalRows(db).$narrowType<{ head: NotNull; reason: NotNull }>().where("state", "=", "asked").where("head", "is not", null).where("reason", "is not", null)
    .where((eb) => eb("repo", "in", eb.selectFrom("main.tracked_repos").select("name"))).orderBy("id"));
  for (const p of rows) {
    if (!REVIEW_ONLY_STOP.test(p.reason)) continue;
    // A later row of the PR took over from this one.
    if (await db.get(db.k.selectFrom("preapprovals").select((eb) => eb.lit(1).as("one")).where("repo", "=", p.repo).where("number", "=", p.number).where("id", ">", p.id))) continue;
    const it = await prRow(db, p.repo, p.number);
    if (!it || it.state !== "OPEN" || it.head_oid !== p.head) continue;
    const r = await reviewAt(db, p, p.head, wake);
    if (r.kind !== "take" && r.kind !== "takefix") continue;
    const d = await getDecision(db, mergeDecisionId(p.repo, p.number, p.head));
    if (!d || d.answer !== null) continue;
    if (!await isOperator(db, p.by, p.repo, held) || !await mergeApprovalOf(db, p.repo)) continue;
    const at = iso();
    const moved = await db.write(async () => {
      if (!await moveRaw(db, p, "review", { reason: null })) return false;
      await withdrawMergeQuestion(db, p.repo, p.number, p.head, at, `${approvedAhead(p)}, so the pre-approved merge goes on`);
      return true;
    });
    if (moved) await say(db, p.repo, p.number, `The review of ${p.fix_id !== null ? "the fix-up" : headName(p)} ${r.kind === "take" ? "is unsure" : r.unsure ? "is unsure and asks for fixes" : "asks for fixes"}; ${approvedAhead(p)}, so the pre-approved merge goes on and its Merge? question is withdrawn.`);
  }
}

/** Told each time at which a pass's answer changes with the clock alone. */
export type Wake = (at: number) => void;

/**
 * What advancePreapprovals reads, as change markers: the planner's input topics (the PR facts and most rows the pass reads) and `access`
 * (roles, and the audit table: the entries an answer's source is read from, and the GitHub writes that follow a base merge's own-diff
 * mark, which no other topic watches). A pass whose markers are the ones it read before and whose wake time (`Wake`) has not come would
 * move nothing.
 */
export async function preapprovalInputs(db: Db): Promise<string> {
  const seqs = await readSeqs(db);
  return [...INPUT_TOPICS, "access"].map((t) => seqs[t] ?? 0).join(",");
}

/**
 * Moves each pre-approved merge that other steps' rows have carried to a new state; the runner tick runs it when its inputs changed
 * (preapprovalInputs) or a time `wake` was told has come. Writes nothing when nothing moved, except the maintainers' write permissions it
 * reads again first (refreshSettlers). A failure tells `wake` the pass's own time, so the next tick runs it again.
 */
export async function advancePreapprovals(db: Db, log: (line: string) => void = () => {}, deps: RefreshDeps = {}, wake: Wake = () => {}): Promise<number> {
  const t = Date.now();
  let n = 0;
  let held: Set<string>;
  try {
    held = await refreshSettlers(db, log, deps, wake);
  } catch (e) {
    // Without the permission reads a stale row would end a maintainer's pre-approval: nothing moves this pass.
    log(`preapproval permissions: ${(e as Error).message}`);
    wake(t);
    return 0;
  }
  try {
    await endStaleRequests(db, held, wake);
    await settleCancelled(db);
    await carryAnswers(db, held);
    await resumeReviewStops(db, held, wake);
  } catch (e) {
    log(`preapproval requests: ${(e as Error).message}`);
    wake(t);
  }
  const rows = await db.all(preapprovalRows(db).where("state", "in", ACTIVE).where((eb) => eb("repo", "in", eb.selectFrom("main.tracked_repos").select("name"))).orderBy("id"));
  // The facts of the PRs of this row and the rows after it, loaded together when a row first needs its PR's, with the settings
  // read once for the load as in a planner pass. A row that moved or failed may have written what they read, so the next row
  // that needs them loads them again.
  let facts: Map<string, PrFacts> | null = null;
  for (const [i, p] of rows.entries()) {
    const factOf = async (): Promise<PrFacts | null> => {
      if (!facts) {
        const loaded = await withSettingsSnapshot(db, () => loadPrFacts(db, { refs: rows.slice(i).map((r) => `${r.repo}#${r.number}`) }));
        for (const f of loaded) if (f.refreshAt !== undefined) wake(f.refreshAt);
        facts = new Map(loaded.map((f) => [`${f.repo}#${f.number}`, f]));
      }
      return facts.get(`${p.repo}#${p.number}`) ?? null;
    };
    try {
      await advance(db, p, held, factOf, wake);
      if ((await db.get(db.k.selectFrom("preapprovals").select("state").where("id", "=", p.id)))!.state !== p.state) {
        n++;
        facts = null;
      }
    } catch (e) {
      facts = null;
      wake(t);
      const msg = oneLine(String((e as Error).message ?? e), 300);
      log(`preapproval ${p.repo}#${p.number}: ${msg}`);
      // Runs every tick: the item's trace gets the error once, not once per tick.
      try {
        const last = await db.get(db.k.selectFrom("audit").select("details").where("action", "=", "preapproval-error").where("target", "=", `${p.repo}#${p.number}`).orderBy(kx.rowid("audit"), "desc").limit(1));
        if (!last || (JSON.parse(last.details ?? "{}") as { error?: string }).error !== msg) await audit(db, ACTOR, "preapproval-error", `${p.repo}#${p.number}`, { id: p.id, state: p.state, error: msg });
      } catch { /* the log line above stands */ }
    }
  }
  return n;
}

export const mergeRunning = async (db: Db, repo: string): Promise<boolean> => !!await db.get(db.k.selectFrom("jobs").select((eb) => eb.lit(1).as("one")).where("repo", "=", repo).where("step", "=", "merge").where("state", "=", "running"));
export const inActiveBatch = async (db: Db, repo: string, n: number): Promise<boolean> =>
  !!await db.get(db.k.selectFrom("main.merge_batch_prs as x").innerJoin("main.merge_batches as b", "b.id", "x.batch_id").select((eb) => eb.lit(1).as("one")).where("b.repo", "=", repo).where("x.number", "=", n).where("b.state", "in", ["checking", "open"]));

/**
 * An operator cancels the PR's pre-approved merge before the merge queue has merged it. A queued PR in an integration batch is first
 * removed from the batch (the operator control: the batch PR is closed; the hold it sets is released) unless the merge is running.
 * Throws when there is none or the queue is past stopping it.
 */
export async function cancelPreapproval(db: Db, by: string, repo: string, n: number, run?: Exec, via?: string): Promise<Preapproval> {
  const p = await db.get(db.k.selectFrom("preapprovals").select("id").where("repo", "=", repo).where("number", "=", n).where("state", "in", ACTIVE).orderBy("id", "desc").limit(1));
  if (!p) throw new Error(`${repo}#${n} has no pre-approved merge in progress`);
  const state = (await db.get(db.k.selectFrom("preapprovals").select("state").where("id", "=", p.id)))!.state;
  // The state change and the take-back of the hand-over answer are one transaction, so the merge queue never sees a cancelled row with a live answer.
  const finish = async () => {
    if (!await cancelRow(db, p.id, by, `cancelled by ${by}`, `${by} cancelled the pre-approved merge.`, true, via)) throw new Error("the pre-approved merge changed a moment ago");
  };
  if (state === "queued" && await inActiveBatch(db, repo, n)) {
    if (await mergeRunning(db, repo)) throw new Error("a merge of the repo is running: it may be merging this PR");
    // The removal holds the PR's merge; a hold that was there before stays, the one the removal set is released again after the row
    // is cancelled (so the queue never sees an unheld PR with a live Merge answer), also when the removal or the cancel fails.
    const heldBefore = !!await db.get(db.k.selectFrom("main.merge_holds").select((eb) => eb.lit(1).as("one")).where("repo", "=", repo).where("number", "=", n));
    try {
      const r = await removeFromBatch(db, by, repo, n, run);
      const b = await db.get(db.k.selectFrom("main.merge_batches").select("state").where("repo", "=", repo).where("branch", "=", r.batch).orderBy("id", "desc").limit(1));
      if (b?.state === "merged") throw new Error("the PR is already merged: its batch merged");
      await finish();
    } finally {
      if (!heldBefore) await releaseMerge(db, by, repo, n);
    }
  } else await finish();
  return (await preapprovalOf(db, repo, n))!;
}

/**
 * Operator: queues the PR's failed pre-approved merge again with the same instructions at the PR's current head, as a new
 * pre-approval (the same path as the first press: the audit entry and the thread line are the ones of any pre-approval).
 * An open Merge? question at the head is answered by the new row's hand-over as it would have been the first time.
 * Throws when the latest pre-approval did not fail.
 */
export async function retryPreapproval(db: Db, by: string, repo: string, n: number): Promise<Preapproval> {
  const p = await db.get(preapprovalRows(db).where("repo", "=", repo).where("number", "=", n).orderBy("id", "desc").limit(1));
  if (!p || p.state !== "failed") throw new Error(`${repo}#${n} has no failed pre-approved merge`);
  if (!await isOperator(db, by, repo)) throw new Error(`${by} does not settle decisions on ${repo}`);
  await runPipelineStep(db, { repo, number: n, step: { kind: "fixup", instructions: p.instructions, merge: true }, by });
  return (await preapprovalOf(db, repo, n))!;
}
