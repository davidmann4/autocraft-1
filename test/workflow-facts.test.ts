// The planner's facts of a PR a maintainer put straight into the merge queue (src/workflow): read at its current head, without a review.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { decidePr } from "../src/core/decide.ts";
import { loadPrFacts } from "../src/core/facts.ts";
import { insertWorkflow } from "../src/workflow/store.ts";
import { OPERATOR, T0, world, type World } from "./world-db.ts";

let current: World | null = null;
afterEach(() => current?.close());

test("a merge-entry PR without a review gets its queue facts at its current head", async () => {
  const w = current = await (await (await (await world()).repo()).pr(1, { lines: 900, label: "missing feature", ci: "failure" })).pr(2, { lines: 900, label: "missing feature" });
  const facts = async (n: number) => (await loadPrFacts(w.db, { refs: [`app#${n}`] }))[0]!;
  // Legacy: an unreviewed PR has no queue facts.
  assert.equal((await facts(1)).ci, "unknown");

  await w.db.run(w.db.k.updateTable("main.tracked_repos").set({ workflow: "new" }).where("name", "=", "app"));
  for (const n of [1, 2]) await insertWorkflow(w.db, { repo: "app", number: n, kind: "pr", entry: "merge", state: "running", startedBy: OPERATOR, startedAt: T0, startedVia: "dashboard", approvedBy: OPERATOR, approvedAt: T0, approvedVia: "dashboard" });

  const red = await facts(1);
  assert.equal(red.review, null);
  assert.equal(red.checksHere, true);
  assert.equal(red.ci, "failure");
  assert.ok(red.cifix, "the CI fix state is read at the head");
  assert.equal(red.mergeable, "MERGEABLE");

  const green = await facts(2);
  assert.equal(green.ci, "success");
  const plan = decidePr(green);
  assert.equal(plan.path, "maintainer");
  assert.ok(!plan.actions.some((a) => a.kind === "review"));
  assert.ok(plan.actions.some((a) => a.kind === "verify" && a.head === "sha2"));
});
