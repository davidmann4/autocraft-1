// Counts the round trips of the planner's units of work on a Postgres database with synthetic data, and times them through
// the latency proxy: a full pass, quiet passes, passes over changed items, the due check, and queueing the proposals. Dev only;
// it never reads a real database.
//
//   AUTOCRAFT_TEST_PG_URL=<postgres admin url> node --no-warnings --import ./test/suite-preload.ts scripts/planner-bench.ts
//       [--delay MS] [--only NAME] [--sites N] [--sql] [--trace] [--unfused] [--width N] [--dump FILE] [--large] [--passes]
//
// --sites N lists the N call sites with the most statements of each unit, --sql its statements, --trace its statements in order; --dump FILE freezes the clock and
// writes what the passes decided (proposals, stored Plans, lane lists), to compare two versions. `scripts/pg-test.sh start`
// gives a throwaway server. --large adds the rows of a production-sized pass (about 33,000 open items, 13,600 of them PRs, and 2,000
// merged PRs); --passes runs the planner passes only. The longest time a transaction sat idle is printed at the end: the server
// ends a session idle longer than the limit in src/db/postgres.ts, so run it on one CPU (`taskset -c 0 nice`) to see a slow node's.
import { mock } from "node:test";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { countQueries } from "../src/db/counter.ts";
import type { Db } from "../src/db/index.ts";
import { connectDb } from "../src/db/open.ts";
import { queryDb } from "../src/db/query-db.ts";
import { COLUMNS } from "../src/db/types.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { planned } from "../src/core/select.ts";
import { plannedItems } from "../src/core/select-items.ts";
import { loadPlanSet } from "../src/core/plan-set.ts";
import { dropPlanState } from "../src/core/plan-engine.ts";
import { enqueueCall } from "../src/remote/calls.ts";
import { applyProposals, detectAutopilot, laneGates, LANES, planDue } from "../src/runner/autopilot.ts";
import { loadSteps } from "../src/runner/steps.ts";
import { SCHEME_ID } from "../src/itemhash.ts";
import { world } from "../test/world-db.ts";
import { startLatencyProxy } from "./latency-proxy.ts";

const args = process.argv.slice(2);
const flag = (name: string, dflt: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : dflt;
};
const delayMs = Number(flag("--delay", "11"));
const only = flag("--only", "");
const sites = Number(flag("--sites", "0"));
const dump = flag("--dump", "");
const statements = args.includes("--sql");
const trace = args.includes("--trace");
const width = Number(flag("--width", "200"));
if (!process.env.AUTOCRAFT_TEST_PG_URL) {
  console.error("AUTOCRAFT_TEST_PG_URL names the throwaway server (scripts/pg-test.sh start)");
  process.exit(2);
}

const REPOS = 25, PRS = 4, ISSUES = 80;
const START = Date.parse("2026-01-10T00:00:00Z");
const iso = (minAgo: number): string => new Date((dump ? START : Date.now()) - minAgo * 60_000).toISOString();
if (dump) mock.timers.enable({ apis: ["Date"], now: START });

// ---- seed: the repo "app" through the test world, then copies of it ----
const w = await world();
const direct = queryDb(w.db);
await w.repo();
for (let n = 1; n <= PRS; n++) {
  await w.pr(n, n === 2 ? { mergeable: "CONFLICTING" } : n === 3 ? { ci: "failure" } : {});
  if (n !== 4) await w.review(n, { verdict: n === 3 ? "take-fix" : "take" });
  if (n === 1) { await w.verified(n); await w.premerge(n, "clean"); }
  if (n !== 2) await w.workflow(n, { entry: n === 1 ? "merge" : "review" });
}
for (let n = 101; n <= 100 + ISSUES; n++) await w.issue(n, { label: n % 2 ? "bugfix" : "feature", ...(n % 3 ? { impact: "medium" } : {}) });
await direct.run(direct.k.updateTable("items").set({ embed_hash: "e", class_hash: "c", class_scheme: SCHEME_ID, text_refs: "[[],[]]" }).where("repo", "=", "app"));
for (const step of ["labels", "prstatus"]) await direct.run(direct.k.insertInto("repo_step_approvals").values({ repo: "app", step, by: "op", at: iso(600) } as never));
for (let i = 0; i < 25; i += 2) await direct.run(direct.k.insertInto("settings").values({ key: `build_feature:pr-builds:${i ? `app${i}` : "app"}`, value: "on" }));
for (let n = 1; n <= 4; n++) await direct.run((direct.k as any).insertInto("item_stage").values({ repo: "app", number: n, stage: "reviewed", at: iso(90), reviewed: 1 }));
const k = direct.k as unknown as import("kysely").Kysely<Record<string, Record<string, unknown>>>;
const tables: (keyof typeof COLUMNS)[] = ["tracked_repos", "repos", "items", "classifications", "pr_checks", "opus_reviews", "verifications", "premerge_reviews", "item_priority", "repo_step_approvals", "pr_files", "item_workflows", "item_stage"] as never;
for (const table of tables.filter((t) => COLUMNS[t])) {
  const repoCol = table === "tracked_repos" || table === "repos" ? "name" : "repo";
  const cols = [...COLUMNS[table]].filter((c) => c !== "id");
  const rows = await direct.all(k.selectFrom(table).select(cols).where(repoCol, "=", "app"));
  for (let i = 1; i < REPOS; i++) for (let j = 0; j < rows.length; j += 200) {
    await direct.run(k.insertInto(table).values(rows.slice(j, j + 200).map((r) => ({ ...r, [repoCol]: `app${i}`, ...(table === "tracked_repos" ? { pipeline: i % 4 ? 1 : 0 } : {}) }))));
  }
}
const repo = (i: number): string => (i % REPOS ? `app${i % REPOS}` : "app");
const steps = ["opus-review", "fixup", "cifix", "checks", "merge", "verify", "labels-apply", "act"];
for (let i = 0; i < 50; i++) {
  await direct.run(direct.k.insertInto("jobs").values({ step: steps[i % steps.length]!, params: JSON.stringify({ repo: repo(i) }), requested_by: "pipeline", requested_at: iso(9), state: i < 10 ? "running" : "queued", started_at: i < 10 ? iso(8) : null, repo: repo(i) }));
}
for (let i = 0; i < 600; i++) {
  await direct.run(direct.k.insertInto("jobs").values({ step: steps[i % steps.length]!, params: JSON.stringify({ repo: repo(i) }), requested_by: "pipeline", requested_at: iso(100 + i), started_at: iso(99 + i), ended_at: iso(98 + i), state: i % 9 ? "done" : "failed", repo: repo(i), items: i % 2, acted: i % 2 }));
}
for (let i = 0; i < 4; i++) {
  const login = `runner${i}`;
  await direct.run(direct.k.insertInto("access").values({ login, role: "maintainer" }));
  const { row } = await createToken(w.db, login, "Task Runner", { kind: "runner" });
  await direct.run(direct.k.updateTable("mcp_tokens").set({ idle_claim_at: Date.parse(iso(0)), idle_tiers: '["top","fast"]' }).where("id", "=", row.id));
  for (let r = 0; r < REPOS; r++) await direct.run(direct.k.insertInto("repo_permissions").values({ login, repo: repo(r), permission: "write", checked_at: iso(0) }));
}
const bundle = { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", timeoutSeconds: 600, maxTurns: 10, stdin: "x".repeat(5000), system: null, mounts: [], mcpServers: [], keepSession: false, hints: {} };
for (let i = 0; i < 30; i++) {
  await enqueueCall(w.db, { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", askedModel: "opus", bundle: bundle as never, items: [{ repo: repo(i), number: 1 }], level: i % 5, maxAttempts: 2 });
}
if (args.includes("--large")) {
  // Copies of one PR per repo without a review, one with, and of issues, at new numbers, so a pass loads a production-sized set.
  const copy = async (table: keyof typeof COLUMNS, from: string, step: number, times: number, set: Record<string, string> = {}): Promise<void> => {
    const cols = COLUMNS[table].filter((c) => c !== "id");
    const q = (c: string) => `"${c}"`;
    await direct.script(`INSERT INTO ${table} (${cols.map(q).join(", ")}) SELECT ${cols.map((c) => c === "number" ? `number + g * ${step}` : set[c] ?? q(c)).join(", ")} FROM ${table}, generate_series(1, ${times}) g WHERE ${from} ON CONFLICT DO NOTHING`);
  };
  const perItem = ["items", "classifications", "item_priority", "item_settled"] as const;
  for (const t of perItem) await copy(t, "number BETWEEN 101 AND 180", 1000, 9);
  for (const t of [...perItem, "pr_checks", "pr_files", "opus_reviews", "verifications", "premerge_reviews"] as const) {
    await copy(t, "number = 2", 100_000, 200, t === "items" ? { title: "title || ' ' || g", body: "repeat('A sentence of the description. ', 60)", mergeable: "'MERGEABLE'" } : {});
    if (t !== "opus_reviews") await copy(t, "number = 4", 100_000, 340, t === "items" ? { body: "repeat('A sentence of the description. ', 60)" } : t === "pr_checks" ? { checks: "(SELECT json_agg(json_build_object('name', 'check number ' || n, 'state', 'SUCCESS'))::text FROM generate_series(1, 30) n)" } : {});
    await copy(t, "number = 1 AND repo <> 'app'", 1_000_000, 84, t === "items" ? { state: "'MERGED'", merged_at: "updated_at" } : {});
  }
}
await direct.script("ANALYZE");
const name = ((await direct.prepare("SELECT current_database() AS n").get()) as { n: string }).n;

// ---- the handle under test, through the proxy ----
const url = new URL(process.env.AUTOCRAFT_TEST_PG_URL);
const proxy = await startLatencyProxy({ host: url.hostname, port: Number(url.port || 5432) }, { delayMs });
url.host = `127.0.0.1:${proxy.port}`;
url.pathname = `/${name}`;
const db: Db = await connectDb(url.toString(), { role: "runner", migrate: false });

// The longest idle time per transaction, read by another process: this one's event loop is busy exactly while a transaction idles.
const idle = spawn(process.execPath, ["--input-type=module", "-e", `
  import pg from "pg";
  const c = new pg.Client({ connectionString: process.argv[1] }); await c.connect();
  let max = 0, at = "";
  process.on("SIGTERM", async () => { console.log("longest idle in transaction: " + Math.round(max) + " ms after " + at); process.exit(0); });
  for (;;) {
    const { rows } = await c.query("SELECT extract(epoch FROM clock_timestamp() - state_change) * 1000 AS ms, left(regexp_replace(query, '\\s+', ' ', 'g'), 120) AS q FROM pg_stat_activity WHERE datname = $1 AND state = 'idle in transaction'", [process.argv[2]]);
    for (const r of rows) if (Number(r.ms) > max) { max = Number(r.ms); at = r.q; }
    await new Promise((r) => setTimeout(r, 20));
  }`, process.env.AUTOCRAFT_TEST_PG_URL, name], { stdio: "inherit", cwd: process.cwd() });

// --unfused sends every read by itself, so the trace shows what each costs on the server.
if (args.includes("--unfused")) (db as { together: Db["together"] }).together = (fn) => fn();
const decided: Record<string, unknown> = {};
async function unit<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const texts = new Map<string, number>();
  const timeline: string[] = [];
  const t0 = performance.now(), cpu0 = process.cpuUsage();
  const off = db.observe((e) => {
    if (e.kind === "write-lock") { timeline.push(`write lock held ${Math.round(e.holdMs)} ms  <- ${e.site}`); return; }
    const end = performance.now() - t0;
    timeline.push(`${String(Math.round(end - e.ms)).padStart(5)} +${String(Math.round(e.ms)).padStart(4)} ms ${String(e.rows).padStart(5)} rows ${String(Math.round(e.bytes / 1024)).padStart(5)} KB  ${e.sql.length > 9000 ? `[${Math.round(e.sql.length / 1024)} KB sql] ` : ""}${e.site.replace(/\(?file:\S*\/(?=src\/)/g, "").slice(0, width)}`);
    const t = `${e.sql.replace(/\s+/g, " ").slice(0, 150)}  <- ${e.site.replace(/\(?file:\S*\/(?=src\/)/, "").slice(0, 200)}`;
    texts.set(t, (texts.get(t) ?? 0) + 1);
  });
  const c = countQueries(db);
  const { value, stats } = await db.meter(fn);
  const ms = performance.now() - t0, cpu = process.cpuUsage(cpu0);
  c.stop();
  off();
  if (!only || label.includes(only)) {
    console.log(`${label.padEnd(26)} ${String(Math.round(ms)).padStart(6)} ms wall  ${String(Math.round((cpu.user + cpu.system) / 1000)).padStart(5)} ms cpu  ${String(stats.statements).padStart(4)} statements  ${String(stats.roundTrips).padStart(4)} trips  ${String(stats.rows).padStart(6)} rows  ${Math.round(c.counts.bytes / 1024)} KB`);
    if (trace) for (const t of timeline) console.log(`    ${t}`);
    if (statements) for (const [t, n] of [...texts].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${t}`);
    if (sites) for (const [s, v] of [...c.counts.sites].sort((a, b) => b[1].roundTrips - a[1].roundTrips).slice(0, sites)) console.log(`    ${String(v.roundTrips).padStart(4)}  ${String(Math.round(v.ms)).padStart(5)} ms ${String(v.rows).padStart(6)} rows  ${s.replace(/\(?file:\S*\/(?=src\/)/g, "").slice(0, 220)}`);
  }
  return value;
}
const pass = async (label: string) => {
  const found = await unit(label, () => detectAutopilot(db, { incremental: true, log: (l) => { if (/took|:/.test(l)) console.log(`    log: ${l}`); } }));
  if (!only || label.includes(only)) console.log(`    ${found.timing?.pass}: plans ${Math.round(found.timing!.loadMs)} ms, lanes ${Math.round(found.timing!.lanesMs)} ms, cache ${Math.round(found.timing!.cacheMs)} ms, ${found.proposals.length} proposals`);
  if (dump) decided[label] = {
    proposals: found.proposals, wakeAt: found.wakeAt, status: found.status, facts: await loadPlanSet(db),
    plans: await direct.all(direct.k.selectFrom("item_plans").selectAll().orderBy("repo").orderBy("number")),
    lanes: await direct.all((direct.k as any).selectFrom("lane_next").selectAll().orderBy("lane")),
  };
  return found;
};
const touch = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await direct.run(direct.k.updateTable("items").set({ comments_count: 7, updated_at: iso(1) }).where("repo", "=", repo(i)).where("number", "=", 1 + (i % 4)));
};
try {
  // Warms the pool's connections, so no unit counts their start.
  await Promise.all(Array.from({ length: 3 }, () => db.seqs()));
  await pass("full, first in process");
  dropPlanState(db);
  await pass("full, second");
  await pass("incremental, quiet");
  await touch(1);
  await pass("incremental, 1 item");
  await touch(20);
  await pass("incremental, 20 items");
  if (!args.includes("--passes")) {
    await unit("job start: PRs to review", () => planned(db, "review", { repo: "app" }));
    await unit("job start: PRs to fix up", () => planned(db, "fixup", { repo: "app1" }));
    await unit("job start: items to label", () => plannedItems(db, "label", { repo: "app1" }));
    await unit("due check, quiet", () => planDue(db));
    await unit("due check, quiet again", () => planDue(db));
    const defs = await loadSteps();
    await unit("Next page: lane gates", () => laneGates(db, LANES, defs));
    const found = await pass("incremental, before apply");
    await unit(`apply ${found.proposals.length} proposals`, () => applyProposals(db, found.proposals, { wakeAt: found.wakeAt ?? null, ...(found.status ? { status: found.status } : {}) }));
    if (dump) {
      decided.queued = await direct.all(direct.k.selectFrom("jobs").select(["step", "params", "state", "requested_by"]).orderBy("id"));
      writeFileSync(dump, JSON.stringify(decided, null, 1));
    }
  }
} finally {
  idle.kill();
  await new Promise((r) => idle.once("close", r));
  await db.close();
  await proxy.close();
  w.close();
  await w.db.close();
}
