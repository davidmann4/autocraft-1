// Predicates other modules embed, and the resolver of the `merge.keysBatchMembers` key source.
import type { Expression, SelectQueryBuilder, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { schemaEb, type Eb } from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { registerKeySource, resolveKeys, type KeySource } from "../keys.ts";

const ACTIVE = ["checking", "open"];

/** The pipeline merged the item (an attempt with outcome `merged`). */
export function mergedByUs(eb: Eb, repoCol: string, numberCol: string): Expression<SqlBool> {
  const w = schemaEb(eb);
  return w.exists(w.selectFrom("merges as mg").select(w.lit(1).as("one")).where("mg.repo", "=", eb.ref(repoCol)).where("mg.number", "=", eb.ref(numberCol)).where("mg.outcome", "=", "merged"));
}

/** The item is a member of a batch that merged. */
export function inMergedBatch(eb: Eb, repoCol: string, numberCol: string): Expression<SqlBool> {
  const w = schemaEb(eb);
  return w.exists(w.selectFrom("merge_batch_prs as bp").innerJoin("merge_batches as b", "b.id", "bp.batch_id").select(w.lit(1).as("one"))
    .where("b.repo", "=", eb.ref(repoCol)).where("bp.number", "=", eb.ref(numberCol)).where("b.state", "=", "merged"));
}

/**
 * One row per pull request of `repos` the pipeline merged, by itself or as a member of a batch that merged: when (`at`: its first merge, else
 * its batch's), whether by a merge of its own (`own`), and whether on a person's approval and not by the merge rule (`approved`).
 */
export function mergedPrs(db: Db, repos: readonly string[]): SelectQueryBuilder<any, any, { repo: string; number: number; at: string; own: number; approved: number }> {
  const k = queryDb(db).k as any;
  const own = k.selectFrom("main.merges as mg").where("mg.outcome", "=", "merged").where(kx.inList(db, "mg.repo", repos))
    .select((eb: any) => ["mg.repo as repo", "mg.number as number", "mg.at as at", eb.lit(1).as("own"), eb.case().when("mg.path", "<>", "rule").then(1).else(0).end().as("approved")]);
  const batched = k.selectFrom("main.merge_batches as b").innerJoin("main.merge_batch_prs as bp", "bp.batch_id", "b.id").where("b.state", "=", "merged").where(kx.inList(db, "b.repo", repos))
    .select((eb: any) => ["b.repo as repo", "bp.number as number", "b.updated_at as at", eb.lit(0).as("own"), eb.lit(0).as("approved")]);
  return k.selectFrom(own.unionAll(batched).as("u")).select((eb: any) => ["u.repo", "u.number", eb.fn.coalesce(eb.fn.min(eb.case().when("u.own", "=", eb.lit(1)).then(eb.ref("u.at")).end()), eb.fn.min("u.at")).as("at"),
    eb.fn.max("u.own").as("own"), eb.fn.max("u.approved").as("approved")]).groupBy(["u.repo", "u.number"]);
}

/** The item is not the integration PR of any batch, past or present. */
export function notBatchPr(eb: Eb, repoCol: string, numberCol: string): Expression<SqlBool> {
  const w = schemaEb(eb);
  return eb.not(w.exists(w.selectFrom("merge_batches as b").select(w.lit(1).as("one")).where("b.repo", "=", eb.ref(repoCol)).where("b.pr_number", "=", eb.ref(numberCol))));
}

/** The item is not one of the integration PRs we opened. */
export function notOwnIntegration(eb: Eb, repoCol: string, numberCol: string): Expression<SqlBool> {
  return notBatchPr(eb, repoCol, numberCol);
}

/** The item is a member of a checking or open batch. */
export function inActiveBatch(eb: Eb, repoCol: string, numberCol: string): Expression<SqlBool> {
  const w = schemaEb(eb);
  return w.exists(w.selectFrom("merge_batch_prs as bp").innerJoin("merge_batches as b", "b.id", "bp.batch_id").select(w.lit(1).as("one"))
    .where("b.repo", "=", eb.ref(repoCol)).where("bp.number", "=", eb.ref(numberCol)).where("b.state", "in", ACTIVE));
}

/** The item has a verification or a PR build row. */
export function hasVerifyOrBuild(eb: Eb, repoCol: string, numberCol: string): Expression<SqlBool> {
  const w = schemaEb(eb);
  return eb.or(["verifications", "pr_builds"].map((t) =>
    w.exists(w.selectFrom(`${t} as x` as "verifications as x").select(w.lit(1).as("one")).where("x.repo", "=", eb.ref(repoCol)).where("x.number", "=", eb.ref(numberCol)))));
}

// Members of the batches whose integration PR is in `args.keys`.
registerKeySource<{ keys: KeySource }>("merge.keysBatchMembers", (db, args) =>
  queryDb(db).k.selectFrom("merge_batches as b")
    .innerJoin(resolveKeys(db, args.keys, "kk"), (j) => j.onRef("kk.repo", "=", "b.repo").onRef("kk.number", "=", "b.pr_number"))
    .innerJoin("merge_batch_prs as bp", "bp.batch_id", "b.id")
    .select(["b.repo as repo", "bp.number as number"]));
