// A post-merge defect holds merges on that repo only, whether or not it is a test repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTrips, resumeStage, tripMergeBreakers } from "../src/data/control/index.ts";
import { loadMergedInfo } from "../src/data/merge/index.ts";
import { connectDb, type Db } from "./helpers/raw-db.ts";

/** A post-merge review of a PR we merged found defects, as the post-merge review records it. */
async function mergeDefect(db: Db, repo: string, number: number, defects: number, at: string): Promise<void> {
  const merged = (await loadMergedInfo(db, [{ repo, number }])).get(`${repo}#${number}`);
  if (defects > 0 && merged) await tripMergeBreakers(db, [{ repo, number, mergedAt: merged.lastAt, reason: `the post-merge review of ${repo}#${number} found ${defects} defects`, evidence: [`${repo}#${number}`] }], at);
}
const activeTrips = async (db: Db): Promise<Record<string, string>> => Object.fromEntries([...await loadTrips(db, { active: true })].map(([k, t]) => [k, t.reason]));

test("a post-merge defect trips the merge breaker of its own repo, not the pipeline's", async () => {
  const db = await connectDb(":memory:");
  const merged = async (repo: string) => await db.run(db.k.insertInto("merges").values({ repo, number: 1, head_oid: "h", run_id: "m", at: "2026-01-01T00:00:00Z", path: "operator", method: "squash", outcome: "merged" }));
  await merged("sandbox");
  await merged("real");
  await db.run(db.k.insertInto("settings").values({ key: "test_repo:sandbox", value: "1" }));
  await mergeDefect(db, "sandbox", 1, 1, "2026-01-01T00:10:00Z");
  assert.deepEqual(Object.keys(await activeTrips(db)), ["merge:sandbox"]);
  await resumeStage(db, "merge:sandbox", "op");
  await mergeDefect(db, "real", 1, 1, "2026-01-01T00:20:00Z");
  assert.deepEqual(Object.keys(await activeTrips(db)), ["merge:real"]);
  // The merge from before the resume no longer trips its repo.
  await mergeDefect(db, "sandbox", 1, 1, "2026-01-01T00:30:00Z");
  assert.deepEqual(Object.keys(await activeTrips(db)), ["merge:real"]);
});
