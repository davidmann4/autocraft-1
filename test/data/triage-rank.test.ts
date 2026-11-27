// Triage priority and rank writers: the upsert keeps the reach score a row already has, and the rank upsert and delete are set-based.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db, Dialect } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import { TEST_PG_URL } from "../test-db.ts";
import { expectFlat } from "../helpers/query-count.ts";
import { loadDuplicateCounts, loadPriorities, loadRankScores, loadRanks, savePriorities, saveRanks } from "../../src/data/triage/index.ts";
import type { PriorityRow, RankBreakdown, RankPut } from "../../src/data/triage/index.ts";
import { AT, both, openApp } from "./planner-helpers.ts";

const prio = (number: number, o: Partial<PriorityRow> = {}): PriorityRow => ({
  repo: "o/a", number, impact: "P2", textHash: "h", jevImpact: "P2", jevP: 0.9, haikuImpact: null, score: 0, model: "jev", reason: "P2 0.90", at: AT, ...o,
});
const breakdown = (level: RankBreakdown["level"]): RankBreakdown => ({ level, rated: level, security: false, type: "bugfix", size: "M", sizeSource: "default", reach: 0 });
const put = (number: number, score: number): RankPut => ({ repo: "o/a", number, score, breakdown: breakdown("P2"), computedAt: AT });
const refs = (n: number) => Array.from({ length: n }, (_, i) => ({ repo: "o/a", number: i + 1 }));

both("savePriorities updates the rating of a row and leaves its reach score to rescoreReach", async ({ db }) => {
  const q = queryDb(db);
  assert.deepEqual([...await savePriorities(db, [prio(1), prio(2)])], ["o/a#1", "o/a#2"]);
  await q.run(q.k.updateTable("main.item_priority").set({ score: 50 }).where("number", "=", 1));
  await savePriorities(db, [prio(1, { impact: "P0", textHash: "h2", model: "haiku", reason: "r", at: "2026-02-01T00:00:00.000Z" })]);
  const rows = await loadPriorities(db, refs(3));
  assert.equal(rows.size, 2);
  assert.deepEqual([rows.get("o/a#1")!.impact, rows.get("o/a#1")!.textHash, rows.get("o/a#1")!.score, rows.get("o/a#1")!.model], ["P0", "h2", 50, "haiku"]);
  assert.equal(rows.get("o/a#2")!.score, 0);
});

both("loadDuplicateCounts counts confirmed duplicates per canonical item", async ({ db }) => {
  const q = queryDb(db);
  const pair = (a: number, b: number, verdict: string, canonical: number | null) => ({ repo: "o/a", a, b, a_hash: "x", b_hash: "y", similarity: 0.9, verdict, canonical, created_at: AT });
  await q.run(q.k.insertInto("main.duplicate_pairs").values([pair(1, 2, "duplicate", 1), pair(1, 3, "duplicate", 1), pair(4, 5, "distinct", null), pair(6, 7, "duplicate", 7)]));
  assert.deepEqual([...(await loadDuplicateCounts(db))].sort(), [["o/a#1", 2], ["o/a#7", 1]]);
});

both("saveRanks upserts changed rows and deletes the others in one write", async ({ db }) => {
  assert.deepEqual(await saveRanks(db, [put(1, 20_000), put(2, 10_000)], []), { changed: 2, removed: 0 });
  assert.deepEqual(await saveRanks(db, [put(1, 30_000), put(3, 5)], [{ repo: "o/a", number: 2 }]), { changed: 2, removed: 1 });
  const ranks = await loadRanks(db, refs(3));
  assert.deepEqual([...ranks].map(([k, r]) => [k, r.score]), [["o/a#1", 30_000], ["o/a#3", 5]]);
  assert.equal(ranks.get("o/a#1")!.breakdown.level, "P2");
  assert.deepEqual([...await loadRankScores(db, { repos: ["o/a"] })].sort(), [["o/a#1", 30_000], ["o/a#3", 5]]);
  assert.deepEqual([...await loadRankScores(db, [{ repo: "o/a", number: 3 }])], [["o/a#3", 5]]);
  assert.equal((await loadRankScores(db, { repos: [] })).size, 0);
});

for (const dialect of ["sqlite", ...(TEST_PG_URL ? ["postgres"] : [])] as Dialect[]) {
  test(`priority and rank loaders and writers issue the same statements for any number of items (${dialect})`, async () => {
    const unit = (run: (db: Db, n: number) => Promise<unknown>) => async (n: number) => {
      const { t, db } = await openApp(dialect);
      await saveRanks(db, refs(n).map((r) => put(r.number, 1)), []);
      await savePriorities(db, refs(n).map((r) => prio(r.number)));
      return { db, run: () => run(db, n), close: () => t.close() };
    };
    await expectFlat(unit(async (db, n) => { await loadRanks(db, refs(n)); await loadRankScores(db, refs(n)); await loadPriorities(db, refs(n)); }), 3, 40);
    await expectFlat(unit(async (db, n) => { await saveRanks(db, refs(n).map((r) => put(r.number, 2)), refs(n).map((r) => ({ repo: "o/z", number: r.number }))); }), 3, 40);
    await expectFlat(unit(async (db, n) => { await savePriorities(db, refs(n).map((r) => prio(r.number, { impact: "P1" }))); }), 3, 40);
  });
}
