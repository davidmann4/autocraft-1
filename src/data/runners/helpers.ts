// reads: access.mcp_tokens, access.access
// Task Runner helpers (`remote_helpers`) (package runners-b).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { STATUS_EVERY_S } from "../../remote/protocol.ts";
import { scaled } from "../../remote/time-scale.ts";
import { dropSnapshotCache } from "./snapshot-cache.ts";
import type { HelperInfo, HelperStatus, LowerLogin, Machine, Readiness, Reserve, RunnerRow, Role, Tier } from "./types.ts";

/** A status this old no longer counts: one report interval and a minute of slack. */
export const STATUS_FRESH_MS = scaled((STATUS_EVERY_S + 60) * 1000);

const json = <T>(text: string | null | undefined, fallback: T): T => {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
};

/**
 * Live runner credentials of the module's readers, left-joined to their last status and to `access`. A helper row made at device
 * login carries `reported_at = 0` until the first report: such a row has no status (`runnerRowOf` reads it as none).
 */
export function runnerCredentials(db: Db, nowMs: number, liveOnly = true) {
  const q = queryDb(db);
  return q.k.selectFrom("main.mcp_tokens as t").leftJoin("main.remote_helpers as h", "h.token_id", "t.id").leftJoin("main.access as a", "a.login", "t.login")
    .select(["t.id", "t.login", "a.role", "t.label", "t.created_at", "t.expires_at", "t.can_agent", "t.can_answer", "t.last_used_at", "t.machine as token_machine",
      "h.machine", "h.helper_version", "h.readiness", "h.until", "h.reason", "h.harness", "h.models", "h.reserve", "h.usage", "h.reported_at", "h.slots", "h.busy",
      "h.last_error", "h.idle_claim_at", "h.idle_tiers", "h.idle_repos", "h.login_renews_at"])
    .where("t.kind", "=", "runner").$if(liveOnly, (s) => s.where("t.expires_at", ">", new Date(nowMs).toISOString()));
}
type Credential = Awaited<ReturnType<ReturnType<typeof runnerCredentials>["execute"]>>[number];

/** A credential row as a `RunnerRow`; the lease counts are filled by the caller. */
export function runnerRowOf(r: Credential): RunnerRow {
  const reported = r.reported_at === null || Number(r.reported_at) === 0 ? null : Number(r.reported_at);
  const has = reported !== null;
  return {
    tokenId: Number(r.id), login: r.login, role: (r.role as Role | null) ?? null, label: r.label, machine: json<Machine | null>(r.machine ?? r.token_machine, null), helperVersion: r.helper_version ?? null,
    createdAt: r.created_at, expiresAt: r.expires_at, canAgent: Number(r.can_agent) === 1, canAnswer: Number(r.can_answer) === 1,
    readiness: has ? (r.readiness as Readiness) : null, until: has ? r.until : null, reason: has ? r.reason : null, harness: has ? r.harness : null,
    models: has ? json<Partial<Record<Tier, string>>>(r.models, {}) : {}, reserve: has ? json<Reserve | null>(r.reserve, null) : null, usage: has ? json<unknown>(r.usage, null) : null,
    reportedAt: reported, slots: r.slots === null ? null : Number(r.slots), busy: r.busy === null ? null : Number(r.busy), lastError: has ? r.last_error : null,
    idleClaimAt: r.idle_claim_at === null ? null : Number(r.idle_claim_at), idleTiers: json<Tier[] | null>(r.idle_tiers, null), idleRepos: json<string[] | null>(r.idle_repos, null),
    loginRenewsAt: r.login_renews_at === null ? null : Number(r.login_renews_at), leased: 0, ownLaneLeased: 0, beatAt: null,
  };
}

/** Upserts a helper's status, including `machine`. */
export async function saveHelperStatus(db: Db, tokenId: number, login: string, s: HelperStatus, now: number): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.remote_helpers")
    .values({
      token_id: tokenId, login, readiness: s.readiness, until: s.until ?? null, reason: s.reason ?? null, harness: s.harness, models: JSON.stringify(s.models),
      reserve: JSON.stringify(s.reserve), usage: s.usage ? JSON.stringify(s.usage) : null, reported_at: now, slots: s.slots, busy: s.busy,
      last_error: s.lastError ? JSON.stringify(s.lastError) : null, helper_version: s.helperVersion ?? null, machine: s.machine ? JSON.stringify(s.machine) : null,
    })
    .onConflict((oc) => oc.column("token_id").doUpdateSet((eb) => ({
      ...kx.excluded(["login", "readiness", "until", "reason", "harness", "models", "reserve", "usage", "reported_at", "slots", "busy", "last_error"])(eb),
      helper_version: eb.fn.coalesce("excluded.helper_version", "main.remote_helpers.helper_version"),
      machine: eb.fn.coalesce("excluded.machine", "main.remote_helpers.machine"),
    }))));
  dropSnapshotCache(db);
}

/**
 * Creates a helper row for a new credential, so its machine is known before the first status report. It has no status until then
 * (`reported_at = 0`, which no freshness test passes). Called by `access` in its token-creation transaction.
 */
export async function addHelper(db: Db, a: { tokenId: number; login: string; machine: Machine | null; helperVersion: string | null }): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.remote_helpers")
    .values({
      token_id: a.tokenId, login: a.login, readiness: "paused", harness: "claude", models: "{}", reserve: JSON.stringify({ fiveHour: 20, weekly: 20 }), reported_at: 0,
      machine: a.machine ? JSON.stringify(a.machine) : null, helper_version: a.helperVersion,
    })
    .onConflict((oc) => oc.column("token_id").doUpdateSet((eb) => ({
      machine: eb.fn.coalesce("excluded.machine", "main.remote_helpers.machine"), helper_version: eb.fn.coalesce("excluded.helper_version", "main.remote_helpers.helper_version"),
    }))));
  dropSnapshotCache(db);
}

/** Deletes helper rows; called by `access` when it deletes tokens. */
export async function removeHelpers(db: Db, tokenIds: number[]): Promise<void> {
  if (!tokenIds.length) return;
  const q = queryDb(db);
  await q.run(q.k.deleteFrom("main.remote_helpers").where(kx.inList(db, "token_id", tokenIds, "bigint")));
  dropSnapshotCache(db);
}

/**
 * Helpers per login (newest credential first) with machine, version, times and scopes, and the login's cool-off. 2 statements, 1 RT.
 * `readiness` is the reported one; `cooledUntil` and `cooledReason` say the login is cooling off, which the caller shows instead of it
 * unless the helper reports `cooled-off` itself.
 */
export async function loadHelpers(db: Db, logins: string[], now: number): Promise<Map<LowerLogin, HelperInfo[]>> {
  const out = new Map<LowerLogin, HelperInfo[]>();
  if (!logins.length) return out;
  const q = queryDb(db);
  const [rows, cooled] = await db.together(() => Promise.all([
    q.all(runnerCredentials(db, now).where(kx.inList(db, "t.login", logins, "citext")).orderBy("t.created_at", "desc").orderBy("t.id", "desc")),
    q.all(q.k.selectFrom("main.remote_cooloffs").select(["login", "until", "reason"]).where("until", ">", now).where(kx.inList(db, "login", logins, "citext"))),
  ]));
  const cool = new Map(cooled.map((c) => [c.login.toLowerCase(), c] as const));
  for (const r of rows) {
    const row = runnerRowOf(r);
    const key = r.login.toLowerCase();
    const c = cool.get(key);
    const used = r.last_used_at ? Date.parse(r.last_used_at) : null;
    const seen = Math.max(row.reportedAt ?? -Infinity, used ?? -Infinity);
    const info: HelperInfo = {
      tokenId: row.tokenId, label: row.label, readiness: row.readiness, until: row.until, reason: row.reason, fresh: row.reportedAt !== null && now - row.reportedAt <= STATUS_FRESH_MS,
      lastSeen: Number.isFinite(seen) ? new Date(seen).toISOString() : null, harness: row.harness, models: row.models, reserve: row.reserve, usage: row.usage, slots: row.slots,
      machine: row.machine, helperVersion: row.helperVersion, createdAt: row.createdAt, expiresAt: row.expiresAt, canAgent: row.canAgent, canAnswer: row.canAnswer,
      cooledUntil: c && row.readiness !== "cooled-off" ? new Date(Number(c.until)).toISOString() : null, cooledReason: c && row.readiness !== "cooled-off" ? c.reason : null,
      busy: row.busy, lastError: json<{ text: string; at: string } | null>(row.lastError, null),
    };
    const list = out.get(key);
    if (list) list.push(info);
    else out.set(key, [info]);
  }
  return out;
}

/** The logins that have a live credential whose last status is fresh (the MCP Connector then offers the task tools). */
export async function hasFreshRunners(db: Db, logins: string[], now: number): Promise<Set<LowerLogin>> {
  if (!logins.length) return new Set();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.mcp_tokens as t").innerJoin("main.remote_helpers as h", "h.token_id", "t.id").select("t.login").distinct()
    .where("t.kind", "=", "runner").where("t.expires_at", ">", new Date(now).toISOString()).where("h.reported_at", ">=", now - STATUS_FRESH_MS)
    .where(kx.inList(db, "t.login", logins, "citext")));
  return new Set(rows.map((r) => r.login.toLowerCase()));
}
