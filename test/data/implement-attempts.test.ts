// implement module: attempt writers, facts and view loaders (SQLite; Postgres when AUTOCRAFT_TEST_PG_URL is set).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db, Dialect } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import { TEST_PG_URL, testDatabase } from "../test-db.ts";
import { expectFlat } from "../helpers/query-count.ts";
import {
  loadImplementFacts, loadImplementStamps, loadImplementationRepos, loadImplementationView, loadPlanReplyOfCall, loadStuckStreaks,
  recordAnswers, recordSteps, restartAttempt, retryRevision, startAttempt, startAttempts,
} from "../../src/data/implement/index.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T00:00:00.000Z";

async function withDb(dialect: Dialect, fn: (db: Db) => Promise<unknown>): Promise<unknown> {
  const t = await testDatabase("", dialect);
  try { return await fn(await t.open({ app: true })); } finally { await t.close(); }
}

/** Runs on SQLite, and on Postgres when a server is configured. */
function both(name: string, fn: (db: Db) => Promise<unknown>): void {
  test(name, async () => {
    const lite = await withDb("sqlite", fn);
    if (TEST_PG_URL) assert.deepEqual(await withDb("postgres", fn), lite);
  });
}

const row = (n: number, o: Partial<{ repo: string; textHash: string }> = {}) => ({ repo: o.repo ?? "app", number: n, queuedBy: "dev", textHash: o.textHash ?? "h1" });
const issues = (n: number) => Array.from({ length: n }, (_, i) => ({ repo: "app", number: i + 1 }));

async function seedOpenIssues(db: Db, nums: number[]): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.items").values(nums.map((n) => ({ repo: "app", number: n, kind: "issue", state: "OPEN" }))));
}

both("startAttempts numbers attempts per issue, refuses an issue with a current attempt and rejects a repeated issue", async (db) => {
  const a = await startAttempts(db, [row(1), row(2)], T0);
  assert.deepEqual(a.started.map((r) => [r.number, r.attempt, r.state]).sort(), [[1, 1, "planning"], [2, 1, "planning"]]);
  const again = await startAttempts(db, [row(1), row(3)], T0);
  assert.deepEqual(again.started.map((r) => r.number), [3]);
  assert.equal(again.refused.length, 1);
  assert.equal(again.refused[0]!.ref, "app#1");
  assert.equal(again.refused[0]!.current.state, "planning");
  await assert.rejects(startAttempts(db, [row(5), row(5)]), /one issue/);
  // After the current attempt ends the next one counts on.
  await recordSteps(db, [{ id: a.started.find((r) => r.number === 1)!.id, to: "failed" }], T0);
  assert.equal((await startAttempt(db, row(1), T1))!.attempt, 2);
  assert.equal(await startAttempt(db, row(1), T1), null);
});

both("recordSteps writes only the patch's columns, guards the move and adds rounds of applied steps in order", async (db) => {
  const [a, b] = (await startAttempts(db, [row(1), row(2)], T0)).started;
  const r = await recordSteps(db, [
    { id: a!.id, expect: ["planning"], to: "planned", patch: { branch: "x", planMd: "p" }, addRounds: [{ kind: "plan", callId: 7, result: { n: 1 } }, { kind: "session" }] },
    { id: b!.id, expect: ["implementing"], to: "checking", addRounds: [{ kind: "checks" }] },
  ], T1);
  assert.equal(r.applied.get(a!.id), true);
  assert.equal(r.applied.get(b!.id), false);
  assert.equal(r.roundIds.get(a!.id)!.length, 2);
  assert.ok(r.roundIds.get(a!.id)![0]! < r.roundIds.get(a!.id)![1]!);
  assert.equal(r.roundIds.get(b!.id), undefined);
  const v = (await loadImplementationView(db, "app#1"))!;
  assert.equal(v.impl.state, "planned");
  assert.equal(v.impl.branch, "x");
  assert.equal(v.impl.updatedAt, T1);
  assert.deepEqual(v.rounds.map((x) => x.kind), ["plan", "session"]);
  assert.equal(v.rounds[0]!.callId, 7);
  assert.deepEqual(v.rounds[0]!.result, { n: 1 });
  assert.equal((await loadImplementationView(db, "app#2"))!.impl.state, "planning");
  // A key left out of the patch stays; null clears; a round's result is replaced in place.
  await recordSteps(db, [{ id: a!.id, patch: { branch: null }, setRounds: [{ id: r.roundIds.get(a!.id)![0]!, result: { n: 2 } }] }], T1);
  const w = (await loadImplementationView(db, "app#1"))!;
  assert.equal(w.impl.branch, null);
  assert.equal(w.impl.planMd, "p");
  assert.equal(w.impl.state, "planned");
  assert.deepEqual(w.rounds[0]!.result, { n: 2 });
});

both("the latest attempt is the current one, else the newest ended one, also for out-of-order data", async (db) => {
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.implementations").values([
    { repo: "app", number: 1, queued_by: "d", state: "failed", attempt: 3, text_hash: "h", created_at: T0, updated_at: T0 },
    { repo: "app", number: 1, queued_by: "d", state: "implementing", attempt: 1, text_hash: "h", created_at: T0, updated_at: T0 },
    { repo: "app", number: 2, queued_by: "d", state: "failed", attempt: 1, text_hash: "h", created_at: T0, updated_at: T0 },
    { repo: "app", number: 2, queued_by: "d", state: "cancelled", attempt: 2, text_hash: "h", created_at: T0, updated_at: T0 },
  ]));
  const f = await loadImplementFacts(db, issues(2));
  assert.equal(f.byIssue.get("app#1")!.attempt.state, "implementing");
  assert.equal(f.byIssue.get("app#2")!.attempt.attempt, 2);
  assert.equal(f.byIssue.get("app#2")!.attempt.state, "cancelled");
});

both("facts carry the open question, the answer after it, guidance, revise heads, PR attempts and text counts", async (db) => {
  const [a] = (await startAttempts(db, [row(1, { textHash: "x" })], T0)).started;
  const id = a!.id;
  await recordSteps(db, [{ id, to: "asked", addRounds: [{ kind: "question", result: { audience: "maintainer", text: "which?", options: [{ key: "a", label: "A", hint: "" }], recommended: "a", limit: true } }] }], T0);
  const q1 = (await loadImplementFacts(db, issues(1))).byIssue.get("app#1")!;
  assert.equal(q1.question!.audience, "maintainer");
  assert.equal(q1.question!.limit, true);
  assert.equal(q1.question!.recommended, "a");
  assert.equal(q1.answer, null);
  await recordAnswers(db, [{ id, question: q1.question!.round, by: "dev", via: "github", option: "a" }], T1);
  const q2 = (await loadImplementFacts(db, issues(1))).byIssue.get("app#1")!;
  assert.equal(q2.answer!.by, "dev");
  assert.equal(q2.answer!.question, q1.question!.round);
  // A new question after the answer: the answer no longer counts.
  await recordSteps(db, [{ id, addRounds: [{ kind: "question", result: { audience: "author", text: "again" } }] }], T1);
  const q3 = (await loadImplementFacts(db, issues(1))).byIssue.get("app#1")!;
  assert.equal(q3.answer, null);
  assert.equal(q3.question!.audience, "author");
  // PR attempt, revisions and guidance.
  await recordSteps(db, [{ id, to: "revising", patch: { prNumber: 9 }, addRounds: [
    { kind: "guidance", result: { by: "dev", text: " try X " } },
    { kind: "revise", result: { prNumber: 9, head: "h1", from: "f", review: true, ci: false, message: "m" } },
    { kind: "revise", result: { prNumber: 9, head: "h2", from: "f", review: false, ci: false, message: "m2" } },
  ] }], T1);
  const f = await loadImplementFacts(db, [{ repo: "app", number: 9 }, { repo: "app", number: 1 }]);
  const i = f.byIssue.get("app#1")!;
  assert.deepEqual(i.guidance.map((g) => g.text), ["try X"]);
  assert.deepEqual(i.reviseHeads, ["h1"]);
  assert.equal(i.lastRevise!.head, "h2");
  assert.equal(i.question, null);
  assert.equal(i.prAttempts[0]!.prNumber, 9);
  assert.deepEqual(f.byPr.get("app#9")!.revisedHeads, ["h1", "h2"]);
  assert.equal(f.byPr.get("app#9")!.issue, 1);
  // A PR key alone finds its attempt; counts are loaded only for an issue with a failed or stuck attempt.
  assert.deepEqual((await loadImplementFacts(db, [{ repo: "app", number: 9 }])).byPr.get("app#9")!.state, "revising");
  assert.deepEqual(i.textCounts, {});
  await recordSteps(db, [{ id, to: "stuck" }], T1);
  await startAttempts(db, [row(1)], T1).catch(() => null);
  const s = (await loadImplementFacts(db, issues(1))).byIssue.get("app#1")!;
  assert.deepEqual(s.textCounts, { x: 1 });
});

both("restartAttempt fails the old attempt and starts the next with the guidance; retryRevision repeats the last revision with the note", async (db) => {
  const [a] = (await startAttempts(db, [row(1)], T0)).started;
  await recordSteps(db, [{ id: a!.id, to: "stuck", patch: { reason: "no change" } }], T0);
  const next = await restartAttempt(db, { id: a!.id, reason: "no change", queuedBy: "dev", textHash: "h2", guidance: { by: "dev", text: "use the helper" }, at: T1 });
  assert.equal(next.attempt, 2);
  assert.equal(next.state, "planning");
  const v = (await loadImplementationView(db, "app#1"))!;
  assert.equal(v.attempts, 2);
  assert.equal(v.impl.id, next.id);
  assert.deepEqual(v.rounds.map((r) => r.kind), ["guidance"]);
  await assert.rejects(restartAttempt(db, { id: a!.id, reason: "x", queuedBy: "dev", textHash: "h" }), /not open/);

  await recordSteps(db, [{ id: next.id, to: "stuck", patch: { prNumber: 4 }, addRounds: [{ kind: "revise", result: { prNumber: 4, head: "h", from: "f", review: true, ci: false, message: "fix it" } }] }], T1);
  assert.equal(await retryRevision(db, { id: next.id, guidance: { by: "dev", text: "careful <b>" }, at: T1 }), true);
  const w = (await loadImplementationView(db, "app#1"))!;
  assert.equal(w.impl.state, "revising");
  const last = w.rounds.filter((r) => r.kind === "revise").at(-1)!.result as { message: string };
  assert.match(last.message, /^fix it\n\nA maintainer's note/);
  assert.ok(!last.message.includes("<b>"));
  assert.equal(await retryRevision(db, { id: next.id }), false);
});

both("stamps, repos, live PRs, plan replies and stuck streaks read what the writers stored", async (db) => {
  const [a, b] = (await startAttempts(db, [row(1), row(2, { repo: "other" })], T0)).started;
  const r = await recordSteps(db, [{ id: a!.id, patch: { prNumber: 5 }, addRounds: [{ kind: "plan", callId: 11, result: "reply text" }] }], T0);
  assert.equal(r.roundIds.get(a!.id)!.length, 1);
  const st = await loadImplementStamps(db, [{ repo: "app", number: 1 }, { repo: "other", number: 2 }]);
  assert.equal(st.get("app#1")!.attempts.length, 1);
  assert.equal(st.get("app#1")!.rounds.n, 1);
  assert.equal(st.get("other#2")!.rounds.n, 0);
  const before = st.get("app#1")!.rounds.length;
  await recordSteps(db, [{ id: a!.id, setRounds: [{ id: r.roundIds.get(a!.id)![0]!, result: "a longer reply text" }] }], T0);
  assert.ok((await loadImplementStamps(db, [{ repo: "app", number: 1 }])).get("app#1")!.rounds.length > before);
  assert.equal(await loadPlanReplyOfCall(db, 11), JSON.stringify("a longer reply text"));
  assert.equal(await loadPlanReplyOfCall(db, 99), null);
  assert.deepEqual([...(await loadImplementationRepos(db, [a!.id, b!.id])).entries()].sort(), [[a!.id, "app"], [b!.id, "other"]].sort());
  // Streaks: newest first, after the repo's since, with a PR or stuck/failed.
  await recordSteps(db, [{ id: b!.id, to: "failed" }], T1);
  const streaks = await loadStuckStreaks(db, new Map([["app", T0], ["other", ""]]), 3);
  assert.deepEqual(streaks.get("other")!.map((x) => [x.number, x.state, x.prNumber]), [[2, "failed", null]]);
  assert.equal(streaks.get("app"), undefined);
  assert.equal((await loadStuckStreaks(db, new Map([["app", ""]]), 3)).get("app")!.length, 1);
});

both("live attempts per repo count open issues only", async (db) => {
  await startAttempts(db, [row(1), row(2), row(3)], T0);
  await seedOpenIssues(db, [1, 2]);
  const f = await loadImplementFacts(db, issues(3));
  assert.deepEqual([...f.liveByRepo.get("app")!].sort(), ["app#1", "app#2"]);
});

test("facts, stamps and step writes issue the same number of statements at 2 and 12 issues", async () => {
  const unit = (run: (db: Db, n: number) => Promise<unknown>) => async (size: number) => {
    const t = await testDatabase("", "sqlite");
    const db = await t.open({ app: true });
    const { started } = await startAttempts(db, Array.from({ length: size }, (_, i) => row(i + 1)), T0);
    await seedOpenIssues(db, started.map((r) => r.number));
    return { db, run: () => run(db, size), close: () => t.close(), started };
  };
  await expectFlat(unit((db, n) => loadImplementFacts(db, issues(n), { withPlans: true })), 2, 12);
  await expectFlat(unit((db, n) => loadImplementStamps(db, issues(n))), 2, 12);
  await expectFlat(async (size) => {
    const u = await unit(async () => {})(size);
    return { ...u, run: () => recordSteps(u.db, u.started.map((r) => ({ id: r.id, expect: ["planning" as const], to: "planned" as const, patch: { planMd: "p" }, addRounds: [{ kind: "plan" as const }] })), T1) };
  }, 2, 12);
  await expectFlat(unit((db, n) => startAttempts(db, Array.from({ length: n }, (_, i) => row(100 + i)), T1)), 2, 12);
});
