// A person's command is the approval of what it starts: it works in a repo with no merge or push approval, with the pipeline off and
// on an item someone stopped, and a refusal writes nothing. Through the command entry point every surface uses.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setFeature } from "../src/build/features.ts";
import { recordSteps } from "../src/data/implement/index.ts";
import { implementStep } from "../src/core/decide-item.ts";
import { loadItemFact } from "../src/core/issue-facts.ts";
import { retryItemPreapproval } from "../src/dash/api/operator.ts";
import type { Req } from "../src/dash/types.ts";
import { preapprovalOf } from "../src/preapproval/index.ts";
import { insertWorkflow, liveWorkflow, updateWorkflow } from "../src/workflow/store.ts";
import { noteMergeable, unknownOf } from "../src/merge/mergeable.ts";
import type { PrChecks } from "../src/review/checks.ts";
import { T0, T1, type World } from "./world-db.ts";
import { before, earlier, implementing, legs8, MAINT, mergesAsPerson, press, pushed, review, run, send, settle, unstarted } from "./workflow-start-world.ts";

for (const pipeline of [true, false]) {
  test(`merge on an unstarted PR of a repo without merge approval, its pipeline ${pipeline ? "on" : "off"}, merges as the sender`, async () => {
    const w = await unstarted(pipeline);
    await run(w, "merge");
    await settle(w);
    await mergesAsPerson(w);
  });
}

test("an approved review start in such a repo merges after its review", async () => {
  const w = await unstarted(false);
  await run(w, "review and merge");
  await settle(w);
  assert.equal((await preapprovalOf(w.db, "app", 1))?.state, "review");
  await review(w);
  await settle(w);
  await mergesAsPerson(w);
});

test("an item someone stopped, closed or put in the backlog starts again with every entry, and merges", async () => {
  for (const end of ["stop", "backlog", "close"]) {
    const w = await unstarted(end !== "stop");
    for (const start of ["review", "fix-up", "review and merge", "fix-up and merge", "merge"]) {
      await run(w, start);
      const wf = (await liveWorkflow(w.db, "app", 1))!;
      assert.notEqual((await w.prPlan(1)).state, "out-of-scope", `${start} after ${end}`);
      const open = await w.rows("SELECT workflow_id FROM preapprovals WHERE number = 1 AND state = 'review'");
      assert.deepEqual(open.map((l) => l.workflow_id), start.includes("merge") ? [wf.id] : [], `${start} after ${end}`);
      await run(w, end);
      assert.equal(await liveWorkflow(w.db, "app", 1), null);
    }
    await run(w, "merge");
    assert.deepEqual((await w.rows("SELECT state FROM workflow_actions WHERE state IN ('pending', 'waiting-token', 'waiting-permission')")).length, 0, "the start took back the close");
    await settle(w);
    await mergesAsPerson(w);
    w.close();
  }
});

test("a stopped issue can be implemented again", async () => {
  const w = await (await unstarted(false)).issue(7);
  for (const end of ["stop", "backlog", "close"]) {
    await run(w, "implement and merge", 7);
    assert.ok(implementStep((await loadItemFact(w.db, "app", 7))!), `planned again after ${end}`);
    await run(w, end, 7);
    assert.equal(implementStep((await loadItemFact(w.db, "app", 7))!), null);
  }
});

test("a refused start writes nothing", async () => {
  const w = await unstarted();
  await run(w, "close");
  const tables = ["item_workflows", "preapprovals", "review_state", "operator_fixups", "workflow_events", "workflow_actions"];
  const all = async () => await Promise.all(tables.map(async (t) => await w.rows(`SELECT * FROM ${t} ORDER BY 1`)));
  const before = await all();
  const refused = async (text: string, head?: string) => {
    const o = await send(w, text, 1, head);
    assert.equal(o.outcome, "refused", `${text}: ${o.line}`);
    assert.deepEqual(await all(), before, text);
  };
  await refused("merge", "older");
  await w.db.run(w.db.k.updateTable("main.pr_checks").set({ is_draft: 1 }));
  for (const text of ["merge", "review and merge", "fix-up and merge"]) await refused(text);
  await w.db.run(w.db.k.updateTable("main.pr_checks").set({ is_draft: 0 }));
  await w.db.run(w.db.k.updateTable("main.items").set({ state: "CLOSED" }));
  await refused("merge");
});

test("a refused answer writes nothing", async () => {
  const w = await unstarted();
  await run(w, "review");
  await w.db.run(w.db.k.updateTable("main.pr_checks").set({ is_draft: 1 }));
  const before = await liveWorkflow(w.db, "app", 1);
  for (const text of ["merge", "fix-up and merge"]) assert.equal((await send(w, text)).outcome, "refused", text);
  assert.deepEqual(await liveWorkflow(w.db, "app", 1), before);
  assert.deepEqual([await w.rows("SELECT id FROM preapprovals"), await w.rows("SELECT id FROM operator_fixups")], [[], []]);
});

test("an approval while the merge leg of the PR's issue works is refused", async () => {
  const w = await (await unstarted()).issue(7);
  const id = await insertWorkflow(w.db, { repo: "app", number: 7, kind: "issue", entry: "implement", state: "running", startedBy: MAINT, startedAt: T0, startedVia: "dashboard", approvedBy: MAINT, approvedAt: T0, approvedVia: "dashboard" });
  await w.db.run(w.db.k.insertInto("main.preapprovals").values({ repo: "app", number: 1, by: MAINT, at: T0, instructions: "", state: "review", from_head: "sha1", head: "sha1", updated_at: T0, fix_id: null, workflow_id: id }));
  assert.equal((await send(w, "merge")).outcome, "refused");
  assert.equal(await liveWorkflow(w.db, "app", 1), null);
});

test("a fix-up-and-merge card pressed on a workflow nobody approved approves it as the presser", async () => {
  const w = await unstarted(false);
  await run(w, "review");
  assert.equal((await liveWorkflow(w.db, "app", 1))!.approvedBy, null);
  await press(w, "fix-up, merge");
  await pushed(w, "sha1", "sha1b");
  await settle(w);
  await mergesAsPerson(w, "sha1b");
});

test("a fix-up-and-merge card pressed on an unstarted PR starts it, approved by the presser", async () => {
  const w = await unstarted(false);
  await press(w, "fix-up, merge");
  await review(w);
  await settle(w);
  await mergesAsPerson(w);
});

test("trying a failed merge again approves as the person who pressed it, whatever became of its workflow", async () => {
  for (const ended of [false, true]) {
    const w = await unstarted(false);
    await run(w, "review");
    const wf = (await liveWorkflow(w.db, "app", 1))!;
    await w.db.run(w.db.k.insertInto("main.preapprovals").values({ repo: "app", number: 1, by: "ann", at: T0, instructions: "rename a to b", state: "failed", from_head: "sha1", updated_at: T0, fix_id: 99, workflow_id: wf.id }));
    if (ended) await run(w, "stop");
    const req = { params: { repo: "app", n: "1" }, user: { login: MAINT, role: "maintainer", canWrite: async () => true, canRead: async () => true } } as unknown as Req;
    await retryItemPreapproval(w.db, req);
    if (ended) await review(w);
    else await pushed(w, "sha1", "sha1b");
    await settle(w);
    await mergesAsPerson(w, ended ? "sha1" : "sha1b");
    w.close();
  }
});

test("implement on an issue whose earlier implementation ended starts afresh", async () => {
  const cases = [{ state: "closed", pr: "CLOSED" }, { state: "merged", pr: "MERGED" }, { state: "pr-opened", pr: "CLOSED" }, { state: "stuck", pr: "CLOSED" }, { state: "closed", pr: "OPEN" }] as const;
  for (const c of cases) {
    const w = await (await unstarted(false)).issue(7);
    await setFeature(w.db, "implement", true, MAINT, "app");
    const id = await earlier(w, c);
    await run(w, "implement and merge", 7);
    await settle(w);
    const why = `attempt ${c.state}, its PR ${c.pr}`;
    assert.equal((await liveWorkflow(w.db, "app", 7))?.state, "running", why);
    // What is left of an attempt whose PR is over is recording its end.
    if (c.state === "pr-opened" || c.state === "stuck") {
      if (c.state === "pr-opened") assert.deepEqual(implementStep((await loadItemFact(w.db, "app", 7))!), { bucket: "revise" }, why);
      await recordSteps(w.db, [{ id, to: "closed" }]);
      await settle(w);
    }
    assert.deepEqual(implementStep((await loadItemFact(w.db, "app", 7))!), { bucket: "plan" }, why);
    if (c.pr === "OPEN") {
      // The earlier attempt's PR, reopened, is no part of it: it starts on its own.
      await run(w, "review", 8);
      assert.equal((await liveWorkflow(w.db, "app", 8))?.startedBy, MAINT);
    }
    w.close();
  }
});

test("a PR closed during the workflow that opened it ends the workflow", async () => {
  const w = await (await unstarted(false)).issue(7);
  await run(w, "implement and merge", 7);
  const id = await earlier(w, { state: "pr-opened", pr: "OPEN" });
  await settle(w);
  await w.db.run(w.db.k.updateTable("main.items").set({ state: "CLOSED", closed_at: new Date().toISOString() }).where("number", "=", 8));
  await recordSteps(w.db, [{ id, to: "closed" }]);
  await settle(w);
  assert.equal(await liveWorkflow(w.db, "app", 7), null);
});

test("a PR that a live implement workflow works on starts no work of its own, and the issue's approved merge goes on", async () => {
  const w = await implementing("implement and merge");
  const before = await legs8(w);
  assert.deepEqual(before.map((l) => l.state), ["review"]);
  for (const text of ["review", "fix-up", "implement", "backlog", "review and merge", "fix-up, urgent"]) {
    const o = await send(w, text, 8);
    assert.equal(o.outcome, "refused", `${text}: ${o.line}`);
    assert.match(o.line, /app#7/, "it names where the work runs");
    assert.match(o.line, new RegExp(MAINT), "and who started it");
  }
  assert.equal(await liveWorkflow(w.db, "app", 8), null);
  assert.deepEqual(await legs8(w), before);

  // Stopped on the issue, the PR can be started on its own; then the issue is not started over it.
  await run(w, "stop", 7);
  await run(w, "review", 8);
  const o = await send(w, "implement", 7);
  assert.equal(o.outcome, "refused", o.line);
  assert.match(o.line, /app#8/);
});

test("an approved PR that is a draft and has no leg waits to be marked ready, and its leg starts then", async () => {
  const w = await unstarted(false);
  await run(w, "merge");
  await settle(w);
  await w.db.run(w.db.k.deleteFrom("main.preapprovals"));
  await w.db.run(w.db.k.updateTable("main.pr_checks").set({ is_draft: 1 }));
  await settle(w);
  const wf = (await liveWorkflow(w.db, "app", 1))!;
  assert.deepEqual([wf.state, wf.blocker, (await w.prPlan(1)).waitKind], ["running", null, "contributor"], wf.rec?.text ?? "");
  await w.db.run(w.db.k.updateTable("main.pr_checks").set({ is_draft: 0 }));
  await settle(w);
  await mergesAsPerson(w);
});

test("a PR started into the merge queue whose merge state stays unknown is followed like a reviewed one", async () => {
  const w = await unstarted();
  const row = { repo: "app", number: 1, head_oid: "sha1", state: "OPEN", overall: "success", mergeable: "UNKNOWN" } as PrChecks;
  await noteMergeable(w.db, [row], T1);
  assert.equal(await unknownOf(w.db, "app", 1, "sha1"), null);
  await run(w, "merge");
  await noteMergeable(w.db, [row], T1);
  assert.equal((await unknownOf(w.db, "app", 1, "sha1"))?.reads, 1);
});

test("a merge nobody can make is refused with the reason, as an entry and on a started PR, and nothing is written: off the default branch, or no CI", async () => {
  for (const [why, set] of [
    [/aimed at release/, (w: World) => w.db.run(w.db.k.updateTable("main.items").set({ base_ref: "release" }).where("number", "=", 1))],
    [/no CI/, (w: World) => w.db.run(w.db.k.updateTable("main.pr_checks").set({ overall: "none", checks: "[]" }))],
  ] as const) {
    const w = await unstarted(false);
    await set(w);
    for (const text of ["merge", "review and merge"]) {
      const o = await send(w, text);
      assert.equal(o.outcome, "refused", o.line);
      assert.match(o.line, why);
    }
    assert.deepEqual([await liveWorkflow(w.db, "app", 1), await w.rows("SELECT id FROM preapprovals")], [null, []]);
    await run(w, "review");
    const o = await send(w, "merge");
    assert.equal(o.outcome, "refused", o.line);
    assert.equal((await liveWorkflow(w.db, "app", 1))!.approvedBy, null);
    w.close();
  }
});

test("an approved merge stopped at a pre-merge defect while it had no fix-up round starts one on the next pass; one whose rounds are used stays stopped", async () => {
  for (const used of [false, true]) {
    const w = await unstarted(false);
    await w.db.run(w.db.k.deleteFrom("main.premerge_reviews"));
    await run(w, "merge");
    await w.premerge(1, "defect", false);
    // The stop is made while the rule gives the defect no round.
    await w.premergeRoundsSpent(1);
    await settle(w);
    const stopped = (await liveWorkflow(w.db, "app", 1))!;
    assert.deepEqual([stopped.state, stopped.blocker], ["blocked", "major-finding"], `used ${used}`);
    // The rule gives it rounds now, or the PR is at the round limit.
    await w.db.run(w.db.k.deleteFrom("main.fixups").where("source", "=", "premerge"));
    if (used) await w.premergeRoundsSpent(1);
    await settle(w);
    const after = (await liveWorkflow(w.db, "app", 1))!;
    const round = (await w.prPlan(1)).actions.some((a) => a.kind === "fixup" && a.params?.source === "premerge");
    if (used) assert.deepEqual([after.state, after.blocker, after.recAt, round], ["blocked", "major-finding", stopped.recAt, false]);
    else {
      assert.deepEqual([after.state, after.blocker, after.rec, round], ["running", null, null, true], JSON.stringify(after.rec));
      assert.equal((await w.rows("SELECT state FROM preapprovals WHERE number = 1 ORDER BY id DESC"))[0]!.state, "ci");
    }
    w.close();
  }
});

test("an approved merge stopped at a pre-merge defect goes on without a question once the author's fix passes the review round", async () => {
  const w = await unstarted(false);
  await w.db.run(w.db.k.deleteFrom("main.premerge_reviews"));
  await run(w, "review and merge");
  await settle(w);
  await review(w);
  await w.premerge(1, "defect", false);
  await w.premergeRoundsSpent(1);
  await settle(w);
  const stopped = (await liveWorkflow(w.db, "app", 1))!;
  assert.deepEqual([stopped.state, stopped.blocker], ["blocked", "major-finding"]);
  // The author pushes their own fix; the review round finds the new commits within what was approved.
  await w.synced(1, "theirs");
  await settle(w);
  assert.deepEqual([(await liveWorkflow(w.db, "app", 1))!.state], ["running"]);
  await w.db.run(w.db.k.insertInto("main.opus_reviews").values({
    repo: "app", number: 1, head_oid: "theirs", run_id: "rv", at: new Date(Date.now() + 1000).toISOString(), model: "m", mode: "full", verdict: "take", sure: 1, reason: "r",
    workflow: JSON.stringify({ outside_purpose: null, recommendation: "Merge as it stands", merge: true, author_commits: { in_scope: true, note: "fixes the defect" } }),
  }));
  await settle(w);
  const goes = (await liveWorkflow(w.db, "app", 1))!;
  assert.deepEqual([goes.state, goes.blocker, goes.rec, goes.acceptedHead], ["running", null, null, "theirs"], JSON.stringify(goes.rec));
  const leg = (await w.rows("SELECT state, head FROM preapprovals WHERE number = 1 ORDER BY id DESC"))[0]!;
  assert.ok(leg.head === "theirs" && !["failed", "cancelled"].includes(leg.state as string), JSON.stringify(leg));
});

test("drop of a blocking pre-merge finding overrules it: the merge goes on with green CI and no new pre-merge review, while merge alone stays refused", async () => {
  const w = await unstarted(false);
  await w.db.run(w.db.k.deleteFrom("main.premerge_reviews"));
  await run(w, "merge");
  await w.premerge(1, "defect", false);
  await w.premergeRoundsSpent(1);
  await settle(w);
  const stopped = (await liveWorkflow(w.db, "app", 1))!;
  assert.deepEqual([stopped.state, stopped.rec!.parts.fix], ["blocked", [1]], stopped.rec?.text ?? "");
  assert.match(stopped.rec!.text, /write drop 1/);
  assert.equal((await send(w, "merge")).outcome, "refused");
  const o = await send(w, "drop 1");
  assert.equal(o.outcome, "run", o.line);
  await settle(w);
  const wf = (await liveWorkflow(w.db, "app", 1))!;
  assert.deepEqual([wf.state, wf.blocker, wf.plan.find((p) => p.n === 1)?.state, wf.plan.find((p) => p.n === 1)?.droppedBy], ["running", null, "dropped", MAINT], JSON.stringify(wf.rec));
  await mergesAsPerson(w);
  assert.equal((await w.rows("SELECT tries FROM premerge_reviews WHERE number = 1")).length, 1);
});

test("a dropped pre-merge finding the review repeats after an accepted author push is a new part, and dropping it again merges on green CI", async () => {
  const w = await unstarted(false);
  await w.db.run(w.db.k.deleteFrom("main.premerge_reviews"));
  await run(w, "merge");
  await w.premerge(1, "defect", false);
  await w.premergeRoundsSpent(1);
  await settle(w);
  assert.equal((await send(w, "drop 1")).outcome, "run");
  await settle(w);
  // The author pushes; the round's review accepts the head, and its pre-merge review finds the same defect.
  await w.synced(1, "sha2");
  await review(w, "sha2");
  await w.verified(1);
  await w.premerge(1, "defect", false);
  await settle(w);
  const stopped = (await liveWorkflow(w.db, "app", 1))!;
  const again = stopped.plan.filter((p) => p.premerge && p.state === "planned").map((p) => p.n);
  assert.deepEqual([stopped.state, again.length, stopped.rec!.parts.fix], ["blocked", 1, again], stopped.rec?.text ?? "");
  assert.equal((await send(w, `drop ${again[0]}`)).outcome, "run");
  await settle(w);
  assert.equal((await liveWorkflow(w.db, "app", 1))!.plan.find((p) => p.n === again[0])?.droppedAt, "sha2");
  await mergesAsPerson(w, "sha2");
});

test("merge at a stop on defects the pre-merge review gave no fix for is refused and asks to fix them first; the yes has them fixed", async () => {
  const w = await unstarted(false);
  await w.db.run(w.db.k.deleteFrom("main.premerge_reviews"));
  await run(w, "merge");
  await w.premerge(1, "defect", false);
  await w.premergeRoundsSpent(1);
  await settle(w);
  const stopped = (await liveWorkflow(w.db, "app", 1))!;
  assert.deepEqual([stopped.state, stopped.rec!.parts.fix, stopped.rec!.again], ["blocked", [1], undefined], stopped.rec?.text ?? "");
  // A stop stored without its defects as parts gets them when someone says merge.
  await updateWorkflow(w.db, stopped.id, { plan: [], blockerParams: { ...stopped.blockerParams, premerge: [] }, rec: { text: "Review it again, then merge.", parts: { fix: [], drop: [] }, merges: true, again: "review" } });
  const o = await send(w, "merge");
  assert.equal(o.outcome, "refused", o.line);
  assert.match(o.line, /nothing merges past them.*Fix them first\?.*Reply yes to fix 1, then merge/);
  const asked = (await liveWorkflow(w.db, "app", 1))!;
  assert.deepEqual([asked.state, asked.rec!.parts.fix, asked.plan.map((p) => p.title), o.question?.recAt], ["blocked", [1], ["off by one"], asked.recAt]);
  // Saying it again asks the same question again.
  assert.match((await send(w, "merge")).line, /Reply yes to fix 1, then merge/);
  await settle(w);
  await run(w, "yes");
  assert.equal((await liveWorkflow(w.db, "app", 1))!.state, "running");
  assert.match(String((await w.rows("SELECT instructions FROM operator_fixups WHERE state = 'queued'"))[0]!.instructions), /off by one/);
});
