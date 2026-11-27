// The dashboard's liveness stamp. Helpers reach the server only through the dashboard, so while it is down, stalled or
// restarting no heartbeat can arrive, and a lease must not be counted as lost for that. The dashboard stamps the
// `remote_liveness` row every ALIVE_EVERY_MS (runners.stampAlive); job processes, which expire leases, read it.
import { isBusy } from "../db.ts";
import { scaled } from "./time-scale.ts";
import { exclusive } from "../async-seq.ts";
import type { Db } from "../db/index.ts";
import * as runners from "../data/runners/index.ts";

export { aliveOf } from "../data/runners/index.ts";

export const ALIVE_EVERY_MS = scaled(5_000);
/** A stamp older than this means the dashboard is not serving: down, stalled or restarting. */
export const ALIVE_STALE_MS = 3 * ALIVE_EVERY_MS;

/** Writes the stamp; after a gap the leased calls' times move forward by it (runners.stampAlive). */
export async function stampAlive(db: Db, nowMs: number = Date.now()): Promise<void> {
  await runners.stampAlive(db, nowMs);
}

/** Whether the dashboard is serving now, and since when without a gap. A database never stamped counts as always alive. */
export async function dashboardAlive(db: Db, nowMs: number): Promise<{ alive: boolean; since: number }> {
  return await runners.loadLiveness(db, nowMs);
}

/** Starts the stamp timer in the dashboard process; returns the function that stops it. */
export async function startLiveness(db: Db): Promise<() => void> {
  const tick = async (): Promise<void> => {
    try { await stampAlive(db); } catch (e) { if (!isBusy(e)) console.log(`liveness stamp not written: ${(e as Error).message}`); }
  };
  const stamp = exclusive(tick);
  await stamp.run();
  const t = setInterval(() => void stamp.skip(), ALIVE_EVERY_MS);
  t.unref();
  return () => clearInterval(t);
}
