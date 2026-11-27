// Fix-ups and CI fixes whose job stopped at the push: the next read of the PR's head settles them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { addOwnPush, landOwnPush } from "../src/data/control/index.ts";
import { takeLeases } from "../src/data/jobs/index.ts";
import { saveChecks, type PrChecks } from "../src/review/checks.ts";
import { LANES, planCtx } from "../src/runner/autopilot.ts";
import { T0, world, type World } from "./world-db.ts";

const read = (number: number, head: string): PrChecks =>
  ({ repo: "app", number, head_oid: head, state: "OPEN", is_draft: false, overall: "success", checks: [], mergeable: "MERGEABLE", maintainer_can_modify: true, cross_repo: false, suites: [] });

/** A started PR whose fix-up of `sha<n>` was about to push `sha<n>b`. */
async function pushing(w: World, n: number, o: { patch?: string; recorded?: boolean } = {}): Promise<void> {
  await (await (await w.pr(n)).review(n, { verdict: "take-fix" })).workflow(n);
  await w.db.run(w.db.k.insertInto("fixups").values({ repo: "app", number: n, from_head: `sha${n}`, to_head: `sha${n}b`, state: "pushing", attempt: 1, created_at: T0, files: '["src/lib.rs"]', ...(o.patch ? { patch: o.patch, lint_task: 1, lint_state: "pending" } : {}) }));
  if (o.recorded !== false) await addOwnPush(w.db, { repo: "app", number: n, from: `sha${n}`, to: `sha${n}b`, action: "fixup-push", lines: 3 });
}
const stateOf = async (w: World, n: number) => (await w.rows("SELECT state, to_head FROM fixups WHERE number = ?", n))[0] as { state: string; to_head: string | null };

test("a push its job stopped at is settled by the head: landed, pushed again from its patch, or made anew", async () => {
  const w = await (await (await world()).repo()).acting();
  for (const [n, o] of [[1, {}], [2, {}], [3, { patch: "diff" }], [4, { recorded: false }], [5, {}], [6, {}]] as const) await pushing(w, n, o);
  await landOwnPush(w.db, { repo: "app", number: 5, to: "sha5b" });
  await w.db.run(w.db.k.insertInto("ci_fixes").values({ repo: "app", number: 1, head: "sha1", to_head: "sha1c", kind: "code", state: "pushing", attempt: 1, created_at: T0 }));
  // Landed; not landed, without and with a stored patch; never sent; landed with someone's commit on top; overtaken by someone's commit.
  await saveChecks(w.db, [read(1, "sha1b"), read(2, "sha2"), read(3, "sha3"), read(4, "sha4"), read(5, "theirs"), read(6, "theirs")]);
  const got = [];
  for (const n of [1, 2, 3, 4, 5, 6]) got.push((await stateOf(w, n)).state);
  assert.deepEqual(got, ["pushed", "superseded", "linting", "superseded", "pushed", "superseded"]);
  assert.equal((await stateOf(w, 3)).to_head, null);
  assert.equal(((await w.rows("SELECT state FROM ci_fixes"))[0] as { state: string }).state, "superseded");
  // The try that did not land is made again.
  assert.ok((await w.prPlan(2)).actions.some((a) => a.kind === "fixup" && a.params?.bucket === "fix"));
  await w.close();
});

test("a running job's push is left alone; once no job is at it, the PR's head is read", async () => {
  const w = await (await (await world()).repo()).acting();
  await pushing(w, 1);
  const job = (await w.db.get(w.db.k.insertInto("jobs").values({ step: "fixup", params: "{}", requested_by: "pipeline", requested_at: T0, state: "running", repo: "app" }).returning("id")))!;
  await takeLeases(w.db, ["pr:app#1"], { id: job.id, step: "fixup" });
  const checks = async () => (await LANES.find((l) => l.name === "merge")!.detect(w.db, await planCtx(w.db))).filter((c) => c.step === "checks").length;
  await saveChecks(w.db, [read(1, "sha1")]);
  assert.deepEqual([(await stateOf(w, 1)).state, await checks()], ["pushing", 0]);
  await w.db.run(w.db.k.updateTable("jobs").set({ state: "queued" }).where("id", "=", job.id));
  assert.equal(await checks(), 1);
  await saveChecks(w.db, [read(1, "sha1")]);
  assert.deepEqual([(await stateOf(w, 1)).state, await checks()], ["superseded", 0]);
  await w.close();
});
