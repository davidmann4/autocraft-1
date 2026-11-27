// workflow module, part a: workflow rows, events, planner facts, scores and scope loaders (SQLite; Postgres when AUTOCRAFT_TEST_PG_URL is set).
import assert from "node:assert/strict";
import type { Db } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import { NO_WORKFLOW_SCORE, workScore } from "../../src/core/work-score.ts";
import { expectFlat } from "../helpers/query-count.ts";
import {
  countEventsSince, listWorkflows, loadActingPairs, loadAnswers, loadEvents, loadGoOnAt, loadLastEventKinds, loadPathEnds, loadQueuePositions, loadStartedRefs,
  loadStartedWork, loadWorkflowFacts, loadWorkflowHistory, loadWorkScores, loadWorkWeights, recordEvents, saveWorkflows, startWorkflows,
} from "../../src/data/workflow/index.ts";
import { AT, both, openApp, seedPrs } from "./planner-helpers.ts";

const wf = (repo: string, number: number, o: Record<string, unknown> = {}) => ({ repo, number, kind: "pr" as const, entry: "review" as const, weight: 5, startedBy: "ann", startedVia: "cli" as const, at: AT, ...o });
const refs = (n: number, repo = "o/a") => Array.from({ length: n }, (_, i) => ({ repo, number: i + 1 }));

both("startWorkflows refuses an item with a live workflow; saveWorkflows patches several shapes and moves updated_at", async ({ db }) => {
  const first = await startWorkflows(db, [wf("o/a", 1), wf("o/a", 2, { approvedBy: "bob", approvedVia: "cli" })]);
  assert.deepEqual([...first.keys()], ["o/a#1", "o/a#2"]);
  const again = await startWorkflows(db, [wf("o/a", 2), wf("o/a", 3)]);
  assert.deepEqual([...again.keys()], ["o/a#3"], "a ref with a live workflow is missing from the result");
  const [a, b, c] = [first.get("o/a#1")!, first.get("o/a#2")!, again.get("o/a#3")!];
  const later = "2026-02-01T00:00:00.000Z";
  assert.equal(await saveWorkflows(db, [
    { id: a, patch: { weight: 8, rec: { text: "x", parts: { fix: [], drop: [] }, merges: false } }, at: later },
    { id: b, patch: { state: "done", approvedBy: null } },
    { id: c, patch: { weight: 2 } },
    { id: a, patch: { step: "review" } },
  ]), 3);
  const rows = await listWorkflows(db, {});
  const byId = new Map(rows.map((w) => [w.id, w]));
  assert.equal(byId.get(a)!.weight, 8);
  assert.equal(byId.get(a)!.step, "review", "patches of one id merge in order");
  assert.equal(byId.get(a)!.rec?.text, "x");
  assert.equal(byId.get(a)!.updatedAt, later);
  assert.equal(byId.get(b)!.state, "done");
  assert.equal(byId.get(b)!.approvedBy, null);
  assert.ok(byId.get(c)!.updatedAt > AT, "a patch always moves updated_at");
  assert.deepEqual((await listWorkflows(db, { live: true })).map((w) => w.id), [a, c]);
  assert.deepEqual((await listWorkflows(db, { logins: ["ANN"], approved: false, live: true })).map((w) => w.id), [a, c], "login match ignores case");
  assert.deepEqual((await listWorkflows(db, { refs: [{ repo: "o/a", number: 2 }] })).map((w) => w.id), [b]);
  assert.deepEqual(await listWorkflows(db, { refs: [] }), []);
  // The item with an ended workflow can start again; its history keeps both, oldest first.
  const restart = await startWorkflows(db, [wf("o/a", 2)]);
  assert.ok(restart.get("o/a#2")! > b);
  assert.deepEqual((await loadWorkflowHistory(db, [{ repo: "o/a", number: 2 }])).get("o/a#2")!.map((w) => w.state), ["done", "running"]);
});

both("events: oldest first, newest n per item, latest kind, go-on time, answers and the rate-limit count", async ({ db }) => {
  const ids = await startWorkflows(db, [wf("o/a", 1), wf("o/a", 2)]);
  const w1 = ids.get("o/a#1")!;
  const ev = (number: number, kind: string, at: string, login = "ann", workflowId: number | null = w1) => ({ workflowId, repo: "o/a", number, login, kind: kind as never, via: "github" as const, at, line: kind });
  await recordEvents(db, [ev(1, "started", "2026-01-01T01:00:00.000Z"), ev(1, "answered", "2026-01-01T03:00:00.000Z", "bob"), ev(1, "ambiguous", "2026-01-01T02:00:00.000Z"), ev(2, "started", "2026-01-01T01:30:00.000Z", "ann", ids.get("o/a#2")!)]);
  const all = await loadEvents(db, refs(2));
  assert.deepEqual(all.get("o/a#1")!.map((e) => e.kind), ["started", "answered", "ambiguous"], "ordered by id, the order they were recorded");
  assert.deepEqual((await loadEvents(db, refs(2), { lastPerRef: 2 })).get("o/a#1")!.map((e) => e.kind), ["answered", "ambiguous"]);
  assert.deepEqual([...(await loadEvents(db, refs(2), { kinds: ["started"] })).keys()], ["o/a#1", "o/a#2"]);
  const last = await loadLastEventKinds(db, refs(2));
  assert.equal(last.get("o/a#1"), "ambiguous");
  assert.equal(last.get("o/a#2"), "started");
  const goOn = await loadGoOnAt(db, [{ id: w1, startedAt: AT }, { id: 999, startedAt: AT }]);
  assert.deepEqual(goOn.get(w1), { since: "2026-01-01T03:00:00.000Z", said: "2026-01-01T03:00:00.000Z", resumed: null });
  assert.deepEqual(goOn.get(999), { since: AT, said: AT, resumed: null });
  assert.deepEqual((await loadAnswers(db, [w1, ids.get("o/a#2")!])).get(w1), { login: "bob", at: "2026-01-01T03:00:00.000Z" });
  assert.equal(await countEventsSince(db, { login: "ann", via: "github", since: "2026-01-01T01:15:00.000Z" }), 2);
  assert.equal(await countEventsSince(db, { login: "ann", via: "cli", since: AT }), 0);
  // An answer counts from when its question was asked, for every reader.
  await recordEvents(db, [{ ...ev(1, "answered", "2026-01-01T05:00:00.000Z"), seenAt: "2026-01-01T04:00:00.000Z" }, ev(1, "resumed", "2026-01-01T06:00:00.000Z")]);
  assert.deepEqual((await loadGoOnAt(db, [{ id: w1, startedAt: AT }])).get(w1), { since: "2026-01-01T04:00:00.000Z", said: "2026-01-01T05:00:00.000Z", resumed: "2026-01-01T06:00:00.000Z" });
  assert.equal((await loadWorkflowFacts(db, [{ repo: "o/a", number: 1 }])).live.get("o/a#1")!.since, "2026-01-01T04:00:00.000Z");
  assert.equal((await loadAnswers(db, [w1])).get(w1)!.at, "2026-01-01T05:00:00.000Z", "who answered last goes by when they answered");
});

both("loadWorkflowFacts: live and implementation-PR workflows, latest ended state and operator work", async ({ db }) => {
  const q = queryDb(db);
  const k = q.k as any;
  await q.run(k.insertInto("main.tracked_repos").values({ name: "o/a" }));
  const ids = await startWorkflows(db, [wf("o/a", 1, { entry: "implement", kind: "issue", weight: 8, startedBy: "ann" }), wf("o/a", 5, { entry: "merge" }), wf("o/a", 6), wf("o/a", 7)]);
  await saveWorkflows(db, [{ id: ids.get("o/a#6")!, patch: { state: "stopped" } }, { id: ids.get("o/a#7")!, patch: { state: "closed" } }]);
  await startWorkflows(db, [wf("o/a", 7)]);
  await recordEvents(db, [{ workflowId: ids.get("o/a#5")!, repo: "o/a", number: 5, login: "cy", kind: "answered", at: "2026-02-01T00:00:00.000Z" }]);
  await q.run(k.insertInto("main.implementations").values({ repo: "o/a", number: 1, queued_by: "ann", state: "pr-open", attempt: 1, text_hash: "h", pr_number: 11, created_at: AT, updated_at: AT }));
  // ann may act on o/a (staff with a write permission read just now, and the app identity); bob may not.
  await q.run(k.insertInto("main.settings").values({ key: "github_identity", value: "app" }));
  await q.run(k.insertInto("main.access").values([{ login: "ann", role: "operator" }, { login: "bob", role: "viewer" }]));
  await q.run(k.insertInto("main.repo_permissions").values([{ login: "ann", repo: "o/a", permission: "write", checked_at: new Date().toISOString() }, { login: "bob", repo: "o/a", permission: "write", checked_at: new Date().toISOString() }]));
  await q.run(k.insertInto("main.operator_fixups").values([
    { repo: "o/a", number: 5, from_head: "h5", instructions: "x", by: "ann", at: AT }, { repo: "o/a", number: 5, from_head: "h5", instructions: "y", by: "bob", at: AT },
  ]));
  await q.run(k.insertInto("main.preapprovals").values({ repo: "o/a", number: 5, by: "ann", at: AT, instructions: "", state: "queued", from_head: "h5", head: "h5", updated_at: AT, workflow_id: ids.get("o/a#5")! }));
  const f = await loadWorkflowFacts(db, [1, 5, 6, 7, 11].map((number) => ({ repo: "o/a", number })));
  assert.equal(f.live.get("o/a#1")!.entry, "implement");
  assert.equal(f.live.get("o/a#1")!.weight, 8);
  assert.equal(f.live.get("o/a#1")!.own, true);
  assert.equal(f.ofPr.get("o/a#11")!.own, false, "the PR of a live implement workflow reads the issue's workflow");
  assert.equal(f.ofPr.get("o/a#11")!.id, ids.get("o/a#1"));
  assert.ok(!f.live.has("o/a#11"));
  assert.equal(f.live.get("o/a#5")!.approved, false);
  assert.deepEqual([f.actors.get(ids.get("o/a#1")!), f.actors.get(ids.get("o/a#5")!)], [["ann"], ["cy", "ann"]], "whoever answered last acts for the workflow, of any entry");
  assert.equal(f.ended.get("o/a#6"), "stopped");
  assert.ok(!f.ended.has("o/a#7"), "an item that started again has a live workflow, not an ended one");
  assert.ok(f.live.has("o/a#7"));
  assert.deepEqual(f.operator.get("o/a#5")!.requests.map((r) => r.instructions), ["x"], "a request counts only while its maker may act");
  assert.equal(f.operator.get("o/a#5")!.legs.length, 1);
  // Only the keys asked for.
  assert.deepEqual([...(await loadWorkflowFacts(db, [{ repo: "o/a", number: 6 }])).live.keys()], []);
  assert.equal((await loadWorkflowFacts(db, [])).live.size, 0);
});

both("scores, queue positions, started refs and the acting pairs follow the live workflows", async ({ db }) => {
  const q = queryDb(db);
  const k = q.k as any;
  await seedPrs(db, ["o/a", "o/b"], 4);
  const ids = await startWorkflows(db, [wf("o/a", 1, { weight: 5 }), wf("o/a", 2, { weight: 8, startedBy: "bob" }), wf("o/b", 1, { weight: 8, approvedBy: "cat", approvedVia: "cli" }), wf("o/b", 9, { weight: 5 })]);
  await q.run(k.insertInto("main.implementations").values({ repo: "o/a", number: 3, queued_by: "ann", state: "pr-open", attempt: 1, text_hash: "h", pr_number: 4, created_at: AT, updated_at: AT }));
  await startWorkflows(db, [wf("o/a", 3, { entry: "implement", kind: "issue", weight: 2 })]);
  const scores = await loadWorkScores(db, [1, 2, 3, 4].map((number) => ({ repo: "o/a", number })));
  assert.ok(scores.get("o/a#2")! > scores.get("o/a#1")!, "weight first");
  assert.ok(scores.get("o/a#1")! > scores.get("o/a#4")!, "the weight-5 start outranks the weight-2 implementation PR");
  assert.ok(scores.has("o/a#4"), "an implementation PR takes its issue's workflow");
  for (const [weight, before] of [[10, true], [5, true], [3, true], [2, false], [1, false]] as const) {
    await saveWorkflows(db, [{ id: ids.get("o/a#1")!, patch: { weight }, at: AT }]);
    const s = (await loadWorkScores(db, [{ repo: "o/a", number: 1 }])).get("o/a#1")!;
    assert.equal(s > NO_WORKFLOW_SCORE, before, `weight ${weight} against unstarted work`);
    assert.equal(s, workScore({ id: ids.get("o/a#1")!, weight }), "the planner's order is the queues'");
    assert.equal((await loadWorkWeights(db, [{ repo: "o/a", number: 1 }])).get("o/a#1"), weight);
  }
  await saveWorkflows(db, [{ id: ids.get("o/a#1")!, patch: { weight: 5 }, at: AT }]);
  const positions = await loadQueuePositions(db);
  assert.deepEqual([...positions.keys()], ["o/a#2", "o/b#1", "o/a#1", "o/a#3"].filter((r) => positions.has(r)));
  assert.equal(positions.get("o/a#2")!.position, 1);
  assert.ok([...positions.values()].every((p) => p.of === positions.size), "o/b#9 is not an open item; the list counts open ones");
  const onlyB = await loadQueuePositions(db, { repos: ["o/b"] });
  assert.equal(onlyB.get("o/b#1")!.position, positions.get("o/b#1")!.position, "a repo filter narrows the rows, not the positions");
  assert.deepEqual([...await loadStartedRefs(db, { login: "BOB" })], ["o/a#2"]);
  assert.deepEqual([...await loadStartedRefs(db, { login: "cat" })], ["o/b#1"]);
  assert.ok((await loadStartedRefs(db, { login: "ann", repos: ["o/a"] })).has("o/a#4"));
  const work = await loadStartedWork(db);
  assert.equal(work.live.length, 5);
  assert.deepEqual(work.prs.map((p) => p.pr), [4]);
  // An attempt that ended while its workflow goes on: the PR is the started work of the same people.
  await q.run(k.updateTable("main.implementations").set({ state: "closed", updated_at: "2026-01-01T01:00:00.000Z" }).where("number", "=", 3));
  assert.deepEqual((await loadStartedWork(db)).prs.map((p) => p.pr), [4]);
  await recordEvents(db, [{ workflowId: ids.get("o/b#9")!, repo: "o/b", number: 9, login: "cy", kind: "answered" }]);
  const pairs = await loadActingPairs(db);
  assert.ok(pairs.some((p) => p.login === "cy" && p.repo === "o/b"), "who answered a workflow of any entry");
  assert.ok(pairs.some((p) => p.login === "cat" && p.repo === "o/b") && pairs.some((p) => p.login === "bob" && p.repo === "o/a"));
  assert.equal(new Set(pairs.map((p) => `${p.login}@${p.repo}`)).size, pairs.length, "pairs are distinct");
  assert.equal(ids.size, 4);
});

both("loadPathEnds reads how the approved path of each workflow ended", async ({ db }) => {
  const ids = await startWorkflows(db, [wf("o/a", 1, { approvedBy: "ann", approvedVia: "cli" }), wf("o/a", 2, { approvedBy: "ann", approvedVia: "cli" }), wf("o/a", 3, { approvedBy: "ann", approvedVia: "cli" }), wf("o/a", 4, { approvedBy: "ann", approvedVia: "cli" })]);
  await saveWorkflows(db, [{ id: ids.get("o/a#2")!, patch: { state: "done" } }, { id: ids.get("o/a#3")!, patch: { state: "stopped" } }, { id: ids.get("o/a#4")!, patch: { approvedBy: null, approvedAt: null } }]);
  const ends = await loadPathEnds(db, [1, 2, 3, 4].map((n) => ({ workflowId: ids.get(`o/a#${n}`)!, approvedAt: AT })).concat([{ workflowId: 999, approvedAt: AT }]));
  assert.deepEqual([ends.get(ids.get("o/a#1")!), ends.get(ids.get("o/a#2")!), ends.get(ids.get("o/a#3")!), ends.get(ids.get("o/a#4")!), ends.get(999)], [null, "merged", null, "stopped", "stopped"], "a held one goes on");
  await startWorkflows(db, [wf("o/a", 3)]);
  assert.equal((await loadPathEnds(db, [{ workflowId: ids.get("o/a#3")!, approvedAt: AT }])).get(ids.get("o/a#3")!), "stopped", "other work took its place");
});

// ---- statements do not grow with the number of items ------------------------------------------------------------

async function seeded(n: number): Promise<{ db: Db; run(): Promise<unknown>; close(): Promise<void> }> {
  const o = await openApp("sqlite");
  const rows = refs(n).map((r) => wf(r.repo, r.number));
  await startWorkflows(o.db, rows);
  await recordEvents(o.db, rows.map((r) => ({ workflowId: null, repo: r.repo, number: r.number, login: "ann", kind: "started" as const, via: "cli" as const, at: AT })));
  const keys = refs(n);
  return {
    db: o.db, close: () => o.t.close(),
    run: async () => {
      await loadWorkflowFacts(o.db, keys);
      await loadWorkScores(o.db, keys);
      await loadWorkflowHistory(o.db, keys);
      await loadEvents(o.db, keys, { lastPerRef: 3 });
      await loadLastEventKinds(o.db, keys);
      await loadQueuePositions(o.db);
      await loadStartedRefs(o.db, { refs: keys });
    },
  };
}

both("the workflow loaders issue as many statements for 40 items as for 4", async () => {
  await expectFlat(seeded, 4, 40);
});
