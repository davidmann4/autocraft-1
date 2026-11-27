// The review and pre-merge steps read the diff before their model call: a PR its diff keeps off the path that asked for the call
// costs none. A person's approval does not read the diff's facts.
import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { runOpusReview, type OpusDeps } from "../src/review/opus.ts";
import { runPremerge } from "../src/premerge/review.ts";
import type { DiffResult } from "../src/review/diff.ts";
import { tmpdir, world, type World } from "./world-db.ts";

const quiet = () => {};
const section = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n-a: 1\n+a: 2\n`;
const CODE = section("src/lib.rs"), CI = CODE + section(".github/workflows/ci.yml");
const CI_REASON = "changes CI or build configuration";

let current: World | null = null;
afterEach(() => current?.close());
/** The world, and the model calls made in it. */
async function fresh(): Promise<{ w: World; calls: string[] }> {
  const calls: string[] = [];
  process.env.AUTOCRAFT_DIFF_CACHE = join(tmpdir("auto-path"), "cache");
  const w = current = await (await (await world()).repo()).models((input) => { calls.push(input); return JSON.stringify({ ref: "app#1", findings: [], searched: "callers" }); });
  return { w, calls };
}
const deps = (diff: DiffResult): OpusDeps => ({ fetchDiff: async () => diff, fetchDelta: async () => ({ ok: false, tooLarge: false, error: "unused" }), model: "opus", maxChars: 120_000 });
const read = (text: string): DiffResult => ({ ok: true, text });
const kinds = async (w: World) => (await w.prPlan(1)).actions.map((a) => a.kind);
const changed = async (w: World) => { const p = await w.prPlan(1); return [p.state, p.wait]; };

test("the review of an unstarted PR that changes CI makes no model call, and the planner says why", async () => {
  const { w, calls } = await fresh();
  await w.pr(1);
  assert.deepEqual(await kinds(w), ["review"]);
  const s = await runOpusReview(w.db, { repo: "app" }, quiet, deps(read(CI)));
  assert.deepEqual([s.off, calls.length], [["app#1"], 0]);
  assert.deepEqual(await changed(w), ["not-started", `${CI_REASON}; waits for a maintainer`]);
});

test("a plain diff of an unstarted PR, and a CI change of a started one, are reviewed", async () => {
  const { w, calls } = await fresh();
  await w.pr(1);
  await runOpusReview(w.db, { repo: "app" }, quiet, deps(read(CODE)));
  assert.ok(calls.length > 0);
  await (await w.pr(2)).workflow(2, { approved: false });
  calls.length = 0;
  const s = await runOpusReview(w.db, { repo: "app" }, quiet, deps(read(CI)));
  assert.deepEqual(s.off, []);
  assert.ok(calls.some((c) => c.includes("app#2")));
});

test("the pre-merge review of a PR the rule would merge reads the diff first: a CI change ends it with no model call", async () => {
  const { w, calls } = await fresh();
  await (await (await w.pr(1)).review(1)).verified(1);
  assert.deepEqual(await kinds(w), ["premerge"]);
  const s = await runPremerge(w.db, { repo: "app" }, quiet, deps(read(CI)));
  assert.deepEqual([s.off, calls.length], [["app#1"], 0]);
  const p = await w.prPlan(1);
  assert.deepEqual([p.state, p.reasons, p.actions], ["needs-decision", [CI_REASON], []]);
});

test("the pre-merge review waits for what the rule reads beside the diff, and runs on a merge a person approved whatever the diff holds", async () => {
  const { w, calls } = await fresh();
  await (await (await w.pr(1)).review(1)).verified(1);
  const pending: DiffResult = { ok: true, text: CODE + section("Cargo.toml"), extras: { files: {}, runs: null, complete: false } };
  assert.deepEqual([(await runPremerge(w.db, { repo: "app" }, quiet, deps(pending))).off, calls.length], [["app#1"], 0]);
  assert.deepEqual(await kinds(w), ["premerge"], "the diff is read again");

  await (await (await w.pr(2)).workflow(2, { entry: "merge" })).verified(2);
  const s = await runPremerge(w.db, { repo: "app", number: 2 }, quiet, deps(read(CI)));
  assert.deepEqual(s.off, []);
  assert.ok(calls.some((c) => c.includes("app#2")));
});
