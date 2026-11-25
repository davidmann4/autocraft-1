// Classify's selection: work a maintainer started goes ahead of the backlog, so a cut to the job's limit keeps it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { refreshPlanCache } from "../src/core/plan-cache.ts";
import { fillClassHashes } from "../src/itemhash.ts";
import { classifyPlans, jevItems } from "../src/runner/classify.ts";
import { OPERATOR, T0, world } from "./world-db.ts";

test("an item with a live workflow is taken before older due items", async () => {
  const w = await (await world()).repo();
  const db = w.db;
  await db.prepare("INSERT INTO settings (key, value) VALUES ('classify_run', 'r1')").run();
  await db.prepare("UPDATE tracked_repos SET workflow = 'new' WHERE name = 'app'").run();
  // Newest first without a started item: 1, 2, 3, then the started item 4, updated longest ago.
  for (const [n, at] of [[1, "2026-03-04"], [2, "2026-03-03"], [3, "2026-03-02"], [4, "2026-03-01"]] as const) {
    await db.prepare("INSERT INTO items (repo, number, kind, state, title, body, author, created_at, updated_at) VALUES ('app', ?, 'issue', 'OPEN', ?, 'b', 'someone', ?, ?)").run(n, `t${n}`, T0, at);
  }
  await fillClassHashes(db);
  await refreshPlanCache(db);
  const before = (await jevItems(db, "r1", "new", await classifyPlans(db, "r1"))).due.map((x) => x.number);
  assert.equal(before.at(-1), 4, "a backlog item updated longest ago comes last");

  await db.prepare("INSERT INTO item_workflows (repo, number, kind, entry, state, started_by, started_at, started_via, updated_at) VALUES ('app', 4, 'issue', 'review', 'running', ?, ?, 'github', ?)").run(OPERATOR, T0, T0);
  const due = (await jevItems(db, "r1", "new", await classifyPlans(db, "r1"))).due.map((x) => x.number);
  assert.equal(due[0], 4, "the started item comes first");
  assert.deepEqual(due.slice(1), before.slice(0, -1), "the others keep their order");
});
