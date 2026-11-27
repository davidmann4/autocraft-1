// A PR the automatic merge rule took up and stopped for a person's judgement comes back with a recommendation that asks nobody: its
// state line says why it stopped and what AutoCraft would do, and whoever answers takes it over; a wait that clears by itself makes no question.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { decidePr } from "../src/core/decide.ts";
import { loadPrFact } from "../src/core/facts.ts";
import { loadStatusInputs } from "../src/data/views/prStatus.ts";
import { mergeMay } from "../src/core/gates.ts";
import { writePlanCache } from "../src/core/plan-cache.ts";
import { advancePreapprovals } from "../src/preapproval/index.ts";
import { advanceWorkflows } from "../src/workflow/advance.ts";
import { runCommand, type Actor } from "../src/workflow/apply.ts";
import { findAutoStops, startAutoStops } from "../src/workflow/auto-stop.ts";
import { parse } from "../src/workflow/parse.ts";
import { liveWorkflow } from "../src/workflow/store.ts";
import { askedLogins, openQuestion } from "../src/workflow/asked.ts";
import { stateLine } from "../src/workflow/status.ts";
import { RULE_STARTER } from "../src/workflow/types.ts";
import { expectFlat } from "./helpers/query-count.ts";
import { T0, untilQuiet, world, type World } from "./world-db.ts";

let current: World | undefined;
afterEach(() => current?.close());

const MAINT = "mira";
const actor: Actor = { login: MAINT, canWrite: async () => true };
const say = async (w: World, text: string) => (await runCommand(w.db, actor, "dashboard", { parsed: parse(text), items: [{ repo: "app", number: 1 }] })).items[0]!;
/** Starts what the rule's stops start, after the planner stored their plans. */
const sweep = async (w: World) => { await writePlanCache(w.db, await w.plan()); await advanceWorkflows(w.db); };
const states = async (w: World) => (await w.rows("SELECT state FROM item_workflows WHERE number = 1 ORDER BY id")).map((r) => r.state);
/** PR `n`, a small bug fix on the auto path, stopped at an unsure take whose recommendation is to merge it. */
async function unsure(w: World, n: number, head?: string): Promise<void> {
  if (head) await w.synced(n, head);
  else await w.pr(n);
  await w.db.run(w.db.k.insertInto("main.opus_reviews").values({
    repo: "app", number: n, head_oid: head ?? `sha${n}`, run_id: "rv", at: T0, model: "m", mode: "full", verdict: "take", sure: 0, reason: "r",
    workflow: JSON.stringify({ outside_purpose: null, recommendation: { text: "Merge it.", fix: [], merge: true, close: false } }),
  }));
  await (await w.verified(n)).premerge(n, "clean");
}
const rows = async (w: World, n: number) => (await w.rows(`SELECT id FROM item_workflows WHERE number = ${n}`)).length;

test("the automatic merge rule's unsure stop asks nobody and says why it stopped, the answer makes the merge the answerer's, and a CI wait asks nothing", async () => {
  const w = current = await (await (await world()).repo()).acting(MAINT);
  await w.db.run(w.db.k.updateTable("main.tracked_repos").set({ workflow: "new" }).where("name", "=", "app"));
  await unsure(w, 1);
  await (await (await (await w.pr(2, { ci: "pending" })).review(2)).verified(2)).premerge(2, "clean");
  const stops = async () => (await w.db.seqs())["auto-stops"] ?? 0;
  const before = await stops();
  await writePlanCache(w.db, await w.plan());
  assert.equal((await w.prPlan(1)).waitCode, "answer");
  assert.ok(await stops() > before, "storing the stop wakes the workflow pass");
  const stored = await stops();
  await writePlanCache(w.db, await w.plan());
  assert.equal(await stops(), stored, "the same plans again wake nothing");

  await advanceWorkflows(w.db);
  const wf = (await liveWorkflow(w.db, "app", 1))!;
  assert.deepEqual([wf.state, wf.startedBy, wf.approvedBy, wf.recHead], ["recommending", RULE_STARTER, null, "sha1"]);
  assert.equal(openQuestion(wf), null, "a rule row has no open question");
  assert.match(stateLine(wf), /^Stopped: the review is unsure\. .*Merge it\./, "the state line has the reason and the recommendation");
  assert.equal(await liveWorkflow(w.db, "app", 2), null, "a CI wait is no question");

  await advanceWorkflows(w.db);
  assert.equal(await rows(w, 1), 1, "one row per PR");

  assert.equal((await say(w, "yes")).outcome, "run");
  await untilQuiet(w.db, [() => advanceWorkflows(w.db), () => advancePreapprovals(w.db)], 8);
  const taken = (await liveWorkflow(w.db, "app", 1))!;
  assert.equal(taken.approvedBy, MAINT);
  assert.deepEqual(askedLogins(taken), [MAINT], "the answerer is asked from now on");
  const may = mergeMay((await loadPrFact(w.db, "app", 1))!);
  assert.ok(may?.ok && may.as === "person" && may.by === MAINT, JSON.stringify(may));

  assert.equal((await say(w, "hold")).outcome, "run");
  assert.deepEqual(await findAutoStops(w.db), [], "an ended workflow is not started again");
  await advanceWorkflows(w.db);
  assert.equal(await rows(w, 1), 1);
});

test("an answer on the rule's stop that does not approve the merge takes the row over: its questions go to the answerer", async () => {
  const w = current = await (await (await world()).repo()).acting(MAINT);
  await w.db.run(w.db.k.updateTable("main.tracked_repos").set({ workflow: "new" }).where("name", "=", "app"));
  await unsure(w, 1);
  await writePlanCache(w.db, await w.plan());
  await advanceWorkflows(w.db);
  assert.equal((await say(w, "review")).outcome, "run");
  const taken = (await liveWorkflow(w.db, "app", 1))!;
  assert.equal(taken.approvedBy, null, "the merge is not approved");
  assert.deepEqual(askedLogins(taken), [MAINT]);
  assert.doesNotMatch(stateLine(taken), /^Stopped/, "the rule's stop line is gone once a person took the row");
});

test("starting the rule's stops sends as many statements for many PRs as for one", async () => {
  await expectFlat(async (size) => {
    const w = await (await world()).repo();
    for (let n = 1; n <= size; n++) await unsure(w, n);
    await writePlanCache(w.db, await w.plan());
    return { db: w.db, run: async () => assert.equal(await startAutoStops(w.db), size), close: async () => w.close() };
  }, 1, 6);
});

test("an author push before anyone answers gives the PR back to the rule, which may ask again; with the pipeline off nothing starts", async () => {
  const w = current = await (await (await world()).repo()).acting(MAINT);
  await unsure(w, 1);
  await w.pipeline(false);
  await sweep(w);
  assert.deepEqual(await states(w), [], "the pipeline is off");
  await w.pipeline(true);
  await sweep(w);
  assert.deepEqual(await states(w), ["recommending"]);
  const commented = async () => (await loadStatusInputs(w.db, ["app"])).get("app")!.started.has(1);
  assert.equal(await commented(), true);

  await w.synced(1, "sha1b");
  await advanceWorkflows(w.db);
  assert.deepEqual(await states(w), ["superseded"]);
  assert.equal(await commented(), false, "its status comment is the rule's again");
  await (await (await w.review(1, { head: "sha1b" })).verified(1)).premerge(1, "clean");
  assert.equal(decidePr((await loadPrFact(w.db, "app", 1))!).path, "rule", "a sure take at the new head merges by the rule");

  await unsure(w, 1, "sha1c");
  await sweep(w);
  assert.deepEqual(await states(w), ["superseded", "recommending"], "a new stop asks again");
  assert.equal((await say(w, "hold")).outcome, "run");
  await w.synced(1, "sha1d");
  await sweep(w);
  assert.deepEqual(await states(w), ["superseded", "stopped"], "after a person ended it, the rule asks no more");
});

test("the rule's stop at a pre-merge defect fixes it before any merge, and once that stop goes at the same head the rule takes the PR back", async () => {
  const w = current = await (await (await world()).repo()).acting(MAINT);
  await (await (await w.pr(1)).review(1)).verified(1);
  await w.premerge(1, "defect", false);
  await w.premergeRoundsSpent(1);
  await sweep(w);
  const wf = (await liveWorkflow(w.db, "app", 1))!;
  const fix = wf.rec?.parts.fix ?? [];
  assert.equal(wf.state, "recommending");
  assert.ok(fix.length && wf.plan.some((p) => fix.includes(p.n) && p.major), `a yes fixes the defect first: ${wf.rec?.text}`);

  const ci = async (overall: "failure" | "success") => w.db.prepare("UPDATE pr_checks SET overall = ?, checks = ? WHERE repo = 'app' AND number = 1")
    .run(overall, overall === "failure" ? JSON.stringify([{ name: "build", state: "failure" }]) : "[]");
  await ci("failure");
  await advanceWorkflows(w.db);
  const red = (await liveWorkflow(w.db, "app", 1))!;
  assert.deepEqual([red.id, red.state, red.rec?.text], [wf.id, "recommending", wf.rec?.text], "red CI at the same head leaves the question as it is");

  await ci("success");
  await w.premerge(1, "clean");
  await advanceWorkflows(w.db);
  assert.deepEqual(await states(w), ["superseded"], "the stop went at the head it was made at");
});
