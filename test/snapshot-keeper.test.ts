// The runner leader's snapshot keeper builds again when an embed job ends, since embed jobs leave the item snapshot's
// refresh to it; a job still running does not count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { keepSnapshot } from "../src/itemtools/keeper.ts";
import { SCRATCH } from "./scratch.ts";
import { testDatabase } from "./test-db.ts";

test("the snapshot keeper builds after an embed job ends, not while it runs", async () => {
  process.env.AUTOCRAFT_SNAPSHOT_DIR = mkdtempSync(join(SCRATCH, "keeper-"));
  const t = await testDatabase();
  const db = await t.open({ app: true });
  const ac = new AbortController();
  let builds = 0;
  const settle = async (n: number) => {
    for (let i = 0; i < 300 && builds < n; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 100));
  };
  try {
    keepSnapshot(db, ac.signal, () => {}, { everyMs: 10, build: async () => (builds++, "built") });
    await settle(1);
    assert.equal(builds, 1, "a build at start");
    const at = new Date().toISOString();
    await db.run(db.k.insertInto("main.jobs").values({ step: "embed", params: "{}", requested_by: "pipeline", requested_at: at, state: "running", started_at: at }));
    await settle(2);
    assert.equal(builds, 1, "no build while the embed job runs");
    await db.run(db.k.updateTable("main.jobs").set({ state: "done", ended_at: new Date().toISOString() }).where("step", "=", "embed"));
    await settle(2);
    assert.equal(builds, 2, "a build once it has ended");
  } finally {
    ac.abort();
    await t.close();
  }
});
