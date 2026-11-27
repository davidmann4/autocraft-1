// Screenshots, collect side: the switch gates every step, and only a clear regression on an unchanged head keeps it from merging.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { storeArtifact, tempPath } from "../src/build/artifacts.ts";
import { setFeature } from "../src/build/features.ts";
import { loadMergeFacts } from "../src/data/merge/index.ts";
import { createEnv, hello } from "../src/build/envs.ts";
import { claim, createTask, getTask } from "../src/build/tasks.ts";
import { parseCompareReply, parseScreenshotReply, type CompareParsed } from "../src/verify/plan.ts";
import { runCollect, collectDue, type CollectDeps } from "../src/verify/results.ts";
import { putConfig, type ScreenshotConfigBody } from "../src/verify/screenshot-config.ts";
import { runVerify, type VerifyDeps } from "../src/verify/index.ts";
import { acting } from "./acting.ts";
import { reportingTaskRunner } from "./fake-runner.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb, type Db } from "./helpers/raw-db.ts";
import { cols, excluded, like } from "../src/db/kx.ts";
import { insertWorkflow } from "../src/workflow/store.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "shots-collect-"));
process.env.AUTOCRAFT_ARTIFACT_DIR = join(dir, "artifacts");
const T0 = "2026-01-01T00:00:00Z";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const CFG: ScreenshotConfigBody = {
  package: "app-ui", example: "snapshot", driver: "args", ui_paths: ["crates/ui*/**"],
  commands: { snap: { doc: "Render the main window.", params: { size: { enum: ["1440x900"] } }, argv: ["--out", "{out}", "--size", "{size}"], capture: true } },
};
const UI_DIFF = "diff --git a/crates/ui/src/dialog.rs b/crates/ui/src/dialog.rs\n--- a/crates/ui/src/dialog.rs\n+++ b/crates/ui/src/dialog.rs\n@@ -1,1 +1,2 @@\n fn a() {}\n+fn b() {}\n";
/** A PNG header (signature, IHDR of w x h) followed by `tag`, enough for the size and dimension checks. */
const png = (tag: string, w = 10, h = 10): Buffer => {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); ihdr.write("IHDR", 4, "latin1"); ihdr.writeUInt32BE(w, 8); ihdr.writeUInt32BE(h, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.from(tag)]);
};

let planCalls = 0, compareCalls = 0;
async function fresh(): Promise<Db> {
  const db = await connectDb(join(mkdtempSync(join(dir, "db-")), "t.db"));
  process.env.AUTOCRAFT_DIFF_CACHE = mkdtempSync(join(dir, "diffs-"));
  planCalls = 0; compareCalls = 0;
  await db.run(db.k.insertInto("items").values({ repo: "app", number: 7, kind: "pr", state: "OPEN", title: "Show size", author: "someone", additions: 5, deletions: 0, head_oid: HEAD, created_at: T0, updated_at: T0 }));
  await db.run(db.k.insertInto("opus_reviews").values({ repo: "app", number: 7, head_oid: HEAD, run_id: "rv", at: T0, model: "m", verdict: "take", reason: "ok", fixes: "[]", sure: 1, mode: "full" }));
  await db.run(db.k.insertInto("pr_checks").values({ repo: "app", number: 7, head_oid: HEAD, state: "OPEN", is_draft: 0, overall: "success", checks: "[]", mergeable: "MERGEABLE", maintainer_can_modify: 1, fetched_at: T0 }));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: T0, pipeline: 1 }));
  await db.run(db.k.insertInto("repos").values({ name: "app", visibility: "public" }));
  await putConfig(db, "op", "app", CFG);
  await insertWorkflow(db, { repo: "app", number: 7, kind: "pr", entry: "review", state: "running", startedBy: "op", startedAt: T0, startedVia: "dashboard" });
  await acting(db, ["op"]);
  await reportingTaskRunner(db);
  return db;
}
const verifyDeps: VerifyDeps = {
  fetchDiff: async () => ({ ok: true, text: UI_DIFF }), fetchCrates: async () => ({ ok: true, rust: true, crates: [] }),
  baseOf: async () => BASE, mainHead: async () => null, model: "sonnet",
  screenshots: { plan: async () => { planCalls++; return parseScreenshotReply(JSON.stringify([{ ref: "app#7", screenshot: true, reason: "Dialog changes", steps: [{ cmd: "snap", args: { size: "1440x900" } }] }]), "app#7", CFG); } },
};
const tasks = async (db: Db, step?: string, state?: string): Promise<number> => (await db.all(db.k.selectFrom("build_tasks").select("id")
  .$if(!!step, (q) => q.where("step", "=", step!)).$if(!!state, (q) => q.where("state", "=", state!)))).length;
const count = async (db: Db, table: "screenshot_runs"): Promise<number> => (await db.all(db.k.selectFrom(table).select((eb) => eb.lit(1).as("one")))).length;
/** Heads of the PR that the planner reads a clear regression at. */
const regressions = async (db: Db): Promise<number> => (await loadMergeFacts(db, [{ repo: "app", number: 7 }])).regressions.size;
const runRow = async <C extends "state" | "reason" | "verdict" | "clear" | "held">(db: Db, ...columns: C[]) => await db.get(db.k.selectFrom("screenshot_runs").select(columns));
const switchOn = async (db: Db): Promise<void> => await setFeature(db, "screenshots", true, "op", "app");

/** Plans a run, then ends both tasks as a worker would: results for every step, one screenshot each. */
async function rendered(db: Db, shots: { head: string; base: string; headSize?: [number, number] }, o: { headFails?: boolean } = {}): Promise<{ head: number; base: number }> {
  await runVerify(db, { repo: "app" }, () => {}, verifyDeps);
  const row = (await db.get(db.k.selectFrom("screenshot_runs").select(["head_task_id", "base_task_id"])))!;
  const run = { h: row.head_task_id!, b: row.base_task_id! };
  for (const [id, tag, fails] of [[run.h, shots.head, o.headFails === true], [run.b, shots.base, false]] as const) {
    const t = (await getTask(db, id))!;
    const results = t.plan.map((s, i) => ({ step: s.name, exitCode: fails && i === t.plan.length - 1 ? 1 : 0, timedOut: false, durationMs: 1 }));
    if (!fails) { const tmp = tempPath(id); writeFileSync(tmp, png(tag, ...(id === run.h ? shots.headSize ?? [10, 10] : [10, 10]))); await storeArtifact(db, id, "s1.png", tmp); }
    await db.run(db.k.updateTable("build_tasks").set({ state: fails ? "failed" : "done", results: JSON.stringify(results), ended_at: T0 }).where("id", "=", id));
  }
  return { head: run.h, base: run.b };
}
const collect = (db: Db, verdict: CompareParsed | (() => Promise<void>)): Promise<unknown> => runCollect(db, {}, () => {}, {
  model: "haiku",
  screenshots: { compare: async (_i, { ref }) => { compareCalls++; if (typeof verdict === "function") { await verdict(); return parseCompareReply(JSON.stringify([{ ref, verdict: "regression", clear: true, summary: "Broken." }]), ref); } return verdict; } },
} satisfies CollectDeps);
const reply = (v: string, clear: boolean): CompareParsed => parseCompareReply(JSON.stringify([{ ref: "app#7", verdict: v, clear, summary: "Handles moved outside the outline." }]), "app#7");

describe("screenshots switch off (test A)", () => {
  test("nothing is queued, recorded, planned or compared; an in-flight run is cancelled and skipped", async () => {
    const db = await fresh();
    for (const on of [false, true]) {
      if (on) await setFeature(db, "screenshots", true, "op", "other");   // another repo's switch: this repo's own is still off
      await runVerify(db, { repo: "app" }, () => {}, verifyDeps);
      assert.deepEqual([await tasks(db), await count(db, "screenshot_runs"), planCalls], [0, 0, 0]);
      assert.deepEqual((await db.all(db.k.selectFrom("verifications").select(["kind", "state"]))).map((r) => ({ ...r })), [{ kind: "ci-enough", state: "ci-enough" }]);
      await db.run(db.k.deleteFrom("verifications"));
    }
    assert.equal(await collectDue(db), false);
    const s = await runCollect(db, {}, () => {}, { model: "haiku" });
    assert.equal(s.shots, 0);

    await switchOn(db);
    const t = await rendered(db, { head: "x", base: "y" });
    await db.run(db.k.updateTable("build_tasks").set({ state: "queued", ended_at: null }).where("id", "=", t.head));
    // Off by hand, so the collect-side guard is what ends the run (setFeature itself stops it at once).
    await db.run(db.k.updateTable("settings").set({ value: "off" }).where("key", "=", "build_feature:screenshots:app"));
    assert.equal(await collectDue(db), true);
    await collect(db, reply("regression", true));
    assert.equal(compareCalls, 0);
    assert.deepEqual({ ...await runRow(db, "state", "reason") }, { state: "skipped", reason: "screenshots switched off" });
    assert.equal((await getTask(db, t.head))!.state, "cancelled");
    assert.equal(await regressions(db), 0);
  });
});

describe("screenshots collect (test B)", () => {
  test("a clear regression is kept as a fact of the head and leaves the verification alone", async () => {
    const db = await fresh(); await switchOn(db);
    await rendered(db, { head: "broken", base: "fine" });
    const before = await db.all(db.k.selectFrom("verifications").select(cols("verifications")));
    await collect(db, reply("regression", true));
    assert.equal(compareCalls, 1);
    assert.deepEqual({ ...await runRow(db, "state", "verdict", "clear", "held") }, { state: "compared", verdict: "regression", clear: 1, held: 1 });
    assert.equal(await regressions(db), 1);
    assert.deepEqual((await db.all(db.k.selectFrom("stages").select("stage").where((eb) => eb.or([like(db, "stage", eb.val("%hold%")), like(db, "stage", eb.val("screenshot%"))])))).map((r) => r.stage), ["hold"]);
    assert.deepEqual(await db.all(db.k.selectFrom("verifications").select(cols("verifications"))), before);
  });

  test("no hold when the regression is not clear, the head task failed, or the head moved during the comparison; identical images make no model call", async () => {
    let db = await fresh(); await switchOn(db);
    await rendered(db, { head: "broken", base: "fine" });
    await collect(db, reply("regression", false));
    assert.equal(await regressions(db), 0);
    assert.equal((await runRow(db, "verdict"))!.verdict, "regression");

    db = await fresh(); await switchOn(db);
    await rendered(db, { head: "x", base: "fine" }, { headFails: true });
    await collect(db, reply("regression", true));
    assert.equal(compareCalls, 0);
    assert.equal((await runRow(db, "state"))!.state, "error");
    assert.equal(await regressions(db), 0);

    db = await fresh(); await switchOn(db);
    await rendered(db, { head: "broken", base: "fine" });
    await collect(db, async () => { await db.run(db.k.updateTable("items").set({ head_oid: "c".repeat(40) }).where("repo", "=", "app")); await db.run(db.k.updateTable("pr_checks").set({ head_oid: "c".repeat(40) }).where("repo", "=", "app")); });
    assert.deepEqual({ ...await runRow(db, "state", "held") }, { state: "compared", held: 0 });
    assert.equal(await regressions(db), 0);

    db = await fresh(); await switchOn(db);
    await rendered(db, { head: "same", base: "same" });
    await collect(db, reply("regression", true));
    assert.equal(compareCalls, 0);
    assert.equal((await runRow(db, "verdict"))!.verdict, "unchanged");
    assert.equal(await regressions(db), 0);
  });
});

describe("screenshots review fixes", () => {
  test("a screenshot task does not use up the verification's retry", async () => {
    const db = await fresh(); await switchOn(db);
    await rendered(db, { head: "a", base: "b" });
    assert.equal(await tasks(db, "screenshot"), 2);
    assert.equal(await tasks(db, "verify"), 0);
    const lost = await createTask(db, { step: "verify", repo: "app", number: 7, headSha: HEAD, baseSha: BASE, requires: { os: "linux", toolchains: ["rust-stable"] },
      plan: [{ name: "fetch deps", cmd: ["true"], network: "fetch", timeoutSec: 10 }], warm: { key: "app", role: "use" } });
    await db.run(db.k.updateTable("build_tasks").set({ state: "lost", ended_at: T0 }).where("id", "=", lost));
    await db.run(db.k.deleteFrom("verifications"));
    await db.run(db.k.insertInto("verifications").values({ repo: "app", number: 7, head_sha: HEAD, base_sha: BASE, kind: "tests", reason: "r", head_task_id: lost, state: "planned", created_at: T0 }));
    const s = await runCollect(db, {}, () => {}, { model: "haiku", screenshots: { compare: async () => null } });
    assert.equal(s.retried, 1);
  });

  test("an invalid image fails the run without a model call; a lost render task is queued again once", async () => {
    let db = await fresh(); await switchOn(db);
    await rendered(db, { head: "a", base: "b", headSize: [9000, 10] });
    await collect(db, reply("regression", true));
    assert.equal(compareCalls, 0);
    assert.deepEqual({ ...await runRow(db, "state", "reason") }, { state: "error", reason: "the render stored an invalid image" });

    db = await fresh(); await switchOn(db);
    const t = await rendered(db, { head: "a", base: "b" });
    await db.run(db.k.updateTable("build_tasks").set({ state: "lost", results: "[]" }).where("id", "=", t.head));
    await collect(db, reply("regression", true));
    assert.equal((await runRow(db, "state"))!.state, "planned");
    assert.equal(await tasks(db, "screenshot"), 4);
    await db.run(db.k.updateTable("build_tasks").set({ state: "lost", results: "[]" }).where("state", "=", "queued"));
    await collect(db, reply("regression", true));
    assert.equal((await runRow(db, "state"))!.state, "error");
    assert.equal(await regressions(db), 0);
  });

  test("switching the feature off cancels render tasks and skips open runs; the claim skips them while off", async () => {
    const db = await fresh(); await switchOn(db);
    await createEnv(db, { id: "env-one", label: "env-one", kind: "local-sandbox", slots: 4 }, "op");
    await hello(db, "env-one", { version: "1", capabilities: { os: "linux", arch: "x86_64", cpus: 8, memGb: 32, diskGb: 200, display: true, gpu: false, toolchains: ["rust-stable"] }, slots: 4 });
    await db.run(db.k.insertInto("settings").values({ key: "base_scope", value: "app" }).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
    await runVerify(db, { repo: "app" }, () => {}, verifyDeps);
    // Off by hand (not through setFeature): the claim alone must refuse the queued render tasks.
    await db.run(db.k.updateTable("settings").set({ value: "off" }).where("key", "=", "build_feature:screenshots:app"));
    assert.deepEqual((await claim(db, "env-one", 4)).tasks.filter((t) => t.repo === "app"), []);
    await setFeature(db, "screenshots", true, "op", "app");
    await setFeature(db, "screenshots", false, "op", "app");
    assert.equal(await tasks(db, "screenshot", "cancelled"), 2);
    assert.deepEqual({ ...await runRow(db, "state", "reason") }, { state: "skipped", reason: "screenshots switched off" });
  });
});
