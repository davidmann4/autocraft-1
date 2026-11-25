// The Now page: what is wrong, what is running and what just happened, in one read.
// Every query leaves out repos the viewer cannot see, as the pipeline, agents and build endpoints do.
import type { ItemRef, ItemShown, Now, NowEntry, NowFeed, NowHealth, NowProblem } from "../../../web/src/api/types.ts";
import { privateStepExpr } from "../../build/tasks.ts";
import { accountListOrNull } from "../../agents/account-actions.ts";
import { jevEnabled, jevOutage } from "../../agents/jev.ts";
import { GITHUB_ACTIONS } from "../../github/actions.ts";
import { mainCiRepos } from "../../mainci/index.ts";
import { pipelineRepos } from "../../pilot.ts";
import { quietFixPrs } from "../../security/quiet.ts";
import { pipelineSwitch, zeroLimits } from "./limits.ts";
import { computeChecks } from "../../health-checks.ts";
import type { Req } from "../types.ts";
import { clip, stepTitle, writeEvent } from "./trace.ts";
import { tripOf } from "../../core/push-outcome.ts";
import { shownLater } from "./shown.ts";
import { canSeeInternals } from "./staff.ts";
import { t } from "../../i18n/index.ts";
import { blankIfHidden, hiddenRepos } from "./visible.ts";
import { filtered, hiddenTestExpr, isHiddenRepo, type HiddenRepos } from "../../hidden-sql.ts";
import { touchesHiddenExpr } from "../../agents/runs.ts";
import type { Db } from "../../db/index.ts";
import type { NotNull } from "kysely";
import * as kx from "../../db/kx.ts";

const RECENT = 15;
type Feed = { entries: NowEntry[]; also: string[]; nextCursor: string | null };
const PER_KIND = 5;
const HOUR_MS = 3_600_000;
/** Jobs that never work on items; they show only in the "Also running" line. */
export const QUIET_STEPS = new Set(["rank", "embed", "checks", "main-ci", "labels-ensure", "review-carry", "verify-collect", "fixissue-collect"]);
/** Writes that are bookkeeping, not something an operator follows. */
const HOUSEKEEPING = new Set(["assign", "unassign", "labels-apply", "label-create", "ci-run-approve", "ci-rerun", "fork-create", "fixissue-claim", "fixissue-unclaim"]);
/** One group of same-action writes by the same actor; a gap longer than this starts a new run of them. */
const GROUP_GAP_MS = 15 * 60_000;
/** Items listed per entry; the entry's `itemCount` is the true total. */
const ITEM_CAP = 200;
const GROUPED: Record<string, (n: number) => string> = {
  "Posted review": (n) => `Posted ${n} reviews`, "Edited review": (n) => `Edited ${n} reviews`, "Commented": (n) => `Commented on ${n} items`,
  "Edited comment": (n) => `Edited ${n} comments`, "Closed": (n) => `Closed ${n} items`, "Closed PR": (n) => `Closed ${n} PRs`, "Pushed": (n) => `Pushed to ${n} PRs`,
  "Opened PR": (n) => `Opened ${n} PRs`, "Opened issue": (n) => `Opened ${n} issues`,
};

type Item = ItemRef & ItemShown;
const minutes = (ms: number): string => (ms < 90 * 60_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : `${Math.round(ms / HOUR_MS)} h`);
/** `col` is not hidden (or is NULL when `nullOk`); used under `$if(filtered(hidden), ...)`. */
const notHidden = (db: Db, eb: kx.Eb, col: string, hidden: HiddenRepos, nullOk = false) =>
  nullOk ? eb.or([eb(kx.ref(col), "is", null), eb.not(hiddenTestExpr(db, col, hidden))]) : eb.not(hiddenTestExpr(db, col, hidden));

const groupBy = <T, K>(rows: T[], key: (r: T) => K): Map<K, T[]> => {
  const out = new Map<K, T[]>();
  for (const r of rows) (out.get(key(r)) ?? out.set(key(r), []).get(key(r))!).push(r);
  return out;
};
/** The first `per` items of each run, by repo and number. */
const runItems = async (db: Db, ids: number[], per: number): Promise<Map<number, { repo: string; number: number }[]>> =>
  groupBy(ids.length ? await db.all(db.k.selectFrom((eb) => eb.selectFrom("agent_run_items")
    .select((e) => ["run_id", "repo", "number", e.fn.agg<number>("row_number", []).over((o) => o.partitionBy("run_id").orderBy("repo").orderBy("number")).as("k")])
    .where(kx.inList(db, "run_id", ids, "bigint")).as("m"))
    .select(["m.run_id", "m.repo", "m.number"]).where("m.k", "<=", per).orderBy("m.run_id").orderBy("m.repo").orderBy("m.number")) : [], (r) => r.run_id);
/** The PR numbers of each merge batch, in batch order. */
const batchPrs = async (db: Db, ids: number[]): Promise<Map<number, { number: number }[]>> =>
  groupBy(ids.length ? await db.all(db.k.selectFrom("merge_batch_prs").select(["batch_id", "number"]).where(kx.inList(db, "batch_id", [...new Set(ids)], "bigint")).orderBy("batch_id").orderBy("position")) : [], (r) => r.batch_id);
/** Merge batch ids by repo and branch, joined by a NUL. */
async function batchIdsOf(db: Db, keys: [string, string][]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!keys.length) return out;
  for (const r of await db.all(db.k.selectFrom("main.merge_batches").select(["id", "repo", "branch"]).where(kx.tupleIn(db, ["repo", "branch"], keys, ["text", "text"])).orderBy("id")))
    if (!out.has(`${r.repo}\0${r.branch}`)) out.set(`${r.repo}\0${r.branch}`, r.id);
  return out;
}

/** What a job of the implement step does, by its bucket (src/implement/types.ts IMPLEMENT_BUCKETS). */
const IMPLEMENT_TITLE: Record<string, string> = { plan: "Implement: plan", build: "Implement: write and check", revise: "Implement: revise the PR" };
const paramsOf = (j: { params: string | null }): Record<string, unknown> => {
  try { const v = JSON.parse(j.params ?? "{}") as unknown; return v && typeof v === "object" ? v as Record<string, unknown> : {}; } catch { return {}; }
};
const jobTitle = (j: { step: string; params: string | null }): string => (j.step === "implement" ? IMPLEMENT_TITLE[String(paramsOf(j).bucket ?? "plan")] ?? stepTitle(j.step) : stepTitle(j.step));
/** The issue of an implement job, from its parameters: the job records it as a job item only when it ends. */
const paramItem = (j: { step: string; repo: string | null; params: string | null }): { repo: string; number: number } | null => {
  if (j.step !== "implement" || !j.repo) return null;
  const n = Number(paramsOf(j).number);
  return Number.isSafeInteger(n) && n > 0 ? { repo: j.repo, number: n } : null;
};

// ---- health ------------------------------------------------------------------

/** The health checks that are not ok, as the warnings list shows them; viewers get the short text and no checks of repos they cannot see. */
export async function checkProblems(db: Db, hidden: HiddenRepos, internals: boolean, nowMs: number): Promise<NowProblem[]> {
  const area = (id: string): NowProblem["area"] =>
    id === "runner" ? "runner" : id.startsWith("deadline:") ? "deadline" : id === "liveness" ? "liveness" : id.startsWith("worker:") || id === "build-queue" ? "workers" : id === "accounts" || id === "user-tokens" ? "account" : "sync";
  return (await computeChecks(db, nowMs))
    .filter((c) => c.state !== "ok" && !(c.repo !== undefined && isHiddenRepo(hidden, c.repo)))
    .map((c) => ({ id: c.id, area: area(c.id), tone: c.state === "fail" ? "bad" : "warn", text: internals ? c.text : c.brief, to: c.to, since: c.since, ...(c.ackStep ? { ackStep: c.ackStep } : {}), ...(c.ack ? { ack: c.ack } : {}) }));
}

export async function healthOf(db: Db, hidden: HiddenRepos, internals: boolean, nowMs: number): Promise<NowHealth> {
  const since = new Date(nowMs - HOUR_MS).toISOString();
  // Repos with the pipeline off are off by design; their red mains stay on the Main CI page.
  const onRead = pipelineRepos(db);
  // Every source reads on its own, so they run together; the problems keep this order.
  const [state, on, checks, trips, zero, accounts, outage, ci, failed] = await Promise.all([
    pipelineSwitch(db), onRead, checkProblems(db, hidden, internals, nowMs),
    db.all(db.k.selectFrom("stage_trips").select(["stage", "reason", "tripped_at"]).where("active", "=", 1).orderBy("tripped_at")),
    zeroLimits(db), accountListOrNull(db),
    (async () => (await jevEnabled(db) ? await jevOutage(db) : null))(),
    mainCiRepos(db, hidden),
    onRead.then((o) => db.all(db.k.selectFrom("jobs").select(["step", (eb) => eb.fn.countAll<number>().as("n")]).where("state", "=", "failed").where("ended_at", ">", since)
      .$if(filtered(hidden), (q) => q.where((eb) => notHidden(db, eb, "repo", hidden, true)))
      .where((eb) => eb.or([eb("repo", "is", null), kx.inList(db, "repo", [...o])]))
      .groupBy("step").orderBy("n", "desc").orderBy("step"))),
  ]);
  const out: NowProblem[] = [];
  const add = (p: NowProblem) => void out.push(p);

  if (!state.enabled) add({ id: "pipeline", area: "pipeline", tone: "warn", text: `Pipeline is ${state.draining ? "draining" : "off"}${state.changedBy ? `, switched ${state.draining ? "to drain" : "off"} by ${state.changedBy}` : ""}`, to: "/pipeline", since: state.changedAt });
  for (const p of checks) add(p);

  for (const t of trips) {
    // A push stage trips per repo or on every repo: the problem says which, and a trip on a hidden repo is left out.
    const k = tripOf(t.stage);
    if (k?.repo && isHiddenRepo(hidden, k.repo)) continue;
    const why = blankIfHidden(t.reason, hidden);
    add({ id: `breaker:${t.stage}`, area: "breaker", tone: "bad", text: `${stepTitle(k?.stage ?? t.stage)}${k ? (k.repo ? ` in ${k.repo}` : " on every repo") : ""} is stopped by its breaker${why ? `: ${clip(why, 120)}` : ""}`, to: "/pipeline", since: t.tripped_at });
  }
  for (const l of zero) add({ id: `limit:${l.step}`, area: "limit", tone: "warn", text: `${l.title} is paused (limit 0 a day)`, to: "/pipeline", since: null });

  for (const a of (accounts ?? []).filter((x) => x.enabled)) {
    if (a.auth.loggedIn === false) add({ id: `account:${a.id}`, area: "account", tone: "bad", text: `Account ${a.label} is signed out`, to: "/accounts", since: null });
    else if (a.pausedReason) add({ id: `account:${a.id}`, area: "account", tone: "warn", text: `Account ${a.label} is paused${blankIfHidden(a.pausedReason, hidden) ? `: ${clip(a.pausedReason, 100)}` : ""}`, to: "/accounts", since: null });
  }
  if (outage) add({ id: "jev", area: "jev", tone: "warn", text: `Jev is unavailable: ${clip(outage.reason, 100)}`, to: "/accounts", since: outage.since });

  for (const r of ci.filter((x) => x.state === "red" && on.has(x.repo))) {
    const names = r.failing.map((f) => f.name).slice(0, 2).join(", ");
    add({ id: `main-ci:${r.repo}`, area: "main-ci", tone: "bad", text: `Main is red in ${r.repo}${names ? `: ${names}` : ""}`, to: "/main-ci", since: r.redSince });
  }

  const nFailed = failed.reduce((a, f) => a + f.n, 0);
  if (nFailed) {
    const steps = failed.slice(0, 3).map((f) => stepTitle(f.step)).join(", ");
    add({ id: "jobs", area: "jobs", tone: "warn", text: `${nFailed} job${nFailed === 1 ? "" : "s"} failed in the last hour: ${steps}${failed.length > 3 ? " and more" : ""}`, to: "/pipeline", since: null });
  }

  return { pipeline: { enabled: state.enabled, by: state.changedBy, at: state.changedAt }, problems: out };
}

// ---- the feed ----------------------------------------------------------------
// One list of units of work, newest started first: a job on its items, a merge, a posted review, a decision, a failure. A job
// is the same entry while it runs and after it ends; the GitHub writes made on its items during its run attach to it.

/** Rows read from each source per page; a source that fills it bounds how far back the merged page is complete. */
const SCAN = 100;
const WRITE_SLACK_MS = 2 * 60_000;

/** Audit actions of a merge batch that are not GitHub writes on an item, with their labels. */
const BATCH_ACTIONS: Record<string, string> = { "batch-stop": "stopped", "batch-hold": "PR held", "batch-blame": "failure traced to a PR", "batch-rerun": "failed CI runs rerun", "batch-remove": "PR removed", "batch-merged-after-end": "merged after it ended" };
const BATCH_LABELS: Record<string, string> = { ...BATCH_ACTIONS, "batch-push": "pushed", "batch-pr": "pull request opened", "batch-pr-close": "PR closed" };

const refOf = (target: string | null): { repo: string; number: number } | null => {
  const m = /^(.+)#(\d+)$/.exec(target ?? "");
  return m ? { repo: m[1]!, number: Number(m[2]) } : null;
};

type Write = { at: string; action: string; label: string; item: Item; key: string; summary: string; login: string };
const lines = (ws: Write[]): { summary: string; items: Item[]; more: number }[] => {
  const by = new Map<string, Write[]>();
  for (const w of ws) (by.get(w.label) ?? by.set(w.label, []).get(w.label)!).push(w);
  return [...by].map(([label, list]) => {
    const distinct = [...new Map(list.map((w) => [`${w.item.repo}#${w.item.number}`, w.item])).values()];
    const verb = GROUPED[label];
    return { summary: list.length > 1 ? (verb ? verb(list.length) : `${label} ${list.length} times`) : list[0]!.summary, items: distinct.slice(0, ITEM_CAP), more: Math.max(0, distinct.length - ITEM_CAP) };
  });
};

async function feed(db: Db, hidden: HiddenRepos, staff: boolean, operator: boolean, before: string | null, nowMs: number): Promise<Feed> {
  // Item references get their kind, state and title in one read at the end.
  const shown = shownLater(db);
  const item = shown.item;
  let completeFrom = "";
  // A source that returned a full scan may hold older rows than it showed, so the page stops at the newest such bound.
  const bound = (rows: { at: string }[]) => {
    if (rows.length < SCAN) return;
    const oldest = rows.reduce((m, r) => (r.at < m ? r.at : m), rows[0]!.at);
    if (oldest > completeFrom) completeFrom = oldest;
  };
  const oldestOf = new Map<NowEntry, string>();
  const base = (e: Pick<NowEntry, "key" | "kind" | "state" | "at" | "title"> & Partial<NowEntry>): NowEntry => ({
    ids: [e.key], batchId: null, endedAt: null, repo: null, items: [], more: 0, what: null, summary: null, progress: null, actor: "AutoCraft", item: null, itemCount: 0, event: null, detail: null, writes: [], children: [], ...e,
  });
  const out: NowEntry[] = [];
  const also: string[] = [];

  // Writes: audit rows and merges that are not bookkeeping. Each goes to the job that worked on its item at that time, else it stands alone.
  const writes: Write[] = [];
  const actions = [...Object.keys(GITHUB_ACTIONS).filter((a) => a !== "merge" && !HOUSEKEEPING.has(a)), ...(staff ? Object.keys(BATCH_ACTIONS) : [])];
  // Events of a merge batch (details.batch, or a `repo:branch` target) show as one row per batch and action, linking to the batch page.
  const batchEvents = new Map<string, { id: number; repo: string; action: string; at: string; oldest: string; key: string }>();
  const jobCols = (eb: kx.Eb) => ["id", "step", "state", eb.fn.coalesce("started_at", "requested_at").as("at"), "ended_at", "progress", "summary", "error", "repo", "items", "acted", "params"] as const;
  // Every source reads on its own, so the reads run together; the rows are placed below in the order of the sources.
  const [audit, merges, running, finished, liveRuns, liveTasks, openBatches, decisions, runs, tasks] = await Promise.all([
    db.all(db.k.selectFrom("audit").select([kx.rowid("audit").as("rowid"), "at", "login", "action", "target", "details"]).where(kx.inList(db, "action", actions))
      .$if(!!before, (q) => q.where("at", "<", before!)).orderBy("at", "desc").orderBy(kx.rowid("audit"), "desc").limit(SCAN)),
    db.all(db.k.selectFrom("merges").select([kx.rowid("merges").as("rowid"), "repo", "number", "at", "path", "method"]).where("outcome", "=", "merged")
      .$if(filtered(hidden), (q) => q.where((eb) => notHidden(db, eb, "repo", hidden)))
      .$if(!!before, (q) => q.where("at", "<", before!)).orderBy("at", "desc").limit(SCAN)),
    // Jobs. Running ones always show on the first page; finished ones by start time.
    db.all(db.k.selectFrom("jobs").select((eb) => jobCols(eb)).where("state", "=", "running")
      .$if(filtered(hidden), (q) => q.where((eb) => notHidden(db, eb, "repo", hidden, true)))
      .$if(!!before, (q) => q.where((eb) => eb(eb.fn.coalesce("started_at", "requested_at"), "<", before!))).orderBy("id", "desc")),
    db.all(db.k.selectFrom("jobs").select((eb) => jobCols(eb)).where("state", "in", ["done", "failed"]).where("started_at", "is not", null)
      .$if(filtered(hidden), (q) => q.where((eb) => notHidden(db, eb, "repo", hidden, true)))
      .$if(!!before, (q) => q.where("started_at", "<", before!)).orderBy("started_at", "desc").limit(SCAN)),
    before ? [] : db.all(db.k.selectFrom("agent_runs as r").leftJoin("claude_accounts as a", "a.id", "r.account_id")
      .select((eb) => ["r.id", "r.job_id", "r.step", "r.model", "r.provider", eb.fn.coalesce("a.label", "r.account_id").as("label"), "r.started_at", "r.progress", "r.item_count", "r.user_login", "r.harness", "r.reported_model"])
      .where("r.state", "=", "running").$if(filtered(hidden), (q) => q.where((eb) => touchesHiddenExpr(db, eb, hidden))).orderBy("r.id")),
    before ? [] : db.all(db.k.selectFrom("build_tasks as t").leftJoin("build_envs as e", "e.id", "t.env_id")
      .select(["t.id", "t.job_id", "t.step", "t.repo", "t.number", "t.state", "t.queued_at", "t.started_at", "t.summary", "e.label"])
      .where("t.state", "in", ["queued", "claimed", "running"])
      .$if(filtered(hidden), (q) => q.where((eb) => notHidden(db, eb, "t.repo", hidden)))
      .$if(!staff, (q) => q.where((eb) => eb.not(privateStepExpr(eb, "t.step")))).orderBy("t.id")),
    before ? [] : db.all(db.k.selectFrom("merge_batches").select(["id", "repo", "branch", "state", "created_at", "summary"]).where("state", "in", ["checking", "open"])
      .$if(filtered(hidden), (q) => q.where((eb) => notHidden(db, eb, "repo", hidden))).orderBy("id", "desc")),
    db.all(db.k.selectFrom("decisions").select(["id", "repo", "number", "items", "question", "answer", "answered_at as at", "answered_by"]).$narrowType<{ at: NotNull }>().where("answered_at", "is not", null)
      .$if(!!before, (q) => q.where("answered_at", "<", before!)).orderBy("answered_at", "desc").limit(SCAN)),
    // Failed calls and tasks of a job show on the job; only those without one stand alone.
    db.all(db.k.selectFrom("agent_runs as r").select((eb) => ["r.id", "r.step", "r.model", eb.fn.coalesce("r.ended_at", "r.started_at").as("at"), "r.error"])
      .where("r.state", "=", "failed").where("r.job_id", "is", null).$if(filtered(hidden), (q) => q.where((eb) => touchesHiddenExpr(db, eb, hidden)))
      .$if(!!before, (q) => q.where((eb) => eb(eb.fn.coalesce("r.ended_at", "r.started_at"), "<", before!))).orderBy("at", "desc").limit(SCAN)),
    db.all(db.k.selectFrom("build_tasks").select((eb) => ["id", "step", "repo", "number", "state", eb.fn.coalesce("ended_at", "queued_at").as("at"), "summary"])
      .where("state", "in", ["failed", "lost"]).where("job_id", "is", null)
      .$if(!staff, (q) => q.where((eb) => eb.not(privateStepExpr(eb))))
      .$if(filtered(hidden), (q) => q.where((eb) => notHidden(db, eb, "repo", hidden)))
      .$if(!!before, (q) => q.where((eb) => eb(eb.fn.coalesce("ended_at", "queued_at"), "<", before!))).orderBy("at", "desc").limit(SCAN)),
  ]);
  bound(audit);
  const parsed = audit.map((a) => {
    let branch: string | null = null;
    try { const b = (JSON.parse(a.details ?? "{}") as { batch?: unknown }).batch; if (typeof b === "string") branch = b; } catch { /* no batch */ }
    const t = /^(.+):([^#:]+)$/.exec(a.target ?? "");
    const ref = refOf(a.target);
    const repo = ref?.repo ?? t?.[1] ?? null;
    if (t && !ref) branch = t[2]!;
    return { a, ref, repo, branch };
  });
  const listed = [...running, ...finished].filter((j) => !(QUIET_STEPS.has(j.step) && j.state !== "failed"));
  const [batchIds, jobItems, itemsOfRun, prsOfOpen, quietPrs, firstOfRun] = await Promise.all([
    batchIdsOf(db, parsed.flatMap((p) => (p.repo && p.branch ? [[p.repo, p.branch] as [string, string]] : []))),
    listed.length ? db.all(db.k.selectFrom("job_items").select(["job_id", "id", "repo", "number"]).where(kx.inList(db, "job_id", listed.map((j) => j.id), "bigint"))
      .$if(filtered(hidden), (q) => q.where((eb) => notHidden(db, eb, "repo", hidden))).orderBy("id")) : [],
    before ? new Map<number, { repo: string; number: number }[]>() : runItems(db, liveRuns.map((r) => r.id), PER_KIND),
    before ? new Map<number, { number: number }[]>() : batchPrs(db, openBatches.map((b) => b.id)),
    decisions.length ? quietFixPrs(db) : new Set<string>(),
    runItems(db, runs.map((r) => r.id), 1),
  ]);
  for (const { a, ref, repo, branch } of parsed) {
    const bid = repo && branch ? batchIds.get(`${repo}\0${branch}`) : undefined;
    if (repo && isHiddenRepo(hidden, repo)) continue;
    if (bid !== undefined && repo) {
      const k = `${bid}:${a.action}`;
      const cur = batchEvents.get(k);
      if (cur) cur.oldest = a.at < cur.oldest ? a.at : cur.oldest;
      else batchEvents.set(k, { id: bid, repo, action: a.action, at: a.at, oldest: a.at, key: `batch-event:${bid}:${a.action}:${a.rowid}` });
      continue;
    }
    if (!ref || a.action in BATCH_ACTIONS) continue;
    const e = writeEvent(a, staff);
    writes.push({ at: a.at, action: a.action, label: GITHUB_ACTIONS[a.action]!, item: item(ref.repo, ref.number), key: e.id, summary: e.summary, login: a.login });
  }
  bound(merges);
  for (const m of merges) {
    writes.push({ at: m.at, action: "merge", label: "Merged", item: item(m.repo, m.number), key: `merge:${m.rowid}`, login: "AutoCraft",
      summary: `Merged${m.method ? ` (${m.method})` : ""}${m.path === "operator" ? " after an answered decision" : " by rule"}` });
  }
  writes.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.key < b.key ? 1 : -1));

  bound(finished);
  const jobEntries = new Map<number, { entry: NowEntry; its: Set<string>; from: number; to: number }>();
  const itemsOfJob = groupBy(jobItems, (r) => r.job_id);
  for (const j of [...running, ...finished]) {
    const live = j.state === "running";
    if (QUIET_STEPS.has(j.step) && j.state !== "failed") {
      if (live && !also.includes(stepTitle(j.step))) also.push(stepTitle(j.step));
      continue;
    }
    const its = itemsOfJob.get(j.id) ?? [];
    const one = its.length ? null : paramItem(j);
    const idle = !its.length && !one && !j.items && !j.acted;
    const e = base({
      key: `job:${j.id}`, kind: "job", state: live ? "running" : j.state === "failed" ? "failed" : "done", at: j.at, endedAt: j.ended_at, title: jobTitle(j),
      // A job without a repo works across repos: its texts name no item of a repo hidden from the reader.
      summary: live ? null : j.state === "failed" ? (staff && j.error ? clip(blankIfHidden(j.error, hidden) || "failed", 100) : null) : blankIfHidden(j.summary, hidden) || null,
      progress: live ? blankIfHidden(j.progress, hidden) || null : null,
      item: its[0] ? item(its[0].repo, its[0].number) : one ? item(one.repo, one.number) : null, items: its.length ? its.slice(0, ITEM_CAP).map((i) => item(i.repo, i.number)) : one ? [item(one.repo, one.number)] : [],
      itemCount: its.length || (one ? 1 : 0), repo: j.repo, event: its[0] ? `job:${its[0].id}` : null, detail: `/pipeline/${j.id}`,
    });
    if (!live && idle && j.state !== "failed") continue;
    jobEntries.set(j.id, { entry: e, its: new Set(its.map((i) => `${i.repo}#${i.number}`)), from: Date.parse(j.at), to: live ? nowMs : Date.parse(j.ended_at ?? j.at) });
    out.push(e);
  }

  const placeChild = (jobId: number | null, e: NowEntry) => {
    const parent = jobId === null ? undefined : jobEntries.get(jobId);
    if (parent && parent.entry.state === "running") parent.entry.children.push(e);
    else if (jobId === null || !parent) out.push(e);
  };
  // Calls and build tasks nest under a running job; those without a job stand alone.
  if (!before) {
    for (const r of liveRuns) {
      const its = itemsOfRun.get(r.id) ?? [];
      placeChild(r.job_id, base({
        key: `run:${r.id}`, kind: "call", state: "running", at: r.started_at, title: stepTitle(r.step), what: r.provider === "jev" ? "Jev" : r.user_login ? r.model : operator ? `${r.model} on ${r.label ?? "an unknown account"}` : r.model, progress: blankIfHidden(r.progress, hidden) || null,
        item: its[0] ? item(its[0].repo, its[0].number) : null, items: its.map((i) => item(i.repo, i.number)), itemCount: Math.max(r.item_count, its.length), event: its[0] ? `run:${r.id}` : null, detail: `/agents/${r.id}`,
        ...(staff && r.user_login && { via: { login: r.user_login, harness: r.harness ?? "", model: r.reported_model ?? "" } }),
      }));
    }
    for (const t of liveTasks) {
      const one = t.number === null ? null : item(t.repo, t.number);
      placeChild(t.job_id, base({
        key: `task:${t.id}`, kind: "task", state: t.state === "queued" ? "queued" : "running", at: t.started_at ?? t.queued_at, title: `Build task, ${stepTitle(t.step)}`, what: t.label, progress: t.summary,
        item: one, items: one ? [one] : [], itemCount: one ? 1 : 0, event: one ? `task:${t.id}` : null, detail: `/envs/${t.id}`,
      }));
    }
    for (const b of openBatches) {
      const prs = prsOfOpen.get(b.id) ?? [];
      out.push(base({
        key: `batch:${b.id}`, kind: "batch", state: b.state === "checking" ? "running" : "queued", at: b.created_at, title: "Integration batch", what: b.branch, progress: b.summary,
        item: prs[0] ? item(b.repo, prs[0].number) : null, items: prs.slice(0, ITEM_CAP).map((p) => item(b.repo, p.number)), itemCount: prs.length, repo: b.repo, batchId: b.id, detail: "/queue/merge",
      }));
    }
  }

  // Writes onto jobs, the rest as rows of their own: consecutive writes of one action by one actor become one row.
  const loose: Write[] = [];
  const attached = new Map<NowEntry, Write[]>();
  for (const w of writes) {
    const t = Date.parse(w.at);
    const key = `${w.item.repo}#${w.item.number}`;
    const owner = [...jobEntries.values()].find((j) => j.its.has(key) && t >= j.from - WRITE_SLACK_MS && t <= j.to + WRITE_SLACK_MS);
    if (owner) {
      owner.entry.ids.push(w.key);
      (attached.get(owner.entry) ?? attached.set(owner.entry, []).get(owner.entry)!).push(w);
    } else loose.push(w);
  }
  for (const [e, ws] of attached) e.writes = lines(ws);
  let g: { w: Write; list: Write[]; last: number } | null = null;
  const groups: { w: Write; list: Write[] }[] = [];
  for (const w of loose) {
    const t = Date.parse(w.at);
    if (g && g.w.action === w.action && g.w.login === w.login && g.last - t <= GROUP_GAP_MS) { g.list.push(w); g.last = t; }
    else { g = { w, list: [w], last: t }; groups.push(g); }
  }
  for (const grp of groups) {
    const w = grp.w;
    const e = base({
      key: w.key, ids: grp.list.map((x) => x.key), kind: grp.list.length > 1 || w.action !== "merge" ? "write" : "merge", state: "done", at: w.at, title: lines(grp.list)[0]!.summary,
      actor: w.login === "AutoCraft" || w.action === "merge" ? "AutoCraft" : staff ? w.login : "AutoCraft", item: w.item, items: [w.item], itemCount: 1, event: w.key,
    });
    if (grp.list.length > 1) { const l = lines(grp.list)[0]!; e.items = l.items; e.more = l.more; e.itemCount = l.items.length + l.more; }
    oldestOf.set(e, grp.list[grp.list.length - 1]!.at);
    out.push(e);
  }

  const prsOfEvent = await batchPrs(db, [...batchEvents.values()].map((ev) => ev.id));
  for (const ev of batchEvents.values()) {
    const prs = prsOfEvent.get(ev.id) ?? [];
    const e = base({
      key: ev.key, kind: "batch", state: "done", at: ev.at, repo: ev.repo, batchId: ev.id, actor: "AutoCraft",
      title: `Merge batch #${ev.id}: ${prs.length} PR${prs.length === 1 ? "" : "s"}, ${BATCH_LABELS[ev.action] ?? ev.action}`,
      item: prs[0] ? item(ev.repo, prs[0].number) : null, items: prs.slice(0, ITEM_CAP).map((p) => item(ev.repo, p.number)), itemCount: prs.length,
    });
    oldestOf.set(e, ev.oldest);
    out.push(e);
  }

  bound(decisions);
  const isQuiet = (repo: string, number: number): boolean => quietPrs.has(`${repo}#${number}`);
  for (const d of decisions) {
    let ref: { repo: string; number: number } | null = d.repo && d.number !== null ? { repo: d.repo, number: d.number } : null;
    let repos = d.repo ? [d.repo] : [];
    // The question of a quiet pull request's decision is model-written text about an unpublished fix.
    let quiet = !!ref && isQuiet(ref.repo, ref.number);
    if (!ref) {
      try {
        const list = (JSON.parse(d.items ?? "[]") as { repo?: unknown; number?: unknown }[]).filter((i): i is { repo: string; number: number } => typeof i.repo === "string" && typeof i.number === "number");
        repos = [...repos, ...list.map((i) => i.repo)];
        ref = list[0] ?? null;
        quiet = list.some((i) => isQuiet(i.repo, i.number));
      } catch { /* malformed: no item */ }
    }
    if (repos.some((r) => isHiddenRepo(hidden, r))) continue;
    out.push(base({
      key: `decision:${d.id}`, kind: "decision", state: "done", at: d.at, repo: d.repo ?? ref?.repo ?? null, title: `Answered ${quiet && !staff ? "a question" : `"${clip(d.question, 80)}"`}: ${d.answer ?? ""}`, actor: d.answered_by || "unknown",
      item: ref && item(ref.repo, ref.number), items: ref ? [item(ref.repo, ref.number)] : [], itemCount: ref ? 1 : 0, event: d.number !== null && d.repo ? `decision:${d.id}:answered` : null, detail: `/decisions/${encodeURIComponent(d.id)}`,
    }));
  }

  bound(runs);
  for (const r of runs) {
    const i = firstOfRun.get(r.id)?.[0];
    out.push(base({ key: `failed-run:${r.id}`, kind: "failure", state: "failed", at: r.at, actor: r.model, item: i ? item(i.repo, i.number) : null, event: i ? `run:${r.id}` : null, detail: `/agents/${r.id}`,
      title: `${stepTitle(r.step)}: model call failed${r.error && staff ? `, ${clip(r.error, 100)}` : ""}` }));
  }
  bound(tasks);
  for (const t of tasks) {
    out.push(base({ key: `failed-task:${t.id}`, kind: "failure", state: "failed", at: t.at, repo: t.repo, item: t.number === null ? null : item(t.repo, t.number), event: t.number === null ? null : `task:${t.id}`, detail: `/envs/${t.id}`,
      title: `Build task (${stepTitle(t.step)}) ${t.state}${t.summary ? `: ${clip(t.summary, 100)}` : ""}` }));
  }

  // A job that has just started has nothing to show yet.
  const bare = (e: NowEntry) => e.kind === "job" && e.state === "running" && !e.itemCount && !e.progress && !e.children.length;
  const live = out.filter((e) => (e.state === "running" || e.state === "queued") && !bare(e));
  const rest = out.filter((e) => e.state !== "running" && e.state !== "queued" && e.at >= completeFrom).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.key < b.key ? 1 : -1)).slice(0, RECENT);
  const page = [...live, ...rest].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.key < b.key ? 1 : -1));
  // The next page starts before the oldest entry shown (all members of a group count), or before the bound when nothing is complete yet.
  const last = rest[rest.length - 1];
  const more = rest.length === RECENT || completeFrom !== "";
  await shown.fill();
  return { entries: page, also, nextCursor: more ? (last ? (oldestOf.get(last) ?? last.at) : completeFrom) : null };
}

/** One page of the feed older than `before`, for infinite scroll. */
export async function nowFeed(db: Db, req: Req): Promise<NowFeed> {
  const before = req.query.get("before");
  const { entries, nextCursor } = await feed(db, await hiddenRepos(db, req), canSeeInternals(req), req.user.role === "operator", before && !Number.isNaN(Date.parse(before)) ? before : null, Date.now());
  return { entries, nextCursor };
}

/** The signed-in person's own stored GitHub App token can no longer be refreshed, so merges and closes they approve cannot run as them. */
async function ownTokenProblem(db: Db, req: Req): Promise<NowProblem | null> {
  if (req.user.role === "viewer") return null;
  const row = await db.get(db.k.selectFrom("user_tokens").select("updated_at").where("login", "=", req.user.login).where("status", "=", "refresh-failed"));
  return row ? { id: "user-token:own", area: "account", tone: "bad", text: t("AutoCraft can no longer act as you on GitHub. Authorize again"), to: "/auth/authorize-app", fullPage: true, since: row.updated_at } : null;
}

export async function now(db: Db, req: Req): Promise<Now> {
  const hidden = await hiddenRepos(db, req);
  const nowMs = Date.now();
  const [f, health, own] = await Promise.all([feed(db, hidden, canSeeInternals(req), req.user.role === "operator", null, nowMs), healthOf(db, hidden, canSeeInternals(req), nowMs), ownTokenProblem(db, req)]);
  if (own) health.problems.unshift(own);
  return { health, alsoRunning: f.also, entries: f.entries, nextCursor: f.nextCursor };
}
