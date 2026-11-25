// The Pipeline page over JSON. Everyone signed in reads steps, jobs, logs, the
// pipeline switch and the stage limits; only operators request or cancel jobs,
// flip the switch and change limits. The
// dashboard never runs a step: it writes job rows that the runner picks up.
import { mayRunRepo } from "../repo-access.ts";
import type { Job, JobState, PipelineOverview, PipelineStage, PipelineState, PipelineStep, StepParam } from "../../../web/src/api/types.ts";
import { enqueue, getJob, jobDetail, jobRow, JobError, JOB_STATES, listJobs, requestCancel, toJobs } from "../../runner/jobs.ts";
import { ackDeadline, LimitError, pipelineState as rawPipelineState, resetLimitCount, setEnabled, setLimit } from "../../runner/autopilot.ts";
import { HEARTBEAT_KEY } from "../../runner/runner.ts";
import { loadSteps, type StepDef } from "../../runner/steps.ts";
import { JUDGEMENT_MODELS, judgementModel, setJudgementModel } from "../../decide/judgement.ts";
import { audit } from "../audit.ts";
import { outsideState } from "../../outside.ts";
import { mayResumeTrip, resumeStage, TripError } from "../../push-outcomes.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { blankIfHidden, hiddenRepos, visibleRepos } from "./visible.ts";
import { cols, excluded } from "../../db/kx.ts";
import { filtered, hiddenTestExpr, isHiddenRepo, type HiddenRepos } from "../../hidden-sql.ts";
import { isQuiet } from "../../security/quiet.ts";
import { canSeeInternals } from "./staff.ts";
import { SECURITY_PREFIX, SECURITY_STEP } from "../../security/rules.ts";
import { mapSeq } from "../../async-seq.ts";
import type { Db } from "../../db/index.ts";
import { setting } from "../../settings-read.ts";
import { LARGE_FIX_KEY, OUTSIDE_PURPOSE_KEY, largeFixLines, outsidePurposeMin } from "../../workflow/settings.ts";

// Stages of docs/pipeline.md. A stage with registered steps shows them; the
// mirror also runs on its own timer.
const STAGES: { n: number; name: string; automatic?: boolean }[] = [
  { n: 1, name: "Mirror", automatic: true },
  { n: 2, name: "Classify" },
  { n: 3, name: "Decide" },
  { n: 4, name: "Label" },
  { n: 5, name: "Review" },
  { n: 6, name: "Integrate" },
  { n: 7, name: "Fix issues" },
];

const RUNNER_ALIVE_MS = 30_000;

function requireOperator(req: Req, step?: StepDef): void {
  if (req.user.role !== "operator" || (step && step.requires !== "operator")) throw new HttpError(403, "only operators run or cancel pipeline steps and change the pipeline switch and limits");
}

/** The pipeline state for the requester: reasons that name a hidden repo and trips on one are left out. */
async function pipelineState(db: Db, req: Req): Promise<PipelineState> {
  const [s, hidden] = await Promise.all([rawPipelineState(db), hiddenRepos(db, req)]);
  const limits = await mapSeq(s.limits, async ({ trips, ...l }) => {
    const shown = await mapSeq((trips ?? []).filter((t) => t.repo === null || !isHiddenRepo(hidden, t.repo)), async (t) => ({ ...t, reason: blankIfHidden(t.reason, hidden), canResume: await mayResumeTrip(req.user, t.key) }));
    return { ...l, pausedReason: blankIfHidden(l.pausedReason, hidden) || null, status: blankIfHidden(l.status, hidden) || null, ...(shown.length ? { trips: shown } : {}) };
  });
  return { ...s, outside: await outsideState(db, hidden), limits, blockers: { largeFixLines: await largeFixLines(db), outsidePurposeMin: await outsidePurposeMin(db) } };
}

/** Viewers read that a job failed, not why: the error carries log and command text. */
/**
 * A job as the reader may see it: viewers get "failed" for an error; no reader gets a summary, progress or error that names a repo
 * hidden from them (a job without a repo works across repos), and an error left out that way reads "failed". Operators hide nothing.
 */
const forViewer = (req: Req, hidden: HiddenRepos) => (j: Job): Job => ({
  ...j, summary: blankIfHidden(j.summary, hidden) || null, progress: blankIfHidden(j.progress, hidden) || null,
  error: j.error && (canSeeInternals(req) ? blankIfHidden(j.error, hidden) || "failed" : "failed"),
});

const wrap = async <T>(f: () => Promise<T | Promise<T>>): Promise<T> => {
  try {
    return await f();
  } catch (e) {
    if (e instanceof JobError) throw new HttpError(e.status, e.message);
    throw e;
  }
};

function wireParams(s: StepDef, repos: string[]): StepParam[] {
  return s.params.filter((p) => !p.cliOnly).map((p): StepParam => {
    const base = { name: p.name, label: p.label, help: p.help, required: !!p.required };
    switch (p.kind) {
      case "enum": return { ...base, kind: "enum", options: p.options, default: p.default };
      case "repo": return { ...base, kind: "repo", options: repos };
      case "int": return { ...base, kind: "int", min: p.min, max: p.max, default: p.default };
      case "run-id": return { ...base, kind: "run-id", default: p.default };
    }
  });
}

const lastJob = async (db: Db, step: string, view: (j: Job) => Job, hidden: HiddenRepos): Promise<Job | null> => {
  const r = await db.get(db.k.selectFrom("jobs").select(cols("jobs")).$narrowType<{ state: JobState }>().where("step", "=", step)
    .$if(filtered(hidden), (q) => q.where((eb) => eb.or([eb("repo", "is", null), eb.not(hiddenTestExpr(db, "repo", hidden))])))
    .orderBy("id", "desc").limit(1));
  return r ? view((await toJobs(db, [r]))[0]!) : null;
};

async function stageState(db: Db, steps: string[], syncFailed: boolean | null): Promise<PipelineStage["state"]> {
  if (steps.length) {
    const active = await db.get(db.k.selectFrom("jobs").select("state").$narrowType<{ state: JobState }>().where("step", "in", steps).where("state", "in", ["running", "queued"])
      .orderBy("state", "desc").limit(1)); // "running" sorts after "queued"
    if (active) return active.state === "running" ? "running" : "queued";
  }
  if (syncFailed !== null) return syncFailed ? "failed" : "ok";
  if (!steps.length) return "idle";
  const last = await db.get(db.k.selectFrom("jobs").select("state").$narrowType<{ state: JobState }>().where("step", "in", steps).where("state", "in", ["done", "failed"])
    .orderBy("id", "desc").limit(1));
  return last?.state === "done" ? "ok" : last?.state === "failed" ? "failed" : "idle";
}

export async function overview(db: Db, req: Req): Promise<PipelineOverview> {
  const all = [...(await loadSteps()).values()].filter((s) => s.name !== SECURITY_STEP || canSeeInternals(req));
  const repos = await visibleRepos(db, req);
  const hidden = await hiddenRepos(db, req);
  const steps: PipelineStep[] = await mapSeq(all, async (s) => ({
    name: s.name, title: s.title, description: s.description, stage: s.stage, requires: s.requires,
    params: wireParams(s, repos), unavailable: s.available?.() ?? null,
    lastJob: await lastJob(db, s.name, forViewer(req, hidden), hidden),
  }));
  const raw = await db.all(db.k.selectFrom("sync_runs").select(["started_at as startedAt", "ended_at as endedAt", "mode", "items", "error"]).orderBy("started_at", "desc").limit(10));
  const lastSync = raw.find((r) => r.endedAt);
  // A sync error can quote GitHub's answer about any repo: staff read it unless it names a repo hidden from them, viewers read "failed".
  const runs = raw.map((r) => ({ ...r, error: r.error && (canSeeInternals(req) ? blankIfHidden(r.error, hidden) || "failed" : "failed") }));
  const high = (await setting(db, "org_high_water")) ?? null;
  const stages: PipelineStage[] = await mapSeq(STAGES, async (st) => {
    const names = steps.filter((s) => s.stage === st.n).map((s) => s.name);
    const mode = st.automatic ? "automatic" : names.length ? "steps" : "planned";
    return {
      n: st.n, name: st.name, mode, steps: names,
      state: mode === "planned" ? "planned" : await stageState(db, names, st.automatic ? (lastSync ? lastSync.error !== null : high ? false : null) : null),
    };
  });
  const beat = (await setting(db, HEARTBEAT_KEY)) ?? null;
  const count = async (state: string) => (await db.get(db.k.selectFrom("jobs").select((eb) => eb.fn.countAll<number>().as("n")).where("state", "=", state)
    .$if(filtered(hidden), (q) => q.where((eb) => eb.or([eb("repo", "is", null), eb.not(hiddenTestExpr(db, "repo", hidden))])))))!.n;
  return {
    stages, steps,
    runner: { lastSeen: beat, alive: beat !== null && Date.now() - Date.parse(beat) < RUNNER_ALIVE_MS },
    sync: { lastFinishedAt: lastSync?.endedAt ?? high, runs },
    counts: { queued: await count("queued"), running: await count("running") },
  };
}

const intQuery = (req: Req, name: string): number | undefined => {
  const v = req.query.get(name);
  if (v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${name} must be a whole number`);
  return n;
};

export async function jobs(db: Db, req: Req) {
  const state = req.query.get("state") || undefined;
  if (state && !JOB_STATES.includes(state as JobState)) throw new HttpError(400, "unknown state");
  const hidden = await hiddenRepos(db, req);
  const list = await listJobs(db, { step: req.query.get("step") || undefined, state: state as JobState | undefined, limit: intQuery(req, "limit"), offset: intQuery(req, "offset") }, hidden);
  return { ...list, jobs: list.jobs.map(forViewer(req, hidden)) };
}

const jobId = (req: Req): number => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, "not a job id");
  return id;
};

export const job = async (db: Db, req: Req) => wrap(async () => {
  const hidden = await hiddenRepos(db, req);
  const id = jobId(req);
  const d = await jobDetail(db, id, { hidden, logs: canSeeInternals(req) });
  const repo = jobRepo((await jobRow(db, id))?.repo);
  d.canCancel = req.user.role === "operator" || (!!repo && await mayRunRepo(req.user, repo));
  if (canSeeInternals(req)) return forViewer(req, hidden)(d) as typeof d;
  // An item's outcome reads "failed: <reason>" or carries notes: viewers get the leading state word, and nothing for a quiet pull request.
  const items = await mapSeq(d.items, async (i) => ({ ...i, outcome: await isQuiet(db, i.repo, i.number) ? null : /^[A-Za-z-]+/.exec(i.outcome ?? "")?.[0] ?? null }));
  return { ...forViewer(req, hidden)(d) as typeof d, items };
});

function body(req: Req): Record<string, unknown> {
  const b = req.json;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "the body must be a JSON object");
  return b as Record<string, unknown>;
}

export async function request(db: Db, req: Req): Promise<Job> {
  requireOperator(req);
  const b = body(req);
  const step = typeof b.step === "string" ? (await loadSteps()).get(b.step) : undefined;
  if (!step) throw new HttpError(400, "no such step");
  requireOperator(req, step);
  if (step.name === SECURITY_STEP) throw new HttpError(400, "scans are started from the repo page");
  const given = b.params && typeof b.params === "object" && !Array.isArray(b.params) ? b.params as Record<string, unknown> : {};
  const cli = step.params.find((p) => p.cliOnly && given[p.name] !== undefined);
  if (cli) throw new HttpError(400, `${cli.label} is set from the command line only`);
  const j = await wrap(async () => enqueue(db, step.name, b.params, req.user.login));
  await audit(db, req.user.login, "job-request", `job:${j.id}`, { step: j.step, params: j.params });
  return j;
}

/** A security job stores its repo as `(security):<repo>`; the permission is on the repo itself. */
const jobRepo = (r: string | null | undefined): string | null => (r?.startsWith(SECURITY_PREFIX) ? r.slice(SECURITY_PREFIX.length) : r ?? null);

// An operator cancels any job; a maintainer with write access cancels the jobs of that repo. A job without a repo stays operator-only.
export async function cancel(db: Db, req: Req): Promise<Job> {
  if (req.user.role === "viewer") throw new HttpError(403, "only operators and maintainers cancel pipeline jobs");
  const id = jobId(req);
  const before = await wrap(async () => await getJob(db, id));
  const repo = jobRepo((await jobRow(db, id))?.repo);
  if (req.user.role !== "operator" && !(repo && await mayRunRepo(req.user, repo))) throw new HttpError(403, "only an operator, or a maintainer with write access to the job's repo, cancels it");
  const j = await wrap(async () => await requestCancel(db, id, req.user.login));
  await audit(db, req.user.login, "job-cancel", `job:${id}`, { step: j.step, state: before.state });
  return j;
}

export const state = async (db: Db, req: Req) => pipelineState(db, req);

export async function putState(db: Db, req: Req) {
  requireOperator(req);
  const b = body(req);
  if (typeof b.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
  const was = (await rawPipelineState(db)).enabled;
  await setEnabled(db, b.enabled, req.user.login);
  await audit(db, req.user.login, "pipeline-switch", "pipeline", { enabled: b.enabled, was });
  return pipelineState(db, req);
}

/** The model of the prepare step and the models an operator may pick. */
export const getJudgementModel = async (db: Db) => ({ judgementModel: await judgementModel(db), judgementModels: [...JUDGEMENT_MODELS] });

export async function putJudgementModel(db: Db, req: Req) {
  requireOperator(req);
  const m = body(req).model;
  if (typeof m !== "string" || !(JUDGEMENT_MODELS as readonly string[]).includes(m)) throw new HttpError(400, `model must be one of ${JUDGEMENT_MODELS.join(", ")}`);
  const was = await judgementModel(db);
  await setJudgementModel(db, m);
  await audit(db, req.user.login, "judgement-model", "pipeline", { model: m, was });
  return pipelineState(db, req);
}

/** The two thresholds of the workflow blockers: a fix above `largeFixLines` changed lines, a change of at least `outsidePurposeMin` lines outside the PR's purpose. */
export async function putBlockers(db: Db, req: Req) {
  requireOperator(req);
  const b = body(req);
  const rows: [string, string, number][] = [[LARGE_FIX_KEY, "largeFixLines", await largeFixLines(db)], [OUTSIDE_PURPOSE_KEY, "outsidePurposeMin", await outsidePurposeMin(db)]];
  const was = { largeFixLines: rows[0]![2], outsidePurposeMin: rows[1]![2] };
  for (const [key, field] of rows) {
    const v = b[field];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 1_000_000) throw new HttpError(400, `${field} must be a whole number from 1 to 1000000`);
    await db.run(db.k.insertInto("settings").values({ key, value: String(v) }).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
  }
  await audit(db, req.user.login, "blocker-thresholds", "pipeline", { was, ...b });
  return pipelineState(db, req);
}

export async function putLimit(db: Db, req: Req) {
  requireOperator(req);
  try {
    await setLimit(db, req.params.step, req.json, req.user.login);
  } catch (e) {
    if (e instanceof LimitError) throw new HttpError(e.status, e.message);
    throw e;
  }
  return (await pipelineState(db, req)).limits.find((l) => l.step === req.params.step)!;
}

/** An operator, or a maintainer with write access to the trip's repo, clears a breaker (`<stage>:<repo>`, or outside-surge). */
export async function resumeTrip(db: Db, req: Req) {
  if (!await mayResumeTrip(req.user, req.params.stage!)) throw new HttpError(403, "only an operator, or a maintainer with write access to the breaker's repo, resumes it");
  try {
    await resumeStage(db, req.params.stage, req.user.login);
  } catch (e) {
    if (e instanceof TripError) throw new HttpError(e.status, e.message);
    throw e;
  }
  return pipelineState(db, req);
}

/** Starts today's count of a step again from zero; the step `all` resets every stage. */
export async function resetLimit(db: Db, req: Req) {
  requireOperator(req);
  try {
    await resetLimitCount(db, req.params.step, req.user.login);
  } catch (e) {
    if (e instanceof LimitError) throw new HttpError(e.status, e.message);
    throw e;
  }
  return pipelineState(db, req);
}

/** An operator acknowledges the deadline stops of a step, which clears their warning in the header. */
export async function ackStepDeadline(db: Db, req: Req) {
  requireOperator(req);
  const step = req.params.step!;
  if (!(await loadSteps()).has(step)) throw new HttpError(404, "no such step");
  await ackDeadline(db, step, req.user.login);
  return { ok: true };
}
