// A login's write permission for helper claims, read through the GitHub App's installation token so that a helper keeps
// working after the user's dashboard session has ended. One cache per login and repo is shared by all slots and helpers.
import { AppError, call, GITHUB_API } from "../github/app.ts";
import { installationToken } from "../github/install-token.ts";
import { WRITE_PERMISSIONS } from "../dash/server/provider.ts";
import type { Db } from "../db/index.ts";
import { loadPermissions, permKey, PERM_READ_TTL, PERM_WRITE_TTL, savePermissions } from "../data/access/index.ts";
import { loadRepos } from "../data/mirror/index.ts";

export const APP_PERMISSION_TTL = 60_000;

export type AppPermission =
  | { kind: "ok"; permission: string }
  /** No app token for the repo's owner (app not registered or installed, repo unknown), or GitHub answered 404: the caller uses another source. */
  | { kind: "unavailable" }
  /** GitHub could not be asked (error, rate limit). */
  | { kind: "error"; why: string };

export type PermissionDeps = { mint?: (owner: string) => Promise<string>; apiBase?: string; now?: () => number };

const cache = new Map<string, { at: number; value: AppPermission }>();
const inflight = new Map<string, Promise<AppPermission>>();

/** Test hook: forget every cached answer. */
export function clearPermissionCache(): void { cache.clear(); inflight.clear(); }

/** `login`'s permission on `repo` from the GitHub App: cached 60 s, concurrent lookups share one request. Written to repo_permissions. */
export function appPermission(db: Db, login: string, repo: string, deps: PermissionDeps = {}): Promise<AppPermission> {
  const now = deps.now ?? Date.now;
  const key = `${login.toLowerCase()}\0${repo}`;
  const hit = cache.get(key);
  if (hit && now() - hit.at < APP_PERMISSION_TTL) return Promise.resolve(hit.value);
  let p = inflight.get(key);
  if (!p) {
    p = lookup(db, login, repo, deps).then((value) => {
      // An error is not kept: the next claim asks again.
      if (value.kind !== "error") cache.set(key, { at: now(), value });
      return value;
    }).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

async function lookup(db: Db, login: string, repo: string, deps: PermissionDeps): Promise<AppPermission> {
  const row = (await loadRepos(db, { names: [repo] })).get(repo);
  if (!row?.owner) return { kind: "unavailable" };
  let token: string;
  try {
    token = await (deps.mint ?? ((o) => installationToken(o)))(row.owner);
  } catch {
    return { kind: "unavailable" };
  }
  try {
    const r = await call(deps.apiBase ?? GITHUB_API, `/repos/${encodeURIComponent(row.owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(login)}/permission`, token) as { permission?: unknown; role_name?: unknown };
    const role = typeof r.role_name === "string" ? r.role_name : "";
    const permission = WRITE_PERMISSIONS.has(role) ? role : typeof r.permission === "string" ? r.permission : "none";
    await savePermissions(db, [{ login, repo, permission, checkedAt: new Date().toISOString() }]);
    return { kind: "ok", permission };
  } catch (e) {
    // A 404 does not prove the user lacks access: the installation may not see the repo, or the login may have been renamed.
    // A collaborator without access is answered 200 with permission "none". The session decides instead.
    if (e instanceof AppError && e.status === 404) return { kind: "unavailable" };
    return { kind: "error", why: `GitHub permission check failed: ${(e as Error).message}` };
  }
}

/** A login's write access to a repo: decided, or unknown with the reason. */
export type WriteCheck = { kind: "yes" } | { kind: "no" } | { kind: "unknown"; why: string };
export type PermissionFn = (db: Db, login: string, repo: string) => Promise<AppPermission>;

/**
 * Write access for a command from a surface with no dashboard session to read it with (Discord, an agent): a cached check younger than
 * PERM_WRITE_TTL decides; else the GitHub App is asked, which refreshes the cached row. When the app cannot ask for the repo, a cached
 * check within PERM_READ_TTL decides, and with none it is a no. When GitHub fails, the answer is unknown, never a no.
 */
export async function freshWrite(db: Db, login: string, repo: string, permission: PermissionFn = (d, l, r) => appPermission(d, l, r)): Promise<WriteCheck> {
  const cached = async (maxAgeMs: number): Promise<WriteCheck | null> => {
    const row = (await loadPermissions(db, [{ login, repo }])).get(permKey(login, repo));
    if (!row || Date.now() - Date.parse(row.checkedAt) >= maxAgeMs) return null;
    return { kind: WRITE_PERMISSIONS.has(row.permission) ? "yes" : "no" };
  };
  const recent = await cached(PERM_WRITE_TTL);
  if (recent) return recent;
  const app = await permission(db, login, repo).catch((e: Error): AppPermission => ({ kind: "error", why: e.message }));
  if (app.kind === "ok") return { kind: WRITE_PERMISSIONS.has(app.permission) ? "yes" : "no" };
  if (app.kind === "error") return { kind: "unknown", why: app.why };
  // Nothing can tell: a dashboard sign-in reads it again.
  return await cached(PERM_READ_TTL) ?? { kind: "no" };
}

/** `canWrite` and `writeError` of a command actor (src/workflow/apply.ts Actor) from `freshWrite`, one check per repo. */
export function writeAccess(db: Db, login: string, permission?: PermissionFn): { canWrite: (repo: string) => Promise<boolean>; writeError: (repo: string) => Promise<string | null> } {
  const memo = new Map<string, Promise<WriteCheck>>();
  const check = (repo: string): Promise<WriteCheck> => {
    let p = memo.get(repo);
    if (!p) memo.set(repo, (p = freshWrite(db, login, repo, permission)));
    return p;
  };
  return {
    canWrite: async (repo) => (await check(repo)).kind === "yes",
    writeError: async (repo) => { const w = await check(repo); return w.kind === "unknown" ? w.why : null; },
  };
}
