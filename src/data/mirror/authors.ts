// Author ids and permissions (M02 mirror-b).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import type { Ref } from "../keys.ts";
import type { AuthorHistory, AuthorPermissionRow, AuthorPermissionSave, RefKey } from "./types.ts";

const stateSum = (eb: kx.AnyEb, state: string) => eb.fn.sum<number>(eb.case().when("state", "=", state).then(eb.lit(1)).else(eb.lit(0)).end());

/**
 * The lowercase logins that authored each item, or authored or co-authored a commit of it (the git author and the Co-authored-by
 * trailers, as GitHub lists them), keyed `repo#number`; items with none are absent. 1 statement per 10,000 refs.
 */
export async function loadItemAuthors(db: Db, refs: Ref[]): Promise<Map<RefKey, string[]>> {
  const out = new Map<RefKey, Set<string>>();
  if (!refs.length) return new Map();
  const q = queryDb(db), k = q.k as any;
  const add = (key: RefKey, login: unknown): void => { if (typeof login === "string" && login) (out.get(key) ?? out.set(key, new Set()).get(key)!).add(login.toLowerCase()); };
  for (const part of kx.chunks(refs)) {
    const pairs = part.map((r) => [r.repo, r.number] as const);
    const rows = await q.all(k.selectFrom("main.items as i").select(["i.repo", "i.number", "i.author", (eb: kx.AnyEb) => eb.cast(eb.val(null), "text").as("co_authors")])
      .where("i.author", "is not", null).where(kx.refIn(db, "i", pairs))
      .unionAll(k.selectFrom("main.pr_commits as c").select(["c.repo", "c.number", "c.author", "c.co_authors"]).where(kx.refIn(db, "c", pairs)))) as
      { repo: string; number: number; author: string | null; co_authors: string | null }[];
    for (const r of rows) {
      const key = `${r.repo}#${r.number}`;
      add(key, r.author);
      let co: unknown = [];
      try { co = r.co_authors ? JSON.parse(r.co_authors) : []; } catch { /* not JSON: no co-authors */ }
      if (Array.isArray(co)) for (const x of co) add(key, x);
    }
  }
  return new Map([...out].map(([key, set]) => [key, [...set]]));
}

/** Bound GitHub account id per login. */
export async function loadAuthorIds(db: Db, logins: string[] | "all"): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (logins !== "all" && !logins.length) return out;
  const q = queryDb(db);
  for (const part of logins === "all" ? [null] : kx.chunks(logins)) {
    const rows = await q.all(q.k.selectFrom("main.author_ids").select(["login", "id"]).$if(part !== null, (b) => b.where(kx.inList(db, "login", part!))));
    for (const r of rows) out.set(r.login, Number(r.id));
  }
  return out;
}

/** Insert `DO NOTHING`; one statement per 500 rows; returns the count bound. */
export async function bindAuthorIds(db: Db, rows: { login: string; id: number }[]): Promise<number> {
  if (!rows.length) return 0;
  const first = new Map<string, number>();
  for (const r of rows) if (!first.has(r.login)) first.set(r.login, r.id);
  const q = queryDb(db);
  return await db.write(async () => {
    let n = 0;
    for (const part of kx.batches([...first].map(([login, id]) => ({ login, id })))) n += Number((await q.run(q.k.insertInto("main.author_ids").values(part).onConflict((oc) => oc.doNothing()))).changes);
    return n;
  });
}

/**
 * Binds, in one statement, every unbound login to the id of its oldest item, when every row of the login has an id (a login can have
 * passed to another account, so a login with an id-less row waits for `loadUnboundLoginPrs`). Returns the count bound.
 */
export async function bindKnownAuthorIds(db: Db): Promise<number> {
  const q = queryDb(db);
  const source = q.k.selectFrom("items as i")
    .select((eb) => ["i.author as login", eb.selectFrom("items as o").select("o.author_id").whereRef("o.author", "=", "i.author")
      .orderBy("o.created_at", (o) => o.asc().nullsFirst()).orderBy("o.repo").orderBy("o.number").limit(1).as("id")])
    .where("i.author", "is not", null).where("i.author_id", "is not", null)
    .where((eb) => eb.not(eb.exists(eb.selectFrom("main.author_ids as a").select(eb.lit(1).as("one")).whereRef("a.login", "=", "i.author"))))
    .where((eb) => eb.not(eb.exists(eb.selectFrom("items as j").select(eb.lit(1).as("one")).whereRef("j.author", "=", "i.author").where("j.author_id", "is", null))))
    .groupBy("i.author");
  return await db.write(async () => Number((await q.run(q.k.insertInto("main.author_ids").columns(["login", "id"]).expression(source as any).onConflict((oc) => oc.doNothing()))).changes));
}

/** The oldest merged or closed PR of each login that has no bound account id (of `logins` when given), by login. */
export async function loadUnboundLoginPrs(db: Db, logins?: string[]): Promise<{ login: string; repo: string; number: number }[]> {
  if (logins && !logins.length) return [];
  const q = queryDb(db);
  const ranked = q.k.selectFrom("items as i")
    .select((eb) => ["i.author as login", "i.repo", "i.number", eb.fn.agg<number>("row_number").over((o) => o.partitionBy("i.author").orderBy("i.created_at", (d) => d.asc().nullsFirst()).orderBy("i.repo").orderBy("i.number")).as("n")])
    .where("i.kind", "=", "pr").where("i.author", "is not", null).where("i.state", "in", ["MERGED", "CLOSED"])
    .$if(!!logins, (b) => b.where(kx.inList(db, "i.author", logins!)));
  const rows = await q.all(q.k.selectFrom(ranked.as("f")).select(["f.login", "f.repo", "f.number"]).where("f.n", "=", 1)
    .where((eb) => eb.not(eb.exists(eb.selectFrom("main.author_ids as a").select(eb.lit(1).as("one")).whereRef("a.login", "=", "f.login")))).orderBy("f.login"));
  return rows.map((r) => ({ login: r.login!, repo: r.repo, number: Number(r.number) }));
}

/** Keyed "repo\nlogin". */
export async function loadAuthorPermissions(db: Db, o: { repos?: string[]; logins?: string[] } = {}): Promise<Map<string, AuthorPermissionRow>> {
  const out = new Map<string, AuthorPermissionRow>();
  if ((o.repos && !o.repos.length) || (o.logins && !o.logins.length)) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.author_permissions").select(kx.cols("author_permissions"))
    .$if(!!o.repos, (b) => b.where(kx.inList(db, "repo", o.repos!)))
    .$if(!!o.logins, (b) => b.where(kx.inList(db, "login", o.logins!, "citext"))));
  for (const r of rows) out.set(`${r.repo}\n${r.login}`, r);
  return out;
}

/**
 * Success rows (a permission) upsert and clear the failure count; failure rows (no permission) add one failure and keep the first
 * failure time. The later row of a (login, repo) in the call wins. Two statements in one `db.write`.
 */
export async function saveAuthorPermissions(db: Db, rows: AuthorPermissionSave[]): Promise<void> {
  if (!rows.length) return;
  const last = new Map(rows.map((r) => [`${r.repo}\n${r.login}`, r]));
  const ok = [...last.values()].filter((r) => r.permission !== null);
  const failed = [...last.values()].filter((r) => r.permission === null);
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.batches(ok)) {
      await q.run(q.k.insertInto("main.author_permissions")
        .values(part.map((r) => ({ login: r.login, repo: r.repo, permission: r.permission, checked_at: r.at, failures: 0, first_failure_at: null, author_id: r.authorId })))
        .onConflict((oc) => oc.columns(["login", "repo"]).doUpdateSet((eb) => ({ ...kx.excluded(["permission", "checked_at", "author_id"])(eb), failures: eb.lit(0), first_failure_at: eb.lit(null) }))));
    }
    for (const part of kx.batches(failed)) {
      await q.run(q.k.insertInto("main.author_permissions").values(part.map((r) => ({ login: r.login, repo: r.repo, failures: 1, first_failure_at: r.at })))
        .onConflict((oc) => oc.columns(["login", "repo"]).doUpdateSet((eb) => ({
          failures: eb("main.author_permissions.failures", "+", 1),
          first_failure_at: eb.fn.coalesce("main.author_permissions.first_failure_at", "excluded.first_failure_at"),
        }))));
    }
  });
}

/**
 * Merged, closed and open PR counts per login and account, over every repo; `logins` narrows who is listed, `repo` lists only
 * logins with a PR there (their counts still cover every repo) and shows that repo only. One statement.
 */
export async function loadAuthorHistory(db: Db, o: { logins?: string[]; repo?: string } = {}): Promise<AuthorHistory[]> {
  if (o.logins && !o.logins.length) return [];
  const q = queryDb(db);
  const perRepo = q.k.selectFrom("items").select((eb) => ["author", "author_id", "repo", stateSum(eb, "MERGED").as("merged"), stateSum(eb, "CLOSED").as("closed"), stateSum(eb, "OPEN").as("open"), eb.fn.max<string | null>("merged_at").as("last_merge")])
    .where("kind", "=", "pr").where("author", "is not", null)
    .$if(!!o.logins, (b) => b.where(kx.inList(db, "author", o.logins!)))
    .groupBy(["author", "author_id", "repo"]);
  const rows = await q.all(q.k.selectFrom(perRepo.as("t"))
    .select((eb) => ["t.author as login", "t.author_id", eb.fn.sum<number>("t.merged").as("merged"), eb.fn.sum<number>("t.closed").as("closed"), eb.fn.sum<number>("t.open").as("open"),
      eb.fn.max<string | null>("t.last_merge").as("last_merge"),
      kx.groupConcat(db, o.repo ? eb.case().when("t.repo", "=", o.repo).then(eb.ref("t.repo")).end() : eb.ref("t.repo"), ",", "t.repo").as("repos")])
    .groupBy(["t.author", "t.author_id"])
    .$if(!!o.repo, (b) => b.having((eb) => eb.fn.sum(eb.case().when("t.repo", "=", o.repo!).then(eb.lit(1)).else(eb.lit(0)).end()), ">", 0))
    .orderBy("t.author").orderBy("t.author_id", (x) => x.asc().nullsFirst()));
  return rows.map((r) => ({ login: r.login!, author_id: r.author_id === null ? null : Number(r.author_id), merged: Number(r.merged), closed: Number(r.closed), open: Number(r.open), lastMerge: r.last_merge, repos: r.repos ? String(r.repos).split(",") : [] }));
}

/** Merged PRs by the GitHub account `authorId` in repos of `owner` (case-insensitive). One statement. */
export async function countMergedByAccount(db: Db, owner: string, authorId: number): Promise<number> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("items as i").innerJoin("repos as r", "r.name", "i.repo")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("i.kind", "=", "pr").where("i.state", "=", "MERGED").where("i.author_id", "=", authorId)
    .where((eb) => eb(eb.fn("lower", ["r.owner"]), "=", owner.toLowerCase())), { label: "mirror.countMergedByAccount" });
  return Number(r?.n ?? 0);
}
