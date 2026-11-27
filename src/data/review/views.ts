// Read models for pages (M13 review).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import { noKeys, pushTo, refKey, storedReviews } from "./rows.ts";
import { loadFollowups, loadPosts, loadPostmerge, loadReviewHistory } from "./reviews.ts";
import type { PremergeRow, RefKey, ReviewEventRow, ReviewRecord, ReviewRow, ReviewSignature, StoredReview } from "./types.ts";

/** The newest review that gave a verdict. */
const latestOf = (stored: StoredReview[]): ReviewRow | null => {
  const r = stored.find((x) => x.verdict !== null);
  if (!r) return null;
  const { claims: _c, ...row } = r;
  return { ...row, verdict: row.verdict! };
};

/** Everything the item page, MCP item tool and trace show of reviews: six statements in one wave. A PR with none of them is absent; `premerge` holds every head's row, oldest first. */
export async function loadReviewRecord(db: Db, keys: KeySource): Promise<Map<RefKey, ReviewRecord>> {
  const out = new Map<RefKey, ReviewRecord>();
  if (noKeys(keys)) return out;
  const q = queryDb(db);
  const [reviews, history, premerge, postmerge, followups, posts] = await db.together(() => Promise.all([
    storedReviews(db, keys),
    loadReviewHistory(db, keys, { any: true }),
    q.all(q.k.selectFrom("main.premerge_reviews as p").innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "p.repo").onRef("kk.number", "=", "p.number"))
      .select(kx.cols("premerge_reviews", "p")).orderBy("p.at")),
    loadPostmerge(db, keys),
    loadFollowups(db, keys),
    loadPosts(db, keys),
  ]));
  const pm = new Map<RefKey, PremergeRow[]>();
  for (const r of premerge) pushTo(pm, refKey(r.repo, r.number), r as PremergeRow);
  const refs = new Set<RefKey>([...reviews.keys(), ...history.keys(), ...pm.keys(), ...postmerge.keys(), ...followups.keys(), ...posts.keys()]);
  for (const ref of refs) {
    const stored = reviews.get(ref) ?? [];
    out.set(ref, { latest: latestOf(stored), reviews: stored, history: history.get(ref) ?? [], premerge: pm.get(ref) ?? [], postmerge: postmerge.get(ref) ?? null, followups: followups.get(ref) ?? [], post: posts.get(ref) ?? null });
  }
  return out;
}

/** Counts and newest times for the trace cache key: five statements in one wave. */
export async function loadReviewSignature(db: Db, keys: KeySource): Promise<Map<RefKey, ReviewSignature>> {
  const out = new Map<RefKey, ReviewSignature>();
  if (noKeys(keys)) return out;
  const q = queryDb(db);
  const stat = (table: "main.opus_review_history" | "main.opus_reviews" | "main.premerge_reviews" | "main.postmerge_reviews", withTries: boolean) =>
    q.all(q.k.selectFrom(`${table} as x` as "main.premerge_reviews as x").innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "x.repo").onRef("kk.number", "=", "x.number"))
      .select((eb) => ["x.repo", "x.number", eb.fn.countAll<number>().as("n"), eb.fn.max<string | null>("x.at").as("newest"),
        (withTries ? eb.fn.sum<number | null>("x.tries") : eb.lit(0)).as("tries")])
      .groupBy(["x.repo", "x.number"]));
  const [history, reviews, premerge, postmerge, followups] = await db.together(() => Promise.all([
    stat("main.opus_review_history", false), stat("main.opus_reviews", false), stat("main.premerge_reviews", true), stat("main.postmerge_reviews", false),
    q.all(q.k.selectFrom("main.postmerge_followups as f").innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "f.repo").onRef("kk.number", "=", "f.number"))
      .select(["f.repo", "f.number", "f.review_at", "f.finding", "f.state"]).orderBy("f.repo").orderBy("f.number").orderBy("f.review_at").orderBy("f.finding")),
  ]));
  const empty = (): ReviewSignature => ({ history: { n: 0, newest: null }, reviews: { n: 0, newest: null }, premerge: { n: 0, newest: null, tries: 0 }, postmerge: { n: 0, newest: null }, followups: "" });
  const of = (repo: string, number: number): ReviewSignature => {
    const ref = refKey(repo, number);
    return out.get(ref) ?? out.set(ref, empty()).get(ref)!;
  };
  for (const r of history) of(r.repo, r.number).history = { n: Number(r.n), newest: r.newest };
  for (const r of reviews) of(r.repo, r.number).reviews = { n: Number(r.n), newest: r.newest };
  for (const r of premerge) of(r.repo, r.number).premerge = { n: Number(r.n), newest: r.newest, tries: Number(r.tries ?? 0) };
  for (const r of postmerge) of(r.repo, r.number).postmerge = { n: Number(r.n), newest: r.newest };
  const parts = new Map<RefKey, string[]>();
  for (const r of followups) pushTo(parts, refKey(r.repo, r.number), `${r.review_at}:${r.finding}:${r.state}`);
  for (const [ref, p] of parts) { const [repo, n] = [ref.slice(0, ref.lastIndexOf("#")), Number(ref.slice(ref.lastIndexOf("#") + 1))]; of(repo, n).followups = p.join(";"); }
  return out;
}

/**
 * The three feeds of `dash/api/activity.ts` (history, pre-merge, post-merge), each its newest `limit` rows by time, in one wave; the
 * feeds are concatenated in that order and the caller merges them. `since` keeps rows at or after it, `before` rows at or before it
 * (the activity cursor); `repos` the visible repos.
 */
export async function listReviewEvents(db: Db, f: { since?: string; before?: string; limit: number; repos?: string[] }): Promise<ReviewEventRow[]> {
  if (f.repos && !f.repos.length) return [];
  const q = queryDb(db);
  const feed = <T extends "main.opus_review_history" | "main.premerge_reviews" | "main.postmerge_reviews">(_table: T) => (b: any) => b
    .where("x.at", "is not", null)
    .$if(f.since !== undefined, (c: any) => c.where("x.at", ">=", f.since))
    .$if(f.before !== undefined, (c: any) => c.where("x.at", "<=", f.before))
    .$if(!!f.repos, (c: any) => c.where(kx.inList(db, "x.repo", f.repos!)))
    .orderBy("x.at", "desc").limit(f.limit);
  const [review, premerge, postmerge] = await db.together(() => Promise.all([
    q.all(feed("main.opus_review_history")(q.k.selectFrom("main.opus_review_history as x").select(["x.repo", "x.number", kx.rowid("main.opus_review_history", "x").as("rowid"), "x.head_oid", "x.at", "x.model", "x.mode", "x.verdict", "x.sure", "x.reason", "x.risks", "x.fixes", "x.claims"])) as any) as Promise<any[]>,
    q.all(feed("main.premerge_reviews")(q.k.selectFrom("main.premerge_reviews as x").select(["x.repo", "x.number", "x.head_oid", "x.at", "x.model", "x.findings", "x.error", "x.searched"])) as any) as Promise<any[]>,
    q.all(feed("main.postmerge_reviews")(q.k.selectFrom("main.postmerge_reviews as x").select(["x.repo", "x.number", "x.merge_sha", "x.at", "x.model", "x.findings", "x.error"])) as any) as Promise<any[]>,
  ]));
  return [
    ...review.map((r): ReviewEventRow => ({ kind: "review", ...r, number: Number(r.number), rowid: Number(r.rowid) })),
    ...premerge.map((r): ReviewEventRow => ({ kind: "premerge", ...r, number: Number(r.number) })),
    ...postmerge.map((r): ReviewEventRow => ({ kind: "postmerge", ...r, number: Number(r.number) })),
  ];
}
