import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "./world-db.ts";
import { decidePr } from "../src/core/decide.ts";
import type { PlanSet } from "../src/core/plan-set.ts";
import { planned } from "../src/core/select.ts";
import { carriedReviews } from "../src/review/carry.ts";
import type { Db } from "../src/db/index.ts";
import { prFacts } from "./world.ts";
import { connectDb, dbFor } from "./helpers/raw-db.ts";
import { sqliteOnly } from "./test-db.ts";

const carriedReview = async (db: Db, c: { repo: string; number: number; head_oid: string }, stale?: Set<string>) => (await carriedReviews(db, [c], stale)).get(`${c.repo}#${c.number}`) ?? null;

test("selection order: our broken push, then work in flight, then score", { skip: sqliteOnly("raw DatabaseSync handle (convert to connectDb)") }, async () => {
  const mk = (n: number, over: Parameters<typeof prFacts>[0]) => { const facts = prFacts({ number: n, review: { head: "old" }, head: "h", ...over }); return { facts, plan: decidePr(facts) }; };
  const plans: PlanSet = {
    run: null, now: 0, pass: { rereadPaceAt: 0 }, items: [],
    prs: [mk(1, { score: 900 }), mk(2, { score: 10, inFlight: true }), mk(3, { score: 5, brokeByUs: true, inFlight: true }), mk(4, { score: 500, inFlight: true })],
  };
  const order = (await planned(await dbFor(new DatabaseSync(":memory:")), "review", { plans })).map((p) => p.facts.number);
  assert.deepEqual(order, [3, 4, 2, 1]);
});

test("a verdict carries over only a single checked fix-up of ours", async () => {
  const db = await connectDb(join(tmpdir("carry"), "t.db"));
  const at = "2026-11-04T10:00:00.000Z";
  await db.run(db.k.insertInto("opus_reviews").values({ repo: "app", number: 1, head_oid: "E", at, model: "opus", mode: "full", verdict: "take-fix", sure: 1, reason: "r", why: "needs a one-line fix", seen_at: at }));
  await db.run(db.k.insertInto("fixups").values({ repo: "app", number: 1, from_head: "E", to_head: "H", state: "pushed", attempt: 1, created_at: at }));
  const c = { repo: "app", number: 1, head_oid: "H" };
  assert.equal(await carriedReview(db, c), null, "no approved patch check yet");
  await db.run(db.k.insertInto("patch_checks").values({ kind: "fixup", repo: "app", number: 1, subject: "E", patch_hash: "x", round: 1, verdict: "approve", reasons: "", problems: "[]", model: "m", created_at: at }));
  const k = await carriedReview(db, c);
  assert.equal(k?.review.verdict, "take");
  assert.deepEqual(k?.review.fixes, []);
  assert.equal(k?.review.why, null, "the take-fix reason described the fixes, now made");
  assert.equal(k?.review.reason, "carried from E: the only change is our checked fix-up");
  assert.equal(await carriedReview(db, { ...c, head_oid: "H2" }), null, "a contributor commit after ours");
});

test("a carried verdict is not carried again after new discussion or at a head that has a review", async () => {
  const db = await connectDb(join(tmpdir("carry2"), "t.db"));
  const at = "2026-11-04T10:00:00.000Z";
  await db.run(db.k.insertInto("opus_reviews").values({ repo: "app", number: 1, head_oid: "E", at, model: "opus", mode: "full", verdict: "take-fix", sure: 1, reason: "r", why: "needs a one-line fix", seen_at: at }));
  await db.run(db.k.insertInto("fixups").values({ repo: "app", number: 1, from_head: "E", to_head: "H", state: "pushed", attempt: 1, created_at: at }));
  await db.run(db.k.insertInto("patch_checks").values({ kind: "fixup", repo: "app", number: 1, subject: "E", patch_hash: "x", round: 1, verdict: "approve", reasons: "", problems: "[]", model: "m", created_at: at }));
  const c = { repo: "app", number: 1, head_oid: "H" };
  assert.ok(await carriedReview(db, c));
  assert.equal(await carriedReview(db, c, new Set(["app#1@E"])), null, "the earlier review has not read the discussion as it is now");
  await db.run(db.k.insertInto("opus_reviews").values({ repo: "app", number: 1, head_oid: "H", at, model: "carried", mode: "carried", verdict: "take", sure: 1, reason: "r" }));
  assert.equal(await carriedReview(db, c), null, "a head with a review is reviewed, not carried, again");
});

test("with no Task Runner, the carry step carries a review to our checked fix-up and the review step leaves the head alone", async () => {
  const { world } = await import("./world-db.ts");
  const { untakenTest } = await import("../src/runner/concurrency.ts");
  const { runCarry } = await import("../src/review/carry-step.ts");
  const { selectOpusCandidates } = await import("../src/review/opus-candidates.ts");
  const w = await (await world()).repo();
  try {
    const at = "2026-11-04T10:00:00.000Z";
    await (await (await w.pr(1)).review(1, { verdict: "take-fix" })).synced(1, "H");
    await w.db.run(w.db.k.updateTable("opus_reviews").set({ seen_at: at }).where("repo", "=", "app").where("number", "=", 1));
    await w.db.run(w.db.k.insertInto("fixups").values({ repo: "app", number: 1, from_head: "sha1", to_head: "H", state: "pushed", attempt: 1, created_at: at }));
    await w.db.run(w.db.k.insertInto("patch_checks").values({ kind: "fixup", repo: "app", number: 1, subject: "sha1", patch_hash: "x", round: 1, verdict: "approve", reasons: "", problems: "[]", model: "m", created_at: at }));
    const untaken = await untakenTest(w.db);
    assert.ok(await untaken({ step: "opus-review", repo: "app" }), "no Task Runner takes the review");
    assert.equal(await untaken({ step: "review-carry", repo: "app" }), null);
    assert.deepEqual((await w.prPlan(1)).actions.map((a) => a.kind).filter((k) => k === "review" || k === "carry"), ["carry"]);
    assert.deepEqual(await selectOpusCandidates(w.db, "app"), []);
    assert.equal(await runCarry(w.db, "app", () => {}), 1);
    assert.deepEqual(await w.db.all(w.db.k.selectFrom("opus_reviews").select(["head_oid", "verdict", "model"]).where("head_oid", "=", "H")), [{ head_oid: "H", verdict: "take", model: "carried" }]);
    assert.equal((await w.prPlan(1)).actions.some((a) => a.kind === "carry" || a.kind === "review"), false);
  } finally { w.close(); }
});
