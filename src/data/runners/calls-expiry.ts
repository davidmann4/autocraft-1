// Lease expiry, liveness and lease state reads (package runners-a).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import { inList, least, ref, schemaEb, type Eb } from "../../db/kx.ts";
import { earlierRunCall } from "../jobs/fragments.ts";
import { noteDrops } from "./cooloffs.ts";
import { deleteOrphanHelpers } from "./cross.ts";
import { ALIVE_STALE_MS, CALLER_GONE_MS, DROP_WINDOW_MS, FAILURE_WINDOW_MS, KEEP_MS, LEASE_PREFIX, dropQueueCache, lostLeaseExpr, lostReasonExpr, queuedMsAfter, sha256hex } from "./calls-shared.ts";
import { bury, finishCalls } from "./calls-unlease.ts";
import type { ClaimFacts, ExpiryResult } from "./types.ts";

/** Queued and leased calls whose caller stopped polling. The calls of a resumed job's earlier runs have no caller until the resumed run adopts them. */
export const goneCallExpr = (db: Db, eb: Eb, now: number) =>
  eb.and([eb("state", "in", ["queued", "leased"]), eb("seen_at", "<", now - CALLER_GONE_MS), eb.not(earlierRunCall(db, eb))]);

const none = (): ExpiryResult => ({ requeued: [], failed: [], withdrawn: [], beaten: [] });

/**
 * Requeues or fails lost leases (one `UPDATE` whose `WHERE` repeats the lost test, so a lease that is no longer lost is left alone), writes tombstones,
 * finishes the runs, notes drops, and withdraws calls whose caller is gone, in one transaction after one read wave unless `facts` carries the reads.
 */
export async function expireLeases(db: Db, o: { now: number; ids?: number[]; facts?: ClaimFacts }): Promise<ExpiryResult> {
  const { now } = o;
  const q = queryDb(db);
  const only = o.ids ? new Set(o.ids) : null;
  let lost: number[], gone: number[];
  if (o.facts) {
    lost = o.facts.lost.filter((i) => !only || only.has(i));
    gone = o.facts.gone.filter((i) => !only || only.has(i));
  } else {
    const [l, g] = await db.together(async () => await Promise.all([
      q.all(q.k.selectFrom("main.remote_calls").select("id").where((eb) => lostLeaseExpr(db, eb, now)).$if(!!o.ids, (b) => b.where(inList(db, "id", o.ids!, "bigint")))),
      q.all(q.k.selectFrom("main.remote_calls").select("id").where((eb) => goneCallExpr(db, eb, now)).$if(!!o.ids, (b) => b.where(inList(db, "id", o.ids!, "bigint")))),
    ]));
    lost = l.map((r) => Number(r.id));
    gone = g.map((r) => Number(r.id));
  }
  if (!lost.length && !gone.length) return none();
  return await db.write(async () => {
    const out = none();
    if (lost.length) {
      const pre = await q.all(q.k.selectFrom("main.remote_calls").select(["id", "run_id", "lease_secret_hash", "token_id", "user_login", "heartbeat_at", "leased_at"])
        .where(inList(db, "id", lost, "bigint")).where("state", "=", "leased"));
      const ups = await q.all(q.k.updateTable("main.remote_calls").set((eb) => {
        const w = schemaEb(eb) as any;
        const fail = w("attempt", ">=", w.ref("max_attempts"));
        return {
          state: w.case().when(fail).then("failed").else("queued").end(), attempt: w("attempt", "+", w.case().when(fail).then(0).else(1).end()),
          lease_secret_hash: null, token_id: null, claim_id: null, lease_timeout_ms: null, started_at: null,
          queued_since: w.case().when(fail).then(w.lit(null)).else(now).end(), ended_at: w.case().when(fail).then(now).else(w.lit(null)).end(),
          error: lostReasonExpr(eb, now), progress: null, picked_by: null, picked_at: null, pick_until: null,
        } as any;
      }).where(inList(db, "id", lost, "bigint")).where("state", "=", "leased").where((eb) => lostLeaseExpr(db, eb, now)).returning(["id", "run_id", "state", "error"]));
      const was = new Map(pre.map((r) => [Number(r.id), r]));
      for (const u of ups) (u.state === "failed" ? out.failed : out.requeued).push(Number(u.id));
      await bury(db, ups.map((u) => ({ id: Number(u.id), hash: was.get(Number(u.id))?.lease_secret_hash ?? null })), now);
      await finishCalls(db, ups.filter((u) => u.run_id !== null).map((u) => ({ id: u.run_id!, state: "failed" as const, error: u.error, summary: "lease ended" })));
      // A lease that never had a heartbeat does not count toward a cool-off: the helper most likely never got the claim's reply.
      const drops = ups.flatMap((u) => {
        const r = was.get(Number(u.id));
        return r && Number(r.heartbeat_at) > Number(r.leased_at) && r.token_id !== null && r.user_login !== null ? [{ tokenId: Number(r.token_id), login: r.user_login, callId: Number(u.id) }] : [];
      });
      if (drops.length) out.beaten = await noteDrops(db, drops, now);
    }
    const reason = "the caller stopped waiting";
    // A requeued lost lease changes what is gone, so with lost leases the test runs afresh instead of on the ids read.
    const ended = await q.all(q.k.updateTable("main.remote_calls").set((eb) => ({ state: "failed", error: reason, ended_at: now, queued_ms: queuedMsAfter(db, eb, now), queued_since: null }) as any)
      .where((eb) => goneCallExpr(db, eb, now)).$if(!lost.length, (b) => b.where(inList(db, "id", gone, "bigint"))).$if(!!o.ids, (b) => b.where(inList(db, "id", o.ids!, "bigint")))
      .returning(["id", "run_id"]));
    out.withdrawn = ended.map((r) => Number(r.id));
    await finishCalls(db, ended.filter((r) => r.run_id !== null).map((r) => ({ id: r.run_id!, state: "failed" as const, error: reason, summary: "withdrawn" })));
    if (out.requeued.length || out.failed.length || out.withdrawn.length) dropQueueCache(db);
    return out;
  });
}

/** The call by secret hash, else its tombstone, as one statement. */
export async function loadLeaseState(db: Db, secret: string): Promise<{ id: number; live: boolean } | null> {
  if (!secret || secret.length > 200 || !secret.startsWith(LEASE_PREFIX)) return null;
  const hash = sha256hex(secret);
  const q = queryDb(db);
  const calls = q.k.selectFrom("main.remote_calls").select((eb) => [eb.lit(0).as("rank"), "id", eb.case().when("state", "=", "leased").then(1).else(0).end().as("live")]).where("lease_secret_hash", "=", hash);
  const dead = q.k.selectFrom("main.remote_lease_tombstones").select((eb) => [eb.lit(1).as("rank"), "call_id as id", eb.lit(0).as("live")]).where("secret_hash", "=", hash);
  const r = await q.get(q.k.selectFrom(calls.unionAll(dead as any).as("u")).selectAll().orderBy("rank").limit(1));
  return r ? { id: Number(r.id), live: Number(r.live) === 1 } : null;
}

/** Deletes old calls, tombstones, drops, checks, passages and cool-offs in one transaction. */
export async function pruneRemote(db: Db, now: number): Promise<void> {
  const old = now - KEEP_MS;
  const q = queryDb(db);
  await db.write(async () => {
    // Each condition is a range of the (state, ended_at) indexes; a row without ended_at goes by when it began.
    await q.run(q.k.deleteFrom("main.remote_calls").where("state", "in", ["done", "failed"]).where((eb) => eb.or([eb("ended_at", "<", old), eb.and([eb("ended_at", "is", null), eb("since", "<", old)])])));
    await q.run(q.k.deleteFrom("main.remote_call_items").where((eb) => eb.not(eb.exists(q.k.selectFrom("main.remote_calls as c").select(eb.lit(1).as("one")).where("c.id", "=", ref<number>("remote_call_items.call_id"))))));
    await q.run(q.k.deleteFrom("main.remote_checks").where("state", "=", "done").where((eb) => eb.or([eb("ended_at", "<", old), eb.and([eb("ended_at", "is", null), eb("requested_at", "<", old)])])));
    await q.run(q.k.deleteFrom("main.remote_lease_tombstones").where("at", "<", old));
    await q.run(q.k.deleteFrom("main.remote_passages").where("at", "<", old));
    await q.run(q.k.deleteFrom("main.remote_lease_drops").where("at", "<", now - DROP_WINDOW_MS));
    await q.run(q.k.deleteFrom("main.remote_cooloffs").where((eb) => eb.and([eb(eb.fn.coalesce("until", eb.lit(0)), "<=", now),
      eb.or([eb("failures", "=", 0), eb("failures_since", "<", now - FAILURE_WINDOW_MS)])])));
    await deleteOrphanHelpers(db);
  });
}

/** Stamps `remote_liveness`; one statement usually, a transaction after a gap. */
export async function stampAlive(db: Db, now: number): Promise<void> {
  // Called inside a transaction: the next tick stamps.
  if (db.inTransaction()) return;
  const q = queryDb(db);
  const fresh = await q.run(q.k.updateTable("main.remote_liveness").set({ alive_at: now }).where("id", "=", 1).where("alive_at", ">=", now - ALIVE_STALE_MS));
  if (fresh.changes === 1) return;
  await db.write(async () => {
    const r = await q.get(q.k.selectFrom("main.remote_liveness").select("alive_at").where("id", "=", 1));
    if (!r) await q.run(q.k.insertInto("main.remote_liveness").values({ id: 1, alive_at: now, since: now }));
    else if (now - Number(r.alive_at) > ALIVE_STALE_MS) {
      // After a gap every leased call's heartbeat, lease and run start move forward by the gap, so neither the idle window nor the time limit counts the time no helper could reach the server.
      const gap = now - Number(r.alive_at);
      await q.run(q.k.updateTable("main.remote_calls").set((eb) => ({
        heartbeat_at: least(db, [eb("heartbeat_at", "+", gap), eb.val(now)]), leased_at: least(db, [eb("leased_at", "+", gap), eb.val(now)]),
        started_at: eb.case().when("started_at", "is", null).then(eb.lit(null)).else(least(db, [eb("started_at", "+", gap), eb.val(now)])).end(),
      })).where("state", "=", "leased"));
      await q.run(q.k.updateTable("main.remote_liveness").set({ alive_at: now, since: now }).where("id", "=", 1));
    } else await q.run(q.k.updateTable("main.remote_liveness").set({ alive_at: now }).where("id", "=", 1));
  });
}

/** The liveness stamp. A database no dashboard ever stamped counts as always alive. */
export async function loadLiveness(db: Db, now: number): Promise<{ alive: boolean; since: number }> {
  const q = queryDb(db);
  return aliveOf(await q.get(q.k.selectFrom("main.remote_liveness").select(["alive_at", "since"]).where("id", "=", 1)), now);
}

export function aliveOf(r: { alive_at: number; since: number } | undefined, now: number): { alive: boolean; since: number } {
  return r ? { alive: now - Number(r.alive_at) <= ALIVE_STALE_MS, since: Number(r.since) } : { alive: true, since: -Infinity };
}
