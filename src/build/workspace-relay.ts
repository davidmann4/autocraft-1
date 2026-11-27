// The relay between a session's workspace tools and the job that owns the workspace. The dashboard queues each tool call
// as a workspace_calls row and waits for its result; the job process waiting on the remote call (awaitCall) claims the
// rows and runs them on its WorkspaceSession, which settles each row (state and result). The rows are the record a resume reads; the wake only
// shortens the waits. On Postgres both sides wake on NOTIFY and poll slowly behind it; on SQLite both poll at the model
// queue's interval. workspace_calls is in no change topic, so the relay's writes never wake the planner.
import { allocation } from "../agents/call.ts";
import type { Db } from "../db/index.ts";
import {
  addWorkspaceCalls, claimQueuedCalls, countKeptImages, loadCallResult, loadRunningCalls, loadWorkspaces, markCalls, pruneWorkspaceImageBatch, refuseQueuedCalls, stubbedImages, stubImages as stubRows,
} from "../data/build/index.ts";
import { scaled } from "../remote/time-scale.ts";
import { assertFence } from "../db/fence.ts";
import { guardedApi, inClusterApi } from "./kube-api.ts";
import { WorkspaceSession, type ToolImage, type WorkspaceToolResult } from "./workspace-tools.ts";
import { capJson, LIVE_STATES } from "./workspaces.ts";

/** Dashboard to job: a tool call was queued. Payload: the workspace id. */
export const CALL_CHANNEL = "workspace_call";
/** Job to dashboard: a tool call has its result. Payload: the workspace_calls id. */
export const REPLY_CHANNEL = "workspace_reply";

/** How often the waiting dashboard request calls `tick` (the HTTP layer writes a keep-alive byte). */
const TICK_MS = scaled(15_000);
/** The poll behind the wake on Postgres; while a side is not listening (connecting, or the connection failed) it polls at the model queue's interval. */
const SAFETY_POLL_MS = scaled(10_000);
/** A session's first images keep their bytes on the row, for the Workspaces page; later ones keep only type, size and hash. */
export const KEPT_IMAGES = 60;
/** Kept image bytes are dropped this long after their workspace ended. */
export const IMAGE_KEEP_MS = 30 * 24 * 3600_000;

/** What the job runs a tool call on: a WorkspaceSession, or a stand-in in tests. */
export type ToolSession = Pick<WorkspaceSession, "call">;

const refusal = (why: string): WorkspaceToolResult => ({ text: `refused: ${why}`, isError: true });
const iso = (): string => new Date().toISOString();

/** The live workspace bound to a remote call, if any. */
async function boundWorkspace(db: Db, callId: number): Promise<{ id: number } | undefined> {
  return [...(await loadWorkspaces(db, { remoteCallIds: [callId] })).values()].find((w) => (LIVE_STATES as readonly string[]).includes(w.state));
}

/** Resolves a waiter early: `poke` before `wait` makes the next wait return at once. */
class Waker {
  #poked = false;
  #fire: (() => void) | null = null;
  poke(): void {
    this.#poked = true;
    this.#fire?.();
  }
  async wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (!this.#poked && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(t);
          this.#fire = null;
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const t = setTimeout(done, ms);
        this.#fire = done;
        signal?.addEventListener("abort", done, { once: true });
      });
    }
    this.#poked = false;
  }
}

/** The model-facing part of a settled row's result (the session's bookkeeping stays in the row). */
function parseResult(text: string): WorkspaceToolResult {
  try {
    const o = JSON.parse(text) as WorkspaceToolResult;
    if (typeof o?.text === "string") {
      const images = Array.isArray(o.images) ? o.images.filter((i): i is ToolImage => typeof i?.data === "string" && typeof i.mimeType === "string") : [];
      return { text: o.text, ...(o.isError === true && { isError: true }), ...(images.length && { images }) };
    }
  } catch { /* below */ }
  return { text: "the tool's result is unreadable", isError: true };
}

// ---- the dashboard's side -------------------------------------------------------

/**
 * Dashboard side: queues tool `name` of the lease's workspace, with the arguments whole, and waits for the row's result.
 * `live` says whether the lease still holds (checked on each poll; a call still queued when it ends is withdrawn, one
 * already running is left to finish in the job), `signal` is the client going away, `tick` is called about every 15 s
 * while waiting.
 */
export async function relayWorkspaceCall(db: Db, lease: { id: number; runId: number | null }, name: string, args: unknown,
  opts: { live: () => Promise<boolean>; signal?: AbortSignal; tick?: () => void }): Promise<WorkspaceToolResult> {
  const ws = await boundWorkspace(db, lease.id);
  if (!ws) return refusal("this call has no live workspace");
  const waker = new Waker();
  let id = -1;
  const sub = db.listen(REPLY_CHANNEL, (p) => { if (p === null || p === String(id)) waker.poke(); });
  try {
    id = (await addWorkspaceCalls(db, [{
      workspace_id: ws.id, n: null, run_id: lease.runId, tool: name, args: JSON.stringify(args ?? {}), state: "queued", result: null, created_at: iso(), started_at: null, deadline_at: null, finished_at: null,
    }]))[0]!;
    await db.notify(CALL_CHANNEL, String(ws.id));
    let lastTick = Date.now(), listening = false;
    for (;;) {
      await waker.wait(Math.min(listening ? SAFETY_POLL_MS : allocation.pollMs, TICK_MS), opts.signal);
      // Read before the row: a result written after the read is then sure to wake the next wait.
      listening = sub?.listening() ?? false;
      const r = await db.fresh(() => loadCallResult(db, id));
      if ((r?.state === "done" || r?.state === "failed") && r.result) {
        const out = parseResult(r.result);
        if (out.images) await settleImages(db, ws.id, lease.runId, id, r.result);
        return out;
      }
      const gone = opts.signal?.aborted ? "the request was cancelled" : !r ? "the call is gone" : !await opts.live() ? "the lease is gone" : null;
      if (gone) {
        const withdrawn = await markCalls(db, [{ id, where: ["queued"], set: { state: "failed", result: JSON.stringify(refusal(gone)), finished_at: iso() } }]);
        return withdrawn.size ? refusal(gone) : { text: `call ${id} did not finish before ${gone}; it runs on in the workspace (for a shell command: shell_status ${id})`, isError: true };
      }
      if (opts.tick && Date.now() - lastTick >= TICK_MS) {
        lastTick = Date.now();
        opts.tick();
      }
    }
  } finally {
    sub?.off();
  }
}

/**
 * Once the session has a result's images, the row keeps their bytes while the session has kept fewer than KEPT_IMAGES;
 * past that it keeps only their type, size and hash. The rest of the result stays as the record.
 */
async function settleImages(db: Db, workspaceId: number, runId: number | null, id: number, stored: string): Promise<void> {
  if (await countKeptImages(db, workspaceId, runId, id) < KEPT_IMAGES) return;
  const stubbed = stubbedImages(stored, "session image limit");
  if (stubbed !== null) await stubRows(db, [{ id, stored, stubbed }]);
}

/** Drops the image bytes of calls in workspaces that ended more than IMAGE_KEEP_MS ago. Returns the rows changed. */
export async function pruneWorkspaceImages(db: Db, nowMs: number = Date.now()): Promise<number> {
  let n = 0, last = 0;
  for (;;) {
    const r = await pruneWorkspaceImageBatch(db, nowMs, last);
    if (!r.rows) return n;
    n += r.rows;
    last = r.last;
  }
}

// ---- the job's side -------------------------------------------------------------

const sessions = new WeakMap<Db, Map<number, ToolSession>>();

/**
 * The job process's session on a workspace, kept for the process's life so its limits and queue span every turn. A
 * runner outside the cluster cannot exec in the pod and refuses every call.
 */
export function jobSession(db: Db, workspaceId: number): ToolSession {
  let m = sessions.get(db);
  if (!m) sessions.set(db, m = new Map());
  let s = m.get(workspaceId);
  if (!s) {
    const api = inClusterApi();
    // A job inherits its runner's fence (AUTOCRAFT_FENCE): once another copy leads, its commands no longer reach the pod.
    s = api ? new WorkspaceSession(db, guardedApi(api, () => assertFence(db)), workspaceId) : { call: async () => refusal("this runner is not in the cluster, so it cannot reach the workspace") };
    m.set(workspaceId, s);
  }
  return s;
}

const parseArgs = (text: string): unknown => {
  try { return JSON.parse(text); } catch { return null; }
};

/**
 * Job side: serves the workspace bound to one remote call while the job waits for that call. `serve` claims the queued
 * calls that came under the call's live lease and runs them side by side on the session (which queues beyond its own
 * limit and settles each row); a call from an earlier lease is left for its dashboard request to withdraw. `end` answers
 * what is still queued.
 */
export class WorkspaceServer {
  readonly db: Db;
  readonly callId: number;
  readonly workspaceId: number;
  readonly session: ToolSession;
  #sub: { off(): void } | null = null;
  /** Rows this process handed to the session and that have not settled. */
  readonly #running = new Set<number>();

  private constructor(db: Db, callId: number, workspaceId: number, session: ToolSession) {
    this.db = db;
    this.callId = callId;
    this.workspaceId = workspaceId;
    this.session = session;
  }

  /**
   * The server of the workspace bound to `callId`, listening for its calls; null when no live workspace is bound to it.
   * First it takes over the rows of the lease that an earlier process of the job left running (a runner restart): a shell
   * command the session started is handed back to it, which re-attaches instead of running it again; any other such call
   * is failed, since its outcome is unknown and its stored arguments are cut.
   */
  static async open(db: Db, callId: number, sessionOf: (db: Db, workspaceId: number) => ToolSession = jobSession): Promise<WorkspaceServer | null> {
    const ws = await boundWorkspace(db, callId);
    if (!ws) return null;
    const s = new WorkspaceServer(db, callId, ws.id, sessionOf(db, ws.id));
    const left = await loadRunningCalls(db, ws.id, callId);
    for (const r of left) {
      if (r.n !== null) s.#run(r.id, r.tool, parseArgs(r.args));
      else if (await s.#settle(r.id, "failed", { text: "failed: the runner restarted while this call ran, so its outcome is unknown; check the workspace and call it again", isError: true })) await db.notify(REPLY_CHANNEL, String(r.id));
    }
    s.#sub = db.listen(CALL_CHANNEL, (p) => { if (p === null || p === String(ws.id)) void s.serve().catch(() => { /* the next poll serves */ }); });
    return s;
  }

  /** Calls still running on the session. */
  get running(): number {
    return this.#running.size;
  }

  async serve(): Promise<void> {
    const { db } = this;
    // One transaction: a call claimed by a pass that then fails would stay running with nothing that runs it.
    const parsed = await db.write(async () => {
      const rows = (await claimQueuedCalls(db, this.workspaceId, this.callId)).filter((r) => !this.#running.has(r.id));
      // The session gets the whole arguments; the row keeps them cut to its record size.
      const parsed = rows.map((r) => ({ ...r, parsed: parseArgs(r.args) }));
      if (parsed.length) await markCalls(db, parsed.map((r) => ({ id: r.id, set: { args: JSON.stringify(capJson(r.parsed ?? {})) } })));
      return parsed;
    });
    for (const r of parsed) this.#run(r.id, r.tool, r.parsed);
  }

  /** Runs one claimed row on the session and wakes the dashboard. A row the session left unsettled gets the result it returned. */
  #run(id: number, tool: string, args: unknown): void {
    this.#running.add(id);
    void this.session.call(tool, args, id)
      .then(async (res) => { await this.#settle(id, "done", res); }, async (e: unknown) => {
        await this.#settle(id, "failed", { text: `failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`, isError: true });
      })
      .then(async () => await this.db.notify(REPLY_CHANNEL, String(id)))
      .catch(() => { /* the database is closed: the process is ending */ })
      .finally(() => this.#running.delete(id));
  }

  /** Settles a row that is still queued or running; true when it did. */
  async #settle(id: number, state: "done" | "failed", res: WorkspaceToolResult): Promise<boolean> {
    return (await markCalls(this.db, [{ id, where: ["queued", "running"], set: { state, result: JSON.stringify(res), finished_at: iso() } }])).has(id);
  }

  /**
   * The call has ended: stops listening and refuses the calls of its last lease that nobody will run. Refusing needs no
   * live lease, since nothing runs. Calls running on the session finish and settle their rows.
   */
  async end(): Promise<void> {
    try {
      this.#sub?.off();
    } finally {
      this.#sub = null;
    }
    const { db } = this;
    const refused = await refuseQueuedCalls(db, this.workspaceId, this.callId, JSON.stringify(refusal("the model call is over")));
    for (const id of refused) await db.notify(REPLY_CHANNEL, String(id));
  }
}
