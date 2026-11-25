// The liveness classifier: an open item is live when something will move it or a person has been asked; otherwise stuck.
import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, computeLiveness, flagSets, refreshLiveness, storedLiveness, type ItemFlags, type PlanRowLike } from "../src/liveness.ts";
import { fixStoppedWait } from "../src/core/decide-item.ts";
import { testDatabase } from "./test-db.ts";

const row = (o: Partial<PlanRowLike>): PlanRowLike => ({ kind: "pr", state: "opus-hold", itemState: "classified", phase: "Held", wait: null, waitKind: null, actions: 0, since: "2026-11-01T00:00:00Z", ...o });
const none: ItemFlags = { question: false, dispute: false, stopped: false };
const cause = (o: Partial<PlanRowLike>, f: Partial<ItemFlags> = {}) => { const v = classify(row(o), { ...none, ...f }); return `${v.live ? "live" : "stuck"}:${v.cause}`; };

test("an item is live when work is due, a person is asked or the wait has an external clearing event", () => {
  assert.equal(cause({ actions: 1 }), "live:planned");
  assert.equal(cause({}, { question: true }), "live:question");
  assert.equal(cause({}, { dispute: true }), "live:dispute");
  assert.equal(cause({}, { stopped: true }), "live:stopped");
  assert.equal(cause({}, { answered: true }), "live:answered");
  assert.equal(cause({ state: "waiting-ci", wait: "CI or GitHub's mergeable state", waitKind: "system" }), "live:external");
  assert.equal(cause({ state: "conflict", wait: "the author", waitKind: "contributor" }), "live:contributor");
  assert.equal(cause({ state: "backlog" }), "live:parked");
  assert.equal(cause({ state: "classified", wait: "Implement is off for app", waitKind: "system" }), "live:external");
  assert.equal(cause({ state: "ready", wait: "merge held by an operator", waitKind: "person" }), "live:parked");
});

test("an item nobody will move or answer is stuck", () => {
  assert.equal(cause({}), "stuck:no-plan");
  assert.equal(cause({ state: "needs-decision", wait: "an operator's Merge? answer", waitKind: "person" }), "stuck:person-wait-without-question");
  assert.equal(cause({ state: "duplicate", wait: "a Duplicate? answer", waitKind: "person" }), "stuck:duplicate-without-question");
  assert.equal(cause({ state: "not-reviewed", wait: "the label referee", waitKind: "system" }), "stuck:internal-wait");
  assert.equal(cause({ state: "needs-decision", wait: "an operator's Merge? answer", waitKind: "person" }, { question: true }), "live:question");
});

test("a review wait names its blockers, whose questions keep the item live", async () => {
  const { blockersOfWait } = await import("../src/review/blockers.ts");
  assert.deepEqual(blockersOfWait("deckcraft#1424, deckcraft#990, which blocks its review"), ["deckcraft#1424", "deckcraft#990"]);
  assert.deepEqual(blockersOfWait("CI on the latest commit to pass"), []);
  assert.deepEqual(blockersOfWait(null), []);
});

test("the stored plans give each open item's flags and verdict; a refresh stores the result and reads it back in order", async () => {
  const t = await testDatabase();
  const db = await t.open({ app: true });
  try {
    const T = "2026-01-01T00:00:00Z";
    const kinds = new Map<number, string>([[1, "pr"], [2, "pr"], [3, "pr"], [4, "issue"], [5, "pr"], [6, "pr"], [7, "issue"], [8, "pr"]]);
    for (const [number, kind] of kinds) {
      await db.run(db.k.insertInto("items").values({ repo: "app", number, kind, state: number === 6 ? "CLOSED" : "OPEN", title: `t${number}`, created_at: T }));
    }
    const plan = (number: number, state: string, wait: string | null, actions = "[]", phase?: string) => db.run(db.k.insertInto("item_plans").values({
      repo: "app", number, kind: kinds.get(number)!, state, actions, wait, reasons: "[]", planned_at: T,
      ...(phase ? { view: JSON.stringify({ status: { phase, since: T }, waitKind: "person" }) } : {}),
    }));
    await plan(1, "needs-decision", "an operator's Merge? answer");
    await plan(2, "needs-decision", "an operator's Merge? answer");
    await plan(3, "needs-decision", "an operator's Merge? answer");
    await plan(4, "classified", fixStoppedWait("failed"));
    await plan(5, "ready", "an operator's Merge? answer", '[{"kind":"merge"}]');
    await plan(6, "ready", null);
    await plan(7, "merged", null, "[]", "Merged");
    await plan(8, "ready", null);
    const decision = (id: string, number: number | null, o: { answer?: string; exec_state?: string } = {}) => db.run(db.k.insertInto("decisions")
      .values({ id, kind: "merge", repo: "app", number, asked_at: T, asked_by: "x", question: "q", options: "[]", answer: o.answer ?? null, exec_state: o.exec_state ?? null }));
    await decision("asked", 1);
    await decision("answered", null, { answer: "yes" });
    await db.run(db.k.insertInto("decision_items").values({ repo: "app", number: 2, decision_id: "answered" }));
    await decision("disputed", 3, { answer: "yes", exec_state: "disputed" });
    const flags = await flagSets(db);
    assert.deepEqual([...flags.question], ["app#1"]);
    assert.deepEqual([...flags.answered], ["app#2"]);
    assert.deepEqual([...flags.dispute], ["app#3"]);
    assert.deepEqual([...flags.stopped], ["app#4"]);

    const live = await computeLiveness(db, Date.parse(T) + 60_000);
    assert.equal(live.open, 6, "closed items and items of an ended phase are not checked");
    assert.deepEqual(live.items.map((i) => `${i.repo}#${i.number} ${i.verdict} ${i.cause}`), ["app#8 stuck no-plan"]);
    const later = await computeLiveness(db, Date.parse(T) + 8 * 86_400_000);
    assert.deepEqual(later.items.map((i) => `${i.number} ${i.verdict} ${i.cause}`), ["8 stuck no-plan", "2 long answered", "5 long planned"]);

    assert.equal(await refreshLiveness(db, Date.parse(T) + 8 * 86_400_000), true);
    const stored = (await storedLiveness(db))!;
    assert.deepEqual(stored.items, later.items);
    assert.equal(stored.open, 6);
  } finally {
    await t.close();
  }
});

test("an issue waiting on an open PR is not long; the PR it waits on is", async () => {
  const t = await testDatabase();
  const db = await t.open({ app: true });
  try {
    const T = "2026-01-01T00:00:00Z";
    for (const [number, kind] of [[1, "issue"], [2, "pr"]] as const) {
      await db.run(db.k.insertInto("items").values({ repo: "app", number, kind, state: "OPEN", title: `t${number}`, created_at: T }));
    }
    await db.run(db.k.insertInto("item_plans").values({ repo: "app", number: 1, kind: "issue", state: "classified", actions: "[]", wait: "open PR #2", reasons: "[]", planned_at: T }));
    await db.run(db.k.insertInto("item_plans").values({ repo: "app", number: 2, kind: "pr", state: "review-stale", actions: "[]", wait: "CI on the latest commit to pass", reasons: "[]", planned_at: T }));
    const res = await computeLiveness(db, Date.parse(T) + 8 * 86_400_000);
    assert.deepEqual(res.items.map((i) => `${i.number} ${i.verdict}`), ["2 long"]);
  } finally { await t.close(); }
});
