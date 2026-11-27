// The duplicate scan reads a chunk of items, their neighbours and the stored pairs in a few waves and writes the pairs and scans once.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { resetScansForCutoff } from "../src/data/triage/index.ts";
import { scanChunk } from "../src/dupes/scan.ts";
import type { VectorIndex } from "../src/embed/vectors.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { SCRATCH } from "./scratch.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const NOW = new Date("2026-06-01T00:00:00.000Z");

/** An index whose neighbours are given by number, best first. */
const index = (near: Record<number, [number, number][]>): VectorIndex => ({
  vectorOf: async () => new Float32Array(1),
  nearest: async (_db: unknown, _v: unknown, _limit: number, skip: string) => (near[Number(skip.split("#")[1])] ?? []).map(([number, score]) => ({ repo: "app", number, score })),
}) as unknown as VectorIndex;

async function fresh(name: string) {
  mkdirSync(SCRATCH, { recursive: true });
  const db = await connectDb(join(SCRATCH, `dupes-scan-${name}-${process.pid}.db`));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: T0, pipeline: 1 }));
  const item = (number: number, o: Record<string, unknown> = {}) => ({ repo: "app", number, kind: "issue", state: "OPEN", title: `t${number}`, body: "b", created_at: T0, updated_at: T0, labels: "[]", embed_hash: `h${number}`, ...o });
  await db.run(db.k.insertInto("items").values([
    item(1), item(2), item(3), item(4), item(5),
    item(6, { state: "CLOSED", closed_at: "2024-01-01T00:00:00.000Z" }),
    item(7, { kind: "pr" }),
  ]));
  return db;
}

const pairsOf = async (db: Awaited<ReturnType<typeof fresh>>) => (await db.all(db.k.selectFrom("duplicate_pairs").select(["a", "b", "similarity"]).orderBy("a").orderBy("b"))).map((r) => [r.a, r.b]);

test("a scan pairs the nearest comparable neighbours up to the cap, skips pairs an operator ruled on, and marks the items scanned", async () => {
  const db = await fresh("pairs");
  await db.run(db.k.insertInto("duplicate_pairs").values({ repo: "app", a: 1, b: 3, a_hash: "old", b_hash: "old", similarity: 0.8, created_at: T0, by_operator: 1, verdict: "distinct" }));
  const near = { 1: [[2, 0.95], [3, 0.9], [6, 0.9], [7, 0.88], [4, 0.8], [5, 0.74]] as [number, number][] };
  const added = await scanChunk(db, index(near), [{ repo: "app", number: 1 }, { repo: "app", number: 2 }], NOW);
  // 6 left the comparison window, 7 is another kind; the cap of 3 counts 2, 3 and 4, and the ruled pair 1-3 is not added again.
  assert.deepEqual(await pairsOf(db), [[1, 2], [1, 3], [1, 4]]);
  assert.equal(added, 2);
  assert.deepEqual((await db.all(db.k.selectFrom("duplicate_scans").select(["number", "hash"]).orderBy("number"))), [{ number: 1, hash: "h1" }, { number: 2, hash: "h2" }]);
  // Scanning again adds nothing: the pairs are stored.
  assert.equal(await scanChunk(db, index(near), [{ repo: "app", number: 1 }], NOW), 0);
});

test("an item without a text hash is not scanned", async () => {
  const db = await fresh("nohash");
  await db.run(db.k.updateTable("items").set({ embed_hash: null }).where("number", "=", 1));
  assert.equal(await scanChunk(db, index({ 1: [[2, 0.95]] }), [{ repo: "app", number: 1 }], NOW), 0);
  assert.equal((await db.all(db.k.selectFrom("duplicate_scans").select("number"))).length, 0);
});

test("a new scan cut-off clears the scan marks once and keeps the stored pairs", async () => {
  const db = await fresh("cutoff");
  await db.run(db.k.insertInto("duplicate_scans").values({ repo: "app", number: 1, hash: "h1", at: T0 }));
  await db.run(db.k.insertInto("duplicate_pairs").values({ repo: "app", a: 1, b: 2, a_hash: "h1", b_hash: "h2", similarity: 0.9, created_at: T0 }));
  assert.equal(await resetScansForCutoff(db, 0.5), true);
  assert.equal((await db.all(db.k.selectFrom("duplicate_scans").select("number"))).length, 0);
  await db.run(db.k.insertInto("duplicate_scans").values({ repo: "app", number: 1, hash: "h1", at: T0 }));
  assert.equal(await resetScansForCutoff(db, 0.5), false, "the same cut-off does not clear again");
  assert.equal((await db.all(db.k.selectFrom("duplicate_scans").select("number"))).length, 1);
  assert.equal((await db.all(db.k.selectFrom("duplicate_pairs").select("a"))).length, 1);
});
