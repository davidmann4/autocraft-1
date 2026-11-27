// Statement counts of the planner's pass inputs: the loads of one pass must not grow with PRs or repos (plan 4.2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { queryDb } from "../../src/db/query-db.ts";
import type { Db } from "../../src/db/index.ts";
import { changedPass, fullPass, loadChangeCursor, loadPlans, loadStageFacts, loadStoredPlans, readChanges, savePlans } from "../../src/data/planner/index.ts";
import { expectFlat } from "../helpers/query-count.ts";
import { TEST_PG_URL } from "../test-db.ts";
import { AT, openApp, planRow, seedPrs } from "./planner-helpers.ts";

// The wave stays far under the 40 reads past which a Postgres wave stops being one snapshot.
const sizes = (n: number) => ({ prs: n, repos: n > 2 ? 4 : 1 });

for (const dialect of ["sqlite" as const, ...(TEST_PG_URL ? ["postgres" as const] : [])]) {
  for (const mode of ["full", "changed"] as const) {
    test(`planner pass inputs: statements do not grow with PRs or repos, ${mode} pass (${dialect})`, async () => {
      await expectFlat(async (n) => {
        const { prs, repos } = sizes(n);
        const o = await openApp(dialect);
        const names = Array.from({ length: repos }, (_, i) => `org/r${i}`);
        await seedPrs(o.db, names, Math.ceil(prs / repos));
        const q = queryDb(o.db);
        const pairs = names.flatMap((repo) => Array.from({ length: Math.ceil(prs / repos) }, (_, i) => ({ repo, number: i + 1 })));
        await q.run(q.k.insertInto("main.stages").values(pairs.map((p) => ({ ...p, stage: "labeled", at: AT, actor: "t", note: "added: bug" }))));
        await savePlans(o.db, pairs.map((p) => planRow(p.repo, p.number)), AT);
        const cursor = await loadChangeCursor(o.db);
        const keys = mode === "full" ? fullPass() : changedPass([], cursor.seen.size);
        return { db: o.db, close: () => o.t.close(), run: () => load(o.db, keys, cursor) };
      }, 2, 12);
    });
  }
}

async function load(db: Db, keys: ReturnType<typeof fullPass>, cursor: Awaited<ReturnType<typeof loadChangeCursor>>) {
  const [changes, stored, plans, stages] = await db.together(() => Promise.all([readChanges(db, cursor), loadStoredPlans(db), loadPlans(db, keys), loadStageFacts(db, keys)]));
  assert.ok(!changes.full);
  assert.ok(stored.rev !== null);
  assert.ok(plans.size > 0 && stages.size > 0);
}
