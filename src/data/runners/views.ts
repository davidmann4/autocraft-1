// reads: access.mcp_tokens, access.access
// Read models for pages and health checks (package runners-b).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { loadTrackedRepos } from "../control/index.ts";
import { loadQueue } from "./calls-read.ts";
import { manualOnlyExpr } from "./fragments.ts";
import { runnerCredentials, runnerRowOf, STATUS_FRESH_MS } from "./helpers.ts";
import { loadRunnerSnapshot } from "./runner-snapshot.ts";
import type { LowerLogin, QueuedCall, ReadyRunner, RunnerHealth, RunnerRow, RunnerSnapshot, Tier } from "./types.ts";

/**
 * The runners that may take calls now, one per credential, from a snapshot: live, fresh, ready, their login not cooling off. `tiersOf` gives
 * the tiers a credential's models offer (accepted model families are the caller's policy). `free` is the slots left after the lane kept for
 * Interactive work and the login's "Max calls at once". Pure.
 */
export function readyRunnersOf(s: RunnerSnapshot, tiersOf: (models: RunnerRow["models"]) => ReadonlySet<Tier>): ReadyRunner[] {
  const out: ReadyRunner[] = [];
  for (const r of s.runners) {
    const login = r.login.toLowerCase();
    if (r.role === null || r.readiness !== "ready" || r.reportedAt === null || r.reportedAt < s.at - STATUS_FRESH_MS || s.cooled.has(login)) continue;
    const set = s.settings.get(login);
    const slots = (r.slots ?? 1) - ((r.slots ?? 1) >= 2 ? 1 : 0);
    const left = set?.maxCalls == null ? Infinity : Math.max(0, set.maxCalls - (s.leasedByLogin.get(login)?.leased ?? 0));
    out.push({
      login: r.login, role: r.role, manual: set?.manualOnly ?? false, tiers: tiersOf(r.models), free: Math.min(left, Math.max(0, slots - r.leased)),
      repos: set?.repos.length ? new Set(set.repos) : null, skip: new Set(set?.skipTasks ?? []),
    });
  }
  return out;
}

/**
 * The queue and the snapshot in one wave: the calls (the queue's rows carry `askedModel`, `queuedMs`, `queuedSince` and `error`), the
 * ready runners and the snapshot the page's pure rules read. The queue is not cut to calls with a live caller: the page filters on `seenAt`.
 */
export async function loadQueueView(db: Db, now: number, o: { tiersOf: (models: RunnerRow["models"]) => ReadonlySet<Tier> }): Promise<{ calls: QueuedCall[]; runners: ReadyRunner[]; snapshot: RunnerSnapshot }> {
  const [queue, snapshot] = await db.together(() => Promise.all([loadQueue(db, now), loadRunnerSnapshot(db, now)]));
  return { calls: queue.calls, runners: readyRunnersOf(snapshot, o.tiersOf), snapshot };
}

/**
 * Leasing credential per run, the helpers and every private login for the live board: credentials with a fresh status or a lease in the
 * window (expired ones included), newest login order. Lease counts of the helpers are not loaded (`leased`, `ownLaneLeased` are 0). 3 statements, 1 RT.
 */
export async function loadRunnerBoard(db: Db, now: number, windowMs: number): Promise<{ leases: Map<number, number>; helpers: RunnerRow[]; private: Set<LowerLogin> }> {
  const q = queryDb(db);
  const leasedIn = (eb: kx.Eb) => eb.or([eb("state", "=", "leased"), eb.and([eb("state", "in", ["done", "failed"]), eb("ended_at", ">", now - windowMs)])]);
  const [leases, helpers, kept] = await db.together(() => Promise.all([
    q.all(q.k.selectFrom("main.remote_calls").select(["run_id", "token_id"]).where("run_id", "is not", null).where("token_id", "is not", null).where((eb) => leasedIn(eb))),
    q.all(runnerCredentials(db, now, false).where((eb) => eb.or([eb("h.reported_at", ">", now - STATUS_FRESH_MS),
      eb("t.id", "in", eb.selectFrom("main.remote_calls").select("token_id").where("token_id", "is not", null).where((e) => leasedIn(e)))]))),
    q.all(q.k.selectFrom("main.user_settings").select("login").where("key", "=", "runner_private").where("value", "=", "1")),
  ]));
  return {
    leases: new Map(leases.map((l) => [Number(l.run_id), Number(l.token_id)] as const)),
    helpers: helpers.map(runnerRowOf).sort((a, b) => a.login.localeCompare(b.login) || a.tokenId - b.tokenId),
    private: new Set(kept.map((r) => r.login.toLowerCase())),
  };
}

/** The reads of the runner health checks. The thresholds are the caller's (scaled windows live in feature code). */
export type HealthThresholds = { queuedMs: number; tierWaitMs: Record<Tier, number>; interactiveWaitMs: number; callerStaleMs: number; noTakerMs: number };

/**
 * Counts and oldest queued time per bucket (queued calls with a live caller past the bucket's limit), the last lease time, ready and
 * Manual-only runner counts, the pipeline-on repos marked without a taker for `noTakerMs` and the operators' runners with their Interactive
 * slots. 6 statements, 1 RT.
 */
export async function loadRunnerHealth(db: Db, now: number, th: HealthThresholds): Promise<RunnerHealth> {
  const q = queryDb(db);
  const tiers = Object.keys(th.tierWaitMs) as Tier[];
  const buckets: { name: string; limit: number; tier?: Tier; interactive?: true }[] = [
    { name: "total", limit: th.queuedMs }, ...tiers.map((t) => ({ name: `tier_${t}`, limit: th.tierWaitMs[t], tier: t })), { name: "interactive", limit: th.interactiveWaitMs, interactive: true as const },
  ];
  const [counts, last, ready, noTaker, tracked, operators] = await db.together(() => Promise.all([
    q.get(q.k.selectFrom("main.remote_calls").select((eb) => buckets.flatMap((b) => {
      const past = eb.and([eb("queued_since", "<", now - b.limit), ...(b.tier ? [eb("tier", "=", b.tier)] : []), ...(b.interactive ? [eb("prompt_id", "like", "discord.%")] : [])]);
      return [eb.fn.coalesce(eb.fn.sum<number>(eb.case().when(past).then(1).else(0).end()), eb.lit(0)).as(`${b.name}_n`),
        eb.fn.min<number | null>(eb.case().when(past).then(eb.ref("queued_since")).end()).as(`${b.name}_oldest`)];
    })).where("state", "=", "queued").where("seen_at", ">=", now - th.callerStaleMs)),
    q.get(q.k.selectFrom("main.remote_calls").select((eb) => eb.fn.max<number | null>("leased_at").as("at"))),
    q.get(q.k.selectFrom("main.mcp_tokens as t").innerJoin("main.remote_helpers as h", "h.token_id", "t.id")
      .select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.coalesce(eb.fn.sum<number>(eb.case().when(manualOnlyExpr(eb, "t.login")).then(1).else(0).end()), eb.lit(0)).as("manual")])
      .where("t.kind", "=", "runner").where("t.expires_at", ">", new Date(now).toISOString()).where("h.readiness", "=", "ready").where("h.reported_at", ">=", now - STATUS_FRESH_MS)),
    q.all(q.k.selectFrom("main.remote_no_taker").select(["repo", "since"]).where("since", "<=", now - th.noTakerMs).orderBy("repo")),
    loadTrackedRepos(db),
    q.all(q.k.selectFrom("main.mcp_tokens as t").innerJoin("main.access as a", "a.login", "t.login")
      .leftJoin("main.user_settings as us", (j) => j.onRef("us.login", "=", "t.login").on("us.key", "=", "interactive_slots"))
      .select(["t.login", "us.value as slots"]).where("t.kind", "=", "runner").where("t.expires_at", ">", new Date(now).toISOString()).where("a.role", "=", "operator").orderBy("t.id")),
  ]));
  const row = counts as Record<string, unknown>;
  const bucket = (name: string): { n: number; oldestMs: number | null } => ({ n: Number(row[`${name}_n`] ?? 0), oldestMs: row[`${name}_oldest`] == null ? null : Number(row[`${name}_oldest`]) });
  const total = bucket("total");
  const slotsOf = (v: string | null): number | null => { const n = v === null ? NaN : Number(v); return Number.isInteger(n) && n >= 0 ? n : null; };
  return {
    queued: { total: total.n, oldestMs: total.oldestMs, byTier: Object.fromEntries(tiers.map((t) => [t, bucket(`tier_${t}`)])), interactive: bucket("interactive") },
    lastLeaseAt: last?.at == null ? null : Number(last.at), ready: Number(ready!.n), manualOnly: Number(ready!.manual),
    noTakerRepos: noTaker.filter((r) => tracked.get(r.repo)?.pipeline).map((r) => ({ repo: r.repo, since: Number(r.since) })),
    operatorRunners: operators.map((o) => ({ login: o.login, interactiveSlots: slotsOf(o.slots) })),
  };
}
