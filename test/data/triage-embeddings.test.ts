// triage module, part b: item embeddings (SQLite; Postgres when AUTOCRAFT_TEST_PG_URL is set).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db, Dialect } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import { TEST_PG_URL, testDatabase } from "../test-db.ts";
import { expectFlat } from "../helpers/query-count.ts";
import { embeddingIndexMark, hasEmbedDiff, listEmbedDiff, loadEmbeddingHashes, loadEmbeddingVectors, pruneEmbeddings, saveEmbeddings, streamEmbeddings } from "../../src/data/triage/index.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const M = "m1";

async function withDb(dialect: Dialect, fn: (db: Db) => Promise<unknown>): Promise<unknown> {
  const t = await testDatabase("", dialect);
  try { return await fn(await t.open({ app: true })); } finally { await t.close(); }
}

/** Runs on SQLite, and on Postgres when a server is configured. */
function both(name: string, fn: (db: Db) => Promise<unknown>): void {
  test(name, async () => {
    const lite = await withDb("sqlite", fn);
    if (TEST_PG_URL) assert.deepEqual(await withDb("postgres", fn), lite);
  });
}

const refs = (n: number) => Array.from({ length: n }, (_, i) => ({ repo: "app", number: i + 1 }));
const put = (number: number, hash = `h${number}`, model = M, repo = "app") => ({ repo, number, model, hash, vec: new Uint8Array([number, 1, 2, 3]) });

/** Tracked repo `app` with items 1..n: odd numbers open, even closed, each hashed `h<number>`. */
async function seed(db: Db, n: number): Promise<void> {
  const q = queryDb(db), k = q.k as any;
  await q.run(k.insertInto("tracked_repos").values({ name: "app", added_by: "t", added_at: T0 }));
  if (n) await q.run(k.insertInto("items").values(refs(n).map((r) => ({ ...r, kind: "issue", state: r.number % 2 ? "OPEN" : "CLOSED", title: "t", body: "b", embed_hash: `h${r.number}` }))));
}

both("the diff lists closed items with a missing or stale vector; saving replaces and a replaced row streams last", async (db) => {
  await seed(db, 4);
  assert.deepEqual((await listEmbedDiff(db, M, false)).map((r) => r.number).sort(), [2, 4]);
  assert.deepEqual((await listEmbedDiff(db, M, true)).map((r) => r.number).sort(), [1, 2, 3, 4]);
  assert.equal(await hasEmbedDiff(db, M), true);

  await saveEmbeddings(db, [put(1), put(2), put(4)]);
  assert.deepEqual((await listEmbedDiff(db, M, false)).map((r) => r.number).sort(), []);
  assert.equal(await hasEmbedDiff(db, M), false);
  assert.deepEqual((await listEmbedDiff(db, "m2", false)).map((r) => r.number).sort(), [2, 4], "a vector of another model does not count");
  await queryDb(db).run((queryDb(db).k as any).updateTable("items").set({ embed_hash: "new" }).where("number", "=", 4));
  assert.deepEqual((await listEmbedDiff(db, M, false)).map((r) => r.number).sort(), [4], "a vector at another hash is stale");

  const first = await streamEmbeddings(db, M, 0, 10);
  assert.deepEqual(first.map((r) => r.number), [1, 2, 4]);
  await saveEmbeddings(db, [put(1, "h1")]);
  const again = await streamEmbeddings(db, M, 0, 10);
  assert.deepEqual(again.map((r) => r.number), [2, 4, 1], "a rewritten row gets a rowid above the others");
  assert.deepEqual((await streamEmbeddings(db, M, again[0]!.rid, 1)).map((r) => r.number), [4]);
  assert.deepEqual([...(await loadEmbeddingHashes(db, refs(4), M))], [["app#1", "h1"], ["app#2", "h2"], ["app#4", "h4"]].sort());
  const v = await loadEmbeddingVectors(db, refs(4), M);
  assert.deepEqual([...v.get("app#2")!.vec], [2, 1, 2, 3]);
  assert.equal((await loadEmbeddingVectors(db, refs(4), "m2")).size, 0);

  const mark = await embeddingIndexMark(db);
  assert.equal(mark.rows, 3);
  assert.ok(mark.tracked.split(",").includes("app"));
  assert.ok(mark.maxRowid! >= again[2]!.rid);
});

both("pruning removes vectors of untracked repos and of items that left the mirror", async (db) => {
  await seed(db, 2);
  await saveEmbeddings(db, [put(1), put(2), put(3), put(1, "h1", M, "other")]);
  assert.equal(await pruneEmbeddings(db), 2);
  assert.deepEqual((await streamEmbeddings(db, M, 0, 10)).map((r) => `${r.repo}#${r.number}`), ["app#1", "app#2"]);
});

test("embedding loaders and the batch write issue the same number of statements at 2 and 12 items", async () => {
  const unit = (run: (db: Db, n: number) => Promise<unknown>) => async (size: number) => {
    const t = await testDatabase("", "sqlite");
    const db = await t.open({ app: true });
    await seed(db, size);
    await saveEmbeddings(db, refs(size).map((r) => put(r.number)));
    return { db, run: () => run(db, size), close: () => t.close() };
  };
  await expectFlat(unit((db, n) => loadEmbeddingHashes(db, refs(n), M)), 2, 12);
  await expectFlat(unit((db, n) => loadEmbeddingVectors(db, refs(n))), 2, 12);
  await expectFlat(unit((db, n) => saveEmbeddings(db, refs(n).map((r) => put(r.number)))), 2, 12);
  await expectFlat(unit((db) => listEmbedDiff(db, M, true)), 2, 12);
});
