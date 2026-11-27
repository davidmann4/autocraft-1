// Task writers (package build-a).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { addAudit } from "../control/index.ts";
import { removeArtifactRows } from "./artifacts.ts";
import { idsIn } from "./rows.ts";
import { loadCancelIds, loadCloneSources, loadTasks } from "./tasks-load.ts";
import { ARTIFACT_KEEP_MS, KEEP_MS, LOST_AFTER_MS, MAX_ATTEMPTS, MAX_LOG_BYTES, MAX_QUEUED, QueueFullError, TaskAccessError, TERMINAL } from "./types.ts";
import type { CancelOutcome, NewTask, PodRun, SandboxEnv, TaskRecord, TaskResult, TaskState } from "./types.ts";

const OPEN = ["claimed", "running"];

/**
 * One multi-row insert returning the ids in order, after the queue cap check: the whole set is refused (`QueueFullError`) when
 * `queued + rows.length` would pass MAX_QUEUED. Rows are validated by the caller (the parsers stay in feature code), which also
 * fills `jobId` from the running job. 2 statements.
 */
export async function createTasks(db: Db, rows: NewTask[]): Promise<number[]> {
  if (rows.length === 0) return [];
  const q = queryDb(db);
  return await db.write(async () => {
    const queued = Number((await q.get(q.k.selectFrom("build_tasks").select((eb) => eb.fn.countAll<number>().as("n")).where("state", "=", "queued")))!.n);
    if (queued + rows.length > MAX_QUEUED) throw new QueueFullError(queued, MAX_QUEUED);
    const at = new Date().toISOString();
    const ids: number[] = [];
    for (const part of kx.batches(rows)) {
      const out = await q.all(q.k.insertInto("build_tasks").values(part.map((t) => ({
        job_id: t.jobId ?? null, step: t.step, repo: t.repo, number: t.number ?? null, head_sha: t.headSha, base_sha: t.baseSha ?? null,
        requires: JSON.stringify(t.requires ?? {}), priority: t.priority ?? 0, plan: JSON.stringify(t.plan), state: "queued", queued_at: at,
        patch: t.patch ?? null, warm_key: t.warm?.key ?? null, warm_role: t.warm?.role ?? null, warm_image: t.warmImage ?? null,
        warm_version: t.warmVersion ?? null, warm_rev: t.warmRev ?? null,
      }))).returning("id"));
      ids.push(...out.map((r) => r.id));
    }
    return ids;
  });
}

/** Queues a copy of each task (same step, commits, requirements, plan, patch and warm role) as a task of job `jobId`; returns the new id per source id. 3 statements. */
export async function cloneTasks(db: Db, ids: number[], jobId: number | null): Promise<Map<number, number>> {
  const sources = [...new Set(ids)];
  if (sources.length === 0) return new Map();
  return await db.write(async () => {
    const rows = await loadCloneSources(db, sources);
    const missing = sources.find((id) => !rows.has(id));
    if (missing !== undefined) throw new Error(`no task ${missing}`);
    const made = await createTasks(db, sources.map((id) => ({ ...rows.get(id)!, jobId })));
    return new Map(sources.map((id, i) => [id, made[i]!]));
  });
}

/**
 * Cancels tasks that are not in a terminal state, by id or by step (and repo), with one `task-cancel` audit row each. An active
 * one stays listed in its worker's claim and heartbeat answers for two minutes. `summaryOf` may set a summary other than the
 * default ("Cancelled before it started." / "Cancelled by an operator."). 3 statements, 4 with `summaryOf`.
 */
export async function cancelTasks(db: Db, sel: { ids: number[] } | { step: string; repo?: string }, by: string, summaryOf?: (t: { id: number; repo: string; was: TaskState }) => string | null): Promise<CancelOutcome[]> {
  if ("ids" in sel && sel.ids.length === 0) return [];
  const q = queryDb(db);
  return await db.write(async () => {
    const found = await q.all(q.k.selectFrom("build_tasks").select(["id", "repo", "state"])
      .$if("ids" in sel, (s) => s.where(kx.inList(db, "id", (sel as { ids: number[] }).ids, "bigint")))
      .$if(!("ids" in sel), (s) => s.where("step", "=", (sel as { step: string }).step).where("state", "not in", [...TERMINAL]).$if(!!(sel as { repo?: string }).repo, (r) => r.where("repo", "=", (sel as { repo: string }).repo)))
      .orderBy("id"));
    const open = found.filter((t) => !(TERMINAL as readonly string[]).includes(t.state));
    const at = new Date().toISOString();
    const won = new Set<number>();
    if (open.length) {
      const r = await q.all(q.k.updateTable("build_tasks").set((eb) => ({
        state: "cancelled", ended_at: at, cancel_requested_at: at,
        summary: eb.case("state").when("queued").then("Cancelled before it started.").else("Cancelled by an operator.").end(),
      })).where(kx.inList(db, "id", open.map((t) => t.id), "bigint")).where("state", "not in", [...TERMINAL]).returning("id"));
      for (const t of r) won.add(t.id);
      const custom = summaryOf ? open.filter((t) => won.has(t.id)).flatMap((t) => {
        const s = summaryOf({ id: t.id, repo: t.repo, was: t.state as TaskState });
        return s === null ? [] : [{ id: t.id, summary: s }];
      }) : [];
      if (custom.length) await kx.updateFrom(db, "build_tasks", ["id"], custom, ["summary"]);
      if (won.size) await addAudit(db, open.filter((t) => won.has(t.id)).map((t) => ({ login: by, action: "task-cancel", target: `task:${t.id}`, at, details: { repo: t.repo, was: t.state } })));
    }
    const byId = new Map(found.map((t) => [t.id, t]));
    const wanted = "ids" in sel ? [...new Set(sel.ids)] : found.map((t) => t.id);
    return wanted.map((id): CancelOutcome => {
      const t = byId.get(id);
      return t ? { id, repo: t.repo, was: t.state as TaskState, result: won.has(id) ? "cancelled" : "already" } : { id, repo: "", was: "queued", result: "missing" };
    });
  });
}

/**
 * Compare-and-set claim of a queued task for a pod environment: the task goes to `running` in the same transaction that inserts
 * its pod run (`claimed_at` and `started_at` are equal). Null when the task was no longer queued. A warm task's `heads` replace its
 * head, base and plan. 3 statements.
 */
export async function claimRun(db: Db, a: { envId: string; taskId: number; keyHash: string; pvc: string | null; stage: number; at: string; heads?: { head: string; base: string | null; plan: unknown } }): Promise<{ task: TaskRecord; run: PodRun } | null> {
  const q = queryDb(db);
  return await db.write(async () => {
    const won = await q.get(q.k.updateTable("build_tasks").set((eb) => ({
      state: "running", env_id: a.envId, attempts: eb("attempts", "+", 1), claimed_at: a.at, started_at: a.at, heartbeat_at: a.at,
      ...(a.heads ? { head_sha: a.heads.head, base_sha: a.heads.base, plan: JSON.stringify(a.heads.plan) } : {}),
    })).where("id", "=", a.taskId).where("state", "=", "queued").returning("id"));
    if (!won) return null;
    const run = await q.get(q.k.insertInto("build_pod_runs").values({ task_id: a.taskId, env_id: a.envId, key_hash: a.keyHash, pvc: a.pvc ?? "", stage: a.stage, started_at: a.at }).returningAll());
    const task = (await loadTasks(db, [a.taskId])).get(a.taskId)!;
    return { task, run: run! };
  });
}

/** Compare-and-set claim for worker environments (`claimed`); returns the ids that won, in pick order. A warm task's heads replace its head, base and plan. 2 statements. */
export async function claimTasks(db: Db, envId: string, picks: { id: number; head?: string; base?: string; plan?: unknown }[], at: string): Promise<number[]> {
  if (picks.length === 0) return [];
  const q = queryDb(db);
  return await db.write(async () => {
    const won = new Set((await q.all(q.k.updateTable("build_tasks").set((eb) => ({ state: "claimed", env_id: envId, attempts: eb("attempts", "+", 1), claimed_at: at, heartbeat_at: at }))
      .where(kx.inList(db, "id", picks.map((p) => p.id), "bigint")).where("state", "=", "queued").returning("id"))).map((r) => r.id));
    const heads = picks.filter((p) => won.has(p.id) && p.head !== undefined).map((p) => ({ id: p.id, head_sha: p.head!, base_sha: p.base ?? null, plan: JSON.stringify(p.plan) }));
    if (heads.length) await kx.updateFrom(db, "build_tasks", ["id"], heads);
    return picks.map((p) => p.id).filter((id) => won.has(id));
  });
}

/** Fails queued tasks no environment can run, each with its own summary (cut to 300 characters); returns how many were still queued. 1 statement. */
export async function failQueuedTasks(db: Db, rows: { id: number; summary: string }[], at: string): Promise<number> {
  if (rows.length === 0) return 0;
  const q = queryDb(db);
  return (await q.run(q.k.updateTable("build_tasks").set({ state: "failed", ended_at: at, summary: kx.caseOf("id", rows.map((r) => [r.id, r.summary.slice(0, 300)] as const)) })
    .where(kx.inList(db, "id", rows.map((r) => r.id), "bigint")).where("state", "=", "queued"))).changes;
}

/** Queues tasks of this environment again with the claim not counted and their logs removed; returns how many. 2 statements. */
export async function releaseClaims(db: Db, envId: string, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const q = queryDb(db);
  return await db.write(async () => {
    const mine = (eb: kx.Eb) => eb.and([idsIn(db, eb, "id", ids), eb("env_id", "=", envId), eb("state", "in", OPEN)]);
    await q.run(q.k.deleteFrom("build_task_logs").where("task_id", "in", (eb) => eb.selectFrom("build_tasks").select("id").where(mine(eb))));
    return (await q.run(q.k.updateTable("build_tasks").set((eb) => ({
      state: "queued", env_id: null, attempts: eb.case().when(eb("attempts", "-", eb.lit(1)), ">", eb.lit(0)).then(eb("attempts", "-", eb.lit(1))).else(eb.lit(0)).end(),
      claimed_at: null, started_at: null, heartbeat_at: null, results: "[]", log_bytes: 0, summary: null,
    })).where(mine))).changes;
  });
}

/** Worker API start: `started_at` keeps its first value, the heartbeat moves; returns the ids started and the environment's recent cancels. 2 statements. */
export async function startTasks(db: Db, envId: string, ids: number[], at: string): Promise<{ started: number[]; cancel: number[] }> {
  const q = queryDb(db);
  const started = ids.length === 0 ? [] : (await q.all(q.k.updateTable("build_tasks").set((eb) => ({ state: "running", started_at: eb.fn.coalesce("started_at", eb.val(at)), heartbeat_at: at }))
    .where(kx.inList(db, "id", ids, "bigint")).where("env_id", "=", envId).where("state", "in", OPEN).returning("id"))).map((r) => r.id);
  return { started, cancel: await loadCancelIds(db, envId, new Date(Date.parse(at) - LOST_AFTER_MS).toISOString()) };
}

/** Heartbeat of tasks a launcher or worker keeps alive; returns how many are still claimed or running on this environment. 1 statement. */
export async function touchTasks(db: Db, envId: string, ids: number[], at: string): Promise<number> {
  if (ids.length === 0) return 0;
  const q = queryDb(db);
  return (await q.run(q.k.updateTable("build_tasks").set({ heartbeat_at: at }).where(kx.inList(db, "id", ids, "bigint")).where("env_id", "=", envId).where("state", "in", OPEN))).changes;
}

/**
 * Worker API finish: one update decides the state in the statement itself (`cancelled` when an operator asked, `done` when every
 * step exited 0 and none timed out, else `failed`). A retried finish gets the state the first one set. Throws `TaskAccessError`
 * (404, or 409 when the task does not run here). 1 statement; 2 when the task was not running.
 */
export async function finishTask(db: Db, envId: string, id: number, r: { results: TaskResult[]; summary: string | null; sandbox: SandboxEnv | null; failed: boolean }): Promise<{ state: TaskState }> {
  const q = queryDb(db);
  const ok = !r.failed && r.results.length > 0 && r.results.every((x) => x.exitCode === 0 && !x.timedOut);
  const done = await q.get(q.k.updateTable("build_tasks").set((eb) => ({
    state: eb.case().when("cancel_requested_at", "is not", null).then("cancelled").else(ok ? "done" : "failed").end(),
    ended_at: new Date().toISOString(), results: JSON.stringify(r.results), summary: r.summary, sandbox_env: r.sandbox ? JSON.stringify(r.sandbox) : null,
  })).where("id", "=", id).where("env_id", "=", envId).where("state", "in", OPEN).returning("state"));
  if (done) return { state: done.state as TaskState };
  const now = await q.get(q.k.selectFrom("build_tasks").select(["state", "env_id"]).where("id", "=", id));
  if (!now) throw new TaskAccessError(404, "no such task");
  if (now.env_id === envId && (TERMINAL as readonly string[]).includes(now.state)) return { state: now.state as TaskState };
  throw new TaskAccessError(409, "this task is not running on this environment");
}

/**
 * Appends log chunks (each at most MAX_CHUNK_BYTES, cleaned by the caller): one conditional update reserves the bytes of all of
 * them, then one insert numbers them after the task's newest chunk. Past the 20 MB cap the chunk that crosses it is cut with a
 * marker and later chunks are dropped. Throws `TaskAccessError` for a missing task or one not running here. 2 statements; +1 past the cap or on an error.
 */
export async function appendTaskLogs(db: Db, envId: string, id: number, step: string, chunks: string[]): Promise<{ truncated: boolean; logBytes: number }> {
  if (chunks.length === 0) return { truncated: false, logBytes: 0 };
  const q = queryDb(db);
  const sizes = chunks.map((c) => Buffer.byteLength(c));
  const total = sizes.reduce((a, b) => a + b, 0);
  return await db.write(async () => {
    const claim = await q.get(q.k.updateTable("build_tasks").set((eb) => ({ log_bytes: eb("log_bytes", "+", total), heartbeat_at: new Date().toISOString() }))
      .where("id", "=", id).where("env_id", "=", envId).where("state", "in", OPEN).where("log_bytes", "<", MAX_LOG_BYTES).returning("log_bytes"));
    if (!claim) {
      const t = await q.get(q.k.selectFrom("build_tasks").select(["state", "env_id", "log_bytes"]).where("id", "=", id));
      if (!t) throw new TaskAccessError(404, "no such task");
      if (t.env_id !== envId || !OPEN.includes(t.state)) throw new TaskAccessError(409, "this task is not running on this environment");
      return { truncated: true, logBytes: t.log_bytes };
    }
    let pos = Number(claim.log_bytes) - total;
    let truncated = false;
    const kept: { ord: number; step: string; chunk: string }[] = [];
    for (const [i, c] of chunks.entries()) {
      const size = sizes[i]!;
      if (pos + size <= MAX_LOG_BYTES) kept.push({ ord: kept.length + 1, step, chunk: c });
      else if (pos < MAX_LOG_BYTES) {
        kept.push({ ord: kept.length + 1, step, chunk: `${Buffer.from(c).subarray(0, MAX_LOG_BYTES - pos).toString("utf8")}\n[log truncated at 20 MB]\n` });
        truncated = true;
      } else truncated = true;
      pos += size;
    }
    if (kept.length) {
      const v = kx.valuesTable(db, kept, { ord: "bigint", step: "text", chunk: "text" }, "v");
      await q.run(q.k.insertInto("build_task_logs").columns(["task_id", "seq", "step", "chunk"]).expression((eb) => eb.selectFrom(v)
        .select((e) => [e.val(id).as("task_id"), e(e.fn.coalesce(e.selectFrom("build_task_logs as m").select((m) => m.fn.max<number>("m.seq").as("mx")).where("m.task_id", "=", id), e.lit(0)), "+", e.ref("v.ord")).as("seq"), "v.step", "v.chunk"])
        .orderBy("v.ord")));
    }
    if (truncated) await q.run(q.k.updateTable("build_tasks").set({ log_bytes: MAX_LOG_BYTES }).where("id", "=", id).where("log_bytes", ">", MAX_LOG_BYTES));
    return { truncated, logBytes: truncated ? MAX_LOG_BYTES : Number(claim.log_bytes) };
  });
}

/**
 * Handles claimed or running tasks whose worker or pod is gone: requeued when a claim is left and nobody cancelled them (log
 * removed), else failed with `reason` or, after a cancel, cancelled with `cancelled` as the summary. Their artifact rows go;
 * `files` are the task ids whose artifact directories the caller removes after the commit. 6 statements for any number of tasks.
 */
export async function loseTasks(db: Db, rows: { id: number; reason: string; cancelled?: string }[], nowMs: number): Promise<{ lost: number; files: number[] }> {
  if (rows.length === 0) return { lost: 0, files: [] };
  const q = queryDb(db);
  return await db.write(async () => {
    const live = await q.all(q.k.selectFrom("build_tasks").select(["id", "attempts", "cancel_requested_at"]).where(kx.inList(db, "id", rows.map((r) => r.id), "bigint")).where("state", "in", OPEN));
    if (live.length === 0) return { lost: 0, files: [] };
    const files = await removeArtifactRows(db, live.map((t) => t.id));
    const requeue = live.filter((t) => !t.cancel_requested_at && t.attempts < MAX_ATTEMPTS).map((t) => t.id);
    const end = live.filter((t) => !requeue.includes(t.id));
    if (requeue.length) {
      await q.run(q.k.deleteFrom("build_task_logs").where(kx.inList(db, "task_id", requeue, "bigint")));
      await q.run(q.k.updateTable("build_tasks").set({ state: "queued", env_id: null, claimed_at: null, started_at: null, heartbeat_at: null, results: "[]", log_bytes: 0, summary: null })
        .where(kx.inList(db, "id", requeue, "bigint")).where("state", "in", OPEN));
    }
    if (end.length) {
      const by = new Map(rows.map((r) => [r.id, r]));
      const text = (t: { id: number; cancel_requested_at: string | null }): string => t.cancel_requested_at ? by.get(t.id)!.cancelled ?? "Cancelled; the worker stopped answering." : by.get(t.id)!.reason;
      await q.run(q.k.updateTable("build_tasks").set((eb) => ({
        state: eb.case().when("cancel_requested_at", "is not", null).then("cancelled").else("failed").end(), ended_at: new Date(nowMs).toISOString(),
        summary: kx.caseOf("id", end.map((t) => [t.id, text(t)] as const)),
      })).where(kx.inList(db, "id", end.map((t) => t.id), "bigint")).where("state", "in", OPEN));
    }
    return { lost: live.length, files };
  });
}

/** The claimed or running tasks that have no pod run (the pod launcher owns those) and no heartbeat for LOST_AFTER_MS. */
export async function loadStaleTasks(db: Db, nowMs: number): Promise<number[]> {
  const q = queryDb(db);
  const cutoff = new Date(nowMs - LOST_AFTER_MS).toISOString();
  return (await q.all(q.k.selectFrom("build_tasks").select("id").where("state", "in", OPEN).where("heartbeat_at", "<", cutoff)
    .where((eb) => eb("id", "not in", eb.selectFrom("build_pod_runs").select("task_id"))).orderBy("id"))).map((t) => t.id);
}

/**
 * Loses the stale tasks (loadStaleTasks), read again under the lock. `seen`: what the caller read already; with none stale nothing
 * is sent, else 8 statements.
 */
export async function reapStaleTasks(db: Db, nowMs: number, seen?: number[]): Promise<{ lost: number; files: number[] }> {
  if ((seen ?? await loadStaleTasks(db, nowMs)).length === 0) return { lost: 0, files: [] };
  return await db.write(async () => {
    const ids = await loadStaleTasks(db, nowMs);
    return await loseTasks(db, ids.map((id) => ({ id, reason: "The worker stopped answering twice (no heartbeat for 2 minutes)." })), nowMs);
  });
}

/**
 * One batch of up to 200 tasks: those whose artifacts expired (rows removed), else those whose rows expired (artifact rows, logs and
 * tasks removed). The caller loops until both lists are empty and removes the artifact directories of `artifactIds` after each
 * batch. 5 statements.
 */
export async function pruneTaskBatch(db: Db, a: { nowMs: number }): Promise<{ artifactIds: number[]; deleted: number[] }> {
  const q = queryDb(db);
  const artifactsBefore = new Date(a.nowMs - ARTIFACT_KEEP_MS).toISOString();
  const before = new Date(a.nowMs - KEEP_MS).toISOString();
  return await db.write(async () => {
    const expiredArtifacts = (await q.all(q.k.selectFrom("build_tasks").select("id").where("ended_at", "is not", null).where("ended_at", "<", artifactsBefore).where("artifact_bytes", ">", 0)
      .where("state", "in", [...TERMINAL]).orderBy("ended_at").limit(200))).map((r) => r.id);
    if (expiredArtifacts.length) return { artifactIds: await removeArtifactRows(db, expiredArtifacts), deleted: [] };
    const expired = (await q.all(q.k.selectFrom("build_tasks").select("id").where("ended_at", "is not", null).where("ended_at", "<", before)
      .where("state", "in", [...TERMINAL]).orderBy("ended_at").limit(200))).map((r) => r.id);
    if (expired.length === 0) return { artifactIds: [], deleted: [] };
    const artifactIds = await removeArtifactRows(db, expired);
    await q.run(q.k.deleteFrom("build_task_logs").where(kx.inList(db, "task_id", expired, "bigint")));
    await q.run(q.k.deleteFrom("build_tasks").where(kx.inList(db, "id", expired, "bigint")));
    return { artifactIds, deleted: expired };
  });
}
