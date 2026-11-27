import { test } from "node:test";
import assert from "node:assert/strict";
import { queryDb } from "../../src/db/query-db.ts";
import {
  addLogChunks, addStats, countJobs, dropLogChunks, isRunning, loadActiveJobsOfItems, loadFailedJobsOfItems, loadItemJobTrail, loadItemsByBucket, loadItemsSince, loadJobDetail, loadJobItems, loadJobStamp,
  loadJobState, loadLastJobPerStep, loadLiveBoard, loadLogTail, loadPrunable, loadQueuePositions, loadStageStates, loadStepDurations, loadStepQueryStats, loadStepRuns, pruneLogChunks, pruneStats, removeJobs,
} from "../../src/data/jobs/index.ts";
import { expectFlat } from "../helpers/query-count.ts";
import { both, flat, seedJobs } from "./jobs-fixture.ts";

const refsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ repo: "app", number: i + 1 }));
const at = "2026-01-01T00:00:00.000Z";

/** Gives each of `n` items a done job with an item row, a queued job and a failed one that crashed before writing an item row. */
async function seedItemJobs(db: Parameters<typeof seedJobs>[0], n: number): Promise<void> {
  const q = queryDb(db);
  for (let i = 1; i <= n; i++) {
    const [done] = await seedJobs(db, [{ step: "review", state: "done", repo: "app", params: { repo: "app", number: i } }]);
    await seedJobs(db, [
      { step: "verify", state: "queued", repo: "app", params: { repo: "app", number: i } },
      { step: "verify", state: "running", repo: "app", params: { repo: "app", number: i } },
      { step: "merge", state: "failed", repo: "app", params: { repo: "app", number: i }, ended_at: new Date().toISOString() },
    ]);
    await q.run(q.k.insertInto("job_items").values({ job_id: done!, repo: "app", number: i, outcome: "ok", at }));
  }
}

both("item loaders key their rows by repo#number: job trail, active jobs, crashed jobs without an item row, positions", async (db) => {
  await seedItemJobs(db, 3);
  const trail = await loadItemJobTrail(db, refsOf(3), { states: ["done"] });
  assert.deepEqual([...trail.keys()].sort(), ["app#1", "app#2", "app#3"]);
  assert.deepEqual(trail.get("app#2")!.map((r) => [r.step, r.state, r.outcome]), [["review", "done", "ok"]]);
  const active = await loadActiveJobsOfItems(db, refsOf(2));
  assert.deepEqual(active.get("app#1")!.map((j) => j.state), ["queued", "running"]);
  const failed = await loadFailedJobsOfItems(db, refsOf(3), "2000-01-01T00:00:00.000Z");
  assert.equal(failed.get("app#3")!.length, 1);
  const queued = [...active.values()].flat().filter((j) => j.state === "queued").map((j) => j.id);
  const pos = await loadQueuePositions(db, queued);
  assert.deepEqual([...pos.values()].sort(), [1, 2]);
  assert.deepEqual([...await loadQueuePositions(db)].length, 3);
  const stamp = await loadJobStamp(db, "app", [{ repo: "app", number: 1 }]);
  assert.deepEqual([stamp.count, stamp.states, stamp.positions.size], [2, "queued,running", 1]);
  assert.equal((await loadJobStamp(db, "app")).count, 6);
  return [stamp.count];
});

test("item and job set loaders read the same number of statements for 2 and 12 keys", async () => {
  const loaders: [string, (db: Parameters<typeof seedJobs>[0], n: number) => Promise<unknown>][] = [
    ["loadItemJobTrail", (db, n) => loadItemJobTrail(db, refsOf(n))],
    ["loadActiveJobsOfItems", (db, n) => loadActiveJobsOfItems(db, refsOf(n))],
    ["loadFailedJobsOfItems", (db, n) => loadFailedJobsOfItems(db, refsOf(n), at)],
    ["loadJobStamp", (db, n) => loadJobStamp(db, "app", refsOf(n))],
    ["loadJobItems", async (db, n) => loadJobItems(db, Array.from({ length: n }, (_, i) => i + 1))],
    ["loadQueuePositions", async (db, n) => loadQueuePositions(db, Array.from({ length: n }, (_, i) => i + 1))],
    ["loadStageStates", (db, n) => loadStageStates(db, Array.from({ length: n }, (_, i) => ({ n: i, steps: ["review", `s${i}`] })))],
    ["loadStepDurations", (db, n) => loadStepDurations(db, Array.from({ length: n }, (_, i) => `s${i}`))],
    ["loadLastJobPerStep", (db, n) => loadLastJobPerStep(db, Array.from({ length: n }, (_, i) => `s${i}`), ["x"])],
    ["loadItemsSince", (db, n) => loadItemsSince(db, Array.from({ length: n }, (_, i) => `s${i}`), Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}`, at])))],
    ["isRunning", (db, n) => isRunning(db, Array.from({ length: n }, (_, i) => ({ step: "verify", repo: `r${i}` })))],
    ["countJobs", (db, n) => countJobs(db, ["queued", "running", "done", "failed", "cancelled"].slice(0, 2 + (n > 2 ? 3 : 0)) as never)],
  ];
  for (const [name, load] of loaders) {
    try {
      await expectFlat(flat(async (db, size) => { await seedItemJobs(db, size); return async () => void await load(db, size); }), 2, 12);
    } catch (e) {
      (e as Error).message = `${name}: ${(e as Error).message}`;
      throw e;
    }
  }
});

both("stage states, counts, last jobs, durations, step history and queue lookups read the jobs table in groups", async (db) => {
  const [r1] = await seedJobs(db, [{ step: "review", state: "running", repo: "app" }, { step: "merge", state: "queued", repo: "secret" }, { step: "verify", state: "failed" }, { step: "verify", state: "done" }, { step: "classify", state: "done", requested_by: "pipeline" }]);
  const states = await loadStageStates(db, [{ n: 1, steps: ["review"] }, { n: 2, steps: ["merge"] }, { n: 3, steps: ["verify"] }, { n: 4, steps: ["classify", "x"] }, { n: 5, steps: ["x"] }]);
  assert.deepEqual([...states.values()], ["running", "queued", "ok", "ok", "idle"]);
  const counts = await countJobs(db, ["queued", "running", "cancelled"], ["secret"]);
  assert.deepEqual([...counts], [["queued", 0], ["running", 1], ["cancelled", 0]]);
  assert.equal((await loadLastJobPerStep(db, ["merge", "review"], ["secret"])).has("merge"), false);
  assert.equal((await loadLastJobPerStep(db, ["verify"])).get("verify")!.state, "done");
  const q = queryDb(db);
  await q.run(q.k.updateTable("jobs").set({ started_at: "2026-01-01T00:00:00.000Z", ended_at: "2026-01-01T00:00:03.000Z" }).where("step", "=", "classify"));
  assert.deepEqual((await loadStepDurations(db, ["classify", "none"])).get("classify"), [3000]);
  assert.equal((await loadStepRuns(db, { requestedBy: "pipeline", sinceDays: 36500, window: 100, last: 3, nowMs: Date.now() })).length, 3);
  assert.deepEqual(await loadJobState(db, r1!), { state: "running", summary: null, error: null });
  assert.deepEqual([...await isRunning(db, [{ step: "review", repo: "app" }, { step: "review", repo: "lib" }])], ["review\0app"]);
  assert.deepEqual((await loadItemsSince(db, ["review", "verify"], { review: at })).size, 1);
  const buckets = await loadItemsByBucket(db, "2025-01-01", "2027-01-01", "day", ["nope"]);
  assert.ok(buckets.every((b) => b.bucket.length === 10));
  return [...states.values()];
});

both("the live board lists running, queued and recent jobs with their items, a viewer's hidden repos and quiet steps left out", async (db) => {
  const [run, done, quiet] = await seedJobs(db, [{ step: "review", state: "running", repo: "app" }, { step: "verify", state: "done", repo: "app", ended_at: new Date().toISOString() }, { step: "sync", state: "done", ended_at: new Date().toISOString() }]);
  await seedJobs(db, [{ step: "merge", state: "queued", repo: "secret" }, { step: "merge", state: "queued", repo: "app" }]);
  const q = queryDb(db);
  await q.run(q.k.insertInto("job_items").values([{ job_id: run!, repo: "app", number: 1, outcome: "a", at }, { job_id: run!, repo: "secret", number: 2, outcome: "b", at }, { job_id: done!, repo: "app", number: 3, outcome: "c", at }]));
  const board = await loadLiveBoard(db, { quietSteps: ["sync"], recentMs: 3_600_000, queuedMax: 5, recentMax: 5, hidden: ["secret"] });
  assert.deepEqual([board.running.length, board.queued.length, board.recent.map((j) => j.id)], [1, 1, [done]]);
  assert.deepEqual(board.items.get(run!)!.map((i) => i.number), [1]);
  assert.equal(board.recent.some((j) => j.id === quiet), false);
  return board.recent.length;
});

test("the live board reads the same number of statements for 2 and 12 jobs", async () => {
  await expectFlat(flat(async (db, size) => {
    await seedItemJobs(db, size);
    return async () => { await loadLiveBoard(db, { quietSteps: [], recentMs: 3_600_000, queuedMax: 50, recentMax: 50 }); };
  }), 2, 12);
});

test("a job's detail reads its row, items and log in one wave and hides a hidden repo's job", async () => {
  const { withDb } = await import("./jobs-fixture.ts");
  await withDb("sqlite", async (db) => {
    const [id, secret] = await seedJobs(db, [{ state: "done", repo: "app" }, { state: "done", repo: "secret" }]);
    const q = queryDb(db);
    await q.run(q.k.insertInto("job_items").values({ job_id: id!, repo: "app", number: 1, outcome: "ok", at }));
    await addLogChunks(db, [{ job_id: id!, seq: 1, start: 0, next_start: 6, chunk: "hello\n", at }]);
    const d = await loadJobDetail(db, id!, { logs: true, hidden: ["secret"] });
    assert.deepEqual([d!.items.length, d!.logTail?.log], [1, "hello\n"]);
    assert.equal((await loadJobDetail(db, id!, { logs: false }))!.logTail, null);
    assert.equal(await loadJobDetail(db, secret!, { logs: true, hidden: ["secret"] }), null);
  });
});

both("log chunks: the tail stops at the byte cap, drops and prunes delete by job and age, removeJobs clears a job's rows", async (db) => {
  const [a, b] = await seedJobs(db, [{ state: "done", ended_at: "2020-01-01T00:00:00.000Z" }, { state: "done" }]);
  const chunk = (job: number, seq: number, text: string, when = at) => ({ job_id: job, seq, start: (seq - 1) * 100, next_start: seq * 100, chunk: text, at: when });
  await addLogChunks(db, [chunk(a!, 1, "one\ntwo\n"), chunk(a!, 2, "three\nfour\n"), chunk(a!, 3, "five\n"), chunk(b!, 1, "b1\n", "2020-01-01T00:00:00.000Z")]);
  assert.deepEqual(await loadLogTail(db, a!, 1000), { log: "one\ntwo\nthree\nfour\nfive\n", logTruncated: false });
  const small = await loadLogTail(db, a!, 8);
  assert.equal(small!.logTruncated, true);
  assert.ok(small!.log.endsWith("five\n"));
  assert.equal(await loadLogTail(db, 999, 10), null);
  assert.equal(await dropLogChunks(db, [{ job: a!, upTo: 2 }]), 2);
  assert.equal((await loadLogTail(db, a!, 1000))!.logTruncated, true, "the first kept chunk starts past 0");
  assert.equal(await pruneLogChunks(db, "2021-01-01T00:00:00.000Z", 10), 1);
  assert.deepEqual((await loadPrunable(db, "2021-01-01T00:00:00.000Z", 10)).map((r) => r.id), [a]);
  assert.equal(await removeJobs(db, [a!]), 1);
  assert.equal(await loadLogTail(db, a!, 100), null);
  return null;
});

test("log tail and drop read and delete in one statement for 2 and 12 jobs", async () => {
  await expectFlat(flat(async (db, size) => {
    const ids = await seedJobs(db, Array.from({ length: size }, () => ({ state: "done" as const })));
    await addLogChunks(db, ids.flatMap((id) => [1, 2, 3].map((seq) => ({ job_id: id, seq, start: seq, next_start: seq + 1, chunk: "x\n", at }))));
    return async () => { await dropLogChunks(db, ids.map((job) => ({ job, upTo: 1 }))); await removeJobs(db, ids); };
  }), 2, 12);
});

both("db stats add up per scope and minute, and per-job counts are read back for the health check", async (db) => {
  await addStats(db, [{ scope: "runner-tick", minute: "2026-01-01T00:00", statements: 2, round_trips: 1, ms: 5, calls: 1 }, { scope: "runner-tick", minute: "2026-01-01T00:00", statements: 3, round_trips: 1, ms: 5, calls: 1 }]);
  await addStats(db, [{ scope: "runner-tick", minute: "2026-01-01T00:00", statements: 1, round_trips: 0, ms: 1, calls: 1 }]);
  const q = queryDb(db);
  const row = await q.get(q.k.selectFrom("db_stats").select(["statements", "round_trips", "ms", "calls"]));
  assert.deepEqual(row, { statements: 6, round_trips: 2, ms: 11, calls: 3 });
  assert.equal(await pruneStats(db, "2026-02-01T00:00"), 1);
  const [id] = await seedJobs(db, [{ state: "done", started_at: new Date().toISOString(), items: 2 }]);
  await q.run(q.k.updateTable("jobs").set({ db_statements: 9, db_round_trips: 3, db_ms: 4, effects: 1 }).where("id", "=", id!));
  assert.deepEqual((await loadStepQueryStats(db, 1)).map((r) => [r.items, r.effects, r.statements]), [[2, 1, 9]]);
  return row;
});

both("the step runs are the newest of each step, with every done one where the newest all failed", async (db) => {
  const ended = new Date().toISOString();
  const run = (step: string, states: string) => [...states].map((c) => ({ step, state: c === "d" ? "done" : "failed", requested_by: "pipeline", ended_at: ended, error: c === "s" ? "runner restarted" : null }));
  await seedJobs(db, [...run("ok", "ddfdd"), ...run("stuck", "dfddfff"), ...run("other", "fff"), ...run("few", "f")] as never);
  const rows = await loadStepRuns(db, { requestedBy: "pipeline", sinceDays: 1, window: 1000, last: 3, nowMs: Date.now() });
  const of = (step: string) => rows.filter((r) => r.step === step).map((r) => r.state[0]).join("");
  assert.deepEqual(["ok", "stuck", "other", "few"].map(of), ["ddf", "fffddd", "fff", "f"]);
  assert.deepEqual(rows.map((r) => r.id), rows.map((r) => r.id).sort((a, b) => b - a));
  return rows.length;
});
