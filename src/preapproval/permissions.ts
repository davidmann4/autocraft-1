// The pipeline's own reading of a maintainer's write permission. A maintainer's pre-approved merge, the Merge answer it rests on and a
// queued fix-up request count only while the maintainer's cached write permission is fresh (src/settlers.ts), and a dashboard session
// refreshes that row only while the person uses the dashboard. The pipeline reads it again through the GitHub App installation
// (src/remote/permission.ts, which writes repo_permissions) shortly before it expires, so these long-lived rows do not end with the session.
import { mergeDecisionId } from "../core/rules.ts";
import { PERM_READ_TTL } from "../dash/server/sessions.ts";
import { WRITE_PERMISSIONS } from "../dash/server/provider.ts";
import { appPermission, type AppPermission } from "../remote/permission.ts";
import { maintainersSettle, maintainersSettleOn, settleKey, settlesNow } from "../settlers.ts";
import type { Db } from "../db/index.ts";
import { rowid } from "../db/kx.ts";

/** A write permission older than this is read again, so it stays younger than PERM_READ_TTL while GitHub answers. About one read per login and repo per TTL. */
export const REFRESH_AFTER = PERM_READ_TTL - 2 * 60_000;
/** A write permission GitHub has not confirmed for this long no longer counts while reads fail or the app cannot see the login (404, no token). */
export const HOLD_MAX = 60 * 60_000;

const lastFailure = new Map<string, string>();

export type RefreshDeps = {
  /** Stands in for `appPermission`, which writes the answer to repo_permissions. */
  permission?: (db: Db, login: string, repo: string) => Promise<AppPermission>;
};

const answeredMerge = async (db: Db, repo: string, number: number, head: string): Promise<string | null> =>
  (await db.get(db.k.selectFrom("main.decisions").select("answered_by").where("id", "=", mergeDecisionId(repo, number, head)).where("answer", "=", "merge")))?.answered_by ?? null;

/** The maintainer logins the pipeline acts for, with the repo: makers of active pre-approvals and queued fix-up requests, and who answered the Merge a queued pre-approval rests on or that has yet to carry across a base merge. */
async function pipelineMaintainers(db: Db): Promise<{ login: string; repo: string }[]> {
  const maintainers = new Set((await db.all(db.k.selectFrom("main.access").select("login").where("role", "=", "maintainer"))).map((r) => r.login));
  if (!maintainers.size) return [];
  const pairs = new Map<string, { login: string; repo: string }>();
  const add = (login: string | null, repo: string) => {
    if (login && maintainers.has(login)) pairs.set(settleKey(login, repo), { login, repo });
  };
  const active = await db.all(db.k.selectFrom("preapprovals").select(["repo", "number", "state", "head", "by"]).where("state", "in", ["fixup", "review", "ci", "queued"])
    .where("repo", "in", (eb) => eb.selectFrom("main.tracked_repos").select("name")).orderBy("repo").orderBy("number").orderBy("id"));
  for (const p of active) {
    add(p.by, p.repo);
    if (p.state === "queued" && p.head) add(await answeredMerge(db, p.repo, p.number, p.head), p.repo);
  }
  for (const o of await db.all(db.k.selectFrom("operator_fixups").select(["by", "repo"]).where("state", "=", "queued").orderBy("id"))) add(o.by, o.repo);
  // A Merge answer that carries across the pipeline's own base merge (carryAnswers) and has not carried yet.
  const carries = await db.all(db.k.selectFrom("conflict_merges as m")
    .innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "m.repo").onRef("i.number", "=", "m.number"))
    .select(["m.repo", "m.number", "m.from_head"])
    .where("m.state", "=", "merged").where("m.own_diff", "=", "same").where("i.state", "=", "OPEN").whereRef("i.head_oid", "=", "m.to_head")
    .where("m.repo", "in", (eb) => eb.selectFrom("main.tracked_repos").select("name"))
    .where((eb) => eb.not(eb.exists(eb.selectFrom("preapprovals as p").select(eb.lit(1).as("one")).whereRef("p.repo", "=", "m.repo").whereRef("p.number", "=", "m.number").whereRef("p.head", "=", "m.to_head"))))
    .orderBy("m.repo").orderBy("m.number").orderBy("m.created_at").orderBy(rowid("conflict_merges", "m")));
  for (const x of carries) add(await answeredMerge(db, x.repo, x.number, x.from_head), x.repo);
  return [...pairs.values()];
}

/**
 * Starts a read through the GitHub App for each maintainer the pipeline acts for whose cached write permission is older than REFRESH_AFTER,
 * and returns the `settleKey`s whose write permission still counts past PERM_READ_TTL: those with no newer answer yet, because the read is
 * under way or failed (it is made again on the next pass), up to HOLD_MAX after GitHub last confirmed it. A fresh answer that is not write
 * ends it; a role or setting change ends it as before. Only a write permission is kept: a stale non-write row is not read again.
 * `wake` is told when a write permission reaches REFRESH_AFTER and a held one HOLD_MAX, and, after the pass, when a read started here ends:
 * its answer (or failure, read again on the next pass) is the next pass's input.
 */
export async function refreshSettlers(db: Db, log: (line: string) => void = () => {}, deps: RefreshDeps = {}, wake: (at: number) => void = () => {}): Promise<Set<string>> {
  const held = new Set<string>();
  const all = await maintainersSettle(db);
  const read = deps.permission ?? ((d, login, repo) => appPermission(d, login, repo));
  const now = Date.now();
  const settlesOn = new Map<string, boolean>();
  for (const { login, repo } of await pipelineMaintainers(db)) {
    if (!all) {
      // A repo on the maintainer workflow lets its maintainers settle without `maintainer_writes`.
      if (!settlesOn.has(repo)) settlesOn.set(repo, await maintainersSettleOn(db, repo));
      if (!settlesOn.get(repo)) continue;
    }
    const row = await db.get(db.k.selectFrom("main.repo_permissions").select(["permission", "checked_at"]).where("login", "=", login).where("repo", "=", repo));
    const age = row ? now - Date.parse(row.checked_at) : NaN;
    if (row && WRITE_PERMISSIONS.has(row.permission) && age < REFRESH_AFTER) wake(Date.parse(row.checked_at) + REFRESH_AFTER);
    // Past HOLD_MAX (or an unreadable time) the row is not held and the pre-approval ends: a read started now would come too late for this pass.
    if (!row || !WRITE_PERMISSIONS.has(row.permission) || !(age >= REFRESH_AFTER && age < HOLD_MAX)) continue;
    const k = settleKey(login, repo);
    held.add(k);
    wake(Date.parse(row.checked_at) + HOLD_MAX);
    const fail = (why: string) => {
      // Read again on every pass while GitHub fails: the log gets each new reason once.
      if (lastFailure.get(k) !== why) log(`permission of ${login} on ${repo}: ${why}`);
      lastFailure.set(k, why);
    };
    read(db, login, repo).then(
      (r) => (r.kind === "error" ? fail(r.why) : r.kind === "unavailable" ? fail("the GitHub App cannot read it (no installation token, or GitHub answered 404)") : void lastFailure.delete(k)),
      (e) => fail((e as Error).message),
    ).finally(() => wake(Date.now()));
  }
  return held;
}

/**
 * Whether `login` settles on `repo` with a write permission confirmed now, for a write the pipeline makes on that person's answer without the
 * user lane (an integration batch's merge). An operator settles; a maintainer needs a write permission checked within PERM_READ_TTL, else it is
 * read through the GitHub App (`read`, which writes repo_permissions). "unknown" when GitHub could not answer and the last write permission is
 * younger than HOLD_MAX: the caller waits. Past that, or on a fresh non-write answer, "no".
 */
export async function settlesLive(db: Db, login: string, repo: string, read: RefreshDeps["permission"] = (d, l, r) => appPermission(d, l, r)): Promise<"yes" | "no" | "unknown"> {
  const role = (await db.get(db.k.selectFrom("main.access").select("role").where("login", "=", login)))?.role;
  if (role !== "maintainer" || !await maintainersSettleOn(db, repo)) return await settlesNow(db, login, [repo]) ? "yes" : "no";
  const age = async (): Promise<number> => {
    const row = await db.get(db.k.selectFrom("main.repo_permissions").select(["permission", "checked_at"]).where("login", "=", login).where("repo", "=", repo));
    return row && WRITE_PERMISSIONS.has(row.permission) ? Date.now() - Date.parse(row.checked_at) : NaN;
  };
  const before = await age();
  if (!(before < PERM_READ_TTL)) {
    let r: AppPermission;
    try { r = await read(db, login, repo); } catch (e) { r = { kind: "error", why: (e as Error).message }; }
    if (r.kind !== "ok") return before < HOLD_MAX ? "unknown" : "no";
  }
  return await settlesNow(db, login, [repo]) ? "yes" : "no";
}
