import assert from "node:assert/strict";
import { applyLocal, closeGoneItems, fillItemHashes, loadChecks, loadItems, saveChecks, saveDiffFacts, saveItems } from "../../src/data/mirror/index.ts";
import type { ItemEntry } from "../../src/data/mirror/index.ts";
import type { Db } from "../helpers/raw-db.ts";
import { both, bothFlat, comment, entry, seedItems } from "./mirror-fixture.ts";

const item = async (db: Db, number: number, repo = "app") => (await loadItems(db, [{ repo, number }], "full")).get(`${repo}#${number}`)!;
const one = (repo: string, number: number) => [{ repo, number }];
const audits = async (db: Db) => await db.all(db.k.selectFrom("main.audit").select(["action", "target", "details"]).orderBy("target"));

both("applyLocal changes an item only while its guard holds and reports what matched", async (db) => {
  await seedItems(db, "app", [1, 2, 3], { head_oid: "h", mergeable: "UNKNOWN", labels: "[]" });
  await seedItems(db, "app", [4], { state: "CLOSED", closed_at: "old" });
  const r = await applyLocal(db, [
    { kind: "merged", repo: "app", number: 1, at: "t1" }, { kind: "merged", repo: "app", number: 4, at: "t1" },
    { kind: "state", repo: "app", number: 2, state: "CLOSED" }, { kind: "labels", repo: "app", number: 3, labels: ["bug", "p1"] },
  ]);
  assert.deepEqual(r.changed.sort(), ["app#1", "app#2", "app#3"]);
  assert.deepEqual([(await item(db, 1)).state, (await item(db, 1)).merged_at, (await item(db, 1)).closed_at], ["MERGED", "t1", "t1"]);
  assert.deepEqual([(await item(db, 4)).state, (await item(db, 4)).closed_at], ["CLOSED", "old"]);
  assert.equal((await item(db, 2)).state, "CLOSED");
  assert.equal((await item(db, 3)).labels, '["bug","p1"]');
  // A merged item is not moved again, and a later read of the same patch keeps the first merge time.
  assert.deepEqual((await applyLocal(db, [{ kind: "merged", repo: "app", number: 1, at: "t2" }, { kind: "state", repo: "app", number: 1, state: "CLOSED" }])).changed, []);
  assert.equal((await item(db, 1)).merged_at, "t1");
  return r.changed.sort();
});

both("applyLocal live: the mirrored mergeable moves for the same head only, and checks of another head reset", async (db) => {
  await seedItems(db, "app", [1, 2], { head_oid: "h1", mergeable: "UNKNOWN" });
  await saveChecks(db, [
    { repo: "app", number: 1, head_oid: "h1", state: "OPEN", is_draft: 0, overall: "success", checks: '[{"name":"x"}]', mergeable: "MERGEABLE", maintainer_can_modify: 1, fetched_at: "x" },
    { repo: "app", number: 2, head_oid: "h1", state: "OPEN", is_draft: 0, overall: "success", checks: '[{"name":"x"}]', mergeable: "MERGEABLE", maintainer_can_modify: 1, fetched_at: "x" },
  ], "t0");
  const live = (h: string, mergeable: string) => ({ head: h, mergeable, draft: true, maintainerCanModify: false });
  const r = await applyLocal(db, [{ kind: "live", repo: "app", number: 1, pr: live("h1", "UNKNOWN"), at: "t1" }, { kind: "live", repo: "app", number: 2, pr: live("h2", "CONFLICTING"), at: "t1" }]);
  assert.deepEqual(r.changed.sort(), ["app#1", "app#2"]);
  const c = await loadChecks(db, [...one("app", 1), ...one("app", 2)]);
  // Same head: the stored known value survives UNKNOWN, the checks stay. New head: pending, no checks, the live value.
  assert.deepEqual([c.get("app#1")!.mergeable, c.get("app#1")!.overall, c.get("app#1")!.is_draft, c.get("app#1")!.fetched_at], ["MERGEABLE", "success", 1, "t1"]);
  assert.deepEqual([c.get("app#2")!.head_oid, c.get("app#2")!.overall, c.get("app#2")!.checks, c.get("app#2")!.mergeable], ["h2", "pending", "[]", "CONFLICTING"]);
  assert.deepEqual([(await item(db, 1)).mergeable, (await item(db, 2)).mergeable], ["UNKNOWN", "UNKNOWN"]);
  await applyLocal(db, [{ kind: "live", repo: "app", number: 1, pr: live("h1", "CONFLICTING"), at: "t2" }]);
  assert.deepEqual([(await item(db, 1)).mergeable, (await loadChecks(db, one("app", 1))).get("app#1")!.mergeable], ["CONFLICTING", "CONFLICTING"]);
  return [(await item(db, 1)).mergeable];
});

both("applyLocal base: a changed base is stored and audited, the cached diff of the head goes unless kept", async (db) => {
  await seedItems(db, "app", [1, 2, 3], { base_ref: "main", head_oid: "h" });
  await saveDiffFacts(db, [1, 2, 3].map((n) => ({ repo: "app", number: n, head_oid: "h", reasons: "[]", lines: 1, pending: 0, last_read: null })) as never, "insert-ignore");
  const r = await applyLocal(db, [
    { kind: "base", repo: "app", number: 1, baseRef: "next", head: "h", by: "tester" }, { kind: "base", repo: "app", number: 2, baseRef: "next", head: "h", keepDiff: true },
    { kind: "base", repo: "app", number: 3, baseRef: "main", head: "h" },
  ]);
  assert.deepEqual(r.changed.sort(), ["app#1", "app#2"]);
  assert.deepEqual([(await item(db, 1)).base_ref, (await item(db, 3)).base_ref], ["next", "main"]);
  const left = await db.all(db.k.selectFrom("main.diff_facts").select("number").orderBy("number"));
  assert.deepEqual(left.map((x) => x.number), [2]);
  const a = (await audits(db)).filter((x) => x.action === "base-changed");
  assert.deepEqual(a.map((x) => x.target), ["app#1", "app#2"]);
  return a.map((x) => x.target);
});

both("closeGoneItems closes open items once and audits each", async (db) => {
  await seedItems(db, "app", [1, 2], { closed_at: null });
  await seedItems(db, "app", [3], { state: "MERGED" });
  assert.equal(await closeGoneItems(db, ["app#1", "app#2", "app#3", "app#9"], "now"), 2);
  assert.deepEqual([(await item(db, 1)).state, (await item(db, 1)).closed_at, (await item(db, 3)).state], ["CLOSED", "now", "MERGED"]);
  assert.equal(await closeGoneItems(db, ["app#1"], "later"), 0);
  assert.equal((await audits(db)).filter((x) => x.action === "item-gone").length, 2);
  return [await closeGoneItems(db, [], "x")];
});

const withComments = (e: ItemEntry, ids: string[]): ItemEntry => ({ ...e, comments: ids.map((id) => comment(e.repo, e.row.number, id)) });

both("saveItems: a read that started before the stored one changes nothing, an identical row is not rewritten, last entry wins", async (db) => {
  const first = await saveItems(db, [withComments(entry("app", 1, { title: "one" }), ["a", "b"]), entry("app", 2), entry("app", 2, { title: "second" })], { readAt: "2026-01-02T00:00:00.000Z" });
  assert.equal(first.stored, 2);
  assert.equal((await item(db, 2)).title, "second");
  // Older read: skipped entirely, comments included.
  assert.equal((await saveItems(db, [withComments(entry("app", 1, { title: "stale" }), ["z"])], { readAt: "2026-01-01T00:00:00.000Z" })).stored, 0);
  assert.equal((await item(db, 1)).title, "one");
  const ids = async () => (await db.all(db.k.selectFrom("main.comments").select("id").where("number", "=", 1).orderBy("id"))).map((c) => c.id);
  assert.deepEqual(await ids(), ["a", "b"]);
  // Identical row: nothing written (comments stay as they were, even when the entry lists others).
  assert.equal((await saveItems(db, [withComments(entry("app", 1, { title: "one" }), ["c"])], { readAt: "2026-01-03T00:00:00.000Z" })).stored, 0);
  assert.deepEqual(await ids(), ["a", "b"]);
  // A changed row replaces its comments; a forced identical row keeps listed comments and drops the unlisted.
  assert.equal((await saveItems(db, [withComments(entry("app", 1, { title: "one again" }), ["c"])], { readAt: "2026-01-04T00:00:00.000Z" })).stored, 1);
  assert.deepEqual(await ids(), ["c"]);
  assert.equal((await saveItems(db, [withComments(entry("app", 1, { title: "one again" }), ["c", "d"])], { readAt: "2026-01-05T00:00:00.000Z", force: true })).stored, 1);
  assert.deepEqual(await ids(), ["c", "d"]);
  assert.equal((await saveItems(db, [withComments(entry("app", 1, { title: "one again" }), ["d"])], { readAt: "2026-01-06T00:00:00.000Z", force: true })).stored, 1);
  assert.deepEqual(await ids(), ["d"]);
  const read = await db.get(db.k.selectFrom("main.item_reads").select("synced_at").where("number", "=", 1));
  assert.equal(read!.synced_at, "2026-01-06T00:00:00.000Z");
  return [await ids(), read!.synced_at];
});

both("saveItems keeps a known mergeable at the same head and writes the text refs of a rewritten PR", async (db) => {
  await saveItems(db, [entry("app", 1, { head_oid: "h", mergeable: "MERGEABLE", text_refs: '[[1],[1]]' }), entry("app", 2, { head_oid: "h", kind: "issue" })], { readAt: "2026-01-01T00:00:00.000Z" });
  assert.equal((await item(db, 1)).text_refs, '[[1],[1]]');
  await saveItems(db, [entry("app", 1, { head_oid: "h", mergeable: "UNKNOWN", title: "changed", text_refs: '[[2],[2]]' })], { readAt: "2026-01-02T00:00:00.000Z" });
  assert.deepEqual([(await item(db, 1)).mergeable, (await item(db, 1)).text_refs, (await item(db, 1)).title], ["MERGEABLE", '[[2],[2]]', "changed"]);
  await saveItems(db, [entry("app", 1, { head_oid: "h2", mergeable: "UNKNOWN", title: "changed" })], { readAt: "2026-01-03T00:00:00.000Z" });
  assert.equal((await item(db, 1)).mergeable, "UNKNOWN");
  return [(await item(db, 1)).text_refs];
});

both("saveItems binds an author id once, and leaves the login alone when it has id-less merged history", async (db) => {
  await seedItems(db, "app", [9], { author: "old", author_id: null, state: "MERGED" });
  await saveItems(db, [entry("app", 1, { author: "new", author_id: 7 }), entry("app", 2, { author: "old", author_id: 8 })], { readAt: "2026-01-01T00:00:00.000Z" });
  await saveItems(db, [entry("app", 3, { author: "new", author_id: 99 })], { readAt: "2026-01-02T00:00:00.000Z" });
  const ids = await db.all(db.k.selectFrom("main.author_ids").select(["login", "id"]).orderBy("login"));
  assert.deepEqual(ids.map((r) => [r.login, Number(r.id)]), [["new", 7]]);
  return ids.map((r) => [r.login, Number(r.id)]);
});

both("fillItemHashes fills missing embed hashes and open items' class hashes of another scheme, in batches", async (db) => {
  await seedItems(db, "app", [1, 2, 3], { embed_hash: null, class_hash: null, class_scheme: null });
  await seedItems(db, "app", [4], { state: "CLOSED", embed_hash: null, class_scheme: null });
  await seedItems(db, "app", [5], { embed_hash: "kept", class_hash: "kept", class_scheme: "s2" });
  const marks: string[] = [];
  const n = await fillItemHashes(db, (r) => ({ embed_hash: `e${r.number}`, class_hash: `c${r.number}`, class_scheme: "s2" }), { scheme: "s2", batch: 2, around: async (source, rows, write) => { marks.push(`${source}:${rows}`); await write(); } });
  assert.equal(n, 4 + 3);
  const rows = await Promise.all([1, 2, 3, 4, 5].map((i) => item(db, i)));
  assert.deepEqual(rows.map((r) => r.embed_hash), ["e1", "e2", "e3", "e4", "kept"]);
  assert.deepEqual(rows.map((r) => r.class_hash), ["c1", "c2", "c3", null, "kept"]);
  assert.deepEqual(marks, ["embed-hashes:2", "embed-hashes:2", "class-hashes:2", "class-hashes:1"]);
  assert.equal(await fillItemHashes(db, () => ({ embed_hash: null, class_hash: null, class_scheme: null }), { scheme: "s2" }), 0);
  return rows.map((r) => r.class_hash);
});

bothFlat("saveItems and applyLocal issue the same number of statements for 2 and 12 entries", async () => {}, async (db, size) => {
  const n = Array.from({ length: size }, (_, i) => i + 1);
  await saveItems(db, n.map((i) => withComments(entry("app", i, { author: `u${i}`, author_id: i, head_oid: "h", text_refs: "[[],[]]" }), [`c${i}a`, `c${i}b`])), { readAt: "2026-01-01T00:00:00.000Z" });
  await saveItems(db, n.map((i) => withComments(entry("app", i, { author: `u${i}`, author_id: i, head_oid: "h", title: "again", text_refs: "[[],[]]" }), [`c${i}c`])), { readAt: "2026-01-02T00:00:00.000Z", force: true });
  await saveChecks(db, n.map((i) => ({ repo: "app", number: i, head_oid: "h", state: "OPEN", is_draft: 0, overall: "success", checks: "[]", mergeable: "MERGEABLE", maintainer_can_modify: 1, fetched_at: "x" })), "t");
  await applyLocal(db, n.flatMap((i) => [
    { kind: "merged" as const, repo: "app", number: i, at: "t" }, { kind: "labels" as const, repo: "app", number: i, labels: ["a"] },
    { kind: "live" as const, repo: "app", number: i, pr: { head: "h", mergeable: "MERGEABLE", draft: false }, at: "t" },
  ]));
});
