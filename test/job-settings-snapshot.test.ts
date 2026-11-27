// A job's settings snapshot serves repeated reads from one reading of the table, yet a step reads back what it wrote, however it wrote it.
import { AsyncResource } from "node:async_hooks";
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { featureOn } from "../src/build/features.ts";
import { config, setting, withConfig, withSettingsSnapshot } from "../src/data/control/index.ts";
import { world } from "./world-db.ts";

test("a watching snapshot shows the step's own raw writes", async () => {
  const { db } = await world();
  const put = (key: string, value: string) => db.run(db.k.insertInto("main.settings").values({ key, value }).onConflict((oc) => oc.column("key").doUpdateSet({ value })));
  await put("a", "1");
  await put("pipeline_enabled", "1");
  await withSettingsSnapshot(db, async () => {
    await put("a", "2"); // not through writeSetting
    assert.equal(await setting(db, "a"), "2");
    await db.run(db.k.deleteFrom("main.settings").where("key", "=", "a"));
    assert.equal(await setting(db, "a"), undefined);
  }, undefined, { live: ["pipeline_enabled"], watchWrites: true });
  // Without watching, a pass keeps the reading it started with.
  await withSettingsSnapshot(db, async () => {
    await put("a", "3");
    assert.equal(await setting(db, "a"), undefined);
  });
});

/** Runs `fn` as a job does, with a clock it can move. */
async function asJob(fn: (put: (value: string) => Promise<unknown>, later: () => void) => Promise<void>, db: Awaited<ReturnType<typeof world>>["db"]): Promise<void> {
  const put = (value: string) => db.run(db.k.insertInto("main.settings").values({ key: "build_feature:implement:app", value }).onConflict((oc) => oc.column("key").doUpdateSet({ value })));
  const real = Date.now;
  let ahead = 0;
  mock.method(Date, "now", () => real.call(Date) + ahead);
  try {
    await withSettingsSnapshot(db, () => fn(put, () => { ahead += 10_000; }), undefined, { watchWrites: true });
  } finally { mock.restoreAll(); }
}

test("a switch changed by another process reaches a running job", async () => {
  const { db } = await world();
  const outside = new AsyncResource("another process");
  await asJob(async (put, later) => {
    assert.equal(await featureOn(db, "implement", "app"), false);
    await put("on"); // a write of the job's own
    assert.equal(await featureOn(db, "implement", "app"), true);
    await outside.runInAsyncScope(() => put("off"));
    later();
    assert.equal(await featureOn(db, "implement", "app"), false);
    await outside.runInAsyncScope(() => put("on"));
    later();
    assert.equal(await withConfig(db, async () => config(db).repo("app").buildFeature("implement")), true, "a nested block starts with a current reading");
  }, db);
});

test("a transaction reads the settings once when they are due, sees its own write, and keeps its reading to itself", async () => {
  const { db } = await world();
  await asJob(async (put, later) => {
    const outside = new AsyncResource("another branch of the job");
    later();
    await db.write(async () => {
      const { stats } = await db.meter(async () => {
        for (let i = 0; i < 3; i++) assert.equal(await featureOn(db, "implement", "app"), false);
      });
      assert.equal(stats.statements, 1);
      await put("on");
      assert.equal(await featureOn(db, "implement", "app"), true);
      assert.equal(config(db).repo("app").buildFeature("implement"), true);
      assert.equal(outside.runInAsyncScope(() => config(db).repo("app").buildFeature("implement")), false, "not committed yet");
    });
    assert.equal(await featureOn(db, "implement", "app"), true);
  }, db);
});

test("a settings read in a transaction does not wait for one outside it", async () => {
  const { db } = await world();
  await asJob(async (_put, later) => {
    const reads = new AsyncResource("another branch of the job");
    later();
    let outside: Promise<unknown> | undefined;
    await db.write(async () => {
      // Outside the transaction's context it would queue behind the transaction's connection on SQLite.
      outside = reads.runInAsyncScope(() => featureOn(db, "implement", "app"));
      assert.equal(await featureOn(db, "implement", "app"), false);
    });
    assert.equal(await outside, false);
  }, db);
});
