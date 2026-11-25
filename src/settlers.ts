// Who may settle a decision (answer, undo their own answer, Backlog, press a conversation card). An operator always may.
// A maintainer may when `settings.maintainer_writes` is on (or every repo the decision covers runs the maintainer workflow,
// whose act rule needs no such setting), every repo the decision covers has the app's identity (the
// merges and closes then run as that person through the user lane, never as the box account) and the person has write
// permission on every one of those repos.
import { githubIdentity } from "./github/identity.ts";
import { PERM_READ_TTL } from "./dash/server/sessions.ts";
import { HttpError } from "./dash/server/util.ts";
import { slugOf } from "./owners.ts";
import { everySeq } from "./async-seq.ts";
import type { Db } from "./db/index.ts";
import { nowParam } from "./db/portable.ts";
import * as kx from "./db/kx.ts";
import type { AliasableExpression, Expression, SqlBool } from "kysely";
import { setting } from "./settings-read.ts";

export const MAINTAINER_WRITES_KEY = "maintainer_writes";

export const maintainerWritesOn = async (db: Db): Promise<boolean> =>
  (await setting(db, MAINTAINER_WRITES_KEY)) === "1";

/** Maintainers settle now where they have write access: `maintainer_writes` on and the app's identity (which is instance-wide, as `allAppIdentity` reads it). */
export const maintainersSettle = async (db: Db): Promise<boolean> => await maintainerWritesOn(db) && await githubIdentity(db) === "app";

/** The tracked repos on the maintainer workflow (tracked_repos.workflow 'new'). */
const newRepos = async (db: Db): Promise<Set<string>> =>
  new Set((await db.all(db.k.selectFrom("main.tracked_repos").select("name").where("workflow", "=", "new"))).map((r) => r.name));

/**
 * Maintainers settle on every one of `repos` (at least one): `maintainer_writes` is on, or each repo runs the maintainer workflow, where
 * the act rule (`actRefusal`) lets any maintainer with write access start, answer, approve and stop without that setting.
 */
const writesFor = (on: boolean, fresh: ReadonlySet<string>, repos: readonly string[]): boolean => on || (repos.length > 0 && repos.every((r) => fresh.has(r)));

/** `maintainer_writes` is on, or every one of `repos` (at least one) runs the maintainer workflow. */
export const maintainerWritesFor = async (db: Db, repos: readonly string[]): Promise<boolean> => writesFor(await maintainerWritesOn(db), await newRepos(db), repos);

/** `maintainersSettle` for one repo: also true in a repo on the maintainer workflow. */
export const maintainersSettleOn = async (db: Db, repo: string): Promise<boolean> =>
  await githubIdentity(db) === "app" && writesFor(await maintainerWritesOn(db), await newRepos(db), [repo]);

export async function setMaintainerWrites(db: Db, on: boolean): Promise<boolean> {
  if (await maintainerWritesOn(db) === on) return false;
  if (on) await db.run(db.k.insertInto("main.settings").values({ key: MAINTAINER_WRITES_KEY, value: "1" }).onConflict((oc) => oc.column("key").doUpdateSet({ value: "1" })));
  else await db.run(db.k.deleteFrom("main.settings").where("key", "=", MAINTAINER_WRITES_KEY));
  return true;
}

export async function settlerLogins(db: Db): Promise<Set<string>> {
  return new Set((await db.all(db.k.selectFrom((eb) => settlerLoginsQuery(eb).as("s")).select("s.login"))).map((r) => r.login));
}

/**
 * Values read once per planner pass or response, so a loop over decisions does not query per decision. `held` holds `settleKey`s whose
 * cached write permission still counts past PERM_READ_TTL: the pipeline is reading it again from GitHub and has no newer answer yet.
 */
export type SettleMemo = { operators?: Set<string>; maintainers?: Set<string>; on?: boolean; newRepos?: Set<string>; roles?: Promise<void>; app: Map<string, boolean>; write: Map<string, boolean>; held?: ReadonlySet<string> };
export const settleMemo = (): SettleMemo => ({ app: new Map(), write: new Map() });
export const settleKey = (login: string, repo: string): string => `${login}\n${repo}`;

// One read per memo, also for callers that share the memo at the same time: all three fields are set together.
const roles = async (db: Db, m: SettleMemo): Promise<void> => {
  if (m.operators) return;
  m.roles ??= (async () => {
    const [rows, on, fresh] = await Promise.all([db.all(db.k.selectFrom("main.access").select(["login", "role"]).where("role", "in", ["operator", "maintainer"])), maintainerWritesOn(db), newRepos(db)]);
    m.maintainers = new Set(rows.filter((r) => r.role === "maintainer").map((r) => r.login));
    m.on = on;
    m.newRepos = fresh;
    m.operators = new Set(rows.filter((r) => r.role === "operator").map((r) => r.login));
  })();
  // A failed read is not kept: the next caller reads again.
  void m.roles.catch(() => { m.roles = undefined; });
  await m.roles;
};

/** At least one repo, and every repo has the app's identity, so a maintainer's GitHub writes run as that maintainer. */
export async function allAppIdentity(db: Db, repos: string[], m: SettleMemo = settleMemo()): Promise<boolean> {
  return repos.length > 0 && await everySeq(repos, async (r) => {
    let v = m.app.get(r);
    if (v === undefined) m.app.set(r, (v = await githubIdentity(db) === "app"));
    return v;
  });
}

/** A cached write permission younger than PERM_READ_TTL, or an older one the memo holds; the write itself reads the live permission again. */
async function cachedWrite(db: Db, login: string, repo: string, m: SettleMemo): Promise<boolean> {
  const k = settleKey(login, repo);
  let v = m.write.get(k);
  if (v === undefined) {
    const row = await db.get(db.k.selectFrom("main.repo_permissions").select("checked_at").where("login", "=", login).where("repo", "=", repo).where("permission", "in", WRITE_PERMISSIONS));
    m.write.set(k, (v = !!row && (Date.now() - Date.parse(row.checked_at) < PERM_READ_TTL || !!m.held?.has(k))));
  }
  return v;
}

/** The sync form for views and the planner: write permission from the cached `repo_permissions` value. */
export async function canSettleCached(db: Db, login: string, role: string, repos: string[], m: SettleMemo = settleMemo()): Promise<boolean> {
  if (role === "operator") return true;
  await roles(db, m);
  if (role !== "maintainer" || !writesFor(m.on!, m.newRepos!, repos) || !await allAppIdentity(db, repos, m)) return false;
  return await everySeq(repos, async (r) => await cachedWrite(db, login, r, m));
}

/** The request form: write permission is read live (the session's `canWrite`). An operator's write access is not checked here: request handlers call `settleRefusal`, which does. */
export async function canSettle(db: Db, user: { login: string; role: string; canWrite: (repo: string) => Promise<boolean> }, repos: string[]): Promise<boolean> {
  if (user.role === "operator") return true;
  if (user.role !== "maintainer" || !writesFor(await maintainerWritesOn(db), await newRepos(db), repos) || !await allAppIdentity(db, repos)) return false;
  const ok = await Promise.all(repos.map((r) => user.canWrite(r).catch(() => false)));
  return ok.every(Boolean);
}

/**
 * May `user` act on `repos` now: answer or settle a decision, run a conversation card or choice, put items in the merge queue (Queue items,
 * queue_pr). One rule for every such write a person starts: an operator needs live write access on every repo, a maintainer the rule of
 * `canSettle`. Returns why not, or null; `what` names the action in the refusal ("settles decisions").
 */
export async function settleRefusal(db: Db, user: { login: string; role: string; canWrite: (repo: string) => Promise<boolean> }, repos: string[], what: string): Promise<string | null> {
  if (user.role !== "operator") return (await canSettle(db, user, repos)) ? null : `only an operator, or a maintainer with write access where the app acts for them, ${what}`;
  const ok = await Promise.all(repos.map((r) => user.canWrite(r).catch(() => false)));
  const blocked = repos.filter((_, i) => !ok[i]);
  return blocked.length ? `no write access to ${blocked.map((r) => slugOf(r)).join(", ")}` : null;
}

/** `settleRefusal` as a 403, for the request handlers. */
export async function requireSettle(db: Db, user: Parameters<typeof settleRefusal>[1], repos: string[], what: string): Promise<void> {
  const why = await settleRefusal(db, user, repos, what);
  if (why) throw new HttpError(403, why);
}

/** The DB-side form for the pipeline: the login's current role, and the cached write permission for a maintainer (or one `m.held` keeps). Write access is read live again when the write is made. */
export async function settlesNow(db: Db, login: string | null, repos: string[], m: SettleMemo = settleMemo()): Promise<boolean> {
  if (!login) return false;
  await roles(db, m);
  return m.operators!.has(login) || (m.maintainers!.has(login) && await canSettleCached(db, login, "maintainer", repos, m));
}

/** The cutoff settlesLoginExpr reads a cached write permission against, at `nowMs`: one read before it is not fresh. */
export const settlesAfter = (nowMs: number): { settles_after: string } => ({ settles_after: new Date(nowMs - PERM_READ_TTL).toISOString() });

/** settledByExpr's check for one loaded decision row. */
export async function settledBy(db: Db, d: { answered_by: string | null; repo: string | null; items: string | null; exec_state?: string | null }, m: SettleMemo = settleMemo()): Promise<boolean> {
  if (!d.answered_by || d.exec_state === "disputed") return false;
  await roles(db, m);
  if (m.operators!.has(d.answered_by)) return true;
  if (!m.maintainers!.has(d.answered_by)) return false;
  let items: { repo: string }[] = [];
  try { items = JSON.parse(d.items ?? "[]"); } catch { /* none */ }
  const repos = [...new Set([...(d.repo ? [d.repo] : []), ...items.map((i) => i.repo)])];
  return writesFor(m.on!, m.newRepos!, repos) && await allAppIdentity(db, repos, m);
}

const WRITE_PERMISSIONS = ["write", "maintain", "admin"];

/** The logins of operators. */
const operatorLogins = (eb: kx.AnyEb) => kx.schemaEb(eb).selectFrom("main.access").select("login").where("role", "=", "operator");

/** The logins whose answers the pipeline acts on: operators, and maintainers while `maintainer_writes` is on. */
const settlerLoginsQuery = (eb: kx.AnyEb) => {
  const t = kx.schemaEb(eb);
  return t.selectFrom("main.access").select("login").where((w) => w.or([w("role", "=", "operator"), w.and([w("role", "=", "maintainer"),
    w.exists(t.selectFrom("main.settings").select(w.lit(1).as("one")).where("key", "=", MAINTAINER_WRITES_KEY).where("value", "=", "1"))])]));
};

/** The logins of maintainers. */
const maintainerLogins = (eb: kx.AnyEb) => kx.schemaEb(eb).selectFrom("main.access").select("login").where("role", "=", "maintainer");
/** `maintainer_writes` is on. */
const writesOnExpr = (eb: kx.AnyEb) =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.settings").select(eb.lit(1).as("one")).where("key", "=", MAINTAINER_WRITES_KEY).where("value", "=", "1"));
/** `repo` runs the maintainer workflow. */
const newRepoExpr = (eb: kx.AnyEb, repo: Expression<any>) =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.tracked_repos as tw").select(eb.lit(1).as("one")).where("tw.name", "=", repo).where("tw.workflow", "=", "new"));
/** Maintainers settle on decisions row `a` by repo: `maintainer_writes` on, or its repo (when set) and every batch item's repo on the maintainer workflow. */
const writesForDecisionExpr = (db: Db, eb: kx.AnyEb, a: string) => eb.or([writesOnExpr(eb), eb.and([
  eb.or([eb(eb.ref(`${a}.repo`), "is", null), newRepoExpr(eb, eb.ref(`${a}.repo`))]),
  eb.not(eb.exists(kx.schemaEb(eb).selectFrom(kx.jsonEach(db, itemsJson(db, eb, a), "j")).select(eb.lit(1).as("one"))
    .where(kx.jsonText(db, "j.value", "$.repo"), "is not", null).where((w) => w.not(newRepoExpr(w, kx.jsonText(db, "j.value", "$.repo")))))),
])]);

/** The instance runs as the GitHub App. */
const appIdentity = (eb: kx.AnyEb) =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.settings as s").select(eb.lit(1).as("one")).where("s.key", "=", "github_identity").where("s.value", "=", "app"));

/** The `items` of decisions row `a` when it is a JSON array, else `[]`. */
const itemsJson = (db: Db, eb: kx.AnyEb, a: string) => eb.case().when(kx.jsonValid(db, `${a}.items`)).then(eb.ref(`${a}.items`)).else(eb.val("[]")).end();

/** `login` is an operator, or a maintainer who settles on `repo` (setting on, app identity, a cached write permission read after settlesAfter(nowMs)). */
export function settlesLoginExpr(eb: kx.AnyEb, login: kx.Ex, repo: kx.Ex, nowMs: number): AliasableExpression<SqlBool> {
  const l = kx.exprOf(eb, login);
  return eb.or([eb(l, "in", operatorLogins(eb)), eb.and([eb(l, "in", maintainerLogins(eb)), eb.or([writesOnExpr(eb), newRepoExpr(eb, kx.exprOf(eb, repo))]), appIdentity(eb),
    eb.exists(kx.schemaEb(eb).selectFrom("main.repo_permissions as rp").select(eb.lit(1).as("one")).where("rp.login", "=", l).where("rp.repo", "=", kx.exprOf(eb, repo))
      .where("rp.permission", "in", WRITE_PERMISSIONS).where("rp.checked_at", ">", settlesAfter(nowMs).settles_after))])]);
}

/** When the cached write permission that lets `login` settle on `repo` (expressions) was read; null for an operator, whose settling does not age. Freshness ends PERM_READ_TTL after it. */
export function settlesCheckedAtExpr(eb: kx.AnyEb, login: kx.Ex, repo: kx.Ex): AliasableExpression<string | null> {
  const l = kx.exprOf(eb, login);
  return eb.case().when(l, "in", operatorLogins(eb)).then(eb.lit(null))
    .else(kx.schemaEb(eb).selectFrom("main.repo_permissions as rp").select((s) => s.fn.max("rp.checked_at").as("at")).where("rp.login", "=", l)
      .where("rp.repo", "=", kx.exprOf(eb, repo)).where("rp.permission", "in", WRITE_PERMISSIONS)).end();
}

/**
 * Condition on a decisions row (`a` is its table name or alias): a disputed answer never counts. Otherwise its answer counts because its answerer is an operator, or a
 * maintainer while `maintainer_writes` is on and every repo the decision covers (its own and its batch items') has the app's
 * identity, so its merge or close is made as that person. Checked wherever the pipeline reads answers.
 */
export function settledByExpr(db: Db, eb: kx.AnyEb, a: string): AliasableExpression<SqlBool> {
  const c = (col: string) => eb.ref(`${a}.${col}`);
  return eb.and([eb(c("exec_state"), "is distinct from", "disputed"), eb.or([eb(c("answered_by"), "in", operatorLogins(eb)), eb.and([
    eb(c("answered_by"), "in", maintainerLogins(eb)),
    writesForDecisionExpr(db, eb, a),
    eb.or([eb(c("repo"), "is not", null), eb(kx.jsonArrayLength(db, itemsJson(db, eb, a)), ">", 0)]),
    eb.not(eb.and([eb(c("repo"), "is not", null), eb.not(appIdentity(eb))])),
    eb.not(eb.exists(kx.schemaEb(eb).selectFrom(kx.jsonEach(db, itemsJson(db, eb, a), "j")).select(eb.lit(1).as("one"))
      .where(kx.jsonText(db, "j.value", "$.repo"), "is not", null).where(eb.not(appIdentity(eb))))),
  ])])]);
}

/**
 * Condition on a decisions row (`a`: its table name or alias): `login` with `role` settles it, as `canSettleCached` decides for one row. An operator
 * settles everything. A maintainer needs `maintainer_writes` on, and for the decision's repo and every batch item's repo the app's identity and a fresh
 * cached write permission. Anyone else settles nothing.
 */
export function canSettleExpr(db: Db, eb: kx.AnyEb, login: string, role: string, a = "decisions"): AliasableExpression<SqlBool> {
  if (role === "operator") return eb.lit(true);
  if (role !== "maintainer") return eb.lit(false);
  const t = kx.schemaEb(eb);
  const c = (col: string) => eb.ref(`${a}.${col}`);
  const fresh = nowParam({ offsetMs: -PERM_READ_TTL });
  const ok = (repo: Expression<any>) => eb.and([appIdentity(eb), eb.exists(t.selectFrom("main.repo_permissions as rp").select(eb.lit(1).as("one"))
    .where("rp.login", "=", login).where("rp.repo", "=", repo).where("rp.permission", "in", WRITE_PERMISSIONS).where("rp.checked_at", ">", fresh))]);
  const itemRepo = () => kx.jsonText(db, "j.value", "$.repo");
  return eb.and([
    writesForDecisionExpr(db, eb, a),
    eb.or([eb(c("repo"), "is not", null), eb(kx.jsonArrayLength(db, itemsJson(db, eb, a)), ">", 0)]),
    eb.or([eb(c("repo"), "is", null), ok(c("repo"))]),
    eb.not(eb.exists(t.selectFrom(kx.jsonEach(db, itemsJson(db, eb, a), "j")).select(eb.lit(1).as("one")).where(itemRepo(), "is not", null).where(eb.not(ok(itemRepo()))))),
  ]);
}

/** Why the maintainer workflow refuses someone: no AutoCraft login, a login that is neither operator nor maintainer, no live write access, or the box identity. */
export type ActRefusal = "no-login" | "no-role" | "no-write" | "box-identity";

/**
 * May `user` act on `repo` in the maintainer workflow (repos on `new`): start, answer, approve a merge, stop. The rule is an AutoCraft
 * login with the operator or maintainer role (read from `access`, whatever the caller claims) and live write access on the repo;
 * `maintainer_writes` is not consulted. The app identity is a precondition, so merges and closes run as the person. Null when allowed.
 */
export async function actRefusal(db: Db, user: { login: string | null; canWrite: (repo: string) => Promise<boolean> }, repo: string): Promise<ActRefusal | null> {
  if (!user.login) return "no-login";
  const role = (await db.get(db.k.selectFrom("main.access").select("role").where("login", "=", user.login)))?.role;
  if (role !== "operator" && role !== "maintainer") return role === undefined ? "no-login" : "no-role";
  if (!await user.canWrite(repo).catch(() => false)) return "no-write";
  if (await githubIdentity(db) !== "app") return "box-identity";
  return null;
}
