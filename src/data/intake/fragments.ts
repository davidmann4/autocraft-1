// Predicates other modules embed in their statements (src/data/** only).
import type { AliasableExpression } from "kysely";
import type { SqlBool } from "kysely";
import * as kx from "../../db/kx.ts";

/** The item `repo#number` is held (a row in `outside_holds`). */
export const heldExpr = (eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex): AliasableExpression<SqlBool> =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.outside_holds as oh").select(eb.lit(1).as("one")).where("oh.repo", "=", kx.exprOf(eb, repo)).where("oh.number", "=", kx.exprOf(eb, number)));

/** The same, keyed by a `repo#number` text expression. */
export const heldByRef = (eb: kx.AnyEb, refs: kx.Ex): AliasableExpression<SqlBool> =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.outside_holds as oh").select(eb.lit(1).as("one"))
    .where((w) => w(w(w.ref("oh.repo"), "||", w.val("#")), "||", w.cast<string>(w.ref("oh.number"), "text")), "=", kx.exprOf(eb, refs)));
