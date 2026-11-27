// The liveness classifier: an open item is live when something will move it or a person has been asked; otherwise stuck.
import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, computeLiveness, refreshLiveness, storedLiveness, type ItemFlags, type PlanRowLike } from "../src/liveness.ts";
import { withConfig } from "../src/data/control/index.ts";
import { loadLivenessInputs } from "../src/data/planner/index.ts";
import { testDatabase } from "./test-db.ts";

const row = (o: Partial<PlanRowLike>): PlanRowLike => ({ kind: "pr", state: "opus-hold", itemState: "classified", phase: "Held", wait: null, waitKind: null, waitCode: null, actions: 0, since: "2026-11-01T00:00:00Z", ...o });
const none: ItemFlags = { question: false, started: true };
const cause = (o: Partial<PlanRowLike>, f: Partial<ItemFlags> = {}) => { const v = classify(row(o), { ...none, ...f }); return `${v.live ? "live" : "stuck"}:${v.cause}`; };

test("an item is live when work is due, a person is asked or the wait has an external clearing event", () => {
  assert.equal(cause({ actions: 1 }), "live:planned");
  assert.equal(cause({}, { question: true }), "live:question");
  assert.equal(cause({ state: "not-started", wait: "a maintainer to start it", waitKind: "person", waitCode: "not-started" }), "live:parked");
  assert.equal(cause({ state: "waiting-ci", wait: "CI or GitHub's mergeable state", waitKind: "system", waitCode: "ci" }), "live:external");
  assert.equal(cause({ state: "conflict", wait: "the author", waitKind: "contributor" }), "live:contributor");
  assert.equal(cause({ state: "backlog" }), "live:parked");
  assert.equal(cause({ state: "classified", wait: "Implement is off for app", waitKind: "system", waitCode: "implement-off" }), "live:external");
  assert.equal(cause({ state: "ready", wait: "merge approval for the repo", waitKind: "person", waitCode: "repo-approval" }), "live:parked");
  assert.equal(cause({ state: "ready", wait: "the circuit breaker of merge to be resumed", waitKind: "person", waitCode: "breaker" }), "live:external");
  assert.equal(cause({ state: "changes-requested", wait: "the maintainer's review", waitKind: "person", waitCode: "changes-requested" }), "live:external");
});

test("an item nobody will move or answer is stuck", () => {
  assert.equal(cause({}), "stuck:no-plan");
  assert.equal(cause({ state: "needs-decision", wait: "a maintainer's answer", waitKind: "person", waitCode: "answer" }), "stuck:person-wait-without-question");
  assert.equal(cause({ state: "not-reviewed", wait: "the label referee", waitKind: "system", waitCode: "triage" }), "stuck:internal-wait");
  assert.equal(cause({ state: "needs-decision", wait: "a maintainer's answer", waitKind: "person", waitCode: "answer" }, { question: true }), "live:question");
});

test("a PR nobody started waits for someone to pick it up; a started one that asks nobody is stuck", async () => {
  const t = await testDatabase();
  const db = await t.open({ app: true });
  try {
    const T = "2026-01-01T00:00:00Z";
    const answer = { wait: "a maintainer's answer", waitKind: "person", waitCode: "answer" };
    const rows: [number, "pr" | "issue", string, { wait: string | null; waitKind: string | null; waitCode: string | null }][] = [
      // Nobody started these three.
      [1, "pr", "opus-hold", answer], [2, "pr", "needs-decision", answer], [3, "pr", "opus-close", { wait: null, waitKind: null, waitCode: null }],
      // Nobody started it, but nothing says what it waits on.
      [4, "pr", "ready", { wait: null, waitKind: null, waitCode: null }],
      // Started, with nobody asked.
      [5, "pr", "opus-hold", answer],
      // The implementation PRs of issue #8, whose workflow recommends, and of #9, which runs.
      [6, "pr", "opus-hold", answer], [7, "pr", "opus-hold", answer],
    ];
    for (const [number, kind, state, w] of rows) {
      await db.run(db.k.insertInto("items").values({ repo: "app", number, kind, state: "OPEN", title: `t${number}`, created_at: T }));
      await db.run(db.k.insertInto("item_plans").values({ repo: "app", number, kind, state, actions: "[]", wait: w.wait, reasons: "[]", planned_at: T, view: JSON.stringify({ status: { phase: "Held", since: T }, waitKind: w.waitKind, waitCode: w.waitCode }) }));
    }
    const wf = { repo: "app", started_by: "x", started_at: T, started_via: "github", updated_at: T };
    await db.run(db.k.insertInto("item_workflows").values([
      { ...wf, number: 5, kind: "pr", entry: "review", state: "running" },
      { ...wf, number: 8, kind: "issue", entry: "implement", state: "recommending" }, { ...wf, number: 9, kind: "issue", entry: "implement", state: "running" },
    ]));
    for (const [number, pr_number] of [[8, 6], [9, 7]] as const) await db.run(db.k.insertInto("implementations").values({ repo: "app", number, pr_number, state: "pr-opened", text_hash: "h", attempt: 1, created_at: T, updated_at: T, queued_by: "x" }));
    const res = await withConfig(db, () => computeLiveness(db, Date.parse(T) + 60_000));
    assert.deepEqual(res.items.map((i) => `${i.number} ${i.verdict} ${i.cause}`).sort(), ["4 stuck no-plan", "5 stuck person-wait-without-question", "7 stuck person-wait-without-question"]);
  } finally { await t.close(); }
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
    const kinds = new Map<number, string>([[1, "pr"], [2, "pr"], [3, "pr"], [4, "issue"], [5, "pr"], [6, "pr"], [7, "issue"], [8, "pr"], [9, "pr"], [10, "pr"]]);
    for (const [number, kind] of kinds) {
      await db.run(db.k.insertInto("items").values({ repo: "app", number, kind, state: number === 6 ? "CLOSED" : "OPEN", title: `t${number}`, created_at: T }));
    }
    const plan = (number: number, state: string, wait: string | null, actions = "[]", phase?: string, waitCode?: string) => db.run(db.k.insertInto("item_plans").values({
      repo: "app", number, kind: kinds.get(number)!, state, actions, wait, reasons: "[]", planned_at: T,
      ...(phase ? { view: JSON.stringify({ status: { phase, since: T }, waitKind: waitCode ? "system" : "person", waitCode }) } : {}),
    }));
    await plan(1, "needs-decision", "a maintainer's answer");
    await plan(2, "needs-decision", "a maintainer's answer");
    await plan(3, "needs-decision", "a maintainer's answer");
    await plan(4, "classified", "an open request for a person to pick up", "[]", "Triage", "open-request");
    await plan(5, "ready", "a maintainer's answer", '[{"kind":"merge"}]');
    await plan(6, "ready", null);
    await plan(7, "merged", null, "[]", "Merged");
    await plan(8, "ready", null);
    await plan(9, "ready", null, '[{"kind":"merge","refused":"breaker"},{"kind":"unassign","head":null,"refused":"scope"}]');
    await plan(10, "ready", null, '[{"kind":"label","refused":"repo-approval"},{"kind":"merge","params":{"note":"\\"refused\\": no"}}]');
    await db.run(db.k.insertInto("item_workflows").values({ repo: "app", number: 1, kind: "pr", entry: "review", state: "recommending", started_by: "x", started_at: T, started_via: "github", updated_at: T }));
    const inputs = await loadLivenessInputs(db);
    assert.deepEqual([...inputs.asked], ["app#1"]);

    const live = await withConfig(db, () => computeLiveness(db, Date.parse(T) + 60_000));
    assert.equal(live.open, 8, "closed items and items of an ended phase are not checked");
    assert.deepEqual(live.items.map((i) => `${i.repo}#${i.number} ${i.verdict} ${i.cause}`), ["app#8 stuck no-plan", "app#9 stuck no-plan"], "an action that is refused moves nothing");
    const later = await withConfig(db, () => computeLiveness(db, Date.parse(T) + 8 * 86_400_000));
    assert.deepEqual(later.items.map((i) => `${i.number} ${i.verdict} ${i.cause}`), ["8 stuck no-plan", "9 stuck no-plan", "2 long external", "3 long external", "5 long planned", "10 long planned"]);

    assert.equal(await withConfig(db, () => refreshLiveness(db, Date.parse(T) + 8 * 86_400_000)), true);
    const stored = (await storedLiveness(db))!;
    assert.deepEqual(stored.items, later.items);
    assert.equal(stored.open, 8);
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
    await db.run(db.k.insertInto("item_plans").values({ repo: "app", number: 1, kind: "issue", state: "classified", actions: "[]", wait: "open PR #2", reasons: "[]", planned_at: T, view: JSON.stringify({ waitKind: "system", waitCode: "open-pr" }) }));
    await db.run(db.k.insertInto("item_plans").values({ repo: "app", number: 2, kind: "pr", state: "review-stale", actions: "[]", wait: "CI on the latest commit to pass", reasons: "[]", planned_at: T }));
    const res = await withConfig(db, () => computeLiveness(db, Date.parse(T) + 8 * 86_400_000));
    assert.deepEqual(res.items.map((i) => `${i.number} ${i.verdict}`), ["2 long"]);
  } finally { await t.close(); }
});
