// The planner reads a reviewed head's diff facts from the database; the code that writes or removes the cached diff stores them.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadPrFacts } from "../src/core/facts.ts";
import { EXTRAS_PENDING_REASON } from "../src/core/sensitive.ts";
import { DIFF_FACTS_KEY, EXTRAS_TRIES, buildDiffFacts, cachedDiff, diffFactsOfCache, dropCachedDiff, noteReread, type DiffFetcher } from "../src/review/diff.ts";
import { tmpdir, world, type World } from "./world-db.ts";

// Other test files write the same fixture heads into the shared scratch cache.
process.env.AUTOCRAFT_DIFF_CACHE = tmpdir("diff-facts");
let current: World | null = null;
afterEach(() => current?.close());

// A README change and a script a workflow step could run, read without the workflow steps: sensitive and waiting for its extras.
const TEXT = [
  "diff --git a/README.md b/README.md", "--- a/README.md", "+++ b/README.md", "@@ -1 +1,2 @@", " # App", "+See the docs.",
  "diff --git a/scripts/build.sh b/scripts/build.sh", "--- a/scripts/build.sh", "+++ b/scripts/build.sh", "@@ -1 +1 @@", "-make", "+make all", "",
].join("\n");
const fetch: DiffFetcher = async () => ({ ok: true, text: TEXT, base: "main", extras: { files: {}, runs: null, complete: false } });

test("the planner's diff facts follow the cached diff's writes, re-reads and removal", async () => {
  const w = (current = await (await (await (await world()).repo()).pr(1, { lines: 500 })).review(1));
  const facts = async () => (await loadPrFacts(w.db, { refs: ["app#1"] }))[0]!;
  assert.equal((await facts()).sensitive, null);

  await cachedDiff(w.db, "app", 1, "sha1", fetch, "main");
  const file = diffFactsOfCache("app", 1, "sha1")!;
  assert.ok(file.pending && file.reasons.length > 0);
  let f = await facts();
  assert.deepEqual(f.sensitive, [...file.reasons, EXTRAS_PENDING_REASON]);
  assert.equal(f.lines, file.lines);
  assert.notEqual(f.lines, 500);
  assert.equal(f.diffPending?.lastRead, null);

  await noteReread(w.db, "app", 1, "sha1", 1234);
  assert.equal((await facts()).diffPending?.lastRead, 1234);
  for (let i = 1; i < EXTRAS_TRIES; i++) await noteReread(w.db, "app", 1, "sha1", 2000 + i);
  const settled = diffFactsOfCache("app", 1, "sha1")!;
  f = await facts();
  assert.equal(settled.pending, false);
  assert.equal(f.diffPending, undefined);
  assert.deepEqual(f.sensitive, settled.reasons);

  await dropCachedDiff(w.db, "app", 1, "sha1");
  f = await facts();
  assert.equal(f.sensitive, null);
  assert.equal(f.lines, 500);

  // Facts computed by other rules are computed again at runner start, once.
  await cachedDiff(w.db, "app", 1, "sha1", fetch, "main");
  await w.db.run(w.db.k.deleteFrom("diff_facts"));
  assert.ok(await buildDiffFacts(w.db));
  assert.deepEqual((await facts()).sensitive, [...file.reasons, EXTRAS_PENDING_REASON]);
  assert.equal(await buildDiffFacts(w.db), null);

  // A new runner pod starts with an empty diff cache: the stored facts stand, through the start and a failed re-read.
  const before = await w.db.all(w.db.k.selectFrom("diff_facts").selectAll());
  process.env.AUTOCRAFT_DIFF_CACHE = tmpdir("diff-facts-fresh");
  assert.equal(await buildDiffFacts(w.db), null);
  await noteReread(w.db, "app", 1, "sha1", 5000);
  assert.deepEqual(await w.db.all(w.db.k.selectFrom("diff_facts").selectAll()), before.map((r) => ({ ...r, last_read: 5000 })));

  // New rules with nothing cached: settled facts wait for a re-read, keeping their reasons, written one transaction per batch.
  await w.db.run(w.db.k.updateTable("diff_facts").set({ pending: 0 }));
  await w.db.run(w.db.k.insertInto("diff_facts").values({ repo: "app", number: 1, head_oid: "sha0", reasons: "[]", lines: 3, pending: 0, last_read: null }));
  await w.db.run(w.db.k.updateTable("settings").set({ value: "older-rules" }).where("key", "=", DIFF_FACTS_KEY));
  const write = w.db.write.bind(w.db);
  let writes = 0;
  w.db.write = (fn, o) => { writes++; return write(fn, o); };
  assert.deepEqual(await buildDiffFacts(w.db, { batch: 1 }), { computed: 0, pending: 2 });
  w.db.write = write;
  assert.equal(writes, 2);
  f = await facts();
  assert.deepEqual(f.sensitive, [...file.reasons, EXTRAS_PENDING_REASON]);
  assert.equal(f.diffPending?.lastRead, 5000);
  assert.equal(await buildDiffFacts(w.db), null);
});
