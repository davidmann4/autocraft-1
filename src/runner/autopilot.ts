// The pipeline switch and the autopilot behind it. With the switch on, the
// runner looks for work whenever a content topic changed, a job finished or an
// operator released work (a 5-minute timer is only a fallback), and queues one
// job per stage that has work, no job of its own queued or running, and an
// item limit left for the day. A job that handled nothing is not queued again
// until the input it saw changes (its fingerprint); a failed job is retried
// after a short, growing backoff. Stages run in pipeline order; a failure in
// one does not stop the others. Turned off, no new jobs are queued and running
// jobs finish.
//
// The planner reads the database, writes only its Plan cache (item_plans) and queues jobs; the runner starts them.
// Each lane's `detect` reads the Plans of the pass (src/core/plan-set.ts).
import { RECOMMEND_RETRY_MS } from "../core/item-rules.ts";
import type { PipelineState, StageLimit } from "../../web/src/api/types.ts";
import { readSeqs, TOPICS } from "../live.ts";
import { pendingConversations } from "../conversations/store.ts";
import { plannedItems, type PlannedItem } from "../core/select-items.ts";
import { loadPlanSet, type PlanSet } from "../core/plan-set.ts";
import { gates, type Want } from "../core/gates.ts";
import type { Action, ActionKind } from "../core/plan.ts";
import { writePlanCache } from "../core/plan-cache.ts";
import { refreshLiveness } from "../liveness.ts";
import { embedderId, modelName } from "../embed/model.ts";
import { jevUsable } from "../agents/jev.ts";
import { PACE_MAX_WAIT_MS, pipelineWriteWait } from "../github/write.ts";
import { embedDue } from "../embed/store.ts";
import { commentApprovalOf } from "../act/approval.ts";
import { selectFixups } from "../fixup/select.ts";
import { needsWork } from "../merge/ci-approval.ts";
import { batchesDue } from "../merge/batch-store.ts";
import { trackedNames } from "../repos.ts";
import { inFlightNow, planned, type Planned } from "../core/select.ts";
import { isQueueState } from "../core/plan.ts";
import { isWork } from "../core/assignment.ts";
import { postCandidates } from "../review/post.ts";
import { collectDue } from "../verify/results.ts";
import { featureRepos } from "../build/features.ts";
import { nightlyRepos } from "../nightly/index.ts";
import { prBuildDue, reposWithQueuedBuilds } from "../prbuild/index.ts";
import { actLimit, actUsedToday } from "../conversations/usage.ts";
import { queueHead } from "../conversations/queue.ts";
import { filingWakes, heldDue } from "../conversations/held.ts";
import { compareKeys, targetKeys } from "../act/order.ts";
import { audit } from "../dash/audit.ts";
import { defaultPerDay, lanesInOrder, limitSteps, zeroOnlySteps } from "../stages/registry.ts";
import { applyUsedAnswers } from "../decisions-used.ts";
import { premergeCandidates } from "../premerge/review.ts";
import { pendingDefects, selectPostmerge } from "../postmerge/select.ts";
import { mainFixDue } from "../mainfix/index.ts";
import { statusApprovalOf } from "../prstatus/approval.ts";
import { statusDue, statusRetriesDue, statusRetryAt } from "../prstatus/index.ts";
import { latestRun } from "../classify/settled.ts";
import { PIPELINE_DRAIN } from "../core/rules.ts";
import { DEADLINE_ERROR, enqueue, JobError, now, requestCancel, RUNNER_STOPPED } from "./jobs.ts";
import { claudePauseReason } from "../agents/accounts.ts";
import { inferenceMode } from "../remote/mode.ts";
import { takerSignature } from "../remote/takers.ts";
import { activeTripRows, activeTrips, tripReasonIn, tripReasonOfStep } from "../push-outcomes.ts";
import { STEP_STAGE } from "../core/push-outcome.ts";
import { NO_TAKER_SKIP } from "./leases.ts";
import { jobBlock, stepParallel, untakenTest, type Active, type UntakenTest } from "./concurrency.ts";
import { knownStep, loadSteps, STEPS, modelsOf, usesClaude, type Params, type StepDef } from "./steps.ts";
import { pilotItems, scopeRepos } from "../pilot.ts";
import { refreshOutsideHolds } from "../outside.ts";
import { JUDGEMENT_MODELS, judgementModel } from "../decide/judgement.ts";
import { FAST_FLOOR, fastFirst, fastScores } from "../fasttrack.ts";
import { deleteSetting, rereadSettingsSnapshot, setting, withSettingsSnapshot, writeSetting } from "../settings-read.ts";
import { inReadSnapshot, planPass, type PlanPass } from "../core/plan-engine.ts";
import { filterSeq, mapSeq, someSeq } from "../async-seq.ts";
import { leaseTurnover } from "../remote/calls.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

/** Fallback only: the planner normally runs on a content change, a finished job or a release. */
export const PLAN_EVERY_MS = 5 * 60_000;
/** An incremental planner (the runner's) loads every item's facts again at least this often: the bound on a change the log missed. */
export const PLAN_FULL_EVERY_MS = 30 * 60_000;
/** Failed jobs of a step are retried after 1, 2, 4, 8, 16 minutes, then every 30. */
export const FAIL_BACKOFF_MS = 60_000;
export const FAIL_BACKOFF_MAX_MS = 30 * 60_000;
/** Checks younger than this count as current for the review that follows. */
export const CHECKS_FRESH_MS = 5 * 60_000;
/** How often the CI and mergeable state of a repo with PRs waiting for CI (or an open batch PR) is read again. */
export const WAITING_CI_RECHECK_MS = 60_000;
export const AUTOPILOT_USER = "pipeline";

export const KEY_ENABLED = "pipeline_enabled";
/** Who changed the pipeline switch last, and when. */
export const KEY_BY = "pipeline_changed_by", KEY_AT = "pipeline_changed_at";
const KEY_PLANNED_AT = "pipeline_planned_at", KEY_SEQS_SEEN = "pipeline_seqs_seen", KEY_WAKE_AT = "pipeline_wake_at", KEY_STATUS = "pipeline_status";
const KEY_CURSOR = "pipeline_review_cursor";
const KEY_VERIFY_CURSOR = "pipeline_verify_cursor";
const KEY_RESET = "limit_reset_at:";

const getSetting = async (db: Db, key: string): Promise<string | null> =>
  await setting(db, key) ?? null;
const setSetting = writeSetting;

// ---- lanes ---------------------------------------------------------------------

/** The first (best-scored) planned PR of each repo. */
const firstByRepo = (items: Planned[]): Map<string, Planned> => {
  const out = new Map<string, Planned>();
  for (const p of items) if (!out.has(p.facts.repo)) out.set(p.facts.repo, p);
  return out;
};

/**
 * Repos with a PR of ours we broke come first, then repos with work of ours in flight, then the rest, each group in the given order:
 * a job takes one repo, so finishing what AutoCraft started beats starting new work.
 */
function flightFirst(plans: PlanSet, repos: string[]): string[] {
  const broke = new Set(plans.prs.filter((p) => p.facts.brokeByUs && p.plan.actions.some(isWork)).map((p) => p.facts.repo));
  const flying = new Set([...plans.prs, ...plans.items].filter((p) => p.plan.actions.some(isWork) && inFlightNow(p.facts, p.plan.state)).map((p) => p.facts.repo));
  const rank = (r: string): number => (broke.has(r) ? 0 : flying.has(r) ? 1 : 2);
  return [...repos].sort((a, b) => rank(a) - rank(b));
}

/** One job the autopilot may queue; `params` leaves out `limit`, which the planner sets. */
export type Candidate = {
  step: string; params: Params;
  /** Polls an external system (CI, GitHub, the sandbox): it may run again on unchanged inputs, at most once a minute. */
  poll?: boolean;
  /** Another job that must also be startable now, e.g. the review that follows a checks job. */
  gate?: { step: string; params: Params; poll?: boolean };
};
/** A pipeline stage in order. `detect` lists the jobs that have work, best first. */
export type Lane = {
  name: string;
  /** Every step the lane may queue. When none of them can start (busy, paused, limit reached, cooling down), the lane is not detected at all. */
  steps?: string[];
  /** Its jobs are per repo: the lane's jobs are judged one repo at a time. */
  perRepo?: boolean;
  /** Its jobs may run for tracked repos outside the pipeline scope (the PR status comment's last edits); `detect` decides which. */
  anyTracked?: boolean;
  /** The change topics the lane's input lives in (default: INPUT_TOPICS). A job that handled nothing is not queued again while these and `extra` are unchanged. */
  topics?: string[];
  /** Input that no topic reports, e.g. the state of sandbox tasks. */
  extra?: (db: Db) => Promise<string>;
  /** Least time between two of the lane's jobs: for cheap recomputes whose input moves in bursts (a sync writes in several transactions) and that no stage waits on. */
  minGapMs?: number;
  detect: (db: Db, ctx: PlanCtx) => Promise<Candidate[]>;
  /** Work score of the lane's best item, null when it has none. Lanes that define it share capacity: see orderLanes(). */
  topScore?: (db: Db, ctx: PlanCtx) => Promise<number | null>;
  /** Runs when the candidate was queued; may write. */
  chosen?: (db: Db, c: Candidate) => Promise<void>;
};

/** What every lane's detect shares, resolved once per planner pass. */
export type PlanCtx = {
  run: string | null; tracked: string[];
  /** The Plans of the pass: facts loaded and decided once. Lanes read them; a lane run without them (a test) loads them on first use. */
  plans?: PlanSet;
  /** Times (ms) at which something the lanes wait for becomes due; the planner wakes at the earliest. */
  wake?: number[];
  /** Why a stage waits on an outside system (CI, the sandbox), keyed by step; shown on the Pipeline page. */
  notes?: Record<string, string>;
  /** The pass's reading of the Task Runners (untakenTest); a lane run without it reads them on first use. */
  untaken?: UntakenTest;
  /** The fast-track scores of the pass (fastScores), read on first use. */
  fast?: Map<string, number>;
  /** The repos in scope (scopeRepos) as the pass read them. */
  scope?: Set<string>;
  /** The planner pass's candidates of each lane, by lane name: the Next lists reuse what the pass detected. */
  detected?: Map<string, Promise<Candidate[]>>;
  /** The incremental pass that built `plans`, when the planner keeps facts between passes. */
  pass?: PlanPass;
};

/** Only the repos in scope (pipeline on, narrowed by the pilot) are planned for; a job for another repo is never proposed. */
export const planCtx = async (db: Db, incremental = false): Promise<PlanCtx> => {
  // The outside-author holds first: the facts below read them through the pilot condition (src/outside.ts).
  const wake: number[] = [];
  try {
    const outside = await refreshOutsideHolds(db);
    if (outside.wakeAt !== null) wake.push(outside.wakeAt);
  } catch (e) {
    console.error(`autopilot: outside-author holds: ${(e as Error).message}`);
  }
  if (incremental) {
    // One read transaction for the settings, the change log and every load, so a write in between is either all seen or left for the next pass.
    return await inReadSnapshot(db, async () => {
      await rereadSettingsSnapshot(db);
      const scope = await scopeRepos(db);
      const run = await latestRun(db);
      const pass = await planPass(db, { now: Date.now(), run, fullEveryMs: PLAN_FULL_EVERY_MS });
      return { run, tracked: (await trackedNames(db)).filter((r) => scope.has(r)), plans: pass.plans, pass, wake, notes: {}, scope };
    });
  }
  const scope = await scopeRepos(db);
  const run = await latestRun(db);
  return { run, tracked: (await trackedNames(db)).filter((r) => scope.has(r)), plans: await loadPlanSet(db, { run }), wake, notes: {}, scope };
};

/** The lane's candidates, detected once per planner pass (ctx.detected). */
const detectOf = (db: Db, ctx: PlanCtx, lane: Pick<Lane, "name" | "detect">): Promise<Candidate[]> => {
  if (!ctx.detected) return lane.detect(db, ctx);
  let c = ctx.detected.get(lane.name);
  if (!c) {
    const m = ctx.detected;
    m.set(lane.name, (c = lane.detect(db, ctx)));
    // A detect that failed is run again by the next caller.
    void c.catch(() => { if (m.get(lane.name) === c) m.delete(lane.name); });
  }
  return c;
};

/** The pass's Plans (loaded on first use when the ctx came without). */
const plansOf = async (db: Db, ctx: PlanCtx): Promise<PlanSet> => (ctx.plans ??= await loadPlanSet(db, { run: ctx.run }));
/**
 * The planned items of `kind` that a job of `step`, which serves every repo, gets to work now. In the user-local mode a job
 * leaves out the Claude calls no Task Runner takes (the pools' poolRoom, the pair check's taker test), so an item that only
 * such a call would serve is not work: a job for it would handle nothing and be queued again on every change of its input.
 * `free`: the item needs no Claude call now (no model, or Jev while Jev may be called).
 */
async function servable(db: Db, ctx: PlanCtx, kind: ActionKind, step: string, free: (p: PlannedItem) => boolean = () => false): Promise<PlannedItem[]> {
  const untaken = (ctx.untaken ??= await untakenTest(db)), byRepo = new Map<string, string | null>();
  let why: string | null = null;
  const out = await filterSeq((await plannedItems(db, kind, { plans: await plansOf(db, ctx) })), async (p) => {
    if (free(p)) return true;
    const repo = p.facts.repo;
    if (!byRepo.has(repo)) byRepo.set(repo, await untaken({ step, repo }));
    const w = byRepo.get(repo)!;
    why ??= w;
    return w === null;
  });
  // With nothing left, the step's status names the wait rather than "nothing to do".
  if (!out.length && why !== null && ctx.notes) ctx.notes[step] ??= why;
  return out;
}

/** The pass's fast-track scores, keyed by `repo#number`. */
const fastOf = async (db: Db, ctx: PlanCtx): Promise<Map<string, number>> => (ctx.fast ??= await fastScores(db));

/** Whether the guard would let the pipeline make the write an action stands for: the global switch and the repo's approval. */
const wantOf = (a: Action): Want => ({ kind: a.kind, ...(typeof a.params?.bucket === "string" ? { bucket: a.params.bucket } : {}) });
const allowed = <T extends { facts: Planned["facts"] | PlannedItem["facts"]; action: Action }>(ps: T[]): T[] =>
  ps.filter((p) => gates(p.facts, wantOf(p.action), "pipeline") === null);
/** The same test for a write that needs no per-item fact, judged on the repo's own facts. */
function repoAllows(plans: PlanSet, repo: string, want: Want): boolean {
  const f = plans.prs.find((p) => p.facts.repo === repo)?.facts ?? plans.items.find((p) => p.facts.repo === repo)?.facts;
  return !f || gates(f, want, "pipeline") === null;
}

/** Topics whose changes call for a plan: content the stages read. Job logs, usage, agent runs, sandbox environments and tasks, audit entries the item-trace bookkeeping and the limits topic (its tables are already read through the jobs topic) do not. */
export const INPUT_TOPICS = TOPICS.filter((t) => !["jobs", "usage", "agents", "envs", "tasks", "workspaces", "access", "github", "plans", "trace", "flow", "limits", "claims", "conversation-includes", "decision-choices", "held-followups", "decision-snooze", "security", "discord", "discord-links", "downloads", "build-features", "pr-builds", "nightly", "remote-helpers", "remote-queue", "rank-inputs"].includes(t));

/** User-local mode: the Task Runners that could take calls (takerSignature). Work a pool left for want of a taker waits on it. */
const takersOf = async (db: Db): Promise<string> => {
  const pass = passOf(db);
  if (pass?.takers !== undefined) return pass.takers;
  const s = await inferenceMode(db) === "user-local" ? await takerSignature(db) : "";
  if (pass) pass.takers = s;
  return s;
};

/** Sandbox tasks that ended, for lanes that read their results. */
const tasksSig = async (db: Db): Promise<string> => String((await db.get(endedTasks(db)))!.n);
const endedTasks = (db: Db) => db.k.selectFrom("main.build_tasks").select((eb) => eb.fn.countAll<number>().as("n")).where("state", "in", ["done", "failed", "cancelled", "lost"]);

/** Daily limits are not a topic of their own (they share `jobs`). */
const limitsSig = async (db: Db): Promise<string> => {
  const [limits, resets] = await Promise.all(limitRows(db).map((q) => db.get(q)));
  return String(limits!.s ?? "") + String(resets!.s ?? "");
};
const limitRows = (db: Db) => [
  db.k.selectFrom("stage_limits")
    .select((eb) => kx.groupConcat(db, eb(eb("step", "||", eb.val("=")), "||", eb.fn.coalesce(eb.cast<string>("per_day", "text"), eb.val("n"))), ",", "step").as("s")),
  db.k.selectFrom("settings")
    .select((eb) => kx.groupConcat(db, eb(eb("key", "||", eb.val("=")), "||", eb.ref("value")), ",", "key").as("s"))
    .where((eb) => eb.or([kx.like(db, "key", eb.val(`${KEY_RESET}%`)), eb("key", "=", "step_parallel")])),
] as const;

const repoOf = (c: Candidate): string | null => (typeof c.params.repo === "string" ? c.params.repo : null);

type JobEnd = { id: number; endedAt: string; state: string; items: number | null; acted: number | null; lease_skips: number | null; lease_skip_keys: string | null };

/** Job and limit reads of one planner pass, loaded on first use. Other connections may start or end jobs meanwhile; applyProposals re-checks blocks and limits with fresh reads. */
type PassReads = {
  db: Db; limits?: Map<string, LimitRow>; started?: { day: string; rows: { step: string; started_at: string; items: number | null }[] }; ends?: (JobEnd & { step: string; repo: string | null; requested_by: string | null })[];
  /** Queued and running jobs of every step. */
  live?: { step: string; params: string; items: number | null; state: string; repo: string | null }[];
  /** The Task Runner signature (takersOf). */
  takers?: string;
  /** Act's usage per UTC day start. */
  act?: Map<string, number>;
  /** Push-breaker trips active now, by key (`<stage>:<repo>`, or `<stage>` on every repo), with their reasons. */
  trips?: Record<string, string>;
};
let passReads: PassReads | null = null;
const passOf = (db: Db): PassReads | null => (passReads?.db === db ? passReads : null);

async function withPassReads<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  if (passReads) return await fn();
  passReads = { db };
  try { return await fn(); } finally { passReads = null; }
}

async function lastJobEnd(db: Db, step: string, repo: string | null, requestedBy?: string): Promise<JobEnd | undefined> {
  const pass = passOf(db);
  if (pass) {
    // The newest ended job of each step, repo and requester; the answer is the newest of those that match.
    pass.ends ??= await db.all(db.k.selectFrom("jobs")
      .select(["id", "step", "repo", "requested_by", "ended_at as endedAt", "state", "items", "acted", "lease_skips", "lease_skip_keys"])
      .where("id", "in", (eb) => eb.selectFrom("jobs").select((e) => e.fn.max<number>("id").as("m"))
        .where((e) => e.and([e("ended_at", "is not", null), e(e.fn.coalesce("error", e.val("")), "<>", RUNNER_STOPPED)])).groupBy(["step", "repo", "requested_by"]))
      .$narrowType<{ endedAt: string }>());
    let best: NonNullable<PassReads["ends"]>[number] | undefined;
    for (const e of pass.ends) if (e.step === step && (repo === null || e.repo === repo) && (requestedBy === undefined || e.requested_by === requestedBy) && (!best || e.id > best.id)) best = e;
    if (!best) return undefined;
    const { step: _s, repo: _r, requested_by: _b, ...end } = best;
    return end;
  }
  return await db.get(db.k.selectFrom("jobs").select(["id", "ended_at as endedAt", "state", "items", "acted", "lease_skips", "lease_skip_keys"])
    .where("step", "=", step).$if(repo !== null, (q) => q.where("repo", "=", repo!))
    .where("ended_at", "is not", null).$if(requestedBy !== undefined, (q) => q.where("requested_by", "=", requestedBy!))
    .where((eb) => eb(eb.fn.coalesce("error", eb.val("")), "<>", RUNNER_STOPPED)).orderBy("id", "desc").limit(1).$narrowType<{ endedAt: string }>());
}

/** A job that changed nothing: it handled no items and made no other progress (a batch advanced, a PR opened, a decision asked). */
const wasIdle = (j: { items: number | null; acted: number | null }): boolean => !j.items && !j.acted;

// ---- fingerprints ----------------------------------------------------------------

type FpRecord = { job: number; fp: string };
const fpKey = (step: string, repo: string | null): string => `pipeline_fp:${step}|${repo ?? ""}`;

/** What the lane's input looked like: the step, its repo, and the counters of the topics it reads. */
export async function fingerprintOf(db: Db, lane: Pick<Lane, "topics" | "extra">, step: string, params: Params, seqs?: Record<string, number>): Promise<string> {
  if (seqs === undefined) seqs = await readSeqs(db);
  const topics = lane.topics ?? INPUT_TOPICS;
  return [step, typeof params.repo === "string" ? params.repo : "", ...topics.map((t) => seqs[t] ?? 0), await lane.extra?.(db) ?? "", await takersOf(db)].join("|");
}

async function fpRecord(db: Db, step: string, repo: string | null): Promise<FpRecord | null> {
  const v = await getSetting(db, fpKey(step, repo));
  if (!v) return null;
  try { return JSON.parse(v) as FpRecord; } catch { return null; }
}

/** Tracked repos after `cursor` first, wrapping round. */
export function roundRobin(repos: string[], cursor: string | null): string[] {
  const sorted = [...repos].sort();
  const after = sorted.filter((r) => cursor !== null && r > cursor);
  return [...after, ...sorted.filter((r) => !after.includes(r))];
}

/** The issue an implement job works on, its bucket and the planned item's work score. */
type ImplementJob = { number: number; bucket: string; score: number | null };

/**
 * Per repo, the queued issue its next implement job works on. The revisions of our implementation PRs (planned on the PR,
 * for the PR's issue) come first, then the issues in the planned order (work of ours in flight, then the work score).
 */
async function implementWork(db: Db, tracked: string[], plans: PlanSet): Promise<Map<string, ImplementJob>> {
  const repos = new Set(tracked), out = new Map<string, ImplementJob>();
  const add = (repo: string, j: ImplementJob) => { if (repos.has(repo) && !out.has(repo)) out.set(repo, j); };
  for (const p of allowed(await planned(db, "implement", { plans }))) add(p.facts.repo, { number: Number(p.action.params?.issue), bucket: "revise", score: p.facts.score });
  for (const p of allowed(await plannedItems(db, "implement", { plans }))) add(p.facts.repo, { number: p.facts.number, bucket: String(p.action.params?.bucket ?? "plan"), score: p.facts.score });
  return out;
}

/** The highest of the scores, null when there is none. */
export const bestScore = (scores: (number | null | undefined)[]): number | null => {
  const some = scores.filter((s): s is number => typeof s === "number");
  return some.length ? Math.max(...some) : null;
};

/**
 * Lanes that have a topScore trade places by it: the lane whose best item has the higher work score comes
 * first, so its job is queued first. A lane without work goes last; ties keep the pipeline order. Other
 * lanes keep their places.
 */
export function orderLanes<T extends { name: string }>(lanes: T[], tops: Map<string, number | null>): T[] {
  const shared = lanes.filter((l) => tops.has(l.name));
  const sorted = [...shared].sort((a, b) => (tops.get(b.name) ?? -1) - (tops.get(a.name) ?? -1));
  let k = 0;
  return lanes.map((l) => (tops.has(l.name) ? sorted[k++]! : l));
}

/** Repos with a CI-fix action of one of the buckets that the guard lets the pipeline carry out (rerun: CI approval; work and collect: a push, or a comment on a closed branch). */
async function cifixRepos(db: Db, ctx: PlanCtx, buckets: string[]): Promise<string[]> {
  const repos = new Set(ctx.tracked);
  const due = allowed(await planned(db, "cifix", { plans: await plansOf(db, ctx) })).filter((p) => buckets.includes(String(p.action.params?.bucket)));
  return flightFirst(await plansOf(db, ctx), [...new Set(due.map((p) => p.facts.repo))].filter((r) => repos.has(r)).sort());
}

/** The code of each lane, keyed by name. Names, steps and order come from the stage registry. */
const LANE_CODE: Omit<Lane, "steps">[] = [
  {
    name: "classify",
    // Jev classifies the items Jev is due for without a Task Runner; Haiku's calls need one.
    detect: async (db, ctx) => {
      const jev = !!ctx.run && await jevUsable(db);
      return ctx.run && (await servable(db, ctx, "classify", "classify-new", (p) => jev && p.action.params?.source === "jev")).length ? [{ step: "classify-new", params: {} }] : [];
    },
  },
  {
    // Items without a priority at their current text hash; the scores of the others are refreshed by the same job.
    name: "priority",
    detect: async (db, ctx) => {
      const jev = await jevUsable(db);
      return (await servable(db, ctx, "prioritize", "prioritize", () => jev)).length ? [{ step: "prioritize", params: {} }] : [];
    },
  },
  {
    // Work score from the stored priority, size, type and security flag; no model. The rank-inputs topic is its work test:
    // it moves only when something runRank reads changed (the lane's own output is not in it).
    name: "rank",
    topics: ["rank-inputs"],
    minGapMs: 60_000,
    detect: async () => [{ step: "rank", params: {} }],
  },
  {
    name: "embed",
    detect: async (db, ctx) => (await embedDue(db, embedderId(modelName()), await plansOf(db, ctx)) ? [{ step: "embed", params: {} }] : []),
  },
  {
    // Before Decide: items held as duplicates wait out the later stages.
    name: "dupes",
    detect: async (db, ctx) => {
      const plans = await plansOf(db, ctx);
      // Scans (local vectors), group questions and answers need no model; a pair check needs a Task Runner, also for its Jev half.
      return (await servable(db, ctx, "dupes", "dupes", (p) => !!p.action.params?.scan || !!p.action.params?.group)).length || (await plannedItems(db, "dupe-answer", { plans })).length ? [{ step: "dupes", params: {} }] : [];
    },
  },
  {
    // Each duplicate group is compared once its pairs are checked; the comparison asks the group decision.
    name: "dupes-compare",
    // A set settled by rule (a closed member, a lone member) needs no model; the others need a Task Runner.
    detect: async (db, ctx) => ((await servable(db, ctx, "dupes-compare", "dupes-compare", (p) => p.facts.inCompareSet === "rule")).length ? [{ step: "dupes-compare", params: {} }] : []),
  },
  {
    name: "decide",
    // Open scope decisions without a recommendation (asked before recommendations existed) also need a job; an answered-null one has recommended_by set.
    detect: async (db, ctx) => {
      // A recommendation that failed is tried again once its backoff ends.
      for (const r of await db.all(db.k.selectFrom("decisions").select("recommend_failed_at as at").where("answer", "is", null)
        .where("recommend_failed_at", ">", new Date(Date.now() - RECOMMEND_RETRY_MS).toISOString()).$narrowType<{ at: string }>())) ctx.wake?.push(Date.parse(r.at) + RECOMMEND_RETRY_MS);
      // A new scope decision is asked without a model; the prepare calls Opus.
      return (await servable(db, ctx, "decide", "decide", (p) => p.action.params?.source === "new")).length ? [{ step: "decide", params: {} }] : [];
    },
  },
  {
    // One repo per job, round robin; the repo's checks come before its review.
    name: "review",
    perRepo: true,
    detect: async (db, ctx) => {
      const out: Candidate[] = [];
      const top = firstByRepo(await planned(db, "review", { plans: await plansOf(db, ctx) }));
      // A PR waiting out the minimum time between reviews, the conflict merge cap or the backoff of an unsent comment is planned again when it ends.
      for (const p of (await plansOf(db, ctx)).prs) {
        const f = p.facts;
        for (const t of [f.reviewHold?.until, f.conflict?.until, f.fixup?.unsent, f.cifix?.unsent, ...f.carry.map((c) => c.unsent)]) {
          const at = typeof t === "object" ? t.until : t;
          if (typeof at === "number") ctx.wake?.push(at);
        }
      }
      // No other stage re-reads the checks of a head that was stored as running or red: a PR whose review waits for CI has its repo's checks read again, at most once per WAITING_CI_RECHECK_MS.
      const ciWait = new Set((await plansOf(db, ctx)).prs.filter((p) => p.facts.reviewHold?.kind === "ci" && !p.facts.reviewHold.red && p.plan.wait === p.facts.reviewHold.wait).map((p) => p.facts.repo));
      for (const repo of flightFirst(await plansOf(db, ctx), await fastFirst(db, roundRobin(ctx.tracked, await getSetting(db, KEY_CURSOR)), (r) => top.get(r)?.facts.number, await fastOf(db, ctx)))) {
        if (!top.has(repo)) continue;
        const checks = await lastJobEnd(db, "checks", repo);
        const fresh = checks?.state === "done" && Date.now() - Date.parse(checks.endedAt) < CHECKS_FRESH_MS;
        const review = { step: "opus-review", params: { repo } };
        out.push(fresh ? review : { step: "checks", params: { repo }, poll: true, gate: review });
      }
      // A repo whose waiting heads have all been pending for more than an hour is read every 5 minutes instead.
      const waiting = (await plansOf(db, ctx)).prs.filter((p) => ciWait.has(p.facts.repo) && p.facts.reviewHold?.kind === "ci" && !p.facts.reviewHold.red);
      const updated = new Map(waiting.length ? (await db.all(db.k.selectFrom("items as i")
        .innerJoin(kx.refPairs(db, waiting.map((p): [string, number] => [p.facts.repo, p.facts.number]), "j"), (jn) => jn.onRef("i.repo", "=", "j.repo").onRef("i.number", "=", "j.number"))
        .select((eb) => [eb(eb("i.repo", "||", eb.val("#")), "||", eb.cast<string>("i.number", "text")).as("k"), "i.updated_at"]))).map((r) => [r.k, r.updated_at]) : []);
      const young = new Set(waiting.filter((p) => { const u = updated.get(`${p.facts.repo}#${p.facts.number}`); return !!u && Date.now() - Date.parse(u) <= 3600_000; })
        .map((p) => p.facts.repo));
      for (const repo of [...ciWait].sort()) {
        if (out.some((c) => c.params.repo === repo)) continue;
        const last = await lastJobEnd(db, "checks", repo);
        const gap = young.has(repo) ? WAITING_CI_RECHECK_MS : 5 * 60_000;
        if (last && Date.now() - Date.parse(last.endedAt) < gap) {
          ctx.wake?.push(Date.parse(last.endedAt) + gap);
          continue;
        }
        out.push({ step: "checks", params: { repo }, poll: true });
      }
      return out;
    },
    topScore: async (db, ctx) => {
      const top = firstByRepo(await planned(db, "review", { plans: await plansOf(db, ctx) }));
      return bestScore(ctx.tracked.map((repo) => top.get(repo)?.facts.score));
    },
    chosen: async (db, c) => {
      if (c.step === "opus-review") await setSetting(db, KEY_CURSOR, String(c.params.repo));
    },
  },
  {
    name: "labels",
    perRepo: true,
    detect: async (db, ctx) => {
      if (!ctx.run) return [];
      const repos = new Set(allowed(await plannedItems(db, "label", { plans: await plansOf(db, ctx) })).map((p) => p.facts.repo));
      // A repo whose GitHub write budget is used up would label nothing (the writes are refused as paced): it waits for the window to move.
      const now = Date.now();
      return (await filterSeq(ctx.tracked, async (repo) => {
        if (!repos.has(repo)) return false;
        const wait = await pipelineWriteWait(db, "labels-apply", repo, now);
        if (wait <= PACE_MAX_WAIT_MS) return true;
        ctx.wake?.push(now + wait);
        if (ctx.notes) ctx.notes["labels-apply"] ??= `The GitHub write budget for ${repo} is used up until ${hhmm(now + wait)}`;
        return false;
      })).map((repo) => ({ step: "labels-apply", params: { repo } }));
    },
  },
  {
    // Needs no merge approval: asking writes only decisions.
    name: "merge-ask",
    detect: async (db, ctx) => {
      const repos = new Set(ctx.tracked);
      return allowed(await planned(db, "ask-merge", { plans: await plansOf(db, ctx) })).some((p) => repos.has(p.facts.repo)) ? [{ step: "merge-ask", params: {} }] : [];
    },
  },
  {
    // Batches in flight and PRs waiting for CI are external waits: they are read again every WAITING_CI_RECHECK_MS, on unchanged inputs too.
    name: "merge",
    perRepo: true,
    extra: tasksSig,
    detect: async (db, ctx) => {
      const plans = await plansOf(db, ctx);
      // The merge queue: PRs with a queue state (merged ones too), in repos approved for merging.
      const queue = plans.prs.filter((p) => p.facts.ghState !== "CLOSED" && isQueueState(p.plan.state) && p.facts.repoFacts.mergeApproved)
        .map((p) => ({ repo: p.facts.repo, number: p.facts.number, state: p.plan.state, eligible: p.plan.eligible }));
      const due = new Set(allowed(await planned(db, "merge", { plans })).map((p) => p.facts.repo));
      const batches = new Set(await batchesDue(db));
      const out: Candidate[] = [];
      // A merge job that advanced a batch runs again at once; one that only watched waits.
      const later = async (step: string, repo: string): Promise<boolean> => {
        const last = await lastJobEnd(db, step, repo);
        if (last && (step === "checks" || wasIdle(last)) && Date.now() - Date.parse(last.endedAt) < WAITING_CI_RECHECK_MS) {
          ctx.wake?.push(Date.parse(last.endedAt) + WAITING_CI_RECHECK_MS);
          const n = queue.filter((e) => e.repo === repo && e.state === "waiting-ci").length;
          (ctx.notes ??= {})[step] = n ? `waiting for CI on ${n} PR${n === 1 ? "" : "s"} in ${repo}` : `waiting for the batch PR's CI in ${repo}`;
          return true;
        }
        return false;
      };
      // The repo whose eligible PR is fast-tracked first goes first.
      const fast = await fastOf(db, ctx);
      const topEligible = (r: string): number | undefined => queue.filter((e) => e.repo === r && e.eligible).sort((a, b) => (fast.get(`${r}#${b.number}`) ?? -1) - (fast.get(`${r}#${a.number}`) ?? -1))[0]?.number;
      for (const repo of flightFirst(plans, await fastFirst(db, [...new Set([...due, ...batches])].sort(), topEligible, fast))) {
        const poll = batches.has(repo);
        if (poll && await later("merge", repo)) continue;
        out.push({ step: "merge", params: { repo }, ...(poll ? { poll } : {}) });
      }
      // No other stage refreshes a PR that waits only for CI or for GitHub to compute its mergeable state.
      const waiting = (await filterSeq([...new Set(queue.filter((e) => e.state === "waiting-ci").map((e) => e.repo))], async (repo) => !due.has(repo) && !batches.has(repo) && !await later("checks", repo))).sort();
      for (const repo of waiting) out.push({ step: "checks", params: { repo }, poll: true, gate: { step: "merge", params: { repo }, poll: true } });
      return out;
    },
  },
  {
    // Comments and closes after operator answers, and Close? decisions for reviewed PRs.
    name: "act",
    perRepo: true,
    // Queued card presses: the drain runs when the first press fits under the daily limit, so the room (and the limit) is part of the input.
    extra: async (db) => {
      const h = await queueHead(db);
      const held = (await heldDue(db)).sig;
      return [h ? `queue:${h.fits ? 1 : 0}:${await actLimit(db) ?? "n"}` : "", held ? `${held}:${await actLimit(db) ?? "n"}` : ""].filter(Boolean).join("|");
    },
    detect: async (db, ctx) => {
      // Repos in the order of their best target: item priority level, then repos that Act served least recently (so one busy repo does not keep the shared daily limit), then the oldest answer.
      const best = new Map<string, { band: number; at: string }>();
      const targets = allowed(await plannedItems(db, "act", { plans: await plansOf(db, ctx) })).flatMap((p) => (typeof p.action.params?.decisionId === "string" ? [{ decisionId: p.action.params.decisionId, repo: p.facts.repo, number: p.facts.number }] : []));
      const keys = await targetKeys(db, targets);
      for (const t of targets) {
        const k = keys.get(t.decisionId);
        if (k && (!best.has(t.repo) || compareKeys(k, best.get(t.repo)) < 0)) best.set(t.repo, k);
      }
      for (const p of allowed(await plannedItems(db, "act", { plans: await plansOf(db, ctx) }))) if (!best.has(p.facts.repo)) best.set(p.facts.repo, { band: 0, at: "" });
      // The press at the head of the queue is carried out by the job of its repo once it fits; until then the planner wakes at the next UTC midnight, when room returns.
      const head = await queueHead(db);
      if (head && !head.fits) ctx.wake?.push(nextUtcMidnight(Date.now()));
      else if (head && ctx.tracked.includes(head.repo) && await commentApprovalOf(db, head.repo)) best.set(head.repo, { band: 5, at: "" });
      // Follow-up issues held until a PR merged: filed by the job of the PR's repo once it merged, dropped once it closed or its merge path ended.
      // A row a stopped create left in `filing` is settled from its audit row once it is old enough: wake then.
      ctx.wake?.push(...await filingWakes(db));
      for (const [repo, fits] of (await heldDue(db)).repos) {
        if (!fits) ctx.wake?.push(nextUtcMidnight(Date.now()));
        else if (ctx.tracked.includes(repo) && await commentApprovalOf(db, repo)) best.set(repo, { band: 5, at: "" });
      }
      const served = new Map(await mapSeq(ctx.tracked, async (repo) => [repo, (await lastJobEnd(db, "act", repo))?.endedAt ?? ""]));
      return ctx.tracked.filter((repo) => best.has(repo)).sort((a, b) => best.get(b)!.band - best.get(a)!.band || (served.get(a)! < served.get(b)! ? -1 : served.get(a)! > served.get(b)! ? 1 : 0) || compareKeys(best.get(a), best.get(b)) || a.localeCompare(b)).map((repo) => ({ step: "act", params: { repo } }));
    },
  },
  {
    name: "fixup",
    perRepo: true,
    // A stored patch is collected when its lint task ends.
    extra: tasksSig,
    detect: async (db, ctx) => {
      const plans = await plansOf(db, ctx);
      const sels = new Map(await mapSeq(ctx.tracked, async (repo) => [repo, await selectFixups(db, repo, ctx.run, plans)]));
      const repos = ctx.tracked.filter((repo) => {
        const sel = sels.get(repo)!;
        const push = repoAllows(plans, repo, { kind: "fixup", bucket: "fix" }), ask = repoAllows(plans, repo, { kind: "fixup", bucket: "ask" });
        return (push && (sel.fix.length > 0 || sel.lint.length > 0 || sel.conflictMerge.length > 0)) || (ask && (sel.ask.length > 0 || sel.conflictAsk.length > 0));
      });
      return flightFirst(plans, await fastFirst(db, repos.sort(), (r) => { const sel = sels.get(r)!; return (sel.lint[0] ?? sel.fix[0] ?? sel.ask[0] ?? sel.conflictMerge[0] ?? sel.conflictAsk[0])?.number; }, await fastOf(db, ctx))).map((repo) => ({ step: "fixup", params: { repo } }));
    },
  },
  {
    // One repo per job, round robin; the repo's checks come before its planning.
    name: "verify",
    perRepo: true,
    extra: tasksSig,
    detect: async (db, ctx) => {
      const out: Candidate[] = [];
      const plans = await plansOf(db, ctx);
      const top = firstByRepo([...await planned(db, "verify", { plans, bucket: "plan" }), ...await planned(db, "verify", { plans, bucket: "unavailable" })]);
      for (const repo of flightFirst(plans, await fastFirst(db, roundRobin(ctx.tracked, await getSetting(db, KEY_VERIFY_CURSOR)), (r) => top.get(r)?.facts.number, await fastOf(db, ctx)))) {
        if (!top.has(repo)) continue;
        const checks = await lastJobEnd(db, "checks", repo);
        const fresh = checks?.state === "done" && Date.now() - Date.parse(checks.endedAt) < CHECKS_FRESH_MS;
        const verify = { step: "verify", params: { repo } };
        out.push(fresh ? verify : { step: "checks", params: { repo }, poll: true, gate: verify });
      }
      return out;
    },
    chosen: async (db, c) => {
      if (c.step === "verify") await setSetting(db, KEY_VERIFY_CURSOR, String(c.params.repo));
    },
  },
  {
    name: "verify-collect",
    extra: tasksSig,
    detect: async (db) => (await collectDue(db) ? [{ step: "verify-collect", params: {} }] : []),
  },
  {
    // Our own build of PR heads (pr-builds feature): queues new builds and collects finished ones, no model call. Off: no repo is detected.
    name: "pr-build",
    perRepo: true,
    extra: tasksSig,
    detect: async (db, ctx) => {
      const queued = new Set(await reposWithQueuedBuilds(db));
      return (await filterSeq([...new Set([...ctx.tracked, ...queued])], async (repo) => await prBuildDue(db, repo, queued))).sort().map((repo) => ({ step: "pr-build", params: { repo } }));
    },
  },
  {
    // One queued issue per job: plan (and build in the same job when the plan is ready), build from a stored plan, or revise our PR.
    name: "implement",
    perRepo: true,
    detect: async (db, ctx) => {
      const plans = await plansOf(db, ctx), work = await implementWork(db, ctx.tracked, plans);
      return flightFirst(plans, await fastFirst(db, [...work.keys()].sort(), (r) => work.get(r)!.number, await fastOf(db, ctx)))
        .map((repo) => { const j = work.get(repo)!; return { step: "implement", params: { repo, number: j.number, bucket: j.bucket } }; });
    },
    topScore: async (db, ctx) => bestScore([...(await implementWork(db, ctx.tracked, await plansOf(db, ctx))).values()].map((j) => j.score)),
  },
  {
    // Label disagreements outside the scope labels, after Jev and Haiku have both answered.
    name: "referee",
    detect: async (db, ctx) => {
      // An item whose Opus call failed is asked again once its backoff ends.
      if (ctx.run) for (const r of await db.all(db.k.selectFrom("classifications").select(kx.jsonText(db, "probs", "$.opusFailedAt").as("at")).where("classifier", "=", "sonnet").where("run_id", "=", ctx.run)
        .where(kx.bytewise(db, kx.jsonText(db, "probs", "$.opusFailedAt")), ">", new Date(Date.now() - RECOMMEND_RETRY_MS).toISOString()).$narrowType<{ at: string }>())) ctx.wake?.push(Date.parse(r.at) + RECOMMEND_RETRY_MS);
      return ctx.run && (await servable(db, ctx, "referee", "referee")).length ? [{ step: "referee", params: {} }] : [];
    },
  },
  {
    // A review carried to our checked fix-up needs no model, so this runs while Claude is paused.
    name: "review-carry",
    perRepo: true,
    detect: async (db, ctx) => {
      const due = new Set((await planned(db, "carry", { plans: await plansOf(db, ctx) })).map((p) => p.facts.repo));
      return ctx.tracked.filter((repo) => due.has(repo)).sort().map((repo) => ({ step: "review-carry", params: { repo } }));
    },
  },
  {
    // The final Opus reviews, posted as one PR review each in repos approved for comments.
    name: "review-post",
    perRepo: true,
    detect: async (db, ctx) => {
      const due = new Set(allowed(await planned(db, "post-review", { plans: await plansOf(db, ctx) })).map((p) => p.facts.repo));
      return ctx.tracked.filter((repo) => due.has(repo)).sort().map((repo) => ({ step: "review-post", params: { repo } }));
    },
  },
  {
    // Operator messages in conversations; answered whether or not the item's repo is in scope, since an operator started them.
    name: "conversation",
    detect: async (db) => ((await pendingConversations(db, undefined, "operator")).length ? [{ step: "conversation", params: {} }] : []),
  },
  {
    // Maintainers' messages, each on the maintainer's own Task Runner: apart from the operators' lane and its daily limit. A job
    // whose messages none of their runners took in time gives them back and handled nothing; the lane then runs again when a
    // message is added or answered, or a waiting maintainer's runners take or end a call (or report ready, the taker signature),
    // not on the claim and release its own job wrote.
    name: "conversation-maintainer",
    topics: [],
    extra: async (db) => {
      const waiting = await pendingConversations(db, undefined, "maintainer");
      const logins = [...new Set(waiting.map((c) => c.login.toLowerCase()))].sort();
      return `${waiting.map((c) => c.turnId).join(",")}|${(await mapSeq(logins, async (l) => `${l}:${await leaseTurnover(db, l)}`)).join(",")}`;
    },
    detect: async (db) => ((await pendingConversations(db, undefined, "maintainer")).length ? [{ step: "conversation-maintainer", params: {} }] : []),
  },
  {
    // Runs GitHub holds for approval on reviewed outside PRs; the checks job records them, the step approves.
    name: "ci-approve",
    perRepo: true,
    detect: async (db, ctx) => (await filterSeq(ctx.tracked, async (repo) => repoAllows(await plansOf(db, ctx), repo, { kind: "approve-ci" }) && (await needsWork(db, repo, ctx.run, await plansOf(db, ctx))).length)).sort().map((repo) => ({ step: "ci-approve", params: { repo } })),
  },
  {
    // Failing gate checks of wanted PRs: the log is read, a formatter run is queued or collected, or a patch is written and pushed.
    name: "cifix",
    perRepo: true,
    extra: tasksSig,
    detect: async (db, ctx) => {
      // A stored patch whose lint task ended is collected by the same step.
      const lint = allowed(await planned(db, "lint", { plans: await plansOf(db, ctx), bucket: "cifix" })).map((p) => p.facts.repo).filter((r) => ctx.tracked.includes(r));
      return flightFirst(await plansOf(db, ctx), [...new Set([...await cifixRepos(db, ctx, ["work", "collect"]), ...lint])].sort()).map((repo) => ({ step: "cifix", params: { repo } }));
    },
  },
  {
    // The planner decides which items left the path to merge; this lane only carries out the unassign actions.
    name: "unassign",
    perRepo: true,
    detect: async (db, ctx) => {
      const plans = await plansOf(db, ctx), repos = new Set(ctx.tracked);
      const due = [...allowed(await planned(db, "unassign", { plans })), ...allowed(await plannedItems(db, "unassign", { plans }))];
      return [...new Set(due.map((p) => p.facts.repo))].filter((r) => repos.has(r)).sort().map((repo) => ({ step: "unassign", params: { repo } }));
    },
  },
  {
    // One status comment per PR, in repos with the PR status switch on: queued when a PR's status line differs from the posted one.
    // Every tracked repo, not only those in scope: comments already posted get their last Merged or Closed edit after the repo's Pipeline is switched off.
    name: "pr-status",
    perRepo: true,
    anyTracked: true,
    // A PR's failure backoff ends with the clock, not with a change in the data.
    extra: async (db) => await statusRetriesDue(db),
    detect: async (db, ctx) => {
      const now = Date.now();
      return (await filterSeq(await trackedNames(db), async (repo) => {
        if (!await statusApprovalOf(db, repo)) return false;
        const retry = await statusRetryAt(db, repo, now);
        if (retry !== null) ctx.wake?.push(retry);
        if (!(await statusDue(db, repo, now)).length) return false;
        // A repo whose GitHub write budget is used up would write nothing (the writes are refused as paced): it waits for the window to move.
        const wait = await pipelineWriteWait(db, "pr-status-comment", repo, now);
        if (wait <= PACE_MAX_WAIT_MS) return true;
        ctx.wake?.push(now + wait);
        if (ctx.notes) ctx.notes["pr-status"] ??= `The GitHub write budget for ${repo} is used up until ${hhmm(now + wait)}`;
        return false;
      })).sort().map((repo) => ({ step: "pr-status", params: { repo } }));
    },
  },
  {
    name: "cifix-rerun",
    perRepo: true,
    detect: async (db, ctx) => (await cifixRepos(db, ctx, ["rerun"])).map((repo) => ({ step: "cifix-rerun", params: { repo } })),
  },
  {
    // The adversarial review of each PR head the merge rule would merge; the queue holds the PR until it is stored.
    name: "premerge",
    perRepo: true,
    detect: async (db, ctx) => {
      const repos = new Set(ctx.tracked);
      const due = new Set((await premergeCandidates(db, { plans: await plansOf(db, ctx), ...(ctx.wake ? { wake: ctx.wake } : {}) })).map((e) => e.repo));
      return [...due].filter((repo) => repos.has(repo)).sort().map((repo) => ({ step: "premerge", params: { repo } }));
    },
  },
  {
    // Opus reviews what each pipeline merge landed; reads only, so it needs no repo approval.
    name: "postmerge",
    perRepo: true,
    detect: async (db, ctx) => (await filterSeq(ctx.tracked, async (repo) => (await selectPostmerge(db, repo, Date.now(), ctx.run, await plansOf(db, ctx))).length)).sort().map((repo) => ({ step: "postmerge", params: { repo } })),
  },
  {
    // The defects of those reviews become issues in repos approved for comments.
    name: "postmerge-file",
    perRepo: true,
    detect: async (db, { tracked }) => {
      const pending = new Set((await pendingDefects(db)).map((d) => d.repo));
      return (await filterSeq(tracked, async (repo) => await commentApprovalOf(db, repo) && pending.has(repo))).sort().map((repo) => ({ step: "postmerge-file", params: { repo } }));
    },
  },
  {
    // A red default branch in a repo approved for it: flaky failures are rerun once, infrastructure failures become a decision, code failures are recorded.
    name: "main-fix",
    perRepo: true,
    // A rerun waits for the next reading of the head or a time limit; the clock moves with no change in the data.
    extra: async (db) => {
      const n = (await db.get(db.k.selectFrom("main.main_fixes").select((eb) => eb.fn.countAll<number>().as("n")).where("state", "=", "rerun-requested")))!.n;
      return n ? `${n}:${Math.floor(Date.now() / 300_000)}` : "";
    },
    detect: async (db, { tracked }) => (await filterSeq(tracked, async (repo) => await mainFixDue(db, repo))).sort().map((repo) => ({ step: "main-fix", params: { repo } })),
  },
  {
    // The nightly checks of repos with the build feature on: queued once a day per repo (in data, from the last run's time), collected when their tasks end.
    name: "nightly",
    perRepo: true,
    // The day's schedule moves with the clock, not with a change in the data.
    extra: async (db) => ((await featureRepos(db, "nightly")).length ? String(Math.floor(Date.now() / 3_600_000)) : ""),
    detect: async (db, { tracked }) => (await nightlyRepos(db, tracked)).map((repo) => ({ step: "nightly", params: { repo } })),
  },
];

export const LANES: Lane[] = buildLanes(LANE_CODE);

/** Every registry lane needs its code and every code entry a registry lane; a mismatch is a programming error. */
export function buildLanes(code: Omit<Lane, "steps">[]): Lane[] {
  const reg = lanesInOrder();
  const names = new Set(reg.map((l) => l.name));
  const missing = reg.filter((l) => !code.some((c) => c.name === l.name)).map((l) => l.name);
  const extra = code.filter((c) => !names.has(c.name)).map((c) => c.name);
  if (missing.length || extra.length) throw new Error(`autopilot lanes and the stage registry differ: no detect for [${missing}], no registry lane for [${extra}]`);
  return reg.map((l) => ({ ...code.find((c) => c.name === l.name)!, steps: l.steps }));
}

// ---- limits and usage ----------------------------------------------------------

export const dayStart = (ms: number = Date.now()): string => `${new Date(ms).toISOString().slice(0, 10)}T00:00:00.000Z`;

type LimitRow = { step: string; per_day: number | null; updated_by: string | null; updated_at: string | null };

/** Daily limits that apply until an operator sets one. */
export const DEFAULT_PER_DAY: Record<string, number> = defaultPerDay();

export const limitRow = async (db: Db, step: string): Promise<LimitRow> => {
  const pass = passOf(db);
  const row = pass ? (pass.limits ??= new Map((await db.all(db.k.selectFrom("stage_limits").select(kx.cols("stage_limits")))).map((r) => [r.step, r]))).get(step)
    : await db.get(db.k.selectFrom("stage_limits").select(kx.cols("stage_limits")).where("step", "=", step));
  return row ?? { step, per_day: DEFAULT_PER_DAY[step] ?? null, updated_by: null, updated_at: null };
};

/** Items handled by the step's jobs that started today (UTC) and after the operator's last reset of its count; for Act, also the GitHub writes of conversation cards. */
export async function usageToday(db: Db, step: string, ms: number = Date.now()): Promise<number> {
  const pass = passOf(db);
  if (step === "act") {
    if (!pass) return await actUsedToday(db, ms);
    const day = dayStart(ms), act = (pass.act ??= new Map());
    if (!act.has(day)) act.set(day, await actUsedToday(db, ms));
    return act.get(day)!;
  }
  const day = dayStart(ms), reset = await getSetting(db, KEY_RESET + step);
  if (pass) {
    // The jobs started since the start of the day, read once; a reset only moves the start later.
    if (pass.started?.day !== day) pass.started = { day, rows: await db.all(db.k.selectFrom("jobs").select(["step", "started_at", "items"]).where("started_at", ">=", day).$narrowType<{ started_at: string }>()) };
    const from = reset && reset > day ? reset : day;
    return pass.started.rows.reduce((n, j) => n + (j.step === step && j.started_at >= from ? j.items ?? 0 : 0), 0);
  }
  return (await db.get(db.k.selectFrom("jobs").select((eb) => eb.fn.coalesce(eb.fn.sum<number>("items"), eb.lit(0)).as("n")).where("step", "=", step).where("started_at", ">=", reset && reset > day ? reset : day)))!.n;
}

/**
 * The part of its `limit` that each queued or running job of the step has not used yet: the day's limit keeps it for them.
 * A queued job that waits for a Task Runner (untakenTest) keeps none.
 */
export async function reservedByJobs(db: Db, step: string, untaken?: UntakenTest): Promise<number> {
  const pass = passOf(db);
  // In a pass the queued and running jobs of every step are read once.
  const rows = pass ? (pass.live ??= await db.all(db.k.selectFrom("jobs").select(["step", "params", "items", "state", "repo"]).where("state", "in", ["queued", "running"]))).filter((r) => r.step === step)
    : await db.all(db.k.selectFrom("jobs").select(["params", "items", "state", "repo"]).where("step", "=", step).where("state", "in", ["queued", "running"]));
  let n = 0;
  for (const r of rows) {
    if (r.state === "queued" && await (untaken ??= await untakenTest(db))({ step, repo: r.repo, params: r.params })) continue;
    let limit: unknown;
    try { limit = (JSON.parse(r.params) as { limit?: unknown }).limit; } catch { continue; }
    if (typeof limit === "number") n += Math.max(0, limit - (r.items ?? 0));
  }
  return n;
}

/** The `limit` a job of the step may get (undefined when the step has none), or null when the day's limit leaves less than the step's minimum. `wanted` is a limit asked for (default: the step's). */
export async function jobLimit(db: Db, step: StepDef, ms: number = Date.now(), wanted?: number, untaken?: UntakenTest): Promise<{ limit?: number } | null> {
  const lp = step.params.find((p) => p.name === "limit" && p.kind === "int");
  if (!lp || lp.kind !== "int") return {};
  const perDay = (await limitRow(db, step.name)).per_day;
  const limit = Math.min(wanted ?? lp.default ?? lp.max, lp.max, perDay === null ? Infinity : perDay - await usageToday(db, step.name, ms) - await reservedByJobs(db, step.name, untaken));
  return limit < lp.min ? null : { limit };
}

/**
 * Why a command-line run of the step cannot start now, or null: the gate() rules of the planner that are not pacing
 * (a job of the step for the same repo is queued or running, the step already works its most repos, a running job
 * holds the step's mutex, the daily limit, a pause).
 */
export async function cliGate(db: Db, step: { name: string }, steps: Map<string, StepDef>, params: Params = {}, ms: number = Date.now()): Promise<string | null> {
  const busy = await jobBlock(db, steps, { step: step.name, repo: typeof params.repo === "string" ? params.repo : null, number: typeof params.number === "number" ? params.number : null }, { mutex: true });
  if (busy) return busy;
  return await pauseReason(db, step.name, ms, { backoff: false, repo: typeof params.repo === "string" ? params.repo : null });
}

/** The steps an operator release (operator-actions.ts) hands new work to. */
const RELEASE_STEPS: Record<string, string[]> = {
  "batch-again": ["merge"], "review-again": ["opus-review"], "verify-again": ["verify"],
};

/** When an operator last released work for the step, or null. */
async function releasedAt(db: Db, step: string): Promise<string | null> {
  const actions = Object.keys(RELEASE_STEPS).filter((a) => RELEASE_STEPS[a]!.includes(step));
  if (!actions.length) return null;
  return (await db.get(db.k.selectFrom("audit").select((eb) => eb.fn.max<string | null>("at").as("at")).where("action", "in", actions)))!.at;
}

/** The least wait after a job stopped for running past its deadline. */
export const DEADLINE_BACKOFF_MS = 3600_000;

/** Minutes-long wait after `failures` failed jobs in a row: 1, 2, 4, 8, 16 minutes, then 30. */
export const failureDelayMs = (failures: number): number => Math.min(FAIL_BACKOFF_MAX_MS, FAIL_BACKOFF_MS * 2 ** Math.max(0, failures - 1));

/**
 * Failed autopilot jobs of the step (of the repo, when given) since its last success: when it may run again, else null.
 * An operator release since the last failure ends it. After a single failure, so does a changed input (`fp` given and
 * different from the one the failed job saw); later failures wait out the backoff, because inputs that change every
 * minute would otherwise retry a failing step at once, every time. Jobs a runner restart ended, and jobs that failed only because a write was paced (it is retried later anyway), do not count.
 */
export async function failureBackoff(db: Db, step: string, ms: number = Date.now(), o: { repo?: string | null; fp?: string } = {}): Promise<{ until: number; failures: number } | null> {
  const rows = await db.all(db.k.selectFrom("jobs").select(["id", "state", "ended_at", "error"]).where("step", "=", step).$if(o.repo != null, (q) => q.where("repo", "=", o.repo!))
    .where("requested_by", "=", AUTOPILOT_USER).where("state", "in", ["done", "failed"])
    .where((eb) => eb.and([eb(eb.fn.coalesce("error", eb.val("")), "<>", RUNNER_STOPPED), eb.not(kx.like(db, eb.fn.coalesce("error", eb.val("")), eb.val("write paced:%")))]))
    .orderBy("id", "desc").limit(12));
  let failures = 0;
  while (failures < rows.length && rows[failures]!.state === "failed") failures++;
  if (!failures || !rows[0]!.ended_at) return null;
  const released = await releasedAt(db, step);
  if (released && released > rows[0]!.ended_at) return null;
  // A job stopped for its deadline did paid work that a rerun would repeat: a changed input does not end the wait.
  const stopped = DEADLINE_ERROR.test(rows[0]!.error ?? "");
  if (o.fp !== undefined && failures === 1 && !stopped) {
    const rec = await fpRecord(db, step, o.repo ?? null);
    if (rec && rec.job === rows[0]!.id && rec.fp !== o.fp) return null;
  }
  const until = Date.parse(rows[0]!.ended_at) + (stopped ? Math.max(DEADLINE_BACKOFF_MS, failureDelayMs(failures)) : failureDelayMs(failures));
  return until > ms ? { until, failures } : null;
}

const hhmm = (ms: number): string => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

/** Why the step cannot start because its push stage tripped on every repo, or (with `repo`) a job of it cannot work that repo because it tripped there; null when neither. */
async function tripOfStep(db: Db, step: string, repo: string | null): Promise<string | null> {
  const pass = passOf(db);
  return pass ? tripReasonIn(pass.trips ??= await activeTrips(db), step, repo) : await tripReasonOfStep(db, step, repo);
}

/**
 * Why the stage cannot start jobs now and when that can lift by itself (null: only a write lifts it, such as a resume or a limit change), or null when it is not paused.
 * A breaker of the step's push stage tripped on every repo pauses it; with `repo`, a job for that repo, one tripped on that repo pauses it too (the stage goes on for other repos). A step's models are taken at their defaults.
 */
export async function pauseOf(db: Db, step: string, ms: number = Date.now(), o: { backoff?: boolean; repo?: string | null } = {}): Promise<{ why: string; wakeAt: number | null } | null> {
  const l = await limitRow(db, step), used = await usageToday(db, step, ms);
  const tripped = await tripOfStep(db, step, o.repo ?? null);
  if (tripped) return { why: tripped, wakeAt: null };
  if (l.per_day === 0) return { why: "paused: the daily limit is 0", wakeAt: null };
  if (l.per_day !== null && used >= l.per_day) return { why: `daily limit of ${l.per_day} items reached; resumes at 00:00 UTC`, wakeAt: nextUtcMidnight(ms) };
  const b = o.backoff === false ? null : await failureBackoff(db, step, ms);
  if (b !== null) return { why: `failed ${b.failures} time${b.failures === 1 ? "" : "s"} in a row; retry at ${hhmm(b.until)}`, wakeAt: b.until };
  // Steps that call Claude (decide, opus-review, the Haiku part of classify-new) wait for an account with headroom.
  // In the user-local mode no account is used: calls wait for helpers instead.
  if (usesClaude(modelsOf(knownStep(step), {})) && await inferenceMode(db) === "server") {
    const why = await claudePauseReason(db, ms);
    return why === null ? null : { why, wakeAt: ms + 60_000 };
  }
  return null;
}

/** Why the stage cannot start jobs now, or null. The one place a stage's pause is decided. */
export const pauseReason = async (db: Db, step: string, ms: number = Date.now(), o: { backoff?: boolean; repo?: string | null } = {}): Promise<string | null> => (await pauseOf(db, step, ms, o))?.why ?? null;

// ---- state ---------------------------------------------------------------------

/** On: the planner queues jobs and the runner starts them. Draining and off are both not enabled. */
export const isEnabled = async (db: Db): Promise<boolean> => await getSetting(db, KEY_ENABLED) === "1";
/** Draining: like off for new work, but the writes of jobs already running go through. */
export const isDraining = async (db: Db): Promise<boolean> => await getSetting(db, KEY_ENABLED) === PIPELINE_DRAIN;

export async function setEnabled(db: Db, enabled: boolean, by: string, mode: "off" | "drain" = "off"): Promise<void> {
  await setSetting(db, KEY_ENABLED, enabled ? "1" : mode === "drain" ? PIPELINE_DRAIN : "0");
  await setSetting(db, KEY_BY, by);
  await setSetting(db, KEY_AT, now());
  // Automatic jobs still waiting are dropped; running ones finish.
  if (!enabled) {
    const waiting = await db.all(db.k.selectFrom("jobs").select(["id", "step"]).where("state", "=", "queued").where("requested_by", "=", AUTOPILOT_USER));
    for (const j of waiting) {
      await requestCancel(db, j.id, by);
      await audit(db, by, "job-cancel", `job:${j.id}`, { step: j.step, state: "queued", reason: "pipeline switched off" });
    }
  }
  // Turning on plans at once; the sync that already happened is not new.
  if (enabled) await deleteSetting(db, KEY_PLANNED_AT);
}

/** How many of the newest jobs deadlineStops looks at. */
const STOP_WINDOW = 5000;

/** Jobs the runner stopped for running past their step's limit that nobody has acknowledged and no later job of the step has beaten. */
export async function deadlineStops(db: Db): Promise<{ step: string; jobId: number; error: string; endedAt: string | null; count: number }[]> {
  const floor = Number((await db.get(db.k.selectFrom("jobs").select((eb) => eb.fn.max<number | null>("id").as("m"))))!.m ?? 0) - STOP_WINDOW;
  const rows = await db.all(db.k.selectFrom("jobs").select(["step", "id", "error", "ended_at as endedAt"]).where("id", ">", floor).where("state", "=", "failed")
    .where((eb) => eb.or([kx.like(db, "error", eb.val("stopped: ran past %")), kx.like(db, "error", eb.val("stopped: no progress for %"))])).orderBy("id", "desc").$narrowType<{ error: string }>());
  const lastDone = (step: string) => db.get(db.k.selectFrom("jobs").select((eb) => eb.fn.max<number | null>("id").as("m")).where("step", "=", step).where("state", "=", "done"));
  // The acknowledgement is an audit row, which the header's query refetches on and the planner does not.
  const acked = (target: string) => db.get(db.k.selectFrom("audit").select((eb) => eb.fn.max<string | null>("at").as("at")).where("action", "=", "deadline-ack").where("target", "=", target));
  const out: { step: string; jobId: number; error: string; endedAt: string | null; count: number }[] = [];
  const steps = [...new Set(rows.map((r) => r.step))];
  for (const step of steps) {
    const mine = rows.filter((r) => r.step === step), latest = mine[0]!;
    const done = Number((await lastDone(step))!.m ?? 0);
    if (done > latest.id) continue;
    const ack = (await acked(`step:${step}`))!.at;
    if (ack && latest.endedAt !== null && ack >= latest.endedAt) continue;
    out.push({ step, jobId: latest.id, error: latest.error, endedAt: latest.endedAt, count: mine.filter((r) => r.id > done).length });
  }
  return out;
}

/** An operator acknowledges the deadline stops of a step: they leave the warnings until the next one. */
export async function ackDeadline(db: Db, step: string, by: string): Promise<void> {
  await audit(db, by, "deadline-ack", `step:${step}`, {});
}

/** Steps that have a row in stage_limits, in pipeline order. */
export const LIMIT_STEPS = limitSteps();

/** Steps whose jobs cannot be sized to what remains of the day: only no limit or a pause makes sense. */
export const ZERO_ONLY = zeroOnlySteps();

export class LimitError extends Error {
  status = 400;
}

export async function setLimit(db: Db, step: unknown, input: unknown, by: string): Promise<{ perDay: number | null }> {
  if (typeof step !== "string" || !LIMIT_STEPS.includes(step)) throw Object.assign(new LimitError("no such stage"), { status: 404 });
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new LimitError("the body must be a JSON object");
  const keys = Object.keys(input);
  if (keys.some((k) => k !== "perDay")) throw new LimitError("only perDay can be set");
  const perDay = (input as { perDay?: unknown }).perDay;
  if (perDay === undefined) throw new LimitError("perDay is required (null means no limit)");
  if (ZERO_ONLY.includes(step) && perDay !== null && perDay !== 0) throw new LimitError(`${step} cannot be sized by a daily limit: use none, or 0 to pause it`);
  if (perDay !== null && (typeof perDay !== "number" || !Number.isInteger(perDay) || perDay < 0 || perDay > 100_000)) throw new LimitError("perDay must be null or a whole number from 0 to 100000");
  await db.run(db.k.insertInto("stage_limits").values({ step, per_day: perDay, updated_by: by, updated_at: now() })
    .onConflict((oc) => oc.column("step").doUpdateSet(kx.excluded(["per_day", "updated_by", "updated_at"]))));
  await audit(db, by, "stage-limit", `step:${step}`, { perDay });
  return { perDay };
}

/** Starts today's count of one step (or of all) again from zero. */
export async function resetLimitCount(db: Db, step: unknown, by: string): Promise<{ steps: string[] }> {
  const steps = step === "all" ? LIMIT_STEPS : typeof step === "string" && LIMIT_STEPS.includes(step) ? [step] : null;
  if (!steps) throw Object.assign(new LimitError("no such stage"), { status: 404 });
  const at = now();
  for (const st of steps) await setSetting(db, KEY_RESET + st, at);
  await audit(db, by, "limit-reset", step === "all" ? "step:all" : `step:${step}`, { steps });
  return { steps };
}

/** What a stage is doing now: running, queued, or why it is not (the planner's last reading); null when unknown. */
async function stepStatus(db: Db, step: string, why: string | undefined): Promise<string | null> {
  const j = await db.get(db.k.selectFrom("jobs").select("state").where("step", "=", step).where("state", "in", ["running", "queued"])
    .orderBy((eb) => eb.case().when("state", "=", "running").then(1).else(0).end(), "desc").limit(1));
  if (j) return j.state;
  return why ?? null;
}

export async function stageLimits(db: Db): Promise<StageLimit[]> {
  const steps = await loadSteps();
  const why = await stageStatus(db);
  const trips = await activeTripRows(db);
  return await mapSeq(LIMIT_STEPS, async (step) => {
    const l = await limitRow(db, step);
    // canResume is the viewer's: the dashboard API sets it per request.
    const mine = trips.filter((t) => t.tripStage === STEP_STAGE[step]).map((t) => ({ key: t.stage, repo: t.repo, reason: t.reason, since: t.tripped_at, canResume: false }));
    return { step, title: steps.get(step)?.title ?? step, perDay: l.per_day, usedToday: await usageToday(db, step), pausedReason: await pauseReason(db, step), ...(mine.length ? { trips: mine } : {}), status: await stepStatus(db, step, why[step]) };
  });
}

export async function pipelineState(db: Db): Promise<Omit<PipelineState, "outside">> {
  return {
    judgementModel: await judgementModel(db), judgementModels: [...JUDGEMENT_MODELS],
    enabled: await isEnabled(db), draining: await isDraining(db), changedBy: await getSetting(db, KEY_BY), changedAt: await getSetting(db, KEY_AT),
    heartbeat: await getSetting(db, "runner_heartbeat"), limits: await stageLimits(db), pilot: await pilotItems(db),
  };
}

// ---- planner -------------------------------------------------------------------

export type PlanOptions = {
  lanes?: Lane[]; nowMs?: number; log?: (line: string) => void;
  /** Keep facts between passes on this connection and reload only what changed (the runner's worker); AUTOCRAFT_PLAN_SHADOW=throw turns it on for every pass. */
  incremental?: boolean;
};

/** A job the detection pass wants queued; `params` include the `limit` the gate set. */
export type Proposal = { lane: string; step: string; params: Params; fp?: string; gate?: { step: string; params: Params } };
/** `wakeAt`: when a wait the pass found ends (ms), null when none. `status`: why each stage without a proposal is not starting. */
export type Detected = {
  proposals: Proposal[]; logs: string[]; wakeAt?: number | null; status?: Record<string, string>;
  /** Milliseconds the pass spent: loading and deciding the Plans, the lanes, writing the Plan cache; and the cache rows written and deleted. */
  timing?: { loadMs: number; lanesMs: number; cacheMs: number; written: number; deleted: number; pass?: string };
};

/** The fewest proposals one lane hands to apply: one per repo, in order, so that when the first is refused at enqueue (or the step is full at step_parallel) the next repo's goes in. */
const PROPOSALS_PER_LANE = 3;

const nextUtcMidnight = (ms: number): number => Date.parse(dayStart(ms)) + 86_400_000;

/**
 * Detection: loads and decides the Plans of every PR and item once, then returns, per lane, the candidates whose
 * step is idle, not backing off, not unchanged since a job that handled nothing, and has limit left. A lane is the
 * items whose Plan holds its action, minus what the guard would refuse (gates()). The only write is the Plan cache
 * (item_plans), so the runner can do it on another connection while it keeps polling; applyProposals() queues the result.
 * The order of the checks on a lane: a step of the lane can start (gate), the lane's items, the guard's gates() per
 * item or repo, the pipeline scope, then gate() per candidate: same-step job, pause and daily limit, failure backoff,
 * unchanged input, minimum gap.
 */
export async function detectAutopilot(db: Db, opts: PlanOptions = {}): Promise<Detected> {
  const steps = await loadSteps();
  // The rest of the pass is synchronous, so its settings come from one reading of the table.
  return await withSettingsSnapshot(db, async () => await withPassReads(db, async () => await detectPass(db, opts, steps)));
}

async function detectPass(db: Db, opts: PlanOptions, steps: Map<string, StepDef>): Promise<Detected> {
  const lanes = opts.lanes ?? LANES, ms = opts.nowMs ?? Date.now();
  const logs: string[] = [];
  const log = (l: string) => { logs.push(l); opts.log?.(l); };
  const proposals: Proposal[] = [];
  const t0 = performance.now();
  const ctx = await planCtx(db, opts.incremental === true || process.env.AUTOCRAFT_PLAN_SHADOW === "throw");
  ctx.detected = new Map();
  // One reading of the Task Runners for the pass: which repos' Claude jobs no runner may take.
  const untaken = (ctx.untaken = await untakenTest(db, steps, ms));
  const loadMs = performance.now() - t0;
  const scope = ctx.scope ?? await scopeRepos(db);
  const seqs = await readSeqs(db);
  const status: Record<string, string> = {};
  // activeJobs, read with the items the daily limits reserve (reservedByJobs): one read of the queued and running jobs for the pass.
  const live = await db.all(db.k.selectFrom("jobs").select(["id", "step", "state", "repo", kx.jsonNum(db, "params", "$.number").as("number"), "params", "items"])
    .where("state", "in", ["queued", "running"]));
  const active: Active[] = live.map(({ items: _, ...a }) => a);
  const reads = passOf(db);
  if (reads) reads.live = live;
  const perLane = Math.max(PROPOSALS_PER_LANE, Math.min(await stepParallel(db), 16));
  // Pause and limit do not change during the pass: one answer per step.
  const paused = new Map<string, string | null>();
  const limitLeft = new Map<string, { limit?: number } | null>();

  const pausedWhy = async (stepName: string): Promise<string | null> => {
    if (!paused.has(stepName)) {
      const p = await pauseOf(db, stepName, ms, { backoff: false });
      const why = p?.why ?? null;
      paused.set(stepName, why);
      if (p?.wakeAt != null) ctx.wake?.push(p.wakeAt);
    }
    return paused.get(stepName)!;
  };
  const note = (stepName: string, why: string) => { status[stepName] ??= why; };

  /**
   * The job's `limit` (undefined when the step has none), or null when it cannot start now. With `lane`, the
   * input checks apply too: failure backoff and "nothing changed since a job that handled nothing".
   */
  const gate = async (stepName: string, params: Params, lane?: Lane, poll = false, precheck = false): Promise<{ limit?: number } | null> => {
    const step = steps.get(stepName);
    if (!step) return null;
    const pending: Active[] = proposals.filter((p) => p.step === stepName).map((p) => ({ id: 0, step: p.step, state: "proposed", repo: typeof p.params.repo === "string" ? p.params.repo : null, number: typeof p.params.number === "number" ? p.params.number : null }));
    const repo0 = typeof params.repo === "string" ? params.repo : null;
    if (await jobBlock(db, steps, { step: stepName, repo: repo0, number: typeof params.number === "number" ? params.number : null }, { extra: pending, precheck, untaken, active })) return null;
    const reason = await pausedWhy(stepName);
    if (reason) { note(stepName, reason); return null; }
    // A breaker tripped on the candidate's repo; the step goes on for other repos, and the trip shows as its own row (pausedWhy covers a trip on every repo).
    if (repo0 !== null && await tripOfStep(db, stepName, repo0)) return null;
    const waits = repo0 === null ? null : await untaken({ step: stepName, repo: repo0, params });
    if (waits !== null) { note(stepName, waits); return null; }
    if (lane) {
      const repo = typeof params.repo === "string" ? params.repo : null;
      const fp = await fingerprintOf(db, lane, stepName, params, seqs);
      const b = await failureBackoff(db, stepName, ms, { repo, fp });
      if (b) {
        ctx.wake?.push(b.until);
        note(stepName, `failed ${b.failures} time${b.failures === 1 ? "" : "s"} in a row; retry at ${hhmm(b.until)}`);
        const key = `${stepName}:${b.until}`;
        if (!warned.has(key)) { warned.add(key); log(`autopilot: ${stepName}: failed ${b.failures} times in a row; retry at ${hhmm(b.until)}`); }
        return null;
      }
      if (!poll && await unchangedSinceIdle(db, stepName, repo, fp)) { note(stepName, "nothing to do: its input has not changed since the last run"); return null; }
      if (lane.minGapMs) {
        const last = await lastJobEnd(db, stepName, repo, AUTOPILOT_USER);
        const next = last ? Date.parse(last.endedAt) + lane.minGapMs : 0;
        if (next > ms) { ctx.wake?.push(next); return null; }
      }
    }
    if (!limitLeft.has(stepName)) limitLeft.set(stepName, await jobLimit(db, step, ms, undefined, untaken));
    return limitLeft.get(stepName)!;
  };

  const tops = new Map<string, number | null>();
  for (const lane of lanes) {
    if (!lane.topScore) continue;
    try { tops.set(lane.name, await lane.topScore(db, ctx)); } catch (e) { log(`autopilot: ${lane.name}: ${(e as Error).message}`); }
  }
  for (const lane of orderLanes(lanes, tops)) {
    try {
      // A lane whose steps cannot start is not worth detecting.
      if (lane.steps && !await someSeq(lane.steps, async (s) => await gate(s, {}, undefined, false, true))) continue;
      const candidates = await detectOf(db, ctx, lane);
      if (!candidates.length) { for (const s of lane.steps ?? []) note(s, "nothing to do"); continue; }
      let taken = 0;
      for (const c of candidates) {
        const outside = lane.anyTracked ? undefined : [c, c.gate].find((x) => x && typeof x.params.repo === "string" && !scope.has(x.params.repo));
        if (outside) { note(outside.step, "outside the pipeline scope"); continue; }
        if (c.gate && !await gate(c.gate.step, c.gate.params, lane, c.gate.poll)) continue;
        const g = await gate(c.step, c.params, lane, c.poll);
        if (!g) continue;
        const params: Params = { ...c.params, ...(g.limit === undefined ? {} : { limit: g.limit }) };
        proposals.push({ lane: lane.name, step: c.step, params, fp: await fingerprintOf(db, lane, c.step, c.params, seqs), ...(c.gate ? { gate: c.gate } : {}) });
        if (++taken >= perLane) break;
      }
    } catch (e) {
      log(`autopilot: ${lane.name}: ${(e as Error).message}`);
    }
  }
  // The lists the Next page shows come from the same pass, so the page needs no Plans of its own.
  if (!opts.lanes) {
    try { await storeLaneItems(db, lanes, ctx); } catch (e) { log(`autopilot: next items: ${(e as Error).message}`); }
  }
  const lanesMs = performance.now() - t0 - loadMs;
  // The Plan cache: the planner's output for the dashboard.
  let cache = { written: 0, deleted: 0 };
  const t1 = performance.now();
  let cached = false;
  try {
    cache = await writePlanCache(db, ctx.plans!);
    cached = true;
  } catch (e) { log(`autopilot: plan cache: ${(e as Error).message}`); }
  const cacheMs = performance.now() - t1;
  if (cached) {
    try { await ctx.pass?.finish(loadMs + lanesMs + cacheMs); } catch (e) { log(`autopilot: plan records: ${(e as Error).message}`); }
  }
  // The liveness check follows the plan cache and stores its own result at most every few minutes.
  try { await refreshLiveness(db); } catch (e) { log(`autopilot: liveness: ${(e as Error).message}`); }
  const passKind = ctx.pass ? `${ctx.pass.kind}, ${ctx.pass.refs} loaded${ctx.pass.diffs.length ? `, ${ctx.pass.diffs.length} shadow differences` : ""}` : undefined;
  if (ctx.pass?.diffs.length) log(`autopilot: plan shadow: ${ctx.pass.diffs.length} differences (plan_shadow_diffs)`);
  if (loadMs + lanesMs + cacheMs > 2000) log(`autopilot: pass took ${Math.round(loadMs + lanesMs + cacheMs)} ms${passKind ? ` (${passKind})` : ""}: plans ${Math.round(loadMs)}, lanes ${Math.round(lanesMs)}, cache ${Math.round(cacheMs)} (${cache.written} rows written, ${cache.deleted} deleted)`);
  // A stage with a candidate the checks above held back says why; the others had no candidate or start now.
  Object.assign(status, ctx.notes ?? {});
  for (const p of proposals) delete status[p.step];
  const wakes = (ctx.wake ?? []).filter((t) => t > ms);
  return { proposals, logs, wakeAt: wakes.length ? Math.min(...wakes) : null, status, timing: { loadMs, lanesMs, cacheMs, ...cache, ...(passKind ? { pass: passKind } : {}) } };
}

/** The lease keys among a job's skip keys: null for a job from before the keys were recorded. */
function leaseSkipKeys(keys: string | null): string[] | null {
  if (!keys) return null;
  try { return (JSON.parse(keys) as string[]).filter((k) => !k.startsWith(NO_TAKER_SKIP)); } catch { return null; }
}

/** True when a running job holds a lease on one of the keys a job skipped (a job from before the keys were recorded: on any lease). */
async function skippedLeaseHeld(db: Db, keys: string[] | null): Promise<boolean> {
  return !!await db.get(db.k.selectFrom("work_leases as l").innerJoin("jobs as j", "j.id", "l.job_id").select((eb) => eb.lit(1).as("one")).where("j.state", "=", "running")
    .$if(keys !== null, (q) => q.where(kx.inList(db, "l.key", keys!))).limit(1));
}

/** True when the last autopilot job of the step (and repo) handled nothing and saw the input `fp` still describes. An operator release since then ends it. */
async function unchangedSinceIdle(db: Db, step: string, repo: string | null, fp: string): Promise<boolean> {
  const last = await lastJobEnd(db, step, repo, AUTOPILOT_USER);
  if (!last || last.state !== "done" || !wasIdle(last)) return false;
  // A job that skipped items another job was working retries once no running job holds a lease on any of them. While one does, the step stays parked, so the planner does not queue it in a loop.
  // Skips for want of a taker do not count: such a step is woken by the taker signature in its fingerprint.
  const leaseKeys = leaseSkipKeys(last.lease_skip_keys);
  if (last.lease_skips && leaseKeys?.length !== 0 && !await skippedLeaseHeld(db, leaseKeys)) return false;
  const rec = await fpRecord(db, step, repo);
  if (!rec || rec.job !== last.id || rec.fp !== fp) return false;
  return !((await releasedAt(db, step) ?? "") > last.endedAt);
}

const warned = new Set<string>();

/** Queues the proposals: per lane and repo the first one that is accepted. Returns the queued job ids. */
export async function applyProposals(db: Db, proposals: Proposal[], opts: PlanOptions & { wakeAt?: number | null; status?: Record<string, string> } = {}): Promise<number[]> {
  const lanes = opts.lanes ?? LANES, log = opts.log ?? (() => {});
  const queued: number[] = [];
  const done = new Set<string>();
  // Jobs queued in this pass and the steps their proposals gate: they hold a repo of the step, so with step_parallel 1 no other repo takes it.
  const reserved: Active[] = [];
  const asActive = (step: string, params: Params, state: string): Active => ({ id: 0, step, state, repo: typeof params.repo === "string" ? params.repo : null, number: typeof params.number === "number" ? params.number : null });
  const steps = await loadSteps();
  const untaken = await untakenTest(db, steps);
  try { await applyUsedAnswers(db); } catch (e) { log(`autopilot: answers: ${(e as Error).message}`); }
  // Marks the next planner pass wants: when a wait ends, and why stages are not starting.
  if (opts.wakeAt) await setSetting(db, KEY_WAKE_AT, new Date(opts.wakeAt).toISOString());
  else await deleteSetting(db, KEY_WAKE_AT);
  if (opts.status) await setSetting(db, KEY_STATUS, JSON.stringify(opts.status));
  for (const p of proposals) {
    const slot = `${p.lane}\0${typeof p.params.repo === "string" ? p.params.repo : ""}`;
    if (done.has(slot)) continue;
    try {
      // The detection ran a moment ago: a job of the same step and repo may have been queued since.
      if (await jobBlock(db, steps, { step: p.step, repo: typeof p.params.repo === "string" ? p.params.repo : null, number: typeof p.params.number === "number" ? p.params.number : null }, { reserved, untaken })) continue;
      if (p.gate && await jobBlock(db, steps, { step: p.gate.step, repo: typeof p.gate.params.repo === "string" ? p.gate.params.repo : null }, { reserved, untaken })) continue;
      // The limit is what is left now, so two proposals of one step cannot both carry the whole remainder.
      const job = await enqueue(db, p.step, p.params, AUTOPILOT_USER, async (step, params) => {
        if (typeof params.limit !== "number") return params;
        const lim = await jobLimit(db, step, Date.now(), params.limit, untaken);
        return lim ? { ...params, ...lim } : null;
      });
      queued.push(job.id);
      reserved.push(asActive(p.step, p.params, "queued"));
      if (p.gate) reserved.push(asActive(p.gate.step, p.gate.params, "gated"));
      done.add(slot);
      if (p.fp !== undefined) await setSetting(db, fpKey(p.step, typeof p.params.repo === "string" ? p.params.repo : null), JSON.stringify({ job: job.id, fp: p.fp } satisfies FpRecord));
      const c: Candidate = { step: p.step, params: Object.fromEntries(Object.entries(p.params).filter(([k]) => k !== "limit")) };
      await lanes.find((l) => l.name === p.lane)?.chosen?.(db, c);
      log(`autopilot: job ${job.id}: ${p.step} ${JSON.stringify(job.params)}`);
    } catch (e) {
      if (!(e instanceof JobError)) {
        log(`autopilot: ${p.lane}: ${(e as Error).message}`);
        done.add(slot);
      } else log(`autopilot: ${p.step}: not queued: ${e.message}`);
    }
  }
  return queued;
}

/** Detection and queueing in one go, on one connection. */
export async function planAutopilot(db: Db, opts: PlanOptions = {}): Promise<number[]> {
  const found = await detectAutopilot(db, opts);
  return applyProposals(db, found.proposals, { ...opts, wakeAt: found.wakeAt ?? null, ...(found.status ? { status: found.status } : {}) });
}

/** What the planner's marks say about the content stages read and the limits that apply to them, from its parts read. */
const inputSignature = (seqs: Record<string, number>, limits: string, tasks: string, takers: string): string =>
  [...INPUT_TOPICS.map((t) => seqs[t] ?? 0), limits, tasks, takers].join(",");

/**
 * Whether the planner is due now (also with the switch off: the Plan cache must follow the data; the runner queues nothing then): a content topic changed, an autopilot job finished, an operator released
 * work, a wait the last pass found has ended, or the fallback timer ran out. Moves the planner's marks when
 * it is, so the caller must then plan.
 */
export async function planDue(db: Db, nowMs: number = Date.now()): Promise<boolean> {
  const t = nowMs;
  // The single-row reads in one statement, with the change markers, the mode and the takers (read in every mode, used in user-local) at the same time.
  const mark = (key: string) => db.k.selectFrom("main.settings").select("value").where("key", "=", key);
  const since = (eb: kx.Eb) => eb.fn.coalesce(mark(KEY_PLANNED_AT), eb.val(""));
  const [v, seqs, mode, takers] = await Promise.all([
    kx.rowValues(db, [...limitRows(db), endedTasks(db), mark(KEY_SEQS_SEEN), mark(KEY_PLANNED_AT), mark(KEY_WAKE_AT),
      db.k.selectFrom("jobs").select((eb) => eb.lit(1).as("one")).where("requested_by", "=", AUTOPILOT_USER).where((eb) => eb("ended_at", ">", since(eb))).limit(1),
      db.k.selectFrom("audit").select((eb) => eb.lit(1).as("one")).where("action", "in", Object.keys(RELEASE_STEPS)).where((eb) => eb("at", ">", since(eb))).limit(1)]),
    readSeqs(db), inferenceMode(db), takerSignature(db),
  ]);
  const text = (r: unknown[] | undefined): string | null => (typeof r?.[0] === "string" ? r[0] : null);
  const sig = inputSignature(seqs, (text(v[0]) ?? "") + (text(v[1]) ?? ""), String(Number(v[2]![0])), mode === "user-local" ? takers : "");
  const [seen, plannedAt, wake] = [text(v[3]), text(v[4]), text(v[5])];
  const changed = sig !== (seen ?? "");
  const planned = plannedAt === null ? 0 : Date.parse(plannedAt);
  const finished = v[6]!.length > 0, released = v[7]!.length > 0;
  const woken = wake !== null && Date.parse(wake) <= t;
  if (!changed && plannedAt !== null && t - planned < PLAN_EVERY_MS && !finished && !released && !woken) return false;
  await setSetting(db, KEY_SEQS_SEEN, sig);
  await setSetting(db, KEY_PLANNED_AT, new Date(t).toISOString());
  // The pass about to run sets the next wake time when it is applied. With the switch off nothing is applied, so a
  // wake time that has passed would stay and make every tick plan again.
  if (woken) await deleteSetting(db, KEY_WAKE_AT);
  return true;
}

/** Why each stage is not starting, as the last planner pass saw it; keyed by step. */
export async function stageStatus(db: Db): Promise<Record<string, string>> {
  try { return JSON.parse(await getSetting(db, KEY_STATUS) ?? "{}") as Record<string, string>; } catch { return {}; }
}

// ---- what each lane will take next ----------------------------------------------

/** The plan actions whose items a lane's job works on, in the order the lane's own selection lists them. Lanes without items are absent. */
export const LANE_KINDS: Record<string, ActionKind[]> = {
  classify: ["classify"], priority: ["prioritize"], embed: ["embed"], dupes: ["dupes", "dupe-answer"], "dupes-compare": ["dupes-compare"], decide: ["decide"],
  review: ["review"], labels: ["label"], "merge-ask": ["ask-merge"], merge: ["merge"], act: ["act"], fixup: ["fixup", "conflict"], verify: ["verify"],
  implement: ["implement"], referee: ["referee"], "review-carry": ["carry"], "review-post": ["post-review"],
  "ci-approve": ["approve-ci"], cifix: ["cifix", "lint"], unassign: ["unassign"], premerge: ["premerge"],
};

/** Lanes whose jobs are not about listed items (counters, collection, operator messages, per-repo scans); every other lane needs a LANE_KINDS entry. */
export const NO_ITEM_LANES = ["rank", "verify-collect", "pr-build", "conversation", "conversation-maintainer", "postmerge", "postmerge-file", "main-fix", "cifix-rerun", "nightly", "pr-status"];

export type LaneItem = {
  repo: string; number: number; kind: "pr" | "issue"; action: string; bucket: string | null;
  fast: boolean; rank: number | null; inFlight: boolean;
  /** The next job of the lane covers this item's repo. */
  next: boolean;
  /** Why the guard would refuse the item's write, or why no job of the lane will take its repo now (no Task Runner takes it), or null. */
  blocked: string | null;
  /** The decision the item's action carries out, when its params name one. */
  decisionId?: string;
};

/**
 * The items a lane's jobs work on, in the order its next jobs take them: the repos in the order `detect` lists
 * its candidates, and within a repo the order the planner's own selection (planned, plannedItems) gives. Items of
 * other repos follow. The dashboard's Next page reads this, so it cannot drift from what the autopilot picks.
 */
export async function laneItems(db: Db, ctx: PlanCtx, lane: Pick<Lane, "name" | "perRepo" | "detect" | "steps">): Promise<LaneItem[]> {
  const kinds = LANE_KINDS[lane.name];
  if (!kinds) return [];
  const plans = await plansOf(db, ctx);
  const seen = new Set<string>(), all: LaneItem[] = [];
  // A repo whose jobs of every step of the lane wait for a Task Runner: the planner proposes none for it.
  const untaken = (ctx.untaken ??= await untakenTest(db)), noRunner = new Map<string, string | null>();
  // Why the repo's jobs wait (the first step's reason), or null when some step of the lane has a taker.
  const waits = async (repo: string): Promise<string | null> => {
    let w = noRunner.get(repo);
    if (w === undefined) {
      const why = lane.steps ? await mapSeq(lane.steps, async (step) => await untaken({ step, repo })) : [];
      noRunner.set(repo, (w = why.length > 0 && why.every((x) => x !== null) ? why[0]! : null));
    }
    return w;
  };
  const add = async (f: Planned["facts"] | PlannedItem["facts"], state: string, a: Action) => {
    const ref = `${f.repo}#${f.number}`;
    if (seen.has(ref)) return;
    seen.add(ref);
    const refused = gates(f, wantOf(a), "pipeline");
    const blocked = !ctx.tracked.includes(f.repo) ? "outside the pipeline scope" : refused === "The pipeline is off" ? null : refused ?? await waits(f.repo);
    const fast = ((await fastOf(db, ctx)).get(ref) ?? 0) >= FAST_FLOOR;
    all.push({
      repo: f.repo, number: f.number, kind: "kind" in f ? f.kind : "pr", action: a.kind, bucket: typeof a.params?.bucket === "string" ? a.params.bucket : null,
      fast, rank: f.score, inFlight: inFlightNow(f, state), next: false, blocked,
      ...(typeof a.params?.decisionId === "string" ? { decisionId: a.params.decisionId } : {}),
    });
  };
  for (const k of kinds) {
    for (const p of await planned(db, k, { plans })) await add(p.facts, p.plan.state, p.action);
    for (const p of await plannedItems(db, k, { plans })) await add(p.facts, p.plan.state, p.action);
  }
  const repos: string[] = [];
  for (const c of await detectOf(db, ctx, lane)) { const r = repoOf(c); if (r && !repos.includes(r)) repos.push(r); }
  const picked = (i: LaneItem) => !lane.perRepo || repos.includes(i.repo);
  const first = lane.perRepo ? repos.flatMap((r) => all.filter((i) => i.repo === r)) : all;
  const rest = all.filter((i) => !first.includes(i));
  return [...first, ...rest].map((i) => ({ ...i, next: picked(i) && !i.blocked }));
}

const plain = (why: string): string => { const t = why.replace(/^(paused|tripped): /, ""); return t.charAt(0).toUpperCase() + t.slice(1); };

/** The most items of one lane the planner stores. */
const NEXT_PER_LANE = 500;
export type StoredLaneItems = Record<string, { total: number; items: LaneItem[] }>;

/** Writes each lane's items as this pass sees them: only the lanes that changed. The table belongs to the `plans` topic, which the planner does not take as input. */
async function storeLaneItems(db: Db, lanes: Lane[], ctx: PlanCtx): Promise<void> {
  const old = new Map((await db.all(db.k.selectFrom("lane_next").select(["lane", "total", "items"]))).map((r) => [r.lane, r]));
  const at = new Date().toISOString();
  for (const lane of lanes) {
    const all = await laneItems(db, ctx, lane);
    const prev = old.get(lane.name);
    old.delete(lane.name);
    if (!all.length) { if (prev) await db.run(db.k.deleteFrom("lane_next").where("lane", "=", lane.name)); continue; }
    const items = JSON.stringify(all.slice(0, NEXT_PER_LANE));
    if (!prev || prev.total !== all.length || prev.items !== items) await db.run(db.k.insertInto("lane_next").values({ lane: lane.name, total: all.length, items, at }).onConflict((oc) => oc.column("lane").doUpdateSet(kx.excluded(["total", "items", "at"]))));
  }
  for (const lane of old.keys()) await db.run(db.k.deleteFrom("lane_next").where("lane", "=", lane));
}

/** The lane lists of the planner's last pass, keyed by lane name. */
export async function storedLaneItems(db: Db): Promise<StoredLaneItems> {
  const out: StoredLaneItems = {};
  for (const r of await db.all(db.k.selectFrom("lane_next").select(["lane", "total", "items"]))) out[r.lane] = { total: r.total, items: JSON.parse(r.items) as LaneItem[] };
  return out;
}

/** The lanes that carry out the write of an answered decision: close and comment, merge, label, fix-up and implementation. */
const HELD_LANES = ["act", "merge", "labels", "fixup", "implement"];

export type Held = { reason: string; approval: boolean };
/** Reads the stored lane lists once; call it once per request and ask per decision. */
export async function heldLookup(db: Db): Promise<(repo: string, number: number, decisionId?: string) => Promise<Held | null>> {
  const rows = new Map((await db.all(db.k.selectFrom("lane_next").select(["lane", "total", "items"]).where("lane", "in", HELD_LANES))).map((r) => [r.lane, r]));
  const parsed = new Map<string, LaneItem[]>();
  const gateOf = new Map<string, Held | null>();
  const laneHold = async (name: string): Promise<Held | null> => {
    if (!gateOf.has(name)) {
      const lane = LANES.find((l) => l.name === name);
      const g = lane ? await laneGate(db, lane, new Map(STEPS.map((x) => [x.name, x]))) : null;
      gateOf.set(name, g && !g.canRun && g.kind !== "running" && g.why ? { reason: plain(g.why), approval: false } : null);
    }
    return gateOf.get(name)!;
  };
  return async (repo, number, decisionId) => {
    for (const [name, row] of rows) {
      if (!parsed.has(name)) parsed.set(name, JSON.parse(row.items) as LaneItem[]);
      const items = parsed.get(name)!;
      const item = items.find((i) => i.repo === repo && i.number === number && (!i.decisionId || !decisionId || i.decisionId === decisionId));
      if (item) {
        if (item.blocked) return { reason: plain(item.blocked), approval: /not approved$/.test(item.blocked) };
        return await laneHold(name);
      }
      // The stored list is capped: an item beyond it is judged by the lane's own gate alone.
      if (row.total > items.length && name === "act") { const h = await laneHold(name); if (h) return h; }
    }
    return null;
  };
}

/**
 * Why no Act job will run for `repo` now, or null: the pipeline is off or draining, off for the repo, or Act's daily limit is 0. Act writes
 * no commit, so no push breaker stops it.
 * A reached daily limit is not a block: queued presses wait for it. Presses that cannot be carried out are refused with this reason instead of queued.
 */
export async function actBlockedReason(db: Db, repo: string): Promise<string | null> {
  if (!await isEnabled(db)) return await isDraining(db) ? "the pipeline is draining" : "the pipeline is off";
  if (!(await scopeRepos(db)).has(repo)) return `the pipeline is off for ${repo}`;
  if ((await limitRow(db, "act")).per_day === 0) return "the daily limit of Act is 0";
  return null;
}

export type LaneGate = { canRun: boolean; kind: "ok" | "running" | "off" | "breaker" | "limit" | "account" | "backoff"; why: string | null };

/** Whether a job of the lane can start now, from the same checks the planner's gate() makes. */
export async function laneGate(db: Db, lane: Pick<Lane, "steps">, allSteps: Map<string, StepDef>, ms: number = Date.now()): Promise<LaneGate> {
  if (!await isEnabled(db)) return { canRun: false, kind: "off", why: await isDraining(db) ? "The pipeline is draining" : "The pipeline is off" };
  const steps = lane.steps ?? [];
  let blocked: LaneGate | null = null;
  for (const s of steps) {
    // Blocked only when no repo can start: the step already works its most repos.
    const full = await jobBlock(db, allSteps, { step: s, repo: null }, { precheck: true });
    if (full) { blocked ??= { canRun: false, kind: "running", why: full.replace(/ \(step_parallel\)$/, "") }; continue; }
    const why = await pauseReason(db, s, ms);
    if (!why) return { canRun: true, kind: "ok", why: null };
    const kind = /^tripped/.test(why) ? "breaker" : /daily limit/.test(why) ? "limit" : /^failed/.test(why) ? "backoff" : "account";
    blocked ??= { canRun: false, kind, why: plain(why) };
  }
  return blocked ?? { canRun: true, kind: "ok", why: null };
}
