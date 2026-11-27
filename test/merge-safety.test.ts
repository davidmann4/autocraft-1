// What the merge step and the planner refuse around a maintainer workflow: an author's push under a push of ours, the time after the
// merge leg ended until the workflow moves on, and an item a person stopped. Each case would merge by the repo's merge rule.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { advancePreapprovals } from "../src/preapproval/index.ts";
import { guard } from "../src/core/guard.ts";
import { loadPrFact } from "../src/core/facts.ts";
import { mergeMay } from "../src/core/gates.ts";
import { mergeVerdicts } from "../src/merge/approval.ts";
import { implementStep } from "../src/core/decide-item.ts";
import { loadItemFact } from "../src/core/issue-facts.ts";
import { scopeSettled } from "../src/review/opus.ts";
import { advanceWorkflows } from "../src/workflow/advance.ts";
import { runCommand, type Actor } from "../src/workflow/apply.ts";
import { parse } from "../src/workflow/parse.ts";
import { liveWorkflow } from "../src/workflow/store.ts";
import { legWait } from "../src/workflow/waits.ts";
import { dupeGroups, kindSets } from "../src/dupes/plan.ts";
import { loadDupeState, saveComparisons } from "../src/data/triage/index.ts";
import { fillEmbedHashes } from "../src/itemhash.ts";
import { T0, world, type World } from "./world-db.ts";

let current: World | undefined;
afterEach(() => current?.close());

const MAINT = "mira";
const actor: Actor = { login: MAINT, canWrite: async () => true };
const command = async (w: World, text: string, number = 1) => {
  const r = await runCommand(w.db, actor, "dashboard", { parsed: parse(text), items: [{ repo: "app", number }] });
  assert.equal(r.items[0]!.outcome, "run", r.lines.join("\n"));
};
/** A small bug fix by a whitelisted author, in a repo whose merge rule may merge it: ready at sha1. */
async function ready(): Promise<World> {
  const w = current = await (await (await world()).repo()).acting(MAINT);
  await (await (await (await w.pr(1)).review(1)).verified(1)).premerge(1, "clean");
  return w;
}
/** Its merge approved by a person, whose leg handed it over. */
async function handedOver(): Promise<World> {
  const w = await (await ready()).workflow(1, { by: MAINT });
  await advanceWorkflows(w.db);
  for (let i = 0; i < 4; i++) await advancePreapprovals(w.db);
  return w;
}
const setLeg = async (w: World, set: { state?: string; head?: string; reason?: string }) =>
  void await w.db.run(w.db.k.updateTable("main.preapprovals").set({ ...set, updated_at: new Date().toISOString() }).where("number", "=", 1));
/** Whether the PR merges now: the plan has the merge and its gate passes, the merge step's fresh check passes, and the guard right before the write passes. */
async function merges(w: World, head = "sha1"): Promise<boolean[]> {
  const f = (await loadPrFact(w.db, "app", 1))!;
  const planned = (await w.prPlan(1)).actions.some((a) => a.kind === "merge" && a.head === head) && mergeMay(f)!.ok;
  const verdict = (await mergeVerdicts(w.db, "app", [{ number: 1, head }])).get(1)!.ok;
  const g = await guard(w.db, { repo: "app", number: 1 }, { kind: "merge", head }, "pipeline", async () => ({ state: "OPEN", head, draft: false, mergeable: "MERGEABLE" }));
  return [planned, verdict, !("refused" in g)];
}
const ALL = [true, true, true], NONE = [false, false, false];
const refusedBy = async (w: World, head = "sha1") => { const v = (await mergeVerdicts(w.db, "app", [{ number: 1, head }])).get(1)!; return v.ok ? null : v.why.text; };

test("an approved PR merges only through its handed-over leg, also where the repo's merge rule would merge it", async () => {
  const w = await (await ready()).workflow(1, { by: MAINT });
  assert.deepEqual(await merges(w), NONE, "approved, its leg not started");
  await advanceWorkflows(w.db);
  assert.deepEqual(await merges(w), NONE, "its leg at work");
  for (let i = 0; i < 4; i++) await advancePreapprovals(w.db);
  assert.deepEqual(await merges(w), ALL, "handed over");
});

test("after the merge leg was cancelled or failed nothing merges before the workflow moved on, nor after it asked", async () => {
  for (const state of ["cancelled", "failed"]) {
    const w = await handedOver();
    assert.deepEqual(await merges(w), ALL);
    await setLeg(w, { state, reason: "the PR conflicts with its base branch" });
    assert.deepEqual(await merges(w), NONE, state);
    await advanceWorkflows(w.db);
    assert.equal((await liveWorkflow(w.db, "app", 1))!.state, "blocked");
    assert.deepEqual(await merges(w), NONE, `${state}, then asked`);
    w.close();
  }
});

test("a held PR does not merge on the repo's approval until someone resumes it or starts it again", async () => {
  const w = await ready();
  assert.deepEqual(await merges(w), ALL, "the rule merges it unstarted");
  await command(w, "review and merge");
  await command(w, "stop");
  assert.deepEqual(await merges(w), NONE);
  assert.match((await refusedBy(w))!, /^Someone holds this/);
});

test("the pull request of a held issue does not merge on the repo's approval", async () => {
  const w = await (await ready()).issue(7);
  await w.db.run(w.db.k.insertInto("main.implementations").values({ repo: "app", number: 7, attempt: 1, state: "pr-opened", pr_number: 1, text_hash: "h", queued_by: MAINT, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } as never));
  await command(w, "implement", 7);
  await command(w, "stop", 7);
  assert.deepEqual(await merges(w), NONE);
  assert.match((await refusedBy(w))!, /^Someone holds this/);
});

test("our push on top of an author's push does not merge; two pushes of ours do", async () => {
  const w = await handedOver();
  const push = async (from: string, to: string) => void await w.db.run(w.db.k.insertInto("main.conflict_merges").values({ repo: "app", number: 1, from_head: from, to_head: to, base_sha: "m", state: "merged", attempt: 1, created_at: new Date().toISOString(), own_diff: "same" } as never));
  await w.synced(1, "c");
  await setLeg(w, { head: "c" });
  await push("b", "c");
  assert.match((await refusedBy(w, "c"))!, /author pushed/);
  await push("sha1", "b");
  assert.equal(await refusedBy(w, "c"), null);
});

test("someone else's push to an implementation PR before its merge leg starts brings the issue back", async () => {
  const w = await (await (await (await world()).repo()).acting(MAINT)).issue(7);
  current = w;
  await w.pr(8, { author: "craft-bot" });
  await w.db.run(w.db.k.insertInto("main.implementations").values({ repo: "app", number: 7, attempt: 1, state: "pr-opened", pr_number: 8, text_hash: "h", queued_by: MAINT, created_at: new Date(Date.now() + 1000).toISOString(), updated_at: new Date().toISOString() } as never));
  await w.db.run(w.db.k.insertInto("main.own_commits").values([{ repo: "app", sha: "sha8", action: "implement-push", at: "t" }, { repo: "app", sha: "rev", action: "implement-push", at: "t" }]));
  await command(w, "implement and merge", 7);
  await w.synced(8, "rev");
  await w.db.run(w.db.k.insertInto("main.push_outcomes").values({ at: new Date().toISOString(), stage: "implement", action: "implement-push", repo: "app", number: 8, from_oid: "theirs", to_oid: "rev", before_res: "green" }));
  await advanceWorkflows(w.db);
  const wf = (await liveWorkflow(w.db, "app", 7))!;
  assert.deepEqual([wf.state, wf.blocker], ["blocked", "author-commits"]);
  await command(w, "yes", 7);
  await advanceWorkflows(w.db);
  assert.equal((await liveWorkflow(w.db, "app", 7))!.state, "running", "the yes accepted the head it was shown");
});

test("a review gets settled scope once a person approved the merge or started a merging entry, not for a plain review start", async () => {
  const w = await (await ready()).workflow(1, { by: MAINT, approved: false });
  const wf = (await liveWorkflow(w.db, "app", 1))!;
  assert.deepEqual(scopeSettled(wf), {});
  assert.deepEqual(scopeSettled(undefined), {});
  assert.equal(scopeSettled({ ...wf, approvedBy: "ann" }).scope_settled?.by, "ann");
  for (const entry of ["merge", "fixup", "implement"] as const) assert.equal(scopeSettled({ ...wf, entry }).scope_settled?.by, MAINT);
});

test("started work under the box identity says that it waits for the GitHub App", async () => {
  const w = await (await (await (await world()).repo()).acting(MAINT)).issue(7);
  current = w;
  await command(w, "implement", 7);
  const wf = (await liveWorkflow(w.db, "app", 7))!;
  assert.equal(await legWait(w.db, wf), null);
  await w.db.run(w.db.k.updateTable("main.settings").set({ value: "box" }).where("key", "=", "github_identity"));
  assert.match((await legWait(w.db, wf))!, /GitHub App/);
  const step = implementStep((await loadItemFact(w.db, "app", 7))!);
  assert.ok(step && "wait" in step && /GitHub App/.test(step.wait.text), JSON.stringify(step));
});

// ---- duplicates of a PR nobody started

const EDGE = { repo: "app", a: 1, b: 2 };
/** The pair of PRs 1 and 2 as the duplicate check leaves it at their current text. */
async function pair(w: World, row: { verdict: string | null; by_operator?: number }): Promise<void> {
  await fillEmbedHashes(w.db);
  const hash = async (n: number) => (await w.db.get(w.db.k.selectFrom("items").select("embed_hash").where("repo", "=", "app").where("number", "=", n)))!.embed_hash!;
  await w.db.run(w.db.k.deleteFrom("duplicate_pairs").where("repo", "=", "app"));
  await w.db.run(w.db.k.insertInto("duplicate_pairs").values({ ...EDGE, a_hash: await hash(1), b_hash: await hash(2), similarity: 0.9, by_operator: 0, created_at: T0, ...row }));
}
/** The group's comparison as the compare step stores it. */
async function compared(w: World, kept: number, source = "model", duplicate = true): Promise<void> {
  const state = await loadDupeState(w.db);
  const s = kindSets(state, dupeGroups(state)[0]!)[0]!;
  const others = s.members.filter((m) => m.number !== kept).map((m) => ({ number: m.number, duplicate, better: [], carry: [] }));
  await saveComparisons(w.db, [{ repo: "app", key: s.key, kind: "pr", members: s.members.map((m) => m.number), hash: s.hash, kept, source, model: "m", reason: "r", result: { others, rounds: 1 }, error: null, attempts: 0, at: T0, summary: null, why: null, sizes: { 1: 20, 2: 20 }, heads: null }]);
}
const setState = async (w: World, n: number, state: string) => void await w.db.run(w.db.k.updateTable("items").set({ state }).where("repo", "=", "app").where("number", "=", n));

test("an unstarted PR that duplicates another open PR is neither reviewed nor merged; the one the comparison keeps goes on", async () => {
  const w = await (await ready()).pr(2);
  await pair(w, { verdict: null });
  assert.deepEqual(await merges(w), ALL, "a candidate pair nobody checked");
  await pair(w, { verdict: "duplicate" });
  assert.deepEqual(await merges(w), NONE, "a duplicate not compared yet");
  assert.match((await w.prPlan(1)).wait!, /^duplicates app#2; waits for their comparison/);

  await compared(w, 2);
  assert.deepEqual(await merges(w), NONE, "the comparison keeps the other");
  assert.match((await refusedBy(w))!, /duplicates app#2/);
  const p = await w.prPlan(1);
  assert.deepEqual([p.state, p.wait, p.waitKind], ["not-started", "duplicates app#2; waits for a maintainer", "person"]);
  assert.deepEqual((await w.prPlan(2)).actions.map((a) => a.kind), ["review"], "the kept one goes on");

  await compared(w, 1);
  assert.deepEqual(await merges(w), ALL, "the comparison keeps it");
  assert.deepEqual((await w.prPlan(2)).actions, [], "the other is not reviewed");
  await w.db.run(w.db.k.updateTable("items").set({ additions: 200 }).where("repo", "=", "app").where("number", "=", 2));
  await fillEmbedHashes(w.db);
  assert.deepEqual(await merges(w), ALL, "an outgrown comparison stands until the next one");

  await w.workflow(2, { by: MAINT });
  assert.deepEqual(await merges(w), NONE, "a person chose the other one");
});

test("a duplicate that merged meanwhile stops the merge; one closed unmerged, found different or ruled different does not", async () => {
  const w = await (await ready()).pr(2);
  await pair(w, { verdict: "duplicate" });
  await compared(w, 1);
  assert.deepEqual(await merges(w), ALL);
  await setState(w, 2, "MERGED");
  assert.deepEqual(await merges(w), NONE, "merged since the comparison");
  await compared(w, 2, "closed");
  assert.deepEqual(await merges(w), NONE, "the merged one won");
  await setState(w, 2, "CLOSED");
  assert.deepEqual(await merges(w), ALL, "closed unmerged");

  await setState(w, 2, "OPEN");
  await compared(w, 1, "rule");
  assert.deepEqual(await merges(w), NONE, "no model named the best one");
  await compared(w, 2, "model", false);
  assert.deepEqual(await merges(w), ALL, "the comparison found two different fixes");
  await compared(w, 2);
  assert.deepEqual(await merges(w), NONE);
  await pair(w, { verdict: "distinct", by_operator: 1 });
  assert.deepEqual(await merges(w), ALL, "a person ruled the pair out");
});

test("a duplicate holds nothing that a person started", async () => {
  const w = await (await handedOver()).pr(2);
  await pair(w, { verdict: "duplicate" });
  await compared(w, 2);
  assert.deepEqual(await merges(w), ALL);
});
