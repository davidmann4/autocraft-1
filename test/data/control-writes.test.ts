// The writers of M05 that record an audit row (tracked repos, pipeline flags, settings): the change and its audit row commit
// together, and roll back together. Runs on SQLite, and on Postgres when AUTOCRAFT_TEST_PG_URL is set.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../../src/db/index.ts";
import { addTrackedRepo, listAudit, loadTrackedRepos, saveSettings, setPipelineFlags, listSettings } from "../../src/data/control/index.ts";
import { TEST_PG_URL, testDatabase } from "../test-db.ts";

async function each(fn: (db: Db) => Promise<void>): Promise<void> {
  for (const d of TEST_PG_URL ? (["sqlite", "postgres"] as const) : (["sqlite"] as const)) {
    const t = await testDatabase("", d);
    try { await fn(await t.open({ app: true })); } finally { await t.close(); }
  }
}

const actions = async (db: Db): Promise<string[]> => (await listAudit(db, { actions: ["repo-track", "repo-pipeline", "settings-save"] })).map((r) => r.action);

test("a write and its audit row land together, and a failed outer transaction keeps neither", () => each(async (db) => {
  const boom = new Error("rolled back");
  const failing = async (work: () => Promise<unknown>): Promise<void> => {
    await assert.rejects(db.write(async () => { await work(); throw boom; }), boom);
  };
  await failing(() => addTrackedRepo(db, { name: "app", by: "op" }));
  assert.ok(!(await loadTrackedRepos(db)).has("app"));
  assert.deepEqual(await actions(db), []);

  await addTrackedRepo(db, { name: "app", by: "op" });
  assert.ok((await loadTrackedRepos(db)).has("app"));
  assert.deepEqual(await actions(db), ["repo-track"]);

  await failing(() => setPipelineFlags(db, [{ repo: "app", on: true }], "op"));
  assert.equal((await loadTrackedRepos(db)).get("app")?.pipeline, false);
  assert.deepEqual(await actions(db), ["repo-track"]);
  await setPipelineFlags(db, [{ repo: "app", on: true }], "op");
  assert.equal((await loadTrackedRepos(db)).get("app")?.pipeline, true);
  assert.deepEqual(await actions(db), ["repo-track", "repo-pipeline"]);

  const save = () => saveSettings(db, [{ key: "single_merge_max", value: "7" }], "op");
  await failing(save);
  assert.ok(!(await listSettings(db)).some((r) => r.key === "single_merge_max"));
  assert.deepEqual(await actions(db), ["repo-track", "repo-pipeline"]);
  await save();
  assert.ok((await listSettings(db)).some((r) => r.key === "single_merge_max"));
  assert.deepEqual(await actions(db), ["repo-track", "repo-pipeline", "settings-save"]);
}));
