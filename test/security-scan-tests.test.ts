// Scan tests (feature scan-tests): off by default and then invisible; on, a confirmed finding gets a build task for a test the
// model wrote, and the task's outcome marks the finding without deleting it or changing its severity.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { scopeToTracked } from "../src/repos.ts";
import { setFeature } from "../src/build/features.ts";
import { getTask } from "../src/build/tasks.ts";
import { autoFixConfirmed } from "../src/security/actions.ts";
import { runScan, type Ask, type ScanDeps } from "../src/security/scan.ts";
import { advanceScanTests, NOT_SHOWN_NOTE } from "../src/security/scantest.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { cols, excluded, jsonNum } from "../src/db/kx.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "scan-tests-"));
const tree = join(dir, "tree");
mkdirSync(join(tree, "crates/psd/src"), { recursive: true });
writeFileSync(join(tree, "crates/psd/src/layer.rs"), Array.from({ length: 200 }, (_, i) => `// line ${i + 1}`).join("\n"));
const db = await connectDb(join(dir, "dash.db"));
// A confidential build environment that has reported: private fixes and their builds can run.
await db.run(db.k.insertInto("build_envs").values({ id: "vault", label: "vault", kind: "remote", slots: 1, key_hash: "x", confidential: 1, confidential_since: "2020-01-01T00:00:00Z", confidential_online_at: "2020-01-01T00:00:00Z", created_at: "2020-01-01T00:00:00Z" }));
after(async () => { await db.close(); rmSync(dir, { recursive: true, force: true }); });

for (const r of ["plain", "wired", "on"]) await db.run(db.k.insertInto("repos").values({ name: r, visibility: "public", default_branch: "main", open_prs: 0, open_issues: 0 }));
await db.run(db.k.insertInto("main.tracked_repos").values(["plain", "wired", "on"].map((name) => ({ name, added_by: "cli", added_at: "x" }))).onConflict((oc) => oc.doNothing()));
await scopeToTracked(db);

const SHA = "a".repeat(40);
const LINES = [40, 80, 120, 160];
const TEST_FILE = "#[test]\nfn rejects_long_length() {\n    assert!(psd::read(&[255; 8]).is_err());\n}\n";

type Spy = { ids: string[]; tests: number; crates: number };
function deps(spy: Spy, withTests: boolean): ScanDeps {
  const ask = (async (id: string) => {
    spy.ids.push(id);
    if (id === "security.model") return { cost: 1, text: JSON.stringify({ summary: "x", entry_points: [], areas: [{ name: "PSD reader", paths: ["crates/psd/src"], entry_points: [], risk: 5, why: "parses files" }] }) };
    if (id === "security.area") return { cost: 1, text: JSON.stringify({ findings: LINES.map((line) => ({ title: `Finding at ${line}`, severity: "high", urgent: false, confidence: 0.9, category: `cat_${line}`, refs: [{ path: "crates/psd/src/layer.rs", line, claim: "shows it" }], reach: "open file", impact: "bad" })) }) };
    return { cost: 0.5, text: JSON.stringify({ verdict: "confirmed", score: 9, result: "Followed the path.", notes: "", proposed_test: "read a record with a long length" }) };
  }) as Ask;
  const base: ScanDeps = { ask, checkout: async () => ({ dir: tree, sha: SHA }), cancelled: async () => false, log: () => {}, confirmed: undefined };
  if (!withTests) return base;
  return {
    ...base,
    writeTest: async () => { spy.tests++; return { text: TEST_FILE, cost: 0.4 }; },
    crates: async () => { spy.crates++; return { ok: true, rust: true, crates: [{ name: "psd", dir: "crates/psd" }] }; },
  };
}
const newScan = async (repo: string): Promise<number> => (await db.get(db.k.insertInto("security_scans").values({ repo, state: "modeling", cap_usd: null, started_by: "boss", started_at: new Date().toISOString() }).returning("id")))!.id;
const findings = async (repo: string) => await db.all(db.k.selectFrom("security_findings").select(["number", "title", "severity", "state", "verification"]).where("repo", "=", repo).orderBy("number"));
const testRow = async (repo: string, n: number) => await db.get(db.k.selectFrom("security_scan_tests").select(cols("security_scan_tests")).where("repo", "=", repo).where("number", "=", n));
const result = (step: string, exitCode: number | null, timedOut = false) => ({ step, exitCode, durationMs: 1, timedOut });

describe("scan tests", () => {
  test("with the switch off nothing is written, queued or asked, and the findings are the same as without the code", async () => {
    const plain: Spy = { ids: [], tests: 0, crates: 0 }, wired: Spy = { ids: [], tests: 0, crates: 0 };
    await runScan(db, await newScan("plain"), deps(plain, false));
    await runScan(db, await newScan("wired"), deps(wired, true));
    assert.deepEqual([wired.tests, wired.crates], [0, 0]);
    assert.ok(!wired.ids.includes("security.scantest"));
    assert.equal((await db.get(db.k.selectFrom("build_tasks").select((eb) => eb.fn.countAll<number>().as("n"))))!.n, 0);
    assert.equal((await db.get(db.k.selectFrom("security_scan_tests").select((eb) => eb.fn.countAll<number>().as("n"))))!.n, 0);
    assert.equal((await db.get(db.k.selectFrom("security_calls").select((eb) => eb.fn.countAll<number>().as("n")).where("kind", "=", "test")))!.n, 0);
    assert.deepEqual(wired.ids, plain.ids);
    const strip = (rows: Awaited<ReturnType<typeof findings>>) => rows.map(({ number: _n, ...r }) => r);
    assert.deepEqual(strip(await findings("wired")), strip(await findings("plain")));
    assert.deepEqual(await advanceScanTests(db), []);
    assert.equal(await autoFixConfirmed(db, "wired"), 4, "every confirmed finding starts its fix as before");
    await db.run(db.k.deleteFrom("jobs"));
  });

  test("with the switch on, the test is queued before the fix and its outcome marks the finding", async () => {
    await setFeature(db, "scan-tests", true, "boss");
    const spy: Spy = { ids: [], tests: 0, crates: 0 };
    const id = await newScan("on");
    await runScan(db, id, { ...deps(spy, true), confirmed: (n) => autoFixConfirmed(db, "on", n) });
    assert.equal(spy.tests, 4);
    const rows = await findings("on");
    assert.deepEqual(rows.map((r) => r.state), ["new", "new", "new", "new"], "no automatic fix starts while a test is building");
    assert.equal((await db.get(db.k.selectFrom("jobs").select((eb) => eb.fn.countAll<number>().as("n")).where("step", "=", "security-fix")))!.n, 0);
    const tasks = await db.all(db.k.selectFrom("build_tasks").select(["step", "patch", "head_sha", "priority", "number"]).orderBy("id"));
    assert.equal(tasks.length, 4);
    for (const t of tasks) {
      assert.equal(t.step, "scan-test");
      assert.equal(t.head_sha, SHA);
      assert.equal(t.priority, -5);
      assert.equal(t.number, null);
      assert.match(t.patch!, /^diff --git a\/crates\/psd\/tests\/autocraft_regression_[0-9a-f]{10}\.rs /);
    }
    const kinds = (await db.all(db.k.selectFrom("security_calls").select("kind").where("scan_id", "=", id).where("finding_number", "=", rows[0]!.number).orderBy("id"))).map((c) => c.kind);
    assert.deepEqual(kinds, ["verify", "test"]);
    const [a, b, c, d] = rows.map((r) => r.number) as [number, number, number, number];
    const plan = async (n: number) => (await getTask(db, (await testRow("on", n))!.task_id))!.plan.map((s) => s.name);
    assert.deepEqual(await plan(a), ["fetch deps", "build", "test"]);

    assert.deepEqual(await advanceScanTests(db), [], "tasks still queued");
    const end = async (n: number, state: string, results: unknown[]) => await db.run(db.k.updateTable("build_tasks").set({ state, results: JSON.stringify(results) }).where("id", "=", (await testRow("on", n))!.task_id));
    await end(a, "failed", [result("fetch deps", 0), result("build", 0), result("test", 101)]);
    await end(b, "done", [result("fetch deps", 0), result("build", 0), result("test", 0)]);
    await end(c, "failed", [result("fetch deps", 0), result("build", 101)]);
    await end(d, "lost", []);
    const ended = await advanceScanTests(db);
    assert.deepEqual(ended.map((e) => e.state), ["confirmed", "not-shown", "could-not-build"]);
    assert.equal((await testRow("on", a))!.state, "confirmed");
    assert.equal((await testRow("on", b))!.state, "not-shown");
    assert.equal((await testRow("on", c))!.state, "could-not-build");
    // An environment error queues the task once more; a second one ends it.
    const again = (await testRow("on", d))!;
    assert.equal(again.state, "building");
    assert.equal(again.retried, 1);
    await end(d, "lost", []);
    assert.deepEqual((await advanceScanTests(db)).map((e) => e.state), ["could-not-build"]);

    // Findings are kept as they were; only the passing test leaves a note.
    const after = await findings("on");
    assert.deepEqual(after.map((r) => [r.state, r.severity]), [["new", "high"], ["new", "high"], ["new", "high"], ["new", "high"]]);
    assert.equal((await db.get(db.k.selectFrom("security_findings").select("note").where("repo", "=", "on").where("number", "=", b)))!.note, NOT_SHOWN_NOTE);
    // The automatic fix skips the finding whose test passed and starts the others.
    assert.equal(await autoFixConfirmed(db, "on"), 3);
    const started = (await db.all(db.k.selectFrom("jobs").select(jsonNum(db, "params", "$.number").as("n")).where("step", "=", "security-fix").orderBy("n"))).map((r) => r.n);
    assert.deepEqual(started, [a, c, d]);
  });

  test("a test that builds for over four hours is cancelled and read as could-not-build", async () => {
    const n = (await findings("on"))[0]!.number;
    await db.run(db.k.insertInto("security_scan_tests")
      .values({ repo: "stuck", number: n, test_path: "p", crate: "psd", test_patch: "x", test_source: "x", task_id: (await testRow("on", n))!.task_id, state: "building", created_at: new Date(Date.now() - 5 * 3_600_000).toISOString() })
      .onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet((eb) => ({ ...excluded(["test_path", "crate", "test_patch", "test_source", "task_id", "state", "created_at"])(eb), retried: 0, detail: null, ended_at: null }))));
    await db.run(db.k.updateTable("build_tasks").set({ state: "queued", results: "[]" }).where("id", "=", (await testRow("on", n))!.task_id));
    assert.deepEqual(await advanceScanTests(db), [{ repo: "stuck", number: n, state: "could-not-build" }]);
    assert.equal((await getTask(db, (await testRow("on", n))!.task_id))!.state, "cancelled");
  });
});
