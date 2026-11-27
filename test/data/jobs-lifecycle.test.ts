import { test } from "node:test";
import assert from "node:assert/strict";
import { queryDb } from "../../src/db/query-db.ts";
import {
  addJobItems, flushJobItems, loadJobItems, loadJobs, markCancelQueued, markCancelRequested, markDeadlineStops, markEnded, markResumed, noteJobItem, openJobPulse, pulseJob, recordResult,
} from "../../src/data/jobs/index.ts";
import { both, seedJobs } from "./jobs-fixture.ts";

both("markResumed requeues running jobs that may resume and reports only those", async (db) => {
  const [ok, cancelled, cli, deadline, tooMany, crashMax] = await seedJobs(db, [
    { state: "running" }, { state: "running" }, { state: "running", requested_by: "cli" }, { state: "running", error: "stopped: ran past 30 min" }, { state: "running", resumes: 12 }, { state: "running" },
  ]);
  const q = queryDb(db);
  await q.run(q.k.updateTable("jobs").set({ cancel_requested_at: "2026-01-01T00:00:00.000Z" }).where("id", "=", cancelled!));
  await q.run(q.k.updateTable("jobs").set({ crash_resumes: 2 }).where("id", "=", crashMax!));
  const got = await markResumed(db, [{ id: ok!, kind: "crash" }, { id: cancelled!, kind: "graceful" }, { id: cli!, kind: "graceful" }, { id: deadline!, kind: "graceful" }, { id: tooMany!, kind: "graceful" }, { id: crashMax!, kind: "crash" }]);
  assert.deepEqual(got.map((r) => [r.id, r.resumes, r.crash_resumes]), [[ok, 1, 1]]);
  const rows = await loadJobs(db, [ok!, cancelled!]);
  assert.equal(rows.get(ok!)!.state, "queued");
  assert.equal(rows.get(cancelled!)!.state, "running");
  return got.length;
});

both("markEnded ends only running jobs, each with its own state and error, and clears progress where asked", async (db) => {
  const [a, b, c] = await seedJobs(db, [{ state: "running" }, { state: "running" }, { state: "queued" }]);
  const q = queryDb(db);
  await q.run(q.k.updateTable("jobs").set({ progress: "half" }));
  const n = await markEnded(db, [{ id: a!, state: "done", error: null, clearProgress: true }, { id: b!, state: "failed", error: "boom", clearProgress: false }, { id: c!, state: "failed", error: "x", clearProgress: true }]);
  assert.equal(n, 2);
  const rows = await loadJobs(db, [a!, b!, c!]);
  assert.deepEqual([a!, b!, c!].map((id) => [rows.get(id)!.state, rows.get(id)!.error, rows.get(id)!.progress]), [["done", null, null], ["failed", "boom", "half"], ["queued", null, "half"]]);
  assert.equal(await markDeadlineStops(db, [{ id: b!, error: "late" }, { id: a!, error: "late" }]), 0, "ended jobs keep their error");
  return null;
});

both("markCancelQueued cancels queued jobs (of the pipeline only on request) and markCancelRequested keeps the first requester", async (db) => {
  const [mine, theirs, running] = await seedJobs(db, [{ requested_by: "pipeline" }, { requested_by: "ann" }, { state: "running" }]);
  const gone = await markCancelQueued(db, { pipelineOnly: true }, "op");
  assert.deepEqual(gone.map((r) => r.id), [mine]);
  assert.equal(await markCancelRequested(db, [running!, theirs!], "first"), 1);
  assert.equal(await markCancelRequested(db, [running!], "second"), 1);
  assert.equal((await loadJobs(db, [running!])).get(running!)!.cancel_requested_by, "first");
  return null;
});

both("recordResult adds query counts to those of earlier runs and leaves unset fields alone", async (db) => {
  const [id] = await seedJobs(db, [{ state: "running" }]);
  await recordResult(db, id!, { summary: "s", stats: { statements: 5, roundTrips: 2, ms: 10.25, effects: 1 } });
  await recordResult(db, id!, { leaseSkips: 2, leaseSkipKeys: ["pr:a#1"], stats: { statements: 3, roundTrips: 1, ms: 5, effects: 0 } });
  const r = (await loadJobs(db, [id!])).get(id!)!;
  assert.deepEqual([r.summary, r.db_statements, r.db_round_trips, r.db_ms, r.effects, r.lease_skips, r.lease_skip_keys], ["s", 8, 3, 15, 1, 2, '["pr:a#1"]']);
  return null;
});

test("a job pulse merges writes and answers cancel and deadline questions without a statement of its own each time", async () => {
  const { withDb } = await import("./jobs-fixture.ts");
  await withDb("sqlite", async (db) => {
    const [id] = await seedJobs(db, [{ state: "running", items: 4 }]);
    const pulse = await openJobPulse(db, { id: id!, items: 4, resumes: 1 }, { minMs: 60_000 });
    assert.equal(await pulse.cancelled(), false);
    const { stats } = await db.meter(async () => {
      for (let i = 0; i < 20; i++) { await pulse.cancelled(); await pulse.timeUp(1e12); pulse.handled(i); pulse.progress(`p${i}`); }
    });
    assert.equal(stats.statements, 0, "inside minMs nothing is written or read");
    const q = queryDb(db);
    await q.run(q.k.updateTable("jobs").set({ cancel_requested_at: "2026-01-01T00:00:00.000Z" }).where("id", "=", id!));
    assert.equal(await pulse.cancelled(), false, "the flag is the cached one");
    await recordResult(db, id!, { patch: await pulse.end() });
    const r = (await loadJobs(db, [id!])).get(id!)!;
    assert.deepEqual([r.items, r.progress], [4 + 19, "p19"], "a resumed job's count adds to its earlier runs");
    assert.equal((await pulseJob(db, id!, {})).cancel_requested_at !== null, true);
  });
});

test("counts and items noted last are stored a little later without another note, also from inside a transaction", async () => {
  const { withDb } = await import("./jobs-fixture.ts");
  await withDb("sqlite", async (db) => {
    const [id] = await seedJobs(db, [{ state: "running" }]);
    const pulse = await openJobPulse(db, { id: id!, items: 0, resumes: 0 }, { minMs: 50 });
    await pulse.cancelled();
    await db.write(async () => {
      pulse.handled(5);
      await noteJobItem(db, id!, "app", 3, "merged", () => {});
    });
    const until = async (cond: () => Promise<boolean>) => {
      const end = Date.now() + 10_000;
      while (!await cond()) {
        assert.ok(Date.now() < end, "not stored");
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    await until(async () => (await loadJobs(db, [id!])).get(id!)!.items === 5);
    await until(async () => (await loadJobItems(db, [id!])).get(id!)?.length === 1);
    await pulse.end();
  });
});

test("noteJobItem logs at once and stores buffered rows on flush; outside a job nothing is stored", async () => {
  const { withDb } = await import("./jobs-fixture.ts");
  await withDb("sqlite", async (db) => {
    const [id] = await seedJobs(db, [{ state: "running" }]);
    const lines: string[] = [];
    await noteJobItem(db, id!, "app", 3, "  merged\n now ", (l) => lines.push(l));
    await noteJobItem(db, null, "app", 4, "dry", (l) => lines.push(l));
    assert.deepEqual(lines, ["[app#3] merged now", "[app#4] dry"]);
    assert.equal((await loadJobItems(db, [id!])).size, 0, "not stored before the flush");
    await flushJobItems(db, id!);
    assert.deepEqual((await loadJobItems(db, [id!])).get(id!)!.map((r) => [r.repo, r.number, r.outcome]), [["app", 3, "merged now"]]);
    await addJobItems(db, Array.from({ length: 501 }, (_, n) => ({ job_id: id!, repo: "r", number: n, outcome: "o", at: "2026-01-01T00:00:00.000Z" })));
    assert.equal((await loadJobItems(db, [id!])).get(id!)!.length, 502);
  });
});
