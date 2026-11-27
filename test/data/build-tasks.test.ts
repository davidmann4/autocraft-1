// build module, part a: task queue writers and loaders, logs, artifacts, pod runs (SQLite; Postgres when AUTOCRAFT_TEST_PG_URL is set).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db, Dialect } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import { TEST_PG_URL, testDatabase } from "../test-db.ts";
import { expectFlat } from "../helpers/query-count.ts";
import {
  addArtifact, appendTaskLogs, claimRun, claimTasks, createTasks, finishTask, hasWarmBuild, loadArtifactFiles, loadArtifacts, loadEnvPass, loadLogTails, loadOpenTasks,
  loadQueuedStats, loadStandaloneTasks, loadTasks, loadTaskStates, loseTasks, MAX_QUEUED, QueueFullError, reapStaleTasks, releaseClaims, savePodRuns, TaskAccessError,
} from "../../src/data/build/index.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const SHA = "a".repeat(40);

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

const k = (db: Db) => queryDb(db).k as any;
const newTask = (i: number, over: Record<string, unknown> = {}) => ({ step: "verify", repo: "app", number: i, headSha: SHA, plan: [{ name: "build", cmd: ["true"], network: "none" as const, timeoutSec: 60 }], ...over });

async function env(db: Db, id = "pods", kind = "kubernetes"): Promise<void> {
  await queryDb(db).run(k(db).insertInto("build_envs").values({ id, label: id, kind, slots: 4, key_hash: "none", created_at: T0 }));
}

async function seedRuns(db: Db, n: number): Promise<void> {
  await env(db);
  const ids = await createTasks(db, Array.from({ length: n }, (_, i) => newTask(i + 1)));
  for (const id of ids) await claimRun(db, { envId: "pods", taskId: id, keyHash: "h", pvc: `pvc-${id}`, stage: 0, at: T0 });
}

both("createTasks refuses the whole set past the queue cap and returns ids in order", async (db) => {
  const first = await createTasks(db, Array.from({ length: MAX_QUEUED - 1 }, (_, i) => newTask(i + 1)));
  assert.equal(first.length, MAX_QUEUED - 1);
  assert.deepEqual([...first].sort((a, b) => a - b), first);
  await assert.rejects(createTasks(db, [newTask(1001), newTask(1002)]), QueueFullError);
  assert.equal((await loadQueuedStats(db, {})).n, MAX_QUEUED - 1);
  assert.equal((await createTasks(db, [newTask(1003)])).length, 1);
  return (await loadQueuedStats(db, {})).n;
});

both("two claims never take the same task and a lost race claims none", async (db) => {
  await env(db, "w1", "remote");
  await env(db, "w2", "remote");
  const ids = await createTasks(db, [newTask(1), newTask(2), newTask(3)]);
  const a = await claimTasks(db, "w1", ids.slice(0, 2).map((id) => ({ id })), T0);
  const b = await claimTasks(db, "w2", ids.slice(1).map((id) => ({ id })), T0);
  assert.deepEqual(a, ids.slice(0, 2));
  assert.deepEqual(b, [ids[2]]);
  const run = await claimRun(db, { envId: "w1", taskId: ids[0]!, keyHash: "h", pvc: null, stage: 0, at: T0 });
  assert.equal(run, null);
  return [...(await loadTasks(db, ids)).values()].map((t) => [t.envId, t.state, t.attempts]);
});

both("claimRun makes the task running with its pod run in one step; releaseClaims queues it again without counting the claim", async (db) => {
  await env(db);
  const [id] = await createTasks(db, [newTask(1)]);
  const got = await claimRun(db, { envId: "pods", taskId: id!, keyHash: "h", pvc: "pvc", stage: 1, at: T0 });
  assert.equal(got?.task.state, "running");
  assert.equal(got?.task.startedAt, got?.task.claimedAt);
  assert.equal(got?.run.pvc, "pvc");
  assert.equal(await releaseClaims(db, "pods", [id!]), 1);
  const t = (await loadTasks(db, [id!])).get(id!)!;
  assert.equal(t.state, "queued");
  assert.equal(t.attempts, 0);
  return t.envId;
});

both("appendTaskLogs numbers chunks after the newest, cuts at the cap and refuses a task that is not running here", async (db) => {
  await env(db, "w1", "remote");
  const [id] = await createTasks(db, [newTask(1)]);
  await assert.rejects(appendTaskLogs(db, "w1", id!, "build", ["x"]), (e) => e instanceof TaskAccessError && e.status === 409);
  await claimTasks(db, "w1", [{ id: id! }], T0);
  await appendTaskLogs(db, "w1", id!, "build", ["a\n", "b\n"]);
  await appendTaskLogs(db, "w1", id!, "test", ["c\n"]);
  const rows = await queryDb(db).all(k(db).selectFrom("build_task_logs").select(["seq", "step", "chunk"]).where("task_id", "=", id).orderBy("seq"));
  assert.deepEqual(rows.map((r: any) => Number(r.seq)), [1, 2, 3]);
  assert.deepEqual(rows.map((r: any) => r.step), ["build", "build", "test"]);
  await queryDb(db).run(k(db).updateTable("build_tasks").set({ log_bytes: 20 * 1024 * 1024 - 3 }).where("id", "=", id));
  const cut = await appendTaskLogs(db, "w1", id!, "test", ["12345", "never"]);
  assert.equal(cut.truncated, true);
  assert.equal(cut.logBytes, 20 * 1024 * 1024);
  const last = await queryDb(db).get(k(db).selectFrom("build_task_logs").select("chunk").where("task_id", "=", id).orderBy("seq", "desc").limit(1));
  assert.match((last as any).chunk, /^123\n\[log truncated/);
  return rows.length;
});

both("loadLogTails returns the chunks the byte-budget loop of the old code kept", async (db) => {
  await env(db, "w1", "remote");
  const [id] = await createTasks(db, [newTask(1)]);
  await claimTasks(db, "w1", [{ id: id! }], T0);
  const chunks = Array.from({ length: 30 }, (_, i) => `line ${i} ${"é".repeat(i % 7)}\n`);
  await appendTaskLogs(db, "w1", id!, "build", chunks);
  const budget = 120;
  let size = 0;
  const parts: string[] = [];
  for (const c of [...chunks].reverse()) {
    parts.push(c);
    size += Buffer.byteLength(c);
    if (size >= budget) break;
  }
  const joined = parts.reverse().join("");
  const want = size > budget ? Buffer.from(joined).subarray(-budget).toString("utf8") : joined;
  const got = (await loadLogTails(db, [{ id: id! }], { maxBytes: budget })).get(id!)!;
  assert.equal(got.text, want);
  assert.ok(got.truncated);
  const stepOnly = (await loadLogTails(db, [{ id: id!, step: "none" }], { maxBytes: budget })).get(id!)!;
  assert.equal(stepOnly.text, "");
  return got.text;
});

both("a task that loses its worker is requeued once, then failed; a cancelled one stays cancelled", async (db) => {
  await env(db, "w1", "remote");
  const ids = await createTasks(db, [newTask(1), newTask(2)]);
  await claimTasks(db, "w1", ids.map((id) => ({ id })), T0);
  await queryDb(db).run(k(db).updateTable("build_tasks").set({ cancel_requested_at: T0 }).where("id", "=", ids[1]));
  const first = await loseTasks(db, ids.map((id) => ({ id, reason: "gone" })), Date.parse(T0));
  assert.equal(first.lost, 2);
  const s1 = await loadTaskStates(db, ids);
  assert.deepEqual([s1.get(ids[0]!)!.state, s1.get(ids[1]!)!.state], ["queued", "cancelled"]);
  await claimTasks(db, "w1", [{ id: ids[0]! }], T0);
  await loseTasks(db, [{ id: ids[0]!, reason: "gone" }], Date.parse(T0));
  const t = (await loadTasks(db, [ids[0]!])).get(ids[0]!)!;
  assert.equal(t.state, "failed");
  assert.equal(t.summary, "gone");
  return [t.state, s1.get(ids[1]!)!.state];
});

both("finishTask decides the state in one update and answers a retried finish with the first state", async (db) => {
  await env(db, "w1", "remote");
  const [id] = await createTasks(db, [newTask(1)]);
  await claimTasks(db, "w1", [{ id: id! }], T0);
  const ok = { results: [{ step: "build", exitCode: 0, durationMs: 5, timedOut: false }], summary: null, sandbox: null, failed: false };
  assert.equal((await finishTask(db, "w1", id!, ok)).state, "done");
  assert.equal((await finishTask(db, "w1", id!, { ...ok, failed: true })).state, "done");
  await assert.rejects(finishTask(db, "w2", id!, ok), TaskAccessError);
  return "done";
});

both("reapStaleTasks loses only tasks without a pod run that stopped heartbeating", async (db) => {
  await env(db, "w1", "remote");
  await env(db);
  const ids = await createTasks(db, [newTask(1), newTask(2), newTask(3)]);
  await claimTasks(db, "w1", [{ id: ids[0]! }, { id: ids[1]! }], T0);
  await claimRun(db, { envId: "pods", taskId: ids[2]!, keyHash: "h", pvc: "p", stage: 0, at: T0 });
  await queryDb(db).run(k(db).updateTable("build_tasks").set({ heartbeat_at: "2026-01-01T00:10:00.000Z" }).where("id", "=", ids[1]));
  const r = await reapStaleTasks(db, Date.parse("2026-01-01T00:11:00.000Z"));
  assert.equal(r.lost, 1);
  const s = await loadTaskStates(db, ids);
  assert.deepEqual([s.get(ids[0]!)!.state, s.get(ids[1]!)!.state, s.get(ids[2]!)!.state], ["queued", "claimed", "running"]);
  return r.lost;
});

both("addArtifact checks the limits against the task and replaces a row of the same name", async (db) => {
  const [id] = await createTasks(db, [newTask(1)]);
  const limits = { maxCount: 2, maxBytes: 100 };
  assert.deepEqual(await addArtifact(db, { taskId: id!, name: "a", bytes: 60, contentType: "text/plain", file: "f1" }, limits), { ok: true });
  assert.deepEqual(await addArtifact(db, { taskId: id!, name: "b", bytes: 50, contentType: "text/plain", file: "f2" }, limits), { refused: "size" });
  assert.deepEqual(await addArtifact(db, { taskId: id!, name: "a", bytes: 90, contentType: "text/plain", file: "f3" }, limits), { ok: true });
  assert.deepEqual(await addArtifact(db, { taskId: id!, name: "c", bytes: 5, contentType: "text/plain", file: "f4" }, limits), { ok: true });
  assert.deepEqual(await addArtifact(db, { taskId: id!, name: "d", bytes: 1, contentType: "text/plain", file: "f5" }, limits), { refused: "count" });
  assert.deepEqual(await addArtifact(db, { taskId: 99999, name: "d", bytes: 1, contentType: "text/plain", file: "f6" }, limits), { refused: "missing" });
  assert.equal((await loadTasks(db, [id!])).get(id!)!.artifactBytes, 95);
  const files = await loadArtifactFiles(db, [{ taskId: id!, name: "a" }, { taskId: id!, name: "zzz" }]);
  return [[...files], [...(await loadArtifacts(db, [id!])).get(id!)!.map((a) => a.name)]];
});

both("savePodRuns applies different patches in one statement per column set", async (db) => {
  await seedRuns(db, 3);
  const ids = [...(await loadEnvPass(db, "kubernetes")).tasks.get("pods")!.runs.map((r) => r.task_id)];
  await savePodRuns(db, [{ taskId: ids[0]!, patch: { pod: "p1", stage: 1 } }, { taskId: ids[1]!, patch: { pod: "p2", stage: 2 } }, { taskId: ids[2]!, patch: { node: "n1" } }]);
  const pass = await loadEnvPass(db, "kubernetes");
  const runs = pass.tasks.get("pods")!.runs;
  assert.deepEqual(runs.map((r) => [r.pod, Number(r.stage), r.node]), [["p1", 1, null], ["p2", 2, null], [null, 0, "n1"]]);
  return runs.length;
});

both("the task-ends counter moves when a task ends, not when one starts, and loadOpenTasks lists only open ones", async (db) => {
  await env(db, "w1", "remote");
  const ids = await createTasks(db, [newTask(1), newTask(2)]);
  const ends = async () => (await db.seqs())["task-ends"] ?? 0;
  const before = await ends();
  await claimTasks(db, "w1", [{ id: ids[0]! }], T0);
  assert.equal(await ends(), before);
  await finishTask(db, "w1", ids[0]!, { results: [{ step: "b", exitCode: 1, durationMs: 1, timedOut: false }], summary: null, sandbox: null, failed: false });
  assert.ok(await ends() > before);
  const open = await loadOpenTasks(db, [{ repo: "app", number: 1 }, { repo: "app", number: 2 }]);
  assert.deepEqual([...open.keys()], ["app#2"]);
  return open.get("app#2")!.length;
});

both("loadStandaloneTasks lists tasks without a job by state, or the named tasks, with the step of the newest log chunk", async (db) => {
  await env(db, "w1", "remote");
  const ids = await createTasks(db, [newTask(1), newTask(2, { repo: "hidden" }), newTask(3, { step: "fix-check" }), newTask(4), newTask(5)]);
  const [job] = await queryDb(db).all(k(db).insertInto("jobs").values({ step: "verify", params: "{}", requested_by: "pipeline", requested_at: T0, state: "running" }).returning("id")) as { id: number }[];
  await queryDb(db).run(k(db).updateTable("build_tasks").set({ job_id: job!.id }).where("id", "=", ids[3]!));
  await claimTasks(db, "w1", [{ id: ids[0]! }], T0);
  await appendTaskLogs(db, "w1", ids[0]!, "test", ["a\n"]);
  await appendTaskLogs(db, "w1", ids[0]!, "build", ["b\n"]);
  const scope = { hiddenRepos: ["hidden"], staff: true };
  const open = await loadStandaloneTasks(db, { states: ["queued", "claimed", "running"] }, scope);
  assert.deepEqual(open.map((t) => t.id), [ids[0], ids[2], ids[4]]);
  assert.equal(open[0]!.logStep, "build");
  assert.deepEqual((await loadStandaloneTasks(db, { ids }, { hiddenRepos: [], staff: false })).map((t) => t.id), [ids[0], ids[1], ids[3], ids[4]], "a private step is for staff");
  assert.deepEqual((await loadStandaloneTasks(db, { ids: [ids[3]!, ids[1]!] }, scope)).map((t) => [t.id, t.jobId]), [[ids[1], null], [ids[3], job!.id]]);
  assert.deepEqual(await loadStandaloneTasks(db, { states: ["done"] }, scope), []);
  return open.map((t) => [t.id, t.state, t.repo, t.number, t.step, t.logStep, t.results, t.summary]);
});

both("hasWarmBuild finds a warm producer of the head or one queued since, and no task that only uses the warm key", async (db) => {
  const [old] = await createTasks(db, [newTask(1, { warm: { key: "w", role: "build" } }), newTask(2, { headSha: "b".repeat(40), warm: { key: "w", role: "use" } })]);
  await queryDb(db).run(k(db).updateTable("build_tasks").set({ queued_at: T0 }).where("id", "=", old!));
  const later = "2026-01-02T00:00:00.000Z";
  const got = [await hasWarmBuild(db, "app", SHA, later), await hasWarmBuild(db, "app", "b".repeat(40), later), await hasWarmBuild(db, "app", "b".repeat(40), "2025-12-31T00:00:00.000Z"), await hasWarmBuild(db, "other", SHA, later)];
  assert.deepEqual(got, [true, false, true, false]);
  return got;
});

test("statement counts of the loaders and writers do not grow with the number of tasks", async () => {
  const unit = (run: (db: Db, n: number) => Promise<unknown>) => async (size: number) => {
    const t = await testDatabase("", "sqlite");
    const db = await t.open({ app: true });
    await env(db, "w1", "remote");
    const ids = await createTasks(db, Array.from({ length: size }, (_, i) => newTask(i + 1)));
    await claimTasks(db, "w1", ids.map((id) => ({ id })), T0);
    await appendTaskLogs(db, "w1", ids[0]!, "build", ["a\n", "b\n", "c\n"]);
    return { db, run: () => run(db, size), close: () => t.close() };
  };
  const all = (db: Db, n: number) => Array.from({ length: n }, (_, i) => i + 1).map((i) => i);
  await expectFlat(unit(async (db, n) => { await loadTasks(db, all(db, n)); await loadTaskStates(db, all(db, n)); await loadArtifacts(db, all(db, n)); }), 3, 40);
  await expectFlat(unit(async (db, n) => await loadLogTails(db, all(db, n).map((id) => ({ id })), { maxBytes: 100 })), 3, 40);
  await expectFlat(unit(async (db, n) => await loadOpenTasks(db, all(db, n).map((number) => ({ repo: "app", number })))), 3, 40);
  await expectFlat(unit(async (db, n) => await touchAll(db, n)), 3, 40);
  await expectFlat(unit(async (db, n) => await appendTaskLogs(db, "w1", 1, "x", Array.from({ length: n }, () => "chunk\n"))), 3, 40);
  await expectFlat(unit(async (db, n) => await loseTasks(db, all(db, n).map((id) => ({ id, reason: "gone" })), Date.parse(T0))), 3, 40);
});

async function touchAll(db: Db, n: number): Promise<void> {
  const { touchTasks } = await import("../../src/data/build/index.ts");
  await touchTasks(db, "w1", Array.from({ length: n }, (_, i) => i + 1), T0);
}

test("the pod pass loads in a fixed number of statements whatever the number of runs", async () => {
  await expectFlat(async (size) => {
    const t = await testDatabase("", "sqlite");
    const db = await t.open({ app: true });
    await seedRuns(db, size);
    return { db, run: () => loadEnvPass(db, "kubernetes"), close: () => t.close() };
  }, 2, 30);
});
