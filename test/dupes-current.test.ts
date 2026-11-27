import { test } from "node:test";
import assert from "node:assert/strict";
import { currentComparison, groupPlans, kindSets, waitingGroups } from "../src/dupes/plan.ts";
import { loadDupeGroups, loadDupeState, saveComparisons, saveDupeGroups, type ComparisonPut } from "../src/data/triage/index.ts";
import { fillEmbedHashes } from "../src/itemhash.ts";
import { T0, world } from "./world-db.ts";
import type { Db } from "./helpers/raw-db.ts";

/**
 * A confirmed duplicate pair of PRs 1 and 2 at their current text, so the two form a group in the stored state. An edit outside
 * sync clears an item's hash; the pair is re-stamped at the new text, as a scan and check would, so the group stays.
 */
async function pair(db: Db): Promise<void> {
  await fillEmbedHashes(db);
  const hash = async (n: number) => (await db.get(db.k.selectFrom("items").select("embed_hash").where("repo", "=", "app").where("number", "=", n)))!.embed_hash!;
  const row = { repo: "app", a: 1, b: 2, a_hash: await hash(1), b_hash: await hash(2) };
  const had = await db.get(db.k.selectFrom("duplicate_pairs").select("repo").where("repo", "=", "app"));
  if (had) await db.run(db.k.updateTable("duplicate_pairs").set({ a_hash: row.a_hash, b_hash: row.b_hash }).where("repo", "=", "app"));
  else await db.run(db.k.insertInto("duplicate_pairs").values({ ...row, similarity: 0.9, verdict: "duplicate", by_operator: 0, created_at: T0 }));
}

test("a duplicate comparison survives head pushes and small diff changes, and is redone for a state change or a diff that moved over 20%", async () => {
  const w = await (await (await (await world()).repo()).pr(1, { lines: 100 })).pr(2, { lines: 100 });
  const group = { repo: "app", members: [1, 2], edges: [] };
  const state = async () => { await pair(w.db); return await loadDupeState(w.db); };
  const set = async () => kindSets(await state(), group)[0]!;
  const current = async () => currentComparison(await state(), await set());
  const s0 = await set();
  const cmp: ComparisonPut = { repo: "app", key: s0.key, kind: "pr", members: [1, 2], hash: s0.hash, kept: 1, source: "model", model: "m", reason: null, result: null, error: null, attempts: 0, at: T0, summary: null, why: null, sizes: { 1: 100, 2: 100 }, heads: null };
  await saveComparisons(w.db, [cmp]);
  assert.ok(await current());
  await w.db.run(w.db.k.updateTable("items").set({ head_oid: "newhead", title: "edited", body: "edited", additions: 115 }).where("repo", "=", "app").where("number", "=", 2));
  assert.ok(await current(), "a push with a 15% size change keeps the result");
  await w.db.run(w.db.k.updateTable("items").set({ additions: 130 }).where("repo", "=", "app").where("number", "=", 2));
  assert.equal(await current(), null, "a 30% size change makes it stale");
  await w.db.run(w.db.k.updateTable("items").set({ additions: 100 }).where("repo", "=", "app").where("number", "=", 2));
  assert.ok(await current());
  await w.db.run(w.db.k.updateTable("items").set({ state: "MERGED" }).where("repo", "=", "app").where("number", "=", 2));
  assert.equal(await current(), null, "a state change makes it stale");
  await w.db.run(w.db.k.updateTable("items").set({ state: "OPEN" }).where("repo", "=", "app").where("number", "=", 2));
  await w.db.run(w.db.k.updateTable("items").set({ closing_issues: "[34]" }).where("repo", "=", "app").where("number", "=", 2));
  assert.equal(await current(), null, "a changed closing-issue link makes it stale");
});

test("the stored sizes are those of the compared snapshot, and a size unknown then makes the result stale once known", async () => {
  const w = await (await (await (await world()).repo()).pr(1, { lines: 100 })).pr(2, { lines: 100 });
  await w.db.run(w.db.k.updateTable("items").set({ additions: null }).where("repo", "=", "app").where("number", "=", 2));
  const group = { repo: "app", members: [1, 2], edges: [] };
  const state = async () => { await pair(w.db); return await loadDupeState(w.db); };
  const set = async () => kindSets(await state(), group)[0]!;
  const current = async () => currentComparison(await state(), await set());
  const snap = await set();
  const sizes = Object.fromEntries(snap.members.flatMap((m) => (m.additions === null || m.deletions === null ? [] : [[m.number, m.additions + m.deletions]])));
  await w.db.run(w.db.k.updateTable("items").set({ additions: 500 }).where("repo", "=", "app").where("number", "=", 1));
  await saveComparisons(w.db, [{ repo: "app", key: snap.key, kind: "pr", members: [1, 2], hash: snap.hash, kept: 1, source: "model", model: "m", reason: null, result: null, error: null, attempts: 0, at: T0, summary: null, why: null, sizes, heads: null }]);
  assert.equal(await current(), null, "PR 1 grew after the snapshot");
  await w.db.run(w.db.k.updateTable("items").set({ additions: 100 }).where("repo", "=", "app").where("number", "=", 1));
  assert.ok(await current());
  await w.db.run(w.db.k.updateTable("items").set({ additions: 100 }).where("repo", "=", "app").where("number", "=", 2));
  assert.equal(await current(), null, "PR 2's size became known");
});

test("a stored group stays while its comparison is redone, and goes when its edge is gone", async () => {
  const w = await (await (await (await world()).repo()).pr(1, { lines: 100 })).pr(2, { lines: 100 });
  const load = async () => { await pair(w.db); return await loadDupeState(w.db); };
  const s0 = kindSets(await load(), { repo: "app", members: [1, 2], edges: [] })[0]!;
  await saveComparisons(w.db, [{ repo: "app", key: s0.key, kind: "pr", members: [1, 2], hash: s0.hash, kept: 1, source: "model", model: "m", reason: null, result: null, error: null, attempts: 0, at: T0, summary: null, why: null, sizes: { 1: 100, 2: 100 }, heads: null }]);
  const plans = groupPlans(await load());
  assert.equal(plans.length, 1);
  await saveDupeGroups(w.db, "app", plans);
  const stored = await loadDupeGroups(w.db);
  assert.deepEqual(stored, plans);
  assert.deepEqual(waitingGroups(await load(), stored), [], "a current group is planned, not kept");
  await w.db.run(w.db.k.updateTable("items").set({ additions: 200 }).where("repo", "=", "app").where("number", "=", 2));
  assert.deepEqual(groupPlans(await load()), []);
  assert.deepEqual(waitingGroups(await load(), stored), stored);
  await w.db.run(w.db.k.updateTable("duplicate_pairs").set({ verdict: "distinct" }).where("repo", "=", "app"));
  assert.deepEqual(waitingGroups(await load(), stored), [], "no edge joins them any more");
});
