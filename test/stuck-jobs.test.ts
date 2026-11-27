// Stuck-job handling: the runner stops a job past its step's deadline and fails it with a warning until acknowledged or beaten by a
// later success; the drain state lets the writes of jobs already running through where plain off blocks them.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { setCommentApproval } from "../src/act/approval.ts";
import { SCRATCH } from "./scratch.ts";
import { world } from "./world-db.ts";
import { connectDb } from "./helpers/raw-db.ts";

process.env.AUTOCRAFT_EXTRA_STEPS = fileURLToPath(new URL("./runner-steps.ts", import.meta.url));

const { connect } = await import("../src/db.ts");
const { enqueue, getJob, jobDetail } = await import("../src/runner/jobs.ts");
const { Runner, deadlineError, noProgressError } = await import("../src/runner/runner.ts");
const { ackDeadline, deadlineStops, isDraining, isEnabled, setEnabled } = await import("../src/runner/autopilot.ts");
const { failureBackoff, DEADLINE_BACKOFF_MS } = await import("../src/runner/autopilot.ts");
const { STEP_PLANS, stepBoundMin, stepDeadlineMin } = await import("../src/runner/deadlines.ts");
const { loadSteps } = await import("../src/runner/steps.ts");
const { guardRepo } = await import("../src/core/guard.ts");

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "stuck-jobs-"));
const dbFile = join(dir, "runner.db");
const db = await connectDb(dbFile);
const runner = new Runner({ db, dbTarget: dbFile, logs: join(dir, "logs"), killAfterMs: 2000, log: () => {}, maxMin: (s) => (s === "test-sleep" ? 0.02 : 999), noProgressMin: (s) => (s === "test-other" ? 0.02 : 999), graceMs: 500 });
after(async () => {
  await runner.stop();
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a job past its step's deadline is stopped and failed, and warns until acknowledged or beaten", async () => {
  const slow = await enqueue(db, "test-sleep", { ms: 60_000 }, "boss");
  for (const end = Date.now() + 20_000; (await getJob(db, slow.id)).state !== "failed" && Date.now() < end; await new Promise((r) => setTimeout(r, 50))) await runner.tick();
  const j = await getJob(db, slow.id);
  assert.equal(j.state, "failed");
  assert.equal(j.error, deadlineError(0.02));
  assert.deepEqual((await deadlineStops(db)).map((d) => d.step), ["test-sleep"]);
  assert.match((await jobDetail(db, slow.id)).log ?? "", /may finish its current item/);
  // The stopped paid work is not started again for an hour, whatever the input does.
  await db.run(db.k.updateTable("jobs").set({ requested_by: "pipeline" }).where("id", "=", slow.id));
  const b = await failureBackoff(db, "test-sleep", Date.now(), { fp: "changed" });
  assert.ok(b && b.until - Date.parse(j.endedAt!) >= DEADLINE_BACKOFF_MS);
  // Every step with model calls gets at least the time the code lets its job work.
  const known = await loadSteps();
  for (const step of Object.keys(STEP_PLANS)) {
    assert.ok(known.has(step), step);
    assert.ok(stepDeadlineMin(step) >= stepBoundMin(step)!, step);
  }
  await ackDeadline(db, "test-sleep", "op");
  assert.deepEqual(await deadlineStops(db), []);

  // A job that writes no log line for longer than its limit is stopped the same way, well inside its deadline.
  const quiet = await enqueue(db, "test-other", { ms: 60_000 }, "boss");
  for (const end = Date.now() + 20_000; (await getJob(db, quiet.id)).state !== "failed" && Date.now() < end; await new Promise((r) => setTimeout(r, 50))) await runner.tick();
  assert.equal((await getJob(db, quiet.id)).error, noProgressError(0.02));
  assert.deepEqual((await deadlineStops(db)).map((d) => d.step), ["test-other"]);
});

test("a job that works in slices ends as a success before its deadline, with work left", async () => {
  const job = await enqueue(db, "test-slices", { units: 10_000 }, "boss");
  // Its clock is the job's start: once it has done some work, the start moves back past its whole deadline (999 min here). The runner
  // keeps its own start in memory, so only the job sees the time as up.
  for (const end = Date.now() + 20_000; Number((await db.get(db.k.selectFrom("jobs").select("items").where("id", "=", job.id)))?.items ?? 0) < 1 && Date.now() < end; await new Promise((r) => setTimeout(r, 50))) await runner.tick();
  await db.run(db.k.updateTable("jobs").set({ started_at: new Date(Date.now() - 1000 * 60_000).toISOString() }).where("id", "=", job.id));
  for (const end = Date.now() + 20_000; !["done", "failed"].includes((await getJob(db, job.id)).state) && Date.now() < end; await new Promise((r) => setTimeout(r, 50))) await runner.tick();
  const j = await getJob(db, job.id);
  assert.equal(j.state, "done");
  assert.equal(j.error, null);
  const [, done, left] = /^(\d+) of \d+ units, (\d+) left$/.exec(j.summary ?? "")!.map(Number);
  assert.ok(done! > 0 && left! > 0, j.summary ?? "");
});

test("draining keeps a running job's writes and starts nothing; off blocks the writes", async () => {
  const pipe = (await (await (await (await world()).repo(["comment"])).pr(1)).pipeline(false)).db;
  await setCommentApproval(pipe, "op", "app", true);
  const refused = async () => (await guardRepo(pipe, "app", "comment", "pipeline") as { refused?: string }).refused;
  await setEnabled(pipe, false, "op", "drain");
  assert.ok(await isDraining(pipe) && !await isEnabled(pipe));
  // While draining no job starts, a manual one included; it runs once the pipeline is on.
  await setEnabled(db, false, "op", "drain");
  const manual = await enqueue(db, "test-echo", {}, "boss");
  for (let n = 0; n < 5; n++) { await runner.tick(); await new Promise((r) => setTimeout(r, 50)); }
  assert.equal((await getJob(db, manual.id)).state, "queued");
  await setEnabled(db, true, "op");
  for (const end = Date.now() + 20_000; (await getJob(db, manual.id)).state !== "done" && Date.now() < end; await new Promise((r) => setTimeout(r, 50))) await runner.tick();
  assert.equal((await getJob(db, manual.id)).state, "done");
  assert.equal(await refused(), undefined);
  await setEnabled(pipe, false, "op");
  assert.match(await refused() ?? "", /pipeline is off/);
  await setEnabled(pipe, true, "op");
  assert.ok(await isEnabled(pipe) && !await isDraining(pipe));
  assert.equal(await refused(), undefined);
});
