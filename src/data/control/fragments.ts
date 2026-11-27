// Predicates other modules embed in their statements (src/data/** only).
import type { AliasableExpression, Expression, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import type { HiddenRepos } from "./types.ts";

const one = (eb: kx.AnyEb) => eb.lit(1).as("one");

/** The repo in `repoCol` is tracked (replaces the inline copies and the `TRACKED` string of `db/scoped.ts`). */
export const trackedRepo = (eb: kx.AnyEb, repoCol: kx.Ex): AliasableExpression<SqlBool> =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.tracked_repos as tr").select(one(eb)).where("tr.name", "=", kx.exprOf(eb, repoCol)));

/** The repo is tracked and its pipeline flag is on. */
export const pipelineOn = (eb: kx.AnyEb, repoCol: kx.Ex): AliasableExpression<SqlBool> =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.tracked_repos as tp").select(one(eb)).where("tp.name", "=", kx.exprOf(eb, repoCol)).where("tp.pipeline", "=", 1));

/** GitHub writes go out as the app (the registry's `githubIdentity`), not as the box account. */
export const appIdentity = (eb: kx.AnyEb): AliasableExpression<SqlBool> =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.settings as sg").select(one(eb)).where("sg.key", "=", "github_identity").where("sg.value", "=", "app"));

/** The viewer's repo filter on the repo in `col`: true when the repo is visible to them (a hidden list is a denylist, `visible` an allowlist). */
export const hiddenRepos = (db: Db, col: kx.Ex, hidden: HiddenRepos): AliasableExpression<SqlBool> =>
  (hidden.visible ? kx.inList(db, col, hidden.visible) : kx.inList(db, col, [...hidden], "text", true)) as AliasableExpression<SqlBool>;

/** True when the repo in `col` is hidden from the viewer: the negation of `hiddenRepos`. */
export const hiddenTestExpr = (db: Db | { readonly dialect: Db["dialect"] }, col: kx.Ex, hidden: HiddenRepos): AliasableExpression<SqlBool> =>
  (hidden.visible ? kx.inList(db, col, hidden.visible, "text", true) : kx.inList(db, col, [...hidden])) as AliasableExpression<SqlBool>;

/** `tripped_at` of the key's `stage_trips` row while it is active, else null. */
export const tripActiveSince = (eb: kx.AnyEb, key: string): Expression<string | null> =>
  kx.schemaEb(eb).selectFrom("main.stage_trips as sp").select("sp.tripped_at").where("sp.stage", "=", key).where("sp.active", "=", 1) as unknown as Expression<string | null>;
