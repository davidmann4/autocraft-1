// The access list (M03 access-a).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { freshConfig } from "../control/settings.ts";
import { addAudit } from "../control/audit.ts";
import type { AccessRow, Login, RemovedSummary, Role } from "./types.ts";

/** Why a change to the access list was refused; `message` is the text the dashboard and the CLI show. */
export class AccessRefused extends Error {
  readonly reason: "exists" | "missing" | "last-operator";
  constructor(reason: AccessRefused["reason"], login: string) {
    super(reason === "exists" ? `${login} is already on the access list` : reason === "missing" ? `${login} is not on the access list` : "That would leave no operator. Add another operator first.");
    this.reason = reason;
  }
}

const RANK: Record<Role, number> = { viewer: 0, maintainer: 1, operator: 2 };

/** Every access row ordered by login without case. */
export async function listAccess(db: Db): Promise<AccessRow[]> {
  const q = queryDb(db);
  return await q.all(q.k.selectFrom("main.access").select(kx.cols("access")).$narrowType<{ role: Role }>().orderBy(kx.nocase(db, "login")));
}

/** Access rows by lower-cased login. */
export async function loadAccess(db: Db, logins: readonly Login[]): Promise<Map<string, AccessRow>> {
  const out = new Map<string, AccessRow>();
  if (!logins.length) return out;
  const q = queryDb(db);
  for (const part of kx.chunks(logins)) {
    for (const r of await q.all(q.k.selectFrom("main.access").select(kx.cols("access")).$narrowType<{ role: Role }>().where(kx.inList(db, "login", part, "citext")))) out.set(r.login.toLowerCase(), r);
  }
  return out;
}

/** Logins holding one of the roles. */
export async function loginsWithRole(db: Db, roles: readonly Role[]): Promise<Login[]> {
  if (!roles.length) return [];
  const q = queryDb(db);
  return (await q.all(q.k.selectFrom("main.access").select("login").where("role", "in", [...roles]))).map((r) => r.login);
}

/** Number of operators. */
export async function countOperators(db: Db): Promise<number> {
  const q = queryDb(db);
  return Number((await q.get(q.k.selectFrom("main.access").select((eb) => eb.fn.countAll<number>().as("n")).where("role", "=", "operator")))!.n);
}

/** Insert guarded by `on conflict do nothing` (no row changed means already on the list) and an audit row, in one `db.write`. */
export async function addLogin(db: Db, by: string, row: { login: Login; role: Role; note: string | null; githubId?: number | null }): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    const at = new Date().toISOString();
    const r = await q.run(q.k.insertInto("main.access").values({ login: row.login, role: row.role, added_by: by, added_at: at, note: row.note || null, github_id: row.githubId ?? null })
      .onConflict((oc) => oc.doNothing()));
    if (!r.changes) throw new AccessRefused("exists", row.login);
    await addAudit(db, [{ login: by, action: "access-add", target: row.login, details: { role: row.role }, at }]);
  });
}

/** Deletes the login's cached permissions and sessions; the number of sessions ended. */
async function endLoginSessions(db: Db, login: string): Promise<number> {
  const q = queryDb(db);
  await q.run(q.k.deleteFrom("main.repo_permissions").where((eb) => kx.ciEq(db, "login", eb.val(login))));
  return Number((await q.run(q.k.deleteFrom("main.sessions").where((eb) => kx.ciEq(db, "login", eb.val(login))))).changes);
}

/** Drops the login's GitHub App user token and queues its revocation; whether a row existed. */
async function dropLoginUserTokens(db: Db, login: string): Promise<boolean> {
  const q = queryDb(db);
  const rows = await q.all(q.k.deleteFrom("main.user_tokens").where((eb) => kx.ciEq(db, "login", eb.val(login))).returning("token_enc"));
  if (!rows.length) return false;
  const queued_at = new Date().toISOString();
  await q.run(q.k.insertInto("main.user_token_revocations").values(rows.map((r) => ({ login, token_enc: r.token_enc, queued_at, kind: "grant" }))));
  return true;
}

/** Org setup links are an operator's: they end when their creator stops being one. */
async function endLoginSetupLinks(db: Db, login: string): Promise<number> {
  const q = queryDb(db);
  return Number((await q.run(q.k.updateTable("main.github_setup_links").set({ revoked_at: new Date().toISOString() })
    .where((eb) => kx.ciEq(db, "created_by", eb.val(login))).where("revoked_at", "is", null).where("used_at", "is", null))).changes);
}

async function keepAnOperator(db: Db, row: AccessRow): Promise<void> {
  if (row.role === "operator" && await countOperators(db) <= 1) throw new AccessRefused("last-operator", row.login);
}

async function rowOf(db: Db, login: string): Promise<AccessRow> {
  const q = queryDb(db);
  const row = await q.get(q.k.selectFrom("main.access").select(kx.cols("access")).$narrowType<{ role: Role }>().where((eb) => kx.ciEq(db, "login", eb.val(login))));
  if (!row) throw new AccessRefused("missing", login);
  return row;
}

/** Deletes the login and its permissions, sessions, tokens, user tokens, Discord links and codes, ends its setup links, audits; one `db.write`. `keepOperator` is read inside the transaction. */
export async function removeLogin(db: Db, by: string, login: Login, o?: { keepOperator?: boolean }): Promise<RemovedSummary> {
  const q = queryDb(db);
  return await db.write(async () => {
    const row = await rowOf(db, login);
    if (o?.keepOperator) await keepAnOperator(db, row);
    await q.run(q.k.deleteFrom("main.access").where((eb) => kx.ciEq(db, "login", eb.val(row.login))));
    const sessions = await endLoginSessions(db, row.login);
    // Re-adding the login later must not bring its old agent tokens back.
    const tokens = Number((await q.run(q.k.deleteFrom("main.mcp_tokens").where((eb) => kx.ciEq(db, "login", eb.val(row.login))))).changes);
    const userTokens = Number(await dropLoginUserTokens(db, row.login));
    // A linked Discord account acts as the login; the delete trigger takes the alert opt-ins with the links.
    const links = Number((await q.run(q.k.deleteFrom("main.discord_links").where((eb) => kx.ciEq(db, "login", eb.val(row.login))))).changes);
    await q.run(q.k.deleteFrom("main.discord_link_codes").where((eb) => kx.ciEq(db, "login", eb.val(row.login))));
    const setupLinks = await endLoginSetupLinks(db, row.login);
    await addAudit(db, [{ login: by, action: "access-remove", target: row.login, details: { role: row.role, sessions, ...(tokens ? { mcpTokens: tokens } : {}), ...(userTokens ? { userTokens } : {}), ...(links ? { discordLinks: links } : {}), ...(setupLinks ? { setupLinks } : {}) } }]);
    return { role: row.role, sessions, tokens, userTokens, links };
  });
}

/** Changes the role; a change also deletes cached permissions and sessions and drops user tokens, a demotion ends answer tokens, and a role below operator ends setup links; one `db.write`. */
export async function setRole(db: Db, by: string, login: Login, role: Role, o?: { keepOperator?: boolean }): Promise<boolean> {
  const q = queryDb(db);
  return await db.write(async () => {
    const row = await rowOf(db, login);
    if (row.role === role) return false;
    if (o?.keepOperator) await keepAnOperator(db, row);
    await q.run(q.k.updateTable("main.access").set({ role }).where((eb) => kx.ciEq(db, "login", eb.val(row.login))));
    const sessions = await endLoginSessions(db, row.login);
    // A lowered role ends the login's answering tokens: they would work again if the login is promoted again.
    let answerTokens = 0;
    if (RANK[role] < RANK[row.role]) {
      answerTokens = Number((await q.run(q.k.deleteFrom("main.mcp_tokens").where((eb) => kx.ciEq(db, "login", eb.val(row.login))).where("can_answer", "=", 1).where("kind", "=", "connector"))).changes)
        + Number((await q.run(q.k.updateTable("main.mcp_tokens").set({ can_answer: 0 }).where((eb) => kx.ciEq(db, "login", eb.val(row.login))).where("can_answer", "=", 1).where("kind", "=", "runner"))).changes);
    }
    const userTokens = Number(await dropLoginUserTokens(db, row.login));
    const setupLinks = role === "operator" ? 0 : await endLoginSetupLinks(db, row.login);
    await addAudit(db, [{ login: by, action: "access-role", target: row.login, details: { from: row.role, to: role, sessions, ...(answerTokens ? { answerTokens } : {}), ...(userTokens ? { userTokens } : {}), ...(setupLinks ? { setupLinks } : {}) } }]);
    return true;
  });
}

/** Compare-and-set of `github_id` where it is null; one read only when nothing changed. */
export async function bindGithubId(db: Db, login: Login, id: number): Promise<"ok" | "bound" | "mismatch"> {
  const q = queryDb(db);
  const r = await q.run(q.k.updateTable("main.access").set({ github_id: id }).where((eb) => kx.ciEq(db, "login", eb.val(login))).where("github_id", "is", null));
  if (r.changes) return "bound";
  const row = await q.get(q.k.selectFrom("main.access").select("github_id").where((eb) => kx.ciEq(db, "login", eb.val(login))));
  return row && row.github_id !== null && Number(row.github_id) === id ? "ok" : "mismatch";
}

/** The access row, only while it is bound to that GitHub id. */
export async function actorOf(db: Db, login: Login, githubId: number): Promise<AccessRow | null> {
  const q = queryDb(db);
  const row = await q.get(q.k.selectFrom("main.access").select(kx.cols("access")).$narrowType<{ role: Role }>().where((eb) => kx.ciEq(db, "login", eb.val(login))));
  return row && row.github_id !== null && Number(row.github_id) === githubId ? row : null;
}

/** The app bot logins (bare slug and `<slug>[bot]` of the registered app and every slug seen) plus the box login, lower case. */
export async function loadOwnLogins(db: Db): Promise<Set<string>> {
  const q = queryDb(db);
  const [app, cfg] = await db.together(() => Promise.all([
    q.get(q.k.selectFrom("main.github_app").select("slug").where("id", "=", 1)),
    freshConfig(db, ["pipeline_login", "app_slugs"]),
  ]));
  const out = new Set<string>();
  if (cfg.pipelineLogin) out.add(cfg.pipelineLogin.toLowerCase());
  for (const s of [...cfg.appSlugs, ...(app?.slug ? [app.slug] : [])]) out.add(s.toLowerCase()).add(`${s.toLowerCase()}[bot]`);
  return out;
}
