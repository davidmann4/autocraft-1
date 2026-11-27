// Build tasks: created by pipeline steps, claimed by workers that pull, run
// on the worker, and reported back. Everything a worker sends is stored as
// data; nothing here executes it, renders it or puts it in a prompt.
import { currentJobId } from "../agents/call.ts";
import type { BuildSummary, BuildTask, BuildTaskDetail, Capabilities, Requires, SandboxEnv, TaskFilter, TaskPage, TaskResult, TaskStep } from "../../web/src/api/types.ts";
import {
  appendTaskLogs, cancelTasks, claimTasks, cloneTasks as cloneTaskRows, createTasks, failQueuedTasks, finishTask as saveFinish, loadCancelIds, loadClaimInputs, loadConfidentialReadyAt, loadEnvs, loadLogTails, loadMemorySummary, loadTaskDetail, loadTaskPage,
  loadTaskStates, loadTasks, loadWorkerTask, pruneTaskBatch, QueueFullError, reapStaleTasks, releaseClaims, startTasks, StatusError, TaskAccessError, touchTasks, loseTasks,
  LOG_TAIL_BYTES, LOST_AFTER_MS, loadTaskSummary, MAX_CHUNK_BYTES, warmKeyOfRepo,
} from "../data/build/index.ts";
import type { ClaimInputs, ClaimPick, NewTask, TaskRecord, TaskState, Warm } from "../data/build/index.ts";
import { readConfig, type Config } from "../data/control/index.ts";
import { removeArtifactDirs } from "./artifacts.ts";
import { BuildError, envSettings } from "./envs.ts";
import { toolchainImage } from "./pods.ts";
import { chooseTasks, claimConfigKeys, satisfies, type ClaimFit } from "./choose.ts";
import { slugOf } from "../owners.ts";
import { autocraftVersion, warmMinInterval, WARM_PRODUCER_REV } from "./warm-queue.ts";
import type { Db } from "../db/index.ts";

export {
  ARTIFACT_KEEP_MS, CONFIDENTIAL_WAIT, KEEP_MS, LOG_TAIL_BYTES, LOST_AFTER_MS, MAX_ATTEMPTS, MAX_CHUNK_BYTES, MAX_LOG_BYTES, MAX_QUEUED, PRIVATE_STEPS, TERMINAL, WARM_STEP,
} from "../data/build/index.ts";
export type { MemRow, NewTask, Warm } from "../data/build/index.ts";
export type { ClaimFit };
export { satisfies };

const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const STEP_NAME_RE = /^[A-Za-z0-9 ._:-]{1,64}$/;
const GLOB_RE = /^[A-Za-z0-9._*?/{},-]{1,200}$/;
const nowIso = (): string => new Date().toISOString();

/** A warm-cache key for a repo name: a readable slug (at most 49 characters) and a hash of the lowercased name, so distinct names never share a key; always valid. */
export const warmKeyOf = warmKeyOfRepo;

/** Maps the data module's refusals to the status errors the API answers with. */
const mapped = (e: unknown): never => {
  if (e instanceof QueueFullError) throw new BuildError(429, e.message);
  if (e instanceof TaskAccessError || e instanceof StatusError) throw new BuildError(e.status, e.message);
  throw e;
};

export const MAX_PATCH_BYTES = 1024 * 1024;
const WARM_KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function parseWarm(v: unknown): Warm {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).some((k) => k !== "key" && k !== "role")) throw new BuildError(400, "warm must be { key, role }");
  if (typeof o.key !== "string" || !WARM_KEY_RE.test(o.key)) throw new BuildError(400, "warm.key is not valid");
  if (o.role !== "use" && o.role !== "build") throw new BuildError(400, "warm.role must be use or build");
  return { key: o.key, role: o.role };
}

export function parsePatch(v: unknown): string {
  if (typeof v !== "string" || v.length === 0) throw new BuildError(400, "patch must be a non-empty string");
  if (Buffer.byteLength(v) > MAX_PATCH_BYTES) throw new BuildError(400, "patch is larger than 1 MiB");
  if (v.includes("\0")) throw new BuildError(400, "patch must be text");
  return v;
}

export function parseRequires(v: unknown): Requires {
  if (v === undefined) return {};
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new BuildError(400, "requires must be an object");
  const o = v as Record<string, unknown>;
  const out: Requires = {};
  for (const [k, x] of Object.entries(o)) {
    if (k === "os" && ["linux", "macos", "windows"].includes(x as string)) out.os = x as Capabilities["os"];
    else if (k === "arch" && ["x86_64", "aarch64"].includes(x as string)) out.arch = x as Capabilities["arch"];
    else if ((k === "display" || k === "gpu") && typeof x === "boolean") out[k] = x;
    else if ((k === "minMemGb" || k === "minDiskGb") && typeof x === "number" && x >= 0 && x <= 1e7) out[k] = x;
    else if (k === "toolchains" && Array.isArray(x) && x.length <= 40 && x.every((t) => typeof t === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/.test(t))) out.toolchains = x as string[];
    else throw new BuildError(400, `requires.${k} is not valid`);
  }
  return out;
}

export function parsePlan(v: unknown): TaskStep[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 20) throw new BuildError(400, "plan must list 1 to 20 steps");
  return v.map((s, i): TaskStep => {
    const o = s as Record<string, unknown> | null;
    const where = `plan[${i}]`;
    if (!o || typeof o !== "object") throw new BuildError(400, `${where} must be an object`);
    if (typeof o.name !== "string" || !STEP_NAME_RE.test(o.name)) throw new BuildError(400, `${where}.name is not valid`);
    if (!Array.isArray(o.cmd) || o.cmd.length < 1 || o.cmd.length > 64 || o.cmd.some((a) => typeof a !== "string" || a.length > 8192 || a.includes("\0"))) throw new BuildError(400, `${where}.cmd must be 1 to 64 strings`);
    if (o.network !== "fetch" && o.network !== "none" && o.network !== "mirror") throw new BuildError(400, `${where}.network must be fetch, none or mirror`);
    if (typeof o.timeoutSec !== "number" || !Number.isInteger(o.timeoutSec) || o.timeoutSec < 1 || o.timeoutSec > 7200) throw new BuildError(400, `${where}.timeoutSec must be 1 to 7200`);
    const step: TaskStep = { name: o.name, cmd: o.cmd as string[], network: o.network, timeoutSec: o.timeoutSec };
    if (o.artifacts !== undefined) {
      if (!Array.isArray(o.artifacts) || o.artifacts.length > 20 || o.artifacts.some((g) => typeof g !== "string" || !GLOB_RE.test(g) || g.startsWith("/") || g.split("/").includes(".."))) throw new BuildError(400, `${where}.artifacts must be up to 20 relative globs`);
      step.artifacts = o.artifacts as string[];
    }
    if (o.bare !== undefined) {
      if (typeof o.bare !== "boolean") throw new BuildError(400, `${where}.bare must be a boolean`);
      if (o.bare) step.bare = true;
    }
    return step;
  });
}

/** Checks a task a pipeline step or the CLI queues; the source is fetched by sha, so it must be a full commit id. */
function checked(t: NewTask): NewTask {
  if (typeof t.step !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(t.step)) throw new BuildError(400, "step is not valid");
  if (typeof t.repo !== "string" || !REPO_RE.test(t.repo)) throw new BuildError(400, "repo is not valid");
  if (!SHA_RE.test(t.headSha)) throw new BuildError(400, "headSha must be a full lowercase commit id");
  if (t.baseSha != null && !SHA_RE.test(t.baseSha)) throw new BuildError(400, "baseSha must be a full lowercase commit id");
  if (t.number != null && (!Number.isInteger(t.number) || t.number < 1)) throw new BuildError(400, "number is not valid");
  const priority = t.priority ?? 0;
  if (!Number.isInteger(priority) || priority < -100 || priority > 100) throw new BuildError(400, "priority must be -100 to 100");
  return {
    ...t, jobId: t.jobId ?? currentJobId(), priority, requires: parseRequires(t.requires), plan: parsePlan(t.plan),
    ...(t.patch === undefined ? {} : { patch: parsePatch(t.patch) }), ...(t.warm === undefined ? {} : { warm: parseWarm(t.warm) }),
  };
}

/** Queues tasks; the whole set is refused (429) when the queue would pass MAX_QUEUED. Returns the ids in order. */
export async function createTaskSet(db: Db, ts: NewTask[]): Promise<number[]> {
  const rows = ts.map(checked);
  return await createTasks(db, rows).catch(mapped);
}

/** Queues a task. Used by pipeline steps and the CLI. */
export async function createTask(db: Db, t: NewTask): Promise<number> {
  return (await createTaskSet(db, [t]))[0]!;
}

/** Queues a copy of each task under the running job; the whole set is refused (429) when the queue is full. Returns the new id per source id. */
export async function cloneTasks(db: Db, ids: number[]): Promise<Map<number, number>> {
  return await cloneTaskRows(db, ids, currentJobId()).catch(mapped);
}

/** Queues a copy of task `id`. */
export async function cloneTask(db: Db, id: number): Promise<number> {
  return (await cloneTasks(db, [id])).get(id)!;
}

export type ClaimedTask = { id: number; repo: string; headSha: string; baseSha: string | null; requires: Requires; plan: TaskStep[]; sourceUrl: string; patch?: string; warm?: Warm };
export type ClaimResult = { tasks: ClaimedTask[]; cancel: number[] };

/**
 * Ids of this environment's tasks that an operator cancelled and whose containers the worker may still be running.
 * A cancel ends the task at once; the worker kills its containers and does not report back, so the id is
 * repeated for LOST_AFTER_MS after the cancel.
 */
export async function cancelIds(db: Db, envId: string): Promise<number[]> {
  return await loadCancelIds(db, envId, new Date(Date.now() - LOST_AFTER_MS).toISOString());
}

const sourceUrl = (repo: string, head: string): string => `https://codeload.github.com/${slugOf(repo)}/tar.gz/${head}`;

/**
 * What an environment with `free` slots would claim now, and the tasks no environment can run (their `fail` summaries): the
 * oldest of the highest priority whose requirements it meets, at most min(free, its slots minus the tasks it is running). A
 * disabled, paused or unreported environment gets none. Claims nothing: `claim` and the pod launcher write the picks.
 * With `fit`, its slots are only the ceiling (not the slots it reported) and `fit` decides each task.
 */
export async function pickTasks(
  db: Db, envId: string, free: number, nowMs: number,
  o: { fit?: ClaimFit; warm?: { version: string; rev: number; image: string | null }; inputs?: ClaimInputs; config?: Config; warmMinIntervalMinutes?: number } = {},
): Promise<{ inputs: ClaimInputs; picks: ClaimPick[]; failed: { id: number; summary: string }[] }> {
  let warm = o.warm;
  if (!o.inputs && warm === undefined) {
    // A warm writer's claim reads the warm facts of its toolchain image.
    const env = (await loadEnvs(db, { ids: [envId] }))[0];
    const s = env?.kind === "kubernetes" ? envSettings(env) : null;
    if (s?.warmWriter) warm = { version: autocraftVersion(), rev: WARM_PRODUCER_REV, image: toolchainImage(s, ["rust-stable"]) };
  }
  const read = o.inputs ?? await loadClaimInputs(db, envId, nowMs, warm);
  const config = o.config ?? await readConfig(db, claimConfigKeys(read));
  const warmMinIntervalMinutes = o.warmMinIntervalMinutes ?? await warmMinInterval(db);
  const out = await chooseTasks(read, { free, nowMs, fit: o.fit, config, warmMinIntervalMinutes });
  return { inputs: read, ...out };
}

/**
 * Hands out queued tasks to an environment that has `free` slots (see pickTasks). The picks are claimed with a compare-and-set, so
 * two environments never get the same task.
 */
export async function claim(db: Db, envId: string, free: number, nowMs: number = Date.now(), fit?: ClaimFit): Promise<ClaimResult> {
  await reapLost(db, nowMs);
  const { picks, failed } = await pickTasks(db, envId, free, nowMs, { fit });
  const at = new Date(nowMs).toISOString();
  if (failed.length) await failQueuedTasks(db, failed, at);
  const won = new Set(picks.length ? await claimTasks(db, envId, picks, at) : []);
  const records = won.size ? await loadTasks(db, [...won], { patch: true }) : new Map<number, TaskRecord>();
  const tasks = picks.flatMap((p): ClaimedTask[] => {
    const t = records.get(p.id);
    return t && won.has(p.id) ? [{
      id: t.id, repo: t.repo, headSha: t.headSha, baseSha: t.baseSha, requires: t.requires, plan: t.plan, sourceUrl: sourceUrl(t.repo, t.headSha),
      ...(t.patch ? { patch: t.patch } : {}), ...(t.warmKey && t.warmRole ? { warm: { key: t.warmKey, role: t.warmRole } } : {}),
    }] : [];
  });
  return { tasks, cancel: await cancelIds(db, envId) };
}

const removeFiles = (r: { files: number[] }): void => removeArtifactDirs(r.files);

/** Tasks without a heartbeat for LOST_AFTER_MS: requeued once, then failed; a cancelled one is just cancelled. Returns how many were handled. */
export async function reapLost(db: Db, nowMs: number = Date.now(), seen?: number[]): Promise<number> {
  const r = await reapStaleTasks(db, nowMs, seen);
  removeFiles(r);
  return r.lost;
}

/**
 * A claimed or running task whose worker or pod is gone: requeued when it has a claim left and nobody cancelled it,
 * else failed with `reason` (or cancelled with `cancelled`). Its artifacts go; a requeued task also loses its log.
 */
export async function loseTask(db: Db, id: number, reason: string, cancelled = "Cancelled; the worker stopped answering.", nowMs: number = Date.now()): Promise<void> {
  removeFiles(await loseTasks(db, [{ id, reason, cancelled }], nowMs));
}

/** Undoes a claim whose task never started (its first pod could not be created): queued again, the claim not counted. */
export async function releaseClaim(db: Db, envId: string, id: number): Promise<void> {
  await releaseClaims(db, envId, [id]);
}

/** Keeps a task alive while its pods run (they send no heartbeats of their own). */
export async function touchTask(db: Db, envId: string, id: number): Promise<void> {
  await touchTasks(db, envId, [id], nowIso());
}

/** What a build pod's API containers need of their task: the source to fetch, the patch, and each step's name and artifact patterns. */
export type PodTask = {
  id: number; repo: string; headSha: string; baseSha: string | null; sourceUrl: string; patch?: string; steps: { name: string; artifacts: string[] }[];
  /** A warm producer's task (step `warm`): its source pod also reports the CI gate's warm-command. */
  warm?: true;
};

export async function podTask(db: Db, envId: string, id: number): Promise<PodTask> {
  const t = await loadWorkerTask(db, envId, id, { patch: true }).catch(mapped);
  return {
    id: t.id, repo: t.repo, headSha: t.headSha, baseSha: t.baseSha, sourceUrl: sourceUrl(t.repo, t.headSha),
    ...(t.patch ? { patch: t.patch } : {}),
    steps: t.plan.map((s) => ({ name: s.name, artifacts: s.artifacts ?? [] })),
    ...(t.step === "warm" ? { warm: true as const } : {}),
  };
}

/** The task when it is running on this environment, else a 404 or 409. */
export const ownedTask = async (db: Db, envId: string, id: number): Promise<TaskRecord> => await loadWorkerTask(db, envId, id).catch(mapped);

export async function startTask(db: Db, envId: string, id: number): Promise<{ cancel: number[] }> {
  const r = await startTasks(db, envId, [id], nowIso());
  if (!r.started.includes(id)) await ownedTask(db, envId, id);
  return { cancel: r.cancel };
}

export async function heartbeat(db: Db, envId: string, id: number): Promise<{ cancel: number[] }> {
  if (await touchTasks(db, envId, [id], nowIso()) === 0) {
    const prior = (await loadTaskStates(db, [id])).get(id);
    const t = prior ? (await loadTasks(db, [id])).get(id) : undefined;
    if (!(t?.envId === envId && t.state === "cancelled")) await ownedTask(db, envId, id);
  }
  return { cancel: await cancelIds(db, envId) };
}

const cleanLine = (s: unknown, max: number): string | null =>
  typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) || null : null;

/** Appends a log chunk; past the per-task cap the rest is dropped with a marker. */
export async function appendLog(db: Db, envId: string, id: number, step: unknown, chunk: unknown): Promise<{ truncated: boolean }> {
  if (typeof chunk !== "string") throw new BuildError(400, "chunk must be text");
  if (Buffer.byteLength(chunk) > MAX_CHUNK_BYTES) throw new BuildError(413, "a log chunk is at most 64 KB");
  const r = await appendTaskLogs(db, envId, id, cleanLine(step, 64) ?? "", [chunk]).catch(mapped);
  return { truncated: r.truncated };
}

export function parseResults(v: unknown): TaskResult[] {
  if (!Array.isArray(v) || v.length > 40) throw new BuildError(400, "results must be a list of at most 40 entries");
  return v.map((r, i) => {
    const o = r as Record<string, unknown> | null;
    if (!o || typeof o !== "object") throw new BuildError(400, `results[${i}] must be an object`);
    const step = cleanLine(o.step, 64);
    const code = o.exitCode;
    const ms = o.durationMs;
    if (!step || (code !== null && (typeof code !== "number" || !Number.isInteger(code))) || typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || typeof o.timedOut !== "boolean") {
      throw new BuildError(400, `results[${i}] is not valid`);
    }
    const mem = o.peakMemBytes;
    const peakMemBytes = typeof mem === "number" && Number.isFinite(mem) && mem >= 0 ? Math.round(mem) : undefined;
    return { step, exitCode: code as number | null, durationMs: Math.round(ms), timedOut: o.timedOut, ...(peakMemBytes !== undefined ? { peakMemBytes } : {}), ...(typeof o.oomKilled === "boolean" ? { oomKilled: o.oomKilled } : {}) };
  });
}

const REF_RE = /^[0-9a-f]{40}$/;
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,299}$/;
const PKG_RE = /^[a-z0-9][a-z0-9+.-]{0,99}$/;

/** The environment a worker reports for a task: image, packages and the craft-fonts / craft-i18n commits. */
export function parseSandboxEnv(v: unknown): SandboxEnv | null {
  if (v === undefined || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof v !== "object" || Array.isArray(v)) throw new BuildError(400, "environment must be an object");
  const ref = (x: unknown, name: string): string | null => {
    if (x === null || x === undefined) return null;
    if (typeof x !== "string" || !REF_RE.test(x)) throw new BuildError(400, `environment.${name} must be a commit id`);
    return x;
  };
  if (typeof o.image !== "string" || !IMAGE_RE.test(o.image) || typeof o.baseImage !== "string" || !IMAGE_RE.test(o.baseImage)) throw new BuildError(400, "environment images are not valid");
  if (!Array.isArray(o.packages) || o.packages.length > 100 || o.packages.some((p) => typeof p !== "string" || !PKG_RE.test(p))) throw new BuildError(400, "environment.packages is not valid");
  return { image: o.image, baseImage: o.baseImage, packages: o.packages as string[], craftFontsRef: ref(o.craftFontsRef, "craftFontsRef"), craftI18nRev: ref(o.craftI18nRev, "craftI18nRev") };
}

/** The worker's last word: done when every step exited 0, cancelled when an operator asked, else failed. */
export async function finishTask(db: Db, envId: string, id: number, body: unknown): Promise<{ state: TaskState }> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BuildError(400, "the body must be a JSON object");
  const o = body as Record<string, unknown>;
  const results = parseResults(o.results);
  const summary = cleanLine(o.summary, 500);
  const sandbox = parseSandboxEnv(o.environment);
  // `failed`: the runner stopped the task for a reason no step result shows (a phase before or after the steps).
  return await saveFinish(db, envId, id, { results, summary, sandbox, failed: o.failed === true }).catch(mapped);
}

const scopeOf = (hidden: string[], staff: boolean) => ({ hiddenRepos: hidden, staff });

/** Cancels a task at once. An active one stays listed in its worker's claim and heartbeat responses for two minutes, so the worker kills it. */
export async function cancelTask(db: Db, id: unknown, by: string): Promise<BuildTask> {
  const n = typeof id === "number" ? id : Number(id);
  const r = Number.isInteger(n) ? (await cancelTasks(db, { ids: [n] }, by))[0] : undefined;
  if (!r || r.result === "missing") throw new BuildError(404, "no such task");
  if (r.result === "already") throw new BuildError(409, `the task is already ${r.was}`);
  return (await getTask(db, n))!;
}

// ---- reading -----------------------------------------------------------------

/** One task with its artifacts, batch and shown item (all repos, staff view). */
export async function getTask(db: Db, id: number): Promise<BuildTask | null> {
  return await loadTaskDetail(db, id, scopeOf([], true));
}

/** The last bytes of the log, from whole chunks. */
export async function logTail(db: Db, id: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  return (await loadLogTails(db, [{ id }], { maxBytes: LOG_TAIL_BYTES })).get(id) ?? { text: "", bytes: 0, truncated: false };
}

export async function getTaskDetail(db: Db, id: number): Promise<BuildTaskDetail | null> {
  return await loadTaskDetail(db, id, scopeOf([], true));
}

/** The step of a security fix's builds: its tasks run under the finding's real repo, so viewers must not see them. */
export const FIX_CHECK_STEP = "fix-check";

/**
 * Since when the private tasks can be claimed: the earliest first worker call of an enabled confidential environment
 * after its flag (or the environment) was turned on; null while none has called since.
 */
export const confidentialReadyAt = async (db: Db): Promise<number | null> => await loadConfidentialReadyAt(db);

/** When a private task's build limit starts: when it was queued, or when a confidential environment could first take it. null: it waits for one. */
export async function privateClockStart(db: Db, queuedAt: string): Promise<number | null> {
  const ready = await confidentialReadyAt(db);
  return ready === null ? null : Math.max(Date.parse(queuedAt), ready);
}

/** `step IN (PRIVATE_STEPS)` as an expression on the step in `col`; `eb.not(...)` for NOT IN. */
export { privateStepExpr } from "../data/build/index.ts";

/** Newest first, keyset-paged by id. `hidden` repos are left out, and the security fix's tasks unless `staff`. */
export async function listTasks(db: Db, f: TaskFilter, hidden: string[] = [], staff = true): Promise<TaskPage> {
  return await loadTaskPage(db, f, scopeOf(hidden, staff)).catch(mapped);
}

export type { BuildSummary };
/** Queued and running tasks and the slots left, over all enabled environments (the flowchart's Verify node). */
export async function summary(db: Db, hidden: string[] = [], staff = true): Promise<BuildSummary> {
  return await loadTaskSummary(db, scopeOf(hidden, staff));
}

/** Drops the artifacts of tasks that ended more than ARTIFACT_KEEP_MS ago, and deletes tasks that ended more than KEEP_MS ago with their logs. Returns the count of deleted tasks. */
export async function pruneTasks(db: Db, nowMs: number = Date.now()): Promise<number> {
  let n = 0;
  for (;;) {
    const r = await pruneTaskBatch(db, { nowMs });
    removeArtifactDirs(r.artifactIds);
    n += r.deleted.length;
    if (!r.artifactIds.length && !r.deleted.length) return n;
  }
}

/** Peak memory per repo and step name over tasks that ended in the last `days` days; steps without a measurement are skipped. */
export const memorySummary = async (db: Db, days: number): Promise<import("../data/build/index.ts").MemRow[]> => await loadMemorySummary(db, days);
