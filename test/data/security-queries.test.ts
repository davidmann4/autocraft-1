// security module: finding moves, scan endings, round clearing, reconcile, quiet PRs and the page loaders
// (SQLite; Postgres when AUTOCRAFT_TEST_PG_URL is set).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db, Dialect } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import { TEST_PG_URL, testDatabase } from "../test-db.ts";
import { expectFlat } from "../helpers/query-count.ts";
import {
  addCalls, addFindings, addScanFindings, countEnvWaits, listScans, loadActiveScans, loadFindingAttention, loadFindingsForLinking, loadFindingsToFix, loadFixPrFindings, loadOverview, loadScanGuard, addQuietPrs, addScan, advanceFinding, advanceFindings, beginScanCall, clearRounds, countFindings, endScanCall, finishArea, finishScanTests, finishScans, listQuietPrs,
  loadFindingBoard, loadFindingDetail, loadFindings, loadFixesToAdvance, loadQuiet, loadRoundLog, loadRounds, loadScanDetail, loadScanRun, loadScans, markDuplicates, reconcileSecurity,
  resumeScan, saveRound, saveScanTest, saveThreatModel, setFindingEnvWait, type NewFinding,
} from "../../src/data/security/index.ts";

const T0 = "2020-01-01T00:00:00.000Z";

async function withDb<T>(dialect: Dialect, fn: (db: Db) => Promise<T>): Promise<T> {
  const t = await testDatabase("", dialect);
  try { return await fn(await t.open({ app: true })); } finally { await t.close(); }
}

/** Runs on SQLite, and on Postgres when a server is configured, whose result must equal SQLite's. */
function both(name: string, fn: (db: Db) => Promise<unknown>): void {
  test(name, async () => {
    const lite = await withDb("sqlite", fn);
    if (TEST_PG_URL) assert.deepEqual(await withDb("postgres", fn), lite);
  });
}

const k = (db: Db) => queryDb(db).k as any;
const finding = (number: number, over: Partial<NewFinding> = {}): NewFinding => ({
  repo: "app", number, scan_id: 1, area: "net", title: `finding ${number}`, severity: "high", urgent: 0, state: "new", refs: "[]", category: null, reach: "r", impact: "i", verification: null,
  fingerprint: `fp${number}`, fix_commit: null, fix_pr: null, ghsa_id: null, fork: null, fix_patch: null, fix_title: null, fix_summary: null, fix_branch: null, fix_files: null, fix_ref: null,
  note: null, env_wait_at: null, reason: null, decided_by: null, duplicate_of: null, fix_attempts: 0, last_failure: null, ...over,
});
const addJob = async (db: Db, step: string, state: string, params: object, repo: string | null = null): Promise<number> =>
  (await queryDb(db).get(k(db).insertInto("jobs").values({ step, params: JSON.stringify(params), requested_by: "x", requested_at: T0, state, repo }).returning("id")) as { id: number }).id;
const stateOf = async (db: Db, repo: string, number: number): Promise<string | undefined> =>
  ((await loadFindings(db, [`${repo}#${number}`], { internal: true })).get(`${repo}#${number}`))?.state;

both("advanceFindings moves only findings in a from state, bumps attempts and restores them", async (db) => {
  const scan = await addScan(db, { repo: "app", cap_usd: null, started_by: "u" });
  await addFindings(db, "app", [finding(1, { scan_id: scan }), finding(2, { scan_id: scan }), finding(3, { scan_id: scan, state: "ready" })]);
  const moved = await advanceFindings(db, [
    { repo: "app", number: 1, from: ["new", "backlog"], to: "fixing", set: { note: "one", bumpFixAttempts: true }, by: "ann" },
    { repo: "app", number: 2, from: ["new", "backlog"], to: "fixing", set: { note: "two", bumpFixAttempts: true }, by: "bob" },
    { repo: "app", number: 3, from: ["new", "backlog"], to: "fixing", set: { note: "three", bumpFixAttempts: true }, by: "cy" },
  ]);
  assert.deepEqual([...moved].sort(), ["app#1", "app#2"]);
  const rows = await loadFindings(db, ["app#1", "app#2", "app#3"]);
  assert.equal(rows.get("app#1")!.note, "one");
  assert.equal(rows.get("app#2")!.note, "two");
  assert.equal(rows.get("app#2")!.decided_by, "bob");
  assert.equal(rows.get("app#1")!.fix_attempts, 1);
  assert.equal(rows.get("app#3")!.state, "ready");
  assert.equal(rows.get("app#3")!.fix_attempts, 0);
  assert.equal(await advanceFinding(db, { repo: "app", number: 1, from: ["fixing"], to: "new", set: { last_failure: "boom", restoreFixAttempts: 0 } }), true);
  assert.equal(await advanceFinding(db, { repo: "app", number: 1, from: ["fixing"], to: "new" }), false);
  const back = (await loadFindings(db, ["app#1"])).get("app#1")!;
  assert.equal(back.fix_attempts, 0);
  assert.equal(back.last_failure, "boom");
});

test("advanceFindings and addFindings issue the same statements for any number of findings", async () => {
  await expectFlat(async (n) => {
    const t = await testDatabase("", "sqlite");
    const db = await t.open({ app: true });
    await addFindings(db, "app", Array.from({ length: n }, (_, i) => finding(i + 1)));
    return { db, close: () => t.close(), run: async () => {
      await advanceFindings(db, Array.from({ length: n }, (_, i) => ({ repo: "app", number: i + 1, from: ["new" as const], to: "fixing" as const, set: { note: `n${i}` } })));
      await addFindings(db, "other", Array.from({ length: n }, (_, i) => finding(i + 1)));
    } };
  }, 2, 40);
});

both("finishScans ends only active scans and releases their unverified findings; resumeScan picks the state to continue in", async (db) => {
  const q = queryDb(db);
  const a = await addScan(db, { repo: "app", cap_usd: null, started_by: "u" });
  const b = await addScan(db, { repo: "lib", cap_usd: 5, started_by: "u" });
  await addFindings(db, "app", [finding(1, { scan_id: a, state: "unverified" }), finding(2, { scan_id: a, state: "disproved" })]);
  assert.deepEqual((await finishScans(db, [{ id: a, state: "failed", error: "x" }, { id: b, state: "capped" }])).ended.sort(), [a, b]);
  assert.equal(await stateOf(db, "app", 1), "new");
  assert.equal(await stateOf(db, "app", 2), "disproved");
  // The job of a scan that Stop ended stores findings until it notices; its own finish lists them.
  const [first, repeat] = await addScanFindings(db, "app", [finding(0, { scan_id: a, state: "unverified" }), { ...finding(0, { scan_id: a, state: "duplicate" }), repeats: 0 }]);
  assert.deepEqual((await finishScans(db, [{ id: a, state: "done" }])).ended, []);
  assert.equal(await stateOf(db, "app", first!), "new");
  assert.equal((await loadFindings(db, [`app#${repeat}`], { internal: true })).get(`app#${repeat}`)!.duplicate_of, first);
  const scans = await loadScans(db, [a, b]);
  assert.equal(scans.get(a)!.state, "failed");
  assert.equal(scans.get(a)!.finding_count, 2);
  // A capped scan with no threat model starts over; one with a threat model and an unchecked finding verifies first.
  assert.deepEqual(await resumeScan(db, { id: b, cap_usd: 9 }), { state: "modeling" });
  assert.equal(await resumeScan(db, { id: b, cap_usd: 9 }), null);
  await q.run(k(db).updateTable("security_scans").set({ state: "capped", threat_model: "{}" }).where("id", "=", a));
  assert.deepEqual(await resumeScan(db, { id: a, cap_usd: null }), { state: "verifying" });
  assert.equal(await stateOf(db, "app", 1), "unverified");
});

both("clearRounds logs the rounds under the finding's attempt, deletes them and returns their sessions", async (db) => {
  await addFindings(db, "app", [finding(1, { state: "ready", fix_attempts: 2 }), finding(2, { state: "fixing", fix_attempts: 1 })]);
  const round = (number: number, n: number, state: string, session: string | null) => ({ repo: "app", number, round: n, patch: "p", test_patch: "t", title: "ti", summary: "s", head_task: 1, base_task: 2, retried: 0, session, state, failure: null, created_at: T0 });
  await saveRound(db, round(1, 1, "failed", null));
  await saveRound(db, round(1, 2, "building", "sess-a"));
  await saveRound(db, round(2, 1, "building", "sess-b"));
  await saveRound(db, round(2, 1, "building", "sess-c"));
  assert.equal((await loadRounds(db, ["app#2"])).get("app#2")!.length, 1);
  const { sessions } = await clearRounds(db, ["app#1", "app#2"]);
  assert.deepEqual(sessions.sort(), ["sess-a", "sess-c"]);
  assert.equal((await loadRounds(db, ["app#1", "app#2"])).size, 0);
  const log = await loadRoundLog(db, ["app#1", "app#2"]);
  assert.deepEqual(log.get("app#1")!.map((r) => [r.attempt, r.round, r.state]), [[2, 1, "failed"], [2, 2, "passed"]]);
  assert.deepEqual(log.get("app#2")!.map((r) => [r.attempt, r.round, r.state]), [[1, 1, "building"]]);
});

both("reconcileSecurity closes scans of ended or missing jobs and frees findings whose job is gone", async (db) => {
  const stopped = await addScan(db, { repo: "a", cap_usd: null, started_by: "u" });
  const failed = await addScan(db, { repo: "b", cap_usd: null, started_by: "u" });
  const orphan = await addScan(db, { repo: "c", cap_usd: null, started_by: "u" });
  const live = await addScan(db, { repo: "d", cap_usd: null, started_by: "u" });
  const q = queryDb(db);
  const job = async (id: number, state: string) => q.run(k(db).updateTable("security_scans").set({ job_id: await addJob(db, "security-scan", state, { repo: "x", scan: id }) }).where("id", "=", id));
  await job(stopped, "cancelled");
  await job(failed, "done");
  await job(live, "running");
  await q.run(k(db).updateTable("security_scans").set({ started_at: T0 }).where("id", "=", orphan));
  await addFindings(db, "app", [
    finding(1, { state: "fixing", updated_at: T0 }), finding(2, { state: "fixing", updated_at: T0 }), finding(3, { state: "landing", updated_at: T0 }),
    finding(4, { state: "landing", fix_pr: 9, updated_at: T0 }), finding(5, { state: "fixing", updated_at: T0, env_wait_at: T0 }),
  ]);
  await addJob(db, "security-fix", "running", { repo: "app", number: 2 });
  await saveRound(db, { repo: "app", number: 1, round: 1, patch: "p", test_patch: "t", title: "t", summary: "s", head_task: 1, base_task: 2, retried: 0, session: null, state: "failed", failure: null, created_at: T0 });
  const r = await reconcileSecurity(db);
  assert.deepEqual(r, { scans: 3, findings: 2 });
  const scans = await loadScans(db, [stopped, failed, orphan, live]);
  assert.deepEqual([stopped, failed, orphan, live].map((id) => scans.get(id)!.state), ["stopped", "failed", "failed", "modeling"]);
  const states = await loadFindings(db, ["app#1", "app#2", "app#3", "app#4", "app#5"]);
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => states.get(`app#${n}`)!.state), ["new", "fixing", "ready", "landing", "fixing"]);
  assert.ok(states.get("app#1")!.last_failure);
  assert.equal((await loadRoundLog(db, ["app#1"])).get("app#1")!.length, 1);
  assert.deepEqual(await reconcileSecurity(db), { scans: 0, findings: 0 });
});

test("reconcileSecurity issues the same statements for any number of stale scans and findings", async () => {
  await expectFlat(async (n) => {
    const t = await testDatabase("", "sqlite");
    const db = await t.open({ app: true });
    for (let i = 0; i < n; i++) await addScan(db, { repo: `r${i}`, cap_usd: null, started_by: "u" });
    await queryDb(db).run(k(db).updateTable("security_scans").set({ started_at: T0 }));
    await addFindings(db, "app", Array.from({ length: n }, (_, i) => finding(i + 1, { state: "fixing", updated_at: T0 })));
    return { db, close: () => t.close(), run: () => reconcileSecurity(db) };
  }, 2, 20);
});

both("quiet PRs: landing fixes on the quiet route and remembered closed ones, until the finding is published", async (db) => {
  await addFindings(db, "app", [
    finding(1, { state: "landing", fix_pr: 10 }), finding(2, { state: "landed", fix_pr: 11, fork: "fork/app" }), finding(3, { state: "ready", fix_pr: null }), finding(4, { state: "published" }),
  ]);
  await addQuietPrs(db, [{ repo: "app", pr: 20, finding: 3 }, { repo: "app", pr: 21, finding: 4 }]);
  await addQuietPrs(db, [{ repo: "app", pr: 20, finding: 3 }]);
  const all = await listQuietPrs(db);
  assert.deepEqual([...all].sort(), ["app#10", "app#20"]);
  const asked = ["app#10", "app#11", "app#20", "app#21", "app#99"];
  const quiet = await loadQuiet(db, asked);
  assert.deepEqual([...quiet].sort(), [...all].sort());
  assert.deepEqual([...await listQuietPrs(db, { repo: "other" })], []);
});

both("endScanCall records the call, costs and verdict together; finishArea estimates from the area average", async (db) => {
  const scan = await addScan(db, { repo: "app", cap_usd: 10, started_by: "u" });
  await addFindings(db, "app", [finding(1, { scan_id: scan, state: "unverified" })]);
  await saveThreatModel(db, scan, { summaryJson: "{}", guessUsd: 3, areas: [0, 1, 2].map((idx) => ({ idx, name: `a${idx}`, paths: "[]", entry_points: "[]", risk: 1, why: null })) });
  assert.equal((await loadScans(db, [scan])).get(scan)!.areas_total, 3);
  const call = await beginScanCall(db, { scanId: scan, kind: "verify", areaIdx: 0, finding: 1 });
  await endScanCall(db, { callId: call, scanId: scan, ok: true, costUsd: 2, runId: null, chargeUsd: 2, billArea: 0, finding: { repo: "app", number: 1, state: "new", patch: { verification: "{}" } } });
  assert.equal(await stateOf(db, "app", 1), "new");
  await finishArea(db, { scanId: scan, idx: 0, failed: false });
  const s = (await loadScans(db, [scan])).get(scan)!;
  assert.equal(s.cost_usd, 2);
  assert.equal(s.areas_done, 1);
  assert.ok(s.estimate_usd! > s.cost_usd);
  const run = (await loadScanRun(db, scan))!;
  assert.deepEqual(run.callCosts, [{ kind: "verify", costUsd: 2 }]);
  assert.equal(run.areas[0]!.state, "done");
  assert.equal(run.areas[0]!.cost_usd, 2);
  const detail = (await loadScanDetail(db, scan))!;
  assert.deepEqual(detail.calls.map((c) => c.area_name), ["a0"]);
  assert.equal(detail.findings.length, 1);
});

both("markDuplicates and finishScanTests only touch findings in the state the move expects", async (db) => {
  await addFindings(db, "app", [finding(1), finding(2, { state: "dismissed" }), finding(3), finding(4)]);
  assert.deepEqual((await markDuplicates(db, [{ repo: "app", number: 2, duplicateOf: 1 }, { repo: "app", number: 3, duplicateOf: 1 }])).sort(), ["app#3"]);
  assert.equal(await countFindings(db, { repo: "app", state: "duplicate" as never }), 1);
  const test = (number: number, state: string) => ({ repo: "app", number, test_path: "t.rs", crate: "c", test_patch: "p", test_source: "s", task_id: 1, retried: 0, state, detail: null, created_at: T0, ended_at: null });
  await saveScanTest(db, test(1, "building"));
  await saveScanTest(db, test(4, "building"));
  await saveScanTest(db, test(2, "confirmed"));
  const n = await finishScanTests(db, [{ repo: "app", number: 1, state: "not-shown", detail: "passes today" }, { repo: "app", number: 4, state: "confirmed", detail: "fails" }, { repo: "app", number: 2, state: "not-shown", detail: "late" }]);
  assert.equal(n, 2);
  const rows = await loadFindings(db, ["app#1", "app#2", "app#4"]);
  assert.equal(rows.get("app#1")!.note, "passes today");
  assert.equal(rows.get("app#2")!.note, null);
  assert.equal(rows.get("app#4")!.note, null);
});

both("loadFixesToAdvance lists building rounds then confidential waits, skipping findings with a live fix job", async (db) => {
  await addFindings(db, "app", [finding(1, { state: "fixing", decided_by: "ann" }), finding(2, { state: "fixing" }), finding(3, { state: "fixing", env_wait_at: T0 }), finding(4, { state: "fixing", env_wait_at: T0 })]);
  const round = (number: number) => ({ repo: "app", number, round: 1, patch: "p", test_patch: "t", title: "t", summary: "s", head_task: 7, base_task: 8, retried: 0, session: null, state: "building", failure: null, created_at: T0 });
  await saveRound(db, round(1));
  await saveRound(db, round(2));
  await addJob(db, "security-fix", "queued", { repo: "app", number: 2 });
  await addJob(db, "security-fix", "done", { repo: "app", number: 4 });
  const rows = await loadFixesToAdvance(db);
  assert.deepEqual(rows.map((r) => [r.number, r.by, r.tasks, r.envWaitAt]), [[1, "ann", { head: 7, base: 8 }, null], [3, null, null, T0], [4, null, null, T0]]);
  await setFindingEnvWait(db, "app#3", null);
  assert.equal((await loadFindings(db, ["app#3"])).get("app#3")!.env_wait_at, null);
});

test("the page loaders issue the same statements for any number of calls, rounds and findings", async () => {
  await expectFlat(async (n) => {
    const t = await testDatabase("", "sqlite");
    const db = await t.open({ app: true });
    const scan = await addScan(db, { repo: "app", cap_usd: null, started_by: "u" });
    await addFindings(db, "app", Array.from({ length: n }, (_, i) => finding(i + 1, { scan_id: scan })));
    await addCalls(db, Array.from({ length: n }, (_, i) => ({ scanId: scan, kind: "verify", finding: 1 + (i % n), ok: true })));
    for (let i = 0; i < n; i++) await saveRound(db, { repo: "app", number: 1, round: i + 1, patch: "p", test_patch: "t", title: "t", summary: "s", head_task: 1, base_task: 2, retried: 0, session: null, state: "failed", failure: null, created_at: T0 });
    return { db, close: () => t.close(), run: async () => {
      await loadFindingDetail(db, "app#1");
      await loadScanDetail(db, scan);
      await loadFindingBoard(db, { repos: ["app"] });
      await loadScanRun(db, scan);
      await loadQuiet(db, Array.from({ length: n }, (_, i) => `app#${i + 1}`));
      await loadFindings(db, Array.from({ length: n }, (_, i) => `app#${i + 1}`));
    } };
  }, 2, 30);
});

both("candidate, attention and listing loaders read what the pipeline and the pages expect", async (db) => {
  const scan = await addScan(db, { repo: "app", cap_usd: null, started_by: "u" });
  const v = (score: number) => JSON.stringify({ score });
  await addFindings(db, "app", [
    finding(1, { scan_id: scan, verification: v(9) }), finding(2, { scan_id: scan, verification: v(3) }), finding(3, { scan_id: scan, verification: v(9), severity: "critical", last_failure: "no" }),
    finding(4, { scan_id: scan, verification: v(9) }), finding(5, { scan_id: scan, state: "landing", fix_pr: 30 }), finding(6, { scan_id: scan, state: "fixing", env_wait_at: T0 }),
  ]);
  await addJob(db, "security-fix", "cancelled", { repo: "app", number: 1 });
  await addJob(db, "security-fix", "failed", { repo: "app", number: 4 });
  await saveScanTest(db, { repo: "app", number: 3, test_path: "t", crate: "c", test_patch: "p", test_source: "s", task_id: 1, retried: 0, state: "building", detail: null, created_at: T0, ended_at: null });
  assert.deepEqual(await loadFindingsToFix(db, { scanTests: false, minScore: 8 }), ["app#1", "app#3"]);
  assert.deepEqual(await loadFindingsToFix(db, { scanTests: true, minScore: 8, repo: "app" }), ["app#1"]);
  const att = await loadFindingAttention(db, { hide: Object.assign(["hidden"], {}) });
  assert.equal(att.openHighCount, 4);
  assert.equal(att.openHigh[0]!.repo, "app");
  assert.deepEqual(att.gaveUp.map((g) => g.number), [3]);
  assert.equal((await loadFindingAttention(db, { hide: Object.assign(["app"], {}) })).openHighCount, 0);
  assert.deepEqual(await countEnvWaits(db), { n: 1, oldest: T0 });
  assert.deepEqual([...(await loadFixPrFindings(db, ["app#30", "app#31"])).keys()], ["app#30"]);
  assert.equal((await loadFindingsForLinking(db)).length, 6);
  const o = await loadOverview(db, "app");
  assert.equal(o.scans[0]!.finding_count, 6);
  assert.equal(o.findings[0]!.severity, "critical");
  assert.equal((await listScans(db, { repos: ["app", "x"], limit: 5 })).length, 1);
  assert.equal((await listScans(db, { repos: ["x"], limit: 5 })).length, 0);
  assert.equal((await loadActiveScans(db, "all")).get("app")!.id, scan);
  assert.equal((await loadActiveScans(db, ["x"])).size, 0);
  assert.equal((await loadScanGuard(db, scan))!.state, "modeling");
});
