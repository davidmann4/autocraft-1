// The per-lease tools of a remote call (src/remote/protocol.ts ROUTES.tool and ROUTES.mcp): the item tools over the
// snapshot, the repo's reference documentation, the `check` build tool and the workspace tools, each served only to a call
// whose bundle lists its server. The first two and the tarball mounts read the runner's disk (the snapshot, the diff
// cache, the reference index, the clones): the dashboard serves them itself when it shares that disk, and otherwise asks
// the runner's worker API (AUTOCRAFT_RUNNER_URL, src/build/worker-api.ts /remote/), which checks the lease again. `check`
// is relayed to the job process that holds the call's CheckTool, and the workspace tools to the job that owns the
// workspace (src/build/workspace-relay.ts).
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { finished, PassThrough, Readable } from "node:stream";
import { dirname, join } from "node:path";
import { CHECK_SERVER } from "../checktool/bridge.ts";
import { TOOL as CHECK_TOOL } from "../checktool/server/tool.ts";
import { fixupDir, GIT_ENV, gitDirEnv, HARDENING } from "../fixup/git.ts";
import { ITEM_SERVER } from "../itemtools/index.ts";
import { TOOLS as ITEM_TOOLS, type ToolResult } from "../itemtools/server/tools.ts";
import type { ItemsCall } from "./items-worker.ts";
import { ThreadCall } from "../thread-call.ts";
import { snapshotFile } from "../itemtools/snapshot.ts";
import { MAX_AROUND, MAX_RESULTS, referenceAround, referenceSearch, type Passage, type SearchOptions } from "../data/external/index.ts";
import { diffCacheDir } from "../review/diff.ts";
import { REFERENCE_SERVER } from "./bundle.ts";
import { relayCheck } from "./check-relay.ts";
import { relayWorkspaceCall } from "../build/workspace-relay.ts";
import { WORKSPACE_SERVER, WORKSPACE_TOOLS, type WorkspaceToolResult } from "../build/workspace-tools.ts";
import type { Mount, TaskBundle } from "./protocol.ts";
import type { Db } from "../db/index.ts";
import { addPassages, loadLeaseBundle, loadLiveLease, loadPassageCount } from "../data/runners/index.ts";
import { envVar } from "../env.ts";

export type { ToolResult };

/** Reference passages one lease may read in all. */
export const PASSAGES_PER_LEASE = 60;
/** Options of the reference search (tests give an embedder and an index file). */
export const referenceOptions: SearchOptions = {};

const REFERENCE_TOOLS = [
  {
    name: "reference_search",
    description: "Searches the reference documentation of the repo's original application. Returns passages (id, page title, text), best match first. Read it to understand how the original behaves; never quote, cite or name it in your answer. The number of passages per call is limited in all.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["query"],
      properties: {
        query: { type: "string", description: "What to look for, in plain words." },
        limit: { type: "integer", description: `At most this many passages (default 5, max ${MAX_RESULTS}).` },
      },
    },
  },
  {
    name: "reference_around",
    description: "The passages before and after one passage on the same page, in page order, to read past a search result.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["passage"],
      properties: {
        passage: { type: "integer", description: "A passage id from reference_search." },
        before: { type: "integer", description: `Passages before it (default 1, max ${MAX_AROUND}).` },
        after: { type: "integer", description: `Passages after it (default 1, max ${MAX_AROUND}).` },
      },
    },
  },
];

/** The tool definitions of each task server, as tools/list returns them. */
export const TASK_TOOLS: Record<string, readonly unknown[]> = { [ITEM_SERVER]: ITEM_TOOLS, [CHECK_SERVER]: [CHECK_TOOL], [REFERENCE_SERVER]: REFERENCE_TOOLS, [WORKSPACE_SERVER]: WORKSPACE_TOOLS };

export type TaskLease = { id: number; runId: number | null; login: string; servers: string[]; mounts: Mount[]; referenceRepo: string | null };

/** The live lease of a secret with what its tools need from the call, or null. */
export async function taskLease(db: Db, secret: string | undefined): Promise<TaskLease | null> {
  const f = secret ? await loadLeaseBundle(db, secret, Date.now()) : null;
  if (!f) return null;
  const b = JSON.parse(f.bundle) as Omit<TaskBundle, "callId">;
  return { id: f.lease.id, runId: f.lease.runId, login: f.lease.login, servers: b.mcpServers, mounts: b.mounts, referenceRepo: f.referenceRepo };
}

class BadArgs extends Error {}

const int = (o: Record<string, unknown>, k: string, dflt: number): number => {
  const v = o[k];
  if (v === undefined) return dflt;
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 1e9) throw new BadArgs(`"${k}" must be a non-negative integer`);
  return v as number;
};

function object(raw: unknown, allowed: string[]): Record<string, unknown> {
  const o = raw ?? {};
  if (typeof o !== "object" || Array.isArray(o)) throw new BadArgs("arguments must be an object");
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new BadArgs(`unknown argument "${k}"`);
  return o as Record<string, unknown>;
}

const passageText = (p: Passage): string => `passage ${p.id}: ${p.title} (${p.page})\n${p.text}`;

/** Passages promised to calls still searching, per lease, so parallel calls cannot together exceed the allowance. */
const reserved = new Map<string, number>();

/** Serves reference passages within the lease's allowance and records each one. */
async function reference(db: Db, lease: TaskLease, name: string, raw: unknown): Promise<ToolResult> {
  const repo = lease.referenceRepo;
  if (!repo) return { text: "this call has no reference documentation", isError: true };
  const used = await loadPassageCount(db, lease.id, lease.runId);
  const key = `${lease.id}:${lease.runId}`;
  const left = PASSAGES_PER_LEASE - Number(used) - (reserved.get(key) ?? 0);
  if (left <= 0) return { text: `refused: the ${PASSAGES_PER_LEASE} reference passages of this call are used up; answer with what you know`, isError: true };
  // Reserve before the first await; the part not served is released in `finally`.
  reserved.set(key, (reserved.get(key) ?? 0) + left);
  let served: Passage[] = [];
  let found: Passage[] = [];
  try {
    if (name === "reference_search") {
      const a = object(raw, ["query", "limit"]);
      if (typeof a.query !== "string" || !a.query.trim() || a.query.length > 500) throw new BadArgs('"query" must be a string of at most 500 characters');
      found = await referenceSearch(repo, a.query, Math.min(int(a, "limit", 5), MAX_RESULTS), referenceOptions);
    } else {
      const a = object(raw, ["passage", "before", "after"]);
      if (a.passage === undefined) throw new BadArgs('missing argument "passage"');
      found = referenceAround(repo, int(a, "passage", 0), int(a, "before", 1), int(a, "after", 1), referenceOptions);
    }
    served = found.slice(0, left);
    const now = Date.now();
    await addPassages(db, served.map((p) => ({ callId: lease.id, runId: lease.runId, login: lease.login, repo, passageId: p.id, page: p.page, at: now })));
  } finally {
    const rest = (reserved.get(key) ?? 0) - left;
    if (rest > 0) reserved.set(key, rest);
    else reserved.delete(key);
  }
  if (!served.length) return { text: name === "reference_search" ? "No passage matches." : "No passage next to it." };
  const cut = served.length < found.length ? `\n\n[${found.length - served.length} more passages withheld: the ${PASSAGES_PER_LEASE} passages of this call are used up]` : "";
  return { text: served.map(passageText).join("\n\n") + cut };
}

// One worker for the item tools of this process; it opens the snapshot on its first call. A read can wait up to the
// snapshot's 30 s busy timeout while a refresh writes; the call limit leaves room for that wait plus the query, and stays
// under the runner's tool timeout so the caller gets this error instead of a dropped request.
const ITEMS_CALL_TIMEOUT_MS = 50_000;
const itemsThread = new ThreadCall<ItemsCall, ToolResult>(new URL("./items-worker.ts", import.meta.url), "item tools", undefined, { timeoutMs: ITEMS_CALL_TIMEOUT_MS });
const items = (name: string, raw: unknown): Promise<ToolResult> => itemsThread.call({ file: snapshotFile(), diffs: diffCacheDir(), name, raw });

/** The runner's worker API, for a dashboard that does not share the runner's disk (AUTOCRAFT_RUNNER_URL); null: the files are local. */
export const runnerUrl = (env: NodeJS.ProcessEnv = process.env): string | null => envVar("RUNNER_URL", env)?.replace(/\/+$/, "") || null;

/** Tool calls the runner answers within this; the item and reference tools read files and an index, nothing slower. */
const RUNNER_TOOL_TIMEOUT_MS = 60_000;

/** Runs an item or reference tool on the runner, which checks the lease again. */
async function runnerTool(base: string, secret: string, server: string, name: string, raw: unknown, signal?: AbortSignal): Promise<ToolResult> {
  const timeout = AbortSignal.timeout(RUNNER_TOOL_TIMEOUT_MS);
  const res = await fetch(`${base}/remote/tools/${server}/${name}`, {
    method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(raw ?? {}),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (res.status === 401 || res.status === 410) return { text: "the lease is gone", isError: true };
  if (!res.ok) throw new Error(`the runner answered ${res.status}`);
  const r = (await res.json()) as { text?: unknown; isError?: unknown };
  if (typeof r.text !== "string") throw new Error("the runner sent no tool result");
  return { text: r.text, ...(r.isError === true && { isError: true }) };
}

/**
 * Runs one tool of `server` for the lease, which must list the server. Bad arguments and refusals come back as an error
 * result. `check` and the workspace tools wait for a job process: `tick` is called about every 15 s meanwhile, and
 * `signal` ends the wait. Only workspace tools return images.
 */
export async function callTaskTool(db: Db, lease: TaskLease, secret: string, server: string, name: unknown, raw: unknown, opts: { signal?: AbortSignal; tick?: () => void; local?: boolean } = {}): Promise<WorkspaceToolResult> {
  const tools = TASK_TOOLS[server] as { name: string }[] | undefined;
  if (!tools || !lease.servers.includes(server)) return { text: `this call has no ${server} tools`, isError: true };
  if (typeof name !== "string" || !tools.some((t) => t.name === name)) return { text: `unknown tool ${JSON.stringify(name)}`, isError: true };
  try {
    const runner = opts.local ? null : runnerUrl();
    if (runner && (server === ITEM_SERVER || server === REFERENCE_SERVER)) return await runnerTool(runner, secret, server, name, raw, opts.signal);
    if (server === ITEM_SERVER) return await items(name, raw);
    if (server === REFERENCE_SERVER) return await reference(db, lease, name, raw);
    const live = async (): Promise<boolean> => (await db.fresh(() => loadLiveLease(db, secret, Date.now())))?.id === lease.id;
    if (server === WORKSPACE_SERVER) return await relayWorkspaceCall(db, { id: lease.id, runId: lease.runId }, name, raw, { live, ...opts });
    return await relayCheck(db, { id: lease.id, runId: lease.runId }, raw, { live, ...opts });
  } catch (e) {
    if (e instanceof BadArgs) return { text: e.message, isError: true };
    console.error(`task tool ${server}/${name}: ${(e as Error).stack ?? e}`);
    return { text: "the tool failed; the error is logged", isError: true };
  }
}

/** The runner's answer to a tarball request must begin within this. */
const RUNNER_HEADERS_MS = 30_000;

/** The runner no longer knows the lease (it ended while the dashboard asked). */
export class LeaseGone extends Error {
  constructor() { super("the lease is gone"); }
}

const ARCHIVE_SLOTS = 4;
/** Archives kept on disk (total bytes); the least recently used are removed first. */
const ARCHIVE_CACHE_BYTES = 2 * 1024 ** 3;
let archiveActive = 0;
const archiveWaiting: (() => void)[] = [];
const archiveDir = (): string => join(dirname(diffCacheDir()), "archives");

async function archiveSlot(): Promise<void> {
  if (archiveActive < ARCHIVE_SLOTS) archiveActive++;
  else await new Promise<void>((r) => archiveWaiting.push(r));
}
function archiveSlotDone(): void {
  const next = archiveWaiting.shift();
  if (next) next();
  else archiveActive--;
}

function pruneArchives(dir: string, keep: string): void {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".tar")).map((f) => ({ f, st: statSync(join(dir, f)) }));
    let total = files.reduce((n, x) => n + x.st.size, 0);
    for (const x of files.sort((a, b) => a.st.mtimeMs - b.st.mtimeMs)) {
      if (total <= ARCHIVE_CACHE_BYTES) break;
      if (x.f === keep) continue;
      rmSync(join(dir, x.f), { force: true });
      total -= x.st.size;
    }
  } catch { /* the cache is best effort */ }
}

const gitOk = (args: string[], env: NodeJS.ProcessEnv): Promise<boolean> =>
  new Promise((ok) => {
    const p = spawn("git", [...HARDENING, ...args], { env, stdio: "ignore" });
    p.on("error", () => ok(false));
    p.on("close", (code) => ok(code === 0));
  });

/**
 * The tar stream of a tarball mount the lease's bundle lists, or null when the bundle has no such mount or our clone of
 * the repo lacks the commit. The stream ends normally only when the archive is complete; otherwise it is destroyed with
 * an error. Archives are cached on disk per repo and commit, and at most ARCHIVE_SLOTS `git archive` run at once.
 * Instruction files stay in; the helper removes them. Without the clones on this disk (`runnerUrl`, unless `local`) the
 * runner streams it, authenticated by the lease's `secret`.
 */
export async function archiveOf(lease: TaskLease, repo: string, sha: string, opts: { secret?: string; local?: boolean; signal?: AbortSignal } = {}): Promise<Readable | null> {
  if (!lease.mounts.some((m) => m.kind === "tarball" && m.repo === repo && m.sha === sha)) return null;
  const runner = opts.local ? null : runnerUrl();
  if (runner) {
    // The runner must start answering within RUNNER_HEADERS_MS; the body then streams for as long as the client reads it.
    // `signal` (the client going away) ends either.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error("the runner did not answer in time")), RUNNER_HEADERS_MS);
    const stop = (): void => ac.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", stop, { once: true });
    let res: Response;
    try {
      res = await fetch(`${runner}/remote/tarball?${new URLSearchParams({ repo, sha })}`, { headers: { authorization: `Bearer ${opts.secret ?? ""}` }, signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 410) { await res.body?.cancel(); throw new LeaseGone(); }
    if (res.status === 404) { await res.body?.cancel(); return null; }
    if (!res.ok || !res.body) { await res.body?.cancel(); throw new Error(`the runner answered ${res.status} for a tarball`); }
    const out = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
    out.on("close", () => opts.signal?.removeEventListener("abort", stop));
    return out;
  }
  const dir = archiveDir(), name = `${repo}@${sha}.tar`, file = join(dir, name);
  if (existsSync(file)) {
    const now = new Date();
    try { utimesSync(file, now, now); } catch { /* evicted meanwhile */ }
    return createReadStream(file);
  }
  const env = { ...process.env, ...GIT_ENV, ...gitDirEnv(join(fixupDir(), repo)) };
  if (!await gitOk(["cat-file", "-e", `${sha}^{commit}`], env)) return null;
  const out = new PassThrough();
  let git: ChildProcess | undefined, held = false;
  const release = (): void => { if (held) { held = false; archiveSlotDone(); } };
  out.on("close", () => { if (git && git.exitCode === null) git.kill(); });
  void (async () => {
    await archiveSlot();
    held = true;
    if (out.destroyed) return release();
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${name}.${process.pid}.${Date.now()}`);
    const sink = createWriteStream(tmp);
    // A failed copy (disk full, the directory gone) is dropped; the client still gets its stream.
    let sinkFailed = false;
    sink.on("error", () => { sinkFailed = true; rmSync(tmp, { force: true }); });
    git = spawn("git", [...HARDENING, "archive", "--format=tar", sha], { env, stdio: ["ignore", "pipe", "ignore"] });
    git.stdout!.pipe(out, { end: false });
    git.stdout!.pipe(sink);
    git.on("error", () => { out.destroy(new Error("git archive failed")); sink.destroy(); rmSync(tmp, { force: true }); release(); });
    git.on("close", (code) => {
      release();
      if (code !== 0) { out.destroy(new Error("git archive failed")); sink.destroy(); rmSync(tmp, { force: true }); return; }
      out.end();
      // The pipe ends the sink with git's output; the copy is kept only when every byte was written.
      finished(sink, (err) => {
        if (err || sinkFailed) { rmSync(tmp, { force: true }); return; }
        try { renameSync(tmp, file); pruneArchives(dir, name); } catch { rmSync(tmp, { force: true }); }
      });
    });
  })().catch((e: unknown) => {
    release();
    out.destroy(e as Error);
  });
  return out;
}
