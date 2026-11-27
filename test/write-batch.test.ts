import assert from "node:assert/strict";
import { test } from "node:test";
import { WriteBatch } from "../src/agents/batch.ts";
import type { Db } from "../src/db/index.ts";

const db = (inTx = false): Db => ({ inTransaction: () => inTx }) as unknown as Db;

test("rows asked for side by side share a write, and those asked for during it the next", async () => {
  const writes: number[][] = [];
  let later: Promise<number>[] = [];
  const d = db();
  const batch: WriteBatch<number, number> = new WriteBatch(async (_db, rows) => {
    writes.push(rows);
    if (!later.length) later = [4, 5].map((n) => batch.add(d, n));
    return rows.map((r) => r * 10);
  });
  const first = await Promise.all([1, 2, 3].map((n) => batch.add(d, n)));
  assert.deepEqual([...first, ...await Promise.all(later)], [10, 20, 30, 40, 50]);
  assert.deepEqual(writes, [[1, 2, 3], [4, 5]]);
});

test("a row that cannot be written fails alone, and a batch that failed takes new rows", async () => {
  const batch = new WriteBatch<number, number>(async (_db, rows) => {
    if (rows.includes(2)) throw new Error("bad row");
    return rows;
  });
  const d = db();
  const got = await Promise.allSettled([1, 2, 3].map((n) => batch.add(d, n)));
  assert.deepEqual(got.map((r) => r.status), ["fulfilled", "rejected", "fulfilled"]);
  assert.equal(await batch.add(d, 4), 4);
});

test("inside a transaction a row is written at once, as part of it", async () => {
  const writes: number[][] = [];
  const batch = new WriteBatch<number, void>(async (_db, rows) => { writes.push(rows); return rows.map(() => undefined); });
  const added = [batch.add(db(true), 1), batch.add(db(true), 2)];
  assert.deepEqual(writes, [[1], [2]]);
  await Promise.all(added);
});
