import { test } from "node:test";
import assert from "node:assert/strict";
import { connectDb } from "./helpers/raw-db.ts";
import { ActionError, actionsOf, batchAgain, reviewAgain, verifyAgain } from "../src/operator-actions.ts";
import { optionalChecks, optionalChecksOf, seenChecks, setOptionalCheck } from "../src/optional-checks.ts";

const t = "2026-11-01T00:00:00.000Z";

async function world() {
  const db = await connectDb(":memory:");
  await db.run(db.k.insertInto("repos").values({ name: "app", visibility: "public" }));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: t, pipeline: 1 }));
  await db.run(db.k.insertInto("items").values([
    { repo: "app", number: 1, kind: "pr", state: "OPEN", title: "PR", head_oid: "h1", updated_at: t },
    { repo: "app", number: 2, kind: "issue", state: "OPEN", title: "Issue" },
  ]));
  return db;
}

test("a held review, a failed verification and a stopped fix are released once, for the item's current head", async () => {
  const db = await world();
  await db.run(db.k.insertInto("opus_reviews").values([
    { repo: "app", number: 1, head_oid: "h1", at: t, mode: "full", verdict: "hold", reason: "needs work" },
    { repo: "app", number: 1, head_oid: "old", at: t, mode: "full", verdict: "hold", reason: "older head" },
  ]));
  await db.run(db.k.insertInto("verifications").values({ repo: "app", number: 1, head_sha: "h1", kind: "k", reason: "r", state: "failed", summary: "red", created_at: t }));
  assert.deepEqual(await actionsOf(db, "app", 1), { reviewAgain: true, verifyAgain: true, batchAgain: false });
  assert.deepEqual(await actionsOf(db, "app", 2), { reviewAgain: false, verifyAgain: false, batchAgain: false });

  await reviewAgain(db, "op", "app", 1);
  await verifyAgain(db, "op", "app", 1);
  const reviews = await db.all(db.k.selectFrom("opus_reviews").select("head_oid"));
  assert.deepEqual(reviews.map((r) => r.head_oid), ["old"]);
  assert.equal((await db.get(db.k.selectFrom("verifications").select("state").where("repo", "=", "app")))!.state, "stale");
  assert.deepEqual(await actionsOf(db, "app", 1), { reviewAgain: false, verifyAgain: false, batchAgain: false });
  await assert.rejects(() => reviewAgain(db, "op", "app", 1), (e) => e instanceof ActionError && e.status === 409);
});

test("optional checks are kept per repo, only for tracked repos, and listed from recent check results", async () => {
  const db = await world();
  assert.equal(await setOptionalCheck(db, "op", "app", " Sonar ", true), true);
  assert.equal(await setOptionalCheck(db, "op", "app", "Sonar", true), false);
  await assert.rejects(() => setOptionalCheck(db, "op", "other", "Sonar", true), /not tracked/);
  assert.deepEqual(await optionalChecks(db, "app"), ["Sonar"]);
  assert.deepEqual((await optionalChecksOf(db))("app"), ["Sonar"]);
  assert.deepEqual((await optionalChecksOf(db))("other"), []);
  await db.run(db.k.insertInto("pr_checks").values({ repo: "app", number: 1, head_oid: "h1", overall: "failure", checks: JSON.stringify([{ name: "build" }, { name: "Sonar" }]), fetched_at: t }));
  await db.run(db.k.insertInto("main_ci").values({ repo: "app", head_sha: "m", branch: "main", state: "success", failing: "[]", checks: JSON.stringify([{ name: "lint" }]), first_seen_at: t, state_changed_at: t, updated_at: t }));
  assert.deepEqual(await seenChecks(db, "app"), ["Sonar", "build", "lint"]);
  assert.equal(await setOptionalCheck(db, "op", "app", "Sonar", false), true);
  assert.deepEqual(await optionalChecks(db, "app"), []);
});

test("a PR held by a failed single-PR batch at its current head is released by superseding that batch", async () => {
  const db = await world();
  const batch = (state: string, summary: string) => db.get(db.k.insertInto("main.merge_batches")
    .values({ repo: "app", branch: "b", state, base_sha: "m", commit_sha: "c", summary, created_at: t, updated_at: t }).returning("id"));
  const failed = (await batch("failed", "conflict"))!.id;
  await db.run(db.k.insertInto("main.merge_batch_prs").values({ batch_id: failed, number: 1, head_oid: "h1", position: 0 }));
  assert.equal((await actionsOf(db, "app", 1)).batchAgain, true);
  await batchAgain(db, "op", "app", 1);
  assert.equal((await db.get(db.k.selectFrom("main.merge_batches").select("state").where("id", "=", failed)))!.state, "superseded");
  assert.equal((await actionsOf(db, "app", 1)).batchAgain, false);
});
