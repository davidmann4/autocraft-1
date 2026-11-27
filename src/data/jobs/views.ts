// Read models for dashboards, health and rates (M07 jobs).
import type { Expression } from "kysely";
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { namedKeys, type Ref } from "../keys.ts";
import { loadAuditMax } from "../control/audit.ts";
import { loadShown } from "../mirror/items.ts";
import { RUNNER_STOPPED } from "./fragments.ts";
import { loadLogTail } from "./logs.ts";
import { hasFilter, numberOf, repoVisible } from "./sql.ts";
import type { ActiveJob, DeadlineStop, FailedJob, HiddenRepos, ItemsByBucket, JobDetail, JobItemRow, JobRow, JobState, JobStamp, LiveBoard, RefKey, StageState, StepRun } from "./types.ts";

/** Bytes of a job log the detail page shows. */
export const LOG_TAIL_BYTES = 48 * 1024;
/** Finished runs per step the duration estimates read. */
const DURATION_SAMPLES = 60;
/** How many of the newest jobs the deadline stops look at. */
const STOP_WINDOW = 5000;

const isHidden = (h: HiddenRepos, repo: string): boolean => (h.visible ? !h.visible.includes(repo) : h.includes(repo));
const jobCols = (alias?: string) => kx.cols("jobs", alias) as never as ReturnType<typeof kx.cols<"jobs">>;
const refKey = (repo: string, number: number): RefKey => `${repo}#${number}`;
const pairsOf = (refs: Ref[]): [string, number][] => refs.map((r): [string, number] => [r.repo, r.number]);

/** Row, items and log tail in one wave; item states come from `mirror.loadShown` in the same wave. A job of a hidden repo is not found. */
export async function loadJobDetail(db: Db, id: number, o: { hidden?: HiddenRepos; logs: boolean }): Promise<JobDetail | null> {
  const q = queryDb(db);
  const [row, items, logTail, shown] = await db.together(() => Promise.all([
    q.get(q.k.selectFrom("jobs").select(jobCols()).$narrowType<{ state: JobState }>().where("id", "=", id)),
    q.all(q.k.selectFrom("job_items").select(["id", "job_id", "repo", "number", "outcome", "at"]).where("job_id", "=", id)
      .$if(hasFilter(o.hidden), (b) => b.where((eb) => repoVisible(db, eb, "repo", o.hidden!))).orderBy("id")),
    o.logs ? loadLogTail(db, id, LOG_TAIL_BYTES) : Promise.resolve(null),
    loadShown(db, namedKeys("jobs.itemsOfJob", { jobId: id })),
  ]));
  if (!row || (row.repo && o.hidden && isHidden(o.hidden, row.repo))) return null;
  const kept = new Set(items.map((i) => refKey(i.repo, i.number)));
  return { row, items, shown: new Map([...shown].filter(([k]) => kept.has(k))), logTail };
}

/**
 * Running, queued (the first `queuedMax`) and recently ended jobs with their items; one round trip. Steps in `quietSteps`
 * show only when they failed. Up to `recentMax * 3` ended jobs come back: the caller drops those without items (a failed one
 * stays) and keeps `recentMax`.
 */
export async function loadLiveBoard(db: Db, o: { quietSteps: string[]; recentMs: number; queuedMax: number; recentMax: number; hidden?: HiddenRepos }): Promise<LiveBoard> {
  const q = queryDb(db);
  const since = new Date(Date.now() - o.recentMs).toISOString();
  const visible = (b: any) => (hasFilter(o.hidden) ? b.where((eb: kx.AnyEb) => repoVisible(db, eb, "repo", o.hidden!)) : b);
  const shown = () => q.k.selectFrom("jobs").select(jobCols()).$narrowType<{ state: JobState }>()
    .where((eb) => eb.or([eb("state", "=", "failed"), eb("step", "not in", o.quietSteps.length ? o.quietSteps : [""])]));
  const runningQ = () => visible(shown().where("state", "=", "running")).orderBy("id");
  const queuedQ = () => visible(shown().where("state", "=", "queued")).orderBy("id").limit(o.queuedMax);
  const recentQ = () => visible(shown().where("state", "in", ["done", "failed"]).where("ended_at", ">", since).where("started_at", "is not", null)).orderBy("ended_at", "desc").limit(o.recentMax * 3);
  const ids = (build: () => any) => (build() as ReturnType<typeof shown>).clearSelect().select("id");
  const [running, queued, recent, itemRows] = await db.together(() => Promise.all([
    q.all(runningQ() as ReturnType<typeof shown>), q.all(queuedQ() as ReturnType<typeof shown>), q.all(recentQ() as ReturnType<typeof shown>),
    q.all(q.k.selectFrom("job_items").select(["id", "job_id", "repo", "number", "outcome", "at"])
      .where("job_id", "in", q.k.selectFrom(ids(runningQ).as("a")).select("a.id").unionAll(q.k.selectFrom(ids(queuedQ).as("b")).select("b.id")).unionAll(q.k.selectFrom(ids(recentQ).as("c")).select("c.id")))
      .$if(hasFilter(o.hidden), (b) => b.where((eb) => repoVisible(db, eb, "repo", o.hidden!))).orderBy("id")),
  ]));
  const items = new Map<number, JobItemRow[]>();
  for (const r of itemRows) { const l = items.get(r.job_id); if (l) l.push(r); else items.set(r.job_id, [r]); }
  return { running, queued, recent, items };
}

/**
 * Jobs `n` from the newest one of `step` on, in descending order of the index on (step, id): with a limit it stops there, where an equality on the step
 * lets Postgres walk all jobs by id to find a step that has few. The rows of earlier steps follow; the caller keeps `step`'s own.
 */
const newestOfStep = (db: Db, step: Expression<string>) =>
  queryDb(db).k.selectFrom("jobs as n").select(["n.id", "n.step"]).where((eb) => eb(eb.refTuple("n.step", "n.id"), "<=", eb.tuple(step, eb.lit(Number.MAX_SAFE_INTEGER)) as never))
    .orderBy("n.step", "desc").orderBy("n.id", "desc");

/** Recent run durations (ms) per step, newest first: the last 60 done jobs of each step. */
export async function loadStepDurations(db: Db, steps: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (!steps.length) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom(kx.jsonEach(db, kx.json([...new Set(steps)]), "s")).select((eb) => ["s.value as step",
    kx.jsonRows(db, q.k.selectFrom(newestOfStep(db, eb.ref("s.value")).select(["n.started_at", "n.ended_at"]).where("n.state", "=", "done")
      .where("n.started_at", "is not", null).where("n.ended_at", "is not", null).limit(DURATION_SAMPLES).as("t")).select(["t.started_at", "t.ended_at"])
      .where("t.step", "=", eb.ref("s.value")).orderBy("t.id", "desc")).as("runs")]));
  for (const r of rows) {
    const runs = kx.parseJsonRows<{ started_at: string; ended_at: string }>(r.runs).map((x) => Date.parse(x.ended_at) - Date.parse(x.started_at));
    if (runs.length) out.set(r.step, runs);
  }
  return out;
}

/** The newest job of each step (a hidden repo's jobs left out). */
export async function loadLastJobPerStep(db: Db, steps: string[], hidden?: HiddenRepos): Promise<Map<string, JobRow>> {
  const out = new Map<string, JobRow>();
  if (!steps.length) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom(kx.jsonEach(db, kx.json([...new Set(steps)]), "s")).innerJoin("jobs as j", (b) => b.onRef("j.step", "=", "s.value").on("j.id", "=", (eb: any) =>
    newestOfStep(db, eb.ref("s.value")).clearSelect().select("n.id").$if(hasFilter(hidden), (x) => x.where((e) => repoVisible(db, e, "n.repo", hidden!))).limit(1)))
    .select(jobCols("j")));
  for (const r of rows) out.set(r.step, r as unknown as JobRow);
  return out;
}

/** Per stage: any running, any queued, else the state of the newest finished job of its steps; two statements in one wave. */
export async function loadStageStates(db: Db, stages: { n: number; steps: string[] }[]): Promise<Map<number, StageState>> {
  const out = new Map<number, StageState>();
  const steps = [...new Set(stages.flatMap((s) => s.steps))];
  if (!steps.length) { for (const s of stages) out.set(s.n, "idle"); return out; }
  const q = queryDb(db);
  const [active, last] = await db.together(() => Promise.all([
    q.all(q.k.selectFrom("jobs").select((eb) => ["step", eb.fn.max<number>(eb.case().when("state", "=", "running").then(eb.lit(1)).else(eb.lit(0)).end()).as("running")])
      .where(kx.inList(db, "step", steps)).where("state", "in", ["running", "queued"]).groupBy("step")),
    q.all(q.k.selectFrom(kx.jsonEach(db, kx.json(steps), "s")).innerJoin("jobs as j", (b) => b.onRef("j.step", "=", "s.value").on("j.id", "=", (eb: any) =>
      newestOfStep(db, eb.ref("s.value")).clearSelect().select("n.id").where("n.state", "in", ["done", "failed"]).limit(1)))
      .select(["j.id", "j.step", "j.state"])),
  ]));
  const running = new Map(active.map((r) => [r.step, Number(r.running) === 1]));
  for (const s of stages) {
    const mine = s.steps;
    if (mine.some((n) => running.get(n) === true)) { out.set(s.n, "running"); continue; }
    if (mine.some((n) => running.has(n))) { out.set(s.n, "queued"); continue; }
    const newest = last.filter((r) => mine.includes(r.step)).sort((a, b) => b.id - a.id)[0];
    out.set(s.n, newest?.state === "done" ? "ok" : newest?.state === "failed" ? "failed" : "idle");
  }
  return out;
}

/** Grouped counts; every asked state is present (0 when none). */
export async function countJobs(db: Db, states: JobState[], hidden?: HiddenRepos): Promise<Map<JobState, number>> {
  const out = new Map<JobState, number>(states.map((s) => [s, 0]));
  if (!states.length) return out;
  const q = queryDb(db);
  for (const r of await q.all(q.k.selectFrom("jobs").select((eb) => ["state", eb.fn.countAll<number>().as("n")]).where("state", "in", states)
    .$if(hasFilter(hidden), (b) => b.where((eb) => repoVisible(db, eb, "repo", hidden!))).groupBy("state"))) out.set(r.state as JobState, Number(r.n));
  return out;
}

/** Queued or running jobs naming each item (`params.number` and the job's repo), oldest first. */
export async function loadActiveJobsOfItems(db: Db, refs: Ref[]): Promise<Map<RefKey, ActiveJob[]>> {
  const out = new Map<RefKey, ActiveJob[]>();
  if (!refs.length) return out;
  const q = queryDb(db);
  for (const part of kx.chunks(refs)) {
    const rows = await q.all(q.k.selectFrom("jobs as j")
      .innerJoin(kx.refPairs(db, pairsOf(part), "rp"), (jn) => jn.onRef("rp.repo", "=", "j.repo").on((eb) => eb("rp.number", "=", numberOf(db, "j.params"))))
      .select(["j.repo", numberOf(db, "j.params").as("number"), "j.id", "j.step", "j.state", "j.requested_by", "j.started_at"]).$narrowType<{ state: JobState }>()
      .where("j.state", "in", ["queued", "running"]).orderBy("j.id"));
    for (const r of rows) {
      const key = refKey(r.repo!, Number(r.number)), row: ActiveJob = { id: r.id, step: r.step, state: r.state, requested_by: r.requested_by, started_at: r.started_at };
      const l = out.get(key);
      if (l) l.push(row); else out.set(key, [row]);
    }
  }
  return out;
}

/** Jobs that failed after `since` naming the item and wrote no `job_items` row for it (they crashed first). */
export async function loadFailedJobsOfItems(db: Db, refs: Ref[], since: string): Promise<Map<RefKey, FailedJob[]>> {
  const out = new Map<RefKey, FailedJob[]>();
  if (!refs.length) return out;
  const q = queryDb(db);
  for (const part of kx.chunks(refs)) {
    const rows = await q.all(q.k.selectFrom("jobs as j")
      .innerJoin(kx.refPairs(db, pairsOf(part), "rp"), (jn) => jn.onRef("rp.repo", "=", "j.repo").on((eb) => eb("rp.number", "=", numberOf(db, "j.params"))))
      .select(["j.repo", "rp.number as number", "j.id", "j.step", "j.error", "j.ended_at"])
      .where("j.state", "=", "failed").where("j.ended_at", ">", since)
      .where((eb) => eb.not(eb.exists(eb.selectFrom("job_items as ji").select(eb.lit(1).as("one")).whereRef("ji.job_id", "=", "j.id").whereRef("ji.repo", "=", "rp.repo").whereRef("ji.number", "=", "rp.number"))))
      .orderBy("j.id"));
    for (const r of rows) {
      const key = refKey(r.repo!, Number(r.number)), row: FailedJob = { id: r.id, step: r.step, error: r.error, ended_at: r.ended_at };
      const l = out.get(key);
      if (l) l.push(row); else out.set(key, [row]);
    }
  }
  return out;
}

/** Position in line of queued jobs (1 = next of its step), of the jobs given or of every queued job. */
export async function loadQueuePositions(db: Db, jobIds?: number[]): Promise<Map<number, number>> {
  if (jobIds && !jobIds.length) return new Map();
  const q = queryDb(db);
  const ranked = q.k.selectFrom("jobs").select((eb) => ["id", eb.fn.agg<number>("row_number").over((w) => w.partitionBy("step").orderBy("id")).as("pos")]).where("state", "=", "queued");
  const rows = await q.all(q.k.selectFrom(ranked.as("r")).select(["r.id", "r.pos"]).$if(!!jobIds, (b) => b.where(kx.inList(db, "r.id", jobIds!, "bigint"))));
  return new Map(rows.map((r) => [r.id, Number(r.pos)]));
}

/**
 * Count, newest id and state list (oldest id first, comma-joined) of the queued and running jobs of a repo that name
 * one of `refs` (every such job of the repo without `refs`), and the queue positions of the queued ones.
 */
export async function loadJobStamp(db: Db, repo: string, refs?: Ref[]): Promise<JobStamp> {
  const q = queryDb(db);
  if (refs && !refs.length) return { count: 0, newestId: null, states: "", positions: new Map() };
  const named = (eb: kx.AnyEb) => kx.schemaEb(eb).selectFrom(kx.refPairs(db, pairsOf(refs ?? []), "rp")).select(eb.lit(1).as("one")).whereRef("rp.repo", "=", "jobs.repo" as never)
    .where((e) => e("rp.number", "=", numberOf(db, "jobs.params")));
  const mine = (b: any, states: string[]): any => b.where("jobs.state", "in", states).where("jobs.repo", "=", repo)
    .$if(!!refs, (x: any) => x.where((eb: kx.AnyEb) => eb.exists(named(eb))));
  const ranked = q.k.selectFrom("jobs").select((eb) => ["jobs.id", eb.fn.agg<number>("row_number").over((w) => w.partitionBy("jobs.step").orderBy("jobs.id")).as("pos")]).where("jobs.state", "=", "queued");
  const [agg, pos] = await db.together(() => Promise.all([
    q.get(mine(q.k.selectFrom("jobs"), ["queued", "running"]).select((eb: kx.AnyEb) => [eb.fn.countAll<number>().as("n"), eb.fn.max<number | null>("jobs.id").as("newest"), kx.groupConcat(db, "jobs.state", ",", "jobs.id").as("states")])) as Promise<{ n: number; newest: number | null; states: string | null } | undefined>,
    q.all(q.k.selectFrom(ranked.as("r")).select(["r.id", "r.pos"]).where("r.id", "in", mine(q.k.selectFrom("jobs"), ["queued"]).select("jobs.id"))),
  ]));
  return { count: Number(agg?.n ?? 0), newestId: agg?.newest ?? null, states: agg?.states ?? "", positions: new Map(pos.map((r) => [r.id, Number(r.pos)])) };
}

/**
 * Finished runs of the jobs `requestedBy` started, among the newest `window` job ids, ended in the last `sinceDays` days, a runner restart's left out,
 * newest first: the newest `last` of each step and repo, and of a step and repo whose newest `last` all failed every done one.
 */
export async function loadStepRuns(db: Db, o: { requestedBy: string; sinceDays: number; window: number; last: number; nowMs: number }): Promise<StepRun[]> {
  const q = queryDb(db);
  const since = new Date(o.nowMs - o.sinceDays * 86_400_000).toISOString();
  const runs = q.k.selectFrom("jobs").select((eb) => ["id", "step", "repo", "state", "error", "ended_at", eb.fn.agg<number>("row_number").over((w) => w.partitionBy(["step", "repo"]).orderBy("id", "desc")).as("rn")])
    .where("id", ">", (eb) => eb(eb.selectFrom("jobs as mx").select((e) => e.fn.max<number>("mx.id").as("m")), "-", o.window))
    .where("requested_by", "=", o.requestedBy).where("state", "in", ["done", "failed"]).where("ended_at", ">", since)
    .where((eb) => eb.or([eb("error", "is", null), eb("error", "<>", RUNNER_STOPPED)]));
  const counted = q.k.selectFrom(runs.as("r")).selectAll("r")
    .select((eb) => eb.fn.sum<number>(eb.case().when(eb.and([eb("r.rn", "<=", o.last), eb("r.state", "=", "failed")])).then(1).else(0).end()).over((w) => w.partitionBy(["r.step", "r.repo"])).as("failed"));
  return await q.all(q.k.selectFrom(counted.as("c")).select(["c.id", "c.step", "c.repo", "c.state", "c.error", "c.ended_at"]).$narrowType<{ state: JobState }>()
    .where((eb) => eb.or([eb("c.rn", "<=", o.last), eb.and([eb("c.failed", "=", o.last), eb("c.state", "=", "done")])])).orderBy("c.id", "desc"));
}

/**
 * Jobs the runner stopped for running past their step's limit that nobody has acknowledged and no later job of the step has
 * beaten: failed stop rows of the last 5000 ids and the last done id per step in one wave, then the acknowledgements of the stopped steps
 * (only when there are any).
 */
export async function loadDeadlineStops(db: Db): Promise<DeadlineStop[]> {
  const q = queryDb(db);
  const stopped = () => q.k.selectFrom("jobs").select(["step", "id", "error", "ended_at"])
    .where("id", ">", (eb) => eb(eb.selectFrom("jobs as mx").select((e) => e.fn.max<number>("mx.id").as("m")), "-", STOP_WINDOW)).where("state", "=", "failed")
    .where((eb) => eb.or([kx.like(db, "error", eb.val("stopped: ran past %")), kx.like(db, "error", eb.val("stopped: no progress for %"))]));
  const [rows, done] = await db.together(() => Promise.all([
    q.all(stopped().orderBy("id", "desc")),
    q.all(q.k.selectFrom("jobs").select((eb) => ["step", eb.fn.max<number>("id").as("m")]).where("state", "=", "done").where("step", "in", (eb) => eb.selectFrom(stopped().as("s")).select("s.step")).groupBy("step")),
  ]));
  const acked = await loadAuditMax(db, "deadline-ack", [...new Set(rows.map((r) => `step:${r.step}`))]);
  const lastDone = new Map(done.map((r) => [r.step, Number(r.m)]));
  const out: DeadlineStop[] = [];
  for (const step of new Set(rows.map((r) => r.step))) {
    const mine = rows.filter((r) => r.step === step), latest = mine[0]!;
    const doneId = lastDone.get(step) ?? 0;
    if (doneId > latest.id) continue;
    const ack = acked.get(`step:${step}`);
    if (ack && latest.ended_at !== null && ack >= latest.ended_at) continue;
    out.push({ step, jobId: latest.id, error: latest.error!, endedAt: latest.ended_at, count: mine.filter((r) => r.id > doneId).length });
  }
  return out;
}

/** Items handled per step in hourly (`bucket` "hour") or daily buckets of jobs started in `[from, to)`: the bucket is the leading characters of the start time, which the caller completes to the bucket's start. */
export async function loadItemsByBucket(db: Db, from: string, to: string, bucket: string, hidden?: HiddenRepos): Promise<ItemsByBucket[]> {
  const q = queryDb(db);
  const prefix = bucket === "hour" ? 13 : 10;
  return (await q.all(q.k.selectFrom("jobs").select((eb) => ["step", eb.fn<string>("substr", [eb.ref("started_at"), eb.lit(1), eb.lit(prefix)]).as("bucket"), eb.fn.coalesce(eb.fn.sum<number>("items"), eb.lit(0)).as("items")])
    .where("started_at", ">=", from).where("started_at", "<", to).$if(hasFilter(hidden), (b) => b.where((eb) => repoVisible(db, eb, "repo", hidden!)))
    .groupBy("step").groupBy("bucket"))).map((r) => ({ step: r.step, bucket: r.bucket, items: Number(r.items) }));
}

/** Sum of `items` of jobs of each step started at or after that step's time in `sinceByStep`; a step without a time is absent. */
export async function loadItemsSince(db: Db, steps: string[], sinceByStep: Record<string, string>): Promise<Map<string, number>> {
  const asked = steps.filter((s) => sinceByStep[s] !== undefined);
  const out = new Map<string, number>(asked.map((s) => [s, 0]));
  if (!asked.length) return out;
  const q = queryDb(db);
  const v = kx.valuesTable(db, asked.map((step) => ({ step, since: sinceByStep[step]! })), { step: "text", since: "text" }, "v");
  for (const r of await q.all(q.k.selectFrom("jobs as j").innerJoin(v, "v.step", "j.step").select((eb) => ["j.step", eb.fn.coalesce(eb.fn.sum<number>("j.items"), eb.lit(0)).as("n")])
    .whereRef("j.started_at", ">=", "v.since").groupBy("j.step"))) out.set(r.step, Number(r.n));
  return out;
}

/** State, summary and error of one job, for the CLI wait loop. */
export async function loadJobState(db: Db, id: number): Promise<{ state: JobState; summary: string | null; error: string | null } | null> {
  const q = queryDb(db);
  return (await q.get(q.k.selectFrom("jobs").select(["state", "summary", "error"]).$narrowType<{ state: JobState }>().where("id", "=", id))) ?? null;
}

/** The newest finished job of `step` (done or failed: either may have written), by id; null when none has ended. */
export async function loadLastEndedJob(db: Db, step: string): Promise<number | null> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("jobs").select("id").where("step", "=", step).where("ended_at", "is not", null).orderBy("id", "desc").limit(1));
  return r ? Number(r.id) : null;
}

/** The probes (`step`, `repo`) that have a running job; keys are `step\0repo`. */
export async function isRunning(db: Db, probes: { step: string; repo: string }[]): Promise<Set<string>> {
  if (!probes.length) return new Set();
  const q = queryDb(db);
  const v = kx.valuesTable(db, probes, { step: "text", repo: "text" }, "v");
  const rows = await q.all(q.k.selectFrom(v).select(["v.step", "v.repo"]).where((eb) => eb.exists(eb.selectFrom("jobs as j").select(eb.lit(1).as("one"))
    .whereRef("j.step", "=", "v.step").whereRef("j.repo", "=", "v.repo").where("j.state", "=", "running"))));
  return new Set(rows.map((r) => `${r.step}\0${r.repo}`));
}
