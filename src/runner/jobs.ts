// The jobs table: requests from the dashboard, the CLI and the autopilot,
// state written by the runner. Shared by the API, the runner and the CLI.
import { filtered, hiddenTestExpr, isHiddenRepo, type HiddenRepos } from "../hidden-sql.ts";
import { appendFileSync, closeSync, fstatSync, openSync, readSync, unlinkSync } from "node:fs";
import type { Job, JobDetail,  JobFilter, JobList, JobParams, JobState, JobUsage } from "../../web/src/api/types.ts";
import { trackedNames } from "../repos.ts";
import { accountLabelsByJob, failRunning } from "../agents/runs.ts";
import { releaseJob } from "./leases.ts";
import { knownStep, loadSteps, modelsOf, ParamError, validateParams, type StepDef } from "./steps.ts";
import { shownLookup } from "../dash/api/shown.ts";
import { blankIfHidden } from "../dash/api/visible.ts";
import { withdrawJobCalls } from "../remote/calls.ts";
import { untakenTest, type UntakenTest } from "./concurrency.ts";
import { MAX_RESUMES, MAX_TOTAL_RESUMES } from "./resuming.ts";

export const JOB_STATES: JobState[] = ["queued", "running", "done", "failed", "cancelled"];
/** Error text of jobs a runner stop or restart ended without resuming them (resumeJob); the autopilot does not count them as failures. */
export const RUNNER_STOPPED = "The runner stopped while this job ran; start it again if needed.";
/** Error of a job the runner stopped for running past its step's deadline; set when the stop is asked, so the job can finish its current item. */
export const DEADLINE_ERROR = /^stopped: (ran past|no progress for) /;
export const now = (): string => new Date().toISOString();
/** Requester of a job that a command line queues for the runner to run (`workspace try`), as opposed to a command-line run (`cli`). */
export const CLI_QUEUE_BY = "cli-queue";

export class JobError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type JobRow = {
  repo: string | null; id: number; step: string; params: string; requested_by: string; requested_at: string; state: JobState;
  started_at: string | null; ended_at: string | null; progress: string | null; summary: string | null; error: string | null;
  usage: string | null; log_path: string | null; pid: number | null; cancel_requested_at: string | null; cancel_requested_by: string | null;
  items: number | null; acted: number | null; resumes: number | null;
};

function parseJson<T>(s: string | null, fallback: T): T {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** `accounts`: labels of the accounts the job's agent runs used; `waiting`: why the queued job does not start (see `toJobs` for a page of jobs). */
export function toJob(r: JobRow, accounts: string[] = [], waiting: string | null = null): Job {
  const params = parseJson<JobParams>(r.params, {});
  return {
    id: r.id, step: r.step, params, requestedBy: r.requested_by, requestedAt: r.requested_at,
    state: r.state, startedAt: r.started_at, endedAt: r.ended_at, progress: r.progress, summary: r.summary, error: r.error,
    cancelRequested: r.cancel_requested_at !== null, usage: parseJson<JobUsage | null>(r.usage, null),
    models: modelsOf(knownStep(r.step), params), accounts, waiting,
  };
}

/** Jobs with their account labels, looked up in one query, and for a queued job that no Task Runner may take, the reason. */
export async function toJobs(db: Db, rows: JobRow[]): Promise<Job[]> {
  const labels = await accountLabelsByJob(db, rows.map((r) => r.id));
  let untaken: UntakenTest | undefined;
  return await mapSeq(rows, async (r) => toJob(r, labels.get(r.id), r.state === "queued" ? await (untaken ??= await untakenTest(db))(r) : null));
}

export async function jobRow(db: Db, id: number): Promise<JobRow | undefined> {
  return await db.get(db.k.selectFrom("jobs").select(cols("jobs")).$narrowType<{ state: JobState }>().where("id", "=", id));
}

export async function getJob(db: Db, id: number): Promise<Job> {
  const r = await jobRow(db, id);
  if (!r) throw new JobError(404, `no job ${id}`);
  return (await toJobs(db, [r]))[0]!;
}

export async function listJobs(db: Db, f: JobFilter = {}, hidden: HiddenRepos = []): Promise<JobList> {
  const filter = <QB extends SelectQueryBuilder<DB, "jobs", any>>(q: QB): QB => q
    .$if(!!f.step, (q) => q.where("step", "=", f.step!))
    .$if(!!f.state, (q) => q.where("state", "=", f.state!))
    .$if(filtered(hidden), (q) => q.where((eb) => eb.or([eb("repo", "is", null), eb.not(hiddenTestExpr(db, "repo", hidden))]))) as QB;
  const total = (await db.get(filter(db.k.selectFrom("jobs").select((eb) => eb.fn.countAll<number>().as("n")))))!.n;
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200), offset = Math.max(f.offset ?? 0, 0);
  const rows = await db.all(filter(db.k.selectFrom("jobs").select(cols("jobs")).$narrowType<{ state: JobState }>()).orderBy("id", "desc").limit(limit).offset(offset));
  return { jobs: await toJobs(db, rows), total };
}

async function stepOf(name: unknown): Promise<StepDef> {
  const step = typeof name === "string" ? (await loadSteps()).get(name) : undefined;
  if (!step) throw new JobError(400, "no such step");
  return step;
}

/** Validated params for a step, or a 400. */
export async function checkRequest(db: Db, stepName: unknown, rawParams: unknown): Promise<{ step: StepDef; params: JobParams }> {
  const step = await stepOf(stepName);
  let params: JobParams;
  try {
    params = validateParams(step, rawParams, await trackedNames(db));
  } catch (e) {
    if (e instanceof ParamError) throw new JobError(400, e.message);
    throw e;
  }
  const why = step.available?.() ?? null;
  if (why) throw new JobError(409, why);
  const refused = step.check ? await step.check(db, params) : null;
  if (refused) throw new JobError(409, refused);
  return { step, params };
}

/** Queues a job. The same step with the same params already waiting is refused. */
/** `settle` runs after the request is checked and before the insert, with no await between: it may change the params (a recomputed limit) or return null to refuse. */
export async function enqueue(db: Db, stepName: unknown, rawParams: unknown, by: string, settle?: (step: StepDef, params: Record<string, unknown>) => Promise<Record<string, unknown> | null>): Promise<Job> {
  const checked = await checkRequest(db, stepName, rawParams);
  const { step } = checked;
  const params = settle ? await settle(step, checked.params) : checked.params;
  if (!params) throw new JobError(409, `the daily limit of ${step.name} leaves too little for a job`);
  const json = JSON.stringify(params);
  if (await db.get(db.k.selectFrom("jobs").select("id").where("step", "=", step.name).where("params", "=", json).where("state", "=", "queued").limit(1))) {
    throw new JobError(409, `${step.name} with these settings is already queued`);
  }
  const repo = typeof params.repo === "string" ? params.repo : null;
  const id = (await db.get(db.k.insertInto("jobs").values({ step: step.name, params: json, repo, requested_by: by, requested_at: now(), state: "queued" }).returning("id")))!.id;
  return await getJob(db, id);
}

/** A queued job is cancelled at once; a running one is marked and the runner stops it. */
export async function requestCancel(db: Db, id: number, by: string): Promise<Job> {
  const r = await jobRow(db, id);
  if (!r) throw new JobError(404, `no job ${id}`);
  const t = now();
  if (r.state === "queued") {
    const done = (await db.run(db.k.updateTable("jobs").set({ state: "cancelled", ended_at: t, cancel_requested_at: t, cancel_requested_by: by })
      .where("id", "=", id).where("state", "=", "queued"))).changes;
    if (done) {
      // A job waiting to resume leaves its earlier run's remote calls behind.
      if (Number(r.resumes) > 0) {
        await withdrawJobCalls(db, "The job was cancelled.", id);
        await failRunning(db, "The job was cancelled.", id);
        await db.run(db.k.updateTable("main.remote_calls").set({ reply: null }).where("job_id", "=", id).where("state", "=", "done").where("reply", "is not", null));
      }
      return await getJob(db, id);
    }
  }
  const marked = (await db.run(db.k.updateTable("jobs")
    .set((eb) => ({ cancel_requested_at: eb.fn.coalesce("cancel_requested_at", eb.val(t)), cancel_requested_by: eb.fn.coalesce("cancel_requested_by", eb.val(by)) }))
    .where("id", "=", id).where("state", "=", "running"))).changes;
  if (!marked) throw new JobError(409, `job ${id} has already ended`);
  return await getJob(db, id);
}

/** Finished jobs and their log files are kept this long; audit and token_usage are kept for good. */
export const JOB_KEEP_MS = 3650 * 24 * 3600_000;

/** Deletes finished jobs that ended more than JOB_KEEP_MS ago, with their log files. Returns the number of jobs. */
export async function pruneJobs(db: Db, nowMs: number = Date.now()): Promise<number> {
  const before = new Date(nowMs - JOB_KEEP_MS).toISOString();
  let n = 0;
  for (;;) {
    const rows = await db.all(db.k.selectFrom("jobs").select(["id", "log_path"]).where("ended_at", "is not", null).where("ended_at", "<", before)
      .where("state", "in", ["done", "failed", "cancelled"]).orderBy("ended_at").limit(1000));
    if (!rows.length) return n;
    for (const r of rows) {
      if (r.log_path) {
        try {
          unlinkSync(r.log_path);
        } catch {
          // already gone
        }
      }
      await db.run(db.k.deleteFrom("job_items").where("job_id", "=", r.id));
      await db.run(db.k.deleteFrom("job_log_chunks").where("job_id", "=", r.id));
      await db.run(db.k.deleteFrom("jobs").where("id", "=", r.id));
      n++;
    }
  }
}

// ---- logs ----------------------------------------------------------------------

export { scrub } from "./scrub.ts";
import { scrub } from "./scrub.ts";
import { mapSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";
import type { DB } from "../db/types.ts";
import type { SelectQueryBuilder } from "kysely";
import { cols, like } from "../db/kx.ts";
import { storedLogTail } from "./job-log.ts";

export const LOG_TAIL_BYTES = 48 * 1024;

/** The end of a job's log: from its log file when this process can read it (it shares the runner's disk), else as the runner stored it. */
export async function jobLogTail(db: Db, id: number, path: string | null, bytes = LOG_TAIL_BYTES): Promise<{ log: string; logTruncated: boolean }> {
  const local = logTail(path, bytes);
  if (local) return local;
  const stored = await storedLogTail(db, id, bytes);
  return stored ? { log: scrub(stored.log), logTruncated: stored.logTruncated } : { log: "", logTruncated: false };
}

/** The end of a log file; null when there is none to read here. */
export function logTail(path: string | null, bytes = LOG_TAIL_BYTES): { log: string; logTruncated: boolean } | null {
  if (!path) return null;
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return { log: scrub(text), logTruncated: start > 0 };
  } finally {
    closeSync(fd);
  }
}

/**
 * `hidden`: the repos the viewer may not see. A job of such a repo is not found.
 * `logs` false (viewers) leaves the log out: its lines can name hidden items and carry command output. For other readers the lines
 * that name a hidden repo are left out (a job without a repo, or a step that reads other repos, logs items of every repo it worked).
 */
export async function jobDetail(db: Db, id: number, view: { hidden?: HiddenRepos; logs?: boolean } = {}): Promise<JobDetail> {
  const r = await jobRow(db, id);
  const hidden = view.hidden ?? [];
  if (!r || (r.repo && isHiddenRepo(hidden, r.repo))) throw new JobError(404, `no job ${id}`);
  const shown = shownLookup(db);
  const items = await mapSeq((await db.all(db.k.selectFrom("job_items").select(["repo", "number", "outcome", "ref"]).where("job_id", "=", id).orderBy("id")))
    .filter((i) => !isHiddenRepo(hidden, i.repo)), async (i) => ({ repo: i.repo, number: i.number, ...await shown(i.repo, i.number), outcome: i.outcome, decision: i.ref }));
  if (view.logs === false) return { ...(await toJobs(db, [r]))[0]!, items, log: null, logTruncated: false, canCancel: false };
  const tail = await jobLogTail(db, id, r.log_path);
  return { ...(await toJobs(db, [r]))[0]!, items, canCancel: false, ...tail, log: tail.log && hidden.length ? tail.log.split("\n").filter((l) => !l || blankIfHidden(l, hidden)).join("\n") : tail.log };
}

/**
 * Puts a running job that a runner stop or restart interrupted back in the queue under the same id: it runs again from the
 * start, with a fresh deadline. Its remote calls stay for the resumed run to adopt (enqueueCall), with their agent runs;
 * the stopped process's local model calls, model-queue waits and work leases end. False, and nothing changes, when it may
 * not resume: a cancel was asked, it was told to stop at its deadline, it resumed MAX_TOTAL_RESUMES times already (or, after an unclean stop, MAX_RESUMES crash resumes), or it is a
 * command-line run (`requested_by` cli: its process belongs to the command, which records its end). A job a command only
 * queues (CLI_QUEUE_BY) runs under the runner like any other, so it resumes.
 */
export async function resumeJob(db: Db, id: number, why: string, kind: "graceful" | "crash"): Promise<boolean> {
  const crash = kind === "crash";
  const r = await db.get(db.k.updateTable("jobs")
    .set((eb) => ({ state: "queued", resumes: eb("resumes", "+", 1), crash_resumes: crash ? eb("crash_resumes", "+", 1) : eb.ref("crash_resumes"), started_at: null, ended_at: null, pid: null, progress: null, error: null }))
    .where("id", "=", id).where("state", "=", "running").where("cancel_requested_at", "is", null).where("resumes", "<", MAX_TOTAL_RESUMES).$if(crash, (q) => q.where("crash_resumes", "<", MAX_RESUMES)).where("requested_by", "<>", "cli")
    .where((eb) => eb.or([eb("error", "is", null), eb.and([
      eb.not(like(db, "error", eb.val("stopped: ran past %"))), eb.not(like(db, "error", eb.val("stopped: no progress for %"))),
    ])]))
    .returning(["resumes", "crash_resumes", "log_path"]));
  if (!r) return false;
  await failRunning(db, "The runner stopped during this call.", id);
  await db.run(db.k.deleteFrom("model_waits").where("job_id", "=", id));
  await releaseJob(db, id);
  if (r.log_path) {
    try { appendFileSync(r.log_path, `${now()} ${why}; the job is queued to resume after the restart (resume ${r.resumes}${crash ? `; crash resume ${r.crash_resumes} of ${MAX_RESUMES}` : ""})\n`); } catch { /* the log is gone */ }
  }
  return true;
}

/**
 * Records the end of a job whose process closed: done on exit 0, cancelled when a cancel was asked, else failed with the
 * reason. With `stopping` (the runner stops) a job that the stop ended resumes (resumeJob): state `queued`.
 */
export async function endJob(db: Db, id: number, code: number | null, signal: NodeJS.Signals | null, spawnError: string | null, stopping = false): Promise<{ state: "done" | "failed" | "cancelled" | "queued"; error: string | null } | null> {
  const row = await jobRow(db, id);
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
  await failRunning(db, "The job ended during this call.", id);
  await db.run(db.k.deleteFrom("model_waits").where("job_id", "=", id));
  await withdrawJobCalls(db, "The job ended during this call.", id);
  // Replies an earlier run of the job left unread are not kept.
  await db.run(db.k.updateTable("main.remote_calls").set({ reply: null }).where("job_id", "=", id).where("state", "=", "done").where("reply", "is not", null));
  await releaseJob(db, id);
  await db.run(db.k.updateTable("jobs").set({ state, ended_at: now(), pid: null, error: state === "failed" ? error : null, ...(state === "done" ? { progress: null } : {}) }).where("id", "=", id));
  return { state, error: state === "failed" ? error : null };
}
