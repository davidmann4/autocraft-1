// Facts: everything the review-to-merge rules read about open PRs, loaded in one pass for a whole database or a slice of it.
// Each concept has one definition here. Where a step selector and the merge queue used different
// definitions, the queue's wins; the differences are listed in the report of this change, not here.
import { pipelineWrites } from "./rules.ts";
import { quietFixPrs } from "../security/quiet.ts";
export { quietFixPrs };
import { commentApprovalOf } from "../act/approval.ts";
import { actionable } from "../decisions.ts";
import { ownLogins } from "../github/identity.ts";
import { notOwnIntegrationExpr, groupHeldExpr, backlogHeldExpr } from "../dupes/held.ts";
import { conflictAskRetryAtOf, conflictBucketOf } from "../fixup/conflict-state.ts";
import { pushApprovalOf } from "../fixup/approval.ts";
import { fixIssueApprovalOf } from "../implement/approval.ts";
import { featureOn } from "../build/features.ts";
import { ENDED_STATES, type ImplementationState } from "../implement/types.ts";
import { authorWritesOf } from "../fixup/author-permission.ts";
import { longLivedAll, pushable, sameRepo, type LongLived } from "../fixup/pushable.ts";
import { FAST_FLOOR, fastScoreExpr } from "../fasttrack.ts";
import { latestRun, refereeClosed, settledSet } from "../classify/settled.ts";
import { redMainRepos, MAIN_FIX_BRANCH_PREFIX } from "../mainci/index.ts";
import { batchStates, membersOf } from "../merge/batch-store.ts";
import { changesRequestedWhy, FORMAL_STATES, gatesOf, GATE_FAILURES, failureNote } from "../merge/changes-requested.ts";
import { ciApprovalOf } from "../merge/ci-approval.ts";
import { mergeApprovalOf } from "../merge/approval.ts";
import { mergeHolds } from "../merge/holds.ts";
import { reposWithNoCi } from "../merge/no-ci.ts";
import { effectiveCi } from "../optional-checks.ts";
import { inPilot, pilotExpr, pipelineRepos } from "../pilot.ts";
import { loadWorkflowFacts } from "../workflow/facts.ts";
import { holdMap } from "../outside.ts";
import { attemptsIn, parseFixes } from "../fixup/candidates.ts";
import { operatorTries, operatorTriesLeft, operatorWork, queuedOperatorFix } from "../preapproval/state.ts";
import { getTask, TERMINAL } from "../build/tasks.ts";
import { SINCE_KEY } from "../postmerge/select.ts";
import { verifyOverride } from "../merge/verify-override.ts";
import { unknownOf } from "../merge/mergeable.ts";
import { BASE_NAME, PIPELINE_LOGIN_KEY, mergeDecisionId, holdDecisionId } from "./rules.ts";
import { openGroupExpr, unsureAtQuery } from "./rule-queries.ts";
import { getRule, tierOf, tierKey, tiersOf, type AuthorRef, type Tier } from "../whitelist.ts";
import { findingsOf, premergeFixUsedIn, premergeRows } from "../premerge/store.ts";
import { headOf } from "../review/candidates.ts";
import { parsePublic } from "../review/opus-parse.ts";
import { rereadPaceAt } from "../review/diff.ts";
import { ownerOf, slugOf } from "../owners.ts";
import { EXTRAS_PENDING_REASON } from "./sensitive.ts";
import { CARRIED, carriedReview } from "../review/carry.ts";
import { postSourcesOf } from "../review/post-source.ts";
import { staleReviews } from "../review/discussion.ts";
import { nextUtcMidnight, reviewHolds } from "../review/gate.ts";
import { scopeAnswers, unsettledScope } from "../review/candidates.ts";
import { NOT_RUST_REASON, PRIVATE_REASON, cachedRust } from "../verify/candidates.ts";
import { CIFIX_PUSH_STATES, CIFIX_TRY_STATES, MAX_FAILURES, labelWithScopeAnswer, sizeOf, unsentAsk } from "./rules.ts";
import type { AssignFacts, PassFacts, PrFacts, PrTier } from "./plan.ts";
import { settledByExpr } from "../settlers.ts";
import { activeTrips, brokeHeads } from "../push-outcomes.ts";
import { tripsOfRepo } from "./push-outcome.ts";
import { setting } from "../settings-read.ts";
import { allOf, everySeq, someSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";
import type { Compilable, Expression, SqlBool } from "kysely";
import { bytewise, inList, jsonText, jsonType, jsonValid, like, literal, refIn, rowid, type AnyEb } from "../db/kx.ts";

export type { PrFacts } from "./plan.ts";

export type LoadOptions = {
  repo?: string;
  /** Only these PRs, as "repo#number". */
  refs?: Iterable<string>;
  /** Decision time in ms (default: the clock). */
  now?: number;
  /** The GitHub App's slug, when it is not to be read from the registered app (null: none). */
  appSlug?: string | null;
  /** The classification run for labels (default: latestRun). */
  run?: string | null;
};

/** `repo#number` of the row of alias `a` as SQL text, and `@` with the column `at` after it when given. */
const keyOf = (eb: AnyEb, a: string, at?: string) => {
  const ref = eb(eb(eb.ref(`${a}.repo`), "||", eb.val("#")), "||", eb.ref(`${a}.number`));
  return at ? eb(eb(ref, "||", eb.val("@")), "||", eb.ref(`${a}.${at}`)) : ref;
};

const parseList = (s: string | null): unknown[] => { try { const v = JSON.parse(s ?? "[]") as unknown; return Array.isArray(v) ? v : []; } catch { return []; } };
const safeJson = (s: string | null): unknown => { try { return JSON.parse(s!); } catch { return null; } };

const selectRows = (db: Db) => db.k.selectFrom("items as i")
  .leftJoin("pr_checks as c", (j) => j.onRef("c.repo", "=", "i.repo").onRef("c.number", "=", "i.number"))
  .leftJoin("item_rank as p", (j) => j.onRef("p.repo", "=", "i.repo").onRef("p.number", "=", "i.number"))
  .leftJoin("opus_reviews as l", (j) => j.onRef("l.repo", "=", "i.repo").onRef("l.number", "=", "i.number").on("l.head_oid", "=", (eb) =>
    eb.selectFrom("opus_reviews as r").select("r.head_oid").whereRef("r.repo", "=", "i.repo").whereRef("r.number", "=", "i.number").where("r.verdict", "is not", null)
      .orderBy("r.at", "desc").orderBy(rowid("opus_reviews", "r"), "desc").limit(1)))
  .leftJoin("diff_facts as df", (j) => j.onRef("df.repo", "=", "l.repo").onRef("df.number", "=", "l.number").onRef("df.head_oid", "=", "l.head_oid"))
  .select((eb) => ["i.repo", "i.number", "i.author", "i.author_id", "i.author_type", "i.assignees", "i.state", "i.review_decision", "i.head_oid", "i.updated_at", "i.is_draft", "i.additions", "i.deletions", "i.mergeable as i_mergeable",
    "i.head_repo", "i.head_ref", "i.base_ref", "i.maintainer_can_modify as i_can",
    "c.head_oid as c_head", "c.fetched_at as c_at", "c.state as c_state", "c.is_draft as c_draft", "c.overall", eb.case().when("c.overall", "=", "failure").then(eb.ref("c.checks")).end().as("c_checks"), "c.mergeable as c_mergeable", "c.maintainer_can_modify as c_can",
    "l.head_oid as r_head", "l.at as r_at", "l.verdict as r_verdict", "l.sure as r_sure", "l.mode as r_mode", "l.reason as r_reason", "l.fixes as r_fixes",
    eb.case().when("l.public_review", "is", null).then(eb.lit(null)).when(eb.not(jsonValid(db, "l.public_review"))).then(eb.val(""))
      .when(eb.and([eb(jsonType(db, "l.public_review", "$.summary"), "=", "text"), eb(jsonType(db, "l.public_review", "$.points"), "=", "array")])).then(jsonText(db, "l.public_review", "$.summary")).else(eb.val("")).end().as("r_public"),
    "l.conflicts as r_conflicts",
    "df.reasons as d_reasons", "df.lines as d_lines", "df.pending as d_pending", "df.last_read as d_last_read",
    fastScoreExpr(db, eb, "i.repo", "i.number", "p.score").as("score"),
    pilotExpr(db, eb, "i").as("in_pilot"), notOwnIntegrationExpr(db, eb, "i").as("not_integration"),
    eb.exists(eb.selectFrom("main.merge_batches as mb").select(eb.lit(1).as("one")).whereRef("mb.repo", "=", "i.repo").whereRef("mb.pr_number", "=", "i.number")).as("batch_pr"),
    backlogHeldExpr(db, eb, "i").as("held_backlog"),
    eb.or([
      eb.exists(eb.selectFrom("decisions as dh").select(eb.lit(1).as("one")).where("dh.kind", "=", "duplicate").where(eb.not(like(db, "dh.id", eb.val("%:dupegroup:%"))))
        .whereRef("dh.repo", "=", "i.repo").whereRef("dh.number", "=", "i.number").where((w) => w.or([w("dh.answer", "is", null), w("dh.answer", "=", "close")]))),
      groupHeldExpr(db, eb, "i"),
    ]).as("held_dup"),
  ])
  .$narrowType<{ state: "OPEN" | "MERGED" | "CLOSED" }>()
  .where("i.kind", "=", "pr")
  .where((eb) => eb.or([eb("i.state", "=", "OPEN"), eb.and([eb("i.state", "=", "MERGED"), eb("l.verdict", "in", ["take", "take-fix"])]),
    eb.exists(eb.selectFrom("merges as mm").select(eb.lit(1).as("one")).whereRef("mm.repo", "=", "i.repo").whereRef("mm.number", "=", "i.number").where("mm.outcome", "=", "merged")),
    // A PR of a live implementation, merged or closed: its attempt still has to end with it (decidePr).
    eb.exists(eb.selectFrom("main.implementations as im").select(eb.lit(1).as("one")).whereRef("im.repo", "=", "i.repo").whereRef("im.pr_number", "=", "i.number")
      .where("im.state", "not in", [...ENDED_STATES]))]));

/** The statements named by the given stored `conflicts` values (JSON [{id, reason}]), one entry per id with the first reason; unknown ids and unreadable values count for nothing. */
async function statementConflicts(find: { get(id: number): Promise<unknown> }, stored: unknown[]): Promise<PrFacts["statementConflicts"]> {
  const out: PrFacts["statementConflicts"] = [];
  for (const v of stored) {
    if (!Array.isArray(v)) continue;
    for (const h of v as { id?: unknown; reason?: unknown }[]) {
      if (typeof h?.id !== "number" || out.some((d) => d.id === h.id)) continue;
      const d = await find.get(h.id) as { id: number; repo: string; number: number | null; text: string } | undefined;
      if (d) out.push({ id: d.id, where: d.number === null ? d.repo : `${d.repo}#${d.number}`, text: d.text, reason: typeof h.reason === "string" ? h.reason : "" });
    }
  }
  return out.sort((a, b) => a.id - b.id);
}

/** The instance-wide inputs of decidePr at `now`: read once per pass, not per PR. */
export const loadPass = (now: number = Date.now()): PassFacts => ({ rereadPaceAt: rereadPaceAt(now) });

/** Keeps the earliest time after `now` per ref: what `refreshAt` is made from. */
export function refreshTimes(now: number): { soon: (ref: string, at: number | undefined) => void; at: (ref: string, ...more: (number | undefined)[]) => number | undefined } {
  const times = new Map<string, number>();
  const later = (t: number | undefined): t is number => t !== undefined && Number.isFinite(t) && t > now;
  return {
    soon: (ref, t) => { if (later(t) && !(times.get(ref)! <= t)) times.set(ref, t); },
    at: (ref, ...more) => [times.get(ref), ...more].filter(later).reduce<number | undefined>((m, t) => (m === undefined || t < m ? t : m), undefined),
  };
}

/** Facts of every open PR (and merged PRs with a take or take-fix review) of the database, repo or refs given. One pass: per-repo values are read once. */
export async function loadPrFacts(db: Db, opts: LoadOptions = {}): Promise<PrFacts[]> {
  const now = opts.now ?? Date.now();
  /** The `unsent` fact of a step's ask comments that never reached GitHub; absent when the ask is due as if none had failed. */
  const unsentOf = (ats: string[]): { unsent?: { until: number } | "final" } => { const u = unsentAsk(ats, now); return u === null ? {} : { unsent: u }; };
  // Clock-driven changes the facts below do not show as a time of their own (expiries, daily counts, cache lifetimes), per PR.
  const refresh = refreshTimes(now);
  const refs = opts.refs ? [...opts.refs] : undefined;
  const rows = await db.all(selectRows(db).$if(!!opts.repo, (q) => q.where("i.repo", "=", opts.repo!)).$if(!!refs, (q) => q.where(refIn(db, "i", refs!))).orderBy("i.repo").orderBy("i.number"));

  // Values read once for all PRs.
  const run = opts.run !== undefined ? opts.run : await latestRun(db);
  // Rows of per-PR tables, read once for the load and keyed by `repo#number` (narrowed like the PRs: by repo or refs).
  const narrow = (eb: AnyEb, a: string): Expression<SqlBool> => eb.and([...(opts.repo ? [eb(eb.ref(`${a}.repo`), "=", opts.repo)] : []), ...(refs ? [refIn(db, a, refs)] : [])]);
  const keyed = async <T extends { k: string }>(q: Compilable<T>): Promise<Map<string, Omit<T, "k">[]>> => {
    const out = new Map<string, Omit<T, "k">[]>();
    for (const row of await db.all(q)) {
      const { k, ...rest } = row;
      (out.get(k) ?? out.set(k, []).get(k)!).push(rest);
    }
    return out;
  };
  const settled = await settledSet(db, run, rows.filter((r) => r.in_pilot && r.not_integration).map((r) => `${r.repo}#${r.number}`));
  const stale = await staleReviews(db, opts.repo, false, { now, refresh: refresh.soon });
  const staleActionable = await staleReviews(db, opts.repo, true, { now, refresh: refresh.soon });
  const scope = await scopeAnswers(db);
  const unsettled = await unsettledScope(db);
  const gates = await gatesOf(db, opts.repo);
  const holds = await mergeHolds(db, opts.repo);
  const inBatch = await batchStates(db, opts.repo);
  const own = await ownFixPrs(db, opts.repo, opts.appSlug);
  const assigned = await assignmentsOf(db, opts.repo);
  const mainRed = await redMainRepos(db);
  const tripped = await activeTrips(db);
  const brokeAt = await brokeHeads(db, opts.repo);
  const implPrs = await implementationPrs(db, opts.repo);
  const wfs = await loadWorkflowFacts(db, opts.repo);
  // The per-PR rows below are independent reads: they run together (on Postgres, over the pool).
  const { ourFixupHead, ourSameDiffMerge, pushedHere, pushedOffAt, carries, fixupsOf, fixupAt, lintFixup, lintOperator, lintCifix, carryRows, conflictRowsOf, lintConflict, cifixOf, merges, waiting, verifRows, otherOpen, openQuestion, unsureAt, reviewRows } = await allOf({
    // carriedReview only carries our own plain fix-up (no carry or pre-merge source) as the head: skip its compiles for other PRs.
    ourFixupHead: keyed(db.k.selectFrom("fixups as f").select((eb) => keyOf(eb, "f", "to_head").as("k")).where("f.state", "=", "pushed").where("f.source", "is", null).where((eb) => narrow(eb, "f"))),
    ourSameDiffMerge: keyed(db.k.selectFrom("conflict_merges as c").select((eb) => keyOf(eb, "c", "to_head").as("k")).where("c.state", "=", "merged").where("c.own_diff", "=", "same").where((eb) => narrow(eb, "c"))),
    // A head we pushed, or the head our push moved off (the mirror may still show it, and our own comment makes its review stale).
    pushedHere: keyed(db.k.selectFrom("push_outcomes as p").select((eb) => keyOf(eb, "p", "to_oid").as("k")).where((eb) => narrow(eb, "p"))
      .union(db.k.selectFrom("push_outcomes as p").select((eb) => keyOf(eb, "p", "from_oid").as("k")).where("p.from_oid", "is not", null).where((eb) => narrow(eb, "p")))),
    pushedOffAt: keyed(db.k.selectFrom("push_outcomes as p").select((eb) => [keyOf(eb, "p", "from_oid").as("k"), "p.at"]).whereRef("p.to_oid", "<>", "p.from_oid").where((eb) => narrow(eb, "p"))),
    carries: keyed(db.k.selectFrom("dupe_carries as c").select((eb) => [keyOf(eb, "c").as("k"), "c.decision_id", "c.attempts"]).where("c.state", "=", "queued").where((eb) => narrow(eb, "c")).orderBy(rowid("dupe_carries", "c"))),
    fixupsOf: keyed(db.k.selectFrom("fixups as f").select((eb) => [keyOf(eb, "f").as("k"), "f.source", "f.state", "f.reason"]).where((eb) => narrow(eb, "f"))),
    // A review's own fix-up rows at a head, in the order of the per-PR index (created_at).
    fixupAt: keyed(db.k.selectFrom("fixups as f").select((eb) => [keyOf(eb, "f", "from_head").as("k"), "f.state", "f.created_at"])
      .where("f.source", "is", null).where("f.state", "in", ["pushed", "cannot-push", "too-large", "asked", "comment-failed", "push-denied", "linting", "comment-unsent"]).where((eb) => narrow(eb, "f"))
      .orderBy("f.created_at").orderBy(rowid("fixups", "f"))),
    lintFixup: keyed(db.k.selectFrom("fixups as f").select((eb) => [keyOf(eb, "f", "from_head").as("k"), "f.source", "f.lint_task"])
      .where("f.state", "=", "linting").where((eb) => eb(eb.fn.coalesce("f.source", eb.val("")), "!=", "operator")).where((eb) => narrow(eb, "f")).orderBy(rowid("fixups", "f"))),
    // An operator's fix-up works the current head, with or without a review there, so its stored patch is read at the head before the review is.
    lintOperator: keyed(db.k.selectFrom("fixups as f").select((eb) => [keyOf(eb, "f", "from_head").as("k"), "f.lint_task"])
      .where("f.state", "=", "linting").where("f.source", "=", "operator").where((eb) => narrow(eb, "f")).orderBy(rowid("fixups", "f"))),
    lintCifix: keyed(db.k.selectFrom("ci_fixes as c").select((eb) => [keyOf(eb, "c", "head").as("k"), "c.lint_task"]).where("c.state", "=", "linting").where((eb) => narrow(eb, "c")).orderBy(rowid("ci_fixes", "c"))),
    carryRows: keyed(db.k.selectFrom("dupe_carries as c")
      .innerJoin("dupe_group_items as g", (j) => j.onRef("g.decision_id", "=", "c.decision_id").on("g.kind", "=", "pr").on("g.role", "=", "close"))
      .leftJoin("items as i", (j) => j.onRef("i.repo", "=", "c.repo").onRef("i.number", "=", "g.number"))
      .select((eb) => [keyOf(eb, "c").as("k"), "g.number", "g.detail", "i.author", "i.author_id as id"]).distinct()
      .where((eb) => like(db, "c.outcome", eb.val("pushed%"))).where((eb) => narrow(eb, "c"))),
    conflictRowsOf: keyed(db.k.selectFrom("conflict_merges as c").select((eb) => [keyOf(eb, "c").as("k"), "c.from_head", "c.state", "c.created_at"]).where((eb) => narrow(eb, "c")).orderBy(rowid("conflict_merges", "c"))),
    lintConflict: keyed(db.k.selectFrom("conflict_merges as c").select((eb) => [keyOf(eb, "c", "from_head").as("k"), "c.lint_task"]).where("c.state", "=", "linting").where((eb) => narrow(eb, "c")).orderBy(rowid("conflict_merges", "c"))),
    cifixOf: keyed(db.k.selectFrom("ci_fixes as c").select((eb) => [keyOf(eb, "c").as("k"), "c.head", "c.state", "c.created_at", "c.task_id", "c.runs", "c.reason"]).where((eb) => narrow(eb, "c"))
      .orderBy("c.created_at").orderBy(rowid("ci_fixes", "c"))),
    // The latest merge attempt at each head (first in the order) and the refusals there.
    merges: keyed(db.k.selectFrom("merges as m").select((eb) => [keyOf(eb, "m", "head_oid").as("k"), "m.outcome", "m.reason", "m.ci", "m.mergeable", "m.at",
      eb.selectFrom("merges as m2").select(eb.fn.countAll<number>().as("n")).whereRef("m2.repo", "=", "m.repo").whereRef("m2.number", "=", "m.number").whereRef("m2.head_oid", "=", "m.head_oid").where("m2.outcome", "=", "refused").$asScalar().$notNull().as("refusals")])
      .where((eb) => narrow(eb, "m")).orderBy("m.at", "desc").orderBy(rowid("merges", "m"), "desc")),
    waiting: keyed(db.k.selectFrom("ci_run_approvals as a").select((eb) => [keyOf(eb, "a", "head_oid").as("k"), "a.runs", "a.approved", "a.reread", "a.failed", "a.cross_repo", "a.approved_at"]).where((eb) => narrow(eb, "a"))),
    verifRows: keyed(db.k.selectFrom("verifications as v").select((eb) => [keyOf(eb, "v", "head_sha").as("k"), "v.state", "v.kind", "v.summary", "v.note"]).where((eb) => narrow(eb, "v"))),
    // An item has one open question at a time (src/merge/withdraw.ts): a Hold question would set another one aside, so it waits for that one.
    otherOpen: keyed(db.k.selectFrom("decisions as d").select((eb) => keyOf(eb, "d").as("k")).distinct().where("d.answer", "is", null)
      .where((eb) => eb.and([eb.not(like(db, "d.id", eb.val("%~replaced-%"))), eb.not(like(db, "d.id", eb.val("%:dupegroup:%")))])).where("d.kind", "in", ["scope", "merge", "close"]).where((eb) => narrow(eb, "d"))),
    // OPEN_QUESTION_SQL for every PR.
    openQuestion: keyed(db.k.selectFrom("decisions as d").select((eb) => keyOf(eb, "d").as("k")).distinct().where("d.kind", "=", "merge").where("d.answer", "is", null)
      .where((eb) => eb.not(like(db, "d.id", eb.val("%~replaced-%")))).where((eb) => narrow(eb, "d"))),
    // unsureAtQuery for every head: a take or take-fix review there with sure = 0.
    unsureAt: keyed(db.k.selectFrom("opus_review_history as o").select((eb) => keyOf(eb, "o", "head_oid").as("k")).where("o.verdict", "in", ["take", "take-fix"]).where("o.sure", "=", 0).where((eb) => narrow(eb, "o"))
      .union(db.k.selectFrom("opus_reviews as o").select((eb) => keyOf(eb, "o", "head_oid").as("k")).where("o.verdict", "in", ["take", "take-fix"]).where("o.sure", "=", 0).where((eb) => narrow(eb, "o")))),
    // Only formal reviews with an author: changesRequestedBy() reads no others.
    reviewRows: keyed(db.k.selectFrom("comments as c").innerJoin("items as i", (j) => j.onRef("i.repo", "=", "c.repo").onRef("i.number", "=", "c.number").on("i.kind", "=", "pr").on("i.state", "=", "OPEN"))
      .select((eb) => [keyOf(eb, "c").as("k"), "c.author", "c.author_association as association", "c.review_state as state", "c.created_at as at"])
      .where("c.kind", "=", "review").where("c.author", "is not", null).where("c.review_state", "in", FORMAL_STATES).where((eb) => narrow(eb, "c")).orderBy(rowid("comments", "c"))
      .$narrowType<{ author: string }>()),
  });
  const answers = new Map((await actionable(db)).filter((a) => a.kind === "merge").map((a) => [a.id, a.answer]));
  const pipelineOn = pipelineWrites(await setting(db, "pipeline_enabled"));
  const posts = new Map((await db.all(db.k.selectFrom("review_posts").select(["repo", "number", "review_id", "head_oid", "posted_at", "opus_at"])))
    .map((p) => [`${p.repo}#${p.number}`, p]));
  const grouped = new Set((await db.all(db.k.selectFrom("dupe_group_items as gi").innerJoin("decisions as g", "g.id", "gi.decision_id")
    .select((eb) => keyOf(eb, "gi").as("ref")).where((eb) => openGroupExpr(db, eb)).where("gi.role", "<>", "stay"))).map((r) => r.ref));
  const activeBatched = new Set((await db.all(db.k.selectFrom("main.merge_batch_prs as p").innerJoin("main.merge_batches as b", "b.id", "p.batch_id")
    .select((eb) => eb(eb(eb.ref("b.repo"), "||", eb.val("#")), "||", eb.cast<string>("p.number", "text")).as("ref")).where("b.state", "in", ["checking", "open"]))).map((x) => x.ref));
  const mergedByPipeline = new Map((await db.all(db.k.selectFrom("merges as m")
    .select((eb) => [keyOf(eb, "m").as("ref"), eb.fn.min<string>("m.at").as("merged_at"),
      eb.selectFrom("merges as x").select("x.head_oid").whereRef("x.repo", "=", "m.repo").whereRef("x.number", "=", "m.number").where("x.outcome", "=", "merged")
        .orderBy("x.at", "desc").orderBy(rowid("merges", "x"), "desc").limit(1).as("head")])
    .where("m.outcome", "=", "merged").groupBy(["m.repo", "m.number"]))).map((x) => [x.ref, x]));
  const pmReviews = new Map((await db.all(db.k.selectFrom("postmerge_reviews").select((eb) => [keyOf(eb, "postmerge_reviews").as("ref"), "at", "error"]))).map((x) => [x.ref, x]));
  const since = await setting(db, SINCE_KEY) ?? "9999";
  const operator = await operatorWork(db, opts.repo, now);
  const carryUnsent = (repo: string, number: number, decision: string) => db.all(db.k.selectFrom("fixups").select("created_at").where("repo", "=", repo).where("number", "=", number).where("source", "=", "carry").where("carry_decision", "=", decision).where("state", "=", "comment-unsent"));
  const carryPoints = (decision: string) => db.all(db.k.selectFrom("dupe_group_items").select("detail").where("decision_id", "=", decision).where("kind", "=", "pr").where("role", "=", "close").orderBy("number"));
  const taskEnded = async (id: number | null): Promise<boolean> => { const t = id != null ? await getTask(db, id) : null; return !t || TERMINAL.includes(t.state); };
  const authorWrites = await authorWritesOf(db, now);
  const postSource = await postSourcesOf(db, rows.filter((r) => r.r_mode === CARRIED && r.r_head).map((r) => `${r.repo}#${r.number}`));
  // In a repo on the maintainer workflow the tier also decides, before any review, whether a PR is on the auto path.
  const queued = rows.filter((r) => r.in_pilot && r.not_integration && (r.r_verdict === "take" || r.r_verdict === "take-fix" || wfs.model(r.repo) === "new") && r.author);
  const tiers = await tiersOf(db, queued.map((r) => ({ login: r.author!, id: r.author_id })));

  const repoMemo = new Map<string, { f: PrFacts["repoFacts"]; pub: boolean; longLived: LongLived; defaultBranch: string | null }>();
  // Repo rows, CI presence and long-lived branches, read once for every repo on first use.
  let tables: { repos: Map<string, { name: string; visibility: string | null; default_branch: string | null }>; noCi: Set<string>; longLived: (repo: string) => LongLived } | undefined;
  const repoTables = async () => (tables ??= ({
    repos: new Map((await db.all(db.k.selectFrom("repos").select(["name", "visibility", "default_branch"]))).map((x) => [x.name, x])),
    noCi: await reposWithNoCi(db), longLived: await longLivedAll(db),
  }));
  const repoOf = async (repo: string) => {
    let m = repoMemo.get(repo);
    if (!m) {
      const t = await repoTables(), row = t.repos.get(repo);
      m = {
        f: { mergeApproved: !!await mergeApprovalOf(db, repo), pushApproved: await pushApprovalOf(db, repo) !== null, commentApproved: await commentApprovalOf(db, repo) !== null, ciApproved: await ciApprovalOf(db, repo) !== null,
          noCi: t.noCi.has(repo), mainRed: mainRed.has(repo), fixIssueApproved: await fixIssueApprovalOf(db, repo) !== null,
          implementOn: await featureOn(db, "implement", repo), workflow: wfs.model(repo) },
        pub: row?.visibility === "public",
        longLived: t.longLived(repo),
        defaultBranch: row?.default_branch ?? null,
      };
      repoMemo.set(repo, m);
    }
    return m;
  };

  // Open PRs by repo, head branch and head repo (lower case), lowest number first: the PR another one is stacked on. Only heads that are an open PR's base.
  // The bases are one uncorrelated list, which SQLite builds once; a correlated EXISTS rescans the repo's open PRs for every row.
  const openByHead = new Map<string, number[]>();
  for (const o of await db.all(db.k.selectFrom("items as i")
    .select((eb) => [eb(eb(eb(eb(eb.ref("i.repo"), "||", eb.val(" ")), "||", eb.ref("i.head_ref")), "||", eb.val(" ")), "||", eb.fn<string>("lower", [eb.ref("i.head_repo")])).as("k"), "i.number"])
    .where("i.kind", "=", "pr").where("i.state", "=", "OPEN").where("i.head_ref", "is not", null).where("i.head_repo", "is not", null).where(inList(db, "i.repo", [...new Set(rows.map((r) => r.repo))]))
    .where((eb) => eb(eb.refTuple("i.repo", "i.head_ref"), "in", eb.selectFrom("items as b").select(["b.repo", "b.base_ref"]).where("b.kind", "=", "pr").where("b.state", "=", "OPEN").where("b.base_ref", "is not", null).$asTuple("repo", "base_ref")))
    .orderBy("i.number"))) (openByHead.get(o.k) ?? openByHead.set(o.k, []).get(o.k)!).push(o.number);
  const retriedAfter = (target: string, at: string) => db.get(db.k.selectFrom("audit").select((eb) => eb.lit(1).as("one")).where("target", "=", target).where("action", "=", "retry").where("at", ">", at).limit(1));
  const verifAt = (ref: string, head: string) => verifRows.get(`${ref}@${head}`)?.[0];
  // The current head of an open merge-entry PR (src/workflow) in a repo on the maintainer workflow: the head its queue facts are read at; null for every other PR.
  const mergeEntryHead = (r: (typeof rows)[number]): string | null =>
    r.state === "OPEN" && !!r.not_integration && wfs.model(r.repo) === "new" && wfs.ofPr(r.repo, r.number, implPrs.get(`${r.repo}#${r.number}`)?.issue ?? null)?.entry === "merge" ? headOf(r) : null;
  // The cached diff facts at those heads (a reviewed PR's come with its row, at the review head).
  const mxKeys = rows.flatMap((r) => { const h = mergeEntryHead(r); return h ? [`${r.repo}#${r.number}@${h}`] : []; });
  const mxDiff = new Map(mxKeys.length ? (await db.all(db.k.selectFrom("diff_facts as x").select((eb) => [keyOf(eb, "x", "head_oid").as("k"), "x.reasons", "x.lines", "x.pending", "x.last_read"])
    .where((eb) => inList(db, keyOf(eb, "x", "head_oid"), mxKeys)))).map((x) => [x.k, x]) : []);
  // The answer of the merge and hold decisions at each reviewed head, by id (null: not answered yet); the loop looks up no others.
  const decisionIds = rows.flatMap((r) => { const h = mergeEntryHead(r) ?? (r.r_head && r.r_verdict && r.r_at ? r.r_head : null); return h ? [mergeDecisionId(r.repo, r.number, h), holdDecisionId(r.repo, r.number, h)] : []; });
  const decisionRows = await db.all(db.k.selectFrom("decisions").select(["id", "answer", "exec_state"]).where(inList(db, "id", decisionIds)));
  const decisionAnswers = new Map(decisionRows.map((d) => [d.id, d.answer]));
  // Answered, but its person has no sign-in or access yet, or it is disputed: the same states the merge step leaves out (src/github/user-lane.ts isWaiting).
  const execWaiting = new Set(decisionRows.filter((d) => d.exec_state === "waiting-token" || d.exec_state === "waiting-permission" || d.exec_state === "disputed").map((d) => d.id));
  const holdQuestionOf = (ref: string, id: string): PrFacts["decision"]["hold"] => {
    const asked = decisionAnswers.has(id), answer = decisionAnswers.get(id) ?? null;
    return { asked, open: asked && answer === null, answer, otherOpen: otherOpen.has(ref) };
  };
  // The settled Merge answers, by decision id: when they were given.
  const mergeAnsweredAt = new Map((await db.all(db.k.selectFrom("decisions").select(["id", "answered_at"]).where("kind", "=", "merge").where("answer", "=", "merge").where("answered_at", "is not", null)
    .where((eb) => settledByExpr(db, eb, "decisions")).$narrowType<{ answered_at: string }>())).map((d) => [d.id, d.answered_at]));
  const answeredAfter = (id: string, at: string): boolean => { const a = mergeAnsweredAt.get(id); return a !== undefined && a > at; };
  const pushChain = await pushChainOf(db);
  const ownHead = await ownHeadOf(db);
  // Pre-merge reviews at the queue head of each PR (its latest review's head, a merge entry's current head), the only ones the loop reads.
  const premergeKeys = rows.flatMap((r) => { const h = mergeEntryHead(r) ?? r.r_head; return h ? [`${r.repo}#${r.number}@${h}`] : []; });
  const premerge = await premergeRows(db, (eb) => eb.and([narrow(eb, "p"), inList(db, keyOf(eb, "p", "head_oid"), premergeKeys)]));
  // The owner statements the reviews' and pre-merge reviews' conflicts name, in one read.
  const statementIds = new Set<number>();
  for (const r of rows) {
    const mxh = mergeEntryHead(r);
    if (!mxh && (!r.r_head || !r.r_verdict || !r.r_at)) continue;
    for (const v of [mxh ? null : safeJson(r.r_conflicts), safeJson(premerge.get(`${r.repo}#${r.number}@${mxh ?? r.r_head}`)?.conflicts ?? null)]) {
      if (Array.isArray(v)) for (const h of v as { id?: unknown }[]) if (typeof h?.id === "number") statementIds.add(h.id);
    }
  }
  const statements = new Map(statementIds.size ? (await db.all(db.k.selectFrom("owner_statements").select(["id", "repo", "number", "text"]).where(inList(db, "id", [...statementIds], "bigint")))).map((x) => [x.id, x]) : []);
  const statement = { get: async (id: number) => statements.get(id) };
  const batchTip = (repo: string, number: number) => db.get(db.k.selectFrom("merge_batches as b").innerJoin("ci_run_approvals as a", (j) => j.onRef("a.repo", "=", "b.repo").onRef("a.number", "=", "b.pr_number").onRef("a.head_oid", "=", "b.commit_sha"))
    .select(["a.runs", "a.approved", "a.reread", "a.failed", "a.cross_repo"]).where("b.repo", "=", repo).where("b.pr_number", "=", number).where("b.state", "=", "open")
    .where((eb) => eb.not(eb.exists(eb.selectFrom("merge_batch_prs as p").select(eb.lit(1).as("one")).whereRef("p.batch_id", "=", "b.id").where((w) => w.not(w.exists(
      w.selectFrom("final_reviews as l").select(w.lit(1).as("one")).whereRef("l.repo", "=", "b.repo").whereRef("l.number", "=", "p.number").whereRef("l.head_oid", "=", "p.head_oid").where("l.verdict", "in", ["take", "take-fix"])
        .where((x) => x("l.head_oid", "=", x.selectFrom("opus_reviews as r").select("r.head_oid").whereRef("r.repo", "=", "l.repo").whereRef("r.number", "=", "l.number").where("r.verdict", "is not", null)
          .orderBy("r.at", "desc").orderBy(rowid("opus_reviews", "r"), "desc").limit(1)))))))))
    .orderBy("b.id").limit(1));

  const batchOf = (repo: string, number: number) => db.get(db.k.selectFrom("merge_batches").select(["id", "commit_sha"]).where("repo", "=", repo).where("pr_number", "=", number).where("state", "in", ["checking", "open"]).orderBy("id").limit(1));
  const pipelineOn_ = await pipelineRepos(db);

  type Wait = { runs: string; approved: string; reread: number; failed: string; cross_repo: number; approved_at: string | null };
  const runsOf = (w: Omit<Wait, "approved_at"> | undefined, ciApproved: boolean): PrFacts["runs"] => {
    if (!w) return null;
    const runs = parseList(w.runs) as { id: number; event?: string }[];
    const failed = JSON.parse(w.failed || "{}") as Record<string, number>;
    const waiting = runs.length + (w.reread ? 1 : 0);
    const blocked: NonNullable<PrFacts["runs"]>["blocked"] = !waiting ? null : !ciApproved ? "off" : runs.some((x) => (failed[x.id] ?? 0) >= MAX_FAILURES) ? "failed"
      : !w.reread && (!w.cross_repo || !runs.some((x) => x.event === "pull_request")) ? "unsupported" : null;
    return { waiting, reread: !!w.reread, crossRepo: !!w.cross_repo, approvable: runs.filter((x) => x.event === "pull_request" && (failed[x.id] ?? 0) < MAX_FAILURES).length, blocked };
  };

  // The pipeline's own Fix PRs count as whitelisted at a head the pipeline itself pushed (others may push to the branch); an operator's deny still wins.
  const tierOf = async (r: { repo: string; number: number; author: string | null; author_id: number | null }, head: string | null): Promise<PrFacts["tier"]> => {
    const t = (r.author ? tiers.get(tierKey({ login: r.author, id: r.author_id })) : undefined) ?? "not";
    return t === "not" && !!r.author && await own.isOwn(r.repo, r.author) && own.prs.has(`${r.repo}#${r.number}`) && !!head && await ownHead(r.repo, r.number, head) ? "whitelisted" : t;
  };
  const holdOf = await reviewHolds(db, now, refs);
  const outsideHolds = await holdMap(db);
  const out: PrFacts[] = [];
  for (const r of rows) {
    // The queue leaves merged PRs outside the pilot and our own integration PRs out.
    if (r.state !== "OPEN" && (!r.in_pilot || !r.not_integration)) continue;
    const ref = `${r.repo}#${r.number}`;
    const rf = await repoOf(r.repo);
    const fresh = !!r.c_at && (!r.updated_at || r.c_at > r.updated_at);
    const integration = !r.not_integration;
    // An integration PR takes part when its repo's pipeline is on or every member is in scope (fast track); its head is the batch tip, where the run approvals are recorded.
    const batchRow = integration ? (await batchOf(r.repo, r.number)) : undefined;
    const inScope = integration ? pipelineOn_.has(r.repo) || (!!batchRow && await (async members => members.length > 0 && await everySeq(members, async (m) => await inPilot(db, r.repo, m.number)))(await membersOf(db, batchRow.id))) : !!r.in_pilot;
    const head = batchRow?.commit_sha ?? headOf(r);
    const pushedOff = r.state === "OPEN" && !integration && !!head && (pushedOffAt.get(`${ref}@${head}`) ?? []).some((p) => !r.updated_at || Date.parse(r.updated_at) < Date.parse(p.at));
    const lines = (r.additions ?? 0) + (r.deletions ?? 0);
    const base: PrFacts = {
      repo: r.repo, number: r.number, ...(pushedOff ? { pushedOff } : {}), assignment: assigned(ref, r.assignees), now, pipelineOn, tripped: tripsOfRepo(tripped, r.repo), ghState: r.state, head, draft: fresh ? r.c_state !== "OPEN" || !!r.c_draft : !!r.is_draft,
      author: r.author, authorIsPipeline: r.author !== null && await own.isOwn(r.repo, r.author), tier: "not", lines, size: sizeOf(lines), label: null, needsDecisionFlag: false,
      scopeAnswer: scope.get(ref) ?? null,
      inScope, ...(outsideHolds.has(ref) ? { outsideHold: outsideHolds.get(ref)! } : {}), integration, batchPr: !!r.batch_pr, heldBacklog: !!r.held_backlog, heldDuplicate: !r.held_backlog && !!r.held_dup, quiet: own.quiet.has(ref), mergeHeld: holds.has(ref),
      fast: (r.score ?? 0) >= FAST_FLOOR, score: r.score, repoFacts: rf.f,
      review: null, post: { postable: false, posted: null },
      checksHere: false, checksOpen: false, ci: "unknown", mergeable: r.i_mergeable ?? "UNKNOWN", unknown: null, runs: null,
      lastMerge: null, runsApprovedAfterMerge: false, verifyOverride: false, verification: null, verifyUnavailable: null,
      decision: { asked: false, openQuestion: false, answer: null, mergeAnswerAfterReview: false, inOpenGroup: grouped.has(ref), execWaiting: false, hold: { asked: false, open: false, answer: null, otherOpen: otherOpen.has(ref) } },
      premerge: null, premergeFixUsed: false, sensitive: null, statementConflicts: [], pushable: false, pushChain: [], conflict: null, inActiveBatch: activeBatched.has(ref), fixup: null, carry: [], lint: [], cifix: null, postmerge: null, batch: null, mainFix: false, baseOffDefault: false, stackedOn: null, changesRequested: null, gateFailureNote: null,
    };
    base.inFlight = r.state === "OPEN" && !integration && !!r.author && await own.isOwn(r.repo, r.author) && own.prs.has(ref);
    base.implementation = implPrs.get(ref) ?? null;
    if (rf.f.workflow === "new") { base.workflow = wfs.ofPr(r.repo, r.number, base.implementation?.issue ?? null); base.endedWorkflow = wfs.ended(r.repo, r.number); }
    if (integration) {
      base.runs = runsOf(await batchTip(r.repo, r.number), rf.f.ciApproved);
      out.push(base);
      continue;
    }
    if (!inScope) {
      const v = head ? verifAt(ref, head) : undefined;
      base.outside = {
        review: r.r_head && r.r_head === head && r.r_verdict && !stale.has(`${ref}@${r.r_head}`) ? r.r_verdict : null,
        verify: v?.state ?? null, ci: head && r.c_head === head ? r.overall ?? null : null,
      };
      out.push(base);
      continue;
    }

    const s = await settled(r.repo, r.number);
    base.label = labelWithScopeAnswer(s.label ?? null, base.scopeAnswer);
    base.needsDecisionFlag = s.flags.includes("needs decision") || (unsettled.has(ref) && !scope.has(ref));
    base.labelUnsure = s.status === "settled" && !!s.referee && !s.referee.sure && refereeClosed(s.referee);
    if (rf.f.workflow === "new") base.tier = await tierOf(r, head);
    const pm = mergedByPipeline.get(ref);
    if (pm) base.postmerge = { mergedAt: pm.merged_at, head: pm.head, since, review: pmReviews.get(ref) ?? null };
    // Checks describe the PR when they were fetched for the reviewed head (or, without a review, the current one).
    const checksAtHead = r.c_head === (mergeEntryHead(r) ?? r.r_head ?? head);
    base.mergeable = (checksAtHead ? r.c_mergeable : r.i_mergeable) ?? "UNKNOWN";
    // An author whose permission has not been read yet counts as able to write: the job that pushes reads it first.
    base.pushable = pushable(r.head_repo, r.repo, checksAtHead ? r.c_can : r.i_can, r.head_ref, rf.longLived, false, sameRepo(r.head_repo, r.repo) && authorWrites(r.repo, r, (t) => refresh.soon(ref, t)) !== "no");
    const ow = operator.get(ref);
    if (ow && r.state === "OPEN") {
      base.operator = { fix: head && ow.fixHeads.has(head) && await queuedOperatorFix(db, r.repo, r.number, head, now) ? { attempts: await operatorTries(db, r.repo, r.number) } : null, hold: ow.hold, premerge: !!head && ow.premergeHeads.has(head), preapproved: ow.preapproved };
      refresh.soon(ref, ow.settleUntil);
    }
    // A fix-up request holds the PR's merge only while the planner can work it: same head, pushable, approved, not conflicting, not a draft, tries left.
    if (base.operator?.fix && !base.heldBacklog && !base.draft && base.mergeable !== "CONFLICTING" && base.pushable && base.repoFacts.pushApproved && await operatorTriesLeft(db, r.repo, r.number)) base.operator.hold = true;
    if (ow && r.state === "OPEN" && head) {
      for (const x of lintOperator.get(`${ref}@${head}`) ?? []) base.lint.push({ step: "fixup", source: "operator", ended: await taskEnded(x.lint_task) });
      if (base.lint.length) base.inFlight = true;
    }
    if (r.state === "OPEN" && !base.heldBacklog) {
      for (const k of carries.get(ref) ?? []) {
        const hasPoints = (await carryPoints(k.decision_id)).some((x) => {
          try { const c = (JSON.parse(x.detail ?? "null") as { carry?: unknown } | null)?.carry; return Array.isArray(c) && c.some((p) => typeof p === "string"); } catch { return false; }
        });
        const u = unsentAsk((await carryUnsent(r.repo, r.number, k.decision_id)).map((x) => x.created_at), now);
        if (hasPoints) base.carry.push({ attempts: k.attempts, ...(u !== null && u !== "final" ? { unsent: u } : {}) });
      }
    }
    if (r.state === "OPEN" && head && !base.draft) { const hold = await holdOf(r.repo, r.number, head, (t) => refresh.soon(ref, t)); if (hold) base.reviewHold = hold; }
    // A merge-entry PR has no review: its queue facts below are read at its current head (the queue head), and it entered the queue when its workflow started.
    const mxh = mergeEntryHead(r);
    if (!mxh && (!r.r_head || !r.r_verdict || !r.r_at)) { out.push(base); continue; }
    const mx = mxh !== null;
    const qh = mxh ?? r.r_head!;
    const qAt = mx ? base.workflow!.startedAt : r.r_at!;

    const take = mx || r.r_verdict === "take" || r.r_verdict === "take-fix";
    const chain = take ? pushChain(r.repo, r.number, qh) : [qh];
    if (!mx) {
      const unsure = take && (r.r_sure === 0 || chain.some((h) => unsureAt.has(`${ref}@${h}`)));
      base.review = {
        head: qh, at: qAt, verdict: r.r_verdict!, unsure, mode: r.r_mode, reason: r.r_reason ?? "", fixes: parseList(r.r_fixes).length,
        stale: stale.has(`${ref}@${qh}`), staleActionable: staleActionable.has(`${ref}@${qh}`),
      };
      base.decision.hold = holdQuestionOf(ref, holdDecisionId(r.repo, r.number, qh));
      if (r.state === "OPEN" && head && head !== qh && (ourFixupHead.has(`${ref}@${head}`) || ourSameDiffMerge.has(`${ref}@${head}`)) && await carriedReview(db, { repo: r.repo, number: r.number, head_oid: head }, stale)) base.carriable = true;
    }
    base.pushChain = chain;
    if (r.state === "OPEN" && (chain.length > 1 || (!!head && pushedHere.has(`${ref}@${head}`)))) base.inFlight = true;
    // The facts of the queue head's cached diff (src/review/diff.ts writes them with the cache); null when it is not cached.
    const d = mx ? mxDiff.get(`${ref}@${qh}`) ?? null : r.d_lines === null ? null : { reasons: r.d_reasons, lines: r.d_lines, pending: r.d_pending, last_read: r.d_last_read };
    const diffFacts = d === null ? null : { reasons: parseList(d.reasons) as string[], lines: d.lines, pending: d.pending === 1, lastRead: d.last_read };
    // While the extras are pending the reasons are the conservative ones, and the wait itself keeps the PR off the rule.
    base.sensitive = diffFacts ? (diffFacts.pending ? [...diffFacts.reasons, EXTRAS_PENDING_REASON] : diffFacts.reasons) : null;
    if (diffFacts?.pending) base.diffPending = { lastRead: diffFacts.lastRead };
    if (diffFacts) { base.lines = diffFacts.lines; base.size = sizeOf(diffFacts.lines); }
    base.statementConflicts = await statementConflicts(statement, [mx ? null : safeJson(r.r_conflicts), safeJson(premerge.get(`${ref}@${qh}`)?.conflicts ?? null)]);
    const p = posts.get(ref);
    // A carried review has no text of its own: the post uses the text of the review it was carried from.
    const src = !mx && r.r_mode === CARRIED ? await postSource(r.repo, r.number, qh) : null;
    const hasPublic = src ? src.hasPublic : !mx && r.r_public !== null;
    const pub = src ? src.public : !hasPublic ? { ok: true } : parsePublic({ summary: r.r_public, points: [] });
    base.post = {
      postable: (hasPublic || !!p?.review_id) && !!pub,
      posted: p ? { head: p.head_oid, at: p.posted_at, opusAt: p.opus_at } : null,
    };
    // The CI fix state at one head: the rows it recorded and its limits.
    const cifixAt = async (cfHead: string): Promise<NonNullable<PrFacts["cifix"]>> => {
      const all = cifixOf.get(ref) ?? [];
      const prior = all.filter((x) => x.head === cfHead);
      const totals = { pushes: all.filter((x) => CIFIX_PUSH_STATES.includes(x.state)).length, tries: all.filter((x) => CIFIX_TRY_STATES.includes(x.state)).length };
      const formatting = prior.find((x) => x.state === "formatting");
      const task = formatting?.task_id != null ? await getTask(db, formatting.task_id) : null;
      const infra = prior.find((x) => x.state === "infra");
      return {
        states: prior.map((x) => x.state), tries: prior.filter((x) => CIFIX_TRY_STATES.includes(x.state)).length,
        rerunAt: prior.find((x) => x.state === "rerun" || x.state === "rerunning")?.created_at ?? null,
        infraRuns: infra ? (parseList(infra.runs ?? "[]") as number[]) : null,
        formattingTask: formatting?.task_id ?? null, formatterEnded: !task || TERMINAL.includes(task.state),
        totalPushes: totals.pushes, totalTries: totals.tries, checksAt: r.c_at,
        skipReason: [...prior].reverse().find((x) => x.state === "skipped")?.reason ?? null,
        ...unsentOf(prior.filter((x) => x.state === "comment-unsent").map((x) => x.created_at)),
      };
    };
    // A non-take review at an earlier head while the review gate waits on red CI at the new head: the CI fix cannot start, so the contributor is asked (src/core/decide.ts unreviewedRed).
    if (!take && r.state === "OPEN" && head && head !== qh && base.reviewHold?.kind === "ci" && base.reviewHold.red && r.c_head === head && await effectiveCi(db, r.repo, r.overall ?? "none", r.c_checks) === "failure") {
      base.ci = "failure";
      base.gateRed = true;
      base.cifix = await cifixAt(head);
    }
    if (!take) { out.push(base); continue; }

    const wait: Wait | undefined = waiting.get(`${ref}@${qh}`)?.[0];
    const checksHere = r.c_head === qh;
    base.checksHere = checksHere;
    base.checksOpen = checksHere && r.c_state === "OPEN" && !r.c_draft;
    const approvedPending = parseList(wait?.approved ?? "[]").length > 0;
    base.ci = checksHere ? (approvedPending ? "pending" : await effectiveCi(db, r.repo, r.overall ?? "none", r.c_checks)) : "unknown";
    base.runs = runsOf(wait, rf.f.ciApproved);
    // Our push to this head turned its required checks red: the CI fix works on it now, without waiting for a review of the new head.
    // A head that our own push or the review's CI gate (red CI at a new head, reviewed earlier) left red is repaired against that head.
    const redNow = r.c_head === head && await effectiveCi(db, r.repo, r.overall ?? "none", r.c_checks) === "failure";
    base.brokeByUs = brokeAt.get(ref) === head && redNow;
    base.gateRed = !base.brokeByUs && !!base.reviewHold?.red && !!head && head !== qh && redNow;
    if (r.state === "OPEN") {
      const from = carriedSources(carryRows.get(ref) ?? []);
      if (from.length) {
        const t = await tiersOf(db, from.filter((x) => x.author).map((x) => ({ login: x.author!, id: x.id })));
        base.carriedFrom = from.map((x) => ({ number: x.number, author: x.author, tier: (x.author ? t.get(tierKey({ login: x.author, id: x.id })) : undefined) ?? "not" }));
      }
    }
    base.tier = await tierOf(r, head);
    const ownHere = !!r.author && await own.isOwn(r.repo, r.author) && own.prs.has(ref) && !!head && await ownHead(r.repo, r.number, head);

    const last = merges.get(`${ref}@${qh}`)?.[0];
    // An operator's Retry after a refusal asks for another try now, without waiting for CI or the mergeable state to change.
    // A fresh Merge answer after a refusal asks for another try, as a Retry does.
    if (last && !(last.outcome === "refused" && (await retriedAfter(mergeDecisionId(r.repo, r.number, qh), last.at) || answeredAfter(mergeDecisionId(r.repo, r.number, qh), last.at)))) {
      base.lastMerge = { outcome: last.outcome, reason: last.reason, ci: last.ci, mergeable: last.mergeable, refusals: last.refusals };
      base.runsApprovedAfterMerge = !!wait?.approved_at && wait.approved_at > last.at;
    }
    base.verification = (verifAt(ref, qh) as PrFacts["verification"] | undefined) ?? null;
    if (base.verification?.state === "failed" || base.verification?.state === "error") base.verifyOverride = await verifyOverride(db, r.repo, r.number, qh);
    if (!base.verification || base.verification.state === "stale") {
      base.verifyUnavailable = !rf.pub ? PRIVATE_REASON : rf.f.noCi && cachedRust(r.repo, qh) === false ? NOT_RUST_REASON : null;
    }
    if (r.state === "OPEN" && base.mergeable !== "MERGEABLE" && base.mergeable !== "CONFLICTING") base.unknown = await unknownOf(db, r.repo, r.number, qh);
    const id = mergeDecisionId(r.repo, r.number, qh);
    const given = answers.get(id) ?? null;
    base.decision = {
      asked: decisionAnswers.has(id), openQuestion: r.state === "OPEN" && openQuestion.has(ref), answer: given,
      mergeAnswerAfterReview: given === "merge" && answeredAfter(id, qAt), inOpenGroup: grouped.has(ref),
      execWaiting: execWaiting.has(id),
      hold: base.decision.hold,
    };
    if (r.state !== "OPEN") { out.push(base); continue; }

    const row = premerge.get(`${ref}@${qh}`) ?? null;
    if (row) {
      const all = findingsOf(row);
      const defects = all.filter((f) => f.severity === "defect");
      base.premerge = { at: row.at, tries: row.tries, hasFindings: row.findings !== null, unsure: row.unsure !== 0, defects: defects.length, defectsAllFixable: defects.every((f) => f.fix), fixesSafe: parseFixes(JSON.stringify(defects.map((f) => f.fix))).length === defects.length, minor: all.length - defects.length, error: row.error ?? null };
      if (defects.length) base.premergeFixUsed = premergeFixUsedIn(fixupsOf.get(ref) ?? []);
    }
    if (base.mergeable === "CONFLICTING" && r.base_ref) {
      const rows = conflictRowsOf.get(ref) ?? [];
      const bucket = conflictBucketOf(rows, { head: qh, pushable: base.pushable }, { push: rf.f.pushApproved, comment: rf.f.commentApproved }, now);
      const until = bucket === "capped" ? nextUtcMidnight(now) : bucket === "ask-retry" ? conflictAskRetryAtOf(rows, qh, now) : undefined;
      base.conflict = { bucket, base: r.base_ref, baseOk: BASE_NAME.test(r.base_ref), ...(until !== undefined ? { until } : {}) };
    }
    if (!mx && r.r_verdict === "take-fix") {
      base.fixup = {
        fixes: parseFixes(r.r_fixes).length, attempts: attemptsIn(fixupsOf.get(ref) ?? []), recorded: (fixupAt.get(`${ref}@${qh}`) ?? []).filter((x) => x.state !== "comment-unsent").map((x) => x.state),
        ...unsentOf((fixupAt.get(`${ref}@${qh}`) ?? []).filter((x) => x.state === "comment-unsent").map((x) => x.created_at)),
      };
    }
    {
      const ended = taskEnded;
      for (const x of lintFixup.get(`${ref}@${qh}`) ?? []) {
        base.lint.push({ step: "fixup", source: x.source === "premerge" || x.source === "carry" || x.source === "operator" ? x.source : "review", ended: await ended(x.lint_task) });
      }
      for (const x of lintCifix.get(`${ref}@${base.brokeByUs || base.gateRed ? head : qh}`) ?? []) base.lint.push({ step: "cifix", source: "review", ended: await ended(x.lint_task) });
      for (const x of lintConflict.get(`${ref}@${qh}`) ?? []) base.lint.push({ step: "conflict", source: "review", ended: await ended(x.lint_task) });
      if (base.lint.length && r.state === "OPEN") base.inFlight = true;
    }
    if (base.ci === "failure" || base.brokeByUs || base.gateRed) {
      const cfHead = base.brokeByUs || base.gateRed || (head && head !== qh) ? head : qh;
      base.cifix = await cifixAt(cfHead ?? qh);
    }
    base.batch = inBatch.get(`${ref}@${qh}`) ?? null;
    if (r.base_ref && r.state === "OPEN") base.stackedOn = (openByHead.get(`${r.repo} ${r.base_ref} ${`${slugOf(r.repo)}`.toLowerCase()}`) ?? []).find((n) => n !== r.number) ?? null;
    base.baseOffDefault = !!r.base_ref && !!rf.defaultBranch && r.base_ref !== rf.defaultBranch;
    base.mainFix = !!r.head_ref?.startsWith(MAIN_FIX_BRANCH_PREFIX) && ownHere;
    const gate = gates.get(ref);
    const { why, live } = changesRequestedWhy(gate, r.updated_at, reviewRows.get(ref) ?? [], r.review_decision);
    if (gate && gate.failures >= GATE_FAILURES) base.gateFailureNote = failureNote(gate.failures);
    if (why) base.changesRequested = { why, live };
    out.push(base);
  }
  // The timed waits the facts hold end at their own times; the refresh also covers the clock uses they do not show.
  const until = (u: { until: number } | "final" | undefined): number | undefined => (typeof u === "object" ? u.until : undefined);
  for (const f of out) {
    const at = refresh.at(`${f.repo}#${f.number}`, f.reviewHold?.until, f.conflict?.until, until(f.fixup?.unsent), until(f.cifix?.unsent), ...f.carry.map((c) => c.unsent?.until));
    if (at !== undefined) f.refreshAt = at;
  }
  return out;
}

/** Facts of one PR, or null when it is not an open PR (or a merged one with a take review). */
export async function loadPrFact(db: Db, repo: string, number: number, opts: Omit<LoadOptions, "repo" | "refs"> = {}): Promise<PrFacts | null> {
  return (await loadPrFacts(db, { ...opts, repo, refs: [`${repo}#${number}`] }))[0] ?? null;
}
export type { PrTier };

// ---- small readers shared with the merge modules ----

/** Returns a function that gives the head and the earlier heads AutoCraft itself pushed it from (a `pushing` row is a push that started and may have landed) (conflict merges of the base, fix-up pushes, carry-over pushes), newest first. */
export async function pushChainOf(db: Db): Promise<(repo: string, number: number, head: string) => string[]> {
  // Every push edge, read once: the heads each head was pushed from, distinct and in order (as the UNION gives them per head).
  const from = new Map<string, string[]>();
  for (const r of await db.all(db.k.selectFrom(
    db.k.selectFrom("conflict_merges").select((eb) => [keyOf(eb, "conflict_merges", "to_head").as("k"), "from_head"]).where("state", "in", ["merged", "pushing"])
      .union(db.k.selectFrom("fixups").select((eb) => [keyOf(eb, "fixups", "to_head").as("k"), "from_head"]).where("state", "in", ["pushed", "pushing"]))
      .union(db.k.selectFrom("dupe_carries").select((eb) => [keyOf(eb, "dupe_carries", "to_head").as("k"), "from_head"]).where("from_head", "is not", null).$narrowType<{ from_head: string }>())
      .union(db.k.selectFrom("ci_fixes").select((eb) => [keyOf(eb, "ci_fixes", "to_head").as("k"), "head as from_head"]).where("state", "in", ["pushed", "pushing"])).as("u"))
    .select(["k", "from_head"]).where("k", "is not", null).orderBy(bytewise(db, "k")).orderBy("from_head"))) (from.get(r.k) ?? from.set(r.k, []).get(r.k)!).push(r.from_head);
  return (repo, number, head) => {
    const chain = [head];
    for (let k = 0; k < chain.length; k++) for (const f of from.get(`${repo}#${number}@${chain[k]}`) ?? []) if (!chain.includes(f)) chain.push(f);
    return chain;
  };
}

/** Returns a function telling whether a PR's head is the pipeline's own work: a commit it pushed to its own branch, or one reached from such a commit only through its own later pushes. */
export async function ownHeadOf(db: Db): Promise<(repo: string, number: number, head: string) => Promise<boolean>> {
  const chain = await pushChainOf(db);
  let pushed: Set<string> | undefined;
  const ours = async (repo: string, sha: string): Promise<boolean> => (pushed ??= new Set((await db.all(db.k.selectFrom("main.own_commits").select((eb) => eb(eb(eb.ref("repo"), "||", eb.val(" ")), "||", eb.ref("sha")).as("k")))).map((r) => r.k))).has(`${repo} ${sha}`);
  return async (repo, number, head) => await someSeq(chain(repo, number, head), async (h) => await ours(repo, h));
}

/** True when any stored Opus review at the head (the current row or an overwritten one in the history) was a take or take-fix with sure = 0. */
export async function headWasUnsure(db: Db, repo: string, number: number, head: string): Promise<boolean> {
  return !!await db.get(unsureAtQuery(db, repo, number, head));
}

type CarrySource = { number: number; detail: string | null; author: string | null; id: number | null };
/** The closed PRs whose parts a pushed carry-over put on this PR, with their authors, from its carry rows. */
function carriedSources(rows: CarrySource[]): { number: number; author: string | null; id: number | null }[] {
  return rows.filter((x) => { try { const p = (JSON.parse(x.detail ?? "null") as { carry?: unknown } | null)?.carry; return Array.isArray(p) && p.length > 0; } catch { return false; } })
    .map((x) => ({ number: x.number, author: x.author, id: x.id }));
}

export { tierKey, tiersOf, type AuthorRef };

/** PRs the pipeline opened itself from a Fix issues attempt or for a red default branch, as `repo#number`, when authored by its own account. */
/** The PRs our implementations opened, by ref: the latest attempt that opened each (ended ones too), its issue, its state and the heads its revisions started from (its `revise` rounds). */
async function implementationPrs(db: Db, repo?: string): Promise<Map<string, NonNullable<PrFacts["implementation"]>>> {
  const rows = await db.all(db.k.selectFrom("main.implementations").select(["id", "repo", "number", "pr_number", "state"]).where("pr_number", "is not", null)
    .$if(!!repo, (q) => q.where("repo", "=", repo!)).orderBy("id").$narrowType<{ pr_number: number }>());
  const out = new Map<string, NonNullable<PrFacts["implementation"]>>();
  const byId = new Map<number, NonNullable<PrFacts["implementation"]>>();
  for (const r of rows) {
    const v = { issue: r.number, state: r.state, revisedHeads: [] as string[] };
    out.set(`${r.repo}#${r.pr_number}`, v);
    if (!ENDED_STATES.has(r.state as ImplementationState)) byId.set(r.id, v);
  }
  if (byId.size) {
    for (const g of await db.all(db.k.selectFrom("main.implementation_rounds").select(["implementation_id", "result"]).where("kind", "=", "revise").where(inList(db, "implementation_id", [...byId.keys()], "bigint")))) {
      const head = (safeJson(g.result) as { head?: unknown } | null)?.head;
      if (typeof head === "string") byId.get(g.implementation_id)?.revisedHeads.push(head);
    }
  }
  return out;
}

export async function ownFixPrs(db: Db, repo?: string, slug?: string | null): Promise<{ login: string | null; prs: Set<string>; quiet: Set<string>; isOwn: (repo: string, author: string | null) => Promise<boolean> }> {
  const logins = new Map<string, Set<string>>();
  const isOwn = async (r: string, author: string | null): Promise<boolean> => {
    if (!author) return false;
    let set = logins.get(r);
    if (!set) logins.set(r, (set = await ownLogins(db, r, slug)));
    return set.has(author);
  };
  const login = await setting(db, PIPELINE_LOGIN_KEY) ?? null;
  const prs = new Set<string>();
  const quiet = await quietFixPrs(db, repo);
  if (!login) return { login, prs, quiet, isOwn };
  for (const ref of quiet) prs.add(ref);
  for (const r of await db.all(db.k.selectFrom("main.fix_attempts").select(["repo", "pr_url"]).where("pr_url", "is not", null).$if(!!repo, (q) => q.where("repo", "=", repo!)).$narrowType<{ pr_url: string }>())) {
    const m = r.pr_url.match(/\/pull\/(\d+)$/);
    if (m) prs.add(`${r.repo}#${m[1]}`);
  }
  for (const r of await db.all(db.k.selectFrom("main.main_fixes").select(["repo", "pr_number as n"]).where("pr_number", "is not", null).$if(!!repo, (q) => q.where("repo", "=", repo!)).$narrowType<{ n: number }>())) prs.add(`${r.repo}#${r.n}`);
  return { login, prs, quiet, isOwn };
}

/** Reads the pipeline account and the last successful assign or unassign of every item from the audit once; the returned function gives an item's assignment facts from its mirrored `assignees` (JSON). */
export async function assignmentsOf(db: Db, repo?: string): Promise<(ref: string, assignees: string | null) => AssignFacts> {
  const login = await setting(db, PIPELINE_LOGIN_KEY) ?? null;
  const last = new Map<string, string | null>();
  // The actions are literals so the inner read walks the audit_assign partial index, not every audit row.
  for (const r of await db.all(db.k.selectFrom("audit").select(["target", "details"]).where("action", "=", "assign").where((eb) => eb(rowid("audit"), "in", eb.selectFrom("audit as a2")
    .select((s) => s.fn.max<number>(rowid("audit", "a2")).as("m")).where("a2.action", "in", [literal("assign"), literal("unassign")])
    .where((w) => w.not(like(db, w.fn.coalesce("a2.details", w.val("")), w.val('%"error":%')))).$if(!!repo, (q) => q.where("a2.target", ">=", `${repo}#`).where("a2.target", "<", `${repo}$`)).groupBy("a2.target"))))) {
    if (r.target === null) continue;
    last.set(r.target, (safeJson(r.details) as { assignee?: string } | null)?.assignee ?? null);
  }
  return (ref, assignees) => {
    const list = parseList(assignees).filter((x): x is string => typeof x === "string");
    const by = last.get(ref);
    // Without a recorded account, the audit's own assignee stands for it.
    return { login: login ?? by ?? null, assignees: list, ours: by !== undefined && (login === null || by === login) };
  };
}
