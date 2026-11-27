// Times the dashboard API routes behind the main pages on a Postgres database with synthetic data, through the latency
// proxy, and counts their database traffic. Dev only; it never reads a real database.
//
//   node --no-warnings scripts/page-bench.ts <postgres admin url> [--delay MS] [--runs N] [--only SUBSTR] [--as op|mt|vw]
//     [--repos N] [--prs N] [--issues N] [--trace] [--dump DIR] [--sql]
//
// Creates a database of its own on the server, seeds it, and asks the dashboard server for each route as a signed-in user
// (session, permission checks and settings included). Prints per route, slowest first: median ms; waits, the
// round trips in sequence (those sent side by side count once); round trips, statements and rows. With --trace also each round trip of the
// last run in order (when it was sent, ms, rows, the call sites), with --sql the statements of its last run (the first 160 characters, counted); --dump DIR
// writes each answer to DIR. Drops the database at the end. `scripts/pg-test.sh start` gives a throwaway server.
import { randomBytes } from "node:crypto";
import { apiRoutes } from "../src/dash/api/index.ts";
import { live } from "../src/dash/api/live.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { loadConfig } from "../src/dash/server/config.ts";
import { TokenBox } from "../src/dash/server/crypto.ts";
import { createApp, SESSION_COOKIE } from "../src/dash/server/index.ts";
import { FakeProvider } from "../src/dash/server/provider.ts";
import { createSession } from "../src/dash/server/sessions.ts";
import type { DbStats } from "../src/db/index.ts";
import { refreshPlanCache } from "../src/core/plan-cache.ts";
import * as kx from "../src/db/kx.ts";
import { connectDb } from "../src/db/open.ts";
import { queryDb, type QueryDb as Db } from "../src/db/query-db.ts";
import { enqueueCall } from "../src/remote/calls.ts";
import type { TaskBundle } from "../src/remote/protocol.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLatencyProxy } from "./latency-proxy.ts";

const args = process.argv.slice(2);
const flag = (name: string, dflt: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : dflt;
};
const admin = args.find((a) => /^postgres(ql)?:\/\//.test(a));
if (!admin) {
  console.error("usage: page-bench.ts <postgres admin url> [--delay MS] [--runs N] [--only SUBSTR]");
  process.exit(2);
}
const delayMs = Number(flag("--delay", "10"));
const runs = Number(flag("--runs", "5"));
const only = flag("--only", "");
const trace = args.includes("--trace");
const dump = flag("--dump", "");
const statements = args.includes("--sql");
const as = flag("--as", "op");

const REPOS = Number(flag("--repos", "25")), OPEN_PRS = Number(flag("--prs", "100")), OPEN_ISSUES = Number(flag("--issues", "2000")), COMMENTS = 4;
// Per repo: open PRs, open issues, then closed items (3 PRs for each issue) up to ITEMS.
const PRS = Math.ceil(OPEN_PRS / REPOS), ISSUES = Math.ceil(OPEN_ISSUES / REPOS), ITEMS = PRS + ISSUES + 150;
// Times count back from the start of the current hour, so two runs within an hour seed the same rows and --dump outputs compare.
const BASE = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const iso = (minAgo: number) => new Date(BASE - minAgo * 60_000).toISOString();

async function insertAll(db: Db, table: string, rows: Record<string, unknown>[]): Promise<void> {
  for (const b of kx.batches(rows)) await db.run((db.k as any).insertInto(table).values(b));
}

async function seed(db: Db): Promise<void> {
  const repos = Array.from({ length: REPOS }, (_, i) => `repo${i}`);
  await insertAll(db, "repos", repos.map((name, i) => ({ name, visibility: i % 5 === 4 ? "private" : "public" })));
  // A new database tracks the default repos.
  await db.run(db.k.deleteFrom("tracked_repos"));
  await insertAll(db, "tracked_repos", repos.map((name, i) => ({ name, pipeline: i % 2 })));
  await insertAll(db, "access", [{ login: "op", role: "operator" }, { login: "mt", role: "maintainer" }, { login: "vw", role: "viewer" }]);
  // Checked now, so no request asks the provider.
  await insertAll(db, "repo_permissions", ["op", "mt", "vw"].flatMap((login) => repos.map((repo) => ({ login, repo, permission: login === "vw" ? "read" : "write", checked_at: new Date(Date.now() + 3_600_000).toISOString() }))));
  const items: Record<string, unknown>[] = [], comments: Record<string, unknown>[] = [], stages: Record<string, unknown>[] = [];
  const checks: Record<string, unknown>[] = [], files: Record<string, unknown>[] = [], classes: Record<string, unknown>[] = [];
  for (const repo of repos) {
    for (let n = 1; n <= ITEMS; n++) {
      const pr = n <= PRS || n > PRS + ISSUES && n % 4 !== 0, open = n <= PRS + ISSUES, age = n * 37;
      items.push({
        repo, number: n, kind: pr ? "pr" : "issue", state: open ? "OPEN" : pr ? "MERGED" : "CLOSED", title: `Item ${n} of ${repo}`,
        body: "Body text ".repeat(20), author: `dev${n % 17}`, created_at: iso(age + 600), updated_at: iso(age), labels: JSON.stringify(n % 4 ? ["bug"] : []),
        ...(pr ? { head_oid: `h${n}`, base_ref: "main", ci_state: n % 7 ? "SUCCESS" : "FAILURE", mergeable: "MERGEABLE", additions: n, deletions: n % 13, changed_files: 3 } : {}),
      });
      for (let c = 0; c < COMMENTS; c++) comments.push({ repo, number: n, id: `${repo}-${n}-${c}`, author: `dev${(n + c) % 17}`, created_at: iso(age - c), body: "A comment ".repeat(15), kind: c === 3 && pr ? "review" : "comment", review_state: c === 3 && pr ? "COMMENTED" : null });
      for (const [k, stage] of ["synced", "classified", "reviewed"].entries()) stages.push({ repo, number: n, stage, at: iso(age - k), actor: "pipeline", note: "note" });
      classes.push({ repo, number: n, classifier: "type", run_id: `r${n}`, at: iso(age), type_label: pr ? "bug" : "feature", flags: "[]" });
      if (pr) {
        checks.push({ repo, number: n, head_oid: `h${n}`, overall: n % 7 ? "SUCCESS" : "FAILURE", checks: JSON.stringify([{ name: "build", state: "SUCCESS" }, { name: "test", state: n % 7 ? "SUCCESS" : "FAILURE" }]), fetched_at: iso(age) });
        for (let f = 0; f < 3; f++) files.push({ repo, number: n, head: `h${n}`, path: `src/file${f}.rs`, additions: f + 1, deletions: f, change_type: "MODIFIED" });
      }
    }
  }
  await insertAll(db, "items", items);
  await insertAll(db, "comments", comments);
  await insertAll(db, "stages", stages);
  await insertAll(db, "classifications", classes);
  await insertAll(db, "pr_checks", checks);
  await insertAll(db, "pr_files", files);
  const workflows: Record<string, unknown>[] = [];
  for (let i = 0; i < Math.min(300, REPOS * ITEMS); i++) {
    const repo = repos[i % REPOS]!, number = Math.floor(i / REPOS) + 1;
    const pr = number <= PRS, rec = i % 3 !== 0;
    workflows.push({ repo, number, kind: pr ? "pr" : "issue", entry: pr ? "review" : "implement", state: rec ? "recommending" : "running", started_by: "op", started_at: iso(i * 11 + 5), started_via: "dashboard",
      rec: rec ? JSON.stringify({ text: "Looks right.", parts: { fix: [], drop: [] }, merges: pr }) : null, rec_at: rec ? iso(i * 11) : null, updated_at: iso(i * 11) });
  }
  await insertAll(db, "item_workflows", workflows);
  const jobs: Record<string, unknown>[] = [];
  for (let i = 0; i < 2000; i++) {
    const running = i < 10, queued = !running && i < 50;
    jobs.push({ step: ["opus-review", "classify", "fixup", "sync"][i % 4], params: "{}", requested_by: "pipeline", requested_at: iso(i * 3 + 1), state: running ? "running" : queued ? "queued" : i % 9 ? "done" : "failed",
      started_at: queued ? null : iso(i * 3 + 1), ended_at: running || queued ? null : iso(i * 3), repo: repos[i % REPOS], progress: running ? "working" : null, error: i % 9 ? null : "exit 1" });
  }
  await insertAll(db, "jobs", jobs);
  const ids = (await db.all(db.k.selectFrom("jobs").select(["id", "repo"]).orderBy("id"))) as { id: number; repo: string }[];
  await insertAll(db, "job_items", ids.map((j, i) => ({ job_id: j.id, repo: j.repo, number: (i % ITEMS) + 1, at: iso(i * 3) })));
  const runRows: Record<string, unknown>[] = ids.slice(0, 1500).map((j, i) => ({
    job_id: j.id, step: "opus-review", stage: 5, prompt_id: "p", prompt_version: "1", provider: "claude", model: "opus",
    items: JSON.stringify([{ repo: j.repo, number: (i % ITEMS) + 1 }]), item_count: 1, state: i < 4 ? "running" : "done", started_at: iso(i * 3 + 1), ended_at: i < 4 ? null : iso(i * 3), cost_usd: 0.12,
  }));
  await insertAll(db, "agent_runs", runRows);
  const runIds = (await db.all(db.k.selectFrom("agent_runs").select(["id", "items"]).orderBy("id"))) as { id: number; items: string }[];
  await insertAll(db, "agent_run_items", runIds.map((r) => ({ run_id: r.id, ...(JSON.parse(r.items) as { repo: string; number: number }[])[0] })));
  await insertAll(db, "sync_runs", Array.from({ length: 50 }, (_, i) => ({ started_at: iso(i * 10 + 1), ended_at: iso(i * 10), mode: "full", items: 10, error: null })));
  await insertAll(db, "settings", [{ key: "liveness_at", value: iso(5) }, { key: "liveness_open", value: "4000" }]);
  await insertAll(db, "liveness_items", Array.from({ length: 150 }, (_, i) => ({
    repo: repos[i % REPOS], number: (i % ITEMS) + 1, kind: "pr", verdict: i % 3 ? "long" : "stuck", cause: "no-wait", state: "OPEN", wait: null, phase: "review", since: iso(i * 30 + 600), checked_at: iso(5),
  })));
  await insertAll(db, "build_envs", Array.from({ length: 3 }, (_, i) => ({ id: `env${i}`, label: `Env ${i}`, kind: "pod", slots: 4, key_hash: `k${i}`, created_at: iso(1000) })));
  await insertAll(db, "build_tasks", Array.from({ length: 300 }, (_, i) => ({
    step: "prbuild", repo: repos[i % REPOS], number: (i % ITEMS) + 1, head_sha: `h${(i % ITEMS) + 1}`, requires: "{}", plan: "{}", state: i < 5 ? "running" : "done", queued_at: iso(i * 5 + 2),
  })));
}

/** Waiting model calls, and Task Runners that asked for work a moment ago; every second repo holds a merge batch. */
async function seedCalls(db: Db): Promise<void> {
  const bundle: Omit<TaskBundle, "callId"> = { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", timeoutSeconds: 600, maxTurns: 10, stdin: "x".repeat(20_000), system: null, mounts: [], mcpServers: [], keepSession: false, hints: {} };
  for (let i = 0; i < 30; i++) await enqueueCall(db, { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", askedModel: "opus", bundle, items: [{ repo: `repo${i % REPOS}`, number: i % PRS + 1 }], level: i % 5, maxAttempts: 2 }, Date.now());
  const helpers: Record<string, unknown>[] = [];
  for (let i = 0; i < 4; i++) {
    const login = i % 2 ? "mt" : "op";
    const { row } = await createToken(db, login, `runner ${i}`, { kind: "runner" });
    helpers.push({ token_id: row.id, login, readiness: "ready", harness: "claude", models: "{}", reserve: "{}", reported_at: Date.now(), slots: 2, busy: 0, helper_version: "1.0.0" });
  }
  await insertAll(db, "remote_helpers", helpers);
  for (let r = 0; r < REPOS; r += 2) {
    await insertAll(db, "merge_batches", [{ repo: `repo${r}`, branch: `integration-repo${r}-1`, state: "building", base_sha: "b", commit_sha: "c", created_at: iso(30), updated_at: iso(20) }]);
    const id = ((await db.get(db.k.selectFrom("merge_batches").select("id").orderBy("id", "desc").limit(1))) as { id: number }).id;
    await insertAll(db, "merge_batch_prs", [1, 2].map((n) => ({ batch_id: id, number: n, head_oid: `h${n}`, position: n })));
  }
}

const ROUTES: [string, Record<string, string>, string?][] = [
  ["/api/me", {}], ["/api/me/settings", {}], ["/api/repos", {}], ["/api/repos/owners", {}], ["/api/progress", {}], ["/api/account/discord", {}], ["/api/mention", {}],
  // The live board's data: GET /api/live itself is the event stream. And the MCP tools an agent polls (a POST to /mcp).
  ["/api/bench/live", {}], ["mcp:get_item", { item: "repo1#1" }], ["mcp:my_items", {}], ["mcp:list_merge_queue", {}],
  ["/api/maintain/home", {}], ["/api/maintain/items", {}], ["/api/maintain/items", {}, "q=item"], ["/api/maintain/items/:repo/:n", { repo: "repo1", n: "1" }],
  ["/api/maintain/queue", {}], ["/api/maintain/repos", {}], ["/api/maintain/stats", {}],
  ["/api/items/:repo/:n/page", { repo: "repo1", n: "1" }], ["/api/items/:repo/:n/page", { repo: "repo1", n: "1" }, "since=<stamp>"], ["/api/items/:repo/:n", { repo: "repo1", n: "1" }], ["/api/items/:repo/:n/peek", { repo: "repo1", n: "1" }],
  ["/api/items/:repo/:n/trace", { repo: "repo1", n: "1" }], ["/api/items/:repo/:n/chat", { repo: "repo1", n: "1" }], ["/api/similar/:repo/:n", { repo: "repo1", n: "1" }],
  ["/api/queue/page", {}], ["/api/next", {}], ["/api/model-queue", {}], ["/api/runners", {}], ["/api/activity", {}], ["/api/activity", {}, "since=<stamp>"], ["/api/agents", {}], ["/api/agents/:id", { id: "20" }],
  ["/api/search", {}, "q=item"], ["/api/repos/all", {}], ["/api/envs", {}], ["/api/envs/caches", {}], ["/api/tasks", {}], ["/api/workspaces", {}], ["/api/stuck", {}], ["/api/main-ci", {}], ["/api/main-ci/summary", {}],
  ["/api/pipeline", {}], ["/api/pipeline/jobs", {}], ["/api/pipeline/jobs/:id", { id: "20" }], ["/api/pipeline/state", {}], ["/api/rates", {}], ["/api/prompts", {}], ["/api/audit", {}], ["/api/cost", {}], ["/api/classifiers", {}], ["/api/contributors", {}],
  ["/api/nightly", {}], ["/api/downloads", {}], ["/api/build/summary", {}], ["/api/build/features", {}], ["/api/build/screenshots", {}], ["/api/batches/:id", { id: "1" }], ["/api/mcp/tokens", {}],
  ["/api/repos/:repo/security", { repo: "repo1" }], ["/api/security/scans", {}], ["/api/security/findings", {}], ["/api/areas/:repo", { repo: "repo1" }],
  ["/api/health", {}], ["/api/access", {}], ["/api/admin/discord", {}], ["/api/settings/inference", {}], ["/api/settings/jev", {}], ["/api/pipeline/outside/held", {}],
];

const name = `pagebench_${randomBytes(3).toString("hex")}`;
const scratch = mkdtempSync(join(tmpdir(), "page-bench-"));
const config = loadConfig({ AUTOCRAFT_DEV_AUTH: "1", AUTOCRAFT_LISTEN: "127.0.0.1:0", AUTOCRAFT_DB: join(scratch, "unused.db") });
const server = queryDb(await connectDb(admin, { role: "cli", migrate: false }));
await server.script(`CREATE DATABASE ${name}`);
const direct = new URL(admin);
direct.pathname = `/${name}`;
const proxy = await startLatencyProxy({ host: direct.hostname, port: Number(direct.port || 5432) }, { delayMs });
const slow = new URL(direct);
slow.host = `127.0.0.1:${proxy.port}`;
try {
  const seedDb = queryDb(await connectDb(direct.toString(), { role: "cli" }));
  await seed(seedDb);
  await seedCalls(seedDb);
  await refreshPlanCache(seedDb);
  const cookie = `${SESSION_COOKIE}=${await createSession(seedDb, new TokenBox(config.secrets.sessionKey), as, { access: "a", refresh: "r", expiresAt: Date.now() + 3_600_000, refreshExpiresAt: Date.now() + 3_600_000 } as never, "bench")}`;
  const { token } = await createToken(seedDb, as, "bench agent");
  await seedDb.script("ANALYZE");
  await seedDb.close();
  const db = await connectDb(slow.toString(), { role: "dashboard" });
  const provider = Object.assign(new FakeProvider(null), { permission: async () => { console.log("permission asked of the provider"); return as === "vw" ? "read" : "write"; } });
  const app = await createApp({ config, db, provider, routes: [...apiRoutes(), { method: "GET", pattern: "/api/bench/live", handler: async (d, r) => ({ json: await live(d, r) }) }] });
  // The stats of the request being served; what the server's timers do meanwhile is not in them.
  let stats: DbStats | undefined;
  const web = createServer((q, r) => void db.meter(() => app.handle(q, r)).then((m) => { stats = m.stats; }));
  await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
  console.log(`delay ${delayMs} ms each way, ${runs} runs, median, as ${as}; ${REPOS} repos, ${REPOS * ITEMS} items`);
  const lines: { ms: number; text: string }[] = [];
  // `<stamp>` in a query: the stamp of the answer before it, as a page that polls sends it.
  let stamp = "";
  for (const [pattern, params, asked] of ROUTES) {
    const query = asked?.replace("<stamp>", stamp);
    const label = pattern + (asked ? `?${asked}` : "");
    if (only && !label.includes(only)) continue;
    const path = pattern.replace(/:(\w+)/g, (_, p: string) => params[p]!) + (query ? `?${query}` : "");
    let body = "";
    const call = async (): Promise<DbStats> => {
      stats = undefined;
      const signal = AbortSignal.timeout(60_000);
      const res = pattern.startsWith("mcp:")
        ? await fetch(`${base}/mcp`, { method: "POST", signal, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: pattern.slice(4), arguments: params } }) })
        : await fetch(base + path, { headers: { cookie }, signal });
      body = await res.text();
      // The meter closes after the answer is out.
      while (!stats) await new Promise((r) => setTimeout(r, 1));
      if (!res.ok) throw new Error(`${res.status} ${body.slice(0, 200)}`);
      return stats;
    };
    try {
      await call();
    } catch (e) {
      console.log(`${label}: ${(e as Error).message}`);
      continue;
    }
    const times: number[] = [];
    let waits = 0, last!: DbStats, log: string[] = [];
    const texts = new Map<string, number>();
    for (let i = 0; i < runs; i++) {
      texts.clear();
      const spans: [number, number][] = [];
      const sent: string[] = [];
      const t0 = performance.now();
      const off = db.observe((e) => { if (e.kind !== "query") return; const end = performance.now(); spans.push([end - e.ms, end]); sent.push(`    @${Math.round(end - e.ms - t0)} ${Math.round(e.ms)} ms ${e.rows} rows ${e.bytes} B  ${e.site.replace(/file:\S*\/(?=src\/)/g, "").replace(/ \+ /g, "\n        ")}`); if (statements) { const t = e.sql.replace(/\s+/g, " ").slice(0, 160); texts.set(t, (texts.get(t) ?? 0) + 1); } });
      last = await call();
      times.push(performance.now() - t0);
      off();
      log = sent;
      waits = 0;
      let busy = 0;
      for (const [from, to] of spans.sort((a, b) => a[1] - b[1])) if (from >= busy) { waits++; busy = to; }
    }
    stamp = /"stamp":"(\w+)"/.exec(body)?.[1] ?? stamp;
    if (dump) {
      mkdirSync(dump, { recursive: true });
      writeFileSync(join(dump, `${label.replace(/^\/(api\/)?/, "").replace(/[/:?=<>]+/g, "_")}.json`), JSON.stringify(JSON.parse(body), null, 1));
    }
    times.sort((a, b) => a - b);
    const med = times[Math.floor(times.length / 2)]!;
    const text = [`${label.padEnd(32)} ${String(Math.round(med)).padStart(6)} ms  ${String(waits).padStart(3)} waits  ${String(last.roundTrips).padStart(4)} trips  ${String(last.statements).padStart(4)} stmts  ${String(last.rows).padStart(6)} rows`,
      ...[...texts].sort((a, b) => b[1] - a[1]).map(([t, k]) => `    ${String(k).padStart(4)}  ${t}`),
      ...(trace ? log : [])].join("\n");
    lines.push({ ms: med, text });
  }
  for (const l of lines.sort((a, b) => b.ms - a.ms)) console.log(l.text);
  app.close();
  web.closeAllConnections();
  web.close();
  await db.close();
} finally {
  await proxy.close();
  await server.script(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await server.close();
  rmSync(scratch, { recursive: true, force: true });
}
