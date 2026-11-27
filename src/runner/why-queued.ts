// Why a queued job or model call about an item does not start, for the item page, the agent's get_item and `workflow status`.
// Each reason is read from the rule that holds the work back, so it cannot disagree with what happens. A job: the runner's start
// pass (runner.ts startJobs): the pipeline switch, the same work or mutex (concurrency.ts jobBlockOf), the taker rule
// (concurrency.ts untakenTest) and the Task Runners' room (src/remote/room.ts jobRoom). A call: the model queue's whyWaiting
// (src/remote/queue-view.ts), the line the Work queue shows. Work none of them holds gets no reason. What only the runner process
// knows is not read: its job ceiling counts its own processes against a capacity it reads itself, and a Claude job still preparing
// its call holds a slot only inside it, so a job that waits only for those shows no reason. One reading of the runners and the
// model queue serves every question.
import { freshConfig } from "../data/control/index.ts";
import { loadJobs, loadLiveJobs } from "../data/jobs/index.ts";
import type { LiveJob } from "../data/jobs/types.ts";
import { loadQueue } from "../data/runners/index.ts";
import { orderedOf } from "../remote/cands.ts";
import { queueViewIn } from "../remote/queue-view.ts";
import { jobRoom, roomStateOf } from "../remote/room.ts";
import { loginWaitIn, runnerWaitText, waitingOnIn } from "../remote/takers.ts";
import { loadView } from "../remote/view.ts";
import { stageOfStep } from "../stages/registry.ts";
import { t } from "../i18n/index.ts";
import type { Db } from "../db/index.ts";
import type { Tier } from "../remote/protocol.ts";
import { AUTOPILOT_USER, KEY_ENABLED } from "./autopilot.ts";
import { jobBlockOf, STEP_PARALLEL_KEY, untakenTest, wantOf, type Active, type JobBlock } from "./concurrency.ts";
import { jobCalls } from "./runner.ts";
import { knownStep, loadSteps, modelsOf, usesClaude, type Params, type StepDef } from "./steps.ts";

/** One queued job or model call about an item: `title` its stage (or step) as the item page names it, `since` when it was queued; `why` one short line, or null when no rule holds it back. */
export type QueuedWork = { kind: "job" | "call"; id: number; step: string; title: string; since: string; why: string | null; /** A call's tier. */ tier?: Tier };

type Ref = { repo: string; number: number };
const keyOf = (r: Ref): string => `${r.repo}#${r.number}`;
const titleOf = (step: string): string => knownStep(step)?.title ?? step;
const workTitle = (step: string): string => stageOfStep(step)?.title ?? titleOf(step);

/**
 * Per item (`repo#n`), its queued jobs (a job whose `number` is the item: a lane job or a run for one item) and the queued calls that
 * name it, oldest first. `shown`: the reader may see whose Task Runner work waits for (operators and maintainers).
 */
export async function queuedOfItems(db: Db, refs: readonly Ref[], o: { shown: boolean; nowMs?: number }): Promise<Map<string, QueuedWork[]>> {
  const nowMs = o.nowMs ?? Date.now();
  const out = new Map<string, QueuedWork[]>(refs.map((r) => [keyOf(r), []]));
  if (!refs.length) return out;
  const [live, v, snapshot, cfg] = await db.together(() => Promise.all([loadLiveJobs(db), loadView(db, nowMs), loadQueue(db, nowMs), freshConfig(db, [KEY_ENABLED, STEP_PARALLEL_KEY])]));
  const queue = queueViewIn(v, snapshot, o.shown, { about: new Set(out.keys()) });
  for (const c of queue.calls) {
    for (const r of c.refs) out.get(keyOf(r))?.push({ kind: "call", id: c.id, step: c.step, title: workTitle(c.step), since: new Date(nowMs - c.waitedMs).toISOString(), why: c.why.text, tier: c.tier });
  }
  const jobs = live.filter((j) => j.state === "queued" && j.repo !== null && j.number !== null && j.step !== "security-fix" && out.has(`${j.repo}#${j.number}`));
  if (jobs.length) {
    const reads: Reads = { live, v, snapshot, cfg, shown: o.shown };
    const [rows, why] = await Promise.all([loadJobs(db, jobs.map((j) => j.id)), jobWaits(db, reads, jobs)]);
    for (const j of jobs) out.get(`${j.repo}#${j.number}`)!.push({ kind: "job", id: j.id, step: j.step, title: workTitle(j.step), since: rows.get(j.id)?.requested_at ?? new Date(nowMs).toISOString(), why: why.get(j.id) ?? null });
  }
  for (const list of out.values()) list.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : a.id - b.id));
  return out;
}

type Reads = { live: readonly LiveJob[]; v: Awaited<ReturnType<typeof loadView>>; snapshot: Awaited<ReturnType<typeof loadQueue>>; cfg: Awaited<ReturnType<typeof freshConfig>>; shown: boolean };

/** Per queued job of `jobs`, why the runner's start pass passes it over now (startJobs, in its order); absent when nothing does. */
async function jobWaits(db: Db, x: Reads, jobs: readonly LiveJob[]): Promise<Map<number, string>> {
  const { cfg, v, shown } = x;
  const steps = await loadSteps();
  const running: Active[] = x.live.filter((j) => j.state === "running").map((j) => ({ id: j.id, step: j.step, state: j.state, repo: j.repo, number: j.number, params: j.params }));
  const untaken = await untakenTest(db, steps, v.now, v);
  let rooms: ReturnType<typeof jobRoom> | undefined;
  const out = new Map<number, string>();
  for (const q of jobs) {
    const why = await (async (): Promise<string | null> => {
      if (cfg.pipelineDraining) return t("The pipeline is draining: no new job starts");
      if (q.requested_by === AUTOPILOT_USER && !cfg.pipelineEnabled) return t("The pipeline is off");
      const step = steps.get(q.step);
      if (!step) return null;
      const block = await jobBlockOf(db, steps, { ...wantOf(q.step, q.params), repo: q.repo }, { states: ["running"], mutex: true, active: running, cap: cfg.stepParallel, untaken });
      if (block) return blockLine(block, q, shown);
      if (!claudeJob(step, q.params) || !q.repo) return null;
      const calls = jobCalls(q.step, q.repo, q.params);
      const none = await untaken({ step: q.step, repo: q.repo, params: q.params, ...(calls.refs && { refs: calls.refs }) });
      if (none) return none;
      // With no job of its step running, a job starts without room (startJobs).
      if (!running.some((j) => j.step === step.name)) return null;
      rooms ??= jobRoom(roomStateOf(v, orderedOf(x.snapshot, v.now)));
      if (rooms.room(step.priority ?? 0, calls) > 0) return null;
      const call = { prompt_id: "", repos: calls.repos ?? [], step: q.step, ...(calls.refs && { refs: calls.refs }) };
      const [off] = waitingOnIn(v, call);
      if (off) return runnerWaitText(off, shown);
      const renew = loginWaitIn(v, call);
      if (renew) return runnerWaitText({ login: renew.login, renewsAt: renew.at }, shown);
      return t("Every Task Runner that may take it is busy");
    })();
    if (why !== null) out.set(q.id, why);
  }
  return out;
}

function claudeJob(step: StepDef, params: string): boolean {
  try { return usesClaude(modelsOf(step, JSON.parse(params) as Params)); } catch { return false; }
}

function blockLine(b: JobBlock, q: LiveJob, shown: boolean): string {
  if (b.kind === "parallel") return b.repos === 1 ? t("{step} is running on 1 repo, the most at once", { step: titleOf(q.step) }) : t("{step} is running on {n} repos, the most at once", { step: titleOf(q.step), n: b.repos });
  if (b.kind === "mutex") return t("Waiting for {step}, which does not run at the same time", { step: titleOf(b.job.step) });
  if (b.job.repo === q.repo && b.job.number === q.number) return t("Waiting for another job on this item");
  return shown && b.job.repo ? t("Waiting for another {step} job on {repo}", { step: titleOf(q.step), repo: b.job.repo }) : t("Waiting for another {step} job", { step: titleOf(q.step) });
}
