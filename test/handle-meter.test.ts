import { test } from "node:test";
import assert from "node:assert/strict";
import type { Kysely } from "kysely";
import { effect, effectsInTx, note } from "../src/db/effects.ts";
import { queryDb } from "../src/db/query-db.ts";
import { expectFlat } from "./helpers/query-count.ts";
import { testDatabase } from "./test-db.ts";

type T = { t: { id: number; v: string | null } };

const SCHEMA = "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)";

test("a meter counts its own context's statements, rows and effects; an inner meter adds to it; an effect inside a transaction or a wave throws in tests and is counted in production", async () => {
  const tdb = await testDatabase(SCHEMA);
  try {
    const db = queryDb(await tdb.open());
    const k = db.k as unknown as Kysely<T>;
    await db.run(k.insertInto("t").values([{ id: 1, v: "a" }, { id: 2, v: "b" }]));
    const reported = effectsInTx().count;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // Work outside the meter, running alongside it, is not counted.
    const outside = gate.then(() => db.all(k.selectFrom("t").selectAll()));
    const { value: inner, stats } = await db.meter(async () => {
      release();
      const rows = await db.all(k.selectFrom("t").selectAll());
      const inner = await db.meter(async () => {
        await db.prepare("SELECT 1 AS x").get();
        effect("http", "test outside a transaction");
      });
      await db.write(async () => {
        await db.run(k.updateTable("t").set({ v: "c" }).where("id", "=", 1));
        assert.throws(() => effect("github-write", "test inside a transaction"), /inside a database transaction \(test inside a transaction\)/);
      });
      return { rows: rows.length, stats: inner.stats };
    });
    await outside;
    await db.together(async () => assert.throws(() => effect("model-call"), /inside a db\.together wave/));
    note("github-write", "a database transaction", "test in production", false);
    assert.ok(stats.statements > inner.stats.statements, "the outer meter counts the inner one's statements and its own");
    assert.equal(stats.effects, inner.stats.effects + 1);
    assert.ok(stats.rows >= inner.rows + inner.stats.rows);
    assert.equal(effectsInTx().count, reported + 1);
    assert.ok(effectsInTx().sites.some((s) => s.site === "test in production" && s.kind === "github-write"));
  } finally {
    await tdb.close();
  }
});

test("expectFlat fails a unit that reads per item and passes a set-based one, allowing statements per effect", async () => {
  const unit = (style: "per-item" | "set" | "set with writes") => async (size: number) => {
    const tdb = await testDatabase(SCHEMA);
    const db = queryDb(await tdb.open());
    const k = db.k as unknown as Kysely<T>;
    const ids = Array.from({ length: size }, (_, i) => i + 1);
    await db.run(k.insertInto("t").values(ids.map((id) => ({ id, v: "a" }))));
    const run = async () => {
      if (style === "per-item") return await Promise.all(ids.map((id) => db.get(k.selectFrom("t").selectAll().where("id", "=", id))));
      const rows = await db.all(k.selectFrom("t").selectAll().where("id", "in", ids));
      if (style === "set with writes") for (const r of rows) {
        effect("github-write", "test");
        await db.run(k.updateTable("t").set({ v: "b" }).where("id", "=", r.id));
      }
      return rows;
    };
    return { db, run, close: () => tdb.close() };
  };
  await assert.rejects(expectFlat(unit("per-item"), 2, 8), /statements grow with size/);
  await expectFlat(unit("set"), 2, 8);
  await expectFlat(unit("set with writes"), 2, 8);
});
