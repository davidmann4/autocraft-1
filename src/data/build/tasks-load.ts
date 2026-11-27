// Task loaders (package build-a).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { resolveKeys } from "../keys.ts";
import { hasPatchExpr, idsIn, lastLogSteps, parseJson, refKey, TASK_COLUMNS, toTask, type TaskDbRow } from "./rows.ts";
import { PRIVATE_STEPS, TaskAccessError, TERMINAL } from "./types.ts";
import type { IdSource, NewTask, Requires, RefSource, TaskBrief, TaskLite, TaskRecord, TaskState, TaskStateRow, TaskStep } from "./types.ts";

const LITE = ["t.id", "t.step", "t.repo", "t.number", "t.head_sha", "t.state", "t.env_id", "t.queued_at", "t.started_at", "t.ended_at", "t.summary", "t.job_id"] as const;
type LiteRow = { id: number; step: string; repo: string; number: number | null; head_sha: string; state: string; env_id: string | null; queued_at: string; started_at: string | null; ended_at: string | null; summary: string | null; job_id: number | null };
const toLite = (r: LiteRow): TaskLite => ({
  id: r.id, step: r.step, repo: r.repo, number: r.number, headSha: r.head_sha, state: r.state as TaskState, envId: r.env_id, queuedAt: r.queued_at,
  startedAt: r.started_at, endedAt: r.ended_at, summary: r.summary, jobId: r.job_id,
});

/** Task rows by id or id fragment; `patch` adds the stored patch. 1 statement. */
export async function loadTasks(db: Db, ids: IdSource, opt?: { patch?: boolean }): Promise<Map<number, TaskRecord>> {
  if (Array.isArray(ids) && ids.length === 0) return new Map();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("build_tasks as t").select((eb) => [...TASK_COLUMNS, hasPatchExpr(eb), ...(opt?.patch ? [eb.ref("t.patch").as("patch")] : [])])
    .where((eb) => idsIn(db, eb, "t.id", ids)).orderBy("t.id"), { label: "build.loadTasks" });
  return new Map(rows.map((r) => [r.id, opt?.patch ? { ...toTask(r as TaskDbRow), patch: (r as { patch?: string | null }).patch ?? null } : toTask(r as TaskDbRow)]));
}

/** State, step and end time per task id. 1 statement. */
export async function loadTaskStates(db: Db, ids: IdSource): Promise<Map<number, TaskStateRow>> {
  if (Array.isArray(ids) && ids.length === 0) return new Map();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("build_tasks as t").select(["t.id", "t.state", "t.step", "t.ended_at"]).where((eb) => idsIn(db, eb, "t.id", ids)), { label: "build.loadTaskStates" });
  return new Map(rows.map((r) => [r.id, { state: r.state as TaskState, step: r.step, endedAt: r.ended_at }]));
}

/** Tasks of the items that are not in a terminal state, oldest first, keyed `repo#number`. 1 statement. */
export async function loadOpenTasks(db: Db, refs: RefSource): Promise<Map<string, TaskLite[]>> {
  if (Array.isArray(refs) && refs.length === 0) return new Map();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("build_tasks as t")
    .innerJoin(resolveKeys(db, refs, "kk"), (j) => j.onRef("kk.repo", "=", "t.repo").onRef("kk.number", "=", "t.number"))
    .select(LITE).where("t.state", "not in", [...TERMINAL]).orderBy("t.id"), { label: "build.loadOpenTasks" });
  const out = new Map<string, TaskLite[]>();
  for (const r of rows) {
    const k = refKey(r.repo, r.number!);
    (out.get(k) ?? out.set(k, []).get(k)!).push(toLite(r));
  }
  return out;
}

/** Task rows per job with the step each one's log is on, for the live board and jobs. 2 statements in one wave. */
export async function loadTasksOfJobs(db: Db, jobIds: number[]): Promise<Map<number, TaskBrief[]>> {
  if (jobIds.length === 0) return new Map();
  const q = queryDb(db);
  const [rows, steps] = await db.together(async () => await Promise.all([
    q.all(q.k.selectFrom("build_tasks as t").select(LITE).where(kx.inList(db, "t.job_id", jobIds, "bigint")).orderBy("t.id"), { label: "build.loadTasksOfJobs" }),
    lastLogSteps(db, q.k.selectFrom("build_tasks as bt").select("bt.id").where(kx.inList(db, "bt.job_id", jobIds, "bigint")).where("bt.started_at", "is not", null).where("bt.ended_at", "is", null)),
  ]));
  const out = new Map<number, TaskBrief[]>();
  for (const r of rows) (out.get(r.job_id!) ?? out.set(r.job_id!, []).get(r.job_id!)!).push({ ...toLite(r), logStep: steps.get(r.id) ?? null });
  return out;
}

/** True when the task is missing or terminal (the planner's rule over loaded states). */
export function taskEnded(states: ReadonlyMap<number, { state: string }>, id: number | null): boolean {
  if (id === null) return true;
  const s = states.get(id);
  return !s || (TERMINAL as readonly string[]).includes(s.state);
}

/** Queued count and oldest queue time, optionally only older than a time, private steps only or excluded. 1 statement. */
export async function loadQueuedStats(db: Db, opt: { olderThan?: string; privateOnly?: boolean; excludePrivate?: boolean }): Promise<{ n: number; oldest: string | null }> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("build_tasks").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.min<string | null>("queued_at").as("oldest")]).where("state", "=", "queued")
    .$if(!!opt.olderThan, (s) => s.where("queued_at", "<", opt.olderThan!))
    .$if(!!opt.privateOnly, (s) => s.where("step", "in", [...PRIVATE_STEPS]))
    .$if(!!opt.excludePrivate, (s) => s.where("step", "not in", [...PRIVATE_STEPS])), { label: "build.loadQueuedStats" });
  return { n: Number(r?.n ?? 0), oldest: r?.oldest ?? null };
}

/** Count of `warm_role = use` head tasks per key `step|repo#number|head` (verify, screenshots). 1 statement. */
export async function loadRetriesOf(db: Db, keys: { step: string; repo: string; number: number; headSha: string }[]): Promise<Map<string, number>> {
  if (keys.length === 0) return new Map();
  const q = queryDb(db);
  const want = kx.valuesTable(db, keys.map((k) => ({ step: k.step, repo: k.repo, number: k.number, head: k.headSha })), { step: "text", repo: "text", number: "bigint", head: "text" }, "w");
  const rows = await q.all(q.k.selectFrom("build_tasks as t")
    .innerJoin(want, (j) => j.onRef("w.step", "=", "t.step").onRef("w.repo", "=", "t.repo").onRef("w.number", "=", "t.number").onRef("w.head", "=", "t.head_sha"))
    .select((eb) => ["t.step", "t.repo", "t.number", "t.head_sha", eb.fn.countAll<number>().as("n")]).where("t.warm_role", "=", "use")
    .groupBy(["t.step", "t.repo", "t.number", "t.head_sha"]), { label: "build.loadRetriesOf" });
  return new Map(rows.map((r) => [`${r.step}|${refKey(r.repo, r.number!)}|${r.head_sha}`, Number(r.n)]));
}

/** Task rows as `NewTask` for cloning (same step, commits, requirements, plan, patch and warm role). 1 statement. */
export async function loadCloneSources(db: Db, ids: number[]): Promise<Map<number, NewTask>> {
  if (ids.length === 0) return new Map();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("build_tasks as t").select(["t.id", "t.step", "t.repo", "t.number", "t.head_sha", "t.base_sha", "t.requires", "t.priority", "t.plan", "t.patch", "t.warm_key", "t.warm_role"])
    .where(kx.inList(db, "t.id", ids, "bigint")), { label: "build.loadCloneSources" });
  return new Map(rows.map((r) => [r.id, {
    step: r.step, repo: r.repo, number: r.number, headSha: r.head_sha, baseSha: r.base_sha, requires: parseJson<Requires>(r.requires, {}), priority: r.priority,
    plan: parseJson<TaskStep[]>(r.plan, []), ...(r.patch === null ? {} : { patch: r.patch }),
    ...(r.warm_key && (r.warm_role === "use" || r.warm_role === "build") ? { warm: { key: r.warm_key, role: r.warm_role } } : {}),
  }]));
}

/** Whether the repo has a warm-build task for `headSha`, or one queued after `since` (ISO time). 1 statement. */
export async function hasWarmBuild(db: Db, repo: string, headSha: string, since: string): Promise<boolean> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("build_tasks").select((eb) => eb.lit(1).as("one")).where("repo", "=", repo).where("warm_role", "=", "build")
    .where((eb) => eb.or([eb("head_sha", "=", headSha), eb("queued_at", ">", since)])).limit(1), { label: "build.hasWarmBuild" });
  return r !== undefined;
}

/** Queued warm-build tasks with the head each would build, oldest first. 1 statement. */
export async function loadQueuedWarmBuilds(db: Db): Promise<{ id: number; repo: string; headSha: string; queuedAt: string }[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("build_tasks").select(["id", "repo", "head_sha", "queued_at"]).where("warm_role", "=", "build").where("state", "=", "queued").orderBy("id"), { label: "build.loadQueuedWarmBuilds" });
  return rows.map((r) => ({ id: Number(r.id), repo: r.repo, headSha: r.head_sha, queuedAt: r.queued_at }));
}

/** The time the private clock started (the earliest first call of an enabled confidential environment), null when none has called. 1 statement. */
export async function loadConfidentialReadyAt(db: Db): Promise<number | null> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("build_envs").select((eb) => eb.fn.min<string | null>("confidential_online_at").as("at")).where("enabled", "=", 1).where("confidential", "=", 1), { label: "build.loadConfidentialReadyAt" });
  return r?.at ? Date.parse(r.at) : null;
}

/** The task row when it runs on this env, else a `TaskAccessError` (404 missing, 409 not running here). 1 statement. */
export async function loadWorkerTask(db: Db, envId: string, id: number, opt?: { patch?: boolean }): Promise<TaskRecord> {
  const t = (await loadTasks(db, [id], opt)).get(id);
  if (!t) throw new TaskAccessError(404, "no such task");
  if (t.envId !== envId || (t.state !== "claimed" && t.state !== "running")) throw new TaskAccessError(409, "this task is not running on this environment");
  return t;
}

/** Ids of this environment's tasks cancelled since `since`, which the worker may still run. 1 statement. */
export async function loadCancelIds(db: Db, envId: string, since: string): Promise<number[]> {
  const q = queryDb(db);
  return (await q.all(q.k.selectFrom("build_tasks").select("id").where("env_id", "=", envId).where("cancel_requested_at", ">", since).orderBy("id"), { label: "build.loadCancelIds" })).map((r) => r.id);
}
