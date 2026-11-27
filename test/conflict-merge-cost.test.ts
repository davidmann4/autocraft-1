import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "./world-db.ts";
import { carriedReviews } from "../src/review/carry.ts";
import type { Db } from "../src/db/index.ts";
import { changedHunks, changedLines, ownDiffKey } from "../src/review/own-diff.ts";
import { prepareOpusInput, type OpusDeps } from "../src/review/opus.ts";
import { conflictBucket } from "../src/fixup/conflict-state.ts";
import { startWorkflows } from "../src/data/workflow/index.ts";
import { connectDb } from "./helpers/raw-db.ts";

const carriedReview = async (db: Db, c: { repo: string; number: number; head_oid: string }, stale?: Set<string>) => (await carriedReviews(db, [c], stale)).get(`${c.repo}#${c.number}`) ?? null;

process.env.AUTOCRAFT_DIFF_CACHE = join(tmpdir("conflict-cost-diffs"), "cache");

const diff = (ctx: string, add: string) => `diff --git a/src/a.rs b/src/a.rs
index 1111111..2222222 100644
--- a/src/a.rs
+++ b/src/a.rs
@@ -10,3 +10,4 @@ fn f() {
 ${ctx}
+${add}
 }
`;

test("a merge of the base that leaves the PR's own diff alone carries the verdict; changed hunks are read alone", async () => {
  assert.equal(ownDiffKey(diff("let a = 1;", "let b = 2;")), ownDiffKey(diff("let a = 9;", "let b = 2;").replace("@@ -10,3", "@@ -40,3")), "context and line numbers moved by the base");
  assert.notEqual(ownDiffKey(diff("x", "let b = 2;")), ownDiffKey(diff("x", "let b = 3;")));
  const before = diff("x", "let b = 2;");
  const after = `${diff("x", "let b = 3;")}diff --git a/src/b.rs b/src/b.rs\n--- a/src/b.rs\n+++ b/src/b.rs\n@@ -1 +1 @@\n-old\n+new\n`;
  const only = changedHunks(before, after);
  assert.match(only, /let b = 3;/);
  assert.match(only, /src\/b\.rs/);
  assert.equal(changedHunks(before, before), "");
  // The size of a resolution: the PR's lines it changed, not the ones it only moved.
  assert.equal(changedLines(before, before.replace("@@ -10,3", "@@ -40,3")), 0);
  assert.equal(changedLines(before, after), 4);

  const db = await connectDb(join(tmpdir("conflict-cost"), "t.db"));
  const at = "2026-11-04T10:00:00.000Z";
  await db.run(db.k.insertInto("opus_reviews").values({ repo: "app", number: 1, head_oid: "E", at, model: "opus", mode: "full", verdict: "take-fix", sure: 1, reason: "r", fixes: '[{"file":"a","change":"c"}]', seen_at: at }));
  await db.run(db.k.insertInto("conflict_merges").values({ repo: "app", number: 1, from_head: "E", to_head: "H", state: "merged", attempt: 1, created_at: at, own_diff: "same" }));
  await db.run(db.k.insertInto("conflict_merges").values({ repo: "app", number: 1, from_head: "E", to_head: "H2", state: "merged", attempt: 1, created_at: at, own_diff: "changed" }));
  const k = await carriedReview(db, { repo: "app", number: 1, head_oid: "H" });
  assert.equal(k?.review.verdict, "take-fix");
  assert.deepEqual(k?.review.fixes, [{ file: "a", change: "c" }]);
  assert.equal(await carriedReview(db, { repo: "app", number: 1, head_oid: "H2" }), null, "changed diff: reviewed, not carried");
});

test("a third merge of the base into one unapproved PR in a UTC day waits for the next day; an approved PR has no daily limit", async () => {
  const db = await connectDb(join(tmpdir("conflict-cap"), "t.db"));
  const now = Date.parse("2026-11-04T20:00:00Z");
  const ins = async (from: string, to: string, at: string) => await db.run(db.k.insertInto("conflict_merges").values({ repo: "app", number: 1, from_head: from, to_head: to, state: "merged", attempt: 1, created_at: at }));
  const p = async (head: string) => await conflictBucket(db, { repo: "app", number: 1, head, pushable: true }, { push: true, comment: true }, now);
  await ins("a", "b", "2026-11-03T23:00:00Z");
  await ins("b", "c", "2026-11-04T01:00:00Z");
  assert.equal(await p("c"), "merge", "one merge today");
  await ins("c", "d", "2026-11-04T02:00:00Z");
  assert.equal(await p("d"), "capped");
  assert.equal(await conflictBucket(db, { repo: "app", number: 1, head: "d", pushable: true }, { push: true, comment: true }, now + 5 * 3600_000), "merge", "next UTC day");
  assert.equal(await conflictBucket(db, { repo: "app", number: 1, head: "d", pushable: true, uncapped: true }, { push: true, comment: true }, now), "merge", "a PR approved for merge gets a third merge the same day");
});

test("the review after our resolution reads the changed and dropped PR hunks, and a head with no recorded delta is reviewed in full", async () => {
  const db = await connectDb(join(tmpdir("conflict-delta"), "t.db"));
  const at = "2026-11-04T10:00:00.000Z";
  await db.run(db.k.insertInto("opus_reviews").values({ repo: "app", number: 1, head_oid: "E", at, model: "opus", mode: "full", verdict: "take", sure: 1, reason: "r", seen_at: at }));
  const before = `${diff("x", "let kept = 1;")}diff --git a/src/b.rs b/src/b.rs\n--- a/src/b.rs\n+++ b/src/b.rs\n@@ -1 +1 @@\n-old\n+dropped line\n`;
  const after = diff("x", "let kept = 1;");
  const delta = changedHunks(before, after);
  assert.match(delta, /\(gone\) \+dropped line/, "the dropped hunk is shown, marked");
  assert.doesNotMatch(delta, /^\+dropped line/m);
  assert.equal(delta.match(/^diff --git a\/src\/b\.rs/gm)?.length, 1, "a path's header appears once");
  // A file the resolver touched shows every hunk, including one whose text did not change.
  const two = `${diff("x", "let kept = 1;")}@@ -50,2 +51,3 @@\n y\n+let moved = 1;\n z\n`;
  assert.equal(changedHunks(two, two), "");
  assert.match(changedHunks(two, two, ["src/a.rs"]), /let moved = 1;/);
  assert.match(changedHunks(two, two, ["src/a.rs"]), /let kept = 1;/);
  await db.run(db.k.insertInto("conflict_merges").values({ repo: "app", number: 1, from_head: "E", to_head: "H", state: "merged", attempt: 1, created_at: at, own_diff: "changed", own_delta: delta }));
  await db.run(db.k.insertInto("conflict_merges").values({ repo: "app", number: 1, from_head: "E", to_head: "H2", state: "merged", attempt: 1, created_at: at, own_diff: "changed", own_delta: null }));
  const deps: OpusDeps = { fetchDiff: async () => ({ ok: true, text: after }), fetchDelta: async () => ({ ok: false, tooLarge: false, error: "unused" }), model: "opus", maxChars: 120_000 };
  const c = (head_oid: string) => ({ repo: "app", number: 1, title: "t", body: "b", author_association: null, head_oid, lines_changed: 2, size: "S" as const, score: null });
  const d = await prepareOpusInput(db, "app", c("H"), deps, () => {});
  assert.equal(d.kind === "ready" && d.mode, "delta");
  assert.ok(d.kind === "ready" && d.input.diff.includes("dropped line"));
  const f = await prepareOpusInput(db, "app", c("H2"), deps, () => {});
  assert.equal(f.kind === "ready" && f.mode, "full", "an empty delta is not a delta");
  // Sent to merge without a review: the review our push owes reads the whole PR, not the changes since a review the person went past.
  await startWorkflows(db, [{ repo: "app", number: 1, kind: "pr", entry: "merge", weight: 5, startedBy: "ann", startedVia: "dashboard", baseHead: "E", at: "2026-11-04T11:00:00.000Z" }]);
  const m = await prepareOpusInput(db, "app", c("H"), deps, () => {});
  assert.deepEqual(m.kind === "ready" && [m.mode, m.input.earlier_opus], ["full", null]);
});
