// The duplicate-stage queries over real rows: merged PRs that fix an issue, unchecked pair counts, held and counted duplicates, and re-marking stored comparisons.
import assert from "node:assert/strict";
import { test } from "node:test";
import { canonInfoAll } from "../src/dupes/canonical.ts";
import { compareAgain } from "../src/dupes/compare.ts";
import { askGroupDecisions, groupPlans } from "../src/dupes/decide.ts";
import { duplicateGroups, kindSetsOf, saveComparison, type StoredComparison } from "../src/dupes/plan.ts";
import { addFastTrack, setFastTrackBypass } from "../src/fasttrack.ts";
import { uncheckedPairCounts, uncheckedPairs } from "../src/dupes/check.ts";
import { duplicateCount, duplicateHeld, backlogHeld } from "../src/dupes/held.ts";
import { fillEmbedHashes } from "../src/itemhash.ts";
import { T0, world } from "./world-db.ts";

test("canonical info, unchecked pairs, duplicate holds and comparison re-marking read the stored rows", async () => {
  const w = await (await (await (await world()).repo()).issue(1, { title: "crash on open" })).issue(2, { title: "crashes when opening" });
  const db = w.db;
  await db.run(db.k.insertInto("items").values({ repo: "app", number: 10, kind: "pr", state: "MERGED", closing_issues: "[2]", created_at: T0, updated_at: T0 }));
  await db.run(db.k.insertInto("items").values({ repo: "app", number: 11, kind: "pr", state: "MERGED", closing_issues: "garbage", created_at: T0, updated_at: T0 }));
  const m = await canonInfoAll(db, [{ repo: "app", number: 1 }, { repo: "app", number: 2 }, { repo: "app", number: 99 }]);
  assert.deepEqual([...m.keys()].sort(), ["app#1", "app#2"]);
  assert.equal(m.get("app#2")!.fixedByMerged, true);
  assert.equal(m.get("app#1")!.fixedByMerged, false);
  assert.equal(m.get("app#1")!.comments, 0);
  await fillEmbedHashes(db);
  const hash = async (n: number) => (await db.get(db.k.selectFrom("items").select("embed_hash").where("repo", "=", "app").where("number", "=", n)))!.embed_hash!;
  await db.run(db.k.insertInto("duplicate_pairs").values({ repo: "app", a: 1, b: 2, a_hash: await hash(1), b_hash: await hash(2), similarity: 0.9, created_at: T0 }));
  assert.equal((await uncheckedPairs(db, -1)).length, 1);
  assert.equal((await uncheckedPairs(db, 0)).length, 0);
  assert.deepEqual([...await uncheckedPairCounts(db)].sort(), [["app#1", 1], ["app#2", 1]]);
  assert.deepEqual([...await uncheckedPairCounts(db, { refs: ["app#1"] })], [["app#1", 1]]);
  assert.deepEqual([...await uncheckedPairCounts(db, { refs: ["app#3"] })], []);
  await db.run(db.k.insertInto("decisions").values({ id: "d1", kind: "duplicate", repo: "app", number: 2, question: "q", options: "[]", asked_at: T0, facts: JSON.stringify(["duplicate of app#1"]) }));
  assert.equal(await duplicateCount(db, "app", 1), 1);
  assert.equal(await duplicateHeld(db, "app", 2), true);
  assert.equal(await duplicateHeld(db, "app", 1), false);
  assert.equal(await backlogHeld(db, "app", 1), false);
  await db.run(db.k.insertInto("dupe_comparisons").values([
    { repo: "app", key: "k1", kind: "issue", members: "[1,2]", hash: "h", kept: 1, source: "rule", at: T0 },
    { repo: "app", key: "k2", kind: "issue", members: "[3,4]", hash: "h", kept: 3, source: "rule", at: T0 },
    { repo: "app", key: "k3", kind: "issue", members: "[1,5]", hash: "again:h", kept: 1, source: "rule", at: T0 }]));
  assert.equal(await compareAgain(db, "t", "app", 1), 1);
  assert.deepEqual((await db.all(db.k.selectFrom("dupe_comparisons").select(["key", "hash"]).orderBy("key"))), [{ key: "k1", hash: "again:h" }, { key: "k2", hash: "h" }, { key: "k3", hash: "again:h" }]);
});

test("an item queued with bypass checks is never the one to close in a duplicate group: both stay open and nothing is asked", async () => {
  const w = await (await (await (await world()).repo()).issue(1, { title: "crash on open" })).issue(2, { title: "crashes when opening" });
  const db = w.db;
  await fillEmbedHashes(db);
  const hash = async (n: number) => (await db.get(db.k.selectFrom("items").select("embed_hash").where("repo", "=", "app").where("number", "=", n)))!.embed_hash!;
  await db.run(db.k.insertInto("duplicate_pairs").values({ repo: "app", a: 1, b: 2, a_hash: await hash(1), b_hash: await hash(2), similarity: 0.9, verdict: "duplicate", created_at: T0 }));
  const [g] = await duplicateGroups(db, "app");
  const [set] = await kindSetsOf(db, g!);
  await saveComparison(db, { repo: "app", key: set!.key, kind: "issue", members: [1, 2], hash: set!.hash, kept: 2, source: "model", model: "sonnet", reason: "2 is fuller", result: null, error: null, attempts: 1, at: T0 } as StoredComparison);
  const roles = async () => (await groupPlans(db, "app")).flatMap((p) => p.items.map((i) => `${i.number}:${i.role}`)).sort();
  assert.deepEqual(await roles(), ["1:close", "2:keep"]);
  await addFastTrack(db, "op", "app#1");
  assert.deepEqual(await roles(), ["1:close", "2:keep"], "fast-tracked without bypass checks: the usual rule");
  await setFastTrackBypass(db, "op", "app#1");
  assert.deepEqual(await roles(), ["1:stay", "2:keep"]);
  assert.deepEqual(await askGroupDecisions(db, "app", T0), []);
});
