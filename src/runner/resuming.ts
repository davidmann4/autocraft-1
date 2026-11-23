// Jobs that a runner stop or restart interrupted go back to the queue under the same id (resumeJob in jobs.ts) and run
// again from the start. Their remote calls stay: the resumed run adopts the call it makes again with the same bundle
// (enqueueCall), and a reply a Task Runner sent meanwhile is read from the row. Their successful GitHub writes are not
// made again (src/github/write.ts). Local model calls and local steps simply run again.
import type { AliasableExpression, SqlBool } from "kysely";
import type { Db } from "../db/index.ts";
import { ref, type Eb } from "../db/kx.ts";

/** A job may resume this many times after an unclean stop (a crash or a kill without the stop signal), which a job that takes the runner down repeatedly causes; a stop past that fails it with RUNNER_STOPPED. */
export const MAX_RESUMES = 2;
/** A job may resume this many times in all, graceful restarts (deploys) included: a backstop against an endless loop. */
export const MAX_TOTAL_RESUMES = 12;
/** Jobs waiting in the queue to resume. */
export const RESUMING_JOBS = "SELECT id FROM main.jobs WHERE state = 'queued' AND resumes > 0";
/** `RESUMING_JOBS` as a subquery. */
export const resumingJobsExpr = (db: Db) => db.k.selectFrom("main.jobs").select("id").where("state", "=", "queued").where("resumes", ">", 0);
/**
 * A remote_calls row of an earlier run of a resumed job that has not ended: it waits for adoption, with no caller polling
 * it. The resumed run's own calls (made since it started) have their caller.
 */
export const EARLIER_RUN_CALL = `EXISTS (SELECT 1 FROM main.jobs j WHERE j.id = remote_calls.job_id AND j.resumes > 0
  AND (j.state = 'queued' OR (j.state = 'running' AND remote_calls.since < (julianday(j.started_at) - 2440587.5) * 86400000)))`;
/** `EARLIER_RUN_CALL` on `remote_calls`. */
export const earlierRunCallExpr = (db: Db, eb: Eb): AliasableExpression<SqlBool> =>
  eb.exists(db.k.selectFrom("main.jobs as j").select(eb.lit(1).as("one")).where("j.id", "=", ref<number>("remote_calls.job_id")).where("j.resumes", ">", 0)
    .where((e) => e.or([e("j.state", "=", "queued"), e.and([e("j.state", "=", "running"),
      e(ref<number>("remote_calls.since"), "<", e(e.parens(e.fn<number>("julianday", [e.ref("j.started_at")]), "-", e.lit(2440587.5)), "*", e.lit(86400000)))])])));
/** Remote calls a resumed run may adopt: open, or answered and not yet read. */
export const ADOPTABLE_CALL = "state IN ('queued', 'leased', 'done') AND consumed_at IS NULL";
/** `ADOPTABLE_CALL` on `remote_calls`, unaliased. */
export const adoptableCallExpr = (eb: Eb): AliasableExpression<SqlBool> => eb.and([eb("state", "in", ["queued", "leased", "done"]), eb("consumed_at", "is", null)]);
/** Agent runs of the adoptable calls of resuming jobs: they stay running until the resumed run reads the reply or the job ends. */
export const KEPT_RUNS = `SELECT run_id FROM main.remote_calls WHERE run_id IS NOT NULL AND ${ADOPTABLE_CALL} AND job_id IN (${RESUMING_JOBS})`;
/** `KEPT_RUNS` as a subquery. */
export const keptRunsExpr = (db: Db) => db.k.selectFrom("main.remote_calls").select("run_id").where("run_id", "is not", null)
  .where((eb) => adoptableCallExpr(eb)).where("job_id", "in", resumingJobsExpr(db));

/** For a job that resumed: when its current run started (work recorded before that belongs to an earlier run). Null for a job that never resumed. */
export async function resumedRun(db: Db, jobId: number): Promise<{ resumes: number; startedAt: string } | null> {
  const r = await db.get(db.k.selectFrom("main.jobs").select(["resumes", "started_at"]).where("id", "=", jobId));
  return r && Number(r.resumes) > 0 && r.started_at ? { resumes: Number(r.resumes), startedAt: r.started_at } : null;
}

/**
 * A token_usage run id that is one job's own: each resumed run gets its own, so the rows of an earlier run (keyed by run
 * id and agent, which restart with the run) are kept beside the later run's.
 */
export const jobRunId = (prefix: string, job: { id: number; resumes: number }): string => (job.resumes ? `${prefix}-${job.id}-r${job.resumes}` : `${prefix}-${job.id}`);
