// The status line of an item: GitHub state first, then the phase map, and `since` moving only when phase or wait changes.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { phaseOf, statusFromItem, statusOf, type StatusInput } from "../src/core/item-status.ts";
import { writePlanCache, type PlanView } from "../src/core/plan-cache.ts";
import { loadPlanSet } from "../src/core/plan-set.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

const input = (p: Partial<StatusInput>): StatusInput => ({ state: null, itemState: null, wait: null, next: null, ...p });

describe("item status", () => {
  test("phase map", () => {
    assert.equal(phaseOf(input({ gh: "MERGED", state: "needs-decision" })), "Merged", "GitHub state wins");
    assert.equal(phaseOf(input({ gh: "CLOSED", state: "ready" })), "Closed");
    assert.equal(phaseOf(input({ state: "needs-decision" })), "Waiting for a person");
    assert.equal(phaseOf(input({ state: "not-reviewed" })), "Review");
    assert.equal(phaseOf(input({ state: "review-stale", reviewBlocked: true })), "Held");
    assert.equal(phaseOf(input({ state: "opus-hold", reviewBlocked: true })), "Held", "a hold blocked by other items is parked");
    assert.equal(phaseOf(input({ state: "opus-hold" })), "Held", "a hold review waits for the author's changes");
    assert.equal(phaseOf(input({ state: "out-of-scope" })), "Pipeline off");
    assert.equal(phaseOf(input({ itemState: "classified", inPipeline: false })), "Pipeline off", "an issue in a repo with the pipeline off");
    assert.equal(phaseOf(input({ gh: "MERGED", inPipeline: false })), "Merged");
    assert.deepEqual(statusOf(input({ state: "out-of-scope", wait: "not in scope", next: "Classify" })), { phase: "Pipeline off", waiting: null, next: null });
    assert.deepEqual(statusOf(input({ state: "out-of-scope", inPipeline: false, held: true, wait: "x" })), { phase: "Held", waiting: null, next: null }, "a held item");
    assert.equal(phaseOf(input({ state: "opus-close" })), "Out of scope");
    assert.equal(phaseOf(input({ state: "ci-failed" })), "Fixing");
    assert.equal(phaseOf(input({ state: "waiting-verify" })), "Verifying");
    assert.equal(phaseOf(input({ state: "waiting-ci" })), "In queue");
    // Typed waits decide the phase, not the wording.
    assert.equal(phaseOf(input({ state: "needs-fix-up", wait: "push approval for the repo", waitKind: "person" })), "Waiting for a person");
    assert.equal(phaseOf(input({ state: "waiting-ci", wait: "merge approval for the repo", waitKind: "person" })), "Waiting for a person");
    assert.equal(phaseOf(input({ state: "needs-fix-up", wait: "the contributor's fixes", waitKind: "contributor" })), "Held");
    assert.equal(phaseOf(input({ state: "needs-fix-up", wait: "the review's fixes to be applied", waitKind: "system" })), "Fixing");
    assert.equal(phaseOf(input({ state: "waiting-ci", wait: "an answer-like CI wording", waitKind: "system" })), "In queue", "a typed system wait ignores the wording");
    assert.equal(phaseOf(input({ state: "not-reviewed", itemState: "held-backlog" })), "Held", "a triage hold beats the PR state");
    assert.equal(phaseOf(input({ itemState: "classified", next: "Fix: in progress" })), "Fixing");
    assert.equal(phaseOf(input({ itemState: "classified", next: "Fix" })), "Triage");
    assert.deepEqual(statusFromItem({ merged_at: "x" }, "t"), { phase: "Merged", waiting: null, next: null, since: "t" });
    assert.equal(statusFromItem({ closed_at: "x" }, "t").phase, "Closed");
    assert.equal(statusFromItem({}, "t").phase, "Triage");
  });

  test("since is carried while phase and wait stay, and resets when the wait changes", async () => {
    mkdirSync(SCRATCH, { recursive: true });
    const db = await connectDb(join(mkdtempSync(join(SCRATCH, "item-status-")), "t.db"));
    await db.run(db.k.insertInto("tracked_repos").values({ name: "app", pipeline: 1 }));
    await db.run(db.k.insertInto("items").values({ repo: "app", number: 1, kind: "issue", state: "OPEN", title: "t", body: "b", is_draft: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }));
    const view = async () => (await db.get(db.k.selectFrom("item_plans").select("view").where("number", "=", 1)))!.view;
    const status = async () => (JSON.parse(await view()) as PlanView).status;
    const write = async (at: string) => await writePlanCache(db, await loadPlanSet(db), at);
    await write("2026-01-02T00:00:00Z");
    assert.equal((await status()).since, "2026-01-02T00:00:00Z");
    assert.deepEqual(await write("2026-01-03T00:00:00Z"), { written: 0, deleted: 0 }, "an identical pass writes nothing");
    assert.equal((await status()).since, "2026-01-02T00:00:00Z");
    // A stored status with another wait stands in for a wait that changed.
    const v = JSON.parse(await view()) as PlanView;
    v.status.waiting = "something else";
    await db.run(db.k.updateTable("item_plans").set({ view: JSON.stringify(v) }).where("number", "=", 1));
    await write("2026-01-05T00:00:00Z");
    assert.equal((await status()).since, "2026-01-05T00:00:00Z", "a changed wait resets since");
  });
});
