// The write permission of a same-repo PR's author, from GitHub, cached per (repo, login) in author_permissions.
// Planning reads only the cache; the jobs that push refresh a missing or old entry first.
import { PIPELINE_LOGIN_KEY } from "../core/rules.ts";
import { slugOf } from "../owners.ts";
import { gh } from "../review/diff.ts";
import { sameRepo } from "./pushable.ts";
import { setting } from "../data/control/index.ts";
import { loadAuthorPermissions, loadItems, saveAuthorPermissions } from "../data/mirror/index.ts";
import type { AuthorPermissionRow } from "../data/mirror/types.ts";
import type { Db } from "../db/index.ts";

export const AUTHOR_PERMISSION_TTL_MS = 24 * 3600_000;
const WRITE = new Set(["write", "maintain", "admin"]);
const KNOWN = new Set(["admin", "maintain", "write", "triage", "read", "none"]);

/** "yes" and "no" are known; "unknown" means the permission has not been read yet (a missing entry). */
export type AuthorWrite = "yes" | "no" | "unknown";

type Row = { author: string | null; author_type: string | null; author_id: number | null };
const authorOf = async (db: Db, repo: string, number: number): Promise<Row | undefined> =>
  (await loadItems(db, [{ repo, number }], "pr")).get(`${repo}#${number}`);

/** The pipeline's own account and bots write to the repository by construction. */
function writesByRole(me: string | undefined, r: Row): boolean {
  if (r.author_type === "Bot") return true;
  return !!me && !!r.author && me.toLowerCase() === r.author.toLowerCase();
}

type Cached = { permission: string | null; checked_at: string | null; failures: number; first_failure_at: string | null; author_id: number | null };
/** The cached entry of the PR's author as stored; a permission read for another account under the login counts as never read. */
const ownEntry = (c: Cached | undefined, r: Row): Cached | undefined =>
  c && c.permission && c.author_id !== null && r.author_id !== null && c.author_id !== r.author_id ? { ...c, permission: null, checked_at: null } : c;
/** Entries by repo and lower-cased login: logins compare case-insensitively. */
const entriesOf = (rows: Map<string, AuthorPermissionRow>): Map<string, Cached> =>
  new Map([...rows.values()].map(({ login, repo, ...c }) => [`${repo}\n${login.toLowerCase()}`, c]));
const cached = async (db: Db, repo: string, r: Row & { author: string }): Promise<Cached | undefined> =>
  ownEntry(entriesOf(await loadAuthorPermissions(db, { repos: [repo], logins: [r.author] })).get(`${repo}\n${r.author.toLowerCase()}`), r);
const old = (at: string | null, nowMs: number = Date.now()): boolean => !at || nowMs - Date.parse(at) > AUTHOR_PERMISSION_TTL_MS;
/** The reads have failed too often or for too long. */
const gaveUp = (c: Cached, nowMs: number = Date.now()): boolean => c.failures >= AUTHOR_READ_FAILURES || (!!c.first_failure_at && old(c.first_failure_at, nowMs));
/** The first time after which `old(at)` holds. */
const oldFrom = (at: string | null): number => (at ? Date.parse(at) + AUTHOR_PERMISSION_TTL_MS + 1 : -Infinity);

/** After this many failed reads, or this long since the first, an author never read counts as unable to write. */
export const AUTHOR_READ_FAILURES = 3;

/**
 * Database only: whether the PR's author can write to the repository, as last read. A stale entry still counts until it is refreshed,
 * but not once its refresh has failed too often or for too long.
 */
export async function authorWrites(db: Db, repo: string, number: number): Promise<AuthorWrite> {
  const r = await authorOf(db, repo, number);
  if (!r?.author) return "no";
  if (writesByRole(await setting(db, PIPELINE_LOGIN_KEY), r)) return "yes";
  return writesFrom(await cached(db, repo, { ...r, author: r.author }));
}

/**
 * authorWrites() for many PRs, from their items rows and the stored permissions, at `nowMs`; `me` is the pipeline's login. `change` is
 * told when the answer would change with the clock alone (an entry aging past the TTL after its refresh failed).
 */
export function authorWritesIn(me: string | null | undefined, permissions: Awaited<ReturnType<typeof loadAuthorPermissions>>, nowMs: number): (repo: string, r: Row, change?: (at: number) => void) => AuthorWrite {
  const entries = entriesOf(permissions);
  return (repo, r, change) => {
    if (!r.author) return "no";
    if (writesByRole(me ?? undefined, r)) return "yes";
    const c = ownEntry(entries.get(`${repo}\n${r.author.toLowerCase()}`), r);
    const w = writesFrom(c, nowMs);
    if (c && w !== "no") change?.(noFrom(c));
    return w;
  };
}

function writesFrom(c: Cached | undefined, nowMs: number = Date.now()): AuthorWrite {
  if (c?.permission) return old(c.checked_at, nowMs) && gaveUp(c, nowMs) ? "no" : WRITE.has(c.permission) ? "yes" : "no";
  // Never read: waiting, until the reads have failed too often or for too long; then the PR gets the normal cannot-push hold.
  return c && gaveUp(c, nowMs) ? "no" : "unknown";
}

/** When writesFrom() turns to "no" with the clock alone: both the entry and the failed reads are old (a read entry), or the failed reads are (a missing one). */
function noFrom(c: Cached): number {
  const failedOld = c.failures >= AUTHOR_READ_FAILURES ? -Infinity : c.first_failure_at ? oldFrom(c.first_failure_at) : Infinity;
  return c.permission ? Math.max(oldFrom(c.checked_at), failedOld) : failedOld;
}

export type PermissionReader = (repo: string, login: string) => Promise<string | null>;

/** The login's permission on the repository from GitHub (a 404 is `none`); null when it cannot be told. */
export const ghPermission: PermissionReader = async (repo, login) => {
  const r = await gh(["api", `repos/${slugOf(repo)}/collaborators/${encodeURIComponent(login)}/permission`, "--jq", ".permission"]);
  if (r.code !== 0) return /HTTP 404|Not Found/i.test(r.err) ? "none" : null;
  const p = r.out.trim().toLowerCase();
  return KNOWN.has(p) ? p : null;
};

/**
 * For a job about to push: reads the author's permission from GitHub when it is missing or over a day old, stores it, and
 * answers like `authorWrites`. A PR whose head is in another repository needs no author permission. A failed read keeps an old
 * entry and is counted; without an entry the answer is "unknown" (the caller leaves the PR for a later run) until the reads
 * have failed three times or for a day.
 */
export async function ensureAuthorWrites(db: Db, repo: string, number: number, headRepo: string | null | undefined, read: PermissionReader = ghPermission): Promise<AuthorWrite> {
  if (!sameRepo(headRepo, repo)) return "yes";
  const r = await authorOf(db, repo, number);
  if (!r?.author) return "no";
  if (!writesByRole(await setting(db, PIPELINE_LOGIN_KEY), r)) {
    const c = await cached(db, repo, { ...r, author: r.author });
    if (!c?.permission || old(c.checked_at)) {
      await saveAuthorPermissions(db, [{ login: r.author, repo, permission: await read(repo, r.author).catch(() => null), at: new Date().toISOString(), authorId: r.author_id }]);
    }
  }
  return await authorWrites(db, repo, number);
}
