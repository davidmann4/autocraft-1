// User-local mode: a job that serves every repo is proposed only for items it can work now. Items whose model call no Task
// Runner takes would leave it handling nothing, and the planner would queue it again on every change of its input.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setJevEnabled } from "../src/agents/jev.ts";
import { setRunner } from "../src/classify/run.ts";
import { runPrioritize } from "../src/priority/index.ts";
import { plannedItems } from "../src/core/select-items.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { excluded } from "../src/db/kx.ts";
import { fillEmbedHashes } from "../src/itemhash.ts";
import { parseStatus, storeStatus } from "../src/remote/helpers.ts";
import { setUserRepos } from "../src/remote/my-repos.ts";
import { noRunnerFor } from "../src/runner/concurrency.ts";
import { detectAutopilot, LANES } from "../src/runner/autopilot.ts";
import { OPERATOR, T0, world } from "./world-db.ts";

test("prioritize waits for a Task Runner or Jev while its items need one", async () => {
  const w = await (await (await world()).repo()).issue(1);
  await fillEmbedHashes(w.db);
  await setJevEnabled(w.db, false, "test");
  assert.equal((await plannedItems(w.db, "prioritize")).length, 1, "the item has no priority");
  const lanes = LANES.filter((l) => l.name === "priority");
  const proposed = async () => (await detectAutopilot(w.db, { lanes })).proposals.map((p) => p.step);

  const idle = await detectAutopilot(w.db, { lanes });
  assert.deepEqual(idle.proposals, [], "no Task Runner and no Jev: a job would rate nothing");
  assert.equal(idle.status?.prioritize, noRunnerFor("app"), "the stage names the wait");
  await setJevEnabled(w.db, true, "test");
  await w.db.run(w.db.k.insertInto("settings").values({ key: "jev_unavailable", value: JSON.stringify({ kind: "account", reason: "out of credit", since: new Date().toISOString(), at: new Date().toISOString() }) })
    .onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
  assert.deepEqual(await proposed(), [], "Jev's account failed a moment ago");

  const token = (await createToken(w.db, OPERATOR, "helper", { kind: "runner" })).row.id;
  await storeStatus(w.db, token, OPERATOR, parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }));
  await setUserRepos(w.db, OPERATOR, ["app"]);
  assert.deepEqual(await proposed(), ["prioritize"], "a Task Runner takes the repo");
});

test("an item Jev was unsure of, with no Task Runner for Haiku, queues no prioritize job until its text changes or a runner comes", async () => {
  const w = await (await (await world()).repo()).issue(1);
  await fillEmbedHashes(w.db);
  await setJevEnabled(w.db, true, "test");
  const lanes = LANES.filter((l) => l.name === "priority");
  const proposed = async () => (await detectAutopilot(w.db, { lanes })).proposals.map((p) => p.step);
  let asked = 0;
  const restore = setRunner(async () => {
    asked++;
    return { code: 0, stderr: "", stdout: JSON.stringify({ answers: { impact: { choice: "P2", probabilities: { P2: 0.5, P3: 0.4 } } }, usage: { input_tokens: 9, output_tokens: 1 } }) };
  });
  try {
    assert.deepEqual(await proposed(), ["prioritize"], "Jev may be asked");
    const r = await runPrioritize(w.db, { limit: 10 });
    assert.deepEqual([r.due, r.saved, asked], [1, 0, 1], "Jev is unsure and nobody takes Haiku's call");
    assert.deepEqual(await proposed(), []);
    assert.equal((await detectAutopilot(w.db, { lanes })).status?.prioritize, noRunnerFor("app"), "the stage names the wait");
    await w.db.run(w.db.k.updateTable("items").set({ body: "It also loses the file.", embed_hash: null }).where("number", "=", 1));
    await fillEmbedHashes(w.db);
    assert.deepEqual(await proposed(), ["prioritize"], "new text: Jev is asked again");
    await runPrioritize(w.db, { limit: 10 });
    assert.deepEqual([await proposed(), asked], [[], 2]);
    const token = (await createToken(w.db, OPERATOR, "helper", { kind: "runner" })).row.id;
    await storeStatus(w.db, token, OPERATOR, parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }));
    await setUserRepos(w.db, OPERATOR, ["app"]);
    assert.deepEqual(await proposed(), ["prioritize"], "a Task Runner takes the repo");
  } finally { restore(); }
});

test("dupes-compare runs without a Task Runner only for a set settled by rule", async () => {
  const w = await (await (await (await world()).repo()).issue(1, { title: "crash on open" })).issue(2, { title: "crashes when opening" });
  await fillEmbedHashes(w.db);
  const hash = async (n: number) => (await w.db.get(w.db.k.selectFrom("items").select("embed_hash").where("repo", "=", "app").where("number", "=", n)))!.embed_hash!;
  await w.db.run(w.db.k.insertInto("duplicate_pairs").values({ repo: "app", a: 1, b: 2, a_hash: await hash(1), b_hash: await hash(2), similarity: 0.9, created_at: T0, verdict: "duplicate" }));
  const lanes = LANES.filter((l) => l.name === "dupes-compare");
  const proposed = async () => (await detectAutopilot(w.db, { lanes })).proposals.map((p) => p.step);

  assert.equal((await plannedItems(w.db, "dupes-compare")).length, 2, "both open members wait for the comparison");
  assert.deepEqual(await proposed(), [], "two open members need a model call no Task Runner takes");
  await w.db.run(w.db.k.updateTable("items").set({ state: "CLOSED" }).where("repo", "=", "app").where("number", "=", 2));
  assert.deepEqual(await proposed(), ["dupes-compare"], "a closed member wins by rule, without a model");
});
