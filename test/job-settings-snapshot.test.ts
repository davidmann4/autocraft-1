// A job's settings snapshot serves repeated reads from one reading of the table, yet a step reads back what it wrote, however it wrote it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setting, withSettingsSnapshot } from "../src/settings-read.ts";
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
