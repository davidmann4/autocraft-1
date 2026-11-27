// Claim reads and the orphan return (package runners-a).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import { ciEq, excluded, indexedBy, inList, literal } from "../../db/kx.ts";
import type { ItemRef } from "../../../web/src/api/types.ts";
import { loadCooloffs } from "./cooloffs.ts";
import { goneCallExpr, loadLiveness } from "./calls-expiry.ts";
import { loadQueueFor, loadQueueSignature } from "./calls-queue-load.ts";
import { INTERACTIVE_PROMPTS, cachedQueue, dropQueueCache, lostLeaseExpr } from "./calls-shared.ts";
import { unlease } from "./calls-unlease.ts";
import { loadRunnerRole } from "./cross.ts";
import { loadRunnerSnapshot } from "./runner-snapshot.ts";
import { dropSnapshotCache } from "./snapshot-cache.ts";
import { DEFAULT_RESERVE, loadUserSettings } from "./user-settings.ts";
import type { ClaimCaller, ClaimFacts, LeaseSource, QueueSnapshot, RunnerSnapshot, UserSettings } from "./types.ts";

/** A login with no stored settings. */
const NO_SETTINGS: UserSettings = { reserve: { fiveHour: 20, weekly: 20 }, repos: [], maxCalls: null, interactiveSlots: null, manualOnly: false, skipTasks: [], taskItems: "all", runnerPrivate: false };

/**
 * The facts of a claim: role and idle flag, cool-off, settings, lease counts, queue signature, and, for the first try (`requestId`), the orphan lease of a
 * repeated claim and the lost and gone calls of the expiry. About 9 statements in one round trip.
 */
export async function loadClaimFacts(db: Db, caller: ClaimCaller, opts: { requestId?: string; now: number }): Promise<ClaimFacts> {
  const { now } = opts;
  const q = queryDb(db);
  const login = caller.login.toLowerCase();
  const first = opts.requestId !== undefined;
  const [role, cooled, settings, counts, signature, orphan, liveness, lost, gone] = await db.together(async () => await Promise.all([
    loadRunnerRole(db, caller.tokenId, now),
    loadCooloffs(db, [login], now),
    loadUserSettings(db, [login]),
    q.get(q.k.selectFrom(indexedBy(db, "main.remote_calls", "remote_calls_leased", "c")).select((eb) => [
      eb.fn.coalesce(eb.fn.sum<number>(eb.case().when("c.own_lane", "=", 1).then(0).else(1).end()), eb.lit(0)).as("leased"),
      eb.fn.coalesce(eb.fn.sum<number>(eb.case().when(eb.and([eb("c.own_lane", "=", 1), eb.or(INTERACTIVE_PROMPTS.map((p) => eb("c.prompt_id", "like", `${p}%`)))])).then(1).else(0).end()), eb.lit(0)).as("interactive")])
      .where("c.state", "=", literal("leased")).where((eb) => ciEq(db, "c.user_login", eb.val(caller.login)))),
    loadQueueSignature(db),
    first ? q.get(q.k.selectFrom("main.remote_calls").select(["id", "run_id", "lease_secret_hash"]).where("token_id", "=", caller.tokenId).where("claim_id", "=", opts.requestId!).where("state", "=", literal("leased"))) : Promise.resolve(undefined),
    loadLiveness(db, now),
    first ? q.all(q.k.selectFrom("main.remote_calls").select("id").where((eb) => lostLeaseExpr(db, eb, now))) : Promise.resolve([]),
    first ? q.all(q.k.selectFrom("main.remote_calls").select("id").where((eb) => goneCallExpr(db, eb, now))) : Promise.resolve([]),
  ]));
  const c = cooled.get(login);
  return {
    role: (role?.role as ClaimFacts["role"]) ?? null, idle: role?.idleClaimAt != null, cooled: c ? { until: Date.parse(c.until), reason: c.reason } : null, settings: settings.get(login) ?? NO_SETTINGS,
    leased: Number(counts?.leased ?? 0), interactive: Number(counts?.interactive ?? 0), signature,
    orphan: orphan ? { id: Number(orphan.id), runId: orphan.run_id, leaseSecretHash: orphan.lease_secret_hash } : null, liveness,
    lost: lost.map((r) => Number(r.id)), gone: gone.map((r) => Number(r.id)),
  };
}

/**
 * Everything a claim decides on: the facts with, in the same wave, the runner snapshot and the queue where their 2 s caches do
 * not hold them. A cached queue that the facts' signature does not confirm costs one more wave.
 */
export async function loadClaim(db: Db, caller: ClaimCaller, opts: { requestId?: string; now: number }): Promise<{ facts: ClaimFacts; queue: QueueSnapshot; snapshot: RunnerSnapshot }> {
  const { now } = opts;
  const [facts, snapshot, queue] = await db.together(() => Promise.all([loadClaimFacts(db, caller, opts), loadRunnerSnapshot(db, now), cachedQueue(db, now) ? null : loadQueueFor(db, now)]));
  return { facts, snapshot, queue: queue ?? await loadQueueFor(db, now, facts.signature) };
}

/** The queued call about to be leased, with its bundle (not in the queue read). */
export async function loadLeaseSource(db: Db, id: number): Promise<LeaseSource | null> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("main.remote_calls").select(["bundle", "base_stdin", "job_id", "step", "stage", "prompt_id", "prompt_version", "asked_model", "items"]).where("id", "=", id).where("state", "=", "queued"));
  return r ? { bundle: r.bundle, baseStdin: r.base_stdin, jobId: r.job_id, step: r.step, stage: Number(r.stage), promptId: r.prompt_id, promptVersion: r.prompt_version, askedModel: r.asked_model, items: JSON.parse(r.items) as ItemRef[] } : null;
}

/**
 * Records an idle helper's tiers and repos. A helper that has not reported a status yet gets its row here, with no status
 * (`reported_at = 0`, as `addHelper` makes it).
 */
export async function markHelperIdle(db: Db, caller: ClaimCaller, a: { now: number; tiers: string[]; repos: string[] | null }): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.remote_helpers")
    .values({
      token_id: caller.tokenId, login: caller.login, readiness: "paused", harness: "claude", models: "{}", reserve: JSON.stringify(DEFAULT_RESERVE), reported_at: 0,
      idle_claim_at: a.now, idle_tiers: JSON.stringify(a.tiers), idle_repos: a.repos ? JSON.stringify(a.repos) : null, login_renews_at: null,
    })
    .onConflict((oc) => oc.column("token_id").doUpdateSet(excluded(["idle_claim_at", "idle_tiers", "idle_repos", "login_renews_at"]))));
  dropSnapshotCache(db);
}

/** Records when a helper's harness login renews (null: its claims have the room again); a helper with no status row yet gets none. */
export async function markLoginRenewal(db: Db, tokenId: number, at: number | null): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.updateTable("main.remote_helpers").set({ login_renews_at: at }).where("token_id", "=", tokenId));
  dropSnapshotCache(db);
}

/** Clears picks of calls, optionally only those of `login`. */
export async function clearPicks(db: Db, ids: number[], login?: string): Promise<number> {
  if (!ids.length) return 0;
  const q = queryDb(db);
  const r = await q.run(q.k.updateTable("main.remote_calls").set({ picked_by: null, picked_at: null, pick_until: null }).where(inList(db, "id", ids, "bigint"))
    .where((eb) => (login === undefined ? eb("picked_by", "is not", null) : eb("picked_by", "=", login))));
  if (Number(r.changes) > 0) dropQueueCache(db);
  return Number(r.changes);
}

/** Returns the lease a repeated claim took before a restart: unlease, tombstone and run failure in one transaction. */
export async function returnOrphanLease(db: Db, orphan: { id: number; runId: number | null; leaseSecretHash: string | null }, now: number): Promise<void> {
  await unlease(db, { id: orphan.id, runId: orphan.runId, hash: orphan.leaseSecretHash }, "returned to the queue: the claim that leased it was repeated after a server restart", now);
}
