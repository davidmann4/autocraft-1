// Row mapping shared by the task, claim, environment and artifact files (internal: not exported from index.ts).
import type { Expression, RawBuilder, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import type { Eb } from "../../db/kx.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { ONLINE_MS } from "./types.ts";
import type { BuildEnv, EnvHealth, EnvRecord, EnvTask, IdSource, Requires, SandboxEnv, TaskRecord, TaskResult, TaskState, TaskStep } from "./types.ts";

export const parseJson = <T>(s: string | null | undefined, fallback: T): T => {
  if (s === null || s === undefined) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export const refKey = (repo: string, number: number): string => `${repo}#${number}`;

/** The task columns without the patch (it can be a megabyte); `has_patch` stands for it. */
export const TASK_COLUMNS = [
  "t.id", "t.job_id", "t.step", "t.repo", "t.number", "t.head_sha", "t.base_sha", "t.requires", "t.priority", "t.plan", "t.state", "t.env_id", "t.attempts",
  "t.queued_at", "t.claimed_at", "t.started_at", "t.ended_at", "t.heartbeat_at", "t.cancel_requested_at", "t.results", "t.summary", "t.log_bytes",
  "t.artifact_bytes", "t.warm_key", "t.warm_role", "t.sandbox_env", "t.warm_image", "t.warm_version", "t.warm_rev",
] as const;

export type TaskDbRow = {
  id: number; job_id: number | null; step: string; repo: string; number: number | null; head_sha: string; base_sha: string | null; requires: string;
  priority: number; plan: string; state: string; env_id: string | null; attempts: number; queued_at: string; claimed_at: string | null;
  started_at: string | null; ended_at: string | null; heartbeat_at: string | null; cancel_requested_at: string | null; results: string; summary: string | null;
  log_bytes: number; artifact_bytes: number; warm_key: string | null; warm_role: string | null; sandbox_env: string | null; warm_image: string | null;
  warm_version: string | null; warm_rev: number | null; has_patch: number | boolean; patch?: string | null;
};

/** `has_patch` as a select item beside `TASK_COLUMNS`. */
export const hasPatchExpr = (eb: Eb) => eb.case().when("t.patch", "is", null).then(0).else(1).end().as("has_patch");

export function toTask(r: TaskDbRow): TaskRecord {
  return {
    id: r.id, jobId: r.job_id, step: r.step, repo: r.repo, number: r.number, headSha: r.head_sha, baseSha: r.base_sha, requires: parseJson<Requires>(r.requires, {}),
    priority: r.priority, plan: parseJson<TaskStep[]>(r.plan, []), state: r.state as TaskState, envId: r.env_id, attempts: r.attempts, queuedAt: r.queued_at,
    claimedAt: r.claimed_at, startedAt: r.started_at, endedAt: r.ended_at, heartbeatAt: r.heartbeat_at, cancelRequestedAt: r.cancel_requested_at,
    results: parseJson<TaskResult[]>(r.results, []), summary: r.summary, logBytes: r.log_bytes, artifactBytes: r.artifact_bytes, hasPatch: !!Number(r.has_patch),
    warmKey: r.warm_key, warmRole: r.warm_role === "use" || r.warm_role === "build" ? r.warm_role : null, warmImage: r.warm_image, warmVersion: r.warm_version,
    warmRev: r.warm_rev, sandbox: parseJson<SandboxEnv | null>(r.sandbox_env, null),
  };
}

/** `col IN ids`: a JSON-bound list, or an id subquery from a fragment. */
export function idsIn(db: Db, eb: Eb, col: string, ids: IdSource): Expression<SqlBool> {
  return Array.isArray(ids) ? kx.inList(db, col, ids, "bigint") : eb(col as never, "in", ids as never);
}

/** The step of each listed task's newest log chunk; one windowed statement. */
export async function lastLogSteps(db: Db, ids: IdSource): Promise<Map<number, string>> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom((eb) => eb.selectFrom("build_task_logs as l").select(["l.task_id", "l.step", (e) => e.fn.agg<number>("row_number").over((o) => o.partitionBy("l.task_id").orderBy("l.seq", "desc")).as("rn")])
    .where((e) => idsIn(db, e, "l.task_id", ids)).as("w")).select(["w.task_id", "w.step"]).where("w.rn", "=", 1), { label: "build.lastLogSteps" });
  return new Map(rows.map((r) => [r.task_id, r.step]));
}


/** The byte length of the text in `col`. */
export const byteLen = (db: Db, col: string): RawBuilder<number> => kx.byteLength(db, col);

/** The name of the first plan step with no result yet; null when the plan or results cannot be read. */
export function currentStep(plan: string | null, results: string | null): string | null {
  try {
    const done = new Set((JSON.parse(results || "[]") as { step: string }[]).map((x) => x.step));
    return (JSON.parse(plan || "[]") as { name: string }[]).find((s) => !done.has(s.name))?.name ?? null;
  } catch {
    return null;
  }
}

export const ENV_COLUMNS = [
  "e.id", "e.label", "e.kind", "e.enabled", "e.slots", "e.confidential", "e.confidential_since", "e.confidential_online_at", "e.key_hash", "e.capabilities",
  "e.reported_slots", "e.version", "e.paused_reason", "e.last_seen_at", "e.created_at", "e.updated_by", "e.updated_at", "e.settings", "e.health",
] as const;

export type EnvDbRow = {
  id: string; label: string; kind: string; enabled: number; slots: number; confidential: number; confidential_since: string | null; confidential_online_at: string | null;
  key_hash: string; capabilities: string | null; reported_slots: number | null; version: string | null; paused_reason: string | null; last_seen_at: string | null;
  created_at: string; updated_by: string | null; updated_at: string | null; settings: string | null; health: string | null;
};

/** The task row of an environment's list of running tasks. */
export type RunningRow = { id: number; env_id: string | null; step: string; repo: string; number: number | null; plan: string; results: string; started_at: string | null; claimed_at: string | null };
export const toEnvTask = (r: RunningRow): EnvTask => ({ id: r.id, step: r.step, repo: r.repo, number: r.number, current: currentStep(r.plan, r.results), startedAt: r.started_at ?? r.claimed_at ?? "" });

export function toEnv(r: EnvDbRow, tasks: EnvTask[], nowMs: number): EnvRecord {
  const online = r.last_seen_at !== null && nowMs - Date.parse(r.last_seen_at) < ONLINE_MS;
  return {
    id: r.id, label: r.label, kind: r.kind as BuildEnv["kind"], enabled: r.enabled === 1, online, lastSeenAt: r.last_seen_at, slots: Math.min(r.slots, r.reported_slots ?? r.slots),
    running: tasks.length, tasks, capabilities: parseJson<BuildEnv["capabilities"]>(r.capabilities, null), version: r.version,
    pausedReason: r.enabled === 1 && online ? r.paused_reason : null, confidential: r.confidential === 1, keyHash: r.key_hash,
    settings: parseJson<unknown>(r.settings, null), health: parseJson<EnvHealth | null>(r.health, null), confidentialOnlineAt: r.confidential_online_at,
    operatorSlots: r.slots, reportedSlots: r.reported_slots, confidentialSince: r.confidential_since, updatedBy: r.updated_by, updatedAt: r.updated_at, createdAt: r.created_at,
  };
}
