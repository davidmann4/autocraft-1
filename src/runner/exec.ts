// `autocraft-server runner exec <id>`: runs one claimed job in the runner's child
// process. Writes progress, the summary or the error, and the job's model
// usage; the runner sets the final state from the exit code.
import type { JobUsage } from "../../web/src/api/types.ts";
import { NoTakerError, setCallContext, StoppedError } from "../agents/call.ts";
import { trackedNames } from "../repos.ts";
import { AUTOPILOT_USER, KEY_ENABLED } from "./autopilot.ts";
import { loadLiveConfig, readSettingsSnapshot, withSettingsSnapshot, type SettingsSnapshot } from "../data/control/index.ts";
import { loadJobUsage } from "../data/inference/index.ts";
import { openJobPulse, type JobPulse, type JobResult } from "../data/jobs/index.ts";
import { leaseSkipKeys, leaseSkips } from "./leases.ts";
import { jobRow, scrub, type JobRow } from "./jobs.ts";
import { recordResult } from "../data/jobs/index.ts";
import { loadSteps, validateParams, type StepContext } from "./steps.ts";
import { JOB_DEADLINE_ENV, SLICE_SHARE } from "./deadlines.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";
import { stopWrites } from "../github/write.ts";

const liveWrites = async (db: Db): Promise<boolean> => { const c = await loadLiveConfig(db); return c.pipelineEnabled || c.drain; };

/** At most one write of a running job's progress, counts and cancel flag per this long. */
const PULSE_MS = 2000;

/** How long a stopping job waits for its GitHub writes in flight: inside the runner's 10 s before SIGKILL, with time left to record usage. */
const WRITE_SETTLE_MS = 7000;

/** Settings a running step re-reads to stop or to size its parallelism: the pipeline switch and the parallelism. */
const LIVE_SETTINGS = [KEY_ENABLED, "jev_parallel"];

const oneLine = (s: string, max = 500): string => scrub(s.replace(/\s+/g, " ").trim()).slice(0, max);

async function usageOf(db: Db, runs: Set<string>, since: string): Promise<JobUsage | null> {
  return await loadJobUsage(db, [...runs], since);
}

export async function execJob(id: number): Promise<number> {
  const db = await openDb();
  // The job's row and what its step starts with, in one wave.
  const { value: [row, tracked, settings], stats: loaded } = await db.meter(() => db.together(() => Promise.all([jobRow(db, id), trackedNames(db), readSettingsSnapshot(db)])));
  if (!row || row.state !== "running" || !row.started_at) {
    console.error(`job ${id} is not running`);
    return 2;
  }
  const startedAt = row.started_at;
  const runs = new Set<string>();
  // A resumed job (src/runner/resuming.ts) adds this run's calls to those of its earlier runs.
  let before: JobUsage | null = null;
  try { before = row.resumes && row.usage ? JSON.parse(row.usage) as JobUsage : null; } catch { /* unreadable: this run's alone */ }
  const pulse = await openJobPulse(db, row, { minMs: PULSE_MS });
  const usageJson = async (): Promise<string | undefined> => {
    const u = await usageOf(db, runs, startedAt);
    const all = u && before ? { calls: before.calls + u.calls, input: before.input + u.input, output: before.output + u.output, costUsd: before.costUsd === null && u.costUsd === null ? null : (before.costUsd ?? 0) + (u.costUsd ?? 0) } : u;
    return all ? JSON.stringify(all) : undefined;
  };
  const fail = async (msg: string): Promise<Ended> => {
    console.error(`failed: ${msg}`);
    return { code: 1, result: { usage: await usageJson(), error: oneLine(msg) } };
  };
  // The runner signals this process alone: GitHub writes in flight finish and are recorded, and a write asked for now is
  // not made (its caller waits, and a resumed run makes it); then what the job handled, counted and used so far is stored and
  // the rest of its process group (model calls, builds) is stopped. The process exits 143, or with the step's own code when
  // the step returned during the stop, once its outcome is stored.
  const ran: { code: number | null; ending: Promise<void> | null; stop: Promise<void> | null } = { code: null, ending: null, stop: null };
  let stepEnded = (): void => {};
  const ended = new Promise<void>((r) => { stepEnded = r; });
  process.once("SIGTERM", () => {
    ran.stop = (async () => {
      const left = await stopWrites("the job is stopping", WRITE_SETTLE_MS, ended);
      if (left) console.log(`${left} GitHub writes still running at the stop; their outcome is unknown`);
      try {
        if (!ran.ending) {
          const patch = await pulse.end();
          await recordResult(db, id, { patch, usage: await usageJson() });
          if (!ran.ending) console.log("stopped");
        }
      } catch (e) { console.error(`the stopped job's counts are not stored: ${(e as Error).message}`); }
      // Also a step that returned while the counts were stored.
      try { await ran.ending; } catch (e) { console.error(`the job's outcome is not stored: ${(e as Error).message}`); }
      process.on("SIGTERM", () => {});
      try { process.kill(-process.pid, "SIGTERM"); } catch { /* not a group leader (a command-line run) */ }
      process.exit(ran.code ?? 143);
    })();
  });
  const { value: { code, result }, stats } = await db.meter(() => runJob(db, id, row, { runs, usageJson, fail, pulse, tracked, settings }));
  // The outcome, the last progress and counts, and what the job cost the database, in one write.
  ran.ending = (async () => {
    const patch = await pulse.end();
    await recordResult(db, id, { ...result, patch, stats: { statements: loaded.statements + stats.statements, roundTrips: loaded.roundTrips + stats.roundTrips, ms: loaded.ms + stats.ms, effects: stats.effects } });
    ran.code = code;
  })();
  await ran.ending;
  stepEnded();
  // Stopping: the handler exits once the writes in flight are recorded.
  if (ran.stop) await ran.stop;
  return code;
}

/** How a job's step ended: the exit code and what its row records. */
type Ended = { code: number; result: JobResult };

/** Runs the job's step in this process. */
async function runJob(db: Db, id: number, row: JobRow, o: { runs: Set<string>; usageJson: () => Promise<string | undefined>; fail: (msg: string) => Promise<Ended>; pulse: JobPulse; tracked: string[]; settings: SettingsSnapshot }): Promise<Ended> {
  const { runs, usageJson, fail, pulse } = o;
  const startedAt = row.started_at!;
  const step = (await loadSteps()).get(row.step);
  if (!step) return await fail(`no step ${row.step} in this build`);
  console.log(`${new Date().toISOString()} job ${id}: ${step.name} ${row.params}, requested by ${row.requested_by}`);
  let params;
  try {
    params = validateParams(step, JSON.parse(row.params), o.tracked);
    const why = step.available?.() ?? (step.check ? await step.check(db, params) : null);
    if (why) return await fail(why);
  } catch (e) {
    return await fail((e as Error).message);
  }

  let lastProgress = 0;
  // The runner passes the deadline it enforces.
  const deadlineMin = Number(process.env[JOB_DEADLINE_ENV]);
  const sliceMs = deadlineMin > 0 ? deadlineMin * 60_000 * SLICE_SHARE : null;
  const ctx: StepContext = {
    db,
    job: { id, requestedBy: row.requested_by, startedAt, resumes: Number(row.resumes ?? 0) },
    params,
    async progress(text) {
      const t = Date.now();
      if (t - lastProgress < 1000) return;
      lastProgress = t;
      pulse.progress(oneLine(text, 200));
      console.log(text);
    },
    log: (line) => console.log(line),
    usageRun: (r) => void runs.add(r),
    // Counts of a resumed job add to its earlier runs', so the daily limits see all of them.
    handled: (n) => pulse.handled(n),
    acted: (n) => pulse.acted(n),
    cancelled: async () => await pulse.cancelled(),
    stopping: async () => await ctx.cancelled() || (row.requested_by === AUTOPILOT_USER && !(await loadLiveConfig(db)).pipelineEnabled),
    // The pulse reads the row's started_at, the runner's claim time, which the deadline counts from.
    timeUp: async () => sliceMs !== null && await pulse.timeUp(sliceMs),
  };
  setCallContext({ jobId: id, step: step.name, stage: step.stage, class: step.priority ?? 0, ...(typeof params.repo === "string" && { repo: params.repo }), cancelled: ctx.cancelled,
    // Model calls (local and remote) are withdrawn when the pipeline is switched off, not during a drain: running jobs finish with their calls.
    stopping: async () => await ctx.cancelled() || (row.requested_by === AUTOPILOT_USER && !await liveWrites(db)) });
  try {
    // One reading of the settings table serves the step's reads; the keys it polls to stop or throttle stay live.
    const summary = await withSettingsSnapshot(db, () => step.run(ctx), Promise.resolve(o.settings), { live: LIVE_SETTINGS, watchWrites: true });
    // Items skipped for a lease are work left for a later job: the planner retries once no job holds a lease (unchangedSinceIdle).
    const result = { usage: await usageJson(), ...(leaseSkips() ? { leaseSkips: leaseSkips(), leaseSkipKeys: leaseSkipKeys() } : {}), summary: oneLine(summary) };
    console.log(`${new Date().toISOString()} done: ${summary}`);
    return { code: 0, result };
  } catch (e) {
    if (e instanceof StoppedError || e instanceof NoTakerError) {
      const summary = e instanceof NoTakerError ? `skipped: ${e.message}` : "stopped: the pipeline was switched off";
      const result = { usage: await usageJson(), ...(leaseSkips() ? { leaseSkips: leaseSkips(), leaseSkipKeys: leaseSkipKeys() } : {}), summary };
      console.log(`${new Date().toISOString()} done: ${summary}`);
      return { code: 0, result };
    }
    console.error((e as Error).stack ?? e);
    return await fail((e as Error).message ?? String(e));
  }
}
