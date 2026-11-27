// How a job leaves the running state: resume after a stop, end, cancel. Each touches tables of several data modules
// (jobs, inference's agent runs, runners' remote calls), so the sequence lives here and runs in one transaction; the log
// file is written after it commits.
import { appendFileSync } from "node:fs";
import type { Db } from "../db/index.ts";
import { clearLeases, loadJobs, loadRunning, markCancelQueued, markCancelRequested, markEnded, markResumed, releaseLeases, RUNNER_STOPPED } from "../data/jobs/index.ts";
import { failRunning } from "../data/inference/index.ts";
import { clearJobReplies, withdrawJobCalls } from "../data/runners/index.ts";
import { MAX_RESUMES } from "./resuming.ts";

/** Error text of jobs a runner stop or restart ended without resuming them (resumeJob); the autopilot does not count them as failures. */
export { RUNNER_STOPPED } from "../data/jobs/index.ts";
/** Error of a job the runner stopped for running past its step's deadline; set when the stop is asked, so the job can finish its current item. */
export const DEADLINE_ERROR = /^stopped: (ran past|no progress for) /;
export const now = (): string => new Date().toISOString();

export class JobError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The calls, runs and replies a job leaves behind when it will not run again. */
export async function dropJobCalls(db: Db, reason: string, ids: number[]): Promise<void> {
  for (const id of ids) {
    await withdrawJobCalls(db, reason, id);
    await failRunning(db, reason, { jobId: id });
  }
  await clearJobReplies(db, ids);
}

/** A queued job is cancelled at once; a running one is marked and the runner stops it. Throws JobError 404 and 409. */
export async function cancelJob(db: Db, id: number, by: string): Promise<void> {
  const r = (await loadJobs(db, [id])).get(id);
  if (!r) throw new JobError(404, `no job ${id}`);
  if (r.state === "queued") {
    const done = await db.write(async () => {
      const cancelled = await markCancelQueued(db, { ids: [id] }, by);
      // A job waiting to resume leaves its earlier run's remote calls behind.
      if (cancelled[0] && Number(cancelled[0].resumes) > 0) await dropJobCalls(db, "The job was cancelled.", [id]);
      return cancelled.length > 0;
    });
    if (done) return;
  }
  if (!await markCancelRequested(db, [id], by)) throw new JobError(409, `job ${id} has already ended`);
}

/**
 * Puts running jobs that a runner stop or restart interrupted back in the queue under the same id: each runs again from the
 * start, with a fresh deadline. Their remote calls stay for the resumed run to adopt (enqueueCall), with their agent runs;
 * the stopped process's local model calls and work leases end. A job does not resume (it is left out of the result, and
 * nothing changes) when a cancel was asked, it was told to stop at its deadline, it resumed MAX_TOTAL_RESUMES times already
 * (or, after an unclean stop, MAX_RESUMES crash resumes), or it is a command-line run (`requested_by` cli: its process belongs to
 * the command, which records its end). A job a command only queues (CLI_QUEUE_BY) runs under the runner like any other, so it resumes.
 */
export async function resumeJobs(db: Db, rows: { id: number; kind: "graceful" | "crash" }[], why: string): Promise<Set<number>> {
  if (!rows.length) return new Set();
  const kinds = new Map(rows.map((r) => [r.id, r.kind]));
  const resumed = await db.write(async () => {
    const got = await markResumed(db, rows);
    if (got.length) {
      for (const r of got) await failRunning(db, "The runner stopped during this call.", { jobId: r.id });
      await releaseLeases(db, { jobIds: got.map((r) => r.id) });
    }
    return got;
  });
  for (const r of resumed) {
    if (!r.log_path) continue;
    const crash = kinds.get(r.id) === "crash";
    try { appendFileSync(r.log_path, `${now()} ${why}; the job is queued to resume after the restart (resume ${r.resumes}${crash ? `; crash resume ${r.crash_resumes} of ${MAX_RESUMES}` : ""})\n`); } catch { /* the log is gone */ }
  }
  return new Set(resumed.map((r) => r.id));
}

export async function resumeJob(db: Db, id: number, why: string, kind: "graceful" | "crash"): Promise<boolean> {
  return (await resumeJobs(db, [{ id, kind }], why)).has(id);
}

/**
 * Records the end of a job whose process closed: done on exit 0, cancelled when a cancel was asked, else failed with the
 * reason. With `stopping` (the runner stops) a job that the stop ended resumes (resumeJob): state `queued`.
 */
export async function endJob(db: Db, id: number, code: number | null, signal: NodeJS.Signals | null, spawnError: string | null, stopping = false): Promise<{ state: "done" | "failed" | "cancelled" | "queued"; error: string | null } | null> {
  const row = (await loadJobs(db, [id])).get(id);
  if (!row || row.state !== "running") return null;
  const finished = code === 0 && !DEADLINE_ERROR.test(row.error ?? "");
  // Stopped by the stop: the process exited on the stop signal (exec.ts exits 143) or was killed. Another exit is the job's own result.
  const stopped = stopping && (code === 143 || signal !== null);
  if (stopped && !finished && !row.cancel_requested_at && await resumeJob(db, id, "the runner stopped", "graceful")) return { state: "queued", error: null };
  let state: "done" | "failed" | "cancelled";
  let error: string | null = row.error;
  if (row.cancel_requested_at) state = "cancelled";
  else if (finished) state = "done";
  else {
    state = "failed";
    if (stopped) error = RUNNER_STOPPED;
    error ??= spawnError ?? (signal ? `The job's process ended on ${signal}.` : `The job's process exited with code ${code}.`);
  }
  await db.write(async () => {
    // Replies an earlier run of the job left unread are not kept.
    await dropJobCalls(db, "The job ended during this call.", [id]);
    await releaseLeases(db, { jobIds: [id] });
    await markEnded(db, [{ id, state, error: state === "failed" ? error : null, clearProgress: state === "done" }]);
  });
  return { state, error: state === "failed" ? error : null };
}

/**
 * Jobs left `running` belong to a runner that is gone: each resumes (resumeJob), or ends cancelled (a cancel was asked) or
 * failed (it may not resume). Their agent runs and remote calls end except those of resuming jobs, and every work lease ends.
 * `skip` are jobs this process runs; `stop` ends what is left of the process of each other job before the job is resumed or ended.
 */
export async function recoverJobs(db: Db, o: { skip: (id: number) => boolean; stop: (job: { id: number; pid: number | null }) => void; log: (line: string) => void }): Promise<number> {
  const rows = await loadRunning(db);
  const mine = rows.filter((r) => !o.skip(r.id));
  for (const r of mine) o.stop(r);
  const cancelled = new Set(mine.filter((r) => r.cancel_requested_at !== null).map((r) => r.id));
  const resumed = await resumeJobs(db, mine.filter((r) => !cancelled.has(r.id)).map((r) => ({ id: r.id, kind: "crash" as const })), "the runner restarted");
  const ended = mine.filter((r) => !resumed.has(r.id));
  await db.write(async () => {
    await markEnded(db, ended.map((r) => ({ id: r.id, state: cancelled.has(r.id) ? "cancelled" : "failed", error: cancelled.has(r.id) ? r.error : r.error ?? RUNNER_STOPPED, clearProgress: false })));
    // Replies an earlier run of the job left unread are not kept (as in endJob).
    await clearJobReplies(db, ended.map((r) => r.id));
  });
  for (const r of mine) {
    o.log(resumed.has(r.id) ? `job ${r.id}: left running by an earlier runner, queued to resume` : `job ${r.id}: left running by an earlier runner, marked ${cancelled.has(r.id) ? "cancelled" : "failed"}`);
  }
  // Model calls of a runner that is gone no longer hold an account slot.
  const orphans = await failRunning(db, "The runner stopped during this call.");
  if (orphans) o.log(`${orphans} agent runs left running by an earlier runner, marked failed`);
  await withdrawJobCalls(db, "The runner stopped during this call.");
  await clearLeases(db);
  return rows.length;
}
