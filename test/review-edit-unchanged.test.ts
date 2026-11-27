import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SCRATCH } from "./scratch.ts";
import { editReview, type Writer } from "../src/github/write.ts";
import type { Guarded } from "../src/core/guard.ts";
import type { Querier } from "../src/mirror.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });

test("a review edit that would leave the text as it is sends nothing, so a retry after a lost answer is not repeated", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "review-edit-")), "t.db"));
  // GitHub's review: the edit mutation sets its text, the read returns it.
  let body = "old text";
  let edits = 0;
  const q = { query: async (query: string, v: { body?: string }) => {
    if (query.includes("updatePullRequestReview")) { edits++; body = v.body!; return { updatePullRequestReview: { pullRequestReview: { id: "R1" } } }; }
    return { node: { body } };
  } } as unknown as Querier;
  const w: Writer = { db, login: "review-post" };
  const g = { scope: "pr", repo: "app", number: 1, head: "H", as: "legacy" } as unknown as Guarded<"post-review">;
  const note = { by: "model", kind: "review", model: "opus" } as const;
  const rows = async () => (await db.get(db.k.selectFrom("audit").select((eb) => eb.fn.countAll<number>().as("n")).where("action", "=", "review-edit")))!.n;

  await editReview(w, q, g, "R1", note, "new verdict");
  assert.equal(edits, 1);
  await editReview(w, q, g, "R1", note, "new verdict");
  assert.equal(edits, 1, "the review already reads the text");
  assert.equal(await rows(), 1);
  await editReview(w, q, g, "R1", note, "another verdict");
  assert.equal(edits, 2, "a changed text is still written");
});
