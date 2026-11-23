// Builds an operator or maintainer starts from their own agent (MCP tools start_build, build_status, cancel_build, build_base): their
// command lines run as a build task on the registered build environments, the same queue the pipeline's builds use.
// The source is a default-branch commit AutoCraft has seen (so the CI gate it reads is upstream's) plus an optional patch
// that turns it into the caller's working tree. The task counts as untrusted code: no confidential environment and no
// warm-snapshot signer takes it, and it only reads the repo's warm build cache.
import type { BuildTask, TaskResult, TaskStep } from "../../web/src/api/types.ts";
import { artifactText } from "../prepush/index.ts";
import { FETCH_SCRIPT } from "../worker/rust.ts";
import { BuildError } from "./envs.ts";
import { mainCiRepos } from "../mainci/index.ts";
import { cancelTask, createTask, getTask, logTail, MAX_PATCH_BYTES, MCP_BUILD_STEP, TERMINAL, warmKeyOf } from "./tasks.ts";
import type { Db } from "../db/index.ts";

export { MCP_BUILD_STEP };
/** Command lines one build may run (the plan's 20 steps less the dependency fetch). */
export const MAX_LINES = 19;
const MAX_LINE = 4000;
/** Open (queued or running) builds from the MCP tools at once, over all users. */
export const MAX_OPEN = 8;
export const DEFAULT_STEP_MIN = 60;
const MAX_STEP_MIN = 120;
const LOG_LINES = { default: 120, max: 400 };
const SHA_RE = /^[0-9a-f]{40}$/;
const OPEN_STATES = ["queued", "claimed", "running"];

export type StartInput = { repo: string; base: string; patch?: string; steps: string[]; stepMinutes: number };

/** The tool's arguments, or a BuildError(400) that says what is wrong. `repo` is already checked by the caller. */
export function parseStart(repo: string, raw: Record<string, unknown>): StartInput {
  for (const k of Object.keys(raw)) if (!["repo", "base", "patch", "steps", "step_minutes"].includes(k)) throw new BuildError(400, `unknown argument "${k}"`);
  if (typeof raw.base !== "string" || !SHA_RE.test(raw.base)) throw new BuildError(400, "base must be a full lowercase commit id (build_base gives the current one)");
  const steps = raw.steps;
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_LINES) throw new BuildError(400, `steps must list 1 to ${MAX_LINES} command lines`);
  for (const s of steps) {
    if (typeof s !== "string" || !s.trim() || s.length > MAX_LINE || /[\0\n\r]/.test(s)) throw new BuildError(400, `each step must be one non-empty command line of at most ${MAX_LINE} characters`);
  }
  let patch: string | undefined;
  if (raw.patch !== undefined && raw.patch !== null && raw.patch !== "") {
    if (typeof raw.patch !== "string" || raw.patch.includes("\0")) throw new BuildError(400, "patch must be the text of a unified diff");
    if (Buffer.byteLength(raw.patch) > MAX_PATCH_BYTES) throw new BuildError(400, "patch is larger than 1 MiB; build a pushed default-branch commit closer to your tree");
    patch = raw.patch.endsWith("\n") ? raw.patch : `${raw.patch}\n`;
  }
  let stepMinutes = DEFAULT_STEP_MIN;
  if (raw.step_minutes !== undefined && raw.step_minutes !== null) {
    if (!Number.isInteger(raw.step_minutes) || (raw.step_minutes as number) < 1 || (raw.step_minutes as number) > MAX_STEP_MIN) throw new BuildError(400, `step_minutes must be a whole number from 1 to ${MAX_STEP_MIN}`);
    stepMinutes = raw.step_minutes as number;
  }
  return { repo, base: raw.base, ...(patch !== undefined && { patch }), steps: steps as string[], stepMinutes };
}

const exitName = (i: number): string => `step-${i + 1}.exit`;

/**
 * The task's plan: the dependency fetch (the only step with network), then one offline step per line. Each line runs in
 * `sh` with cargo offline; its exit code is kept as an artifact and the step itself always succeeds, so every line runs
 * even after one fails. A line that runs out of time still ends the task.
 */
export function buildPlan(steps: string[], stepMinutes: number): TaskStep[] {
  return [
    { name: "fetch deps", cmd: ["sh", "-c", FETCH_SCRIPT], network: "fetch", timeoutSec: 900 },
    ...steps.map((line, i): TaskStep => ({
      name: `step ${i + 1}`,
      cmd: ["sh", "-c", `CARGO_NET_OFFLINE=true sh -c "$1"; echo $? > /out/${exitName(i)}; true`, `step-${i + 1}`, line],
      network: "none", timeoutSec: stepMinutes * 60, artifacts: [exitName(i)],
    })),
  ];
}

export type Base = { sha: string; branch: string; state: string };

/** The current default-branch head of a tracked repo, as the Main CI page shows it. */
export async function currentBase(db: Db, repo: string): Promise<Base | null> {
  const r = (await mainCiRepos(db)).find((x) => x.repo === repo);
  return r ? { sha: r.headSha, branch: r.branch, state: r.state } : null;
}

/** Whether `sha` is a default-branch commit of `repo` that AutoCraft recorded (main_ci keeps the recent heads). */
async function knownBase(db: Db, repo: string, sha: string): Promise<boolean> {
  return !!await db.prepare("SELECT 1 FROM main_ci WHERE repo = ? AND head_sha = ? LIMIT 1").get(repo, sha);
}

/** Queues the build; returns its task id. */
export async function startBuild(db: Db, i: StartInput): Promise<number> {
  const head = await currentBase(db, i.repo);
  if (!head) throw new BuildError(409, `AutoCraft has recorded no default-branch commit of ${i.repo} yet`);
  if (i.base !== head.sha && !await knownBase(db, i.repo, i.base)) throw new BuildError(400, `base must be a default-branch commit AutoCraft has seen; the current one is ${head.sha} (${head.branch}). Make the patch against it.`);
  const open = (await db.prepare(`SELECT COUNT(*) AS n FROM build_tasks WHERE step = ? AND state IN (${OPEN_STATES.map(() => "?").join(", ")})`).get(MCP_BUILD_STEP, ...OPEN_STATES) as { n: number }).n;
  if (open >= MAX_OPEN) throw new BuildError(429, `${MAX_OPEN} builds from agents are already queued or running; wait for one to end`);
  return await createTask(db, {
    step: MCP_BUILD_STEP, repo: i.repo, headSha: i.base, baseSha: i.base, requires: { os: "linux", toolchains: ["rust-stable"] },
    plan: buildPlan(i.steps, i.stepMinutes), ...(i.patch !== undefined && { patch: i.patch }), warm: { key: warmKeyOf(i.repo), role: "use" },
  });
}

/** A build from these tools by id; 404 for any other task, so these tools reach nothing else. */
export async function ownBuild(db: Db, id: unknown): Promise<BuildTask> {
  const n = typeof id === "number" ? id : typeof id === "string" && /^\d{1,12}$/.test(id) ? Number(id) : NaN;
  const t = Number.isInteger(n) ? await getTask(db, n) : null;
  if (!t || t.step !== MCP_BUILD_STEP) throw new BuildError(404, `no build ${String(id).slice(0, 40)}`);
  return t;
}

export type LineResult = { line: number; command: string; exitCode: number | null; seconds: number | null; state: "ok" | "failed" | "timed out" | "running" | "not run" };
export type BuildStatus = { task: BuildTask; done: boolean; ok: boolean | null; lines: LineResult[]; log: string; logTruncated: boolean };

/** What the build did: each line's exit code (from its artifact), time and state, and the end of the log. */
export async function buildStatus(db: Db, t: BuildTask, logLines: number = LOG_LINES.default): Promise<BuildStatus> {
  const done = TERMINAL.includes(t.state);
  const results = new Map<string, TaskResult>(t.results.map((r) => [r.step, r]));
  const fetch = results.get("fetch deps");
  const lines: LineResult[] = [];
  for (const [i, step] of t.plan.slice(1).entries()) {
    const r = results.get(step.name);
    const command = step.cmd[4] ?? "";
    const exitText = r ? (await artifactText(db, t.id, exitName(i)))?.trim() : undefined;
    const exitCode = exitText !== undefined && /^\d{1,3}$/.test(exitText) ? Number(exitText) : null;
    const seconds = r ? Math.round(r.durationMs / 1000) : null;
    const state: LineResult["state"] = r?.timedOut ? "timed out" : r ? (exitCode === 0 ? "ok" : "failed") : !done ? "running" : "not run";
    lines.push({ line: i + 1, command, exitCode, seconds, state });
  }
  const ok = !done ? null : t.state === "done" && !!fetch && fetch.exitCode === 0 && lines.every((l) => l.state === "ok");
  const tail = await logTail(db, t.id);
  const n = Math.min(Math.max(1, Math.trunc(logLines) || LOG_LINES.default), LOG_LINES.max);
  const all = tail.text.replace(/\s+$/, "").split("\n");
  return { task: t, done, ok, lines, log: all.slice(-n).join("\n"), logTruncated: tail.truncated || all.length > n };
}

export const MAX_LOG_LINES = LOG_LINES.max;

/** Cancels an open build from these tools. */
export async function cancelBuild(db: Db, t: BuildTask, by: string): Promise<BuildTask> {
  if (TERMINAL.includes(t.state)) throw new BuildError(409, `build ${t.id} already ended (${t.state})`);
  return await cancelTask(db, t.id, by);
}
