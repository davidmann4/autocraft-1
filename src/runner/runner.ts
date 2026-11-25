// `autocraft-server runner serve`: the only process that runs pipeline steps. It
// polls the jobs table, runs each job in its own child process (`autocraft
// runner exec <id>`, its own process group, output to a per-job log file),
// stops jobs whose cancel was requested, runs the autopilot (queues jobs while the
// pipeline switch is on) and puts jobs that a stop or an earlier runner left
// unfinished back in the queue to resume (src/runner/resuming.ts).
import { advanceWorkflows } from "../workflow/advance.ts";
import { copyLogs, JobLogCopy, pruneJobLogs } from "./job-log.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, statSync, closeSync, mkdirSync, openSync, readFileSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dbEnv, dbLockName, dbTarget } from "../db/open.ts";
import { advancePreapprovals, preapprovalInputs } from "../preapproval/index.ts";
import { applyProposals, AUTOPILOT_USER, isDraining, isEnabled, planDue, type Detected } from "./autopilot.ts";
import { recordUsageSamples } from "../agents/accounts.ts";
import { AccountWatcher } from "../agents/manage.ts";
import { failRunning, pruneRuns } from "../agents/runs.ts";
import { pruneJevUnsure } from "../agents/step.ts";
import { pruneTasks, reapLost } from "../build/tasks.ts";
import { pruneBench } from "../nightly/index.ts";
import { prunePlanHistory } from "../core/plan-cache.ts";
import { commandWorkExpr, drainCommands, pruneCommands } from "../github/commands.ts";
import { checkPendingUpdate } from "../build/worker-update.ts";
import { endJob, JOB_KEEP_MS, now, pruneJobs, resumeJob, RUNNER_STOPPED } from "./jobs.ts";
import { advanceSecurityFixes, autoFixConfirmed } from "../security/actions.ts";
import { advanceScanTests } from "../security/scantest.ts";
import { OffThread } from "./offthread.ts";
import { groupsFile, killGroups, removeGroupsFile } from "./groups.ts";
import { buildDiffFacts } from "../review/diff.ts";
import { loadSteps, modelsOf, usesClaude, type Params } from "./steps.ts";
import { jobBlock } from "./concurrency.ts";
import { queueRoomPass } from "../agents/call.ts";
import { TRY_STEP } from "../build/workspace-session.ts";
import { pruneWorkspaceImages } from "../build/workspace-relay.ts";
import { noTakerFor } from "../remote/takers.ts";
import { JOB_DEADLINE_ENV, stepDeadlineMin, stepNoProgressMin } from "./deadlines.ts";
import { envVar } from "../env.ts";
import { anyRepinDue } from "../repin/due.ts";
import { jobRemoteQueue, REMOTE_WAIT_CAP_MS, withdrawJobCalls } from "../remote/calls.ts";
import { exclusive } from "../async-seq.ts";
import { refreshReadIdentity } from "../github/read.ts";
import type { Db } from "../db/index.ts";
import { excluded, jsonNum } from "../db/kx.ts";

export const logsDir = (): string => envVar("RUNNER_LOGS") ?? join(homedir(), ".cache/autocraft-logs/jobs");

export function runnerLockPath(): string {
  const dir = envVar("LOCK_DIR") ?? join(homedir(), ".cache/autocraft-logs");
  return join(dir, `runner-${dbLockName()}.lock`);
}

export const HEARTBEAT_KEY = "runner_heartbeat";
/** How often the runner brings the flowchart summary up to date (src/flow/summary.ts). */
export const FLOW_EVERY_MS = 20_000;
/** How often queued webhook items are read again from GitHub. */
export const WEBHOOK_DRAIN_MS = 5_000;
/** How often the runner checks for a repo due for its daily reconcile. */
export const RECONCILE_CHECK_MS = 5 * 60_000;
const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));

/** Job processes at once. A job that calls Claude also waits for a free account slot (see startJobs). */
export const DEFAULT_MAX_JOBS = 32;

export type RunnerOptions = {
  db: Db;
  /** Database the children and worker threads open (a SQLite path or a postgres:// URL); default `dbTarget()`. */
  dbTarget?: string;
  logs?: string;
  /** Most job processes running at once. */
  maxJobs?: number;
  /** Time a job gets to stop after SIGTERM before SIGKILL. */
  killAfterMs?: number;
  lockFile?: string;
  log?: (line: string) => void;
  /** The planner's detection pass (default: a worker thread on its own connection to `dbTarget`). Tests pass a fake. */
  detect?: (nowMs: number) => Promise<Detected>;
  /** The flowchart summary refresh (default: a worker thread). */
  refreshFlow?: () => Promise<unknown>;
  /** Longest run of a job of a step in minutes, given the job's `limit` param (default: stepDeadlineMin). Tests pass a short one. */
  maxMin?: (step: string, items?: number) => number;
  /** Minutes a job may show no progress, by step (default: stepNoProgressMin). */
  noProgressMin?: (step: string) => number;
  /** How long past its deadline a job may finish its current item before the runner stops its process (default 10 minutes). */
  graceMs?: number;
};

type Running = { child: ChildProcess; termAt: number | null; exited: Promise<void>; startedAt: number; deadlineMin: number; logPath: string; logCopy: JobLogCopy; /** When the job was told to finish its current item and stop. */ flaggedAt: number | null; noProgressMin: number; /** Why it was told to stop. */ stopMsg: string | null; /** Time in which a user-local call of the job waited for a helper, summed over the checks that saw one waiting. */ remoteWaitMs: number; remoteSeen: { at: number; queued: boolean } | null };

/** The error of a job the runner stopped for running past its step's limit. */
export const deadlineError = (min: number): string => `stopped: ran past ${min} min`;
export const noProgressError = (min: number): string => `stopped: no progress for ${min} min`;

/** True when `pid` is alive and is the child of job `id`. */
function isJobProcess(pid: number, id: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").includes(`runner exec ${id}`);
  } catch {
    return false;
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
}

export class Runner {
  readonly db: Db;
  readonly running = new Map<number, Running>();
  /** Ended jobs whose end could not be recorded: every tick records them again, so their rows reach a final state. */
  private readonly unrecorded = new Map<number, { code: number | null; signal: NodeJS.Signals | null; spawnError: string | null }>();
  private stopping = false;
  private flowAt = 0;
  private webhookAt = 0;
  private webhooking: Promise<void> | null = null;
  /** The autorepin drain (src/repin), apart from the webhook pass so its git work never delays re-reads and comment commands. */
  private repinning: Promise<void> | null = null;
  private webhookClient: import("../mirror.ts").Client | null = null;
  private reconcileAt = 0;
  private reconciling: Promise<void> | null = null;
  private reconcileClient: import("../mirror.ts").Client | null = null;
  private planning: Promise<void> | null = null;
  private detected: Detected | null = null;
  /** What the last pre-approval pass read (preapprovalInputs) and the earliest time its answer changes with the clock alone. */
  private preapprovalMark: { sig: string; wakeAt: number } | null = null;
  private flowing: Promise<void> | null = null;
  private readonly planThread: OffThread;
  private readonly flowThread: OffThread;
  private readonly o: Required<Omit<RunnerOptions, "db" | "lockFile" | "detect" | "refreshFlow" | "maxMin" | "graceMs" | "noProgressMin">> & { lockFile: string | null };
  private readonly detect: (nowMs: number) => Promise<Detected>;
  private readonly refreshFlow: () => Promise<unknown>;
  private readonly maxMin: (step: string, items?: number) => number;
  private readonly graceMs: number;
  private readonly noProgressMin: (step: string) => number;

  constructor(opts: RunnerOptions) {
    this.db = opts.db;
    this.o = {
      dbTarget: opts.dbTarget ?? dbTarget(), logs: opts.logs ?? logsDir(), maxJobs: opts.maxJobs ?? DEFAULT_MAX_JOBS, killAfterMs: opts.killAfterMs ?? 10_000,
      lockFile: opts.lockFile ?? null, log: opts.log ?? ((l) => console.log(l)),
    };
    mkdirSync(this.o.logs, { recursive: true });
    this.planThread = new OffThread(this.o.dbTarget);
    this.flowThread = new OffThread(this.o.dbTarget);
    this.detect = opts.detect ?? ((t) => this.planThread.plan(t));
    this.maxMin = opts.maxMin ?? stepDeadlineMin;
    this.graceMs = opts.graceMs ?? 600_000;
    this.noProgressMin = opts.noProgressMin ?? stepNoProgressMin;
    this.refreshFlow = opts.refreshFlow ?? (() => this.flowThread.flow());
  }

  /**
   * Jobs left `running` belong to a runner that is gone: what is left of their processes is stopped and each job resumes
   * (resumeJob), or ends cancelled (a cancel was asked) or failed (it may not resume). The remote calls and agent runs of
   * resuming jobs stay; other calls of jobs, model-queue waits and work leases of the gone runner end.
   */
  async recover(): Promise<number> {
    const rows = await this.db.all(this.db.k.selectFrom("jobs").select(["id", "pid", "cancel_requested_at"]).where("state", "=", "running"));
    for (const r of rows) {
      if (this.running.has(r.id)) continue;
      if (r.pid && isJobProcess(r.pid, r.id)) {
        killGroup(r.pid, "SIGKILL");
        // A command-line run's process leads no group of its own.
        try { process.kill(r.pid, "SIGKILL"); } catch { /* gone with its group */ }
      }
      const cancelled = r.cancel_requested_at !== null;
      if (!cancelled && await resumeJob(this.db, r.id, "the runner restarted", "crash")) {
        this.o.log(`job ${r.id}: left running by an earlier runner, queued to resume`);
        continue;
      }
      await this.db.run(this.db.k.updateTable("jobs")
        .set((eb) => ({ state: cancelled ? "cancelled" : "failed", ended_at: now(), pid: null, error: cancelled ? eb.ref("error") : eb.fn.coalesce("error", eb.val(RUNNER_STOPPED)) }))
        .where("id", "=", r.id).where("state", "=", "running"));
      // Replies an earlier run of the job left unread are not kept (as in endJob).
      await this.db.run(this.db.k.updateTable("main.remote_calls").set({ reply: null }).where("job_id", "=", r.id).where("state", "=", "done").where("reply", "is not", null));
      this.o.log(`job ${r.id}: left running by an earlier runner, marked ${cancelled ? "cancelled" : "failed"}`);
    }
    // Model calls of a runner that is gone no longer hold an account slot.
    const orphans = await failRunning(this.db, "The runner stopped during this call.");
    if (orphans) this.o.log(`${orphans} agent runs left running by an earlier runner, marked failed`);
    await this.db.run(this.db.k.deleteFrom("model_waits"));
    await withdrawJobCalls(this.db, "The runner stopped during this call.");
    await this.db.run(this.db.k.deleteFrom("work_leases"));
    return rows.length;
  }

  /** One pass: heartbeat, cancels, autopilot, new jobs. */
  async tick(): Promise<void> {
    const t = now();
    await this.db.run(this.db.k.insertInto("settings").values({ key: HEARTBEAT_KEY, value: t }).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
    if (this.o.lockFile) {
      try {
        utimesSync(this.o.lockFile, new Date(), new Date());
      } catch {
        // removed under us; the next start notices
      }
    }
    await this.cancels();
    await this.recordEnds();
    if (this.stopping) return;
    try {
      await refreshReadIdentity(this.db);
    } catch (e) {
      this.o.log(`GitHub identity not refreshed: ${(e as Error).message}`);
    }
    try {
      const lost = await reapLost(this.db);
      if (lost) this.o.log(`${lost} build tasks lost their worker`);
    } catch (e) {
      this.o.log(`build tasks: ${(e as Error).message}`);
    }
    await this.webhookTick();
    this.reconcileTick();
    await this.usageTick();
    this.workerUpdateTick();
    await this.autopilot();
    await this.startJobs();
    if (!this.flowing && Date.now() - this.flowAt >= FLOW_EVERY_MS) {
      this.flowAt = Date.now();
      this.flowing = this.refreshFlow().then(() => undefined, (e) => this.o.log(`flowchart summary: ${(e as Error).message}`)).finally(() => (this.flowing = null));
    }
  }

  /** Reads the items GitHub App webhooks named again from GitHub, off the tick, while no sync run holds its lock. The poll covers any that fail. */
  private async webhookTick(): Promise<void> {
    if (this.webhooking || Date.now() - this.webhookAt < WEBHOOK_DRAIN_MS) return;
    this.webhookAt = Date.now();
    const commands = !!await this.db.get(this.db.k.selectFrom("main.github_commands").select((eb) => eb.lit(1).as("one")).where((eb) => commandWorkExpr(eb)).limit(1));
    // Autorepins whose pull request was merged or closed, or whose lockfile task ended (src/repin).
    const repins = !this.repinning && await anyRepinDue(this.db);
    if (!commands && !repins && !await this.db.get(this.db.k.selectFrom("main.sync_requests").select((eb) => eb.lit(1).as("one")).limit(1))) return;
    this.webhooking = (async () => {
      const { lockHeld, lockPath, fullLockPath, Client, SYNC_RESERVE } = await import("../mirror.ts");
      if (lockHeld(lockPath()) || lockHeld(fullLockPath())) return;
      const c = this.webhookClient = await this.seedRate(this.webhookClient ?? new Client(SYNC_RESERVE));
      const { drainSyncRequests } = await import("../github/webhooks.ts");
      const n = await drainSyncRequests(this.db, c, { limit: 10, log: this.o.log });
      if (n) this.o.log(`webhooks: read ${n} items again`);
      // Commands in comments (`@<app> merge queue`) after the re-reads, so the item is read at its current head.
      if (commands) {
        const k = await drainCommands(this.db, { querier: c, log: this.o.log });
        if (k) this.o.log(`webhooks: carried out ${k} commands from comments`);
      }
      // Started after the commands, so an autorepin set on a pull request that is already merged starts in this pass, and not
      // waited for: the next pass's re-reads and commands do not wait on its git work.
      if ((repins || commands) && !this.repinning) {
        this.repinning = (async () => {
          const { drainRepins } = await import("../repin/index.ts");
          const k = await drainRepins(this.db, { querier: c, log: this.o.log });
          if (k) this.o.log(`autorepin: ${k} ended`);
        })().catch((e) => this.o.log(`autorepin: ${(e as Error).message}`)).finally(() => (this.repinning = null));
      }
    })().catch((e) => this.o.log(`webhooks: ${(e as Error).message}`)).finally(() => (this.webhooking = null));
  }

  /**
   * Seeds a client the runner keeps for its life with the last sync's rate reading, so the reserve holds from its first read.
   * Below the reserve nothing is read until the limit resets; the sync's reading is newer than ours when it is the later one.
   */
  private async seedRate(c: import("../mirror.ts").Client): Promise<import("../mirror.ts").Client> {
    const get = async (k: string): Promise<string | undefined> => (await this.db.get(this.db.k.selectFrom("main.settings").select("value").where("key", "=", k)))?.value ?? undefined;
    const seen = Number(await get("sync_rate_remaining"));
    const reset = Date.parse(await get("sync_rate_reset_at") ?? "");
    if (Number.isFinite(seen) && Number.isFinite(reset) && reset > Date.now()) {
      c.remaining = c.remaining === null ? seen : Math.min(c.remaining, seen);
      c.resetAt = new Date(reset);
    } else if (c.resetAt && c.resetAt.getTime() <= Date.now()) {
      c.remaining = null;
      c.resetAt = null;
    }
    return c;
  }

  /**
   * The daily reconcile of one tracked repo (mirror.ts reconcileNext), off the tick, one at a time. Its reads give way to
   * the minute sync and a full re-sync: before each one it waits while either holds its lock, and it keeps the sync's reserve.
   * Sync is not pipeline work, so this runs with the pipeline off too.
   */
  private reconcileTick(): void {
    if (this.reconciling || Date.now() - this.reconcileAt < RECONCILE_CHECK_MS) return;
    this.reconcileAt = Date.now();
    this.reconciling = (async () => {
      const { lockHeld, lockPath, fullLockPath, lowPriority, reconcileNext, Client, SYNC_RESERVE } = await import("../mirror.ts");
      const c = this.reconcileClient = await this.seedRate(this.reconcileClient ?? new Client(SYNC_RESERVE));
      const busy = (): boolean => lockHeld(lockPath()) || lockHeld(fullLockPath());
      await reconcileNext(this.db, lowPriority(c, { busy, minRemaining: SYNC_RESERVE }), new Date(), this.o.log);
    })().catch((e) => this.o.log(`reconcile: ${(e as Error).message}`)).finally(() => (this.reconciling = null));
  }

  /**
   * The planner. Detection reads a lot and runs off the loop, at most one pass at a time; the
   * tick queues what it found, so a slow detection never delays the heartbeat or cancels.
   */
  private async autopilot(): Promise<void> {
    const found = this.detected;
    this.detected = null;
    if (found) {
      for (const l of found.logs) this.o.log(l);
      try {
        // Detection read the database a moment ago; the switch may have been turned off since.
        if (await isEnabled(this.db)) {
          await applyProposals(this.db, found.proposals, { log: this.o.log, wakeAt: found.wakeAt ?? null, ...(found.status ? { status: found.status } : {}) });
          // A private fix that a switch-off cancelled is queued again once the pipeline is on.
          const fixes = await autoFixConfirmed(this.db);
          if (fixes) this.o.log(`autopilot: started the private fix of ${fixes} confirmed security findings`);
        }
      } catch (e) {
        this.o.log(`autopilot: ${(e as Error).message}`);
      }
    }
    // A private fix waits for its build without a job; the next job starts when the build tasks end, for operator-started fixes with the pipeline off too.
    try {
      const next = await advanceSecurityFixes(this.db, isEnabled(this.db));
      if (next) this.o.log(`security: continued the private fix of ${next} findings after their builds`);
    } catch (e) { this.o.log(`security fixes: ${(e as Error).message}`); }
    // The build task of a scan test is read here (database only); a finding whose test ended can then start its automatic fix.
    try {
      for (const t of await advanceScanTests(this.db)) {
        this.o.log(`security: scan test of ${t.repo} finding ${t.number}: ${t.state}`);
        if (await isEnabled(this.db) && t.state !== "not-shown") await autoFixConfirmed(this.db, t.repo, t.number);
      }
    } catch (e) { this.o.log(`security scan tests: ${(e as Error).message}`); }
    // Pre-approved merges move on rows other steps wrote; they are read here, not on a timer of their own.
    try { await this.preapprovals(); } catch (e) { this.o.log(`preapprovals: ${(e as Error).message}`); }
    if (this.planning || !await planDue(this.db)) return;
    this.planning = this.detect(Date.now())
      .then((d) => { this.detected = d; }, (e) => this.o.log(`autopilot: detection failed: ${(e as Error).message}`))
      .finally(() => (this.planning = null));
  }

  /**
   * The pre-approval pass, when what it reads changed since the last one (read before it runs, so its own moves make the next tick run it
   * again) or a time it was told about has come, also one told after the pass ended (a permission read's answer). A pass that throws runs
   * again on the next tick.
   */
  private async preapprovals(): Promise<void> {
    const t = Date.now();
    const sig = await preapprovalInputs(this.db);
    const m = this.preapprovalMark;
    if (m && m.sig === sig && t < m.wakeAt) return;
    this.preapprovalMark = null;
    const next = { sig, wakeAt: Infinity };
    // The maintainer workflow's blockers and recommendations come first: a blocker stops its merge leg before the leg moves on.
    try { await advanceWorkflows(this.db, this.o.log); } catch (e) { this.o.log(`workflows: ${(e as Error).message}`); }
    await advancePreapprovals(this.db, this.o.log, {}, (at) => { if (at < next.wakeAt) next.wakeAt = at; });
    this.preapprovalMark = next;
  }

  private updateAt = 0;
  private updating = false;

  /** About once a minute, runs the sandbox worker update that a deploy left pending once its tasks have finished. */
  private workerUpdateTick(): void {
    if (this.updating || Date.now() - this.updateAt < 60_000) return;
    this.updateAt = Date.now();
    this.updating = true;
    checkPendingUpdate(this.db, undefined, this.o.log)
      .catch((e) => this.o.log(`worker update: ${(e as Error).message}`))
      .finally(() => (this.updating = false));
  }

  private usageAt = 0;
  private refreshAt = 0;
  private pruneAt = 0;
  private watcher: AccountWatcher | undefined;

  /** Records usage readings that changed (at most every 15 s), reads sign-in state (every 15 minutes) and plan usage (every 5) of accounts through the claude command, and prunes old agent data hourly. */
  private async usageTick(): Promise<void> {
    const t = Date.now();
    if (t - this.usageAt >= 15_000) {
      this.usageAt = t;
      try {
        await recordUsageSamples(this.db, t);
      } catch (e) {
        this.o.log(`usage samples: ${(e as Error).message}`);
      }
    }
    if (t - this.refreshAt >= 60_000) {
      this.refreshAt = t;
      void (this.watcher ??= new AccountWatcher(this.db, (m) => this.o.log(m))).tick(t);
    }
    if (t - this.pruneAt >= 3600_000) {
      this.pruneAt = t;
      try {
        await pruneJobs(this.db, t);
      } catch (e) {
        this.o.log(`prune jobs: ${(e as Error).message}`);
      }
      try {
        await pruneJobLogs(this.db, t);
      } catch (e) {
        this.o.log(`prune job logs: ${(e as Error).message}`);
      }
      try {
        await prunePlanHistory(this.db, JOB_KEEP_MS, t);
      } catch (e) {
        this.o.log(`prune plan history: ${(e as Error).message}`);
      }
      try {
        await pruneTasks(this.db, t);
      } catch (e) {
        this.o.log(`prune build tasks: ${(e as Error).message}`);
      }
      try {
        await pruneWorkspaceImages(this.db, t);
      } catch (e) {
        this.o.log(`prune workspace images: ${(e as Error).message}`);
      }
      try {
        await pruneBench(this.db, t);
      } catch (e) {
        this.o.log(`prune nightly bench: ${(e as Error).message}`);
      }
      try {
        await pruneRuns(this.db, t);
      } catch (e) {
        this.o.log(`prune agent runs: ${(e as Error).message}`);
      }
      try {
        await pruneJevUnsure(this.db, t);
      } catch (e) {
        this.o.log(`prune kept Jev answers: ${(e as Error).message}`);
      }
      try {
        await pruneCommands(this.db, t);
      } catch (e) {
        this.o.log(`prune github commands: ${(e as Error).message}`);
      }
    }
  }

  private async cancels(): Promise<void> {
    await this.checkRunning();
    // The new log lines of every running job, in one write (each job at most every JOB_LOG_FLUSH_MS).
    await copyLogs(this.db, [...this.running.values()].map((r) => r.logCopy)).catch((e: Error) => this.o.log(`job logs not stored: ${e.message}`));
  }

  private async checkRunning(): Promise<void> {
    for (const [id, r] of this.running) {
      const row = await this.db.get(this.db.k.selectFrom("jobs").select("cancel_requested_at").where("id", "=", id));
      // Time a user-local model call waits for a helper counts like waiting for an account slot: not toward the deadline, and not as a time without progress.
      const nowMs = Date.now();
      const remote = await jobRemoteQueue(this.db, id);
      if (r.remoteSeen?.queued) r.remoteWaitMs += nowMs - r.remoteSeen.at;
      r.remoteSeen = { at: nowMs, queued: remote.queued };
      // Up to REMOTE_WAIT_CAP_MS of it; past that a call nobody takes no longer holds the job and its item.
      const waiting = remote.queued && r.remoteWaitMs < REMOTE_WAIT_CAP_MS;
      const late = nowMs - r.startedAt - Math.min(r.remoteWaitMs, REMOTE_WAIT_CAP_MS) >= r.deadlineMin * 60_000;
      const cancel = !!row?.cancel_requested_at || this.stopping;
      // Progress is a new line in the job's log (the job's own output: progress lines, check-tool notes, results); reading its mtime costs one stat.
      let lastLine = Math.max(r.startedAt, waiting ? nowMs : remote.lastLeaseAt ?? 0);
      try { lastLine = Math.max(lastLine, statSync(r.logPath).mtimeMs); } catch { /* no log yet */ }
      const idle = r.flaggedAt === null && Date.now() - lastLine >= r.noProgressMin * 60_000;
      // Past its deadline a job is first asked to stop: the failure is recorded, which the job reads at its item boundaries (ctx.cancelled)
      // and finishes the writes of its current item. Only after the grace does the process get the signals a cancel gets.
      if ((late || idle) && !cancel && r.flaggedAt === null && r.termAt === null) {
        r.flaggedAt = Date.now();
        const msg = r.stopMsg = idle && !late ? noProgressError(r.noProgressMin) : deadlineError(r.deadlineMin);
        await this.db.run(this.db.k.updateTable("jobs").set({ error: msg }).where("id", "=", id).where("state", "=", "running"));
        try { appendFileSync(r.logPath, `${now()} ${msg}; the job may finish its current item, and is stopped ${Math.round(this.graceMs / 60_000)} min from now\n`); } catch { /* the log is gone */ }
        this.o.log(`job ${id}: ${msg}; finishing its current item`);
      }
      const graceOver = r.flaggedAt !== null && Date.now() - r.flaggedAt >= this.graceMs;
      if (!cancel && !graceOver) continue;
      const pid = r.child.pid;
      if (!pid) continue;
      if (r.termAt === null) {
        r.termAt = Date.now();
        const deadline = !cancel;
        if (deadline) {
          try { appendFileSync(r.logPath, `${now()} ${r.stopMsg ?? deadlineError(r.deadlineMin)}; the job did not finish in time and is stopped\n`); } catch { /* the log is gone */ }
        }
        // The job process alone: it lets its GitHub writes in flight finish, then stops its process group (src/runner/exec.ts).
        try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
        this.o.log(`job ${id}: stopping (${this.stopping ? "runner stopping" : deadline ? `${r.stopMsg} grace over` : "cancel requested"})`);
      } else if (Date.now() - r.termAt >= this.o.killAfterMs) {
        killGroup(pid, "SIGKILL");
      }
    }
  }

  /**
   * Starts queued jobs: security first (priority 2), then by id. A job whose step calls Claude starts only while the
   * model queue has room for its class and its repo (queueRoomPass; a job without a repo param spans repos and is asked about
   * none), so processes do not sit waiting for slots, unless no job of its step runs. Such a job with a repo starts only while
   * a Task Runner that may take its repo and its step's task is connected and ready (busy or not); a job no Task Runner may take
   * waits queued. The room is read once per pass, so a start takes one from every room counted so far, and a room first read
   * later in the pass starts with the pass's starts taken off: the Task Runners that serve one repo or task may serve others.
   */
  private async startJobs(): Promise<void> {
    const steps = await loadSteps();
    const queued = (await this.db.all(this.db.k.selectFrom("jobs").select(["id", "step", "params", "requested_by", "repo"]).where("state", "=", "queued").orderBy("id")))
      .sort((a, b) => (steps.get(b.step)?.priority ?? 0) - (steps.get(a.step)?.priority ?? 0) || a.id - b.id);
    if (!queued.length) return;
    // Automatic jobs wait while the pipeline is off; they are cancelled when it is switched off. While it drains, nothing new starts.
    const [on, draining] = await Promise.all([isEnabled(this.db), isDraining(this.db)]);
    // Room by class, then by the job's step and repo ("" for a job without one): a runner counts only for the tasks it takes.
    const room = new Map<number, Map<string, number>>();
    const pass = await queueRoomPass(this.db);
    let started = 0;
    for (const q of queued) {
      if (draining || (q.requested_by === AUTOPILOT_USER && !on)) continue;
      if (this.running.size >= this.o.maxJobs) return;
      const step = steps.get(q.step);
      if (!step) {
        await this.db.run(this.db.k.updateTable("jobs").set({ state: "failed", ended_at: now(), error: "This step does not exist in this build." }).where("id", "=", q.id).where("state", "=", "queued"));
        continue;
      }
      if (await this.blocked(steps, q.id)) continue;
      let claude = false;
      try { claude = usesClaude(modelsOf(step, JSON.parse(q.params) as Params)); } catch { /* params are checked when the job runs */ }
      const cls = step.priority ?? 0;
      let byRepo = room.get(cls);
      if (!byRepo) room.set(cls, (byRepo = new Map()));
      const key = `${q.step}\n${q.repo ?? ""}`;
      const roomOf = async (): Promise<number> => byRepo.get(key) ?? await pass.room(cls, q.repo ? [q.repo] : undefined, q.step) - started;
      if (claude && q.repo && !await pass.taker([q.repo], q.step)) {
        // A pipeline job waits for a Task Runner; a command-line session job (`workspace try`) is not replanned, so it fails.
        const why = q.step === TRY_STEP ? await noTakerFor(this.db, q.repo, q.step) : null;
        if (why) await this.db.run(this.db.k.updateTable("jobs").set({ state: "failed", ended_at: now(), error: why }).where("id", "=", q.id).where("state", "=", "queued"));
        continue;
      }
      if (claude && !await this.db.get(this.db.k.selectFrom("jobs").select((eb) => eb.lit(1).as("one")).where("step", "=", step.name).where("state", "=", "running").limit(1))) {
        // Nothing of the step runs: it starts anyway, and takes a slot of the room.
      } else if (claude) {
        byRepo.set(key, await roomOf());
        if (byRepo.get(key)! <= 0) continue;
      }
      if (await this.start(q.id, step.name, steps) && claude) {
        byRepo.set(key, await roomOf());
        started++;
        for (const m of room.values()) for (const [k, n] of m) m.set(k, n - 1);
      }
    }
  }

  /** Why the queued job cannot start: a running job (of this runner or a command-line run) of the same step and repo, a full step, or a held mutex. */
  private async blocked(steps: Awaited<ReturnType<typeof loadSteps>>, id: number): Promise<string | null> {
    const r = await this.db.get(this.db.k.selectFrom("jobs").select(["step", "repo", jsonNum(this.db, "params", "$.number").as("number")]).where("id", "=", id));
    return r ? await jobBlock(this.db, steps, r, { states: ["running"], mutex: true }) : "gone";
  }

  /** The job's `limit` param (its items), when it has one. */
  private async limitOf(id: number): Promise<number | undefined> {
    try {
      const p = JSON.parse((await this.db.get(this.db.k.selectFrom("jobs").select("params").where("id", "=", id)))!.params) as { limit?: unknown };
      return typeof p.limit === "number" ? p.limit : undefined;
    } catch { return undefined; }
  }

  private async start(id: number, stepName: string, steps: Awaited<ReturnType<typeof loadSteps>>): Promise<boolean> {
    const logPath = join(this.o.logs, `job-${id}.log`);
    // The check and the claim are one write transaction, so a command-line run cannot take the step in between.
    // Read before the claim: nothing may wait between the claim and the spawn.
    const logCopy = await JobLogCopy.open(this.db, id, logPath);
    const deadlineMin = this.maxMin(stepName, await this.limitOf(id));
    const claimed = await this.db.write(async () => await this.blocked(steps, id) ? 0
      : (await this.db.run(this.db.k.updateTable("jobs").set({ state: "running", started_at: now(), log_path: logPath }).where("id", "=", id).where("state", "=", "queued"))).changes);
    if (!claimed) return false;
    const groups = groupsFile(this.o.logs, id);
    removeGroupsFile(groups);
    const fd = openSync(logPath, "a");
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [CLI, "runner", "exec", String(id)], {
        detached: true,
        stdio: ["ignore", fd, fd],
        env: { ...dbEnv(this.o.dbTarget), AUTOCRAFT_JOB_GROUPS: groups, [JOB_DEADLINE_ENV]: String(deadlineMin) },
      });
    } finally {
      closeSync(fd);
    }
    // Registered before any await, so abandon() reaches every child that runs.
    let spawnError: string | null = null;
    child.on("error", (e) => (spawnError = e.message));
    const exited = new Promise<void>((resolve) => {
      child.on("close", (code, signal) => {
        removeGroupsFile(groups);
        void this.finish(id, code, signal, spawnError)
          .catch((e) => {
            this.unrecorded.set(id, { code, signal, spawnError });
            this.o.log(`job ${id}: end not recorded: ${(e as Error).message}`);
          })
          // After the end is recorded (or not): resumeJob and the deadline notes append to the file first.
          .then(() => copyLogs(this.db, [logCopy], true).catch((e: Error) => this.o.log(`job ${id}: log not stored: ${e.message}`)))
          .finally(() => {
            this.running.delete(id);
            resolve();
          });
      });
    });
    this.running.set(id, { child, termAt: null, exited, startedAt: Date.now(), deadlineMin, logPath, logCopy, flaggedAt: null, noProgressMin: this.noProgressMin(stepName), stopMsg: null, remoteWaitMs: 0, remoteSeen: null });
    await this.db.run(this.db.k.updateTable("jobs").set({ pid: child.pid ?? null }).where("id", "=", id));
    this.o.log(`job ${id}: started (pid ${child.pid})`);
    return true;
  }

  private async finish(id: number, code: number | null, signal: NodeJS.Signals | null, spawnError: string | null): Promise<void> {
    const r = await endJob(this.db, id, code, signal, spawnError, this.stopping);
    if (r) this.o.log(`job ${id}: ${r.state === "queued" ? "queued to resume after the restart" : r.state}${r.state === "failed" && r.error ? `: ${r.error}` : ""}`);
  }

  private async recordEnds(): Promise<void> {
    for (const [id, e] of [...this.unrecorded]) {
      try {
        await this.finish(id, e.code, e.signal, e.spawnError);
        this.unrecorded.delete(id);
      } catch (err) {
        this.o.log(`job ${id}: end still not recorded: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Fencing, after the leader lease was lost (src/db/leader.ts): starts nothing more and kills every job's process group at
   * once, writing nothing. The new leader's recover() resumes or fails the jobs, as after a crash.
   */
  abandon(): void {
    this.stopping = true;
    for (const r of this.running.values()) if (r.child.pid) killGroup(r.child.pid, "SIGKILL");
    // Model calls run in groups of their own; the jobs list theirs in their groups files.
    killGroups([...this.running.keys()].map((id) => groupsFile(this.o.logs, id)));
  }

  /** Resolves when every running job has ended. */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running.values()].map((r) => r.exited));
  }

  /** Stops every running job (SIGTERM, then SIGKILL after the grace time) and waits for them; each unfinished job is queued to resume (endJob). */
  async stop(): Promise<void> {
    this.stopping = true;
    const cancels = exclusive(() => this.cancels());
    const timer = setInterval(() => void cancels.skip().catch((e) => this.o.log(`cancels: ${(e as Error).message}`)), 500);
    await cancels.run();
    await this.idle();
    clearInterval(timer);
    await this.recordEnds();
    await Promise.all([this.planThread.close(), this.flowThread.close()]);
  }

  /** Polls until `signal` aborts, then stops running jobs. */
  async serve(signal: AbortSignal, pollMs = 2000): Promise<void> {
    await this.recover();
    try {
      const read = await buildDiffFacts(this.db);
      if (read) this.o.log(`diff facts: computed again for new rules: ${read.computed} heads from the diff cache, ${read.pending} wait for a re-read`);
    } catch (e) {
      this.o.log(`diff facts: ${(e as Error).message}`);
    }
    while (!signal.aborted) {
      try {
        await this.tick();
      } catch (e) {
        this.o.log(`runner: ${(e as Error).stack ?? e}`);
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, pollMs);
        signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
      });
    }
    await this.stop();
  }
}
