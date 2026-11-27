// Step memory data: the finish API keeps peakMemBytes and oomKilled, drops junk, and the summary groups per repo and step.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { memorySummary, parseResults } from "../src/build/tasks.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

const R = { exitCode: 0, durationMs: 5, timedOut: false };

test("results keep valid memory fields and ignore invalid ones", () => {
  const [a, b, c] = parseResults([{ step: "build", ...R, peakMemBytes: 5.8e9, oomKilled: true }, { step: "test", ...R }, { step: "x", ...R, peakMemBytes: -1, oomKilled: "yes" }]);
  assert.deepEqual(a, { step: "build", ...R, peakMemBytes: 5.8e9, oomKilled: true });
  assert.deepEqual(b, { step: "test", ...R });
  assert.deepEqual(c, { step: "x", ...R });
});

test("memory summary: median, max and OOM count per repo and step; old results are skipped", async () => {
  mkdirSync(SCRATCH, { recursive: true });
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "build-mem-")), "m.db"));
  const add = async (repo: string, results: unknown[]) =>
    await db.run(db.k.insertInto("build_tasks").values({ step: "verify", repo, head_sha: "a".repeat(40), requires: "{}", plan: "[]", state: "done", queued_at: new Date().toISOString(), ended_at: new Date().toISOString(), results: JSON.stringify(results) }));
  await add("app", [{ step: "build", ...R, peakMemBytes: 2e9 }, { step: "test", ...R }]);
  await add("app", [{ step: "build", ...R, peakMemBytes: 6e9, oomKilled: true }]);
  await add("app", [{ step: "build", ...R, peakMemBytes: 4e9 }]);
  assert.deepEqual(await memorySummary(db, 30), [{ repo: "app", step: "build", steps: 3, medianBytes: 4e9, maxBytes: 6e9, oom: 1 }]);
});
