import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { storeArtifact, tempPath } from "../src/build/artifacts.ts";
import { setFeature } from "../src/build/features.ts";
import { getTask } from "../src/build/tasks.ts";
import { CLIPPY_ARTIFACT, lintPlan, queueLintFor, readLint } from "../src/prepush/index.ts";
import { lintVerdict, testCrates } from "../src/prepush/tests.ts";
import type { CratesFetcher } from "../src/verify/crates.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb, type Db } from "./helpers/raw-db.ts";

process.env.AUTOCRAFT_DIFF_CACHE = join(SCRATCH, "diffs");
const HEAD = "a".repeat(40);
const PATCH = "diff --git a/crates/a/src/lib.rs b/crates/a/src/lib.rs\n--- a/crates/a/src/lib.rs\n+++ b/crates/a/src/lib.rs\n@@ -1,1 +1,2 @@\n fn a() {}\n+fn b() {}\n";
const job = (repo: string) => ({ step: "fixup", repo, number: 1, head: HEAD, base: HEAD, patch: PATCH });
const crates: CratesFetcher = async () => ({ ok: true, rust: true, crates: [{ name: "a", dir: "crates/a" }, { name: "root", dir: "." }] });
const db = async () => await connectDb(join(mkdtempSync(join(SCRATCH, "db-")), "t.db"));

/** A finished lint task with the given artifacts (clippy output clean unless named). */
async function finished(d: Db, repo: string, files: Record<string, string>, o: { state?: string; timedOut?: boolean } = {}): Promise<number> {
  const id = (await d.get(d.k.selectFrom("build_tasks").select("id").where("repo", "=", repo).orderBy("id", "desc").limit(1)))!.id;
  const results = [{ step: "fetch deps", exitCode: 0, durationMs: 1, timedOut: false }, { step: "format", exitCode: 0, durationMs: 1, timedOut: false }, { step: "clippy", exitCode: 0, durationMs: 1, timedOut: false },
    { step: "tests", exitCode: o.timedOut ? null : 0, durationMs: 1, timedOut: !!o.timedOut }];
  await d.run(d.k.updateTable("build_tasks").set({ state: o.state ?? "done", results: JSON.stringify(results) }).where("id", "=", id));
  for (const [name, text] of Object.entries({ [CLIPPY_ARTIFACT]: '{"reason":"build-finished","success":true}\n', ...files })) {
    const tmp = tempPath(id);
    writeFileSync(tmp, text);
    await storeArtifact(d, id, name, tmp);
  }
  return id;
}

describe("push tests", () => {
  test("off: today's plan and no crate lookup; on: a tests step for the affected crate", async () => {
    const d = await db();
    const never: CratesFetcher = async () => { throw new Error("must not be called"); };
    const off = await queueLintFor(d, job("app"), never);
    assert.deepEqual((await getTask(d, off!))!.plan, lintPlan(["crates/a/src/lib.rs"]));
    assert.deepEqual((await getTask(d, off!))!.plan.map((s) => s.name), ["fetch deps", "format", "clippy"]);
    await setFeature(d, "push-tests", true, "op", "app");
    const on = (await getTask(d, (await queueLintFor(d, job("app"), crates))!))!.plan;
    assert.equal(on.at(-1)!.name, "tests");
    assert.ok(on.at(-1)!.cmd.slice(4).join(" ") === "a");
  });

  test("a failing test that fails again on the rerun is a finding; a flake and a timeout are notes", async () => {
    const d = await db();
    await setFeature(d, "push-tests", true, "op", "app");
    const failing = "test t::x ... FAILED\n\nfailures:\n\n---- t::x stdout ----\nthread 't::x' panicked at src/lib.rs:3:\nboom\n\nfailures:\n    t::x\n";
    await queueLintFor(d, job("app"), crates);
    const bad = await readLint(d, await finished(d, "app", { "tests.txt": failing, "tests.exit": "101", "tests-rerun.txt": failing, "tests-rerun.exit": "101" }));
    assert.equal(bad.kind, "result");
    if (bad.kind === "result") {
      assert.deepEqual(bad.findings.map((f) => [f.code, f.message]), [["test", "test t::x failed"]]);
      assert.match(bad.findings[0]!.rendered, /boom/);
    }
    await queueLintFor(d, job("app"), crates);
    const flaky = await readLint(d, await finished(d, "app", { "tests.txt": failing, "tests.exit": "101", "tests-rerun.txt": "test result: ok\n", "tests-rerun.exit": "0" }));
    assert.ok(flaky.kind === "result" && flaky.findings.length === 0 && /flaky/.test(flaky.testsNote ?? ""));
    await queueLintFor(d, job("app"), crates);
    const slow = await readLint(d, await finished(d, "app", {}, { state: "failed", timedOut: true }));
    assert.ok(slow.kind === "result" && slow.findings.length === 0 && slow.testsNote === "tests timed out");
  });

  test("crates: longest prefix, over six or root-only files means none; test findings are asked once, then the push goes ahead", () => {
    const cs = [{ name: "a", dir: "crates/a" }, { name: "root", dir: "." }];
    assert.deepEqual(testCrates(["crates/a/src/lib.rs", "src/main.rs"], cs), ["a", "root"]);
    assert.equal(testCrates(["Cargo.lock"], cs), null);
    const seven = Array.from({ length: 7 }, (_, n) => ({ name: `c${n}`, dir: `x${n}` }));
    assert.equal(testCrates(seven.map((c) => `${c.dir}/lib.rs`), seven), null);
    const t = { level: "error" as const, code: "test", message: "test t::x failed", file: "", line: 0, rendered: "boom" };
    const c = { ...t, code: "clippy::x", message: "m" };
    assert.equal(lintVerdict([t], 1).action, "ask");
    assert.equal(lintVerdict([t], 2).action, "push");
    assert.equal(lintVerdict([c, t], 2).action, "fail");
    assert.equal(lintVerdict([c], 1).action, "ask");
  });
});
