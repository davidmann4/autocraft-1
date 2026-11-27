// Workspace sessions (`workspace_sessions`) (package build-b).
// reads: jobs.jobs (through jobs.fragments.jobEnded and jobs.loadJobs)
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { loadJobs } from "../jobs/index.ts";
import { jobEnded } from "../jobs/fragments.ts";
import { patchRows } from "./row-patch.ts";
import type { NewSession, SessionRow, SessionSource, SweptSession } from "./types.ts";

const NUMERIC = ["item", "keep", "deadline_sec", "workspace_id", "remote_call_id", "job_id"] as const;
const OPEN = ["queued", "starting", "running"];

/** Insert returning the id. 1 statement. */
export async function addSession(db: Db, row: NewSession): Promise<number> {
  const q = queryDb(db);
  const r = await db.write(async () => await q.get(q.k.insertInto("main.workspace_sessions").values(row).returning("id")));
  return Number(r!.id);
}

/**
 * Sessions by ids, workspace ids, remote call id or job id, oldest first within a key. The key is the session id for `ids`, the workspace id
 * for `workspaceIds`, the call id for `remoteCallId` and the job id for `jobId`. 1 statement.
 */
export async function loadSessions(db: Db, src: SessionSource): Promise<Map<number, SessionRow[]>> {
  const out = new Map<number, SessionRow[]>();
  if (("ids" in src && !src.ids.length) || ("workspaceIds" in src && !src.workspaceIds.length)) return out;
  const q = queryDb(db);
  let b = q.k.selectFrom("main.workspace_sessions").selectAll().orderBy("id");
  if ("ids" in src) b = b.where(kx.inList(db, "id", src.ids, "bigint"));
  else if ("workspaceIds" in src) b = b.where(kx.inList(db, "workspace_id", src.workspaceIds, "bigint"));
  else if ("remoteCallId" in src) b = b.where("remote_call_id", "=", src.remoteCallId);
  else b = b.where("job_id", "=", src.jobId);
  for (const r of await q.all(b)) {
    const key = "ids" in src ? Number(r.id) : "workspaceIds" in src ? Number(r.workspace_id) : "remoteCallId" in src ? src.remoteCallId : src.jobId;
    (out.get(key) ?? out.set(key, []).get(key)!).push(r as SessionRow);
  }
  return out;
}

/** The item and bound call of each workspace's sessions, oldest first, without prompts (lists read these). 1 statement. */
export async function loadSessionCalls(db: Db, workspaceIds: number[]): Promise<Map<number, { item: number | null; remoteCallId: number | null }[]>> {
  const out = new Map<number, { item: number | null; remoteCallId: number | null }[]>();
  if (!workspaceIds.length) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.workspace_sessions").select(["workspace_id", "item", "remote_call_id"]).where(kx.inList(db, "workspace_id", workspaceIds, "bigint")).orderBy("id"));
  for (const r of rows) {
    const id = Number(r.workspace_id);
    (out.get(id) ?? out.set(id, []).get(id)!).push({ item: r.item === null ? null : Number(r.item), remoteCallId: r.remote_call_id === null ? null : Number(r.remote_call_id) });
  }
  return out;
}

/**
 * Claims a session for a job: the first job to claim it, or the same job again, while the session has not ended. Returns the state the
 * session is in, or null for another job's session or one that ended (the job then touches nothing). 1 statement.
 */
export async function claimSession(db: Db, id: number, jobId: number): Promise<{ state: string } | null> {
  const q = queryDb(db);
  const r = await db.write(async () => await q.get(q.k.updateTable("main.workspace_sessions").set({ job_id: jobId, updated_at: new Date().toISOString() })
    .where("id", "=", id).where((eb) => eb.or([eb("job_id", "is", null), eb("job_id", "=", jobId)])).where("state", "in", OPEN).returning("state")));
  return r ? { state: r.state } : null;
}

/** Patches sessions (`whereState` is the compare-and-set); `updated_at` is set unless the patch sets it. Returns the number of rows changed. */
export async function patchSessions(db: Db, rows: { id: number; whereState?: string[]; set: Partial<Omit<SessionRow, "id">> }[]): Promise<number> {
  const at = new Date().toISOString();
  return (await patchRows(db, "workspace_sessions", rows.map((r) => ({ id: r.id, ...(r.whereState ? { from: r.whereState } : {}), set: { updated_at: at, ...r.set } })), NUMERIC)).size;
}

/**
 * Fails the open sessions whose job ended (done, failed or cancelled) without ending them: a job stopped by its deadline, a cancel or
 * a runner stop it may not resume from exits without running the session's own cleanup. A job queued to resume keeps its session.
 * Returns the sessions failed; the caller ends the workspaces of those that are not kept. 3 statements, 1 without a match.
 */
export async function sweepSessions(db: Db, nowIso: string): Promise<SweptSession[]> {
  const q = queryDb(db);
  const open = await q.all(q.k.selectFrom("main.workspace_sessions as s").select(["s.id", "s.workspace_id", "s.keep", "s.job_id"])
    .where("s.state", "in", OPEN).where("s.job_id", "is not", null).where((eb) => jobEnded(eb, "s.job_id")).orderBy("s.id"));
  if (!open.length) return [];
  const jobs = await loadJobs(db, [...new Set(open.map((r) => Number(r.job_id)))]);
  const outcomes = new Map(open.map((r) => {
    const j = jobs.get(Number(r.job_id));
    return [Number(r.id), `job ${r.job_id} ended (${j?.state}${j?.error ? `: ${j.error}` : ""}) before the session did`.slice(0, 300)];
  }));
  const failed = await patchRows(db, "workspace_sessions", open.map((r) => ({
    id: Number(r.id), from: OPEN, set: { state: "failed", outcome: outcomes.get(Number(r.id))!, ended_at: nowIso, updated_at: nowIso },
  })), NUMERIC);
  return open.filter((r) => failed.has(Number(r.id))).map((r) => {
    const j = jobs.get(Number(r.job_id));
    return { id: Number(r.id), workspaceId: r.workspace_id === null ? null : Number(r.workspace_id), keep: Number(r.keep) === 1, jobId: Number(r.job_id), jobState: j?.state ?? null, error: j?.error ?? null };
  });
}
