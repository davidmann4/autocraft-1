import assert from "node:assert/strict";
import { loadActivityByLogins, loadAuthoredIn, loadCommentHeads, loadComments, loadCommentStats, loadFormalReviews, loadNewerComments, loadSpokenComments, newerKey, searchComments } from "../../src/data/mirror/index.ts";
import type { Db } from "../helpers/raw-db.ts";
import { both, bothFlat, comment, seedItems } from "./mirror-fixture.ts";

const put = (db: Db, rows: ReturnType<typeof comment>[]) => db.write(async () => { await db.run(db.k.insertInto("main.comments").values(rows as never)); });
const refs = (n: number) => Array.from({ length: n }, (_, i) => ({ repo: "app", number: i + 1 }));

both("loadComments filters and orders as asked and reads the body only on request", async (db) => {
  await seedItems(db, "app", [1, 2]);
  await put(db, [
    comment("app", 1, "c1", { created_at: "2026-01-03T00:00:00Z" }), comment("app", 1, "c2", { author: "bot[bot]", created_at: "2026-01-02T00:00:00Z" }),
    comment("app", 1, "c3", { created_at: null, counted: 0 }), comment("app", 2, "c4", { kind: "review", review_state: "APPROVED" }),
  ]);
  const ids = async (f: Parameters<typeof loadComments>[2]) => [...(await loadComments(db, refs(2), f)).entries()].map(([k, v]) => `${k}:${v.map((c) => c.id).join(",")}`);
  assert.deepEqual(await ids({ order: "rowid" }), ["app#1:c1,c2,c3", "app#2:c4"]);
  assert.deepEqual(await ids({ order: "created" }), ["app#1:c3,c2,c1", "app#2:c4"]);
  assert.deepEqual(await ids({ order: "rowid", counted: true, excludeBots: true }), ["app#1:c1", "app#2:c4"]);
  assert.deepEqual(await ids({ order: "rowid", kinds: ["review"] }), ["app#2:c4"]);
  assert.deepEqual(await ids({ order: "rowid", after: "2026-01-02T12:00:00Z" }), ["app#1:c1"]);
  assert.ok(!("body" in (await loadComments(db, refs(1), { order: "rowid" })).get("app#1")![0]!));
  assert.equal((await loadComments(db, refs(1), { order: "rowid", body: true })).get("app#1")![0]!.body, "text c1");
  return await ids({ order: "created" });
});

both("loadCommentStats counts, sizes and lists the authors of each item's comments under the same filter", async (db) => {
  await seedItems(db, "app", [1, 2]);
  await put(db, [
    comment("app", 1, "c1", { created_at: "2026-01-03T00:00:00Z", url: "u" }), comment("app", 1, "c2", { author: "bob", body: "four" }),
    comment("app", 1, "c3", { author: "alice", counted: 0 }), comment("app", 2, "c4", { author: "bot[bot]" }),
  ]);
  const all = await loadCommentStats(db, refs(2));
  assert.equal(all.get("app#1")!.n, 3);
  assert.equal(all.get("app#1")!.hasUrls, true);
  assert.equal(all.get("app#1")!.newest, "2026-01-03T00:00:00Z");
  assert.deepEqual([...all.get("app#1")!.authors].sort(), ["alice", "bob"]);
  assert.equal(all.get("app#2")!.hasUrls, false);
  const counted = await loadCommentStats(db, refs(2), { counted: true, excludeBots: true });
  assert.equal(counted.get("app#1")!.n, 2);
  assert.equal(counted.has("app#2"), false);
  return [all.get("app#1")!.n, counted.get("app#1")!.n];
});

both("spoken comments leave out bots, named logins and empty text; heads, newer ones and edges follow the creation order", async (db) => {
  await seedItems(db, "app", [1, 2]);
  await put(db, [
    comment("app", 1, "c1", { created_at: "2026-01-01T00:00:00Z", author: "Ann", author_association: "MEMBER" }), comment("app", 1, "c2", { created_at: "2026-01-04T00:00:00Z", author: "bot[bot]" }),
    comment("app", 1, "c3", { created_at: "2026-01-03T00:00:00Z", author: "own-app" }), comment("app", 1, "c4", { created_at: "2026-01-03T00:00:00Z", author: "bob" }),
    comment("app", 1, "c5", { created_at: "2026-01-05T00:00:00Z", body: "  " }), comment("app", 1, "c0", { created_at: null, author: null }),
  ]);
  const not = ["own-app"];
  const heads = await loadCommentHeads(db, refs(2), { not });
  assert.deepEqual([...heads], [["app#1", { n: 3, last: "c4" }]]);
  const edge = async (order: "first" | "last") => (await loadSpokenComments(db, { repo: "app", number: 1 }, { order, limit: 2, not })).map((c) => c.id);
  assert.deepEqual([await edge("first"), await edge("last")], [["c0", "c1"], ["c4", "c1"]]);
  const asked = ["c1", "c4", "gone", null].map((after) => ({ repo: "app", number: 1, after }));
  const newer = await loadNewerComments(db, asked, { not });
  assert.deepEqual(asked.map((a) => newer.get(newerKey(a))?.map((c) => c.id) ?? null), [["c4"], [], null, ["c0", "c1", "c4"]]);
  assert.deepEqual([...await loadAuthoredIn(db, "app", ["ann", "bob"], ["MEMBER"])], ["ann"]);
  return [...heads];
});

both("loadFormalReviews keeps formal reviews with an author on open PRs, in row order", async (db) => {
  await seedItems(db, "app", [1]);
  await seedItems(db, "app", [2], { state: "MERGED" });
  await seedItems(db, "app", [3], { kind: "issue" });
  const review = (n: number, id: string, state: string | null, author: string | null = "rev") => comment("app", n, id, { kind: "review", review_state: state, author, author_association: "MEMBER" });
  await put(db, [review(1, "r1", "CHANGES_REQUESTED"), review(1, "r2", "COMMENTED"), review(1, "r3", "APPROVED", null), review(1, "r4", "APPROVED"), review(2, "r5", "APPROVED"), review(3, "r6", "APPROVED"), comment("app", 1, "c1")]);
  const m = await loadFormalReviews(db, [{ repo: "app", number: 1 }, { repo: "app", number: 2 }, { repo: "app", number: 3 }]);
  assert.deepEqual([...m.keys()], ["app#1"]);
  assert.deepEqual(m.get("app#1")!.map((r) => [r.id, r.state, r.association]), [["r1", "CHANGES_REQUESTED", "MEMBER"], ["r4", "APPROVED", "MEMBER"]]);
  return m.get("app#1")!.map((r) => r.id);
});

both("loadActivityByLogins finds logins with an item or a comment in the repo, ignoring case", async (db) => {
  await seedItems(db, "app", [1], { author: "Alice" });
  await seedItems(db, "other", [1], { author: "dave" });
  await put(db, [comment("app", 1, "c1", { author: "bob" })]);
  const found = await loadActivityByLogins(db, "app", ["alice", "BOB", "carol", "dave"]);
  assert.deepEqual([...found].sort(), ["BOB", "alice"]);
  assert.equal((await loadActivityByLogins(db, "app", [])).size, 0);
  return [...found].sort();
});

both("searchComments finds comments by their text within the repos asked for", async (db) => {
  await seedItems(db, "app", [1]);
  await seedItems(db, "lib", [1]);
  await put(db, [comment("app", 1, "c1", { body: "the flux capacitor is broken" }), comment("lib", 1, "c2", { body: "capacitor too" }), comment("app", 1, "c3", { body: "nothing here" })]);
  assert.deepEqual((await searchComments(db, "capacitor", { repos: ["app"] })).map((h) => h.id), ["c1"]);
  assert.equal((await searchComments(db, "capacitor", {})).length, 2);
  assert.ok((await searchComments(db, "capacitor", { snippets: true, limit: 1 }))[0]!.snippet!.includes("\u0002"));
  return (await searchComments(db, "capacitor", { repos: ["app"] })).map((h) => h.id);
});

bothFlat("the comment loaders issue the same number of statements for 2 and 12 keys", async (db, size) => {
  await seedItems(db, "app", Array.from({ length: size }, (_, i) => i + 1));
  await put(db, Array.from({ length: size * 2 }, (_, i) => comment("app", (i % size) + 1, `c${i}`, { kind: i % 2 ? "review" : "comment", review_state: i % 2 ? "APPROVED" : null })));
}, async (db, size) => {
  const keys = refs(size);
  await db.together(async () => {
    await Promise.all([loadComments(db, keys, { order: "created", body: true }), loadCommentStats(db, keys, { counted: true }), loadFormalReviews(db, keys), loadActivityByLogins(db, "app", ["alice", "bob"])]);
  });
});
