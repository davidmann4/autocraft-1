// Predicates and derived tables other modules embed.
import type { Expression, SelectQueryBuilder, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import { ref, schemaEb, type Eb, type Ex } from "../../db/kx.ts";

/** The item has a mention row. */
export function mentioned(eb: Eb, repoCol: Ex, numberCol: Ex): Expression<SqlBool> {
  const w = schemaEb(eb);
  return w.exists(w.selectFrom("discord_mentions as dm").select(w.lit(1).as("one")).where("dm.repo", "=", ref<string>(repoCol)).where("dm.number", "=", ref<number>(numberCol)));
}

/** Derived table `(repo, number, n)` of mention counts, for sorting the item list by mentions. */
export function mentionCounts(db: Db): SelectQueryBuilder<any, any, { repo: string; number: number; n: number }> {
  return queryDb(db).k.selectFrom("discord_mentions").select(["repo", "number", (eb) => eb.fn.countAll<number>().as("n")]).groupBy(["repo", "number"]) as SelectQueryBuilder<any, any, { repo: string; number: number; n: number }>;
}
