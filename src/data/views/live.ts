// The live board: running, queued and lately ended jobs, calls and build tasks without a job, open integration batches and, for staff,
// the worker rows, in two waves of loaders. The lanes are assembled by the handler.
import type { Db } from "../../db/index.ts";
import type { HiddenRepos } from "../control/types.ts";
import { loadOpenTaskDurations, loadStandaloneTasks, loadTaskCards } from "../build/tasks-views.ts";
import type { TaskCard } from "../build/types.ts";
import { loadCallDurations, loadJobRuns, loadLooseRuns, loadWorkerRuns } from "../inference/views.ts";
import type { JobCall, RunRow } from "../inference/types.ts";
import { loadLiveBoard, loadStepDurations } from "../jobs/views.ts";
import type { LiveBoard } from "../jobs/types.ts";
import { listActiveBatches } from "../merge/batches.ts";
import type { BatchView } from "../merge/types.ts";
import { loadShown } from "../mirror/items.ts";
import type { ItemShown } from "../mirror/types.ts";
import { loadRunnerBoard } from "../runners/views.ts";
import type { RunnerRow } from "../runners/types.ts";
import type { LiveOptions } from "./types.ts";

export type LiveView = {
  board: LiveBoard;
  looseRuns: RunRow[];
  batches: BatchView[];
  /** Queued, claimed and running build tasks without a job. */
  standalone: TaskCard[];
  stepDurations: Map<string, number[]>;
  workerRuns: RunRow[] | null;
  runnerBoard: { leases: Map<number, number>; helpers: RunnerRow[]; private: Set<string> } | null;
  jobRuns: Map<number, JobCall[]>;
  jobTasks: Map<number, TaskCard[]>;
  /** The combined-tree tasks of the open batches, by task id. */
  batchTasks: Map<number, TaskCard>;
  /** Earlier done calls by `step:model`, of the calls running now. */
  callDurations: Map<string, { startedAt: string; endedAt: string }[]>;
  /** Earlier done tasks' durations in ms by `repo|step`, of the tasks not ended. */
  taskDurations: Map<string, number[]>;
  shown: Map<string, ItemShown>;
};

/** Earlier runs an estimate is read from. */
export const LIVE_SAMPLES = 60;

/**
 * Wave 1: the job board, runs without a job, open batches, standalone tasks, and, for staff, the worker runs and runner board.
 * Wave 2: calls and tasks of the board's jobs and of the batches, the durations of the running jobs' steps, the earlier durations
 * behind the estimates of the calls and tasks that run now, and the shown fields of every first item.
 */
export async function loadLiveView(db: Db, scope: { hidden: HiddenRepos; staff: boolean }, o: LiveOptions): Promise<LiveView> {
  const vis = { hidden: scope.hidden, staff: scope.staff };
  const taskScope = { hiddenRepos: scope.hidden, staff: scope.staff };
  const since = new Date(o.nowMs - o.workerWindowMs).toISOString();
  const [board, looseRuns, batches, standalone, workerRuns, runnerBoard] = await db.together(() => Promise.all([
    loadLiveBoard(db, { quietSteps: o.quietSteps, recentMs: o.recentMs, queuedMax: o.queuedMax, recentMax: o.recentMax, hidden: scope.hidden }),
    loadLooseRuns(db, vis),
    listActiveBatches(db, { hidden: scope.hidden }),
    loadStandaloneTasks(db, { states: ["queued", "claimed", "running"] }, taskScope),
    scope.staff ? loadWorkerRuns(db, vis, since, o.workerCallsMax) : null,
    scope.staff ? loadRunnerBoard(db, o.nowMs, o.workerWindowMs) : null,
  ]));
  const jobIds = [...board.running, ...board.queued, ...board.recent].map((j) => j.id);
  const taskIds = batches.flatMap((b) => (b.task_id === null ? [] : [b.task_id]));
  const refs = [
    ...[...board.items.values()].flatMap((l) => (l[0] ? [{ repo: l[0].repo, number: l[0].number }] : [])),
    ...looseRuns.flatMap((r) => (r.firstRepo !== null && r.firstNumber !== null ? [{ repo: r.firstRepo, number: r.firstNumber }] : [])),
    ...(workerRuns ?? []).flatMap((r) => (r.firstRepo !== null && r.firstNumber !== null ? [{ repo: r.firstRepo, number: r.firstNumber }] : [])),
    ...batches.flatMap((b) => (b.members[0] ? [{ repo: b.repo, number: b.members[0].number }] : [])),
    ...standalone.flatMap((t) => (t.number === null ? [] : [{ repo: t.repo, number: t.number }])),
  ];
  const [jobRuns, jobTasks, batchCards, stepDurations, callDurations, taskDurations, shown] = await db.together(() => Promise.all([
    loadJobRuns(db, jobIds, vis),
    loadTaskCards(db, jobIds, taskScope),
    loadStandaloneTasks(db, { ids: taskIds }, taskScope),
    loadStepDurations(db, [...new Set(board.running.map((j) => j.step))]),
    loadCallDurations(db, "running", LIVE_SAMPLES),
    loadOpenTaskDurations(db, LIVE_SAMPLES),
    loadShown(db, refs),
  ]));
  const batchTasks = new Map(batchCards.map((t) => [t.id, t]));
  return { board, looseRuns, batches, standalone, stepDurations, workerRuns, runnerBoard, jobRuns, jobTasks, batchTasks, callDurations, taskDurations, shown };
}
