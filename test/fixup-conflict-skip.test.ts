import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Querier } from "../src/mirror.ts";
import { setPushApproval } from "../src/fixup/approval.ts";
import { runFixup, type FixupDeps } from "../src/fixup/index.ts";
import { selectFixups } from "../src/fixup/select.ts";
import { acting, appLane } from "./acting.ts";
import { reportingTaskRunner } from "./fake-runner.ts";
import { SCRATCH } from "./scratch.ts";
import { validating } from "./gql.ts";
import { insertWorkflow } from "../src/workflow/store.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "fixup-conflict-skip-"));
const T0 = "2026-01-01T00:00:00Z";
const FIXES = JSON.stringify([{ file: "src/lib.rs", change: "rename a to b" }]);

// Mirrored mergeable state is stale (UNKNOWN, no checks row) while GitHub reports the first three PRs as conflicting.
test("PRs found conflicting live go to the conflict merge and do not use up the fix-up limit", async () => {
  const db = await connectDb(join(dir, "t.db"));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: T0, pipeline: 1 }));
  await setPushApproval(db, "op", "app", true);
  await reportingTaskRunner(db);
  const heads = new Map<number, string>();
  for (const n of [1, 2, 3, 4]) {
    const head = String(n).repeat(40);
    heads.set(n, head);
    await db.run(db.k.insertInto("items").values({ repo: "app", number: n, kind: "pr", state: "OPEN", title: "Fix a thing", author: "someone", additions: 5, deletions: 0, head_oid: head, head_ref: "fix", head_repo: "contrib/app", base_ref: "main",
      maintainer_can_modify: 1, mergeable: "UNKNOWN", created_at: T0, updated_at: T0 }));
    await db.run(db.k.insertInto("opus_reviews").values({ repo: "app", number: n, head_oid: head, run_id: "rv", at: T0, model: "m", verdict: "take-fix", reason: "nearly right", fixes: FIXES, sure: 1, mode: "full" }));
    await insertWorkflow(db, { repo: "app", number: n, kind: "pr", entry: "fixup", state: "running", startedBy: "op", startedAt: T0, startedVia: "dashboard" });
    await acting(db, ["op"]);
  }
  const querier: Querier = validating({
    spent: 0, remaining: 5000,
    async query(_q: string, v: object) {
      const n = Number((v as { n?: number }).n);
      return { repository: { pullRequest: {
        id: `PR${n}`, number: n, state: "OPEN", isDraft: false, headRefOid: heads.get(n), headRefName: "fix", maintainerCanModify: false,
        mergeable: n === 4 ? "MERGEABLE" : "CONFLICTING", headRepository: { nameWithOwner: "contrib/app" }, assignees: { nodes: [] },
      } } };
    },
  });
  const deps = { querier, lane: appLane(querier), now: () => new Date(T0), root: join(dir, "cache"), exec: async () => ({ code: 0, stdout: JSON.stringify({ login: "pipeline-bot", id: 42, node_id: "U42" }), stderr: "" }) } as unknown as FixupDeps;
  const log: string[] = [];
  let handled = 0;
  await runFixup(db, { repo: "app", limit: 3, dryRun: false, onHandled: (n) => { handled = n; } }, (l) => log.push(l), deps);

  assert.equal(log.filter((l) => l.includes("conflicts with the base branch")).length, 3);
  assert.equal(handled, 1, "only the plain PR counts as handled");
  assert.ok(log.some((l) => l.includes("app#4")), "the PR behind the conflicted ones was reached");

  const sel = await selectFixups(db, "app");
  assert.deepEqual(sel.conflictMerge.map((c) => c.number).sort(), [1, 2, 3]);
  assert.ok(sel.fix.every((c) => c.number === 4), "conflicted PRs are no fix-up candidates");
});
