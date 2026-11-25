// `autocraft-server runner exec <id>`: runs one claimed job in the runner's child
// process. Writes progress, the summary or the error, and the job's model
// usage; the runner sets the final state from the exit code.
import type { JobUsage } from "../../web/src/api/types.ts";
import { NoTakerError, setCallContext, StoppedError } from "../agents/call.ts";
import { trackedNames } from "../repos.ts";
import { AUTOPILOT_USER, isDraining, isEnabled, KEY_ENABLED } from "./autopilot.ts";
import { JEV_PARALLEL_KEY, USAGE_PAUSE_KEY } from "../agents/accounts.ts";
import { withSettingsSnapshot } from "../settings-read.ts";
import { leaseSkipKeys, leaseSkips } from "./leases.ts";
import { DEADLINE_ERROR, jobRow, scrub, type JobRow } from "./jobs.ts";
import { loadSteps, validateParams, type StepContext } from "./steps.ts";
import { JOB_DEADLINE_ENV, SLICE_SHARE } from "./deadlines.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";
import { stopWrites } from "../github/write.ts";

/** How long a stopping job waits for its GitHub writes in flight: inside the runner's 10 s before SIGKILL, with time left to record usage. */
const WRITE_SETTLE_MS = 7000;

/** Settings a running step re-reads to stop or to size its parallelism: the pipeline switch and the account limits. */
const LIVE_SETTINGS = [KEY_ENABLED, JEV_PARALLEL_KEY, USAGE_PAUSE_KEY];

const oneLine = (s: string, max = 500): string => scrub(s.replace(/\s+/g, " ").trim()).slice(0, max);

async function usageOf(db: Db, runs: Set<string>, since: string): Promise<JobUsage | null> {
  if (!runs.size) return null;
  const r = (await db.get(db.k.selectFrom("token_usage").select((eb) => [
    eb.fn.countAll<number>().as("calls"), eb.fn.coalesce(eb.fn.sum<number>("input_tokens"), eb.val(0)).as("input"),
    eb.fn.coalesce(eb.fn.sum<number>("output_tokens"), eb.val(0)).as("output"), eb.fn.sum<number | null>("cost_usd").as("cost"),
  ]).where("run_id", "in", [...runs]).where("started_at", ">=", since)))!;
  return { calls: r.calls, input: r.input, output: r.output, costUsd: r.cost };
}

export async function execJob(id: number): Promise<number> {
  const db = await openDb();
  const row = await jobRow(db, id);
  if (!row || row.state !== "running" || !row.started_at) {
    console.error(`job ${id} is not running`);
    return 2;
  }
  const startedAt = row.started_at;
  const runs = new Set<string>();
  // A resumed job (src/runner/resuming.ts) adds this run's calls to those of its earlier runs.
  let before: JobUsage | null = null;
  try { before = row.resumes && row.usage ? JSON.parse(row.usage) as JobUsage : null; } catch { /* unreadable: this run's alone */ }
  const itemsBefore = row.resumes ? Number(row.items ?? 0) : 0, actedBefore = row.resumes ? Number(row.acted ?? 0) : 0;
  const saveUsage = async () => {
    const u = await usageOf(db, runs, startedAt);
    const all = u && before ? { calls: before.calls + u.calls, input: before.input + u.input, output: before.output + u.output, costUsd: before.costUsd === null && u.costUsd === null ? null : (before.costUsd ?? 0) + (u.costUsd ?? 0) } : u;
    if (all) await db.run(db.k.updateTable("jobs").set({ usage: JSON.stringify(all) }).where("id", "=", id));
  };
  const fail = async (msg: string): Promise<number> => {
    await saveUsage();
    await db.run(db.k.updateTable("jobs").set({ error: oneLine(msg) }).where("id", "=", id));
    console.error(`failed: ${msg}`);
    return 1;
  };
  // The runner signals this process alone: GitHub writes in flight finish and are recorded, and a write asked for now is
  // not made (its caller waits, and a resumed run makes it); then the rest of the job's process group (model calls,
  // builds) is stopped. The process exits 143, or with the step's own code when the step returned during the stop.
  const ran: { code: number | null; stop: Promise<void> | null } = { code: null, stop: null };
  let stepEnded = (): void => {};
  const ended = new Promise<void>((r) => { stepEnded = r; });
  process.once("SIGTERM", () => {
    ran.stop = (async () => {
      const left = await stopWrites("the job is stopping", WRITE_SETTLE_MS, ended);
      if (left) console.log(`${left} GitHub writes still running at the stop; their outcome is unknown`);
      if (ran.code === null) {
        await saveUsage();
        console.log("stopped");
      }
      process.on("SIGTERM", () => {});
      try { process.kill(-process.pid, "SIGTERM"); } catch { /* not a group leader (a command-line run) */ }
      process.exit(ran.code ?? 143);
    })();
  });
  const code = await runJob(db, id, row, { runs, saveUsage, fail, itemsBefore, actedBefore });
  ran.code = code;
  stepEnded();
  // Stopping: the handler exits once the writes in flight are recorded.
  if (ran.stop) await ran.stop;
  return code;
}

/** Runs the job's step in this process; returns the exit code. */
async function runJob(db: Db, id: number, row: JobRow, o: { runs: Set<string>; saveUsage: () => Promise<void>; fail: (msg: string) => Promise<number>; itemsBefore: number; actedBefore: number }): Promise<number> {
  const { runs, saveUsage, fail, itemsBefore, actedBefore } = o;
  const startedAt = row.started_at!;
  const step = (await loadSteps()).get(row.step);
  if (!step) return await fail(`no step ${row.step} in this build`);
  console.log(`${new Date().toISOString()} job ${id}: ${step.name} ${row.params}, requested by ${row.requested_by}`);
  let params;
  try {
    params = validateParams(step, JSON.parse(row.params), await trackedNames(db));
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
      await db.run(db.k.updateTable("jobs").set({ progress: oneLine(text, 200) }).where("id", "=", id));
      console.log(text);
    },
    log: (line) => console.log(line),
    usageRun: (r) => void runs.add(r),
    // Counts of a resumed job add to its earlier runs', so the daily limits see all of them.
    handled: async (n) => void await db.run(db.k.updateTable("jobs").set({ items: itemsBefore + n }).where("id", "=", id)),
    acted: async (n) => void await db.run(db.k.updateTable("jobs").set({ acted: actedBefore + n }).where("id", "=", id)),
    cancelled: async () => {
      const r = (await db.get(db.k.selectFrom("jobs").select(["cancel_requested_at", "error"]).where("id", "=", id)))!;
      return !!r.cancel_requested_at || DEADLINE_ERROR.test(r.error ?? "");
    },
    stopping: async () => await ctx.cancelled() || (row.requested_by === AUTOPILOT_USER && !await isEnabled(db)),
    // Read from the row on each call: started_at is the runner's claim time, the start its deadline counts from.
    timeUp: async () => {
      if (sliceMs === null) return false;
      const r = await db.get(db.k.selectFrom("jobs").select("started_at").where("id", "=", id));
      return Date.now() - Date.parse(r?.started_at ?? startedAt) >= sliceMs;
    },
  };
  setCallContext({ jobId: id, step: step.name, stage: step.stage, class: step.priority ?? 0, ...(typeof params.repo === "string" && { repo: params.repo }), cancelled: ctx.cancelled,
    // Model calls (local and remote) are withdrawn when the pipeline is switched off, not during a drain: running jobs finish with their calls.
    stopping: async () => await ctx.cancelled() || (row.requested_by === AUTOPILOT_USER && !await isEnabled(db) && !await isDraining(db)) });
  try {
    // One reading of the settings table serves the step's reads; the keys it polls to stop or throttle stay live.
    const summary = await withSettingsSnapshot(db, () => step.run(ctx), undefined, { live: LIVE_SETTINGS, watchWrites: true });
    await saveUsage();
    // Items skipped for a lease are work left for a later job: the planner retries once no job holds a lease (unchangedSinceIdle).
    if (leaseSkips()) await db.run(db.k.updateTable("jobs").set({ lease_skips: leaseSkips(), lease_skip_keys: JSON.stringify(leaseSkipKeys()) }).where("id", "=", id));
    await db.run(db.k.updateTable("jobs").set({ summary: oneLine(summary) }).where("id", "=", id));
    console.log(`${new Date().toISOString()} done: ${summary}`);
    return 0;
  } catch (e) {
    if (e instanceof StoppedError || e instanceof NoTakerError) {
      await saveUsage();
      if (leaseSkips()) await db.run(db.k.updateTable("jobs").set({ lease_skips: leaseSkips(), lease_skip_keys: JSON.stringify(leaseSkipKeys()) }).where("id", "=", id));
      const summary = e instanceof NoTakerError ? `skipped: ${e.message}` : "stopped: the pipeline was switched off";
      await db.run(db.k.updateTable("jobs").set({ summary }).where("id", "=", id));
      console.log(`${new Date().toISOString()} done: ${summary}`);
      return 0;
    }
    console.error((e as Error).stack ?? e);
    return await fail((e as Error).message ?? String(e));
  }
}
