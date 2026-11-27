import type { Role, User } from "../types.ts";
import { randomToken, sha256hex, type TokenBox } from "./crypto.ts";
import { refreshShared, usableAccess } from "./token-refresh.ts";
import { REPO_NAME, WRITE_PERMISSIONS, type Provider, type Tokens } from "./provider.ts";
import * as access from "../../data/access/index.ts";
import { PERM_READ_TTL, PERM_WRITE_TTL, OPERATOR_SESSION_MAX, SESSION_MAX, SESSION_TTL, sessionEndsAt } from "../../data/access/index.ts";
import type { Sealed } from "../../data/access/index.ts";
import type { Db } from "../../db/index.ts";
import { writeAccess } from "../../remote/permission.ts";

// A session also ends SESSION_MAX after sign-in however active it is; operators' sessions are shorter.
export { PERM_READ_TTL, PERM_WRITE_TTL, OPERATOR_SESSION_MAX, SESSION_MAX, SESSION_TTL, sessionEndsAt };

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
  await access.addSession(db, {
    idHash, login, csrf: randomToken(32), sealedTokens: sealTokens(box, tokens, idHash) as Sealed, now: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_TTL).toISOString(), userAgent: (userAgent ?? "").slice(0, 300) || null,
  });
  return id;
}

// A session counts only while its login is still on the access list; the
// role comes from the list, not the session, so it is always current.
export async function loadSession(db: Db, id: string | undefined): Promise<Session | null> {
  if (!id || id.length > 100) return null;
  const idHash = sha256hex(id);
  const row = await access.loadSession(db, idHash);
  if (!row?.role) return null;
  return { rowid: row.rowid, idHash, login: row.login, role: row.role, csrf: row.csrf, tokenEnc: row.token_enc };
}

/** A login's cached repo permissions, by repo. */
export type CachedPermissions = ReadonlyMap<string, access.PermEntry>;

/** The cached permissions of the session's login; empty without one. Read alongside loadSession, whose answer says whether they count. */
export async function loadSessionPermissions(db: Db, id: string | undefined): Promise<CachedPermissions> {
  return !id || id.length > 100 ? new Map() : await access.loadPermissionsOfSession(db, sha256hex(id));
}

/** The most sessions KnownSessions keeps. */
const KNOWN_SESSIONS_MAX = 5000;

/**
 * Sessions this process has read lately, with their role then. A hint only: it decides what a request reads ahead alongside its
 * session row, which still decides what it may do. A cookie that names no session is never in it.
 */
export class KnownSessions {
  #roles = new Map<string, Role>();

  roleOf(id: string | undefined): Role | undefined {
    return id ? this.#roles.get(sha256hex(id)) : undefined;
  }

  /** Records what reading the session of cookie `id` answered. */
  note(id: string | undefined, session: Session | null): void {
    if (!id) return;
    const key = session?.idHash ?? sha256hex(id);
    this.#roles.delete(key);
    if (!session) return;
    this.#roles.set(key, session.role);
    if (this.#roles.size > KNOWN_SESSIONS_MAX) this.#roles.delete(this.#roles.keys().next().value!);
  }
}

export async function deleteSession(db: Db, id: string): Promise<void> {
  await access.endSession(db, sha256hex(id));
}

export async function pruneExpired(db: Db): Promise<void> {
  await access.pruneExpired(db, Date.now());
}

// One refresh per session at a time in this process; refreshShared serialises refreshes of the login across processes.
const refreshing = new Map<string, Promise<string | null | undefined>>();

// Returns a usable access token: null when the session can no longer get one
// (and has been ended), undefined after a transient failure. `mirror`: the
// session holds a GitHub App token, shared with the login's user_tokens row.
export async function accessToken(db: Db, box: TokenBox, provider: Provider, idHash: string, mirror: boolean, rejected?: string): Promise<string | null | undefined> {
  const row = await access.loadSessionSealed(db, idHash);
  if (!row) return null;
  const t = openTokens(box, row.sealed, idHash);
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
  // A read's checks take every cached permission; a write's are few and read when they come.
  const [live, cachedAll] = await Promise.all([access.loadLiveSessionsOf(db, login), forWrite ? undefined : access.loadPermissionsOf(db, login)]);
  const s = live.find((x) => Date.now() < sessionEndsAt(x.created_at, role));
  if (s) return makeUser(db, box, provider, { rowid: s.rowid, idHash: s.id_hash, login: s.login, role, csrf: s.csrf, tokenEnc: s.token_enc }, forWrite, false, cachedAll);
  const permissions = permissionsOnce(db, login, cachedAll);
  const cached = async (repo: string): Promise<string | null> => {
    const row = (await permissions()).get(repo);
    return row && Date.now() - Date.parse(row.checkedAt) < PERM_READ_TTL ? row.permission : null;
  };
  // With no session, a write's permission comes from the GitHub App when the cached one is over a minute old.
  if (forWrite) {
    const write = writeAccess(db, login);
    return {
      login, role,
      canWrite: write.canWrite,
      canRead: async (repo) => { const p = await cached(repo); return p !== null && p !== "none"; },
      permissionError: write.writeError,
    };
  }
  return {
    login, role,
    canWrite: async (repo) => WRITE_PERMISSIONS.has(await cached(repo) ?? ""),
    canRead: async (repo) => { const p = await cached(repo); return p !== null && p !== "none"; },
    permissionError: async (repo) => await cached(repo) === null ? `${login} has no live dashboard session to read the permission on ${repo} from GitHub` : null,
  };
}

/** Reads a login's cached permissions at the first call, unless given; a failed read is tried again. */
function permissionsOnce(db: Db, login: string, given?: CachedPermissions): () => Promise<CachedPermissions> {
  let read: Promise<CachedPermissions> | undefined = given && Promise.resolve(given);
  return () => {
    if (!read) {
      read = access.loadPermissionsOf(db, login);
      void read.catch(() => { read = undefined; });
    }
    return read;
  };
}

/** Whether `login` had write permission on `repo` at its last successful check, made less than `maxAgeMs` ago. */
export async function cachedWrite(db: Db, login: string, repo: string, maxAgeMs: number): Promise<boolean> {
  const row = (await access.loadPermissions(db, [{ login, repo }])).get(access.permKey(login, repo));
  return !!row && WRITE_PERMISSIONS.has(row.permission) && Date.now() - Date.parse(row.checkedAt) < maxAgeMs;
}

// `forWrite` is true on POST requests: a handler that calls canWrite there is
// about to write, so the cached permission must be at most a minute old.
// `cached` holds the login's cached permissions when the caller has read them already; else they are read at the first check, all at once.
export function makeUser(db: Db, box: TokenBox, provider: Provider, s: Session, forWrite: boolean, mirrorUserTokens = false, cached?: CachedPermissions): User {
  const memo = new Map<string, Promise<string | null>>();
  const permissions = permissionsOnce(db, s.login, cached);
  const failed = new Map<string, string>();
  const fail = (repo: string, why: string): null => {
    failed.set(repo, why);
    return null;
  };
  // The user's permission on the repo from GitHub (cached), or null when it can't be told (the reason goes in `failed`).
  const check = async (repo: string): Promise<string | null> => {
    if (!REPO_NAME.test(repo)) return fail(repo, `${repo} is not a repo name`);
    const maxAge = forWrite ? PERM_WRITE_TTL : PERM_READ_TTL;
    const known = (await permissions()).get(repo);
    if (known && Date.now() - Date.parse(known.checkedAt) < maxAge) return known.permission;
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
    await access.savePermissions(db, [{ login: s.login, repo, permission, checkedAt: new Date().toISOString() }]);
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
