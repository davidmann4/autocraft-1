// A model session in a workspace, recorded in workspace_sessions. `workspace try` (kind 'try') is the operator's test
// session: the CLI records the request, the `workspace-try` job creates or takes the workspace, waits for it to be ready,
// runs one bound remote call (served by awaitCall) and logs what the session did. The prompt is operator text: it goes
// into the call's stdin and so into its agent run's prompt text, which operators and maintainers can read, and never
// into job params, progress or the job log, which every signed-in user can read.
import { createHash } from "node:crypto";
import type { Db } from "../db/index.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { promptTier } from "../remote/bundle.ts";
import { inferenceMode } from "../remote/mode.ts";
import { noOwnRunnerReason, ownTaker } from "../remote/takers.ts";
import { awaitCall, type Outcome } from "../remote/calls.ts";
import type { JobState } from "../../web/src/api/types.ts";
import { trackedNames } from "../repos.ts";
import type { Params, StepContext } from "../runner/steps.ts";
import { BuildError } from "./envs.ts";
import { assertFence } from "../db/fence.ts";
import { guardedApi, inClusterApi } from "./kube-api.ts";
import { queueWorkspaceCall } from "./workspace-call.ts";
import { READY_LIMIT_MS, SEED_LIMIT_MS } from "./workspace-launch.ts";
import { OWN_CALLS, WORKSPACE_SERVER } from "./workspace-tools.ts";
import { cleanOutput, createWorkspace, endWorkspace, execWs, getWorkspace, LIVE_STATES, refuseWarmWriter, resumeWorkspace, type WorkspaceStateName } from "./workspaces.ts";

export const TRY_STEP = "workspace-try";
export const TRY_PROMPT_ID = "workspace.try";
/** The session call's time limit in seconds. */
export const TRY_DEADLINE_SEC = { min: 300, max: 7200, default: 3600 } as const;
export const TRY_PROMPT_MAX_BYTES = 8 * 1024;
const TRY_MAX_TURNS = 400;
const READY_POLL_MS = 3000;
/** The most a session call may wait in the remote call queue in all; past it the call is withdrawn and the session fails. */
export const TRY_QUEUE_WAIT_MS = 30 * 60_000;
/**
 * The pod's time limit (activeDeadlineSeconds, counted from its start) over the call's attempts: seeding, the call's longest
 * wait in the queue, and a margin for the lease's start and end, so the call's own limit or the queue wait ends the session first.
 */
const POD_MARGIN_SEC = (SEED_LIMIT_MS + TRY_QUEUE_WAIT_MS) / 1000 + 10 * 60;
/** Workspaces a try can take: live ones; a parked one is resumed. */
const TAKEN_STATES = LIVE_STATES as string[];
/** Attempts of the session's call: a lease lost with its Task Runner goes back to the queue once, onto the same workspace. */
const TRY_ATTEMPTS = 2;

/** Implementation work's model choice: the implement.session prompt's model, effort and tier. */
const IMPLEMENT = CLAUDE_PROMPTS["implement.session"];

const SYSTEM = `You work in a workspace: a checkout of {{repo}} at commit {{sha}} in /work/src, in a container with no network access. The task is for {{repo}}#{{item}}.

Your only tools are the mcp__${WORKSPACE_SERVER}__* tools: shell (bash, run in /work/src), shell_status and shell_kill (for commands started with background), read, write, edit, glob and grep, and app_start, screenshot and app_stop to run a GUI app on a virtual display and look at it (drive the app through its own CLI with shell). Paths are absolute below /work, or relative to /work/src. Nothing outside the workspace can be reached, so do not try to fetch or install anything.

These tools are the only way to see or change the code: call them as tools, never write a tool call or its result as text. If you have none of them, or they all fail, say so in one line and stop.

Do the task the user gives you. Finish with a short summary of what you changed and why, and what you ran to check it.`;
const SYSTEM_VERSION = createHash("sha256").update(SYSTEM).digest("hex").slice(0, 10);

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const SHA = /^[0-9a-f]{40}$/;
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type TryRequest = {
  repo: string; baseSha: string; item: number; prompt: string; envId: string; keep: boolean; deadlineSec?: number;
  /** A live workspace of the same repo and base to use instead of a new one. */
  workspaceId?: number | null;
  /** The GitHub login whose own Task Runners run the session's model call. */
  forLogin: string;
  by: string;
};

/** Checks and records a try session; returns its id. The caller queues the `workspace-try` job with `{repo, session}`. */
export async function requestTrySession(db: Db, r: TryRequest): Promise<number> {
  if (!(await trackedNames(db)).includes(r.repo)) throw new BuildError(400, `${r.repo} is not a tracked repo`);
  if (!GITHUB_LOGIN.test(r.forLogin)) throw new BuildError(400, "--for must be a GitHub login");
  if (!SHA.test(r.baseSha)) throw new BuildError(400, "the base must be a full 40-character commit sha");
  if (!Number.isInteger(r.item) || r.item < 1) throw new BuildError(400, "the item must be an issue or PR number");
  if (!await db.get(db.k.selectFrom("items").select("number").where("repo", "=", r.repo).where("number", "=", r.item))) throw new BuildError(404, `${r.repo}#${r.item} is not in the mirror`);
  // Checked at the request: a call bound to this user that none of their runners may take would wait queued for ever.
  // Only their runners count, whatever their My repos say (the call is bound to them).
  if (await inferenceMode(db) === "user-local" && !await ownTaker(db, r.forLogin, { prompt_id: TRY_PROMPT_ID, repos: [r.repo], tier: promptTier("implement.session") }))
    throw new BuildError(409, noOwnRunnerReason(r.forLogin));
  const bytes = Buffer.byteLength(r.prompt, "utf8");
  if (!r.prompt.trim()) throw new BuildError(400, "the prompt is empty");
  if (bytes > TRY_PROMPT_MAX_BYTES) throw new BuildError(400, `the prompt is ${bytes} bytes; at most ${TRY_PROMPT_MAX_BYTES}`);
  const deadline = r.deadlineSec ?? TRY_DEADLINE_SEC.default;
  if (!Number.isInteger(deadline) || deadline < TRY_DEADLINE_SEC.min || deadline > TRY_DEADLINE_SEC.max) throw new BuildError(400, `the deadline must be ${TRY_DEADLINE_SEC.min} to ${TRY_DEADLINE_SEC.max} seconds`);
  let envId = r.envId;
  if (r.workspaceId != null) {
    const w = await getWorkspace(db, r.workspaceId);
    if (!w) throw new BuildError(404, `no workspace ${r.workspaceId}`);
    if (!TAKEN_STATES.includes(w.state)) throw new BuildError(409, `workspace ${w.id} is ${w.state}`);
    if (w.repo !== r.repo || w.base_sha !== r.baseSha) throw new BuildError(409, `workspace ${w.id} holds ${w.repo} at ${w.base_sha.slice(0, 8)}, not ${r.repo} at ${r.baseSha.slice(0, 8)}`);
    envId = w.env_id;
  }
  if (envId) await refuseWarmWriter(db, envId);
  const at = iso();
  const row = await db.get(db.k.insertInto("workspace_sessions").values({
    kind: "try", repo: r.repo, base_sha: r.baseSha, item: r.item, prompt: r.prompt, env_id: envId, keep: r.keep ? 1 : 0, deadline_sec: deadline,
    workspace_id: r.workspaceId ?? null, requested_by: r.by, for_login: r.forLogin, created_at: at, updated_at: at,
  }).returning("id"));
  return Number(row!.id);
}

/** The step's check: the session exists for the repo and has not ended. */
export async function checkTrySession(db: Db, p: Params): Promise<string | null> {
  const s = await db.get(db.k.selectFrom("workspace_sessions").select(["repo", "kind", "state"]).where("id", "=", Number(p.session)));
  if (!s || s.kind !== "try" || s.repo !== p.repo) return "no such try session";
  return s.state === "done" || s.state === "failed" ? `the session already ended (${s.state})` : null;
}

class SessionEnd extends Error {}

/** The `workspace-try` job. Returns the one-line summary; throws when the session did not run to a reply. */
export async function runTrySession(ctx: StepContext): Promise<string> {
  const db = ctx.db, id = Number(ctx.params.session);
  const s = await db.get(db.k.selectFrom("workspace_sessions").selectAll().where("id", "=", id));
  if (!s || s.prompt === null) throw new Error(`no try session ${id}`);
  const update = async (set: { state?: string; outcome?: string; workspace_id?: number; remote_call_id?: number; ended_at?: string }) =>
    await db.run(db.k.updateTable("workspace_sessions").set({ ...set, updated_at: iso() }).where("id", "=", id));
  // One job runs a session: the first to claim it, or the same job resumed. Another job stops here and touches nothing.
  const claimed = await db.get(db.k.updateTable("workspace_sessions").set({ job_id: ctx.job.id, updated_at: iso() })
    .where("id", "=", id).where((eb) => eb.or([eb("job_id", "is", null), eb("job_id", "=", ctx.job.id)])).where("state", "in", ["queued", "starting", "running"])
    .returning("state"));
  if (!claimed) throw new Error(`session ${id} belongs to another job or has ended`);
  if (claimed.state === "queued") await update({ state: "starting" });
  const model = IMPLEMENT.models[0]!;
  ctx.log(`session ${id}: ${s.repo}#${s.item} at ${s.base_sha.slice(0, 8)}, ${model} (effort ${IMPLEMENT.effort}), time limit ${s.deadline_sec} s${s.keep ? ", workspace kept" : ""}`);

  let wsId = s.workspace_id;
  const finish = async (state: "done" | "failed", outcome: string): Promise<void> => {
    await update({ state, outcome: outcome.slice(0, 300), ended_at: iso() });
    if (wsId === null) return;
    if (!s.keep) {
      if (await endWorkspace(db, wsId)) ctx.log(`workspace ${wsId} ended`);
    } else if (LIVE_STATES.includes((await getWorkspace(db, wsId))?.state as WorkspaceStateName)) ctx.log(`workspace ${wsId} kept: end it with \`workspace end ${wsId}\``);
  };
  const fail = async (outcome: string): Promise<never> => {
    await finish("failed", outcome);
    throw new SessionEnd(`session ${id}: ${outcome}`);
  };

  try {
    let callId = s.remote_call_id;
    if (callId !== null) ctx.log(`session ${id}: resuming with model call ${callId}`);
    else {
      if (wsId === null) {
        // The workspace and the session's link to it in one write, so a resumed job takes the same workspace.
        wsId = await db.write(async () => {
          const w = await createWorkspace(db, { repo: s.repo, baseSha: s.base_sha, envId: s.env_id, limits: { deadlineSec: s.deadline_sec * TRY_ATTEMPTS + POD_MARGIN_SEC }, owner: `job ${ctx.job.id}` });
          await update({ workspace_id: w });
          return w;
        });
        ctx.log(`workspace ${wsId} requested on ${s.env_id}`);
      }
      // An external wait (registry GLOBAL_WAITS "Workspace start"): the launcher moves the row and fails it past its own limits.
      const waitFrom = Date.now();
      for (let last = "";;) {
        const w = await getWorkspace(db, wsId);
        if (!w) return await fail(`workspace ${wsId} is gone`);
        if (w.state === "ready") break;
        if (w.state === "parked") {
          if (!await resumeWorkspace(db, wsId)) return await fail(`workspace ${wsId} is parked and could not be resumed${w.error ? `: ${w.error}` : ""}`);
          ctx.log(`workspace ${wsId} parked; resuming it`);
        }
        if (!TAKEN_STATES.includes(w.state)) return await fail(`workspace ${wsId} is ${w.state}${w.error ? `: ${w.error}` : ""}`);
        if (Date.now() - waitFrom > READY_LIMIT_MS) return await fail(`workspace ${wsId} was not ready within ${Math.round(READY_LIMIT_MS / 60_000)} min (still ${w.state})`);
        if (await ctx.cancelled()) return await fail("cancelled while the workspace started");
        if (w.state !== last) {
          last = w.state;
          await ctx.progress(`session ${id}: workspace ${wsId} ${w.state}`);
          ctx.log(`workspace ${wsId}: ${w.state}`);
        }
        await sleep(READY_POLL_MS);
      }
      ctx.log(`workspace ${wsId} ready`);

      const system = SYSTEM.replaceAll("{{repo}}", s.repo).replace("{{sha}}", s.base_sha).replace("{{item}}", String(s.item));
      callId = await queueWorkspaceCall(db, {
        workspaceId: wsId, promptId: TRY_PROMPT_ID, promptVersion: SYSTEM_VERSION, model, tier: promptTier("implement.session"), effort: IMPLEMENT.effort,
        stdin: s.prompt, system, timeoutSeconds: s.deadline_sec, maxTurns: TRY_MAX_TURNS, items: [{ repo: s.repo, number: s.item }], maxAttempts: TRY_ATTEMPTS,
        forLogin: s.for_login ?? undefined, boundSlot: true,
      });
      await update({ remote_call_id: callId, state: "running" });
      ctx.log(`session ${id}: model call ${callId} queued`);
    }
    if (wsId === null) return await fail("the session has a model call but no workspace");
    await ctx.progress(`session ${id}: model call ${callId} in workspace ${wsId}`);
    ctx.handled(1);
    let out: Outcome;
    try {
      // A resumed job waits on the same call, even one that ended while no job waited (its outcome is read from the row).
      out = await awaitCall(db, callId, { log: ctx.log, maxWaitMs: TRY_QUEUE_WAIT_MS });
    } catch (e) {
      // Withdrawn for want of a Task Runner or past the queue wait, cancelled or stopped: recorded, then the job ends the way the error says.
      await finish("failed", `the model call ended: ${(e as Error).message}`);
      throw e;
    }

    const outcome = describeOutcome(out);
    await update({ outcome: outcome.slice(0, 300) });
    ctx.log(`session ${id}: model call ${callId} ${outcome}`);
    if (out.state === "done" && out.text.trim()) ctx.log(`session ${id}: reply:\n${capReply(out.text.trim())}`);
    const stats = await sessionStats(db, wsId, callId);
    ctx.log(`session ${id}: ${stats.calls} workspace tool calls, ${formatMs(stats.shellMs)} of shell time`);
    const files = await logDiffStat(ctx, wsId);
    const line = `${outcome}; ${stats.calls} tool calls, ${formatMs(stats.shellMs)} shell${files !== null ? `; ${files}` : ""}`;
    if (out.state !== "done") return await fail(line);
    await finish("done", line);
    return `session ${id} in workspace ${wsId}: ${line}`;
  } catch (e) {
    if (e instanceof SessionEnd) throw e;
    const st = await db.get(db.k.selectFrom("workspace_sessions").select("state").where("id", "=", id));
    if (st && st.state !== "failed" && st.state !== "done") await finish("failed", (e as Error).message ?? String(e));
    throw e;
  }
}

const REPLY_CAP_BYTES = 4096;

/** A try session's reply text cut to REPLY_CAP_BYTES (on a character boundary), with a marker that says how long it was. */
export function capReply(text: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= REPLY_CAP_BYTES) return text;
  return `${Buffer.from(text, "utf8").subarray(0, REPLY_CAP_BYTES).toString("utf8").replace(/\uFFFD+$/, "")}\n(cut, ${bytes} bytes)`;
}

function describeOutcome(o: Outcome): string {
  if (o.state === "done") return `done${o.turns !== null ? ` in ${o.turns} turns` : ""}${o.costUsd !== null ? `, $${o.costUsd.toFixed(2)}` : ""}`;
  if (o.state === "failed") return `failed: ${cleanOutput(Buffer.from(o.error)).replace(/\s+/g, " ").slice(0, 200)}`;
  return "not taken by the session's Task Runner";
}

const formatMs = (ms: number): string => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

/**
 * Tool calls of the session's model call and their shell time, from the workspace's call rows since the call was queued:
 * foreground commands' run time, and background commands' once a shell_status or shell_kill saw them end.
 */
export async function sessionStats(db: Db, workspaceId: number, callId: number): Promise<{ calls: number; shellMs: number }> {
  const since = (await db.get(db.k.selectFrom("remote_calls").select("since").where("id", "=", callId)))?.since;
  const rows = await db.all(db.k.selectFrom("workspace_calls").select(["tool", "result"]).where("workspace_id", "=", workspaceId)
    .where("tool", "not in", OWN_CALLS).$if(since != null, (q) => q.where("created_at", ">=", iso(Number(since)))));
  let fg = 0;
  const bg = new Map<number, number>();
  for (const r of rows) {
    let acct: { ms?: unknown; ref?: unknown; ended?: unknown; bg?: unknown } = {};
    try {
      acct = ((JSON.parse(r.result ?? "{}") as { acct?: typeof acct }).acct) ?? {};
    } catch { /* not JSON */ }
    const ms = typeof acct.ms === "number" ? acct.ms : 0;
    if (r.tool === "shell" && acct.bg !== 1) fg += ms;
    else if ((r.tool === "shell_status" || r.tool === "shell_kill") && acct.ended === 1 && typeof acct.ref === "number") bg.set(acct.ref, Math.max(bg.get(acct.ref) ?? 0, ms));
  }
  return { calls: rows.length, shellMs: fg + [...bg.values()].reduce((a, b) => a + b, 0) };
}

const DIFF_SCRIPT = `git -C /work/src diff --stat "$1" && git -C /work/src ls-files --others --exclude-standard | sed 's/^/new file: /' | head -n 100`;

/** Logs the session's change against the base commit (tracked and new files) and returns the stat's last line, or null. */
async function logDiffStat(ctx: StepContext, wsId: number): Promise<string | null> {
  const cluster = inClusterApi();
  if (!cluster) {
    ctx.log("diff stat: this runner is not in the cluster, so it cannot reach the workspace");
    return null;
  }
  const api = guardedApi(cluster, () => assertFence(ctx.db));
  const w = await getWorkspace(ctx.db, wsId);
  if (!w || w.state !== "ready") {
    ctx.log(`diff stat: workspace ${wsId} is ${w?.state ?? "gone"}`);
    return null;
  }
  const base = w.base_commit && SHA.test(w.base_commit) ? w.base_commit : "HEAD";
  try {
    const r = await execWs(ctx.db, api, wsId, ["run", "60", "--", "bash", "-c", DIFF_SCRIPT, "diff-stat", base], { tool: "report", args: { report: "diff-stat" }, timeoutMs: 70_000 });
    const lines = r.output.split("\n").filter((l) => l.trim()).slice(0, 200);
    ctx.log(`git diff --stat ${base.slice(0, 8)}:`);
    for (const l of lines) ctx.log(`  ${l}`);
    if (!lines.length) ctx.log("  (no changes)");
    if (r.error) ctx.log(`diff stat: ${r.error}`);
    const summary = lines.find((l) => /\d+ files? changed/.test(l));
    const added = lines.filter((l) => l.startsWith("new file: ")).length;
    return summary || added ? [summary?.trim(), added ? `${added} new files` : ""].filter(Boolean).join(", ") : "no changes";
  } catch (e) {
    ctx.log(`diff stat: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Ends the sessions whose job ended without ending them: a job stopped by its deadline, a cancel or a runner stop that
 * it may not resume from exits without running the session's own cleanup. Each is marked failed and its workspace ended
 * unless kept. A job queued to resume keeps its session. Run on the launcher's passes; returns the sessions ended.
 */
export async function sweepSessions(db: Db, log: (line: string) => void = () => {}): Promise<number> {
  const rows = await db.all(db.k.selectFrom("workspace_sessions as s").innerJoin("jobs as j", "j.id", "s.job_id")
    .select(["s.id", "s.workspace_id", "s.keep", "j.id as job", "j.state as job_state", "j.error"])
    .where("s.state", "not in", ["done", "failed"]).where("j.state", "in", ["done", "failed", "cancelled"] satisfies JobState[]));
  let n = 0;
  for (const r of rows) {
    const outcome = `job ${r.job} ended (${r.job_state}${r.error ? `: ${r.error}` : ""}) before the session did`.slice(0, 300);
    const at = iso();
    const ch = await db.run(db.k.updateTable("workspace_sessions").set({ state: "failed", outcome, ended_at: at, updated_at: at })
      .where("id", "=", r.id).where("state", "not in", ["done", "failed"]));
    if (!ch.changes) continue;
    n++;
    const ended = r.workspace_id !== null && !r.keep && await endWorkspace(db, r.workspace_id);
    log(`workspace sessions: session ${r.id} failed: ${outcome}${ended ? `; workspace ${r.workspace_id} ended` : ""}`);
  }
  return n;
}
