// The Live board on Home: every running and queued unit of the pipeline's work (jobs, model calls and build tasks of their own, open
// integration batches) on one time axis, with the model calls and build steps inside it and how long the same work took before. Jobs that
// ended in the last minutes stay on it, faded. Repos the reader cannot see are left out. Staff also get the worker view: one row per
// Task Runner (a person's own tokens; private ones share one neutral row) and Jev, with the model calls each ran in the last hour.
import type { ItemRef, ItemShown, LiveBoard, LiveEstimate, LiveLane, LiveOp, LiveOpKind, LiveWorker } from "../../../web/src/api/types.ts";
import { STATUS_FRESH_MS } from "../../data/runners/index.ts";
import type { HiddenRepos } from "../../data/control/index.ts";
import type { JobCall, RunRow } from "../../data/inference/index.ts";
import type { TaskCard } from "../../data/build/index.ts";
import type { RunnerRow } from "../../data/runners/index.ts";
import { loadLiveView, type LiveView } from "../../data/views/live.ts";
import type { Req } from "../types.ts";
import { canSeeInternals } from "./staff.ts";
import { stepTitle } from "./trace.ts";
import { blankIfHidden, hiddenRepos } from "./visible.ts";
import type { Db } from "../../db/index.ts";

/** Jobs that never work on items; they show only in the "Also running" line. */
const QUIET_STEPS = new Set(["rank", "embed", "checks", "main-ci", "labels-ensure", "review-carry", "verify-collect", "fixissue-collect"]);

/** Ended jobs stay on the board this long. */
const RECENT_MS = 20 * 60_000;
const RECENT_MAX = 8;
const QUEUED_MAX = 6;
/** Fewer earlier runs than this give no estimate. */
const MIN_SAMPLES = 3;

/** Median and 90th percentile of durations in ms; null with too few. */
function estimateOf(ms: number[]): LiveEstimate | null {
  const xs = ms.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (xs.length < MIN_SAMPLES) return null;
  const at = (q: number) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))]!;
  return { median: at(0.5), p90: at(0.9), samples: xs.length };
}

/** A build step's kind from its name, as the timeline colours it. */
export function buildKind(name: string): LiveOpKind {
  const n = name.toLowerCase();
  if (/test|spec|jest|vitest|pytest/.test(n)) return "tests";
  if (/lint|clippy|eslint|fmt|format|check|typecheck|tsc/.test(n)) return "lint";
  if (/build|compile|bundle|package|make/.test(n)) return "build";
  if (/install|setup|fetch|checkout|clone|deps|restore|cache|prepare|\bci\b/.test(n)) return "setup";
  return "other";
}

const iso = (ms: number) => new Date(ms).toISOString();
const NONE_SHOWN: ItemShown = { kind: null, state: null, title: null };

export async function live(db: Db, req: Req): Promise<LiveBoard> {
  const hidden = await hiddenRepos(db, req);
  const staff = canSeeInternals(req);
  const nowMs = Date.now();
  // Housekeeping steps show only when they fail; left out before any limit, so they never take a slot.
  const quiet = [...QUIET_STEPS];
  const v = await loadLiveView(db, { hidden, staff }, { nowMs, quietSteps: quiet, recentMs: RECENT_MS, recentMax: RECENT_MAX, queuedMax: QUEUED_MAX, workerWindowMs: WORKER_WINDOW_MS, workerCallsMax: WORKER_CALLS_MAX });
  const item = (repo: string, number: number): ItemRef & ItemShown => ({ repo, number, ...(v.shown.get(`${repo}#${number}`) ?? NONE_SHOWN) });

  // Estimates, read once per key.
  const jobEstimate = (step: string) => estimateOf(v.stepDurations.get(step) ?? []);
  const callEstimate = (step: string, model: string) => estimateOf((v.callDurations.get(`${step}:${model}`) ?? []).map((d) => Date.parse(d.endedAt) - Date.parse(d.startedAt)));
  const taskEstimate = (repo: string, step: string) => estimateOf(v.taskDurations.get(`${repo}|${step}`) ?? []);

  // The owner of a Private Task Runner is named nowhere on the board, except to themselves.
  const ownerShown = (c: JobCall): boolean => c.provider !== "jev" && req.user.role === "operator" && !!c.userLogin && v.runnerBoard !== null && !privateTo(req, v.runnerBoard.private)(c.userLogin);
  const callOp = (c: JobCall): LiveOp => ({
    kind: "model", label: c.provider === "jev" ? "Jev" : c.model, detail: ownerShown(c) ? `${stepTitle(c.step)} on ${c.userLogin}` : stepTitle(c.step),
    start: c.startedAt, end: c.endedAt, estimate: c.state === "running" ? callEstimate(c.step, c.model) : null, ...(c.state === "failed" ? { failed: true } : {}),
  });
  /** A finished task as one op per step (from its recorded durations); a running one as one op named by the step its log is on. */
  const taskOps = (t: TaskCard): LiveOp[] => {
    if (!t.startedAt) return [];
    const start = Date.parse(t.startedAt);
    if (t.endedAt) {
      const results = t.results;
      if (!results.length) return [{ kind: "build", label: "Build task", detail: stepTitle(t.step), start: t.startedAt, end: t.endedAt, estimate: null, ...(t.state !== "done" ? { failed: true } : {}) }];
      let at = start;
      return results.map((r) => {
        const op: LiveOp = { kind: buildKind(r.step), label: r.step, detail: stepTitle(t.step), start: iso(at), end: iso(at + r.durationMs), estimate: null, ...(r.exitCode !== 0 ? { failed: true } : {}) };
        at += r.durationMs;
        return op;
      });
    }
    return [{ kind: t.logStep ? buildKind(t.logStep) : "build", label: t.logStep ?? "Build task", detail: stepTitle(t.step), start: t.startedAt, end: null, estimate: taskEstimate(t.repo, t.step) }];
  };

  // Jobs: running, then queued (the next few), then the ones that ended lately.
  const lanes: LiveLane[] = [];
  let recent = 0;
  for (const j of [...v.board.running, ...v.board.queued, ...v.board.recent]) {
    const ended = j.state === "done" || j.state === "failed";
    const its = v.board.items.get(j.id) ?? [];
    if (ended && its.length === 0 && j.state !== "failed") continue;
    if (ended && ++recent > RECENT_MAX) continue;
    const calls = v.jobRuns.get(j.id) ?? [];
    const tasks = v.jobTasks.get(j.id) ?? [];
    const line = j.state === "running" ? blankIfHidden(j.progress, hidden) : j.state === "failed" ? (staff && j.error ? blankIfHidden(j.error, hidden) : "Failed") : j.state === "done" ? blankIfHidden(j.summary, hidden) : null;
    lanes.push({
      key: `job:${j.id}`, title: stepTitle(j.step), state: j.state === "running" ? "running" : j.state === "queued" ? "queued" : j.state === "failed" ? "failed" : "done",
      start: j.started_at ?? j.requested_at, end: j.ended_at, line: line || null,
      item: its[0] ? item(its[0].repo, its[0].number) : null, itemCount: its.length, repo: j.repo, detail: `/pipeline/${j.id}`,
      estimate: j.state === "running" ? jobEstimate(j.step) : null,
      ops: [...calls.map(callOp), ...tasks.flatMap(taskOps)].sort((a, b) => a.start.localeCompare(b.start)),
    });
  }

  // Calls and build tasks that run without a job.
  for (const c of v.looseRuns) {
    const op = callOp(c);
    lanes.push({
      key: `run:${c.id}`, title: stepTitle(c.step), state: "running", start: c.startedAt, end: null, line: blankIfHidden(c.progress, hidden) || null,
      item: c.firstRepo !== null && c.firstNumber !== null ? item(c.firstRepo, c.firstNumber) : null, itemCount: c.itemCount > 0 ? 1 : 0, repo: c.firstRepo, detail: `/agents/${c.id}`, estimate: op.estimate, ops: [op],
    });
  }
  // Open integration batches, with the build task of their combined tree; that task gets no lane of its own.
  const batchTasks = new Set(v.batches.map((b) => b.task_id).filter((id): id is number => id !== null));
  for (const b of v.batches) {
    const task = b.task_id === null ? undefined : v.batchTasks.get(b.task_id);
    const first = b.members[0];
    lanes.push({
      key: `batch:${b.id}`, title: "Integration batch", state: "running", start: b.created_at, end: null,
      line: blankIfHidden(b.summary, hidden) || (b.state === "checking" ? "Checking the combined tree" : b.pr_number !== null ? `Batch pull request #${b.pr_number} is open` : null),
      item: first ? item(b.repo, first.number) : null, itemCount: b.members.length, repo: b.repo, detail: `/batches/${b.id}`, estimate: null, ops: task ? taskOps(task) : [],
    });
  }
  for (const t of v.standalone) {
    if (batchTasks.has(t.id)) continue;
    const ops = taskOps(t);
    lanes.push({
      key: `task:${t.id}`, title: `Build task, ${stepTitle(t.step)}`, state: t.state === "queued" ? "queued" : "running", start: t.startedAt ?? t.queuedAt, end: null, line: t.summary,
      item: t.number === null ? null : item(t.repo, t.number), itemCount: t.number === null ? 0 : 1, repo: t.repo, detail: `/envs/${t.id}`, estimate: ops[0]?.estimate ?? null, ops,
    });
  }
  if (!staff) return { lanes };
  return { lanes, workers: workersOf(req, v, hidden, nowMs, callEstimate) };
}

/** The worker view shows the calls that ran in this last stretch. */
export const WORKER_WINDOW_MS = 60 * 60_000;
/** At most this many calls go on the worker view, the newest. */
const WORKER_CALLS_MAX = 400;
/** The row that holds the calls of every runner its owner keeps private. */
export const PRIVATE_RUNNER = "Private Task Runner";

/** Whether the reader must not learn who owns a runner: its owner keeps it private, and is someone else. */
const privateTo = (req: Req, owners: ReadonlySet<string>) => (login: string): boolean => owners.has(login.toLowerCase()) && login.toLowerCase() !== req.user.login.toLowerCase();

/** A runner's label as the board may show it: never the machine's hostname, which a label defaults to (device-login.ts). */
function shownLabel(label: string | null, machine: { hostname?: string } | null): string | null {
  if (!label) return null;
  const host = String(machine?.hostname ?? "");
  const l = label.trim().toLowerCase();
  const h = host.trim().toLowerCase();
  return h && (l === h.slice(0, 60) || l === h.split(".")[0]) ? null : label;
}

/** The distinct models a runner's status offers (tier to model). */
function modelsOf(models: RunnerRow["models"]): string[] {
  return [...new Set(Object.values(models ?? {}).filter((m): m is string => typeof m === "string" && m !== ""))];
}

/**
 * One row per worker: each shared Task Runner with a fresh status or a call in the window (its owner's login, label, slots and models),
 * one "Private Task Runner" row for the calls of runners whose owners keep them private (runner-private.ts; the reader's own runners
 * are always theirs) and Jev when it ran.
 * Rows keep a fixed order (runners by owner and id, the private row, then Jev), so a row does not move when its work starts
 * or ends. Calls on repos hidden from the reader are left out. No row carries a machine's hostname.
 */
function workersOf(req: Req, v: LiveView, hidden: HiddenRepos, nowMs: number, callEstimate: (step: string, model: string) => LiveEstimate | null): LiveWorker[] {
  const runs = v.workerRuns ?? [];
  const board = v.runnerBoard!;
  // The runner credential that leased each remote call (only the lease's run is linked; an older lease falls back to its owner).
  const leases = board.leases;
  const helpers = board.helpers;
  const isPrivate = privateTo(req, board.private);
  const ownerOf = new Map(helpers.map((h) => [h.tokenId, h.login]));

  const workerOfRun = (r: RunRow): string | null => {
    if (r.provider === "jev") return "jev";
    if (r.userLogin) {
      const token = leases.get(r.id);
      return isPrivate(token !== undefined ? ownerOf.get(token) ?? r.userLogin : r.userLogin) ? "private"
        : token !== undefined ? `runner:${token}` : `login:${r.userLogin.toLowerCase()}`;
    }
    return null;
  };
  const keyOf = new Map(runs.map((r) => [r.id, workerOfRun(r)]));

  const rows = new Map<string, LiveWorker>();
  for (const h of helpers) {
    if (isPrivate(h.login)) continue;
    const fresh = h.reportedAt !== null && nowMs - h.reportedAt <= STATUS_FRESH_MS;
    rows.set(`runner:${h.tokenId}`, {
      key: `runner:${h.tokenId}`, kind: "runner", name: shownLabel(h.label, h.machine) ?? "Task Runner", login: h.login, harness: h.harness,
      status: !fresh ? "offline" : h.readiness === "ready" ? "online" : "held", note: fresh && h.readiness !== "ready" ? blankIfHidden(h.reason, hidden) || h.readiness : null,
      busy: 0, slots: fresh && h.slots !== null ? h.slots : null, models: fresh ? modelsOf(h.models) : [], calls: [],
    });
  }
  for (const r of runs) {
    const key = keyOf.get(r.id);
    if (!r.userLogin || !key?.startsWith("login:") || rows.has(key)) continue;
    rows.set(key, { key, kind: "runner", name: "Task Runner", login: r.userLogin, harness: null, status: "offline", note: null, busy: 0, slots: null, models: [], calls: [] });
  }
  if ([...keyOf.values()].includes("private")) {
    rows.set("private", { key: "private", kind: "private", name: PRIVATE_RUNNER, login: null, harness: null, status: "offline", note: null, busy: 0, slots: null, models: [], calls: [] });
  }
  if (runs.some((r) => r.provider === "jev")) rows.set("jev", { key: "jev", kind: "jev", name: "Jev", login: null, harness: null, status: "online", note: null, busy: 0, slots: null, models: [], calls: [] });

  for (const r of runs) {
    const key = keyOf.get(r.id);
    const row = key ? rows.get(key) : undefined;
    if (!row) continue;
    const running = r.state === "running";
    if (running) row.busy++;
    const t = r.tokens;
    const recorded = t.input !== null || t.output !== null;
    const ref = r.firstRepo !== null && r.firstNumber !== null ? { repo: r.firstRepo, number: r.firstNumber } : null;
    row.calls.push({
      id: r.id, step: r.step, title: stepTitle(r.step), model: r.provider === "jev" ? "Jev" : r.model,
      item: ref ? { ...ref, ...(v.shown.get(`${ref.repo}#${ref.number}`) ?? NONE_SHOWN) } : null, itemCount: r.itemCount,
      start: r.startedAt, end: r.endedAt,
      tokens: recorded ? (t.input ?? 0) + (t.output ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0) : null,
      estimate: running ? callEstimate(r.step, r.model) : null, ...(r.state === "failed" ? { failed: true } : {}),
    });
  }
  const priv = rows.get("private");
  if (priv) priv.status = priv.busy > 0 ? "online" : "offline";
  return [...rows.values()];
}
