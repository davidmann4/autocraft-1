// Fragments other modules embed. `alias` names the caller's table that has `repo` and `number` columns.
import type { Expression, Kysely, SelectQueryBuilder, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import { schemaEb, type Eb } from "../../db/kx.ts";
import { resolveKeys, type KeySource } from "../keys.ts";

const PATCH_TABLES = ["fixups", "ci_fixes", "conflict_merges"] as const;
const OPERATOR_ENDED = ["pushing", "pushed", "failed", "refused", "rejected", "cannot-push", "too-large", "push-denied", "asked", "comment-failed", "superseded"];

/** The final states of an operator fix-up's try that say something about the request: every one but a dropped try's. */
export const FINAL_BUT_DROPPED = OPERATOR_ENDED.filter((s) => s !== "superseded");

/** The pipeline already worked this item: a fix-up or CI fix row exists for it. */
export function hasPatchWork(eb: Eb, alias: string): Expression<SqlBool> {
  const w = schemaEb(eb);
  return eb.or(["fixups", "ci_fixes"].map((t) =>
    w.exists(w.selectFrom(`${t} as x` as "fixups as x").select(w.lit(1).as("one")).whereRef("x.repo", "=", `${alias}.repo` as never).whereRef("x.number", "=", `${alias}.number` as never))));
}

/** A fix-up row of the item at `headRef` (a column reference to the head) in one of `states`. */
export function hasFixupAt(eb: Eb, alias: string, headRef: string, states: readonly string[]): Expression<SqlBool> {
  const w = schemaEb(eb);
  return w.exists(w.selectFrom("fixups as x").select(w.lit(1).as("one")).whereRef("x.repo", "=", `${alias}.repo` as never)
    .whereRef("x.number", "=", `${alias}.number` as never).whereRef("x.from_head", "=", headRef as never).where("x.state", "in", [...states]));
}

/** The operator fix-up request of the row `alias` has a final fixups row (in one of `states`) of its own at the head it asks for. */
export function operatorFixEnded(eb: Eb, alias: string, states: readonly string[] = OPERATOR_ENDED): Expression<SqlBool> {
  const w = schemaEb(eb);
  return w.exists(w.selectFrom("fixups as f").select(w.lit(1).as("one")).whereRef("f.operator_fix", "=", `${alias}.id` as never).whereRef("f.from_head", "=", `${alias}.from_head` as never)
    .where("f.source", "=", "operator").where("f.state", "in", [...states]));
}

/** Every `lint_task` and `task_id` (column `id`) of the patch rows of `keys`, so `build.loadTaskStates` loads them in the same wave. */
export function patchTaskIds(db: Db, keys: KeySource): SelectQueryBuilder<any, any, { id: number }> {
  const k = queryDb(db).k as unknown as Kysely<any>;
  const of = (t: (typeof PATCH_TABLES)[number], col: string) => k.selectFrom(t)
    .innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", `${t}.repo`).onRef("kk.number", "=", `${t}.number`))
    .select(`${t}.${col} as id`).where(`${t}.${col}`, "is not", null);
  return of("fixups", "lint_task").union(of("conflict_merges", "lint_task")).union(of("ci_fixes", "lint_task")).union(of("ci_fixes", "task_id")) as SelectQueryBuilder<any, any, { id: number }>;
}
