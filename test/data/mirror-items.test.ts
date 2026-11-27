import assert from "node:assert/strict";
import { listItems, loadItemAuthors, loadItems, loadOpenNumbers, loadOpenPrLinks, loadPrMirror, loadShown, countItems, listMentioning, openItemKeys, searchItems, saveChecks } from "../../src/data/mirror/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import { both, bothFlat, seedItems } from "./mirror-fixture.ts";

const refs = (repo: string, n: number) => Array.from({ length: n }, (_, i) => ({ repo, number: i + 1 }));

both("loadItems reads the preset's columns for the keys, leaves missing keys out, and accepts a key source", async (db) => {
  await seedItems(db, "app", [1, 2, 3]);
  await seedItems(db, "lib", [1], { kind: "issue", state: "CLOSED" });
  const card = await loadItems(db, [{ repo: "app", number: 1 }, { repo: "app", number: 9 }, { repo: "lib", number: 1 }], "card");
  assert.deepEqual([...card.keys()].sort(), ["app#1", "lib#1"]);
  assert.ok(!("body" in card.get("app#1")!));
  assert.equal((await loadItems(db, [{ repo: "app", number: 1 }], "text")).get("app#1")!.body, "body 1");
  assert.ok(!("fts" in (await loadItems(db, [{ repo: "app", number: 1 }], "full")).get("app#1")!));
  assert.deepEqual((await loadItems(db, [], "ref")).size, 0);
  const open = await loadItems(db, openItemKeys({ repos: ["app", "lib"] }), "ref");
  assert.deepEqual([...open.keys()].sort(), ["app#1", "app#2", "app#3"]);
  return [...open.keys()].sort();
});

both("listItems filters, orders by repo and number, and pages", async (db) => {
  await seedItems(db, "app", [1, 2, 3, 4], { labels: '["bug"]', head_oid: "abc" });
  await seedItems(db, "app", [5], { labels: '["docs"]', state: "MERGED", head_oid: "def" });
  await seedItems(db, "lib", [1], { kind: "issue" });
  const nums = async (f: Parameters<typeof listItems>[1]) => (await listItems(db, f, "ref")).map((r) => `${r.repo}#${r.number}`);
  assert.deepEqual(await nums({ repos: ["app"], states: ["OPEN"], labelsAny: ["bug"] }), ["app#1", "app#2", "app#3", "app#4"]);
  assert.deepEqual(await nums({ headOid: "def" }), ["app#5"]);
  assert.deepEqual(await nums({ kind: "issue" }), ["lib#1"]);
  assert.deepEqual(await nums({ numbers: [2, 3], repos: ["app"] }), ["app#2", "app#3"]);
  assert.deepEqual(await nums({ page: { after: "app#2", limit: 2 } }), ["app#3", "app#4"]);
  assert.deepEqual(await nums({ hidden: Object.assign(["lib"], {}) }), ["app#1", "app#2", "app#3", "app#4", "app#5"]);
  return await nums({});
});

both("the open-link, number, count and shown loaders read what the planner needs", async (db) => {
  await seedItems(db, "app", [1], { base_ref: "main", head_ref: "feat/a", head_repo: "Org/App" });
  await seedItems(db, "app", [2], { base_ref: "feat/a", head_ref: "feat/b", head_repo: "org/app", closing_issues: "[7]", text_refs: '[[],[]]' });
  await seedItems(db, "app", [3], { kind: "issue", state: "CLOSED", title: "done" });
  assert.deepEqual([...(await loadOpenNumbers(db, ["app", "none"], "pr")).entries()], [["app", [1, 2]]]);
  assert.deepEqual((await loadOpenPrLinks(db, ["app"])).map((r) => [r.number, r.title ?? null]), [[2, null], [1, "title 1"]]);
  assert.deepEqual([...(await countItems(db, { repos: ["app"] }, "state")).entries()].sort(), [["CLOSED", 1], ["OPEN", 2]]);
  assert.equal((await countItems(db, {})).get(""), 3);
  const shown = await loadShown(db, refs("app", 3));
  assert.deepEqual([shown.get("app#3")!.state, shown.get("app#3")!.kind, shown.get("app#1")!.state], ["closed", "issue", "open"]);
  return [...shown.entries()];
});

both("loadPrMirror carries the checks list only for a failing PR", async (db) => {
  await seedItems(db, "app", [1, 2, 3], { head_oid: "h" });
  const row = (number: number, overall: string) => ({ repo: "app", number, head_oid: "h", state: "OPEN", is_draft: 0, overall, checks: '[{"name":"ci"}]', mergeable: "MERGEABLE", maintainer_can_modify: 1, fetched_at: "x" });
  await saveChecks(db, [row(1, "failure"), row(2, "success")], "2026-01-01T00:00:00Z");
  const m = await loadPrMirror(db, refs("app", 3));
  assert.equal(m.get("app#1")!.checks!.checks, '[{"name":"ci"}]');
  assert.equal(m.get("app#2")!.checks!.checks, null);
  assert.equal(m.get("app#2")!.checks!.overall, "success");
  assert.equal(m.get("app#3")!.checks, null);
  return [m.get("app#1")!.checks!.checks, m.get("app#3")!.checks];
});

both("searchItems finds items by their text, best first, within the repos asked for", async (db) => {
  await seedItems(db, "app", [1], { title: "flux capacitor", body: "does not charge" });
  await seedItems(db, "app", [2], { title: "unrelated", body: "the capacitor again" });
  await seedItems(db, "lib", [1], { title: "capacitor in lib", body: "" });
  const hits = await searchItems(db, "capacitor", { repos: ["app"] });
  assert.deepEqual(hits.map((h) => h.ref).sort(), ["app#1", "app#2"]);
  assert.equal(hits[0]!.ref, "app#1");
  assert.deepEqual(await searchItems(db, "   ", {}), []);
  const withSnippets = await searchItems(db, "capacitor", { snippets: true, kind: "pr" });
  assert.ok(withSnippets.every((h) => (h.snippets ?? []).every((s) => s.includes("\u0002"))));
  return hits.map((h) => h.ref);
});

both("a path is found by the search as a word of its own, and by listMentioning inside a URL too", async (db) => {
  await seedItems(db, "app", [1], { title: "Broken save", body: "Seen in crates/io/src/lib.rs:20" });
  await seedItems(db, "app", [2], { title: "Broken load", body: "https://github.com/o/app/blob/main/crates/io/src/lib.rs#L3" });
  await seedItems(db, "app", [3], { title: "Version", body: "Since v1.2.3, with Cargo.toml's 'quoted' part" });
  await seedItems(db, "app", [4], { title: "Closed long ago", body: "crates/io/src/lib.rs", state: "CLOSED", closed_at: "2025-01-01T00:00:00Z" });
  const found = async (s: string) => (await searchItems(db, s, { repos: ["app"] })).map((h) => h.ref).sort();
  assert.ok((await found("crates/io/src/lib.rs")).includes("app#1"));
  assert.ok((await found('"in crates/io/src/lib.rs"')).includes("app#1"));
  assert.deepEqual(await found("Cargo.toml"), ["app#3"]);
  assert.deepEqual(await found("cargo.to*"), ["app#3"]);
  assert.deepEqual(await found("v1.2.3"), ["app#3"]);
  assert.ok(!(await found("broken -crates/io/src/lib.rs")).includes("app#1"));
  for (const odd of ["it's a\\b", "a'b", "x\\'y", "a&b|c!d", "a:b*", "<->.<->x/y"]) await found(odd);
  const mentioning = (await listMentioning(db, "app", ["#77", "crates/io/src/lib.rs"], { since: "2026-01-01T00:00:00Z" })).map((i) => i.number);
  assert.deepEqual(mentioning, [1, 2]);
  return mentioning;
});

bothFlat("the item loaders issue the same number of statements for 2 and 12 keys", async (db, size) => {
  await seedItems(db, "app", Array.from({ length: size }, (_, i) => i + 1), { head_ref: "feat", head_repo: "o/a", base_ref: "main" });
}, async (db, size) => {
  const keys = refs("app", size);
  await db.together(async () => {
    await Promise.all([loadItems(db, keys, "card"), loadItems(db, keys, "text"), loadPrMirror(db, keys), loadShown(db, keys), loadOpenNumbers(db, ["app"]),
      loadOpenPrLinks(db, ["app"]), countItems(db, { repos: ["app"] }, "kind"), listItems(db, { repos: ["app"] }, "pr")]);
  });
});

both("loadItemAuthors: the item author with its commits' authors and co-authors, lowercase, once each", async (db) => {
  await seedItems(db, "app", [1], { author: "Ann" });
  await seedItems(db, "app", [2], { author: null });
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.pr_commits").values([
    { repo: "app", number: 1, oid: "a", committed_at: "t", author: "ann", co_authors: '["Bob","ann"]' },
    { repo: "app", number: 2, oid: "b", committed_at: "t", author: "Cid", co_authors: "not json" },
  ]));
  const m = await loadItemAuthors(db, [{ repo: "app", number: 1 }, { repo: "app", number: 2 }, { repo: "app", number: 3 }]);
  assert.deepEqual([...m].map(([k, v]) => [k, [...v].sort()]).sort(), [["app#1", ["ann", "bob"]], ["app#2", ["cid"]]]);
  return [...m.keys()].sort();
});
