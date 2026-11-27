// A review binds the base branch its diff was read against; an approved merge carried across a base merge covers no fix-up without a fresh review.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { recordLiveBase } from "../src/merge/base.ts";
import { premergeAt } from "../src/premerge/store.ts";
import { advancePreapprovals, preapprovalOf, preapproveMerge } from "../src/preapproval/index.ts";
import { markedStaleSince, staleReviews } from "../src/review/discussion.ts";
import { reviewHold } from "../src/review/gate.ts";
import { saveOpus } from "../src/review/opus.ts";
import { OPERATOR, T0, world, type World } from "./world-db.ts";

let current: World | null = null;
afterEach(() => current?.close());

test("a retarget makes the review stale like a push, and the re-review against the new base voids the old base's pre-merge review", async () => {
  const w = (current = await (await (await (await (await world()).repo()).pr(1)).review(1)).premerge(1, "clean"));
  await w.db.run(w.db.k.updateTable("items").set({ base_ref: "release" }).where("number", "=", 1));
  await w.db.run(w.db.k.updateTable("opus_reviews").set({ base_ref: "release" }).where("number", "=", 1));
  assert.equal((await staleReviews(w.db, "app")).size, 0);

  // The PR author retargets to the default branch; a live read before the merge records it.
  await recordLiveBase(w.db, "app", 1, "sha1", "main");
  assert.ok((await staleReviews(w.db, "app")).has("app#1@sha1"));
  assert.equal(await markedStaleSince(w.db, "app", 1, ""), false);
  const today = new Date().toISOString();
  for (let i = 0; i < 3; i++) await w.db.run(w.db.k.insertInto("opus_review_history").values({ repo: "app", number: 1, head_oid: "sha1", at: today, model: "m", mode: "full", verdict: "take", sure: 1, reason: "r" }));
  assert.equal((await reviewHold(w.db, "app", 1, "sha1"))?.kind, "cap");

  await saveOpus(w.db, "rv2", { repo: "app", number: 1, head_oid: "sha1" }, {
    mode: "full", base: null, baseRef: "main", model: "m",
    review: { ref: "app#1", verdict: "take", sure: true, reason: "fine", fixes: [], risks: [], summary: null, why: null, public: null, conflicts: [], claims: [], blocked_by: [] },
  });
  assert.equal((await staleReviews(w.db, "app")).size, 0);
  assert.equal(await premergeAt(w.db, "app", 1, "sha1"), null);
  assert.equal((await w.rows("SELECT trigger FROM opus_review_history WHERE number = 1 ORDER BY rowid DESC LIMIT 1"))[0]!.trigger, "base");
});

test("an approved merge carried across a clean base merge runs the review's fix-up and goes on at its new head", async () => {
  const w = (current = await (await (await (await (await (await world()).repo()).acting()).pr(30)).review(30, { verdict: "take" })).workflow(30));
  await preapproveMerge(w.db, { repo: "app", number: 30, by: OPERATOR });
  await w.db.run(w.db.k.insertInto("conflict_merges").values({ repo: "app", number: 30, from_head: "sha30", to_head: "sha30m", state: "merged", attempt: 1, created_at: T0, own_diff: "same" }));
  await w.synced(30, "sha30m");
  for (let i = 0; i < 3; i++) await advancePreapprovals(w.db);
  assert.equal((await preapprovalOf(w.db, "app", 30))?.state, "review");
  assert.equal((await preapprovalOf(w.db, "app", 30))?.head, "sha30m");

  await w.review(30, { head: "sha30m", verdict: "take-fix" });
  for (let i = 0; i < 3; i++) await advancePreapprovals(w.db);
  // The merge is approved: the review's fixes are the pipeline's fix-up to make.
  assert.equal((await preapprovalOf(w.db, "app", 30))?.state, "review");

  // The fix-up's push is the leg's own; its new head is reviewed again and goes on to CI on a take.
  await w.db.run(w.db.k.insertInto("fixups").values({ repo: "app", number: 30, from_head: "sha30m", to_head: "sha30f", state: "pushed", attempt: 1, created_at: T0 }));
  await w.synced(30, "sha30f");
  for (let i = 0; i < 3; i++) await advancePreapprovals(w.db);
  assert.equal((await preapprovalOf(w.db, "app", 30))?.state, "review");
  await w.review(30, { head: "sha30f" });
  for (let i = 0; i < 3; i++) await advancePreapprovals(w.db);
  assert.equal((await preapprovalOf(w.db, "app", 30))?.state, "ci");
});
