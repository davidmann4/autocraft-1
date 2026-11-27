import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { computeChecks } from "../src/health-checks.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { SCRATCH } from "./scratch.ts";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

async function seed(runs: { step: string; state: "done" | "failed"; h: number; error?: string; repo?: string }[]) {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "stephealth-")), "m.db"));
  for (const r of runs) {
    await db.run(db.k.insertInto("jobs").values({ step: r.step, params: "{}", requested_by: "pipeline", requested_at: hoursAgo(r.h), state: r.state, started_at: hoursAgo(r.h), ended_at: hoursAgo(r.h), error: r.error ?? null, repo: r.repo ?? null }));
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

test("one repo whose job keeps failing neither stalls nor pauses a step that succeeds on another repo meanwhile", async () => {
  const { pauseOf } = await import("../src/runner/autopilot.ts");
  const failing = [0.05, 0.04, 0.03].map((h) => ({ step: "verify", repo: "app", state: "failed" as const, h, error: "app: GitHub could not be read" }));
  const both = await seed([{ step: "verify", repo: "other", state: "done", h: 0.06 }, ...failing]);
  assert.deepEqual(await stalled(both), []);
  assert.equal(await pauseOf(both, "verify", NOW), null, "the other repo may run");
  const alone = await seed(failing);
  assert.match((await stalled(alone))[0]?.text ?? "", /on app .*its last 3 runs there failed/);
  assert.match((await pauseOf(alone, "verify", NOW))?.why ?? "", /^failed 3 times in a row/);
  // Every repo fails at once (a revoked token), an hour after a success on one of them: the step itself is failing.
  const everywhere = await seed([{ step: "verify", repo: "other", state: "done", h: 1 }, ...["app", "other", "third"].map((repo, i) => ({ step: "verify", repo, state: "failed" as const, h: 0.05 - i * 0.01, error: "bad credentials" }))]);
  const wide = await stalled(everywhere);
  assert.deepEqual(wide.map((c) => c.state), ["warn"], "warned at once, though a repo succeeded within the stall limit");
  assert.doesNotMatch(wide[0]!.text, / on (app|other|third) /, "about the step, not one repo");
});
