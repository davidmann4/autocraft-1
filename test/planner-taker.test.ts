// User-local mode: the planner proposes no Claude job for a repo that no Task Runner takes and says why; a queued job of such
// a repo shows the reason and holds neither a repo of step_parallel nor part of the daily limit.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

process.env.AUTOCRAFT_EXTRA_STEPS = fileURLToPath(new URL("./runner-steps.ts", import.meta.url));

const { connect } = await import("../src/db.ts");
const { enqueue, getJob } = await import("../src/runner/jobs.ts");
const { noRunnerFor, noRunnerForTask, setStepParallel } = await import("../src/runner/concurrency.ts");
const { applyProposals, detectAutopilot, laneCandidates, reservedByJobs } = await import("../src/runner/autopilot.ts");
const { legWait } = await import("../src/workflow/waits.ts");
const { liveWorkflow } = await import("../src/workflow/store.ts");
const { SNAPSHOT_CACHE_MS } = await import("../src/data/runners/snapshot-cache.ts");
const { createToken } = await import("../src/dash/mcp/tokens.ts");
const { parseStatus, storeStatus } = await import("../src/remote/helpers.ts");
const { setUserRepos } = await import("../src/remote/my-repos.ts");
const { setUserTasks, taskOfStep, TASK_CHOICES } = await import("../src/remote/my-tasks.ts");

mkdirSync(SCRATCH, { recursive: true });

test("a Task Runner that takes only deckcraft: deckcraft is planned, photocraft waits with a reason and blocks nothing", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "planner-taker-")), "t.db"));
  for (const r of ["deckcraft", "photocraft"]) await db.prepare("INSERT INTO tracked_repos (name, pipeline) VALUES (?, 1) ON CONFLICT (name) DO UPDATE SET pipeline = 1").run(r);
  await db.prepare("INSERT INTO access (login, role) VALUES ('olga', 'operator')").run();
  const token = (await createToken(db, "olga", "helper", { kind: "runner" })).row.id;
  await storeStatus(db, token, "olga", parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }));
  await setUserRepos(db, "olga", ["deckcraft"]);
  await setStepParallel(db, 1, "test");

  const lane = (repos: string[]) => [{ name: "model", steps: ["test-model"], perRepo: true, detect: async () => repos.map((repo) => ({ step: "test-model", params: { repo } })) }];
  const both = await detectAutopilot(db, { lanes: lane(["photocraft", "deckcraft"]) });
  assert.deepEqual(both.proposals.map((p) => p.params.repo), ["deckcraft"]);
  const photo = await detectAutopilot(db, { lanes: lane(["photocraft"]) });
  assert.equal(photo.proposals.length, 0);
  assert.equal(photo.status?.["test-model"], "No Task Runner takes photocraft");

  // An operator queues photocraft anyway: it stays queued with the reason, and neither holds the step nor its limit.
  const queued = await enqueue(db, "test-model", { repo: "photocraft", limit: 5 }, "olga");
  assert.equal((await getJob(db, queued.id)).waiting, "No Task Runner takes photocraft");
  assert.equal(await reservedByJobs(db, "test-model"), 0);
  const found = await detectAutopilot(db, { lanes: lane(["deckcraft"]) });
  const ids = await applyProposals(db, found.proposals, { lanes: lane(["deckcraft"]) });
  assert.equal(ids.length, 1, "step_parallel 1 is not taken by the photocraft job");
  assert.equal((await getJob(db, ids[0]!)).params.repo, "deckcraft");
  assert.equal((await getJob(db, ids[0]!)).waiting, null);
  assert.equal(await reservedByJobs(db, "test-model"), 5, "only the deckcraft job keeps its limit");
});

test("a Task Runner whose user unticked the step's task: nothing is planned, a queued job waits with the task as the reason", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "planner-taker-task-")), "t.db"));
  await db.prepare("INSERT INTO tracked_repos (name, pipeline) VALUES ('deckcraft', 1) ON CONFLICT (name) DO UPDATE SET pipeline = 1").run();
  await db.prepare("INSERT INTO access (login, role) VALUES ('olga', 'operator')").run();
  const token = (await createToken(db, "olga", "helper", { kind: "runner" })).row.id;
  await storeStatus(db, token, "olga", parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }));
  await setUserTasks(db, "olga", TASK_CHOICES.map((t) => t.id).filter((t) => t !== taskOfStep("test-model")));

  const lane = [{ name: "model", steps: ["test-model"], perRepo: true, detect: async () => [{ step: "test-model", params: { repo: "deckcraft" } }] }];
  const found = await detectAutopilot(db, { lanes: lane });
  assert.equal(found.proposals.length, 0);
  assert.equal(found.status?.["test-model"], noRunnerForTask("deckcraft", "test-model"));
  assert.notEqual(noRunnerForTask("deckcraft", "test-model"), noRunnerFor("deckcraft"), "the runner takes the repo: the reason names the task");
  const queued = await enqueue(db, "test-model", { repo: "deckcraft", limit: 5 }, "olga");
  assert.equal((await getJob(db, queued.id)).waiting, noRunnerForTask("deckcraft", "test-model"));
  assert.equal(await reservedByJobs(db, "test-model"), 0);
});

const T = new Date().toISOString();
const startWork = (db: Awaited<ReturnType<typeof connectDb>>, repo: string, number: number, login: string) =>
  db.prepare("INSERT INTO item_workflows (repo, number, kind, entry, state, started_by, started_at, started_via, updated_at) VALUES (?, ?, 'pr', 'review', 'running', ?, ?, 'github', ?)").run(repo, number, login, T, T);

test("a lane job starts only while a call about one of its due items has a Task Runner: started work elsewhere in the repo does not count", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "planner-taker-items-")), "t.db"));
  await db.prepare("INSERT INTO tracked_repos (name, pipeline) VALUES ('deckcraft', 1) ON CONFLICT (name) DO UPDATE SET pipeline = 1").run();
  await db.prepare("INSERT INTO access (login, role) VALUES ('olga', 'operator')").run();
  const token = (await createToken(db, "olga", "helper", { kind: "runner" })).row.id;
  await storeStatus(db, token, "olga", parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }));
  // Olga's runner does not take deckcraft; only the item she started there is hers.
  await setUserRepos(db, "olga", ["photocraft"]);
  await startWork(db, "deckcraft", 1, "olga");

  const lane = (due: { repo: string; number: number; approved: boolean }[]) => [{ name: "fixup", steps: ["fixup"], perRepo: true, detect: async () => laneCandidates("fixup", ["deckcraft"], due) }];
  const nobodys = await detectAutopilot(db, { lanes: lane([{ repo: "deckcraft", number: 2, approved: false }]) });
  assert.equal(nobodys.proposals.length, 0, "no job for an item whose call no runner would take");
  assert.equal(nobodys.status?.fixup, noRunnerFor("deckcraft"));
  const hers = await detectAutopilot(db, { lanes: lane([{ repo: "deckcraft", number: 1, approved: true }, { repo: "deckcraft", number: 2, approved: false }]) });
  assert.deepEqual(hers.proposals.map((p) => p.params.number ?? null), [1], "her item's own job, and no regular job for the other");
});

test("a started item whose next model step no Task Runner can take says so, naming its owner's runner while only that one takes it", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "planner-taker-wait-")), "t.db"));
  await db.prepare("INSERT INTO settings (key, value) VALUES ('github_identity', 'app') ON CONFLICT (key) DO UPDATE SET value = 'app'").run();
  await db.prepare("INSERT INTO access (login, role) VALUES ('mira', 'maintainer'), ('olga', 'operator')").run();
  await startWork(db, "app", 5, "mira");
  await db.prepare("INSERT INTO item_plans (repo, number, kind, head, state, actions, reasons, view, planned_at) VALUES ('app', 5, 'pr', 'h1', 'fixup', ?, '[]', '{}', ?)").run(JSON.stringify([{ kind: "fixup", head: "h1" }]), T);
  const wf = (await liveWorkflow(db, "app", 5))!;
  let at = Date.now();
  // Each read past the window the runner snapshot is kept for, so a new report shows.
  const line = async () => await legWait(db, wf, (at += 2 * SNAPSHOT_CACHE_MS));
  assert.equal(await line(), "Waiting for the fix-up: no Task Runner can take it");
  const report = async (login: string, readiness: string) => {
    const token = (await createToken(db, login, "runner", { kind: "runner" })).row.id;
    await storeStatus(db, token, login, parseStatus({ slots: 1, busy: 0, readiness, harness: "claude", models: { top: "opus", small: "haiku" }, reserve: { fiveHour: 0, weekly: 0 } }), at + 2 * SNAPSHOT_CACHE_MS);
  };
  await report("mira", "quota-held");
  assert.equal(await line(), "Waiting for mira's Task Runner (usage limit)");
  // Another runner that takes the repo and task takes the call while hers is held for its usage limit.
  await report("olga", "ready");
  assert.equal(await line(), null);
});

test("a pool job whose only unit no Task Runner takes waits for the takers, not for its other input", async () => {
  const { poolRoom } = await import("../src/agents/call.ts");
  const { pool } = await import("../src/classify/run.ts");
  const { leaseSkipKeys, NO_TAKER_SKIP, UNITS_RAN } = await import("../src/runner/leases.ts");
  const { INPUT_TOPICS } = await import("../src/runner/autopilot.ts");
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "planner-taker-pool-")), "t.db"));
  await db.prepare("INSERT INTO tracked_repos (name, pipeline) VALUES ('photocraft', 1) ON CONFLICT (name) DO UPDATE SET pipeline = 1").run();
  await db.prepare("INSERT INTO access (login, role) VALUES ('olga', 'operator')").run();
  const token = (await createToken(db, "olga", "helper", { kind: "runner" })).row.id;
  await storeStatus(db, token, "olga", parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }));
  // Olga's runner takes photocraft only for the item she started, so a verify job of the repo passes the gate but its unit on #2 has no taker.
  await setUserRepos(db, "olga", ["deckcraft"]);
  await startWork(db, "photocraft", 1, "olga");

  const lane = [{ name: "verify", steps: ["verify"], perRepo: true, detect: async () => [{ step: "verify", params: { repo: "photocraft" } }] }];
  const plan = async () => await detectAutopilot(db, { lanes: lane });
  const end = async (id: number, keys: string[]) =>
    await db.prepare("UPDATE jobs SET state = 'done', started_at = ?, ended_at = ?, lease_skips = 1, lease_skip_keys = ? WHERE id = ?").run(T, new Date().toISOString(), JSON.stringify(keys), id);
  let seq = 0;
  const unrelated = async () => {
    const before = await db.seqs();
    await db.prepare("INSERT INTO tracked_repos (name, pipeline) VALUES (?, 0)").run(`other${++seq}`);
    const after = await db.seqs();
    assert.ok(INPUT_TOPICS.some((t) => after[t] !== before[t]), "an input of the lane moved");
  };
  const queue = async () => {
    const [id] = await applyProposals(db, (await plan()).proposals, { lanes: lane });
    assert.ok(id, "the repo's job is queued");
    return id!;
  };

  // A job in which another unit ran (its builds may still be running) waits for its input as usual, not for the takers.
  await end(await queue(), [`${NO_TAKER_SKIP}photocraft#2`, `${UNITS_RAN}1`]);
  await unrelated();
  const id = await queue();

  let ran = false;
  await pool([async () => { ran = true; }], poolRoom(db, () => ["photocraft"], () => [{ repo: "photocraft", number: 2 }]), { log: () => {} });
  const keys = leaseSkipKeys().filter((k) => k.startsWith(NO_TAKER_SKIP) || k.startsWith(UNITS_RAN));
  assert.deepEqual(keys, [`${NO_TAKER_SKIP}photocraft#2`], "the unit left unstarted is recorded as a skip for want of a taker, and no unit ran");
  assert.equal(ran, false);
  await end(id, keys);

  assert.equal((await plan()).proposals.length, 0, "the idle job is not queued again");
  await unrelated();
  assert.equal((await plan()).proposals.length, 0, "input that does not change the takers leaves it parked");

  await setUserRepos(db, "olga", ["deckcraft", "photocraft"]);
  assert.deepEqual((await plan()).proposals.map((p) => p.params.repo), ["photocraft"], "the takers changed: the job runs again");
});

test("a Verify job of a repo is proposed only while a call about one of the PRs it would plan has a Task Runner", async () => {
  const { world } = await import("./world-db.ts");
  const { LANES } = await import("../src/runner/autopilot.ts");
  const w = await (await (await (await (await (await (await world()).repo()).pr(1)).review(1)).pr(2)).review(2)).pr(3);
  try {
    const db = w.db, now = new Date().toISOString();
    await db.prepare("INSERT INTO access (login, role) VALUES ('olga', 'operator') ON CONFLICT (login) DO NOTHING").run();
    const token = (await createToken(db, "olga", "helper", { kind: "runner" })).row.id;
    await storeStatus(db, token, "olga", parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }));
    // Olga's runner takes app only for the PR she started, which Verify has nothing to plan on; the repo's checks were just read.
    await setUserRepos(db, "olga", ["deckcraft"]);
    await startWork(db, "app", 3, "olga");
    await db.prepare("INSERT INTO jobs (step, params, requested_by, requested_at, state, started_at, ended_at, repo) VALUES ('checks', '{\"repo\":\"app\"}', 'pipeline', ?, 'done', ?, ?, 'app')").run(now, now, now);
    const lanes = LANES.filter((l) => l.name === "verify");

    const held = await detectAutopilot(db, { lanes });
    assert.deepEqual(held.proposals, [], "no Verify job while no Task Runner takes its PRs");
    assert.equal(held.status?.verify, noRunnerFor("app"));

    await setUserRepos(db, "olga", ["deckcraft", "app"]);
    const found = await detectAutopilot(db, { lanes });
    assert.deepEqual(found.proposals.map((p) => [p.step, p.params.repo]), [["verify", "app"]]);
    assert.equal((await applyProposals(db, found.proposals, { lanes })).length, 1, "the job is queued");
  } finally { w.close(); }
});
