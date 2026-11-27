// Predicates other modules embed.
import type { AliasableExpression, Expression, SelectQueryBuilder, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import { ref, schemaEb, type Eb, type Ex } from "../../db/kx.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import { PRIVATE_STEPS, TERMINAL } from "./types.ts";

/** The task in `idCol` is missing or in a terminal state (a null id counts as ended). */
export function taskEndedExpr(eb: Eb, idCol: Ex): Expression<SqlBool> {
  const w = schemaEb(eb);
  return eb.or([eb(ref(idCol), "is", null), eb.not(w.exists(w.selectFrom("build_tasks as bt").select(w.lit(1).as("one")).where("bt.id", "=", ref<number>(idCol)).where("bt.state", "not in", [...TERMINAL])))]);
}

/** Scalar: the run time in ms of the task in `idCol` (from when a worker took it to its end) when it ended `done`; else null. */
export function taskDoneMsExpr(eb: Eb, idCol: Ex): AliasableExpression<number | null> {
  const w = schemaEb(eb) as any;
  return w.selectFrom("build_tasks as dt")
    .select((e: any) => e(e(e.fn("julianday", ["dt.ended_at"]), "-", e.fn("julianday", [e.fn("coalesce", ["dt.started_at", "dt.claimed_at"])])), "*", 86400000).as("ms"))
    .where("dt.id", "=", ref<number>(idCol)).where("dt.state", "=", "done").where("dt.ended_at", "is not", null)
    .where((e: any) => e.or([e("dt.started_at", "is not", null), e("dt.claimed_at", "is not", null)])) as AliasableExpression<number | null>;
}

/** The state of the task in `idCol`, null when it is missing. */
export function taskStateExpr(eb: Eb, idCol: Ex): Expression<string | null> {
  const w = schemaEb(eb);
  return w.selectFrom("build_tasks as bs").select("bs.state").where("bs.id", "=", ref<number>(idCol)) as unknown as Expression<string | null>;
}

/** The task in `idCol` exists and is not in a terminal state. */
export function taskIsOpenExpr(eb: Eb, idCol: Ex): Expression<SqlBool> {
  const w = schemaEb(eb);
  return w.exists(w.selectFrom("build_tasks as bo").select(w.lit(1).as("one")).where("bo.id", "=", ref<number>(idCol)).where("bo.state", "not in", [...TERMINAL]));
}

/** Ids (column `id`) of the open tasks of the items in `keys`. */
export function openTaskIds(db: Db, keys: KeySource): SelectQueryBuilder<any, any, { id: number }> {
  return queryDb(db).k.selectFrom("build_tasks as t")
    .innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "t.repo").onRef("kk.number", "=", "t.number"))
    .select("t.id as id").where("t.state", "not in", [...TERMINAL]) as SelectQueryBuilder<any, any, { id: number }>;
}

/** Ids (column `id`) of the tasks of the jobs in `jobIds`. */
export function taskIdsOfJobs(db: Db, jobIds: number[]): SelectQueryBuilder<any, any, { id: number }> {
  return queryDb(db).k.selectFrom("build_tasks").select("id").where("job_id", "in", jobIds);
}

/** The step in `col` is one whose output stays private (fix checks, scan tests). */
export function privateStepExpr(eb: Eb, col: Ex): Expression<SqlBool> {
  return eb(ref(col), "in", [...PRIVATE_STEPS]);
}

/** Ids (column `id`) of the remote calls bound to the workspaces of `env` that are live. */
export function boundCallIds(db: Db, env: string): SelectQueryBuilder<any, any, { id: number }> {
  return queryDb(db).k.selectFrom("workspaces").select("remote_call_id as id").where("env_id", "=", env).where("remote_call_id", "is not", null)
    .where("state", "in", ["requested", "starting", "seeding", "ready", "parked"]) as SelectQueryBuilder<any, any, { id: number }>;
}
