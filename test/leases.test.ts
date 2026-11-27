// Work leases and the daily-limit reservation: two jobs never work one PR together or pass the day's limit together.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { setCallContext } from "../src/agents/call.ts";
import { jobLimit } from "../src/runner/autopilot.ts";
import { endJob } from "../src/runner/jobs.ts";
import { leaseItem, leaseSkips, take } from "../src/runner/leases.ts";
import type { StepDef } from "../src/runner/steps.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { excluded } from "../src/db/kx.ts";

after(() => setCallContext(null));

async function fresh(name: string) {
  mkdirSync(SCRATCH, { recursive: true });
  return await connectDb(join(SCRATCH, `leases-${name}-${process.pid}.db`));
}
const addJob = async (db: Awaited<ReturnType<typeof fresh>>, step: string, state: string, params: object = {}, items = 0): Promise<number> =>
  (await db.get(db.k.insertInto("jobs").values({
    step, params: JSON.stringify(params), requested_by: "pipeline", requested_at: new Date().toISOString(), state,
    started_at: state === "queued" ? null : new Date().toISOString(), items,
  }).returning("id")))!.id;
const as = (jobId: number, step: string) => setCallContext({ jobId, step, stage: 1, cancelled: async () => false });

test("fixup and cifix on one PR: the second job skips it, and a lease of an ended job is free", async () => {
  const db = await fresh("pr");
  const fixup = await addJob(db, "fixup", "running"), cifix = await addJob(db, "cifix", "running");
  const lines: string[] = [];
  as(fixup, "fixup");
  const release = await leaseItem(db, "pr:r#1", (l) => lines.push(l));
  assert.ok(release);
  as(cifix, "cifix");
  assert.equal(await leaseItem(db, "pr:r#1", (l) => lines.push(l)), null);
  assert.equal(lines.length, 1);
  assert.equal(leaseSkips(), 1, "a lease skip is counted for the job record");
  assert.ok(await leaseItem(db, "pr:r#2", () => {}), "another PR is free");
  as(fixup, "fixup");
  assert.ok(await take(db, "pr:r#1", fixup, "fixup"), "the holder may take it again");
  // The holder's job ends: its leases go, and a lease left by a crash (job no longer running) is free.
  await endJob(db, fixup, 0, null, null);
  assert.deepEqual(await db.all(db.k.selectFrom("work_leases").select("key").where("job_id", "=", fixup)), []);
  await db.run(db.k.insertInto("work_leases").values({ key: "pr:r#3", job_id: fixup, step: "fixup", taken_at: "x" }));
  assert.ok(await take(db, "pr:r#3", cifix, "cifix"));
});

test("a second job of a step gets the day's remainder minus the first job's unspent limit", async () => {
  const db = await fresh("limit");
  await db.run(db.k.insertInto("stage_limits").values({ step: "fixup", per_day: 20 }).onConflict((oc) => oc.column("step").doUpdateSet(excluded(["per_day"]))));
  const step = { name: "fixup", params: [{ name: "limit", kind: "int", min: 1, max: 50, default: 15 }] } as unknown as StepDef;
  assert.deepEqual(await jobLimit(db, step), { limit: 15 });
  await addJob(db, "fixup", "running", { limit: 15 }, 4); // 4 used (counted today), 11 unspent
  assert.deepEqual(await jobLimit(db, step), { limit: 5 });
  await addJob(db, "fixup", "queued", { limit: 5 });
  assert.equal(await jobLimit(db, step), null);
});
