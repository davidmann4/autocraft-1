// Cached repo permissions and the act rule (M03 access-a).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import type { ActFacts, ActIdentity, ActRefusal, ActVerdict, Login, PermEntry, PermKey, PermRow, Role, Standing } from "./types.ts";

export const WRITE_PERMISSIONS: readonly string[] = ["write", "maintain", "admin"];
export const PERM_READ_TTL = 10 * 60_000;
export const PERM_WRITE_TTL = 60_000;
/** A write permission older than this is read again, so it stays younger than `PERM_READ_TTL` while GitHub answers. */
export const REFRESH_AFTER = PERM_READ_TTL - 2 * 60_000;
/** How long after GitHub last confirmed it a write permission still counts for work under way, while it is read again. */
export const HOLD_MAX = 60 * 60_000;

/** The key of a (login, repo) pair in the maps of this file: the login lower-cased. */
export const permKey = (login: string, repo: string): PermKey => `${login.toLowerCase()}\n${repo}`;

/** Cached permission per login and repo; one JSON-bound tuple lookup. */
export async function loadPermissions(db: Db, pairs: readonly { login: Login; repo: string }[]): Promise<Map<PermKey, PermEntry>> {
  const out = new Map<PermKey, PermEntry>();
  if (!pairs.length) return out;
  const q = queryDb(db);
  for (const part of kx.chunks(pairs)) {
    const rows = await q.all(q.k.selectFrom("main.repo_permissions").select(["login", "repo", "permission", "checked_at"])
      .where(kx.tupleIn(db, ["login", "repo"], part.map((p) => [p.login, p.repo]), ["citext", "text"])));
    for (const r of rows) out.set(permKey(r.login, r.repo), { permission: r.permission, checkedAt: r.checked_at });
  }
  return out;
}

/** All cached rows of those logins. */
export async function loadPermissionsOfLogins(db: Db, logins: readonly Login[]): Promise<Map<string, PermRow[]>> {
  const out = new Map<string, PermRow[]>();
  if (!logins.length) return out;
  const q = queryDb(db);
  for (const part of kx.chunks(logins)) {
    for (const r of await q.all(q.k.selectFrom("main.repo_permissions").select(kx.cols("repo_permissions")).where(kx.inList(db, "login", part, "citext")))) {
      const k = r.login.toLowerCase();
      const list = out.get(k);
      if (list) list.push(r);
      else out.set(k, [r]);
    }
  }
  return out;
}

/** One person, many repos (a session's visible repos). */
export async function loadPermissionsForRepos(db: Db, login: Login, repos: string[]): Promise<Map<string, PermEntry>> {
  const out = new Map<string, PermEntry>();
  if (!repos.length) return out;
  const q = queryDb(db);
  for (const part of kx.chunks(repos)) {
    const rows = await q.all(q.k.selectFrom("main.repo_permissions").select(["repo", "permission", "checked_at"])
      .where((eb) => kx.ciEq(db, "login", eb.val(login))).where(kx.inList(db, "repo", part)));
    for (const r of rows) out.set(r.repo, { permission: r.permission, checkedAt: r.checked_at });
  }
  return out;
}

const byRepo = (rows: readonly { repo: string; permission: string; checked_at: string }[]): Map<string, PermEntry> =>
  new Map(rows.map((r) => [r.repo, { permission: r.permission, checkedAt: r.checked_at }]));

/** Every cached permission of one login, by repo. */
export async function loadPermissionsOf(db: Db, login: Login): Promise<Map<string, PermEntry>> {
  const q = queryDb(db);
  return byRepo(await q.all(q.k.selectFrom("main.repo_permissions").select(["repo", "permission", "checked_at"]).where((eb) => kx.ciEq(db, "login", eb.val(login)))));
}

/** Every cached permission of the login a session belongs to, by repo, without knowing the login yet. */
export async function loadPermissionsOfSession(db: Db, idHash: string): Promise<Map<string, PermEntry>> {
  const q = queryDb(db);
  return byRepo(await q.all(q.k.selectFrom("main.repo_permissions").select(["repo", "permission", "checked_at"])
    .where("login", "in", (eb) => eb.selectFrom("main.sessions").select("login").where("id_hash", "=", idHash))));
}

/** Batched upsert, one statement per 500 rows. A pair listed twice (in any letter case of the login) keeps its last row. */
export async function savePermissions(db: Db, rows: { login: Login; repo: string; permission: string; checkedAt: string }[]): Promise<void> {
  const last = new Map<PermKey, (typeof rows)[number]>();
  for (const r of rows) last.set(permKey(r.login, r.repo), r);
  if (!last.size) return;
  const q = queryDb(db);
  for (const part of kx.batches([...last.values()])) {
    await q.run(q.k.insertInto("main.repo_permissions").values(part.map((r) => ({ login: r.login, repo: r.repo, permission: r.permission, checked_at: r.checkedAt })))
      .onConflict((oc) => oc.columns(["login", "repo"]).doUpdateSet(kx.excluded(["permission", "checked_at"]))));
  }
}

/** Batched delete. */
export async function endPermissions(db: Db, logins: Login[]): Promise<number> {
  if (!logins.length) return 0;
  const q = queryDb(db);
  let n = 0;
  for (const part of kx.chunks(logins)) n += Number((await q.run(q.k.deleteFrom("main.repo_permissions").where(kx.inList(db, "login", part, "citext")))).changes);
  return n;
}

/**
 * Cached rows below write permission, checked within `PERM_READ_TTL` (Task Runner claim snapshot), with the permission and when it was
 * checked. Given logins, their rows; given `{ runners: true }`, the rows of every login with a live Task Runner credential (one
 * statement, so the snapshot reads it in its own wave); given item keys, the rows of every login on the repos of those items.
 */
export async function loadPermissionDenials(db: Db, logins: Login[] | { runners: true } | KeySource, nowMs: number): Promise<Map<PermKey, PermEntry>> {
  const out = new Map<PermKey, PermEntry>();
  const nowIso = new Date(nowMs).toISOString();
  const since = new Date(nowMs - PERM_READ_TTL).toISOString();
  const q = queryDb(db);
  const base = () => q.k.selectFrom("main.repo_permissions").select(["login", "repo", "permission", "checked_at"]).where("checked_at", ">", since)
    .where("permission", "not in", [...WRITE_PERMISSIONS]);
  const keep = (rows: { login: string; repo: string; permission: string; checked_at: string }[]): void => {
    for (const r of rows) out.set(permKey(r.login, r.repo), { permission: r.permission, checkedAt: r.checked_at });
  };
  if (!Array.isArray(logins) && "runners" in logins) {
    keep(await q.all(base().where("login", "in", (eb) => eb.selectFrom("main.mcp_tokens").select("login").where("kind", "=", "runner").where("expires_at", ">", nowIso))));
    return out;
  }
  if (Array.isArray(logins) && logins.every((l) => typeof l === "string")) {
    for (const part of kx.chunks(logins as Login[])) keep(await q.all(base().where(kx.inList(db, "login", part, "citext"))));
    return out;
  }
  const keys = logins as KeySource;
  if (Array.isArray(keys) && !keys.length) return out;
  keep(await q.all(base().where((eb) => eb("repo", "in", eb.selectFrom(resolveKeys(db, keys, "kr")).select("kr.repo")))));
  return out;
}

/** The (login, repo) pairs of `logins` with a cached write permission checked within `PERM_READ_TTL`. */
export async function loadFreshWrites(db: Db, logins: readonly Login[], nowMs: number): Promise<Set<PermKey>> {
  const out = new Set<PermKey>();
  if (!logins.length) return out;
  const since = new Date(nowMs - PERM_READ_TTL).toISOString();
  const q = queryDb(db);
  for (const part of kx.chunks(logins)) {
    const rows = await q.all(q.k.selectFrom("main.repo_permissions").select(["login", "repo"]).where(kx.inList(db, "login", part, "citext"))
      .where("checked_at", ">", since).where("permission", "in", [...WRITE_PERMISSIONS]));
    for (const r of rows) out.add(permKey(r.login, r.repo));
  }
  return out;
}

/** One LEFT JOIN of the pairs to `access` and `repo_permissions`; the only database read of the act rule. */
export async function loadActFacts(db: Db, pairs: { login: string | null; repo: string }[]): Promise<Map<PermKey, ActFacts>> {
  const out = new Map<PermKey, ActFacts>();
  const named = new Map<PermKey, { login: string; repo: string }>();
  for (const p of pairs) {
    if (p.login === null) out.set(permKey("", p.repo), { login: null, role: null, githubId: null, perm: null });
    else named.set(permKey(p.login, p.repo), { login: p.login, repo: p.repo });
  }
  const q = queryDb(db);
  for (const part of kx.chunks([...named.values()])) {
    const rows = await q.all(q.k.selectFrom(kx.valuesTable(db, part, { login: "citext", repo: "text" }, "p"))
      .leftJoin("main.access as a", (j) => j.on(kx.ciEq(db, "a.login", "p.login")))
      .leftJoin("main.repo_permissions as rp", (j) => j.on(kx.ciEq(db, "rp.login", "p.login")).onRef("rp.repo", "=", "p.repo"))
      .select(["p.login as login", "p.repo as repo", "a.role as role", "a.github_id as github_id", "rp.permission as permission", "rp.checked_at as checked_at"]));
    for (const r of rows) {
      if (r.login === null || r.repo === null) continue;
      out.set(permKey(r.login, r.repo), {
        login: r.login, role: (r.role as Role | null) ?? null, githubId: r.github_id === null || r.github_id === undefined ? null : Number(r.github_id),
        perm: r.permission !== null && r.checked_at !== null ? { permission: r.permission, checkedAt: r.checked_at } : null,
      });
    }
  }
  return out;
}

/** The set form for the planner and bulk commands; never calls GitHub. `why: "stale"` tells the caller to re-read the permission. */
export async function canActMany(db: Db, pairs: { login: string | null; repo: string }[], o: { identity: ActIdentity; mode: "cached"; maxAgeMs: number; now?: number }): Promise<Map<PermKey, ActVerdict>> {
  const facts = await loadActFacts(db, pairs);
  const now = o.now ?? Date.now();
  const out = new Map<PermKey, ActVerdict>();
  for (const p of pairs) {
    const key = permKey(p.login ?? "", p.repo);
    const f = facts.get(key) ?? { login: p.login, role: null, githubId: null, perm: null };
    const write = freshWrite(f.perm, o.maxAgeMs, now) ? "cached"
      : f.perm && !isWrite(f.perm.permission) && now - Date.parse(f.perm.checkedAt) < o.maxAgeMs ? "no" : "unknown";
    out.set(key, decideAct(f, write, o.identity));
  }
  return out;
}

/** The request form, in the order of today's `actRefusal`: login, role, the live write check, then the identity. */
export async function canAct(db: Db, actor: { login: string | null; canWrite(repo: string): Promise<boolean> }, repo: string, o: { identity: ActIdentity }): Promise<ActRefusal | null> {
  const facts: ActFacts = actor.login === null ? { login: null, role: null, githubId: null, perm: null } : (await loadActFacts(db, [{ login: actor.login, repo }])).get(permKey(actor.login, repo))!;
  // The identity check comes last: with "app" here only the login and the role can refuse.
  const early = decideAct(facts, "yes", "app");
  if (!early.ok) return early.why as ActRefusal;
  const write = await actor.canWrite(repo).catch(() => false);
  const v = decideAct(facts, write ? "yes" : "no", o.identity);
  return v.ok ? null : v.why as ActRefusal;
}

/** Whether the permission is write or better. */
export function isWrite(permission: string | null | undefined): boolean {
  return !!permission && WRITE_PERMISSIONS.includes(permission);
}

/** Whether a cached write permission is young enough. */
export function freshWrite(row: PermEntry | null | undefined, maxAgeMs: number, now: number): boolean {
  return !!row && isWrite(row.permission) && now - Date.parse(row.checkedAt) < maxAgeMs;
}

/** The act rule over loaded facts: login, role, write access, then the identity, in that order. */
export function decideAct(facts: ActFacts, write: "yes" | "no" | "unknown" | "cached", identity: ActIdentity): ActVerdict {
  if (!facts.login || facts.role === null) return { ok: false, why: "no-login" };
  if (facts.role !== "operator" && facts.role !== "maintainer") return { ok: false, why: "no-role" };
  if (write === "no") return { ok: false, why: "no-write" };
  if (write === "unknown") return { ok: false, why: "stale" };
  if (identity !== "app") return { ok: false, why: "box-identity" };
  return { ok: true, role: facts.role, basis: write === "yes" ? "live" : "cached" };
}

/**
 * Whether an approval a person gave, or work they started, still counts for the repo: the act rule (an operator's or maintainer's AutoCraft
 * role, write access, the app identity) over what GitHub last answered. The write permission is the pipeline's to keep fresh
 * (src/preapproval/permissions.ts). "unknown" when GitHub has not confirmed it within HOLD_MAX, or never answered: the caller keeps the
 * state, carries nothing out and waits for the read; also while writes go out as the box account, which the act rule lets nobody use. "no"
 * only on the role or on GitHub's own answer within PERM_READ_TTL.
 */
export function standing(facts: ActFacts | undefined, identity: ActIdentity, now: number = Date.now()): Standing {
  if (!facts || !decideAct(facts, "yes", "app").ok) return "no";
  if (identity !== "app") return "unknown";
  const age = facts.perm ? now - Date.parse(facts.perm.checkedAt) : NaN;
  if (isWrite(facts.perm?.permission)) return age < HOLD_MAX ? "yes" : "unknown";
  return age < PERM_READ_TTL ? "no" : "unknown";
}

/** `standing` of each pair, with one read. */
export async function standings(db: Db, pairs: { login: string; repo: string }[], o: { identity: ActIdentity; now?: number }): Promise<Map<PermKey, Standing>> {
  const facts = await loadActFacts(db, pairs);
  return new Map(pairs.map((p) => { const k = permKey(p.login, p.repo); return [k, standing(facts.get(k), o.identity, o.now)]; }));
}
