// merge module, part b: verifications, PR builds, screenshots and CI run approvals (SQLite; Postgres when AUTOCRAFT_TEST_PG_URL is set).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db, Dialect } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import { TEST_PG_URL, testDatabase } from "../test-db.ts";
import { expectFlat } from "../helpers/query-count.ts";
import {
  addScreenshotRuns, listVerifications, loadLateDisagreements, loadLatestVerification, loadPendingPrBuilds, loadPendingScreenshotRuns,
  loadPendingVerifications, loadPrBuildStates, loadPrBuildViews, loadRunApprovals, loadScreenshotConfigs, loadScreenshotRuns, loadVerifications, loadVerifyDue,
  markRereads, markVerificationsStale, restartPrBuilds, restartVerifications, saveRunResults, saveVerifications, settlePrBuilds, settleScreenshotRuns,
  settleVerifications, skipQueuedFeatureRuns,
} from "../../src/data/merge/index.ts";

const T0 = "2026-01-01T00:00:00.000Z";

async function withDb(dialect: Dialect, fn: (db: Db) => Promise<unknown>): Promise<unknown> {
  const t = await testDatabase("", dialect);
  try { return await fn(await t.open({ app: true })); } finally { await t.close(); }
}

function both(name: string, fn: (db: Db) => Promise<unknown>): void {
  test(name, async () => {
    const lite = await withDb("sqlite", fn);
    if (TEST_PG_URL) assert.deepEqual(await withDb("postgres", fn), lite);
  });
}

const refs = (n: number) => Array.from({ length: n }, (_, i) => ({ repo: "app", number: i + 1 }));

/** `n` open PRs in a live workflow, each with a planned verification, a queued build, a planned screenshot run and a run approval at head `h<number>`. */
async function seed(db: Db, n: number): Promise<void> {
  const q = queryDb(db);
  const k = q.k as any;
  for (const r of refs(n)) {
    await q.run(k.insertInto("items").values({ repo: r.repo, number: r.number, kind: "pr", state: "OPEN", head_oid: `h${r.number}`, title: "t", created_at: T0, updated_at: T0 }));
    await q.run(k.insertInto("item_workflows").values({ repo: r.repo, number: r.number, kind: "pr", entry: "review", state: "running", started_by: "x", started_at: T0, started_via: "test", updated_at: T0 }));
    await q.run(k.insertInto("verifications").values({ repo: r.repo, number: r.number, head_sha: `h${r.number}`, kind: "tests", reason: "x", state: "planned", created_at: T0 }));
    await q.run(k.insertInto("pr_builds").values({ repo: r.repo, number: r.number, head_sha: `h${r.number}`, scope: "all", state: "queued", created_at: T0 }));
    await q.run(k.insertInto("screenshot_runs").values({ repo: r.repo, number: r.number, head_sha: `h${r.number}`, state: "planned", created_at: T0 }));
    await q.run(k.insertInto("ci_run_approvals").values({ repo: r.repo, number: r.number, head_oid: `h${r.number}`, runs: "[]", approved: "[1]", failed: "{}", checked_at: T0 }));
  }
}

/** Runs `fn` at two sizes on each configured engine and checks that the statement count does not grow with the size. */
function flat(name: string, fn: (db: Db, n: number) => Promise<unknown>): void {
  test(name, async () => {
    for (const dialect of (TEST_PG_URL ? ["sqlite", "postgres"] : ["sqlite"]) as Dialect[]) {
      await expectFlat(async (n) => {
        const t = await testDatabase("", dialect);
        const db = await t.open({ app: true });
        await seed(db, n);
        return { db, run: () => fn(db, n), close: () => t.close() };
      }, 2, 12);
    }
  });
}

flat("verification loaders issue the same statements at 2 and 12 PRs", async (db, n) => {
  await Promise.all([loadVerifications(db, refs(n)), listVerifications(db, { states: ["planned"] }), loadLatestVerification(db, refs(n)), loadPendingVerifications(db), loadVerifyDue(db)]);
});
flat("PR build and screenshot loaders issue the same statements at 2 and 12 PRs", async (db, n) => {
  await Promise.all([
    loadPrBuildViews(db, refs(n).map((r) => ({ ref: `${r.repo}#${r.number}`, head: `h${r.number}` }))), loadPendingPrBuilds(db, "app"), loadLateDisagreements(db, "app"),
    loadPrBuildStates(db, ["app"], 0), loadScreenshotRuns(db, refs(n)), loadPendingScreenshotRuns(db), loadScreenshotConfigs(db),
  ]);
});
flat("run approval reads and writers issue the same statements at 2 and 12 PRs", async (db, n) => {
  await loadRunApprovals(db, refs(n));
  await markRereads(db, refs(n).map((r) => ({ ...r, head: `h${r.number}` })), T0);
  await saveRunResults(db, refs(n).map((r) => ({ key: `app#${r.number}@h${r.number}`, runs: [], approved: [2], failed: {}, approvedNow: true })));
});
flat("verification writers issue the same statements at 2 and 12 PRs", async (db, n) => {
  const keys = refs(n).map((r) => `app#${r.number}@h${r.number}`);
  await saveVerifications(db, refs(n).map((r) => ({
    repo: r.repo, number: r.number, headSha: `h${r.number}`, baseSha: null, kind: "tests", reason: "y", plan: { a: 1 }, model: null, headTaskId: null, baseTaskId: null,
    state: "planned", summary: null, note: null, at: T0, finishedAt: null,
  })));
  await settleVerifications(db, keys.map((key) => ({ key, from: ["planned"], set: { state: "passed", finishedAt: T0 } })));
  await restartVerifications(db, keys.map((key) => ({ key, headTask: null, baseTask: null })));
  await markVerificationsStale(db, keys);
  await settlePrBuilds(db, keys.map((key) => ({ key, from: "queued", set: { state: "passed", finishedAt: T0 } })));
  await restartPrBuilds(db, keys.map((key) => ({ key, taskId: 7 })));
  await settleScreenshotRuns(db, keys.map((key) => ({ key, from: ["planned"], set: { state: "compared", clear: true } })));
});

both("verification settle is compare-and-set and keeps columns it does not set", async (db) => {
  await seed(db, 3);
  await settleVerifications(db, [{ key: "app#1@h1", from: ["planned"], set: { state: "failed", summary: "boom", finishedAt: T0 } }]);
  const changed = await settleVerifications(db, [
    { key: "app#1@h1", from: ["planned", "running"], set: { state: "passed" } },
    { key: "app#2@h2", from: ["planned", "running"], set: { state: "running" } },
    { key: "app#3@h3", from: ["planned"], set: { state: "error", summary: "e" } },
  ]);
  assert.deepEqual([...changed].sort(), ["app#2@h2", "app#3@h3"]);
  const all = await loadVerifications(db, refs(3));
  assert.equal(all.get("app#1@h1")!.state, "failed");
  assert.equal(all.get("app#1@h1")!.summary, "boom");
  assert.equal(all.get("app#2@h2")!.state, "running");
  assert.equal(all.get("app#2@h2")!.summary, null);
  assert.equal(await markVerificationsStale(db, ["app#1@h1", "app#1@other"]), 1);
  return [...all.keys()].sort();
});

both("verification rows: head filter, latest per ref, due check and pending list follow the item's head", async (db) => {
  await seed(db, 2);
  await saveVerifications(db, [{ repo: "app", number: 1, headSha: "old", baseSha: null, kind: "tests", reason: "r", plan: null, model: null, headTaskId: null, baseTaskId: null, state: "passed", summary: null, note: null, at: "2025-12-01T00:00:00.000Z", finishedAt: null }]);
  const heads = await loadVerifications(db, refs(2), { heads: true });
  assert.deepEqual([...heads.keys()].sort(), ["app#1@h1", "app#2@h2"]);
  assert.equal((await loadVerifications(db, refs(2))).size, 3);
  const latest = await loadLatestVerification(db, refs(2));
  assert.equal(latest.get("app#1")!.head, "h1");
  const pending = await loadPendingVerifications(db);
  assert.equal(pending.length, 2);
  assert.ok(pending.every((p) => p.itemState === "OPEN" && p.currentHead === `h${p.number}`));
  assert.equal((await loadVerifyDue(db)).verifications, false);
  const q = queryDb(db);
  await q.run((q.k as any).updateTable("items").set({ head_oid: "moved" }).where("number", "=", 2));
  const due = await loadVerifyDue(db);
  assert.equal(due.verifications, true);
  assert.equal(due.screenshots, true);
  assert.deepEqual(due.shotRepos, ["app"]);
  await q.run((q.k as any).updateTable("items").set({ state: "CLOSED" }).where("number", "=", 1));
  const closed = (await loadPendingVerifications(db)).find((p) => p.number === 1)!;
  assert.equal(closed.itemState, "CLOSED");
  assert.ok(closed.inScope);
  // Started and then out of scope: the verification is collected, the screenshot run is not.
  await q.run((q.k as any).updateTable("item_workflows").set({ state: "stopped" }));
  assert.deepEqual((await loadPendingVerifications(db)).map((p) => p.inScope), [false, false]);
  const out = await loadVerifyDue(db);
  assert.deepEqual([out.verifications, out.screenshots, out.shotRepos], [true, false, []]);
  return null;
});

both("PR build settle flags a disagreement once and a retry adds one", async (db) => {
  await seed(db, 2);
  const failed = await settlePrBuilds(db, [{ key: "app#1@h1", from: "queued", set: { state: "failed", summary: "test failed", finishedAt: T0 } }]);
  assert.deepEqual([...failed], ["app#1@h1"]);
  const q = queryDb(db);
  await q.run((q.k as any).insertInto("pr_checks").values({ repo: "app", number: 1, head_oid: "h1", overall: "success", checks: "[]", fetched_at: T0 }));
  assert.deepEqual((await loadLateDisagreements(db, "app")).map((d) => d.number), [1]);
  const flag = { key: "app#1@h1", from: "failed" as const, set: { state: "failed", disagree: true, ciOverall: "success" } };
  assert.equal((await settlePrBuilds(db, [flag])).size, 1);
  assert.equal((await settlePrBuilds(db, [flag])).size, 0);
  assert.equal((await loadLateDisagreements(db, "app")).length, 0);
  assert.equal((await settlePrBuilds(db, [{ key: "app#2@h2", from: "failed", set: { state: "passed" } }])).size, 0);
  await restartPrBuilds(db, [{ key: "app#2@h2", taskId: 9 }, { key: "app#2@h2", taskId: 10 }]);
  // Task states are read for queued builds only; the build task loader lands with the build module.
  await settlePrBuilds(db, [{ key: "app#2@h2", from: "queued", set: { state: "passed" } }]);
  const views = await loadPrBuildViews(db, [{ ref: "app#1", head: "h1" }, { ref: "app#2", head: null }]);
  assert.equal(views.get("app#1")!.disagree, true);
  assert.equal(views.get("app#1")!.state, "failed");
  assert.equal(views.get("app#2")!.retried, 1);
  assert.equal(views.get("app#2")!.taskId, 10);
  const state = (await loadPrBuildStates(db, ["app"], Date.parse(T0) - 1000)).get("app")!;
  assert.equal(state.usedSince, 2);
  assert.ok(state.have.has("1@h1"));
  assert.equal((await loadPrBuildStates(db, ["app"], Date.parse(T0) + 1000)).get("app")?.usedSince, 0);
  return null;
});

both("screenshot runs: settle with a state guard, skip queued runs, add ignores existing heads", async (db) => {
  await seed(db, 2);
  await addScreenshotRuns(db, [
    { repo: "app", number: 1, headSha: "h1", baseSha: null, state: "skipped", reason: "dup", plan: null, headTaskId: null, baseTaskId: null, createdAt: T0 },
    { repo: "app", number: 1, headSha: "h9", baseSha: "b", state: "skipped", reason: "no ui", plan: { steps: [] }, headTaskId: null, baseTaskId: null, createdAt: T0 },
  ]);
  const runs = await loadScreenshotRuns(db, refs(2));
  assert.equal(runs.get("app#1@h1")!.state, "planned");
  assert.equal(runs.get("app#1@h9")!.finishedAt, T0);
  const changed = await settleScreenshotRuns(db, [
    { key: "app#1@h1", from: ["planned", "running"], set: { state: "compared", clear: true, verdict: "regression", held: true, comparison: "worse", finishedAt: T0 } },
    { key: "app#1@h9", from: ["planned"], set: { state: "running" } },
  ]);
  assert.deepEqual([...changed], ["app#1@h1"]);
  const after = await loadScreenshotRuns(db, refs(1));
  assert.equal(after.get("app#1@h1")!.clear, true);
  assert.equal(after.get("app#1@h1")!.held, true);
  assert.equal(after.get("app#1@h9")!.state, "skipped");
  assert.equal((await loadPendingScreenshotRuns(db)).length, 1);
  assert.deepEqual(await skipQueuedFeatureRuns(db, "screenshots", "app"), { taskSteps: ["screenshot"] });
  assert.equal((await loadPendingScreenshotRuns(db)).length, 0);
  assert.equal((await loadScreenshotRuns(db, refs(2))).get("app#2@h2")!.state, "skipped");
  await skipQueuedFeatureRuns(db, "pr-builds");
  return null;
});

both("run results merge approved run ids, clear the reread mark and stamp the approval time", async (db) => {
  await seed(db, 2);
  await markRereads(db, [{ repo: "app", number: 1, head: "h1" }], T0);
  assert.equal((await loadRunApprovals(db, refs(1))).get("app#1@h1")!.reread, true);
  await markRereads(db, [{ repo: "app", number: 1, head: "h1b" }], T0);
  const moved = await loadRunApprovals(db, refs(2));
  assert.ok(moved.has("app#1@h1b") && !moved.has("app#1@h1"));
  await saveRunResults(db, [
    { key: "app#2@h2", runs: [{ id: 5, name: "ci", event: "pull_request" }], approved: [2, 3], failed: { "5": 1 }, approvedNow: true },
    { key: "app#1@h1b", runs: [], approved: [], failed: {}, approvedNow: false },
  ]);
  const got = await loadRunApprovals(db, refs(2));
  const two = got.get("app#2@h2")!;
  assert.deepEqual(two.approved.sort(), [1, 2, 3]);
  assert.equal(two.runs.length, 1);
  assert.ok(two.approvedAt !== null);
  assert.equal(got.get("app#1@h1b")!.reread, false);
  assert.equal(got.get("app#1@h1b")!.approvedAt, null);
  return null;
});
