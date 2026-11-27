// What a lane proposes and what its step selects are the planned actions that may run, for PRs of every state (test/random-pr.ts).
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { decidePr } from "../src/core/decide.ts";
import type { PrFacts } from "../src/core/plan.ts";
import type { PlanSet } from "../src/core/plan-set.ts";
import { planned } from "../src/core/select.ts";
import { plannedItems } from "../src/core/select-items.ts";
import { selectCifix } from "../src/cifix/select.ts";
import { runFixup, type FixupDeps } from "../src/fixup/index.ts";
import { selectFixups } from "../src/fixup/select.ts";
import { runBatches } from "../src/merge/batch.ts";
import { runUnassign } from "../src/unassign/index.ts";
import { resumeTrips } from "../src/data/control/index.ts";
import { setApproval } from "../src/labels/approval.ts";
import { detectAutopilot, LANE_KINDS, LANES, planDue, type PlanCtx } from "../src/runner/autopilot.ts";
import { factsOf, prng, randomPrRows, rnd } from "./random-pr.ts";
import { reportingTaskRunner } from "./fake-runner.ts";
import { SCRATCH } from "./scratch.ts";
import { T0, world, type World } from "./world-db.ts";

const CASES = 400;
const lane = (name: string) => LANES.find((l) => l.name === name)!;
const ctxOf = (f: PrFacts, refuse = false): PlanCtx & { plans: PlanSet } => {
  const p = decidePr(f);
  const plan = refuse ? { ...p, actions: p.actions.map((a) => ({ ...a, permission: { ok: false as const, why: { code: "blocked" as const, who: "person" as const, text: "It is blocked" } } })) } : p;
  return { run: "r1", tracked: ["app"], wake: [], plans: { run: "r1", now: f.now, pass: { rereadPaceAt: 0 }, prs: [{ facts: f, plan }], items: [] } };
};

describe("a lane proposes a job exactly when its step has something it may work", async () => {
  const w = await (await world()).repo();
  after(() => w.close());
  const seed = Date.now() & 0x7fffffff, x = rnd(prng(seed));
  const cases = Array.from({ length: CASES }, () => factsOf(randomPrRows(x)));
  const proposes = async (name: string, ctx: PlanCtx) => (await lane(name).detect(w.db, ctx)).length > 0;
  // Stored patches are rows the random facts have none of in the database.
  const noLint = (f: PrFacts): PrFacts => ({ ...f, lint: [] });

  test("over random pull requests", async () => {
    for (const [i, f0] of cases.entries()) {
      const f = noLint(f0), ctx = ctxOf(f), { plans } = ctx, at = `seed ${seed} case ${i}`;
      const ci = await selectCifix(w.db, "app", "r1", plans, "pipeline");
      assert.equal(await proposes("cifix", ctx), [ci.work, ci.collect, ci.ask, ci.capped].some((l) => l.length > 0), `cifix, ${at}`);
      assert.equal(await proposes("cifix-rerun", ctx), ci.rerun.length > 0, `cifix-rerun, ${at}`);
      const fx = await selectFixups(w.db, "app", "r1", plans, "pipeline");
      assert.equal(await proposes("fixup", ctx), [fx.fix, fx.ask, fx.conflictMerge, fx.conflictAsk].some((l) => l.length > 0), `fixup, ${at}`);
      for (const name of ["review-carry", "review-post", "premerge"]) {
        assert.equal(await proposes(name, ctx), (await planned(w.db, LANE_KINDS[name]![0]!, { plans })).length > 0, `${name}, ${at}`);
      }
    }
  });

  test("a refused action is neither proposed nor selected, for the pipeline or a person", async () => {
    for (const f0 of cases) {
      const ctx = ctxOf(noLint(f0), true), { plans } = ctx;
      for (const name of ["review", "review-carry", "review-post", "premerge", "verify", "merge", "fixup", "cifix", "cifix-rerun", "ci-approve", "unassign", "implement"]) {
        // A wait for CI is polled whatever may run.
        assert.deepEqual((await lane(name).detect(w.db, ctx)).filter((c) => c.step !== "checks"), [], name);
      }
      for (const a of plans.prs[0]!.plan.actions) assert.deepEqual(await planned(w.db, a.kind, { plans, by: { operator: "op" } }), [], a.kind);
      for (const sel of [await selectCifix(w.db, "app", "r1", plans), await selectFixups(w.db, "app", "r1", plans)]) assert.ok(Object.values(sel).every((l) => l.length === 0));
    }
  });
});

const trip = async (w: World, stage: string) =>
  void await w.db.run(w.db.k.insertInto("stage_trips").values({ stage, reason: "2 of the last 10 pushes broke a required check", evidence: "[]", tripped_at: T0, active: 1 }));
const proposed = async (w: World, name: string) => (await detectAutopilot(w.db, { lanes: [lane(name)] })).proposals.map((p) => p.step);
const numbers = (l: { number: number }[]) => l.map((c) => c.number);

describe("a tripped stage pushes and merges nothing and still does what writes no commit", () => {
  for (const key of ["fixup", "fixup:app"]) test(`${key}: the contributor of a closed branch is asked, and a stored patch is kept`, async () => {
    const w = await (await (await (await (await world()).repo()).pr(1)).review(1, { verdict: "take-fix" })).pr(2);
    try {
      await w.review(2, { verdict: "take-fix" });
      await reportingTaskRunner(w.db);
      assert.deepEqual(await proposed(w, "fixup"), ["fixup", "fixup"], "one job per PR");
      await trip(w, key);
      assert.deepEqual(await proposed(w, "fixup"), []);
      await w.db.run(w.db.k.insertInto("fixups").values({ repo: "app", number: 2, from_head: "sha2", state: "linting", attempt: 1, created_at: T0, patch: "+z\n", lint_round: 1, lint_state: "pending", source: "review" }));
      assert.deepEqual((await w.prPlan(2)).actions.filter((a) => a.kind === "lint").map((a) => a.permission?.ok), [false]);
      await (await w.pr(3, { canModify: false })).review(3, { verdict: "take-fix" });
      assert.deepEqual(await proposed(w, "fixup"), ["fixup"]);
      const sel = await selectFixups(w.db, "app");
      assert.deepEqual([numbers(sel.fix), numbers(sel.lint), numbers(sel.ask), sel.listed.length], [[], [], [3], 1]);
      await runFixup(w.db, { repo: "app", dryRun: false, limit: 0 }, () => {}, { now: () => new Date(), querier: w.gh.querier, root: SCRATCH } as unknown as FixupDeps);
      assert.equal((await w.rows("SELECT state FROM fixups WHERE number = 2"))[0]!.state, "linting");
      await planDue(w.db);
      assert.equal(await planDue(w.db), false);
      await resumeTrips(w.db, [key], "op");
      assert.ok(await planDue(w.db), "the resume lets the pushes go on");
      assert.ok(numbers((await selectFixups(w.db, "app")).fix).includes(1));
    } finally { w.close(); }
  });

  test("merge: an open batch is advanced, and no pull request is merged", async () => {
    const w = await (await (await (await (await (await world()).repo()).pr(1)).review(1)).verified(1)).premerge(1, "clean");
    try {
      const due = async () => (await planned(w.db, "merge", { repo: "app" })).length;
      assert.equal(await due(), 1);
      await trip(w, "merge:app");
      assert.equal(await due(), 0);
      assert.deepEqual(await proposed(w, "merge"), []);
      await w.db.run(w.db.k.insertInto("merge_batches").values({ id: 5, repo: "app", branch: "integration-app-1", state: "open", base_sha: "b", commit_sha: "t", pr_number: 50, created_at: T0, updated_at: T0 }));
      assert.deepEqual(await proposed(w, "merge"), ["merge"]);
    } finally { w.close(); }
  });
});

test("a label in a repo not approved for labels is neither proposed nor selected", async () => {
  const w = await (await (await world()).repo()).issue(1, { label: "bugfix" });
  try {
    const due = async () => [(await plannedItems(w.db, "label", { repo: "app" })).length, (await proposed(w, "labels")).length];
    assert.deepEqual(await due(), [0, 0]);
    assert.equal((await plannedItems(w.db, "label", { repo: "app", refused: true })).length, 1, "it is planned");
    await setApproval(w.db, "op", "app", true);
    assert.deepEqual(await due(), [1, 1]);
  } finally { w.close(); }
});

test("once a Pipeline-off repo's last workflow ends, our assignment is released and its batch is closed; nothing else runs there", async () => {
  const w = await (await world()).repo();
  try {
    for (const n of [1, 2]) await (await (await (await w.pr(n)).review(n)).verified(n)).premerge(n, "clean");
    await runBatches(w.db, { repo: "app" }, () => {}, w.gh.batchDeps());
    const batch = async () => (await w.rows("SELECT state, pr_number FROM merge_batches ORDER BY id")).map((r) => [r.state, Number(r.pr_number)]);
    assert.deepEqual(await batch(), [["open", 900]]);
    for (const n of [1, 2]) await w.workflow(n, { approved: true });
    await w.db.run(w.db.k.insertInto("audit").values({ at: T0, login: "assign", action: "assign", target: "app#1", details: '{"assignee":"bot"}' }));
    await w.db.run(w.db.k.updateTable("items").set({ assignees: JSON.stringify(["bot"]) }).where("number", "=", 1));
    w.gh.live(1, { assignees: ["bot"] });
    await reportingTaskRunner(w.db);
    await w.db.run(w.db.k.updateTable("tracked_repos").set({ pipeline: 0 }).where("name", "=", "app"));
    const steps = async () => [...new Set((await detectAutopilot(w.db)).proposals.filter((p) => p.params.repo === "app").map((p) => p.step))].sort();
    assert.ok(!(await steps()).includes("unassign"), "the batch goes on for the started pull requests");
    await w.db.run(w.db.k.updateTable("item_workflows").set({ state: "stopped" }));
    assert.deepEqual(await steps(), ["merge", "unassign"]);
    const r = await runBatches(w.db, { repo: "app" }, () => {}, w.gh.batchDeps());
    assert.deepEqual([r.superseded.length, r.started, r.published, r.merged], [1, [], [], []]);
    assert.deepEqual(await batch(), [["superseded", 900]]);
    const said = String((await w.rows("SELECT details FROM audit WHERE action = 'batch-pr-close'"))[0]!.details);
    assert.ok(/pipeline is off, so #1, #2 wait until someone starts them/.test(said) && !/rebuilt/.test(said), said);
    assert.deepEqual((await runUnassign(w.db, { repo: "app", by: "pipeline", runId: "t", querier: w.gh.querier, exec: async () => ({ code: 0, stdout: JSON.stringify({ login: "bot", id: 9, node_id: "NB" }), stderr: "" }) })).unassigned, ["app#1"]);
    assert.deepEqual((await w.rows("SELECT action, target FROM audit WHERE action IN ('batch-pr-close', 'unassign', 'merge', 'batch-merge') ORDER BY action")).map((x) => `${x.action} ${x.target}`), ["batch-pr-close app#900", "unassign app#1"]);
    assert.ok(!(await steps()).includes("merge"));
  } finally { w.close(); }
});
