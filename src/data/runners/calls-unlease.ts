// Ending a lease without a reply: back to the queue, or failed (not exported by index.ts). Each joins the caller's transaction or opens its own.
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import { finishRuns } from "../inference/index.ts";
import type { RunEnd } from "../inference/types.ts";
import { dropQueueCache } from "./calls-shared.ts";

/** Keeps the secret hash of a lease that ended or went back to the queue, so its routes answer 410. */
export async function bury(db: Db, rows: { id: number; hash: string | null }[], now: number): Promise<void> {
  const v = rows.filter((r): r is { id: number; hash: string } => r.hash !== null).map((r) => ({ secret_hash: r.hash, call_id: r.id, at: now }));
  if (!v.length) return;
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.remote_lease_tombstones").values(v).onConflict((oc) => oc.doNothing()));
}

/** Who gave a lease back: their runners skip the call for `waitMs` (null: RELEASE_SKIP_MS); `setupRetry` counts a setup failure's short wait. */
export type ReleasedBy = { login: string; waitMs: number | null; setupRetry?: boolean };

/** Puts a leased call back in the queue without using an attempt; true when this call changed (the lease was still the one named). */
export async function unlease(db: Db, r: { id: number; runId: number | null; hash: string | null }, why: string, now: number, releasedBy: ReleasedBy | null = null): Promise<boolean> {
  return await db.write(async () => {
    const q = queryDb(db);
    const up = await q.run(q.k.updateTable("main.remote_calls").set((eb) => ({
      state: "queued", lease_secret_hash: null, token_id: null, claim_id: null, lease_timeout_ms: null, started_at: null, queued_since: now, error: why, progress: null, picked_by: null, picked_at: null, pick_until: null,
      ...(releasedBy !== null && { released_by: releasedBy.login, released_at: now, release_wait_ms: releasedBy.waitMs, ...(releasedBy.setupRetry && { setup_retries: eb("setup_retries", "+", 1) }) }),
    })).where("id", "=", r.id).where("state", "=", "leased").where((eb) => (r.hash === null ? eb("lease_secret_hash", "is", null) : eb("lease_secret_hash", "=", r.hash))));
    if (Number(up.changes) !== 1) return false;
    await bury(db, [{ id: r.id, hash: r.hash }], now);
    if (r.runId !== null) await finishRuns(db, [{ id: r.runId, state: "failed", error: why, summary: "returned to the queue" }]);
    dropQueueCache(db);
    return true;
  });
}

/**
 * A failed lease goes back to the queue with the next attempt, or fails once its attempts are used up. Compare-and-set on the lease secret
 * and attempt read, so only that lease ends. `skipLogin` keeps the login's runners from being offered the call again for a while.
 * Returns the new state, or null when the lease was not the one named.
 */
export async function requeue(db: Db, l: { id: number; runId: number | null; attempt: number; maxAttempts: number; hash: string }, reason: string, now: number, opts: { skipLogin?: string; summary?: string; tokens?: RunEnd["tokens"]; output?: Uint8Array } = {}): Promise<"queued" | "failed" | null> {
  const fail = l.attempt >= l.maxAttempts;
  const q = queryDb(db);
  const up = await q.run(q.k.updateTable("main.remote_calls").set((eb) => ({
    state: fail ? "failed" : "queued", attempt: eb("attempt", "+", fail ? 0 : 1), lease_secret_hash: null, token_id: null, claim_id: null, lease_timeout_ms: null, started_at: null, queued_since: fail ? null : now,
    ended_at: fail ? now : null, error: reason, progress: null, picked_by: null, picked_at: null, pick_until: null, ...(opts.skipLogin !== undefined && { released_by: opts.skipLogin, released_at: now, release_wait_ms: null }),
  })).where("id", "=", l.id).where("state", "=", "leased").where("attempt", "=", l.attempt).where("lease_secret_hash", "=", l.hash));
  if (Number(up.changes) !== 1) return null;
  await bury(db, [{ id: l.id, hash: l.hash }], now);
  if (l.runId !== null) await finishRuns(db, [{ id: l.runId, state: "failed", error: reason, summary: opts.summary ?? "lease ended", ...(opts.tokens && { tokens: opts.tokens }), ...(opts.output && { output: opts.output }) }]);
  dropQueueCache(db);
  return fail ? "failed" : "queued";
}

/** Ends the runs of withdrawn or lost calls; nothing is sent for none. */
export const finishCalls = async (db: Db, ends: RunEnd[]): Promise<void> => void (ends.length && await finishRuns(db, ends));
