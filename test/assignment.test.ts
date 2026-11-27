// The assignment rule: a stage assigns AutoCraft's account when its work starts; the planner unassigns it once the item is off
// the path to merge. Decision rows for PRs and issues, then the helper and the step against a fake GitHub.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decideItem } from "../src/core/decide-item.ts";
import { decidePr } from "../src/core/decide.ts";
import { guardRepo } from "../src/core/guard.ts";
import type { AssignFacts } from "../src/core/plan.ts";
import { claimForWork } from "../src/github/claim.ts";
import { setFeature } from "../src/build/features.ts";
import { runUnassign } from "../src/unassign/index.ts";
import { insertWorkflow } from "../src/workflow/store.ts";
import { world } from "./world-db.ts";
import { itemFacts, prFacts } from "./world.ts";

const ours: AssignFacts = { login: "bot", assignees: ["bot"], ours: true };
const unassigns = (a: { actions: { kind: string }[] }) => a.actions.some((x) => x.kind === "unassign");
const spent = { fixes: 2, attempts: 99, recorded: [] as string[] };

// The pipeline account as `gh api user` reports it.
const asPipelineBot = async () => ({ code: 0, stdout: JSON.stringify({ login: "pipeline-bot", id: 9, node_id: "NB" }), stderr: "" });

test("a PR is unassigned only when we are the sole assignee and made the assignment", () => {
  const plan = (assignment: AssignFacts) => decidePr(prFacts({ size: "L", lines: 900, assignment }));
  assert.equal(plan(ours).state, "needs-decision");
  assert.equal(unassigns(plan(ours)), true);
  assert.equal(unassigns(plan({ login: "bot", assignees: ["bot", "alice"], ours: true })), false);
  assert.equal(unassigns(plan({ login: "bot", assignees: ["bot"], ours: false })), false);
  assert.equal(unassigns(decidePr(prFacts({ ghState: "MERGED", assignment: ours }))), false);
});

test("a PR on the path to merge keeps the assignment, one that left it loses it", () => {
  assert.equal(unassigns(decidePr(prFacts({ assignment: ours }))), false, "ready, merge due");
  assert.equal(unassigns(decidePr(prFacts({ review: null, draft: true, assignment: ours }))), true, "draft");
  assert.equal(unassigns(decidePr(prFacts({ inScope: false, assignment: ours }))), true, "out of scope");
  const pushed = decidePr(prFacts({ head: "h2", assignment: ours }));
  assert.ok(pushed.actions.some((a) => a.kind === "review"));
  assert.equal(unassigns(pushed), false, "the contributor pushed: the new head's review is due");
  const held = { mergeable: "CONFLICTING", conflict: { bucket: "held", base: "main", baseOk: true } };
  assert.equal(unassigns(decidePr(prFacts({ ...held, assignment: ours }))), true, "conflict held");
  assert.equal(unassigns(decidePr(prFacts({ ...held, conflict: { bucket: "merge", base: "main", baseOk: true }, assignment: ours }))), false, "conflict merge due");
});

test("a fix-up that gave up asks the contributor, then releases the PR, unless it is in a batch; on a PR approved for merge it asks the approver at once", () => {
  const approved = { review: { verdict: "take-fix" }, fixup: spent, assignment: ours };
  assert.equal(unassigns(decidePr(prFacts(approved))), true, "approver asked");
  const f = { ...approved, workflow: { entry: "fixup", approved: false, startedBy: "maint", startedAt: "2026-11-04T09:00:00.000Z", own: true } as const };
  assert.equal(unassigns(decidePr(prFacts(f))), false, "ask due");
  const asked = { ...f, fixup: { ...spent, recorded: ["asked"] } };
  assert.equal(unassigns(decidePr(prFacts(asked))), true, "asked");
  assert.equal(unassigns(decidePr(prFacts({ ...f, repoFacts: { commentApproved: false } }))), true, "no comment approval");
  assert.equal(unassigns(decidePr(prFacts({ ...asked, inActiveBatch: true }))), false);
});

test("a take-fix PR with a conflict give-up, an ended CI fix and CI runs a maintainer approves are released; a refused merge is kept", () => {
  const held = { mergeable: "CONFLICTING", conflict: { bucket: "held", base: "main", baseOk: true } };
  assert.equal(unassigns(decidePr(prFacts({ review: { verdict: "take-fix" }, fixup: { fixes: 0, attempts: 0, recorded: [] as string[] }, ...held, assignment: ours }))), true, "conflict held, take-fix");
  // `askedPatch`: the asked row is a posted patch, which ends the CI fix on a PR approved for merge (a plain ask to the contributor does not).
  const cifix = (states: string[]) => ({ ci: "failure", cifix: { states, tries: 0, rerunAt: null, infraRuns: null, formattingTask: null, formatterEnded: true, totalPushes: 0, totalTries: 0, checksAt: null, askedPatch: true }, assignment: ours });
  assert.equal(unassigns(decidePr(prFacts(cifix(["asked"])))), true, "CI fix ended without a push");
  assert.equal(unassigns(decidePr(prFacts(cifix([])))), false, "CI fix due");
  assert.equal(unassigns(decidePr(prFacts({ runs: { waiting: 1, reread: false, crossRepo: true, approvable: 1 }, repoFacts: { ciApproved: false }, assignment: ours }))), true, "CI runs wait for a maintainer");
  assert.equal(unassigns(decidePr(prFacts({ lastMerge: { outcome: "refused", reason: "x", ci: "pending", mergeable: "MERGEABLE" }, assignment: ours }))), false, "refused merge retried");
});

test("an issue is unassigned when its implementation waits on a person, kept while it runs, and never assigned by the planner", async () => {
  const queued = (state: string) => ({ queuedBy: "op", standing: "yes" as const, featureOn: true, liveInRepo: 0,
    row: { state, attempt: 1, textChanged: false, newCommentAfterQuestion: false, decisionAnswered: false, requeuedAfterEnd: false, asked: null, prOpen: false } });
  assert.equal(unassigns(decideItem(itemFacts({ assignment: ours, implement: queued("stuck") }))), true);
  assert.equal(unassigns(decideItem(itemFacts({ assignment: ours, implement: queued("implementing") }))), false);
  assert.equal(unassigns(decideItem(itemFacts({ assignment: { login: "bot", assignees: ["bot", "alice"], ours: true }, implement: queued("stuck") }))), false);
  // An issue whose implement workflow an operator started is planned for Implement once the repo's switch is on; it is not assigned: only a stage starting work does that.
  const w = await (await (await (await world()).repo()).acting()).issue(5, { impact: "P2" });
  await insertWorkflow(w.db, { repo: "app", number: 5, kind: "issue", entry: "implement", state: "running", startedBy: "op", startedAt: "2026-11-04T08:00:00.000Z", startedVia: "dashboard" });
  const plan = async () => (await w.plan()).items.find((i) => i.facts.number === 5)!.plan;
  const implement = async () => (await plan()).actions.filter((a) => a.kind === "implement" || a.kind === "unassign").map((a) => [a.kind, a.params?.bucket]);
  assert.deepEqual(await implement(), [], "Implement off: nothing is planned");
  await setFeature(w.db, "implement", true, "op", "app");
  assert.deepEqual(await implement(), [["implement", "plan"]]);
  // Started by someone who may not act on the repo: nothing is planned for Implement.
  await w.db.run(w.db.k.updateTable("item_workflows").set({ started_by: "viewer" }).where("number", "=", 5));
  assert.deepEqual(await implement(), []);
});

test("a stage assigns once; a person who removed us is final", async () => {
  const w = await (await (await world()).repo()).pr(1);
  const g = await guardRepo(w.db, "app", "push", "pipeline");
  assert.ok(!("refused" in g));
  const me = { id: "U1", login: "pipeline-bot" };
  const claim = () => claimForWork({ db: w.db, login: "t" }, g as never, w.gh.querier, "app", 1, "pr", me, { run: "t" });
  assert.equal(await claim(), true);
  assert.equal(await claim(), false, "now assigned");
  w.gh.live(1, { assignees: [] });
  assert.equal(await claim(), false, "removed by a person");
  assert.equal(w.gh.writesOf("assign").length, 1);
});

test("the unassign step releases what the planner says and only our own assignment", async () => {
  const w = await (await (await (await (await (await (await (await (await (await world()).repo()).pr(1)).review(1)).verified(1)).premerge(1, "clean")).pr(2)).review(2)).verified(2)).premerge(2, "clean");
  const mark = async (n: number, who: string[]) => await w.db.run(w.db.k.updateTable("items").set({ assignees: JSON.stringify(who) }).where("repo", "=", "app").where("number", "=", n));
  for (const n of [1, 2]) await w.db.run(w.db.k.insertInto("audit").values({ at: "2026-11-04T00:00:00Z", login: "assign", action: "assign", target: `app#${n}`, details: '{"assignee":"pipeline-bot"}' }));
  await mark(1, ["pipeline-bot"]);
  await mark(2, ["pipeline-bot", "alice"]);
  w.gh.live(1, { assignees: ["pipeline-bot"] });
  w.gh.live(2, { assignees: ["pipeline-bot", "alice"] });
  // Started with review and done: both wait for a person's answer to the recommendation.
  for (const n of [1, 2]) await insertWorkflow(w.db, { repo: "app", number: n, kind: "pr", entry: "review", state: "recommending", startedBy: "op", startedAt: "2026-11-04T00:00:00Z", startedVia: "dashboard" });
  const r = await runUnassign(w.db, { repo: "app", by: "pipeline", runId: "t", querier: w.gh.querier, exec: asPipelineBot });
  assert.deepEqual(r.due, 1);
  assert.deepEqual(r.unassigned, ["app#1"]);
});

test("a push keeps the assignment while the new head's review is due; a stage assigns again after our own unassign", async () => {
  const w = await (await (await (await (await (await world()).repo()).pr(1, { head: "old" })).review(1, { head: "old" })).pr(2, { head: "theirs" })).review(2, { head: "old" });
  for (const n of [1, 2]) {
    await w.db.run(w.db.k.insertInto("audit").values({ at: "2026-11-04T00:00:00Z", login: "assign", action: "assign", target: `app#${n}`, details: '{"assignee":"pipeline-bot"}' }));
    await w.db.run(w.db.k.updateTable("items").set({ assignees: JSON.stringify(["pipeline-bot"]) }).where("repo", "=", "app").where("number", "=", n));
    w.gh.live(n, { assignees: ["pipeline-bot"] });
  }
  // The mirror still shows the head our push left, and a comment of ours made its review stale.
  await w.db.run(w.db.k.insertInto("settings").values([{ key: "review_stale:app#1", value: "2999-01-01T00:00:00Z" }, { key: "review_stale:app#2", value: "2999-01-01T00:00:00Z" }]));
  await w.db.run(w.db.k.insertInto("push_outcomes").values({ at: "2026-11-04T00:01:00Z", stage: "fixup", action: "fixup-push", repo: "app", number: 1, from_oid: "old", to_oid: "new", before_res: "unknown" }));
  const r = await runUnassign(w.db, { repo: "app", by: "pipeline", runId: "t", querier: w.gh.querier, exec: asPipelineBot });
  assert.deepEqual(r.unassigned, [], "neither our push nor the contributor's releases while the new head's review is due");

  const g = await guardRepo(w.db, "app", "push", "pipeline");
  assert.ok(!("refused" in g));
  // Our own earlier unassign of #2 (as a give-up would leave it).
  await w.db.run(w.db.k.insertInto("audit").values({ at: "2026-11-04T00:02:00Z", login: "unassign", action: "unassign", target: "app#2", details: '{"assignee":"pipeline-bot","state":"done"}' }));
  await w.db.run(w.db.k.updateTable("items").set({ assignees: "[]" }).where("repo", "=", "app").where("number", "=", 2));
  w.gh.live(2, { assignees: [] });
  const claim = () => claimForWork({ db: w.db, login: "t" }, g as never, w.gh.querier, "app", 2, "pr", { id: "U1", login: "pipeline-bot" }, { run: "t" });
  assert.equal(await claim(), true, "assigns again after our own unassign");
});
