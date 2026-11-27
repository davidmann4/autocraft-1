// Predicates other modules embed.
import type { Expression, SqlBool } from "kysely";
import { schemaEb, type Eb } from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import type { Db } from "../../db/index.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import type { HiddenRepos, RunVisibility } from "./types.ts";

/** Whether any repo filter applies: operators get an empty list without `visible`. */
export const filtered = (h: HiddenRepos): boolean => !!h.visible || h.length > 0;

/** The repo in `col` may be seen under `hidden`: not on the denylist, or on the allowlist `hidden.visible` when there is one (an empty allowlist shows nothing). */
export function repoShown(eb: Eb, col: string, hidden: HiddenRepos): Expression<SqlBool> {
  if (hidden.visible) return hidden.visible.length ? eb(col, "in", [...hidden.visible]) as Expression<SqlBool> : eb.val(false) as unknown as Expression<SqlBool>;
  return hidden.length ? eb(col, "not in", [...hidden]) as Expression<SqlBool> : eb.val(true) as unknown as Expression<SqlBool>;
}

/** `agent_runs` row (alias `alias`) visible under `vis`: no filter when nothing is hidden; else it has an item row and none in a hidden repo. */
export function runVisible(vis: { hidden: HiddenRepos }, eb: Eb, alias = "r"): Expression<SqlBool> {
  if (!filtered(vis.hidden)) return eb.val(true) as unknown as Expression<SqlBool>;
  const w = schemaEb(eb);
  const items = (q: ReturnType<typeof w.selectFrom<"agent_run_items as ri">>) => q.select(w.lit(1).as("one")).where("ri.run_id", "=", eb.ref(`${alias}.id`));
  return eb.and([
    w.exists(items(w.selectFrom("agent_run_items as ri"))),
    eb.not(w.exists(items(w.selectFrom("agent_run_items as ri")).where(eb.not(repoShown(eb, "ri.repo", vis.hidden))))),
  ]);
}
export type { RunVisibility };

/** The lowest item by repo and number of the run aliased `alias`: the stored column, or the item rows of a run an old pod wrote without it. */
export const runFirst = (eb: Eb, col: "repo" | "number", alias = "r") =>
  eb.fn.coalesce(`${alias}.first_${col}`, schemaEb(eb).selectFrom("agent_run_items as fi").select(`fi.${col}`).where("fi.run_id", "=", eb.ref(`${alias}.id`)).orderBy("fi.repo").orderBy("fi.number").limit(1) as never);

/** `run_id`s of runs that touched the items of `keys`, as a subquery. */
export function runItems(db: Db, keys: KeySource) {
  return queryDb(db).k.selectFrom("agent_run_items as ri")
    .innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "ri.repo").onRef("kk.number", "=", "ri.number"))
    .select("ri.run_id as run_id");
}
