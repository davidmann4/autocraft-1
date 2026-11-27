// The fence of a process that works as the leader of a role (src/db/leader.ts). Every write transaction it opens on
// Postgres checks, right after it takes the writer lock, that the role's lease (`leader_leases`) still has the epoch this
// process won; a later winner moves the epoch, so the writes of a process that lost its lease fail. Child processes inherit the fence through
// AUTOCRAFT_FENCE, so a job's writes are fenced with its runner's.
import { envVar } from "../env.ts";
import type { Db } from "./index.ts";
import { queryDb } from "./query-db.ts";

export type LeaderRole = "runner" | "periodic";
export const LEADER_ROLES: readonly LeaderRole[] = ["runner", "periodic"];

/** SQLSTATE of a write refused by the fence. */
export const FENCED_CODE = "ACF01";

export type Fence = { role: LeaderRole; epoch: number };

/** undefined: not read from the environment yet. */
let fence: Fence | null | undefined;

function parseFence(v: string | undefined): Fence | null {
  const m = /^(runner|periodic):([1-9][0-9]{0,15})$/.exec(v ?? "");
  return m ? { role: m[1] as LeaderRole, epoch: Number(m[2]) } : null;
}

/** Fences this process's writes, and those of the processes and worker threads it starts from now on, to `f` (null: none). */
export function setFence(f: Fence | null): void {
  fence = f;
  if (f) process.env.AUTOCRAFT_FENCE = `${f.role}:${f.epoch}`;
  else delete process.env.AUTOCRAFT_FENCE;
}

export function currentFence(): Fence | null {
  if (fence === undefined) fence = parseFence(envVar("FENCE"));
  return fence;
}

/**
 * The statement a write transaction runs after its writer lock (empty when the process has no fence). The role and epoch
 * are checked values, so they go in as literals; the statement has no parameters and runs in the BEGIN round trip.
 */
export function fenceSql(): string {
  const f = currentFence();
  if (!f) return "";
  return `; DO $fence$BEGIN IF NOT EXISTS (SELECT 1 FROM leader_leases WHERE role = '${f.role}' AND epoch = ${f.epoch}) THEN `
    + `RAISE EXCEPTION 'this process no longer leads the ${f.role}: another copy took over' USING ERRCODE = '${FENCED_CODE}'; END IF; END$fence$`;
}

/** Whether `e` is a write the fence refused. */
export const isFenced = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === FENCED_CODE;

export class FencedError extends Error {
  readonly code = FENCED_CODE;
}

/**
 * Throws a FencedError when this process's fence no longer holds: for actions outside the database (Kubernetes calls).
 * Does nothing without a fence or on SQLite, where nothing is fenced.
 */
export async function assertFence(db: Db): Promise<void> {
  const f = currentFence();
  if (!f || db.dialect !== "postgres") return;
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("leader_leases").select("epoch").where("role", "=", f.role));
  if (r === undefined || Number(r.epoch) !== f.epoch) throw new FencedError(`this process no longer leads the ${f.role}: another copy took over`);
}
