// The runner on fake steps: it runs queued jobs in child processes, records
// success, failure and usage, honours cancels, recovers jobs an earlier runner
// left running, runs one job per step and repo at a time.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "../src/db/open.ts";
import { rowid } from "../src/db/kx.ts";

process.env.AUTOCRAFT_EXTRA_STEPS = fileURLToPath(new URL("./runner-steps.ts", import.meta.url));

const { connect } = await import("../src/db.ts");
const { enqueue, getJob, jobDetail, requestCancel } = await import("../src/runner/jobs.ts");
const { DEFAULT_MAX_JOBS, Runner } = await import("../src/runner/runner.ts");
const { STEPS } = await import("../src/runner/steps.ts");
const { FAKE_TOKEN } = await import("./runner-steps.ts");
const { inputHash } = await import("../src/runner/classify.ts");
const { RUNNER_STOPPED, endJob } = await import("../src/runner/jobs.ts");
const { setInferenceMode } = await import("../src/remote/mode.ts");
const { createToken } = await import("../src/dash/mcp/tokens.ts");
const { claimCall, submitCall } = await import("../src/remote/calls.ts");
const { PROTOCOL_VERSION } = await import("../src/remote/protocol.ts");
const { setCallContext } = await import("../src/agents/call.ts");
const { ghComment, resumeWritesForTests, stopWrites } = await import("../src/github/write.ts");
type GuardedItem = import("../src/core/guard.ts").GuardedItem;

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "runner-test-"));
const dbFile = join(dir, "runner.db");
const db = await connectDb(dbFile);
await db.run(db.k.insertInto("tracked_repos").values({ name: "app", pipeline: 1 }).onConflict((oc) => oc.doNothing()));
await db.run(db.k.updateTable("tracked_repos").set({ pipeline: 1 }));
const runner = new Runner({ db, dbTarget: dbFile, logs: join(dir, "logs"), killAfterMs: 2000, log: () => {} });

after(async () => {
  await runner.stop();
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function until(cond: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!await cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await runner.tick();
    await new Promise((r) => setTimeout(r, 50));
  }
}

const state = async (id: number) => (await getJob(db, id)).state;

describe("runner", () => {
  test("runs a queued job and records its summary, usage and a scrubbed log; a failing job is failed", async () => {
    const ok = await enqueue(db, "test-echo", { n: 7 }, "boss");
    const bad = await enqueue(db, "test-echo", { mode: "fail" }, "boss");
    await until(async () => await state(ok.id) === "done" && await state(bad.id) === "failed");
    const j = await jobDetail(db, ok.id);
    assert.equal(j.summary, "echo 7");
    assert.deepEqual(j.usage, { calls: 1, input: 100, output: 10, costUsd: 0.01 });
    assert.ok(j.startedAt && j.endedAt);
    assert.ok(j.log!.includes("token in the log: [hidden]"), j.log!);
    assert.ok(!j.log!.includes(FAKE_TOKEN));
    assert.equal((await getJob(db, bad.id)).error, "echo failed on purpose");
    // The runner stored the log too: without the file (another disk) the job page shows the same scrubbed text.
    await until(async () => !!await db.get(db.k.selectFrom("job_log_chunks").select("seq").where("job_id", "=", ok.id)));
    rmSync((await db.get(db.k.selectFrom("jobs").select("log_path").where("id", "=", ok.id)))!.log_path!);
    const stored = (await jobDetail(db, ok.id)).log!;
    assert.ok(stored.includes("token in the log: [hidden]") && !stored.includes(FAKE_TOKEN), stored);
  });

  test("with AUTOCRAFT_DB_URL set, a job process opens that Postgres database, not a SQLite file", async () => {
    // A stand-in server that records the startup packet a Postgres client sends first (it names the database), then hangs up.
    const seen: Buffer[] = [];
    const server = createServer((s) => s.on("data", (b: Buffer) => { seen.push(b); s.destroy(); }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const saved = { url: process.env.AUTOCRAFT_DB_URL, db: process.env.AUTOCRAFT_DB };
    const pgDir = mkdtempSync(join(dir, "pg-"));
    const pgDb = await connectDb(join(pgDir, "jobs.db"));
    process.env.AUTOCRAFT_DB_URL = `postgres://autocraft@127.0.0.1:${port}/childjob`;
    delete process.env.AUTOCRAFT_DB;
    const pgRunner = new Runner({ db: pgDb, logs: join(pgDir, "logs"), killAfterMs: 2000, log: () => {}, detect: async () => ({ proposals: [], logs: [] }), refreshFlow: async () => undefined });
    try {
      const job = await enqueue(pgDb, "test-echo", { n: 1 }, "boss");
      const end = Date.now() + 20_000;
      while (!Buffer.concat(seen).includes("database\0childjob\0")) {
        if (Date.now() > end) throw new Error(`the job process did not connect; job ${job.id} is ${(await getJob(pgDb, job.id)).state}`);
        await pgRunner.tick();
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      await pgRunner.stop();
      await pgDb.close();
      await new Promise((r) => server.close(r));
      for (const [k, v] of [["AUTOCRAFT_DB_URL", saved.url], ["AUTOCRAFT_DB", saved.db]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("a job stopped by a runner stop resumes under the same id and reads the reply its Task Runner sent meanwhile", async () => {
    await setInferenceMode(db, "user-local", "test");
    await db.run(db.k.insertInto("access").values({ login: "bob", role: "maintainer" }));
    const bob = { tokenId: (await createToken(db, "bob", "helper", { kind: "runner" })).row.id, login: "bob", role: "maintainer" as const };
    const opts = { db, dbTarget: dbFile, logs: join(dir, "logs"), killAfterMs: 2000, log: () => {} };
    const first = new Runner(opts);
    const job = await enqueue(db, "test-remote", {}, "boss");
    const callOf = async () => await db.all(db.k.selectFrom("remote_calls").select(["id", "state", "run_id"]).where("job_id", "=", job.id));
    let lease = null;
    for (let i = 0; i < 400 && !lease; i++) {
      await first.tick();
      if ((await callOf()).length) lease = (await claimCall(db, bob, { requestId: `resume-${i}`, protocol: PROTOCOL_VERSION, helperVersion: "1.2.0", harness: "claude", harnessVersion: "2.1", tiers: { top: "opus" } }, async () => true)).lease;
      if (!lease) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(lease, "the job's call was leased");
    await first.stop();
    const stopped = await getJob(db, job.id);
    assert.equal(stopped.state, "queued", "the stop queued the job to resume");
    assert.equal((await callOf())[0]!.state, "leased", "the call stays with its Task Runner");
    // The Task Runner answers while no runner runs the job.
    assert.deepEqual(await submitCall(db, lease.secret, { ok: true, text: "the review", model: "claude-opus-4-5", usage: { inputTokens: 10, outputTokens: 2 } }), { accepted: true });

    const second = new Runner(opts);
    try {
      await second.recover();
      for (let i = 0; i < 400 && !["done", "failed"].includes(await state(job.id)); i++) {
        await second.tick();
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      await second.stop();
    }
    const j = await jobDetail(db, job.id);
    assert.equal(j.state, "done", j.error ?? j.log ?? "");
    assert.equal(j.summary, "reply: the review");
    const calls = await callOf();
    assert.equal(calls.length, 1, "the resumed run adopted the call instead of asking again");
    assert.equal((await db.get(db.k.selectFrom("agent_runs").select("state").where("id", "=", calls[0]!.run_id!)))!.state, "done");
    assert.ok(j.log!.includes("queued to resume after the restart (resume 1)"), j.log!);

    // A job left running by a runner that is gone resumes too, until it has crash-resumed twice.
    const left = Number((await db.get(db.k.insertInto("jobs").values({ step: "test-echo", params: "{}", requested_by: "boss", requested_at: new Date().toISOString(), state: "running", started_at: new Date().toISOString(), resumes: 1, crash_resumes: 1 }).returning("id")))!.id);
    await second.recover();
    assert.equal((await getJob(db, left)).state, "queued");
    await db.run(db.k.updateTable("jobs").set({ state: "running" }).where("id", "=", left));
    await second.recover();
    assert.equal((await getJob(db, left)).error, RUNNER_STOPPED);
    // A command-line run is not resumed: its process belongs to the command, which may still be running it.
    const cli = Number((await db.get(db.k.insertInto("jobs").values({ step: "test-echo", params: "{}", requested_by: "cli", requested_at: new Date().toISOString(), state: "running", started_at: new Date().toISOString() }).returning("id")))!.id);
    await second.recover();
    assert.equal((await getJob(db, cli)).state, "failed");
  });

  test("graceful stops (deploys) resume a job well past the crash limit, which only unclean stops count against", async () => {
    const id = Number((await db.get(db.k.insertInto("jobs").values({ step: "test-echo", params: "{}", requested_by: "boss", requested_at: new Date().toISOString(), state: "running", started_at: new Date().toISOString() }).returning("id")))!.id);
    for (let i = 0; i < 3; i++) {
      assert.equal((await endJob(db, id, 143, null, null, true))?.state, "queued");
      await db.run(db.k.updateTable("jobs").set({ state: "running" }).where("id", "=", id));
    }
    const j = (await db.get(db.k.selectFrom("jobs").select(["resumes", "crash_resumes"]).where("id", "=", id)))!;
    assert.equal(j.resumes, 3);
    assert.equal(j.crash_resumes, 0);
    await db.run(db.k.updateTable("jobs").set({ crash_resumes: 2 }).where("id", "=", id));
    assert.equal((await endJob(db, id, 143, null, null, true))?.state, "queued", "a graceful stop ignores crash resumes");
    await db.run(db.k.updateTable("jobs").set({ state: "running" }).where("id", "=", id));
    await new Runner({ db, dbTarget: dbFile, logs: join(dir, "logs"), killAfterMs: 2000, log: () => {} }).recover();
    assert.equal((await getJob(db, id)).error, RUNNER_STOPPED);
  });

  test("a runner stop while a step writes lets the write finish, and the write it refuses is no failed item: the job resumes", async () => {
    const stopper = new Runner({ db, dbTarget: dbFile, logs: join(dir, "logs"), killAfterMs: 5000, log: () => {} });
    const job = await enqueue(db, "test-writes", { n: 5 }, "boss");
    const states = async () => (await db.all(db.k.selectFrom("audit").select("details").orderBy(rowid("audit")))).map((r) => JSON.parse(r.details || "{}") as { jobId?: number; state?: string }).filter((d) => d.jobId === job.id).map((d) => d.state!);
    for (let i = 0; i < 400 && !(await states()).includes("started"); i++) {
      await stopper.tick();
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok((await states()).includes("started"), "a comment is being written");
    await stopper.stop();
    const j = await jobDetail(db, job.id);
    assert.equal(j.state, "queued", j.log ?? "");
    assert.ok(!j.log!.includes("failed:"), j.log!);
    const written = await states();
    assert.ok(written.length >= 1 && written.every((s) => s === "done"), `the write in flight finished and was recorded: ${written.join(", ")}`);
    await requestCancel(db, job.id, "boss");
  });

  test("a resumed job does not post again a comment its earlier run posted", async () => {
    const id = Number((await db.get(db.k.insertInto("jobs").values({ step: "test-echo", params: "{}", requested_by: "boss", requested_at: new Date().toISOString(), state: "running", started_at: new Date().toISOString() }).returning("id")))!.id);
    setCallContext({ jobId: id, step: "test-echo", stage: 2, cancelled: async () => false });
    try {
      let posts = 0;
      const exec = async () => { posts++; return { code: 0, stdout: `https://github.com/storytold/app/issues/3#issuecomment-${posts}\n`, stderr: "" }; };
      const g = { scope: "item", action: { kind: "act" }, repo: "app", number: 3, as: "app" } as unknown as GuardedItem;
      const comment = (text: string) => ghComment({ db, login: "act" }, g, exec, "act-comment", { repo: "app", number: 3, pr: false }, { by: "fixed" } as never, text);
      await comment("hello");
      // The runner stopped, the job resumed and runs again from the start.
      await db.run(db.k.updateTable("jobs").set({ resumes: 1, started_at: new Date(Date.now() + 1000).toISOString() }).where("id", "=", id));
      const again = await comment("hello");
      assert.equal(posts, 1, "the comment is not posted twice");
      assert.match(again.stdout, /issuecomment-1/, "the earlier comment's URL is the result");
      await comment("something else");
      assert.equal(posts, 2, "a comment the earlier run did not post is posted");

      // A stopping job lets a write in flight finish and be recorded, and refuses writes asked for after the stop.
      let send = (): void => {};
      const slow = async () => { await new Promise<void>((r) => { send = r; }); return { code: 0, stdout: "https://github.com/storytold/app/issues/3#issuecomment-9\n", stderr: "" }; };
      const inFlight = ghComment({ db, login: "act" }, g, slow, "act-comment", { repo: "app", number: 3, pr: false }, { by: "fixed" } as never, "in flight");
      await new Promise((r) => setTimeout(r, 50));
      const stopping = stopWrites("the job is stopping", 5000);
      send();
      assert.equal(await stopping, 0, "nothing is left in flight");
      assert.equal((await inFlight).code, 0);
      assert.equal((JSON.parse((await db.get(db.k.selectFrom("audit").select("details").where("action", "=", "act-comment").orderBy(rowid("audit"), "desc").limit(1)))!.details!) as { state: string }).state, "done");
      // A write asked for after the stop is not made, and its caller waits for the process to exit.
      const rows = async () => (await db.get(db.k.selectFrom("audit").select((eb) => eb.fn.countAll<number>().as("n")).where("action", "=", "act-comment")))!.n;
      const n = await rows();
      const late = await Promise.race([comment("after the stop").then(() => "settled", () => "settled"), new Promise((r) => setTimeout(() => r("waits"), 200))]);
      assert.equal(late, "waits");
      assert.equal(await rows(), n, "no row for the write that was not made");
    } finally {
      resumeWritesForTests();
      setCallContext(null);
    }
  });






});
