// Comment loaders (M01 mirror-a).
import type { Expression, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { parseSearch } from "../../db/search.ts";
import type { KeySource } from "../keys.ts";
import { joinKeys, keyChunks, refKey, qualified, type AnyQ } from "./shared.ts";
import type { CommentFilter, CommentHead, CommentHit, CommentOut, CommentStats, RefKey, ReviewFact, SnippetMarks, SpokenComment } from "./types.ts";

type Filter = Omit<CommentFilter, "order" | "body">;

const COMMENT_COLUMNS = kx.cols("comments").filter((c) => c !== "body");

/** The filter's conditions on the comments table aliased `a`. */
function conditions(db: Db, eb: kx.AnyEb, a: string, f: Filter): Expression<SqlBool>[] {
  const c: Expression<SqlBool>[] = [];
  if (f.kinds) c.push(kx.inList(db, `${a}.kind`, f.kinds));
  if (f.counted) c.push(eb(`${a}.counted`, "=", 1));
  if (f.after !== undefined) c.push(eb(`${a}.created_at`, ">", f.after));
  if (f.authors) c.push(kx.inList(db, `${a}.author`, f.authors));
  if (f.excludeBots) c.push(eb.or([eb(`${a}.author`, "is", null), eb.not(kx.like(db, `${a}.author`, eb.val("%[bot]")))]));
  return c;
}

/** Comments of each item, filtered and ordered as asked. The body is read only with `body: true`. */
export async function loadComments(db: Db, keys: KeySource, f: CommentFilter = { order: "rowid" }): Promise<Map<RefKey, CommentOut[]>> {
  const q = queryDb(db);
  const cols = qualified("c", f.body ? [...COMMENT_COLUMNS, "body"] : COMMENT_COLUMNS);
  const parts = await Promise.all(keyChunks(keys).map((k) => {
    const base = (joinKeys(db, q.k.selectFrom("comments as c"), k, "c") as AnyQ).select(cols as never).where((eb: kx.AnyEb) => eb.and(conditions(db, eb, "c", f)));
    const ordered = f.order === "created" ? base.orderBy("c.created_at", (o: any) => o.asc().nullsFirst()).orderBy(kx.rowid("comments", "c")) : base.orderBy(kx.rowid("comments", "c"));
    return q.all(ordered, { label: "mirror.loadComments" });
  }));
  const out = new Map<RefKey, CommentOut[]>();
  for (const rows of parts) for (const r of rows as CommentOut[]) {
    const k = refKey(r.repo, r.number);
    (out.get(k) ?? out.set(k, []).get(k)!).push(r);
  }
  return out;
}

/** Count, newest time, total length, link presence and authors of each item's comments. */
export async function loadCommentStats(db: Db, keys: KeySource, f: Filter = {}): Promise<Map<RefKey, CommentStats>> {
  const q = queryDb(db);
  const parts = await Promise.all(keyChunks(keys).map((k) => q.all(
    (joinKeys(db, q.k.selectFrom("comments as c"), k, "c") as AnyQ)
      .select((eb: kx.AnyEb) => [
        eb.ref("c.repo").as("repo"), eb.ref("c.number").as("number"), eb.fn.countAll<number>().as("n"),
        eb.fn.max<string | null>("c.created_at").as("newest"),
        eb.fn.sum<number | null>(eb.fn<number>("length", [eb.fn.coalesce("c.body", eb.val(""))])).as("length"),
        eb.fn.sum<number>(eb.case().when("c.url", "is not", null).then(eb.lit(1)).else(eb.lit(0)).end()).as("urls"),
        kx.jsonRows(db, eb.selectFrom("comments as a").select("a.author").distinct().whereRef("a.repo", "=", "c.repo").whereRef("a.number", "=", "c.number")
          .where("a.author", "is not", null).where((e: kx.AnyEb) => e.and(conditions(db, e, "a", f)))).as("authors"),
      ] as never)
      .where((eb: kx.AnyEb) => eb.and(conditions(db, eb, "c", f))).groupBy(["c.repo", "c.number"]), { label: "mirror.loadCommentStats" })));
  const out = new Map<RefKey, CommentStats>();
  for (const rows of parts) for (const r of rows as { repo: string; number: number; n: number; newest: string | null; length: number | null; urls: number; authors: string | null }[])
    out.set(refKey(r.repo, r.number), {
      n: Number(r.n), newest: r.newest, length: Number(r.length ?? 0), hasUrls: Number(r.urls) > 0,
      authors: kx.parseJsonRows<{ author: string }>(r.authors).map((a) => a.author),
    });
  return out;
}

// The review states that count as a reviewer's opinion (COMMENTED does not); the same list as merge's FORMAL_STATES.
const FORMAL_STATES = ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"];

/** Formal review entries (kind review, author set, formal state) of open PRs in row order. */
export async function loadFormalReviews(db: Db, keys: KeySource): Promise<Map<RefKey, ReviewFact[]>> {
  const q = queryDb(db);
  const parts = await Promise.all(keyChunks(keys).map((k) => q.all(
    (joinKeys(db, q.k.selectFrom("comments as c"), k, "c") as AnyQ)
      .innerJoin("items as i", (j: any) => j.onRef("i.repo", "=", "c.repo").onRef("i.number", "=", "c.number").on("i.kind", "=", "pr").on("i.state", "=", "OPEN"))
      .select(["c.repo", "c.number", "c.id", "c.author", "c.author_association as association", "c.review_state as state", "c.created_at as at"] as never)
      .where("c.kind", "=", "review").where("c.author", "is not", null).where(kx.inList(db, "c.review_state", FORMAL_STATES))
      .orderBy(kx.rowid("comments", "c")), { label: "mirror.loadFormalReviews" })));
  const out = new Map<RefKey, ReviewFact[]>();
  for (const rows of parts) for (const r of rows as (ReviewFact & { repo: string; number: number })[]) {
    const k = refKey(r.repo, r.number);
    (out.get(k) ?? out.set(k, []).get(k)!).push({ id: r.id, author: r.author, association: r.association, state: r.state, at: r.at });
  }
  return out;
}

/** Logins (as given) with an item or a comment in the repo; the match ignores case. */
export async function loadActivityByLogins(db: Db, repo: string, logins: string[]): Promise<Set<string>> {
  if (!logins.length) return new Set();
  const q = queryDb(db);
  const lower = logins.map((l) => l.toLowerCase());
  const rows = await q.all(q.k.selectFrom("items").select((eb) => eb.fn<string>("lower", ["author"]).as("login")).where("repo", "=", repo).where((eb) => kx.inList(db, eb.fn("lower", ["author"]), lower))
    .union(q.k.selectFrom("comments").select((eb) => eb.fn<string>("lower", ["author"]).as("login")).where("repo", "=", repo).where((eb) => kx.inList(db, eb.fn("lower", ["author"]), lower))), { label: "mirror.loadActivityByLogins" });
  const found = new Set(rows.map((r) => r.login));
  return new Set(logins.filter((l) => found.has(l.toLowerCase())));
}

/** Logins (lower case) with an item or a comment in the repo written under one of `associations` (GitHub's author association); the match ignores case. */
export async function loadAuthoredIn(db: Db, repo: string, logins: string[], associations: string[]): Promise<Set<string>> {
  if (!logins.length || !associations.length) return new Set();
  const q = queryDb(db);
  const lower = [...new Set(logins.map((l) => l.toLowerCase()))];
  const rows = await q.all(q.k.selectFrom("items").select((eb) => eb.fn<string>("lower", ["author"]).as("login")).where("repo", "=", repo).where((eb) => kx.inList(db, eb.fn("lower", ["author"]), lower))
    .where(() => kx.inList(db, "author_association", associations))
    .union(q.k.selectFrom("comments").select((eb) => eb.fn<string>("lower", ["author"]).as("login")).where("repo", "=", repo).where((eb) => kx.inList(db, eb.fn("lower", ["author"]), lower))
      .where(() => kx.inList(db, "author_association", associations))), { label: "mirror.loadAuthoredIn" });
  return new Set(rows.map((r) => r.login));
}

/** Comments with text by people and review bots: not empty, no `[bot]` login, none of `not` (logins as stored). */
const spoken = (db: Db, eb: kx.AnyEb, a: string, not: readonly string[]): Expression<SqlBool> => eb.and([
  eb(eb.fn.coalesce(eb.fn("trim", [`${a}.body`]), eb.val("")), "<>", ""),
  eb.not(kx.like(db, eb.fn.coalesce(`${a}.author`, eb.val("")), eb.val("%[bot]"))),
  ...(not.length ? [eb.not(kx.inList(db, eb.fn.coalesce(`${a}.author`, eb.val("")), [...not]))] : []),
]);

/** Count and id of the newest (by `created_at`, then id) spoken comment per item; `not`: logins whose comments do not count. Items with none have no entry. */
export async function loadCommentHeads(db: Db, keys: KeySource, o: { not?: readonly string[] } = {}): Promise<Map<RefKey, CommentHead>> {
  const q = queryDb(db);
  const out = new Map<RefKey, CommentHead>();
  const parts = await Promise.all(keyChunks(keys).map((k) => q.all((q.k as any).selectFrom(
    (joinKeys(db, q.k.selectFrom("comments as c"), k, "c") as AnyQ)
      .select((eb: kx.AnyEb) => ["c.repo", "c.number", "c.id",
        eb.fn.countAll().over((w: any) => w.partitionBy(["c.repo", "c.number"])).as("n"),
        eb.fn.agg("row_number").over((w: any) => w.partitionBy(["c.repo", "c.number"])
          .orderBy(eb.case().when("c.created_at", "is", null).then(1).else(0).end()).orderBy("c.created_at", "desc").orderBy("c.id", "desc")).as("rn")] as never)
      .where((eb: kx.AnyEb) => spoken(db, eb, "c", o.not ?? [])).as("w"))
    .select(["w.repo", "w.number", "w.id", "w.n"]).where("w.rn", "=", 1), { label: "mirror.loadCommentHeads" })));
  for (const rows of parts) for (const r of rows as unknown as { repo: string; number: number; id: string; n: number }[]) out.set(refKey(r.repo, r.number), { n: Number(r.n), last: r.id });
  return out;
}

/** The oldest (`first`, oldest first) or newest (`last`, newest first) `limit` spoken comments of one item, with their text. */
export async function loadSpokenComments(db: Db, ref: { repo: string; number: number }, o: { order: "first" | "last"; limit: number; not?: readonly string[] }): Promise<SpokenComment[]> {
  const q = queryDb(db);
  const rows = await q.all((q.k.selectFrom("comments as c") as AnyQ).select(["c.id", "c.author", "c.body"] as never).where("c.repo", "=", ref.repo).where("c.number", "=", ref.number)
    .where((eb: kx.AnyEb) => spoken(db, eb, "c", o.not ?? []))
    .orderBy("c.created_at", (x: any) => (o.order === "first" ? x.asc().nullsFirst() : x.desc().nullsLast())).orderBy("c.id", o.order === "first" ? "asc" : "desc").limit(o.limit), { label: "mirror.loadSpokenComments" });
  return rows as unknown as SpokenComment[];
}

/** The key of one entry of `loadNewerComments`. */
export const newerKey = (r: { repo: string; number: number; after: string | null }): string => `${r.repo}#${r.number}@${r.after ?? ""}`;

/** Per entry, the spoken comments after the comment `after` (by `created_at`, then id; null: all), oldest first; null when that comment is gone. One statement. */
export async function loadNewerComments(db: Db, entries: { repo: string; number: number; after: string | null }[], o: { not?: readonly string[] } = {}): Promise<Map<string, SpokenComment[] | null>> {
  const out = new Map<string, SpokenComment[] | null>();
  const unique = [...new Map(entries.map((e) => [newerKey(e), e])).values()];
  if (!unique.length) return out;
  const q = queryDb(db);
  const v = kx.valuesTable(db, unique.map((e) => ({ k: newerKey(e), repo: e.repo, number: e.number, after: e.after })), { k: "text", repo: "text", number: "bigint", after: "text" }, "v");
  const rows = await q.all((q.k as any).selectFrom(v)
    .leftJoin("comments as m", (j: any) => j.onRef("m.repo", "=", "v.repo").onRef("m.number", "=", "v.number").onRef("m.id", "=", "v.after"))
    .leftJoin("comments as c", (j: any) => j.onRef("c.repo", "=", "v.repo").onRef("c.number", "=", "v.number").on((eb: kx.AnyEb) => eb.and([spoken(db, eb, "c", o.not ?? []), eb.or([
      eb("v.after", "is", null), eb("c.created_at", ">", eb.ref("m.created_at")), eb.and([eb("c.created_at", "=", eb.ref("m.created_at")), eb("c.id", ">", eb.ref("m.id"))])])])))
    .select(["v.k", "v.after", "m.id as mark", "c.id", "c.author", "c.body"]).orderBy("c.created_at", (x: any) => x.asc().nullsFirst()).orderBy("c.id"), { label: "mirror.loadNewerComments" });
  for (const e of unique) out.set(newerKey(e), []);
  for (const r of rows as unknown as { k: string; after: string | null; mark: string | null; id: string | null; author: string | null; body: string }[]) {
    if (r.after !== null && r.mark === null) out.set(r.k, null);
    else if (r.id !== null) out.get(r.k)?.push({ id: r.id, author: r.author, body: r.body });
  }
  return out;
}

const MARKS: SnippetMarks = { open: "\u0002", close: "\u0003", words: 24 };

/** Full-text comment search, best first (lower score); `limit` defaults to 20. */
export async function searchComments(db: Db, search: string, opts: { repos?: string[]; limit?: number; snippets?: boolean }): Promise<CommentHit[]> {
  const s = parseSearch(search);
  if (!s || (opts.repos && !opts.repos.length)) return [];
  const q = queryDb(db);
  const hits = kx.commentHits(db, s, { score: true, ...(opts.snippets ? { snippet: MARKS } : {}) }, "h");
  const rows = await q.all((q.k.selectFrom(hits) as AnyQ).select(["h.repo", "h.number", "h.id", "h.author", "h.score", ...(opts.snippets ? ["h.snippet"] : [])] as never)
    .$if(!!opts.repos, (b: AnyQ) => b.where(kx.inList(db, "h.repo", opts.repos!)))
    .orderBy("h.score").orderBy("h.repo").orderBy("h.number").orderBy("h.id").limit(opts.limit ?? 20), { label: "mirror.searchComments" });
  return (rows as { repo: string; number: number; id: string; author: string | null; score: number; snippet?: string | null }[]).map((r) => ({
    ref: refKey(r.repo, r.number), id: r.id, author: r.author, score: r.score, ...(opts.snippets && r.snippet ? { snippet: r.snippet } : {}),
  }));
}
