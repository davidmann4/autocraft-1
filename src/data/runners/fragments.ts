// Predicates other modules embed.
import type { AliasableExpression, Expression, SelectQueryBuilder, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import { exprOf, inList, ref, schemaEb, type AnyEb, type Eb, type Ex } from "../../db/kx.ts";

import { earlierRunCall as jobsEarlierRunCall, resumingJobs } from "../jobs/fragments.ts";

const MANUAL_ONLY_KEY = "manual_only";

/** The run of the call's live lease: only calls queued under it are served. */
export function leasedRunOf(db: Db, callId: number): SelectQueryBuilder<any, any, { run_id: number | null }> {
  return queryDb(db).k.selectFrom("remote_calls").select("run_id").where("id", "=", callId).where("state", "=", "leased");
}

/** leasedRunOf for several calls. */
export function leasedRunsOf(db: Db, callIds: number[]): SelectQueryBuilder<any, any, { run_id: number | null }> {
  return queryDb(db).k.selectFrom("remote_calls").select("run_id").where(inList(db, "id", callIds, "bigint")).where("state", "=", "leased");
}

/** The run of the call in any state: what its last lease ran under. */
export function runOfCall(db: Db, callId: number): SelectQueryBuilder<any, any, { run_id: number | null }> {
  return queryDb(db).k.selectFrom("remote_calls").select("run_id").where("id", "=", callId);
}

/** A `remote_calls` row (unaliased) that a resumed run may adopt: open, or answered and not yet read. */
export function adoptableCall(eb: Eb): Expression<SqlBool> {
  return eb.and([eb("state", "in", ["queued", "leased", "done"]), eb("consumed_at", "is", null)]);
}

/** A `remote_calls` row (unaliased) of an earlier run of a resumed job that has not ended: it waits for adoption with no caller. */
export const earlierRunCall = jobsEarlierRunCall;

/** Agent run ids of adoptable calls of resuming jobs: they stay running until the resumed run reads the reply or the job ends. */
export function keptRuns(db: Db): SelectQueryBuilder<any, any, { run_id: number | null }> {
  return queryDb(db).k.selectFrom("remote_calls").select("run_id").where("run_id", "is not", null)
    .where((eb) => adoptableCall(eb)).where("job_id", "in", resumingJobs(db));
}

/** Scalar subquery: when the call was queued (`since`, ms). */
export function callSince(eb: Eb, callId: Ex): Expression<number | null> {
  const w = schemaEb(eb);
  return w.selectFrom("remote_calls as cs").select("cs.since").where("cs.id", "=", ref<number>(callId)) as unknown as Expression<number | null>;
}

/** The login in `loginCol` has `manual_only = '1'`. */
export function manualOnlyExpr(eb: Eb, loginCol: Ex): Expression<SqlBool> {
  return userSettingExpr(eb, loginCol, MANUAL_ONLY_KEY, "1");
}

/** The login in `loginCol` has setting `key` (with `value` when given). */
export function userSettingExpr(eb: Eb, loginCol: Ex, key: string, value?: string): Expression<SqlBool> {
  const w = schemaEb(eb);
  return w.exists(w.selectFrom("user_settings as us").select(w.lit(1).as("one")).where("us.login", "=", ref<string>(loginCol)).where("us.key", "=", key)
    .$if(value !== undefined, (q) => q.where("us.value", "=", value!)));
}

/** Scalar: 1 when a call of the job waits in the queue for a caller that polls it (seen within `staleMs`), else 0. */
export function remoteQueuedOf(eb: AnyEb, jobIdRef: Ex, nowMs: number, staleMs: number): AliasableExpression<number> {
  const t = schemaEb(eb);
  return eb.fn.coalesce(t.selectFrom("main.remote_calls as rq").select((e) =>
    e.fn.max<number>(e.case().when(e.and([e("rq.state", "=", "queued"), e("rq.seen_at", ">=", nowMs - staleMs)])).then(e.lit(1)).else(e.lit(0)).end()).as("q"))
    .where("rq.job_id", "=", exprOf(eb, jobIdRef)), eb.lit(0)) as unknown as AliasableExpression<number>;
}

/** Scalar: when the job's latest remote call was leased (ms), or null. */
export function lastLeaseOf(eb: AnyEb, jobIdRef: Ex): AliasableExpression<number | null> {
  return schemaEb(eb).selectFrom("main.remote_calls as rl").select((e) => e.fn.max<number | null>("rl.leased_at").as("l"))
    .where("rl.job_id", "=", exprOf(eb, jobIdRef)) as unknown as AliasableExpression<number | null>;
}
