// Predicates other modules embed in their statements (src/data/** only).
import type { AliasableExpression, Expression, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { registerKeySource } from "../keys.ts";
import { openItem } from "../mirror/fragments.ts";
import { onEdgeExpr } from "./cross.ts";

const one = (eb: kx.AnyEb) => eb.lit(1).as("one");

/** Rows that make an item or a run count as classified: Jev's, and Haiku's when it classified alone (only that path sets `input_hash`). `a` names the classifications table when the query aliases it. */
export function verdictExpr(eb: kx.AnyEb, a?: string): AliasableExpression<SqlBool> {
  const c = (col: string) => eb.ref(a ? `${a}.${col}` : col);
  return eb.or([eb(c("classifier"), "=", "jev"), eb.and([eb(c("classifier"), "=", "haiku"), eb(c("input_hash"), "is not", null)])]);
}

/** The join condition of an `item_settled` row `alias` with the item `item` in `run` (null: no rows). */
export function settledJoin(eb: kx.AnyEb, run: string | null, alias: string, item = "i"): AliasableExpression<SqlBool> {
  return eb.and([eb(eb.ref(`${alias}.run`), "=", run ?? ""), eb(eb.ref(`${alias}.repo`), "=", eb.ref(`${item}.repo`)), eb(eb.ref(`${alias}.number`), "=", eb.ref(`${item}.number`))]);
}

/** Any classifier row of the item, in any run, flags it as security (the public hidden rule). */
export const hasSecurityVerdict = (db: Db, eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex): AliasableExpression<SqlBool> => {
  const t = kx.schemaEb(eb);
  const flags = eb.case().when(kx.jsonValid(db, "c.flags")).then(eb.ref("c.flags")).else(eb.val("[]")).end();
  return eb.exists(t.selectFrom(["main.classifications as c", kx.jsonEach(db, flags, "f")]).select(one(eb))
    .where("c.repo", "=", kx.exprOf(eb, repo)).where("c.number", "=", kx.exprOf(eb, number)).where("f.value", "=", "security"));
};

/** The item has a verdict row (`verdictExpr`). */
export const hasVerdict = (eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex): AliasableExpression<SqlBool> =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.classifications as cv").select(one(eb)).where("cv.repo", "=", kx.exprOf(eb, repo)).where("cv.number", "=", kx.exprOf(eb, number)).where((w) => verdictExpr(w, "cv")));

/** The item has a referee (`sonnet`) verdict row. */
export const hasRefereeVerdict = (eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex): AliasableExpression<SqlBool> =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.classifications as cr").select(one(eb)).where("cr.repo", "=", kx.exprOf(eb, repo)).where("cr.number", "=", kx.exprOf(eb, number)).where("cr.classifier", "=", "sonnet"));

/** The item is assigned to one of the named areas. */
export const inAreas = (eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex, names: readonly string[]): AliasableExpression<SqlBool> =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.item_areas as ia").select(one(eb)).where("ia.repo", "=", kx.exprOf(eb, repo)).where("ia.number", "=", kx.exprOf(eb, number)).where("ia.area", "in", [...names]));

/** The item has no area. */
export const hasNoArea = (eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex): AliasableExpression<SqlBool> =>
  eb.not(eb.exists(kx.schemaEb(eb).selectFrom("main.item_areas as ina").select(one(eb)).where("ina.repo", "=", kx.exprOf(eb, repo)).where("ina.number", "=", kx.exprOf(eb, number)).where("ina.area", "is not", null)));

/** `item_rank` left-joined on the item `item`; use with `rankScore`. */
export const rankJoin = <Q extends { leftJoin: (...a: any[]) => any }>(q: Q, item = "i", alias = "r") =>
  q.leftJoin(`main.item_rank as ${alias}`, (j: any) => j.onRef(`${alias}.repo`, "=", `${item}.repo`).onRef(`${alias}.number`, "=", `${item}.number`));

/** The score column of `rankJoin`'s alias. */
export const rankScore = (eb: kx.AnyEb, alias = "r"): Expression<number | null> => eb.ref(`${alias}.score`) as Expression<number | null>;

/** The item is the member a duplicate group closes, and a duplicate edge of it holds (as loadDupeSignals reads it: a stored group counts for nothing without one). */
export const isDuplicateClose = (db: Db, eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex): AliasableExpression<SqlBool> =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.dupe_group_items as dc").select(one(eb)).where("dc.repo", "=", kx.exprOf(eb, repo)).where("dc.number", "=", kx.exprOf(eb, number)).where("dc.role", "=", "close")
    .where((w) => onEdgeExpr(db, w, "dc.repo", "dc.number")));

/** The item's rank level (`item_rank.score / 10000`, default 2). */
export const rankLevel = (eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex): Expression<number> => {
  const s = kx.schemaEb(eb).selectFrom("main.item_rank as rl").select("rl.score").where("rl.repo", "=", kx.exprOf(eb, repo)).where("rl.number", "=", kx.exprOf(eb, number));
  return eb.fn.coalesce(eb.cast<number>(eb(s, "/", eb.lit(10000)), "bigint"), eb.lit(2)) as unknown as Expression<number>;
};

/** An `item_embeddings` row of `model` exists for the item. */
export const embeddedAt = (eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex, model: string): AliasableExpression<SqlBool> =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.item_embeddings as ie").select(one(eb)).where("ie.repo", "=", kx.exprOf(eb, repo)).where("ie.number", "=", kx.exprOf(eb, number)).where("ie.model", "=", model));

/** Open items with a priority row: the keys `rescoreReach` loads the mirror's reach signals for in the same wave. */
registerKeySource<undefined>("triage.ratedOpen", (db) => queryDb(db).k.selectFrom("main.item_priority as rp").select(["rp.repo", "rp.number"]).where((eb) => openItem(eb, "rp.repo", "rp.number")));
