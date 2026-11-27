// Sessions and OAuth states (M04 access-b).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import type { AdminSession, NewOauthState, NewSession, OauthState, Role, Sealed, SessionRow } from "./types.ts";

const DAY = 86_400_000;
export const SESSION_TTL = 14 * DAY;
/** A session also ends this long after sign-in however active it is; operators' sessions are shorter. */
export const SESSION_MAX = 30 * DAY;
export const OPERATOR_SESSION_MAX = 7 * DAY;
const TOUCH_EVERY = 60_000;
const OAUTH_STATE_TTL = 600_000;

/** The time a session made at `createdAt` ends at the latest, whatever its activity. */
export const sessionEndsAt = (createdAt: string, role: Role | null): number => Date.parse(createdAt) + (role === "operator" ? OPERATOR_SESSION_MAX : SESSION_MAX);

const iso = (ms: number): string => new Date(ms).toISOString();

/** Inserts a session. */
export async function addSession(db: Db, row: NewSession): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.insertInto("sessions").values({
    id_hash: row.idHash, login: row.login, csrf: row.csrf, token_enc: row.sealedTokens, created_at: row.now, last_seen: row.now, expires_at: row.expiresAt, user_agent: row.userAgent,
  }));
}

/** Joins `access` for the live role; deletes an over-age session; touches `last_seen` and `expires_at` when older than 60 s. */
export async function loadSession(db: Db, idHash: string, o?: { now?: number }): Promise<SessionRow | null> {
  const q = queryDb(db);
  const now = o?.now ?? Date.now();
  const row = await q.get(q.k.selectFrom("sessions as s").innerJoin("access as a", "a.login", "s.login")
    .select([kx.rowid("sessions", "s").as("rowid"), ...kx.cols("sessions", "s"), "a.role"])
    .where("s.id_hash", "=", idHash).where("s.expires_at", ">", iso(now)));
  if (!row) return null;
  const role = row.role as Role;
  const endsAt = sessionEndsAt(row.created_at, role);
  if (!(now < endsAt)) {
    await q.run(q.k.deleteFrom("sessions").where("id_hash", "=", idHash));
    return null;
  }
  if (now - Date.parse(row.last_seen) > TOUCH_EVERY) {
    await q.run(q.k.updateTable("sessions").set({ last_seen: iso(now), expires_at: iso(Math.min(now + SESSION_TTL, endsAt)) }).where("id_hash", "=", idHash));
  }
  return { ...row, rowid: Number(row.rowid), role };
}

/** The sealed tokens of a session. */
export async function loadSessionSealed(db: Db, idHash: string): Promise<{ sealed: Sealed | null; login: string } | null> {
  const q = queryDb(db);
  const row = await q.get(q.k.selectFrom("sessions").select(["token_enc", "login"]).where("id_hash", "=", idHash));
  return row ? { sealed: row.token_enc as Sealed | null, login: row.login } : null;
}

/** Replaces the sealed tokens. */
export async function saveSessionTokens(db: Db, idHash: string, sealed: Sealed): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.updateTable("sessions").set({ token_enc: sealed }).where("id_hash", "=", idHash));
}

/** Newest first, with sealed tokens: the sessions of `login` that have not expired and hold a token set. The role is the live one, or null off the access list. */
export async function loadLiveSessionsOf(db: Db, login: string, o?: { now?: number }): Promise<SessionRow[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("sessions as s").leftJoin("access as a", "a.login", "s.login")
    .select([kx.rowid("sessions", "s").as("rowid"), ...kx.cols("sessions", "s"), "a.role"])
    .where("s.login", "=", login).where("s.expires_at", ">", iso(o?.now ?? Date.now())).where("s.token_enc", "is not", null)
    .orderBy("s.created_at", "desc"));
  return rows.map((r) => ({ ...r, rowid: Number(r.rowid), role: r.role as Role | null }));
}

/** Joined to `access.role`, for the Access page: live sessions, most recently seen first. */
export async function listSessions(db: Db, now: number): Promise<AdminSession[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("sessions as s").innerJoin("access as a", "a.login", "s.login")
    .select([kx.rowid("sessions", "s").as("rowid"), ...kx.cols("sessions", "s"), "a.role"])
    .where("s.expires_at", ">", iso(now)).orderBy("s.last_seen", "desc"));
  return rows.map((r) => ({ ...r, rowid: Number(r.rowid), role: r.role as Role }))
    .filter((s) => now < sessionEndsAt(s.created_at, s.role));
}

/** Deletes one session. */
export async function endSession(db: Db, idHash: string): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.deleteFrom("sessions").where("id_hash", "=", idHash));
}

/** Deletes one session only while it still holds `sealed` (a sign-in may have replaced it); true when it was deleted. One statement. */
export async function endSessionIf(db: Db, idHash: string, sealed: Sealed): Promise<boolean> {
  const q = queryDb(db);
  return Number((await q.run(q.k.deleteFrom("sessions").where("id_hash", "=", idHash).where("token_enc", "=", sealed))).changes) > 0;
}

/** Admin revoke: delete returning. */
export async function endSessionById(db: Db, rowid: number): Promise<{ idHash: string; login: string; createdAt: string; sealed: Sealed | null } | null> {
  const q = queryDb(db);
  const s = await q.get(q.k.deleteFrom("sessions").where(kx.rowid("sessions"), "=", rowid).returning(["id_hash", "login", "created_at", "token_enc"]));
  return s ? { idHash: s.id_hash, login: s.login, createdAt: s.created_at, sealed: s.token_enc as Sealed | null } : null;
}

/** Identity switch. */
export async function endAllSessions(db: Db): Promise<number> {
  const q = queryDb(db);
  return Number((await q.run(q.k.deleteFrom("sessions"))).changes);
}

/** Deletes expired sessions and OAuth states; one `db.write`. */
export async function pruneExpired(db: Db, now: number): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    await q.run(q.k.deleteFrom("sessions").where((eb) => eb.or([eb("expires_at", "<=", iso(now)), eb("created_at", "<=", iso(now - SESSION_MAX))])));
    await q.run(q.k.deleteFrom("oauth_states").where("created_at", "<=", iso(now - OAUTH_STATE_TTL)));
  });
}

/** Inserts a state. */
export async function addOauthState(db: Db, row: NewOauthState): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.insertInto("oauth_states").values({ state: row.state, verifier: row.verifier, return_to: row.returnTo, identity: row.identity, created_at: row.createdAt }));
}

/** `DELETE ... RETURNING` when the cookie matches, a plain read when not (the row stays). */
export async function takeOauthState(db: Db, state: string, o: { cookieMatches: boolean }): Promise<OauthState | null> {
  const q = queryDb(db);
  const cols = kx.cols("oauth_states");
  return (o.cookieMatches
    ? await q.get(q.k.deleteFrom("oauth_states").where("state", "=", state).returning(cols))
    : await q.get(q.k.selectFrom("oauth_states").select(cols).where("state", "=", state))) ?? null;
}
