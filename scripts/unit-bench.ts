// Counts the round trips and times of the runner's and the Task Runners' units of work on a Postgres database with
// synthetic data, through the latency proxy: the runner tick, the claim (with and without a lease), the caller poll, the
// runner snapshot, the queue view, the sync, a job's start and a classify chunk. Dev only; it never reads a real database.
//
//   node --no-warnings scripts/unit-bench.ts <postgres admin url> [--delay MS] [--only SUBSTR] [--sql] [--dump FILE]
//
// Creates a database of its own on the server, seeds it, prints one line per unit (ms, round trips, statements), with --sql
// its statements in order, and drops the database. `scripts/pg-test.sh start` gives a throwaway server.
// --dump FILE writes what the read units returned, to compare two versions of the code.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToken } from "../src/dash/mcp/tokens.ts";
import type { Db } from "../src/db/index.ts";
import * as kx from "../src/db/kx.ts";
import { connectDb } from "../src/db/open.ts";
import { queryDb } from "../src/db/query-db.ts";
import { loadRunnerSnapshot } from "../src/data/runners/index.ts";
import { dropQueueCache } from "../src/data/runners/calls-shared.ts";
import { awaitCall, claimCall, enqueueCall, type Caller } from "../src/remote/calls.ts";
import { PROTOCOL_VERSION, type Claim, type TaskBundle } from "../src/remote/protocol.ts";
import { queueView } from "../src/remote/queue-view.ts";
import { runSync, type Querier } from "../src/mirror.ts";
import { JobLogCopy } from "../src/runner/job-log.ts";
import { applyProposals } from "../src/runner/autopilot.ts";
import { Runner } from "../src/runner/runner.ts";
import { runJev, setRunner } from "../src/classify/run.ts";
import { withConfig } from "../src/data/control/index.ts";
import { startLatencyProxy } from "./latency-proxy.ts";

const args = process.argv.slice(2);
const flag = (name: string, dflt: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : dflt;
};
const admin = args.find((a) => /^postgres(ql)?:\/\//.test(a));
if (!admin) {
  console.error("usage: unit-bench.ts <postgres admin url> [--delay MS] [--only SUBSTR] [--sql] [--dump FILE]");
  process.exit(2);
}
const delayMs = Number(flag("--delay", "11")), only = flag("--only", ""), showSql = args.includes("--sql"), dumpFile = flag("--dump", "");

const REPOS = 25, PRS = 100, ISSUES = 2000, QUEUED = 40, RUNNING = 10, CALLS = 30, RUNNERS = 4;
const base = Date.now();
const iso = (minAgo: number): string => new Date(base - minAgo * 60_000).toISOString().replace(/\.\d+Z$/, "Z");
const repos = Array.from({ length: REPOS }, (_, i) => `repo${String(i).padStart(2, "0")}`);
const repoOf = (i: number): string => repos[i % REPOS]!;
const bundle: Omit<TaskBundle, "callId"> = { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", timeoutSeconds: 600, maxTurns: 10, stdin: "x".repeat(20_000), system: null, mounts: [], mcpServers: [], keepSession: false, hints: {} };

async function insertAll(db: Db, table: string, rows: Record<string, unknown>[]): Promise<void> {
  const q = queryDb(db);
  for (const b of kx.batches(rows)) await q.run((q.k as any).insertInto(table).values(b));
}

async function seed(db: Db): Promise<{ callers: Caller[]; calls: number[]; running: number[] }> {
  const q = queryDb(db);
  // The repos a new database tracks by default.
  await q.run(q.k.deleteFrom("tracked_repos"));
  await q.run(q.k.deleteFrom("repos"));
  await insertAll(db, "repos", repos.map((name) => ({ name, visibility: "public", synced_at: iso(5), high_water: iso(10) })));
  await insertAll(db, "tracked_repos", repos.map((name) => ({ name, pipeline: 1 })));
  await insertAll(db, "settings", [{ key: "pipeline_enabled", value: "1" }, { key: "step_parallel", value: "none" }]);
  const items: Record<string, unknown>[] = [], commits: Record<string, unknown>[] = [], comments: Record<string, unknown>[] = [];
  for (let i = 0; i < PRS; i++) {
    items.push({ repo: repoOf(i), number: 1000 + i, kind: "pr", state: "OPEN", title: `PR ${i}`, body: "Body ".repeat(60), author: `dev${i % 17}`, author_id: 500 + (i % 17), created_at: iso(600 + i), updated_at: iso(30 + i), labels: "[]", head_oid: `h${i}`, base_ref: "main", ci_state: "SUCCESS", mergeable: "MERGEABLE" });
    commits.push({ repo: repoOf(i), number: 1000 + i, oid: `oid${i}`, committed_at: iso(40), author: `dev${i % 17}`, co_authors: "[]" });
    for (let c = 0; c < 4; c++) comments.push({ repo: repoOf(i), number: 1000 + i, id: `c${i}-${c}`, kind: "comment", author: "someone", created_at: iso(60 - c), body: "A comment ".repeat(10) });
  }
  for (let i = 0; i < ISSUES; i++) items.push({ repo: repoOf(i), number: 5000 + i, kind: "issue", state: "OPEN", title: `Issue ${i}`, body: "Body ".repeat(60), author: `dev${i % 17}`, created_at: iso(900 + i), updated_at: iso(60 + i), labels: "[]" });
  await insertAll(db, "items", items);
  await insertAll(db, "pr_commits", commits);
  await insertAll(db, "comments", comments);
  const callers: Caller[] = [];
  for (let i = 0; i < RUNNERS; i++) {
    const login = `mt${i}`;
    await insertAll(db, "access", [{ login, role: i ? "maintainer" : "operator" }]);
    const id = (await createToken(db, login, "helper", { kind: "runner" })).row.id;
    callers.push({ tokenId: id, login, role: i ? "maintainer" : "operator" });
    await insertAll(db, "remote_helpers", [{ token_id: id, login, readiness: "ready", harness: "claude", models: JSON.stringify({ top: "opus", mid: "sonnet", small: "haiku" }), reserve: JSON.stringify({ fiveHour: 20, weekly: 20 }), reported_at: Date.now() + 600_000, slots: 4, busy: 1, idle_claim_at: Date.now() + 600_000, idle_tiers: '["top"]' }]);
  }
  await insertAll(db, "item_workflows", Array.from({ length: 20 }, (_, i) => ({ repo: repoOf(i), number: 1000 + i, kind: "pr", entry: "review", state: "running", started_by: "mt1", started_at: iso(50), started_via: "dashboard", updated_at: iso(50) })));
  const calls: number[] = [];
  for (let i = 0; i < CALLS; i++) calls.push(await enqueueCall(db, { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", askedModel: "opus", bundle, items: [{ repo: repoOf(i), number: 1000 + i }], level: i % 5, maxAttempts: 2 }));
  const running: number[] = [];
  for (let i = 0; i < RUNNING; i++) running.push(Number((await q.get(q.k.insertInto("jobs").values({ step: "opus-review", params: JSON.stringify({ repo: repoOf(i) }), repo: repoOf(i), requested_by: "pipeline", requested_at: iso(5), state: "running", started_at: iso(4) } as never).returning("id")))!.id));
  // Half wait for the same work, half for room (the calls waiting hold it).
  await insertAll(db, "jobs", Array.from({ length: QUEUED }, (_, i) => ({ step: i % 2 ? "opus-review" : "premerge-review", params: JSON.stringify({ repo: repoOf(i) }), repo: repoOf(i), requested_by: "pipeline", requested_at: iso(3), state: "queued" })));
  await insertAll(db, "jobs", Array.from({ length: 3000 }, (_, i) => ({ step: ["opus-review", "classify-new", "fixup", "verify"][i % 4], params: JSON.stringify({ repo: repoOf(i) }), repo: repoOf(i), requested_by: "pipeline", requested_at: iso(i + 10), state: i % 9 ? "done" : "failed", started_at: iso(i + 9), ended_at: iso(i + 8) })));
  await insertAll(db, "sync_state", [{ id: 1, org_high_water: iso(6), search_catchup_at: iso(1), repos_refreshed_at: new Date().toISOString(), author_ids_backfilled_at: iso(100) }]);
  return { callers, calls, running };
}

const name = `unitbench_${randomBytes(3).toString("hex")}`;
const server = await connectDb(admin, { role: "cli", migrate: false });
await queryDb(server).script(`CREATE DATABASE ${name}`);
const direct = new URL(admin);
direct.pathname = `/${name}`;
const proxy = await startLatencyProxy({ host: direct.hostname, port: Number(direct.port || 5432) }, { delayMs });
const slow = new URL(direct);
slow.host = `127.0.0.1:${proxy.port}`;
const logs = mkdtempSync(join(tmpdir(), "unit-bench-"));
const dumps: Record<string, unknown> = {};
const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_, x: unknown) => (x instanceof Map ? [...x] : x instanceof Set ? [...x] : x)));
try {
  const seedDb = await connectDb(direct.toString(), { role: "cli" });
  const { callers, calls, running } = await seed(seedDb);
  await queryDb(seedDb).script("ANALYZE");
  const db = await connectDb(slow.toString(), { role: "runner" });
  // Task Runners are served on a handle whose lone writes take no writer lock (src/dash/index.ts).
  const remote = await connectDb(slow.toString(), { role: "dashboard-remote", rowWrites: true });
  const trips: { sql: string; site: string; ms: number }[] = [];
  for (const h of [db, remote]) h.observe((e) => { if (e.kind === "query") trips.push({ sql: e.sql.replace(/\s+/g, " "), site: e.site, ms: e.ms }); });
  /** Runs the unit `runs` times (after `warm` unmeasured ones) and prints the median time and the round trips of its last run. */
  const unit = async (label: string, run: (i: number) => Promise<unknown>, o: { runs?: number; warm?: number; before?: () => Promise<void> | void } = {}): Promise<void> => {
    if (only && !label.includes(only)) return;
    const ms: number[] = [];
    let statements = 0, trip = 0;
    for (let i = 0; i < (o.warm ?? 1) + (o.runs ?? 5); i++) {
      await o.before?.();
      // Statements a unit leaves running (writes off its path) belong to it, not to the next.
      await new Promise((r) => setTimeout(r, 120));
      trips.length = 0;
      const t = performance.now();
      const { value, stats } = await db.meter(() => remote.meter(() => run(i)));
      const took = performance.now() - t;
      const counted = value.stats;
      trip = trips.length;
      await new Promise((r) => setTimeout(r, 200));
      if (i >= (o.warm ?? 1)) ms.push(took);
      statements = stats.statements + counted.statements;
      dumps[label] = value.value === undefined ? undefined : plain(value.value);
    }
    ms.sort((a, b) => a - b);
    console.log(`${label.padEnd(34)} ${String(Math.round(ms[Math.floor(ms.length / 2)]!)).padStart(6)} ms ${String(trip).padStart(4)} trips on the path, ${String(trips.length).padStart(4)} in all, ${String(statements).padStart(4)} statements`);
    if (showSql) for (const t of trips) console.log(`    ${String(Math.round(t.ms)).padStart(4)} ms  ${t.sql.slice(0, 150)}  <- ${t.site.replace(/file:\S*?\/src\//g, "src/").slice(0, 240)}`);
  };
  console.log(`delay ${delayMs} ms each way, median`);

  // ---- runner ----
  const runner = new Runner({ db, dbTarget: slow.toString(), logs, log: (l) => void (showSql && console.log(`    log: ${l}`)), detect: () => new Promise(() => {}) });
  for (const id of running) {
    const logPath = join(logs, `job-${id}.log`);
    runner.running.set(id, { child: { pid: undefined }, termAt: null, exited: Promise.resolve(), startedAt: Date.now(), deadlineMin: 600, logPath, logCopy: JobLogCopy.open(id, logPath), flaggedAt: null, noProgressMin: 600, stopMsg: null, remoteSeen: null, remoteWaitMs: 0 } as never);
  }
  // Nothing is spawned (a job that could start is left queued) and nothing reads GitHub.
  Object.assign(runner, { reconcileTick: () => {}, workerUpdateTick: () => {} });
  (runner as unknown as { start: () => Promise<null> }).start = async () => null;
  await unit("runner tick", () => runner.tick(), { warm: 3 });

  const dequeue = async (): Promise<void> => { const q = queryDb(seedDb); await q.run(q.k.deleteFrom("jobs").where("step", "=", "opus-review").where("state", "=", "queued")); };
  await unit("queueing 5 of the planner's proposals", async () => {
    const proposals = [12, 13, 14, 15, 16].map((i) => ({ lane: "opus-review", step: "opus-review", params: { repo: repoOf(i), limit: 5 } }));
    const ids = await applyProposals(db, proposals as never, { log: (l) => void (showSql && console.log(l)) });
    if (ids.length !== 5) throw new Error(`${ids.length} jobs queued`);
  }, { before: dequeue, runs: 3 });

  // ---- calls ----
  let n = 0;
  const claim = (): Claim => ({ requestId: `bench-claim-${String(++n).padStart(6, "0")}`, protocol: PROTOCOL_VERSION, helperVersion: "9.0.0", harness: "claude", harnessVersion: "2.1", tiers: { top: "opus" } } as Claim);
  const cold = (): void => { dropQueueCache(db); dropQueueCache(remote); };
  await unit("runner snapshot (cold)", () => loadRunnerSnapshot(db, Date.now()), { before: cold });
  await unit("queue view (cold)", () => queueView(db, Date.now(), true), { before: cold });
  await unit("claim: nothing to take (cold)", () => claimCall(remote, callers[1]!, claim(), async () => false), { before: cold });
  await unit("claim: nothing to take (warm)", () => claimCall(remote, callers[1]!, claim(), async () => false));
  const unlease = async (): Promise<void> => { const q = queryDb(seedDb); await q.run(q.k.updateTable("remote_calls").set({ state: "queued", lease_secret_hash: null, token_id: null, claim_id: null, user_login: null })); cold(); };
  await unit("claim: a lease (cold)", async () => { if (!(await claimCall(remote, callers[0]!, claim(), async () => true)).lease) throw new Error("no lease"); }, { before: unlease });
  await unlease();
  if (!only || "caller poll".includes(only)) {
    const stop = calls.map((id) => awaitCall(db, id, { log: () => {} }).catch(() => null));
    await new Promise((r) => setTimeout(r, 3_000));
    trips.length = 0;
    const t = performance.now();
    await new Promise((r) => setTimeout(r, 10_000));
    const s = (performance.now() - t) / 1000;
    console.log(`${"caller poll, 30 calls waiting".padEnd(34)} ${(trips.length / s).toFixed(2)} trips a second over ${s.toFixed(0)} s`);
    if (showSql) for (const x of trips.slice(0, 12)) console.log(`    ${Math.round(x.ms)} ms  ${x.sql.slice(0, 150)}  <- ${x.site.replace(/file:\S*?\/src\//g, "src/").slice(0, 160)}`);
    const q = queryDb(seedDb);
    await q.run(q.k.updateTable("remote_calls").set({ state: "failed", error: "ended" }));
    await Promise.all(stop);
    await q.run(q.k.updateTable("remote_calls").set({ state: "queued", error: null }));
  }

  // ---- sync ----
  let rev = 0;
  const node = (i: number) => ({ __typename: "PullRequest", repository: { name: repoOf(i), owner: { login: "storytold" } }, number: 1000 + i, title: `PR ${i}`, body: `Body ${rev} `.repeat(40), url: `https://github.com/storytold/${repoOf(i)}/pull/${1000 + i}`, author: { login: `dev${i % 17}`, __typename: "User", databaseId: 500 + (i % 17) }, authorAssociation: "MEMBER",
    createdAt: iso(600 + i), updatedAt: iso(5), closedAt: null, state: "OPEN", labels: { nodes: [] }, assignees: { nodes: [] }, commentCount: { totalCount: 4 }, reactionCount: { totalCount: 0 }, isDraft: false, mergedAt: null, additions: 1, deletions: 1, changedFiles: 1, headRefName: "b", headRefOid: `h${i}`, baseRefName: "main", closingIssuesReferences: { nodes: [] }, maintainerCanModify: true, mergeable: "MERGEABLE", reviewDecision: null, commits: { nodes: [] },
    comments: { nodes: Array.from({ length: 4 }, (_, c) => ({ id: `c${i}-${c}`, author: { login: "someone", __typename: "User" }, authorAssociation: "NONE", createdAt: iso(60 - c), body: "A comment", url: "u" })) }, reviews: { nodes: [] } });
  const oneRepo = repos[0]!;
  const client = (nodes: unknown[]): Querier => ({ spent: 0, remaining: 4000, query: async (text: string, v: object) => {
    if (text.includes("search(")) return { search: { issueCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes } };
    const all = v as { states?: string[] };
    const page = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: text.includes("pullRequests(") && all.states?.[0] === "OPEN" ? nodes : [] };
    if (text.includes("repositoryOwner")) return { repositoryOwner: { repositories: { ...page, nodes: repos.map((r) => ({ name: r, owner: { login: "storytold" }, visibility: "PUBLIC", isArchived: false, isFork: false, isPrivate: false, defaultBranchRef: { name: "main" }, pullRequests: { totalCount: 4 }, issues: { totalCount: 80 } })) } } };
    return { repository: { issues: page, pullRequests: page } };
  } } as unknown as Querier);
  const quiet = async <T>(fn: () => Promise<T>): Promise<T> => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };
  const list = (k: number): unknown[] => Array.from({ length: k }, (_, i) => node(i));
  // Each sync starts where the seed left it.
  const rewind = async (): Promise<void> => { const q = queryDb(seedDb); await q.run(q.k.updateTable("sync_state").set({ org_high_water: iso(6) })); rev++; };
  await unit("sync by search, nothing new", () => quiet(() => runSync(db, client([]), { full: false, all: false, only: [], perRepo: false } as never)), { before: rewind });
  await unit("sync by search, 20 changed PRs", () => quiet(() => runSync(db, client(list(20)), { full: false, all: false, only: [], perRepo: false } as never)), { before: rewind });
  await unit("sync of one repo, 4 changed PRs", () => quiet(() => runSync(db, client(list(PRS).filter((x) => (x as { repository: { name: string } }).repository.name === oneRepo)), { full: false, all: false, only: [oneRepo], perRepo: true } as never)), { before: rewind });

  // ---- a job ----
  process.env.AUTOCRAFT_DB_URL = slow.toString();
  const { execJob } = await import("../src/runner/exec.ts");
  if (!only || "job start".includes(only)) {
    const q = queryDb(seedDb);
    const { loadSteps } = await import("../src/runner/steps.ts");
    const steps = await loadSteps();
    const runs: number[] = [];
    for (let i = 0; i < 4; i++) {
      const id = Number((await q.get(q.k.insertInto("jobs").values({ step: "bench-noop", params: "{}", repo: null, requested_by: "pipeline", requested_at: iso(1), state: "running", started_at: new Date().toISOString() } as never).returning("id")))!.id);
      steps.set("bench-noop", { ...steps.get("classify-new")!, name: "bench-noop", params: [], check: undefined, available: undefined, run: async (ctx: { progress(t: string): Promise<void>; cancelled(): Promise<boolean> }) => { await ctx.progress("working"); await ctx.cancelled(); return "done"; } } as never);
      const t = performance.now();
      await quiet(() => execJob(id));
      runs.push(performance.now() - t);
      const r = await q.get(q.k.selectFrom("jobs").select(["state", "summary", "db_round_trips", "db_statements"]).where("id", "=", id));
      if (i === 3) console.log(`${"job start and end, step does nothing".padEnd(34)} ${Math.round(runs.sort((a, b) => a - b)[1]!)} ms (connection included), ${r!.db_round_trips} trips and ${r!.db_statements} statements in the metered part; ${r!.summary}`);
    }
  }

  // ---- classify ----
  const answers = { type: { choice: "performance", confidence: 0.95, probabilities: { performance: 0.95, bugfix: 0.05 } }, security: { noul: 0.1 }, needs_decision: { noul: 0.1 } };
  const restore = setRunner(async () => { await new Promise((r) => setTimeout(r, 300)); return { code: 0, stderr: "", stdout: JSON.stringify({ answers, usage: { input_tokens: 1000, output_tokens: 50 } }) }; });
  const chunk = Array.from({ length: 40 }, (_, i) => ({ repo: repoOf(i), number: 5000 + i, kind: "issue" as const, title: "t", body: "b", lines_changed: null, files_changed: null, author_association: null }));
  await unit("classify: a chunk of 40, calls 300 ms", () => quiet(() => withConfig(db, () => runJev(db, "bench", chunk as never, 20))), { runs: 3 });
  restore();
  if (dumpFile) writeFileSync(dumpFile, JSON.stringify(dumps, null, 1));
  await db.close();
  await remote.close();
  await seedDb.close();
} finally {
  await proxy.close();
  await queryDb(server).script(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await server.close();
  rmSync(logs, { recursive: true, force: true });
}
process.exit(0);
