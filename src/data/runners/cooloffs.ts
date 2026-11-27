// Cool-offs after repeated drops or failures (`remote_cooloffs`, `remote_lease_drops`) (package runners-b).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { scaled } from "../../remote/time-scale.ts";
import { addAudit } from "../control/index.ts";
import { dropSnapshotCache } from "./snapshot-cache.ts";
import type { LowerLogin } from "./types.ts";

/** Lease drops of one login within DROP_WINDOW_MS that start a cool-off. */
export const DROP_LIMIT = 3;
export const DROP_WINDOW_MS = scaled(2 * 3600_000);
/** A token's drops count at most once in this long: one outage or one stuck machine is one drop. */
export const DROP_DEDUPE_MS = scaled(10 * 60_000);
/** How long lost leases cool a login off. */
export const COOLOFF_MS = scaled(6 * 3600_000);
/** Failed replies in a row, within FAILURE_WINDOW_MS of the first, that start a cool-off. */
export const FAILURE_LIMIT = 5;
export const FAILURE_WINDOW_MS = scaled(30 * 60_000);
/** How long failed replies cool a login off. */
export const FAILURE_COOLOFF_MS = scaled(3600_000);

export const DROP_REASON = `its leases were lost ${DROP_LIMIT} times within 2 hours (no heartbeat, or past the call's time limit)`;
export const FAILURE_REASON = `its helpers failed ${FAILURE_LIMIT} calls in a row within 30 minutes`;

type Drop = { tokenId: number; login: string; callId: number };
type Held = { tokenId: number; login: string | null; callId: number | null; at: number; isNew: boolean };

/**
 * Records dropped leases: one read of the recent drops, the rule applied in order over the batch in memory (a token's drops count once
 * per DROP_DEDUPE_MS, a call lost again by the same login within the window counts once, the DROP_LIMIT-th drop of a login within the
 * window starts its cool-off and forgets its drops), then the cool-offs, the delete of the cooled logins' drops, the surviving new drops and
 * the audit rows. The result equals calling the rule once per drop, in order. Returns the logins that started a cool-off.
 */
export async function noteDrops(db: Db, drops: Drop[], now: number): Promise<string[]> {
  if (!drops.length) return [];
  const q = queryDb(db);
  const logins = [...new Set(drops.map((d) => d.login))];
  const tokens = [...new Set(drops.map((d) => d.tokenId))];
  const held: Held[] = (await q.all(q.k.selectFrom("main.remote_lease_drops").select(["token_id", "login", "call_id", "at"]).where("at", ">=", now - DROP_WINDOW_MS)
    .where((eb) => eb.or([kx.inList(db, "login", logins, "citext"), kx.inList(db, "token_id", tokens, "bigint")]))))
    .map((r) => ({ tokenId: Number(r.token_id), login: r.login, callId: r.call_id === null ? null : Number(r.call_id), at: Number(r.at), isNew: false }));
  const lower = (l: string | null): string | null => l?.toLowerCase() ?? null;
  const cooled = new Set<string>();
  for (const d of drops) {
    if (held.some((h) => h.tokenId === d.tokenId && h.at > now - DROP_DEDUPE_MS)) continue;
    if (held.some((h) => lower(h.login) === lower(d.login) && h.callId === d.callId && h.at >= now - DROP_WINDOW_MS)) continue;
    held.push({ tokenId: d.tokenId, login: d.login, callId: d.callId, at: now, isNew: true });
    if (held.filter((h) => lower(h.login) === lower(d.login) && h.at >= now - DROP_WINDOW_MS).length >= DROP_LIMIT) {
      cooled.add(d.login);
      for (let i = held.length - 1; i >= 0; i--) if (lower(held[i]!.login) === lower(d.login)) held.splice(i, 1);
    }
  }
  const fresh = held.filter((h) => h.isNew);
  if (!fresh.length && !cooled.size) return [];
  await db.write(async () => {
    if (cooled.size) {
      const list = [...cooled];
      await q.run(q.k.insertInto("main.remote_cooloffs").values(list.map((login) => ({ login, until: now + COOLOFF_MS, reason: DROP_REASON, failures: 0, failures_since: null })))
        .onConflict((oc) => oc.column("login").doUpdateSet(kx.excluded(["until", "reason", "failures", "failures_since"]))));
      await q.run(q.k.deleteFrom("main.remote_lease_drops").where(kx.inList(db, "login", list, "citext")));
    }
    if (fresh.length) await q.run(q.k.insertInto("main.remote_lease_drops").values(fresh.map((h) => ({ token_id: h.tokenId, login: h.login, call_id: h.callId, at: h.at }))));
    if (cooled.size) await addAudit(db, [...cooled].map((login) => ({ login, action: "remote-cooloff", target: login, details: { until: now + COOLOFF_MS, reason: DROP_REASON } })));
  });
  dropSnapshotCache(db);
  return [...cooled];
}

/** Counts a failure against the login; cools it off at the limit. */
export async function noteFailure(db: Db, login: string, now: number): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    const r = await q.get(q.k.selectFrom("main.remote_cooloffs").select(["failures", "failures_since"]).where("login", "=", login));
    const fresh = !r || r.failures_since === null || Number(r.failures_since) < now - FAILURE_WINDOW_MS;
    const failures = fresh ? 1 : Number(r.failures) + 1;
    if (failures >= FAILURE_LIMIT) {
      await q.run(q.k.insertInto("main.remote_cooloffs").values({ login, until: now + FAILURE_COOLOFF_MS, reason: FAILURE_REASON, failures: 0, failures_since: null })
        .onConflict((oc) => oc.column("login").doUpdateSet(kx.excluded(["until", "reason", "failures", "failures_since"]))));
      await q.run(q.k.deleteFrom("main.remote_lease_drops").where("login", "=", login));
      await addAudit(db, [{ login, action: "remote-cooloff", target: login, details: { until: now + FAILURE_COOLOFF_MS, reason: FAILURE_REASON } }]);
      return;
    }
    await q.run(q.k.insertInto("main.remote_cooloffs").values({ login, failures, failures_since: fresh ? now : r!.failures_since })
      .onConflict((oc) => oc.column("login").doUpdateSet(kx.excluded(["failures", "failures_since"]))));
  });
  dropSnapshotCache(db);
}

/** Resets failure counts; joins `submitLease`'s transaction. */
export async function noteSuccess(db: Db, logins: string[]): Promise<void> {
  if (!logins.length) return;
  const q = queryDb(db);
  await q.run(q.k.updateTable("main.remote_cooloffs").set({ failures: 0, failures_since: null }).where(kx.inList(db, "login", logins, "citext")).where("failures", ">", 0));
}

/** Ends a cool-off, deletes the login's drops and audits when it was cooling off. */
export async function clearCooloff(db: Db, login: string, by: string, now: number): Promise<boolean> {
  const q = queryDb(db);
  const was = await db.write(async () => {
    const gone = await q.get(q.k.deleteFrom("main.remote_cooloffs").where("login", "=", login).returning(["until"]));
    await q.run(q.k.deleteFrom("main.remote_lease_drops").where("login", "=", login));
    const cooling = gone?.until != null && Number(gone.until) > now;
    if (cooling) await addAudit(db, [{ login: by, action: "remote-cooloff-clear", target: login, details: {} }]);
    return cooling;
  });
  dropSnapshotCache(db);
  return was;
}

/** Live cool-offs per login. */
export async function loadCooloffs(db: Db, logins: string[], now: number): Promise<Map<LowerLogin, { until: string; reason: string }>> {
  if (!logins.length) return new Map();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.remote_cooloffs").select(["login", "until", "reason"]).where("until", ">", now).where(kx.inList(db, "login", logins, "citext")));
  return new Map(rows.map((r) => [r.login.toLowerCase(), { until: new Date(Number(r.until)).toISOString(), reason: r.reason ?? DROP_REASON }] as const));
}
