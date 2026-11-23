// The dashboard's liveness stamp. Helpers reach the server only through the dashboard, so while it is down, stalled or
// restarting no heartbeat can arrive, and a lease must not be counted as lost for that. The dashboard stamps the
// `remote_liveness` row every ALIVE_EVERY_MS; job processes, which expire leases (calls.ts expireLeases), read it.
import { isBusy } from "../db.ts";
import { scaled } from "./time-scale.ts";
import { exclusive } from "../async-seq.ts";
import type { Db } from "../db/index.ts";
import { least } from "../db/kx.ts";

export const ALIVE_EVERY_MS = scaled(5_000);
/** A stamp older than this means the dashboard is not serving: down, stalled or restarting. */
export const ALIVE_STALE_MS = 3 * ALIVE_EVERY_MS;

/**
 * Writes the stamp. After a gap (the previous stamp is stale) every leased call's heartbeat, lease and run start move
 * forward by the gap, capped at now, so neither the idle window nor the time limit counts the time no helper could reach
 * the server; the unbroken run of stamps then starts afresh.
 */
export async function stampAlive(db: Db, nowMs: number = Date.now()): Promise<void> {
  // Called inside a transaction: the next tick stamps.
  if (db.inTransaction()) return;
  // The usual stamp is one statement on the row alone; a stale stamp takes the writer lock to move the leases with it.
  const fresh = await db.run(db.k.updateTable("main.remote_liveness").set({ alive_at: nowMs }).where("id", "=", 1).where("alive_at", ">=", nowMs - ALIVE_STALE_MS));
  if (fresh.changes === 1) return;
  await db.write(async () => {
    const r = await db.get(db.k.selectFrom("main.remote_liveness").select("alive_at").where("id", "=", 1));
    if (!r) await db.run(db.k.insertInto("main.remote_liveness").values({ id: 1, alive_at: nowMs, since: nowMs }));
    else if (nowMs - Number(r.alive_at) > ALIVE_STALE_MS) {
      const gap = nowMs - Number(r.alive_at);
      await db.run(db.k.updateTable("main.remote_calls").set((eb) => ({
        heartbeat_at: least(db, [eb("heartbeat_at", "+", gap), eb.val(nowMs)]),
        leased_at: least(db, [eb("leased_at", "+", gap), eb.val(nowMs)]),
        started_at: eb.case().when("started_at", "is", null).then(eb.lit(null)).else(least(db, [eb("started_at", "+", gap), eb.val(nowMs)])).end(),
      })).where("state", "=", "leased"));
      await db.run(db.k.updateTable("main.remote_liveness").set({ alive_at: nowMs, since: nowMs }).where("id", "=", 1));
    } else await db.run(db.k.updateTable("main.remote_liveness").set({ alive_at: nowMs }).where("id", "=", 1));
  });
}

/**
 * Whether the dashboard is serving now, and since when without a gap. A database the dashboard never stamped (no
 * dashboard has run against it) counts as always alive.
 */
export async function dashboardAlive(db: Db, nowMs: number): Promise<{ alive: boolean; since: number }> {
  return aliveOf(await db.get(livenessRow(db)), nowMs);
}

/** The stamp row dashboardAlive reads. */
export const livenessRow = (db: Db) => db.k.selectFrom("main.remote_liveness").select(["alive_at", "since"]).where("id", "=", 1);

/** dashboardAlive for the stamp row already read (undefined: none). */
export function aliveOf(r: { alive_at: number; since: number } | undefined, nowMs: number): { alive: boolean; since: number } {
  if (!r) return { alive: true, since: -Infinity };
  return { alive: nowMs - Number(r.alive_at) <= ALIVE_STALE_MS, since: Number(r.since) };
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
