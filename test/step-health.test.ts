import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { computeChecks } from "../src/health-checks.ts";
import { connectDb } from "../src/db/open.ts";
import { SCRATCH } from "./scratch.ts";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

async function seed(runs: { step: string; state: "done" | "failed"; h: number; error?: string }[]) {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "stephealth-")), "m.db"));
  for (const r of runs) {
    await db.run(db.k.insertInto("jobs").values({ step: r.step, params: "{}", requested_by: "pipeline", requested_at: hoursAgo(r.h), state: r.state, started_at: hoursAgo(r.h), ended_at: hoursAgo(r.h), error: r.error ?? null }));
  }
  return db;
}
const stalled = async (db: Awaited<ReturnType<typeof seed>>) => (await computeChecks(db, NOW)).filter((c) => c.id.startsWith("step-stalled:"));

test("a step whose last three runs failed after an old success fails; one success among the last three gives no check", async () => {
  const bad = await seed([
    { step: "classify-new", state: "done", h: 40 }, { step: "classify-new", state: "done", h: 36 },
    ...[3, 2, 1].map((h) => ({ step: "classify-new", state: "failed" as const, h, error: "stopped: ran past 20 min" })),
  ]);
  const checks = await stalled(bad);
  assert.equal(checks.length, 1);
  assert.equal(checks[0]!.state, "fail");
  assert.equal(checks[0]!.id, "step-stalled:classify-new");
  assert.match(checks[0]!.text, /Classify.*has not completed a run since 2026-11-19 00:00 UTC; its last 3 runs failed \(stopped: ran past 20 min\)/);

  const mixed = await seed([
    { step: "classify-new", state: "done", h: 40 }, { step: "classify-new", state: "failed", h: 3, error: "x" },
    { step: "classify-new", state: "done", h: 2 }, { step: "classify-new", state: "failed", h: 1, error: "x" },
  ]);
  assert.deepEqual(await stalled(mixed), []);
});
