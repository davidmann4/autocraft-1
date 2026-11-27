import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BUILD_FEATURES, featureOn, featureRepos, featureStates, setFeature, shownFeatures } from "../src/build/features.ts";
import { createEnv, hello } from "../src/build/envs.ts";
import { FEATURES_REPO_ONLY_DONE, featuresRepoOnlySqlite } from "../src/db/feature-repo-only.ts";
import { connect } from "../src/db.ts";
import { INPUT_TOPICS, planDue } from "../src/runner/autopilot.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb, dbFor } from "./helpers/raw-db.ts";
import { rowid } from "../src/db/kx.ts";

mkdirSync(SCRATCH, { recursive: true });
const fresh = async () => await connectDb(join(mkdtempSync(join(SCRATCH, "bf-")), "t.db"));

test("every feature is off until switched on", async () => {
  const db = await fresh();
  for (const f of BUILD_FEATURES) assert.equal(await featureOn(db, f, "app"), false);
  assert.ok((await featureStates(db)).every((s) => !s.on && s.repos.length === 0));
});

test("a repo switch stays on only where the global switch was on, and featureOn reads only the repo switch", async () => {
  const sync = connect(":memory:");
  sync.prepare("DELETE FROM main.settings WHERE key = ?").run(FEATURES_REPO_ONLY_DONE); // opening the database ran it on no rows
  const put = sync.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?)");
  for (const [k, v] of [["build_feature:screenshots", "on"], ["build_feature:screenshots:app", "on"], ["build_feature:implement", "off"],
    ["build_feature:implement:app", "on"], ["build_feature:nightly:app", "on"], ["build_feature:scan-tests", "on"]]) put.run(k, v);
  featuresRepoOnlySqlite(sync);
  featuresRepoOnlySqlite(sync); // a second run changes nothing
  const db = await dbFor(sync);
  assert.deepEqual(await featureRepos(db, "screenshots"), ["app"]);
  assert.deepEqual(await featureRepos(db, "implement"), [], "global off");
  assert.deepEqual(await featureRepos(db, "nightly"), [], "no global row");
  assert.equal(await featureOn(db, "scan-tests"), true, "scan-tests keeps its instance-wide switch");
  assert.equal((await db.all(db.k.selectFrom("settings").select("key").where("key", "in", ["build_feature:screenshots", "build_feature:implement"]))).length, 0);
  await setFeature(db, "implement", true, "op", "app");
  assert.equal(await featureOn(db, "implement", "app"), true, "the repo switch alone turns it on");
  const row = (await db.get(db.k.selectFrom("audit").select(["login", "target", "details"]).where("action", "=", "build-feature").orderBy(rowid("audit")).limit(1)))!;
  assert.deepEqual([row.login, row.target, JSON.parse(row.details ?? "null")], ["op", "implement", { feature: "implement", on: true, repo: "app" }]);
  assert.equal(await featureOn(db, "implement", "other"), false);
  assert.equal(await featureOn(db, "implement"), false, "no repo, no answer");
  await assert.rejects(setFeature(db, "implement", true, "op"), /per repo/);
});

test("Screenshots and Nightly checks show only while an enabled environment can run them", async () => {
  const db = await fresh();
  assert.deepEqual(await shownFeatures(db), ["push-tests", "batch-build", "implement"]);
  await createEnv(db, { id: "box", label: "box", kind: "local-sandbox", slots: 1 }, "op");
  await hello(db, "box", { version: "1", slots: 1, capabilities: { os: "linux", arch: "x86_64", cpus: 4, memGb: 8, diskGb: 50, display: true, gpu: false, toolchains: ["rust-stable", "rust-nightly"] } });
  assert.deepEqual(await shownFeatures(db), ["screenshots", "push-tests", "batch-build", "nightly", "implement"]);
});

test("a switch change is planned at once but is no new input to a lane whose job handled nothing", async () => {
  const db = await fresh();
  assert.ok(!INPUT_TOPICS.includes("build-features" as never));
  const before = await db.seqs();
  await setFeature(db, "nightly", true, "op", "app");
  const after = await db.seqs();
  assert.equal(after["build-features"], (before["build-features"] ?? 0) + 1);
  assert.equal(after.settings, before.settings);
  await planDue(db);
  assert.equal(await planDue(db), false);
  await setFeature(db, "pr-builds", true, "op", "app");
  assert.equal(await planDue(db), true);
});

test("the Implement switch is planner input", async () => {
  const db = await fresh();
  const before = await db.seqs();
  await setFeature(db, "implement", true, "op", "app");
  const after = await db.seqs();
  const woke = INPUT_TOPICS.filter((t) => after[t] !== before[t]);
  assert.ok(woke.length > 0, "no planner input topic moved");
  assert.equal(after.settings, before.settings, "the settings topic keeps its own trigger");
});

test("a maintainer with write access to a repo switches its shown features, not another repo's or a hidden one, and a viewer cannot", async () => {
  const { postFeature } = await import("../src/dash/api/build.ts");
  const db = await fresh();
  await db.run(db.k.insertInto("tracked_repos").values([{ name: "x" }, { name: "y" }]).onConflict((oc) => oc.doNothing()));
  const as = (role: string, writes: string[], json: unknown) => ({ params: {}, query: new URLSearchParams(), json, user: { login: "u", role, canWrite: async (r: string) => writes.includes(r), canRead: async () => true } }) as never;
  await postFeature(db, as("maintainer", ["x"], { feature: "implement", on: true, repo: "x" }));
  assert.equal((await featureStates(db)).find((s) => s.feature === "implement")!.repos.includes("x"), true);
  await assert.rejects(postFeature(db, as("maintainer", ["x"], { feature: "implement", on: true, repo: "y" })), /write access/);
  await postFeature(db, as("maintainer", ["x"], { feature: "push-tests", on: true, repo: "x" }));
  assert.equal(await featureOn(db, "push-tests", "x"), true);
  await assert.rejects(postFeature(db, as("operator", [], { feature: "implement", on: true })), /repo is required/);
  await assert.rejects(postFeature(db, as("maintainer", ["x"], { feature: "nightly", on: true, repo: "x" })), /operator/);
  await assert.rejects(postFeature(db, as("viewer", ["x"], { feature: "implement", on: true, repo: "x" })), /write access/);
});

test("a write-maintainer approves issue implementations for their repo only", async () => {
  const { fixIssueApproval } = await import("../src/dash/api/admin.ts");
  const db = await fresh();
  await db.run(db.k.insertInto("tracked_repos").values([{ name: "x" }, { name: "y" }]).onConflict((oc) => oc.doNothing()));
  const as = (role: string, name: string) => ({ params: {}, query: new URLSearchParams(), json: { name }, user: { login: "u", role, canWrite: async (r: string) => r === "x", canRead: async () => true } }) as never;
  assert.equal((await fixIssueApproval(db, as("maintainer", "x"), true)).fixing?.approved, true);
  await assert.rejects(fixIssueApproval(db, as("maintainer", "y"), true), /write access/);
  await assert.rejects(fixIssueApproval(db, as("viewer", "x"), false), /write access/);
});
