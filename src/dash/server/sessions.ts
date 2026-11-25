import type { Role, User } from "../types.ts";
import { randomToken, sha256hex, type TokenBox } from "./crypto.ts";
import { refreshShared, usableAccess } from "./token-refresh.ts";
import { REPO_NAME, WRITE_PERMISSIONS, type Provider, type Tokens } from "./provider.ts";
import type { Db } from "../../db/index.ts";
import { excluded, rowid } from "../../db/kx.ts";

const DAY = 86_400_000;
export const SESSION_TTL = 14 * DAY;
// A session also ends this long after sign-in however active it is; operators'
// sessions are shorter.
export const SESSION_MAX = 30 * DAY;
export const OPERATOR_SESSION_MAX = 7 * DAY;
const TOUCH_EVERY = 60_000;
export const PERM_READ_TTL = 10 * 60_000;
export const PERM_WRITE_TTL = 60_000;

export type Session = {
  rowid: number;
  idHash: string;
  login: string;
  role: Role;
  csrf: string;
  tokenEnc: string | null;
};

// sessions.token_enc holds the sealed JSON of the whole Tokens set, so the
// refresh token and expiry times are encrypted the same way as the access token.
export const sealTokens = (box: TokenBox, t: Tokens, idHash: string): string => box.seal(JSON.stringify(t), idHash);

export function openTokens(box: TokenBox, sealed: string | null, idHash: string): Tokens | null {
  const plain = sealed ? box.open(sealed, idHash) : null;
  if (!plain) return null;
  try {
    return JSON.parse(plain) as Tokens;
  } catch {
    return null;
  }
}

export async function createSession(db: Db, box: TokenBox, login: string, tokens: Tokens, userAgent: string | undefined): Promise<string> {
  const id = randomToken(32);
  const idHash = sha256hex(id);
  const now = new Date();
  await db.run(db.k.insertInto("sessions").values({
    id_hash: idHash, login, csrf: randomToken(32), token_enc: sealTokens(box, tokens, idHash), created_at: now.toISOString(),
    last_seen: now.toISOString(), expires_at: new Date(now.getTime() + SESSION_TTL).toISOString(), user_agent: (userAgent ?? "").slice(0, 300) || null,
  }));
  return id;
}

/** The time a session made at `createdAt` ends at the latest, whatever its activity. */
export const sessionEndsAt = (createdAt: string, role: Role): number => Date.parse(createdAt) + (role === "operator" ? OPERATOR_SESSION_MAX : SESSION_MAX);

// A session counts only while its login is still on the access list; the
// role comes from the list, not the session, so it is always current.
export async function loadSession(db: Db, id: string | undefined): Promise<Session | null> {
  if (!id || id.length > 100) return null;
  const idHash = sha256hex(id);
  const row = await db.get(db.k.selectFrom("sessions as s").innerJoin("access as a", "a.login", "s.login")
    .select([rowid("sessions", "s").as("rowid"), "s.login", "s.csrf", "s.token_enc", "s.last_seen", "s.created_at", "a.role"])
    .where("s.id_hash", "=", idHash).where("s.expires_at", ">", new Date().toISOString())
    .$narrowType<{ role: Role }>());
  if (!row) return null;
  const now = Date.now();
  const endsAt = sessionEndsAt(row.created_at, row.role);
  if (!(now < endsAt)) {
    await db.run(db.k.deleteFrom("sessions").where("id_hash", "=", idHash));
    return null;
  }
  if (now - Date.parse(row.last_seen) > TOUCH_EVERY) {
    await db.run(db.k.updateTable("sessions")
      .set({ last_seen: new Date(now).toISOString(), expires_at: new Date(Math.min(now + SESSION_TTL, endsAt)).toISOString() })
      .where("id_hash", "=", idHash));
  }
  return { rowid: Number(row.rowid), idHash, login: row.login, role: row.role, csrf: row.csrf, tokenEnc: row.token_enc };
}

export async function deleteSession(db: Db, id: string): Promise<void> {
  await db.run(db.k.deleteFrom("sessions").where("id_hash", "=", sha256hex(id)));
}

export async function pruneExpired(db: Db): Promise<void> {
  const now = new Date();
  await db.run(db.k.deleteFrom("sessions").where((eb) => eb.or([
    eb("expires_at", "<=", now.toISOString()), eb("created_at", "<=", new Date(now.getTime() - SESSION_MAX).toISOString()),
  ])));
  await db.run(db.k.deleteFrom("oauth_states").where("created_at", "<=", new Date(now.getTime() - 600_000).toISOString()));
}

// One refresh per session at a time in this process; refreshShared serialises refreshes of the login across processes.
const refreshing = new Map<string, Promise<string | null | undefined>>();

// Returns a usable access token: null when the session can no longer get one
// (and has been ended), undefined after a transient failure. `mirror`: the
// session holds a GitHub App token, shared with the login's user_tokens row.
export async function accessToken(db: Db, box: TokenBox, provider: Provider, idHash: string, mirror: boolean, rejected?: string): Promise<string | null | undefined> {
  const row = await db.get(db.k.selectFrom("sessions").select(["token_enc", "login"]).where("id_hash", "=", idHash));
  if (!row) return null;
  const t = openTokens(box, row.token_enc, idHash);
  if (!t) return null;
  if (usableAccess(t, rejected)) return t.access;
  let p = refreshing.get(idHash);
  if (!p) {
    p = refreshShared(db, box, provider, row.login, { kind: "session", idHash }, { rejected, heal: mirror })
      .then((r) => (r.ok ? r.tokens.access : r.transient ? undefined : null))
      .finally(() => refreshing.delete(idHash));
    refreshing.set(idHash, p);
  }
  return p;
}

/**
 * The User an agent token stands for (src/dash/mcp/). A token carries no GitHub token of its own, so permission checks
 * use the login's newest live dashboard session, as that session's own requests would. Without one, only a cached
 * permission young enough for the request counts, and anything else reads as no permission: the repo is hidden
 * unless public, and a pick is shown as `none`.
 */
export async function userForLogin(db: Db, box: TokenBox, provider: Provider, login: string, role: Role, forWrite: boolean): Promise<User> {
  const s = (await db.all(db.k.selectFrom("sessions").select([rowid("sessions").as("rowid"), "id_hash", "login", "csrf", "token_enc", "created_at"])
    .where("login", "=", login).where("expires_at", ">", new Date().toISOString()).where("token_enc", "is not", null)
    .$narrowType<{ token_enc: string }>().orderBy("created_at", "desc")))
    .find((x) => Date.now() < sessionEndsAt(x.created_at, role));
  if (s) return makeUser(db, box, provider, { rowid: Number(s.rowid), idHash: s.id_hash, login: s.login, role, csrf: s.csrf, tokenEnc: s.token_enc }, forWrite);
  const cached = async (repo: string): Promise<string | null> => {
    const row = await db.get(db.k.selectFrom("repo_permissions").select(["permission", "checked_at"]).where("login", "=", login).where("repo", "=", repo));
    return row && Date.now() - Date.parse(row.checked_at) < (forWrite ? PERM_WRITE_TTL : PERM_READ_TTL) ? row.permission : null;
  };
  return {
    login, role,
    canWrite: async (repo) => WRITE_PERMISSIONS.has(await cached(repo) ?? ""),
    canRead: async (repo) => { const p = await cached(repo); return p !== null && p !== "none"; },
    permissionError: async (repo) => await cached(repo) === null ? `${login} has no live dashboard session to read the permission on ${repo} from GitHub` : null,
  };
}

/** Whether `login` had write permission on `repo` at its last successful check, made less than `maxAgeMs` ago. */
export async function cachedWrite(db: Db, login: string, repo: string, maxAgeMs: number): Promise<boolean> {
  const row = await db.get(db.k.selectFrom("repo_permissions").select(["permission", "checked_at"]).where("login", "=", login).where("repo", "=", repo));
  return !!row && WRITE_PERMISSIONS.has(row.permission) && Date.now() - Date.parse(row.checked_at) < maxAgeMs;
}

// `forWrite` is true on POST requests: a handler that calls canWrite there is
// about to write, so the cached permission must be at most a minute old.
export function makeUser(db: Db, box: TokenBox, provider: Provider, s: Session, forWrite: boolean, mirrorUserTokens = false): User {
  const memo = new Map<string, Promise<string | null>>();
  const failed = new Map<string, string>();
  const fail = (repo: string, why: string): null => {
    failed.set(repo, why);
    return null;
  };
  // The user's permission on the repo from GitHub (cached), or null when it can't be told (the reason goes in `failed`).
  const check = async (repo: string): Promise<string | null> => {
    if (!REPO_NAME.test(repo)) return fail(repo, `${repo} is not a repo name`);
    const maxAge = forWrite ? PERM_WRITE_TTL : PERM_READ_TTL;
    const cached = await db.get(db.k.selectFrom("repo_permissions").select(["permission", "checked_at"]).where("login", "=", s.login).where("repo", "=", repo));
    if (cached && Date.now() - Date.parse(cached.checked_at) < maxAge) return cached.permission;
    let permission: string | undefined;
    try {
      const noToken = (t: string | null | undefined): null => fail(repo, t === null ? `${s.login}'s dashboard session has ended; sign in again` : `${s.login}'s GitHub token could not be refreshed (GitHub did not answer)`);
      let token = await accessToken(db, box, provider, s.idHash, mirrorUserTokens);
      if (!token) return noToken(token);
      permission = await provider.permission(token, repo);
      if (permission === "unauthorized") {
        token = await accessToken(db, box, provider, s.idHash, mirrorUserTokens, token);
        if (!token) return noToken(token);
        permission = await provider.permission(token, repo);
        if (permission === "unauthorized") return fail(repo, `GitHub refused ${s.login}'s token`);
      }
    } catch (e) {
      console.error(`permission check ${s.login} ${repo}: ${(e as Error).message}`);
      return fail(repo, `GitHub permission check failed: ${(e as Error).message}`);
    }
    failed.delete(repo);
    await db.run(db.k.insertInto("repo_permissions").values({ login: s.login, repo, permission, checked_at: new Date().toISOString() })
      .onConflict((oc) => oc.columns(["login", "repo"]).doUpdateSet(excluded(["permission", "checked_at"]))));
    return permission;
  };
  const permission = (repo: string): Promise<string | null> => {
    let p = memo.get(repo);
    if (!p) memo.set(repo, (p = check(repo)));
    return p;
  };
  return {
    login: s.login,
    role: s.role,
    async canWrite(repo: string): Promise<boolean> {
      return WRITE_PERMISSIONS.has((await permission(repo)) ?? "");
    },
    async canRead(repo: string): Promise<boolean> {
      const p = await permission(repo);
      return p !== null && p !== "none";
    },
    permissionError: async (repo) => failed.get(repo) ?? null,
  };
}
