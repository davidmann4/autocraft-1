// Batches by area: a new batch takes the top-ranked PR, then the other ready PRs of its area, then the rest in rank
// order, so a ready PR is never left out for an area match. GitHub and git are faked (test/world-db.ts).
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { editAreas, saveItemAreas } from "../src/data/triage/index.ts";
import { runBatches } from "../src/merge/batch.ts";
import { world, type World } from "./world-db.ts";

let current: World | null = null;
afterEach(() => current?.close());

async function members(areas: (string | null)[], limit?: number): Promise<number[]> {
  current?.close();
  const w = (current = await (await world()).repo());
  await editAreas(w.db, "app", { op: "replace", areas: [{ name: "render", description: "Drawing" }, { name: "text", description: "Type" }] }, null);
  for (const [i, area] of areas.entries()) {
    const n = i + 1;
    await (await (await (await w.pr(n)).review(n)).verified(n)).premerge(n, "clean");
    await saveItemAreas(w.db, "app", 1, [{ repo: "app", number: n, area, source: "operator", confidence: null }]);
  }
  await runBatches(w.db, { repo: "app", ...(limit === undefined ? {} : { limit }) }, () => {}, w.gh.batchDeps());
  const rows = await w.db.all(w.db.k.selectFrom("merge_batch_prs").select("number").orderBy("batch_id").orderBy("position"));
  return rows.map((r) => r.number);
}

test("a batch with room for some takes the top PR's area first; one with room for all takes every ready PR", async () => {
  const areas = ["render", "text", "render", null];
  const some = await members(areas, 2);
  assert.deepEqual(some, [1, 3]);
  const all = await members(areas);
  assert.deepEqual([...all].sort(), [1, 2, 3, 4]);
  assert.ok(all.indexOf(3) < all.indexOf(2), "the top PR's area comes before the rank-order fill");
  // A top PR with no area matches nothing: the batch fills in rank order.
  assert.deepEqual(await members([null, "render", "text", "render"], 2), [1, 2]);
});
