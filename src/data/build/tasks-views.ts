// Task read models for the dashboard, live board and trace (package build-a).
import type { Expression, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { filtered } from "../control/hidden.ts";
import { hiddenRepos } from "../control/fragments.ts";
import { loadBatchesByTask } from "../merge/index.ts";
import { loadRepos, loadShown } from "../mirror/index.ts";
import { resolveKeys } from "../keys.ts";
import { loadArtifacts, loadLogTails } from "./artifacts.ts";
import { privateStepExpr } from "./fragments.ts";
import { byteLen, hasPatchExpr, idsIn, lastLogSteps, parseJson, refKey, TASK_COLUMNS, toTask, type TaskDbRow } from "./rows.ts";
import { loadConfidentialReadyAt } from "./tasks-load.ts";
import { CONFIDENTIAL_WAIT, LOG_TAIL_BYTES, PRIVATE_STEPS, StatusError, TERMINAL } from "./types.ts";
import type {
  BuildSummary, BuildTask, BuildTaskDetail, EnvTasks, IdSource, ItemShown, MemRow, PodRun, RefSource, Requires, SandboxEnv, TaskCard, TaskEvent, TaskFilter, TaskHistoryStat, TaskPage, TaskResult,
  TaskState, TaskStep, ViewScope,
} from "./types.ts";

const CURSOR_RE = /^[1-9][0-9]{0,15}$/;
const FILTER_STATES = ["queued", "claimed", "running", "done", "failed", "cancelled", "lost", "active"];
const OPEN = ["claimed", "running"];
const NO_ITEM: ItemShown = { kind: null, state: null, title: null };

/** What the viewer may see: no private steps unless staff, no hidden repos. */
function visible(db: Db, eb: kx.Eb, scope: ViewScope, repo: string, step: string): Expression<SqlBool>[] {
  return [...(scope.staff ? [] : [eb.not(privateStepExpr(eb, step))]), ...(filtered(scope.hiddenRepos) ? [hiddenRepos(db, repo, scope.hiddenRepos)] : [])];
}

type PageRow = TaskDbRow & { env_label: string | null; patch_bytes: number | null };

const pageSelect = (db: Db) => queryDb(db).k.selectFrom("build_tasks as t").leftJoin("build_envs as e", "e.id", "t.env_id")
  .select((eb) => [...TASK_COLUMNS, hasPatchExpr(eb), "e.label as env_label", eb.case().when("t.patch", "is", null).then(null).else(byteLen(db, "t.patch")).end().as("patch_bytes")]);

/** The rows as `BuildTask`s: artifacts, batches, shown items, default branches and the confidential clock come in one wave (a second only for the members of listed batches). */
async function decorate<X = undefined>(db: Db, rows: PageRow[], extra?: () => Promise<X>): Promise<{ tasks: BuildTask[]; extra: X }> {
  const ids = rows.map((r) => r.id);
  const refs = rows.flatMap((r) => (r.number === null ? [] : [{ repo: r.repo, number: r.number }]));
  const baselineRepos = [...new Set(rows.filter((r) => r.step === "verify" && r.number === null && !Number(r.has_patch)).map((r) => r.repo))];
  const [artifacts, batches, shown, ready, repos, more] = await db.together(async () => await Promise.all([
    loadArtifacts(db, ids), loadBatchesByTask(db, ids), refs.length ? loadShown(db, refs) : Promise.resolve(new Map<string, ItemShown>()), loadConfidentialReadyAt(db),
    baselineRepos.length ? loadRepos(db, { names: baselineRepos }) : Promise.resolve(new Map()), extra ? extra() : Promise.resolve(undefined as X),
  ]));
  const members = [...batches.values()].flatMap((b) => b.members.map((number) => ({ repo: b.repo, number })));
  const memberShown = members.length ? await loadShown(db, members) : new Map<string, ItemShown>();
  const tasks = rows.map((r): BuildTask => {
    const b = batches.get(r.id);
    const t = toTask(r);
    return {
      id: t.id, jobId: t.jobId, step: t.step, repo: t.repo, number: t.number, headSha: t.headSha, baseSha: t.baseSha, requires: t.requires as Requires, priority: t.priority,
      plan: t.plan as TaskStep[], state: t.state, envId: t.envId, envLabel: r.env_label, cancelRequested: t.cancelRequestedAt !== null,
      queuedAt: t.queuedAt, claimedAt: t.claimedAt, startedAt: t.startedAt, endedAt: t.endedAt, heartbeatAt: t.heartbeatAt,
      results: t.results as TaskResult[], artifacts: (artifacts.get(r.id) ?? []).map((a) => ({ name: a.name, bytes: a.bytes, contentType: a.contentType })),
      summary: t.summary ?? (t.state === "queued" && ready === null && (PRIVATE_STEPS as readonly string[]).includes(t.step) ? CONFIDENTIAL_WAIT : null),
      patchBytes: r.patch_bytes === null ? null : Number(r.patch_bytes),
      warm: t.warmKey && t.warmRole ? { key: t.warmKey, role: t.warmRole } : null,
      batch: b ? {
        id: b.id, branch: b.branch, fork: b.fork, commitSha: b.commitSha, baseSha: b.baseSha, prs: b.members,
        shown: b.members.map((n) => ({ ...(memberShown.get(refKey(b.repo, n)) ?? NO_ITEM) })),
      } : null,
      item: t.number === null ? null : shown.get(refKey(t.repo, t.number)) ?? NO_ITEM,
      baseline: t.step === "verify" && t.number === null && !t.hasPatch ? { branch: repos.get(t.repo)?.default_branch ?? null } : null,
      sandbox: t.sandbox as SandboxEnv | null,
    };
  });
  return { tasks, extra: more as X };
}

/** The task list page, newest first, keyset-paged by id. Wave 1 the page plus one row, wave 2 artifacts, batches, shown items, default branches and the confidential clock. */
export async function loadTaskPage(db: Db, filter: TaskFilter, scope: ViewScope): Promise<TaskPage> {
  if (filter.state !== undefined && !FILTER_STATES.includes(filter.state)) throw new StatusError(400, "unknown state");
  if (filter.cursor !== undefined && !CURSOR_RE.test(filter.cursor)) throw new StatusError(400, "bad cursor");
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const q = queryDb(db);
  const rows = await q.all(pageSelect(db).where((eb) => eb.and(visible(db, eb, scope, "t.repo", "t.step")))
    .$if(filter.state === "active", (s) => s.where("t.state", "in", ["queued", "claimed", "running"]))
    .$if(!!filter.state && filter.state !== "active", (s) => s.where("t.state", "=", filter.state as string))
    .$if(!!filter.env, (s) => s.where("t.env_id", "=", filter.env!))
    .$if(!!filter.repo, (s) => s.where("t.repo", "=", filter.repo!))
    .$if(filter.cursor !== undefined, (s) => s.where("t.id", "<", Number(filter.cursor)))
    .orderBy("t.id", "desc").limit(limit + 1), { label: "build.loadTaskPage" }) as PageRow[];
  const page = rows.slice(0, limit);
  return { tasks: (await decorate(db, page)).tasks, next: rows.length > limit ? String(page[page.length - 1]!.id) : null };
}

/** One task with artifacts, batch, shown item, and for staff the log tail and patch; null when it is missing, of a hidden repo or private to staff. */
export async function loadTaskDetail(db: Db, id: number, scope: ViewScope): Promise<BuildTaskDetail | null> {
  const q = queryDb(db);
  const row = await q.get(pageSelect(db).where("t.id", "=", id).where((eb) => eb.and(visible(db, eb, scope, "t.repo", "t.step"))), { label: "build.loadTaskDetail" }) as PageRow | undefined;
  if (!row) return null;
  const { tasks, extra } = await decorate(db, [row], scope.staff ? async () => ({
    tail: (await loadLogTails(db, [{ id }], { maxBytes: LOG_TAIL_BYTES })).get(id) ?? null,
    patch: (await q.get(q.k.selectFrom("build_tasks").select("patch").where("id", "=", id), { label: "build.loadTaskDetail" }))?.patch ?? null,
  }) : undefined);
  const t = tasks[0]!;
  return scope.staff && extra
    ? { ...t, logTail: extra.tail?.text ?? "", logBytes: extra.tail?.bytes ?? 0, logTruncated: extra.tail?.truncated ?? false, patch: extra.patch, canCancel: false }
    : { ...t, logTail: null, logBytes: 0, logTruncated: false, patch: null, canCancel: false };
}

/** Queued and running tasks and the slots left over all online enabled environments. 3 statements in one wave. */
export async function loadTaskSummary(db: Db, scope: ViewScope): Promise<BuildSummary> {
  const q = queryDb(db);
  const online = new Date(Date.now() - 60_000).toISOString();
  const [counts, envs, used] = await db.together(async () => await Promise.all([
    q.get(q.k.selectFrom("build_tasks as t").select((eb) => [
      eb.fn.coalesce(eb.fn.sum<number>(eb.case().when("t.state", "=", "queued").then(1).else(0).end()), eb.lit(0)).as("queued"),
      eb.fn.coalesce(eb.fn.sum<number>(eb.case().when("t.state", "in", OPEN).then(1).else(0).end()), eb.lit(0)).as("running"),
    ]).where("t.state", "in", ["queued", "claimed", "running"]).where((eb) => eb.and(visible(db, eb, scope, "t.repo", "t.step"))), { label: "build.loadTaskSummary" }),
    q.all(q.k.selectFrom("build_envs").select(["id", "slots", "reported_slots"]).where("enabled", "=", 1).where("last_seen_at", ">", online), { label: "build.loadTaskSummary" }),
    q.all(q.k.selectFrom("build_tasks").select((eb) => ["env_id as id", eb.fn.countAll<number>().as("n")]).where("state", "in", OPEN).groupBy("env_id"), { label: "build.loadTaskSummary" }),
  ]));
  const byEnv = new Map(used.map((u) => [u.id, Number(u.n)]));
  const slotsOf = (e: { slots: number; reported_slots: number | null }) => Math.min(e.slots, e.reported_slots ?? e.slots);
  const slots = envs.reduce((s, e) => s + slotsOf(e), 0);
  const inUse = envs.reduce((s, e) => s + Math.min(byEnv.get(e.id) ?? 0, slotsOf(e)), 0);
  return { queued: Number(counts?.queued ?? 0), running: Number(counts?.running ?? 0), slots, free: slots - inUse, online: envs.length };
}

/** An environment's pod runs and the tasks they belong to, in task order. 2 statements in one wave. */
export async function loadEnvTasks(db: Db, envId: string): Promise<EnvTasks> {
  const q = queryDb(db);
  const [runs, tasks] = await db.together(async () => await Promise.all([
    q.all(q.k.selectFrom("build_pod_runs").selectAll().where("env_id", "=", envId).orderBy("task_id"), { label: "build.loadEnvTasks" }),
    q.all(q.k.selectFrom("build_tasks as t").select((eb) => [...TASK_COLUMNS, hasPatchExpr(eb)])
      .where("t.id", "in", (eb) => eb.selectFrom("build_pod_runs").select("task_id").where("env_id", "=", envId)).orderBy("t.id"), { label: "build.loadEnvTasks" }),
  ]));
  return { runs: runs as PodRun[], tasks: (tasks as TaskDbRow[]).map(toTask) };
}

/** Task rows per job with the step each started, unended task's log is on, for the live board. 2 statements in one wave. */
export async function loadTaskCards(db: Db, jobIds: IdSource, scope: ViewScope): Promise<Map<number, TaskCard[]>> {
  if (Array.isArray(jobIds) && jobIds.length === 0) return new Map();
  const q = queryDb(db);
  const mine = (eb: kx.Eb) => eb.and([idsIn(db, eb, "t.job_id", jobIds), ...visible(db, eb, scope, "t.repo", "t.step")]);
  const [rows, steps] = await db.together(async () => await Promise.all([
    q.all(q.k.selectFrom("build_tasks as t").select(["t.id", "t.job_id", "t.step", "t.repo", "t.number", "t.state", "t.queued_at", "t.started_at", "t.ended_at", "t.results", "t.summary"]).where(mine).orderBy("t.id"), { label: "build.loadTaskCards" }),
    lastLogSteps(db, q.k.selectFrom("build_tasks as t").select("t.id").where(mine).where("t.started_at", "is not", null).where("t.ended_at", "is", null)),
  ]));
  const out = new Map<number, TaskCard[]>();
  for (const r of rows) {
    const card: TaskCard = {
      id: r.id, jobId: r.job_id, step: r.step, state: r.state as TaskState, repo: r.repo, number: r.number, queuedAt: r.queued_at, startedAt: r.started_at, endedAt: r.ended_at,
      results: parseJson<TaskResult[]>(r.results, []), summary: r.summary, logStep: steps.get(r.id) ?? null,
    };
    (out.get(r.job_id!) ?? out.set(r.job_id!, []).get(r.job_id!)!).push(card);
  }
  return out;
}

/**
 * Tasks as live-board cards with the step their newest log chunk is on, oldest first: `states` lists tasks without a job in those states
 * (private steps and hidden repos filtered by `scope`), `ids` the listed tasks (private steps filtered). 2 statements in one wave.
 */
export async function loadStandaloneTasks(db: Db, src: { states: TaskState[] } | { ids: number[] }, scope: ViewScope): Promise<TaskCard[]> {
  if ("ids" in src && !src.ids.length) return [];
  const q = queryDb(db);
  const mine = (eb: kx.Eb) => eb.and("ids" in src
    ? [kx.inList(db, "t.id", src.ids, "bigint"), ...visible(db, eb, { staff: scope.staff, hiddenRepos: [] }, "t.repo", "t.step")]
    : [eb("t.state", "in", src.states), eb("t.job_id", "is", null), ...visible(db, eb, scope, "t.repo", "t.step")]);
  const [rows, steps] = await db.together(async () => await Promise.all([
    q.all(q.k.selectFrom("build_tasks as t").select(["t.id", "t.job_id", "t.step", "t.repo", "t.number", "t.state", "t.queued_at", "t.started_at", "t.ended_at", "t.results", "t.summary"]).where(mine).orderBy("t.id"), { label: "build.loadStandaloneTasks" }),
    lastLogSteps(db, q.k.selectFrom("build_tasks as t").select("t.id").where(mine)),
  ]));
  return rows.map((r) => ({
    id: r.id, jobId: r.job_id, step: r.step, state: r.state as TaskState, repo: r.repo, number: r.number, queuedAt: r.queued_at, startedAt: r.started_at, endedAt: r.ended_at,
    results: parseJson<TaskResult[]>(r.results, []), summary: r.summary, logStep: steps.get(r.id) ?? null,
  }));
}

/** The newest `samples` durations in ms of done tasks per `repo|step` of the tasks that have not ended, newest first (a window function). 1 statement. */
export async function loadOpenTaskDurations(db: Db, samples: number): Promise<Map<string, number[]>> {
  const q = queryDb(db);
  const want = q.k.selectFrom("build_tasks as o").select(["o.repo", "o.step"]).distinct().where("o.state", "not in", [...TERMINAL]).as("w");
  const rows = await q.all(q.k.selectFrom((eb) => eb.selectFrom("build_tasks as t").innerJoin(want, (j) => j.onRef("w.repo", "=", "t.repo").onRef("w.step", "=", "t.step"))
    .select((e) => ["t.repo", "t.step", "t.started_at", "t.ended_at", "t.id", e.fn.agg<number>("row_number").over((o) => o.partitionBy(["t.repo", "t.step"]).orderBy("t.id", "desc")).as("rn")])
    .where("t.state", "=", "done").where("t.started_at", "is not", null).where("t.ended_at", "is not", null).as("s"))
    .select(["s.repo", "s.step", "s.started_at", "s.ended_at"]).where("s.rn", "<=", samples).orderBy("s.repo").orderBy("s.step").orderBy("s.id", "desc"), { label: "build.loadOpenTaskDurations" });
  const out = new Map<string, number[]>();
  for (const r of rows) (out.get(`${r.repo}|${r.step}`) ?? out.set(`${r.repo}|${r.step}`, []).get(`${r.repo}|${r.step}`)!).push(Date.parse(r.ended_at!) - Date.parse(r.started_at!));
  return out;
}

/** An item's task history, oldest first, for the trace and activity pages. 1 statement. */
export async function loadItemTaskEvents(db: Db, ref: { repo: string; number: number }, scope: ViewScope): Promise<TaskEvent[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("build_tasks as t").select(["t.id", "t.job_id", "t.head_sha", "t.step", "t.state", "t.queued_at", "t.started_at", "t.ended_at", "t.summary", "t.env_id"])
    .where("t.repo", "=", ref.repo).where("t.number", "=", ref.number).where((eb) => eb.and(visible(db, eb, scope, "t.repo", "t.step"))).orderBy("t.id"), { label: "build.loadItemTaskEvents" });
  return rows.map((r) => ({ id: r.id, jobId: r.job_id, headSha: r.head_sha, step: r.step, state: r.state as TaskState, queuedAt: r.queued_at, startedAt: r.started_at, endedAt: r.ended_at, summary: r.summary, envId: r.env_id }));
}

/** The trace's "has anything changed" signature per item: count, newest id, whether any task ended, and the states in id order. 1 statement. */
export async function loadTaskHistoryStats(db: Db, refs: RefSource): Promise<Map<string, TaskHistoryStat>> {
  if (Array.isArray(refs) && refs.length === 0) return new Map();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("build_tasks as t").innerJoin(resolveKeys(db, refs, "kk"), (j) => j.onRef("kk.repo", "=", "t.repo").onRef("kk.number", "=", "t.number"))
    .select((eb) => ["t.repo", "t.number", eb.fn.countAll<number>().as("n"), eb.fn.max<number>("t.id").as("newest"),
      eb.fn.sum<number>(eb.case().when("t.ended_at", "is not", null).then(1).else(0).end()).as("ended"), kx.groupConcat(db, "t.state", ",", "t.id").as("states")])
    .groupBy(["t.repo", "t.number"]), { label: "build.loadTaskHistoryStats" });
  return new Map(rows.map((r) => [refKey(r.repo, r.number!), { n: Number(r.n), newestId: Number(r.newest), ended: Number(r.ended) > 0, states: r.states ?? "" }]));
}

/** Peak memory per repo and step name over tasks that ended in the last `days` days (median, max, OOM kills); steps without a measurement are skipped. 1 statement. */
export async function loadMemorySummary(db: Db, days: number): Promise<MemRow[]> {
  const q = queryDb(db);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows = await q.all(q.k.selectFrom("build_tasks").select(["repo", "results"]).where("ended_at", ">=", since).where("results", "!=", "[]"), { label: "build.loadMemorySummary" });
  const groups = new Map<string, { repo: string; step: string; peaks: number[]; oom: number }>();
  for (const row of rows) {
    for (const r of parseJson<TaskResult[]>(row.results, [])) {
      if (typeof r.peakMemBytes !== "number") continue;
      const key = `${row.repo}\0${r.step}`;
      const g = groups.get(key) ?? { repo: row.repo, step: r.step, peaks: [], oom: 0 };
      g.peaks.push(r.peakMemBytes);
      if (r.oomKilled) g.oom++;
      groups.set(key, g);
    }
  }
  return [...groups.values()].map((g) => {
    const p = g.peaks.sort((a, b) => a - b);
    const mid = p.length >> 1;
    return { repo: g.repo, step: g.step, steps: p.length, medianBytes: p.length % 2 ? p[mid]! : Math.round((p[mid - 1]! + p[mid]!) / 2), maxBytes: p[p.length - 1]!, oom: g.oom };
  }).sort((a, b) => a.repo.localeCompare(b.repo) || a.step.localeCompare(b.step));
}
