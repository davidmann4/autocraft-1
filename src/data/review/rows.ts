// Shared statements and row parsing of the review module's loaders.
import type { SelectQueryBuilder } from "kysely";
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import type { HeadKey, HeadRef, HistoryRow, ReviewFinding, ReviewRow, ReviewWorkflow, RefKey, StoredReview, Verdict } from "./types.ts";

export const refKey = (repo: string, number: number): RefKey => `${repo}#${number}`;
export const headRef = (repo: string, number: number, head: string): HeadRef => `${repo}#${number}@${head}`;
export const noKeys = (keys: KeySource): boolean => Array.isArray(keys) && keys.length === 0;

export const listOf = <T>(s: string | null | undefined): T[] => {
  try { const v = JSON.parse(s ?? "[]") as unknown; return Array.isArray(v) ? (v as T[]) : []; } catch { return []; }
};
const objectOf = <T>(s: string | null | undefined): T | null => {
  try { const v = JSON.parse(s ?? "null") as unknown; return v && typeof v === "object" && !Array.isArray(v) ? (v as T) : null; } catch { return null; }
};
export const refsOf = (s: string | null | undefined): RefKey[] => listOf<unknown>(s).filter((x): x is string => typeof x === "string");

/** The `opus_reviews` columns of a `ReviewRow`, without the heavy texts. */
const REVIEW_COLS = ["repo", "number", "head_oid", "at", "run_id", "model", "mode", "base_head", "base_ref", "verdict", "sure", "reason", "fixes", "risks", "conflicts", "blocked_by", "seen_at", "disc_hash", "workflow"] as const;

/** The select list of `ReviewRow` for `opus_reviews` named `alias`; `public_summary` reads as `r_public` of core/facts.ts does. */
export function reviewSelect(db: Db, eb: kx.AnyEb, alias: string) {
  return [
    ...REVIEW_COLS.map((c) => `${alias}.${c}`),
    eb.case().when(`${alias}.public_review`, "is", null).then(eb.lit(null)).when(eb.not(kx.jsonValid(db, `${alias}.public_review`))).then(eb.val(""))
      .when(eb.and([eb(kx.jsonType(db, `${alias}.public_review`, "$.summary"), "=", "text"), eb(kx.jsonType(db, `${alias}.public_review`, "$.points"), "=", "array")]))
      .then(kx.jsonText(db, `${alias}.public_review`, "$.summary")).else(eb.val("")).end().as("public_summary"),
  ] as any[];
}

/** A row with no `sure` counts as sure. */
const sureOf = (v: unknown): boolean => v === null || v === undefined || Number(v) !== 0;

export function parseReview(r: any): ReviewRow {
  return {
    repo: r.repo, number: Number(r.number), head: r.head_oid, at: r.at, run_id: r.run_id ?? null, model: r.model ?? null, mode: r.mode, base_head: r.base_head ?? null, base_ref: r.base_ref ?? null,
    verdict: r.verdict as Verdict, sure: sureOf(r.sure), reason: r.reason ?? "",
    fixes: listOf<ReviewFinding>(r.fixes), risks: listOf<string>(r.risks), conflicts: listOf<{ id: number; reason: string }>(r.conflicts),
    blocked_by: refsOf(r.blocked_by), seen_at: r.seen_at ?? null, disc_hash: r.disc_hash ?? null, public_summary: r.public_summary ?? null,
    workflow: objectOf<ReviewWorkflow>(r.workflow),
  };
}

/** Every stored review of the PRs of `keys`, newest first within a PR. One statement. */
export async function storedReviews(db: Db, keys: KeySource): Promise<Map<RefKey, StoredReview[]>> {
  const out = new Map<RefKey, StoredReview[]>();
  if (noKeys(keys)) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.opus_reviews as o").innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "o.repo").onRef("kk.number", "=", "o.number"))
    .select((eb) => [...reviewSelect(db, eb, "o"), "o.claims"] as any).orderBy("o.at", "desc").orderBy(kx.rowid("main.opus_reviews", "o"), "desc") as any) as any[];
  for (const r of rows) pushTo(out, refKey(r.repo, r.number), { ...parseReview(r), verdict: (r.verdict ?? null) as Verdict | null, claims: r.claims ?? null });
  return out;
}

/** Rows with a verdict, one per (PR, head), newest first within a PR, for the PRs of `keys`; `rn` is the position (1 is the latest). */
export function reviewWindow(db: Db, keys: KeySource): SelectQueryBuilder<any, any, any> {
  const q = queryDb(db);
  return q.k.selectFrom("main.opus_reviews as o")
    .innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "o.repo").onRef("kk.number", "=", "o.number"))
    .select((eb) => [...reviewSelect(db, eb, "o"), eb.fn.agg<number>("row_number").over((w) => w.partitionBy(["o.repo", "o.number"]).orderBy("o.at", "desc").orderBy(kx.rowid("main.opus_reviews", "o"), "desc")).as("rn")] as any)
    .where("o.verdict", "is not", null);
}

/** The latest review of each PR of `keys`, as `ReviewRow`s. One statement. */
export async function latestRows(db: Db, keys: KeySource): Promise<Map<RefKey, ReviewRow>> {
  const out = new Map<RefKey, ReviewRow>();
  if (noKeys(keys)) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom(reviewWindow(db, keys).as("t")).selectAll("t").where("t.rn", "=", 1) as any) as any[];
  for (const r of rows) out.set(refKey(r.repo, r.number), parseReview(r));
  return out;
}

export const headTuples = (heads: HeadKey[]) => heads.map((h) => [h.repo, h.number, h.head] as const);

export function parseHistory(r: any): HistoryRow {
  return {
    rowid: Number(r.rowid), head: r.head_oid, at: r.at, model: r.model ?? null, mode: r.mode ?? null, verdict: r.verdict, sure: sureOf(r.sure), reason: r.reason ?? "",
    summary: r.summary ?? null, risks: listOf<string>(r.risks), fixes: listOf<ReviewFinding>(r.fixes), claims: r.claims ?? null, blocked_by: refsOf(r.blocked_by), trigger: r.trigger ?? null, job_id: r.job_id === null || r.job_id === undefined ? null : Number(r.job_id),
  };
}

export function pushTo<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const l = m.get(k);
  if (l) l.push(v); else m.set(k, [v]);
}
