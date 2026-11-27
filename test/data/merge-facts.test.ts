// merge module, part a: planner facts, batch membership, mergeable-unknown state and batch updates (SQLite; Postgres when AUTOCRAFT_TEST_PG_URL is set).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db, Dialect } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import { TEST_PG_URL, testDatabase } from "../test-db.ts";
import { expectFlat } from "../helpers/query-count.ts";
import { loadBatchMembership, loadMergeFacts, loadBatchRun, loadBatches, noteMergeable, loadUnknownDue, markUnknownStuck, removeMergeState, updateBatches, setBatchSize, loadBatchSizes } from "../../src/data/merge/index.ts";

const T0 = "2026-01-01T00:00:00.000Z";

async function withDb(dialect: Dialect, fn: (db: Db) => Promise<unknown>): Promise<unknown> {
  const t = await testDatabase("", dialect);
  try { return await fn(await t.open({ app: true })); } finally { await t.close(); }
}

/** Runs on SQLite, and on Postgres when a server is configured. */
function both(name: string, fn: (db: Db) => Promise<unknown>): void {
  test(name, async () => {
    const lite = await withDb("sqlite", fn);
    if (TEST_PG_URL) assert.deepEqual(await withDb("postgres", fn), lite);
  });
}

const refs = (n: number) => Array.from({ length: n }, (_, i) => ({ repo: "app", number: i + 1 }));

/** `n` PRs, each with two attempts at one head, a verification and a run approval; PR 1 is in an open batch whose own PR is number 1000. */
async function seed(db: Db, n: number): Promise<void> {
  const q = queryDb(db);
  const k = q.k as any;
  for (const r of refs(n)) {
    await q.run(k.insertInto("merges").values([
      { repo: r.repo, number: r.number, head_oid: `h${r.number}`, run_id: "r1", at: T0, path: "rule", method: null, outcome: "refused", reason: "ci pending", ci: "pending", mergeable: "MERGEABLE" },
      { repo: r.repo, number: r.number, head_oid: `h${r.number}`, run_id: "r2", at: "2026-01-02T00:00:00.000Z", path: "rule", method: "squash", outcome: r.number % 2 ? "merged" : "refused", reason: null, ci: "success", mergeable: "MERGEABLE" },
    ]));
    await q.run(k.insertInto("verifications").values({ repo: r.repo, number: r.number, head_sha: `h${r.number}`, kind: "tests", reason: "x", state: "passed", created_at: T0 }));
    await q.run(k.insertInto("ci_run_approvals").values({ repo: r.repo, number: r.number, head_oid: `h${r.number}`, runs: "[]", approved: "[]", failed: "{}", checked_at: T0 }));
  }
  const { id } = (await q.get(k.insertInto("merge_batches").values({ repo: "app", branch: "integration-app-20260101-1", state: "open", base_sha: "b", commit_sha: "tip", pr_number: 1000, created_at: T0, updated_at: T0 }).returning("id"))) as { id: number };
  // Members written by an old pod have no repo column value.
  await q.run(k.insertInto("merge_batch_prs").values(refs(Math.min(n, 3)).map((r, i) => ({ batch_id: id, number: r.number, head_oid: `h${r.number}`, position: i, repo: i === 0 ? null : r.repo }))));
}

both("merge facts: newest attempt per head with its refusals, merged history, batch state", async (db) => {
  await seed(db, 4);
  const f = await loadMergeFacts(db, refs(4));
  const a = f.attempts.get("app#1@h1")!;
  assert.equal(a.outcome, "merged");
  assert.equal(a.refusals, 1);
  assert.equal(f.attempts.get("app#2@h2")!.outcome, "refused");
  assert.equal(f.attempts.get("app#2@h2")!.refusals, 2);
  assert.ok(f.merged.has("app#1") && !f.merged.has("app#2"));
  const m = f.merged.get("app#1")!;
  assert.equal(m.lastHead, "h1");
  assert.ok(m.firstAt <= m.lastAt);
  assert.equal(f.verifications.get("app#3@h3")?.state, "passed");
  assert.ok(f.runs.has("app#4@h4"));
  assert.equal(f.batchStates.get("app#1@h1"), "in-batch");
  assert.ok(f.activeBatched.has("app#2") && !f.activeBatched.has("app#4"));
  assert.equal(f.integration.size, 0);
  assert.ok(f.batchPrs.size === 0);
  const own = await loadMergeFacts(db, [{ repo: "app", number: 1000 }]);
  assert.ok(own.batchPrs.has("app#1000"));
  assert.equal(own.integration.get("app#1000")?.commitSha, "tip");
  assert.equal(own.integration.get("app#1000")?.members.length, 3);
  return [...f.attempts.keys()].sort();
});

both("batch membership finds members whose repo column is empty, and loadBatches keeps position order", async (db) => {
  await seed(db, 3);
  const m = await loadBatchMembership(db, refs(3));
  assert.deepEqual([...m.keys()].sort(), ["app#1", "app#2", "app#3"]);
  assert.equal(m.get("app#1")!.prNumber, 1000);
  const run = await loadBatchRun(db, "app");
  assert.deepEqual(run.active[0]!.members.map((x) => x.number), [1, 2, 3]);
  assert.ok(run.size > 0);
  assert.deepEqual([...(await loadBatches(db, run.active.map((b) => b.id))).keys()], run.active.map((b) => b.id));
});

test("merge facts and batch membership issue the same number of statements at 2 and 12 PRs", async () => {
  const unit = (run: (db: Db, n: number) => Promise<unknown>) => async (size: number) => {
    const t = await testDatabase("", "sqlite");
    const db = await t.open({ app: true });
    await seed(db, size);
    return { db, run: () => run(db, size), close: () => t.close() };
  };
  await expectFlat(unit((db, n) => loadMergeFacts(db, refs(n))), 2, 12);
  await expectFlat(unit((db, n) => loadBatchMembership(db, refs(n))), 2, 12);
});

both("noteMergeable counts reads at one head, restarts at a new head and forgets known states", async (db) => {
  const row = (head: string, mergeable: string | null = null) => ({ repo: "app", number: 7, head_oid: head, mergeable, state: "OPEN", overall: "success" });
  const taken = (head: string) => new Set([`app#7@${head}`]);
  await noteMergeable(db, [row("a")], T0, taken("a"));
  await noteMergeable(db, [row("a")], "2026-01-01T00:05:00.000Z", taken("a"));
  const s1 = await queryDb(db).get(queryDb(db).k.selectFrom("merge_state").selectAll().where("number", "=", 7));
  assert.equal(s1!.reads, 2);
  assert.equal(s1!.since, T0);
  await noteMergeable(db, [row("b")], "2026-01-01T00:10:00.000Z", taken("b"));
  const s2 = await queryDb(db).get(queryDb(db).k.selectFrom("merge_state").selectAll().where("number", "=", 7));
  assert.equal(s2!.reads, 1);
  assert.equal(s2!.head, "b");
  assert.ok(s2!.since > s1!.since);
  // Without a take review the row is not waited on, so it goes.
  await noteMergeable(db, [row("b")], "2026-01-01T00:15:00.000Z", new Set());
  assert.equal((await queryDb(db).all(queryDb(db).k.selectFrom("merge_state").select("number"))).length, 0);
});

both("markUnknownStuck matches only an unchanged row; removeMergeState drops rows of PRs that are not open", async (db) => {
  const q = queryDb(db);
  const k = q.k as any;
  await q.run(k.insertInto("merge_state").values([{ repo: "app", number: 1, head: "a", since: T0, reads: 5 }, { repo: "app", number: 2, head: "b", since: T0, reads: 5 }]));
  const n = await markUnknownStuck(db, [{ repo: "app", number: 1, head: "a", reads: 5 }, { repo: "app", number: 2, head: "b", reads: 6 }]);
  assert.equal(n, 1);
  const rows = await q.all(k.selectFrom("merge_state").select(["number", "stuck", "rereads"]).orderBy("number")) as { number: number; stuck: number; rereads: number }[];
  assert.deepEqual(rows.map((r) => [r.number, !!r.stuck, r.rereads]), [[1, true, 1], [2, false, 0]]);
  assert.equal(await removeMergeState(db, { keys: [{ repo: "app", number: 2 }] }), 1);
  assert.equal(await removeMergeState(db, { repo: "app", closed: true }), 1);
  assert.equal((await loadUnknownDue(db, "app")).length, 0);
});

both("updateBatches: compare-and-set holds, and size follows the changed batches", async (db) => {
  await seed(db, 2);
  const id = (await loadBatchRun(db, "app")).active[0]!.id;
  assert.equal(await setBatchSize(db, "app", 10), 10);
  // The batch is open, so a row that expects it checking changes nothing and does not grow the size.
  assert.deepEqual(await updateBatches(db, [{ id, at: T0, set: { state: "failed", summary: "x" }, onlyIf: ["checking"], size: "shrink" }]), []);
  assert.equal((await loadBatchSizes(db, ["app"])).get("app"), 10);
  assert.deepEqual(await updateBatches(db, [{ id, at: T0, set: { state: "failed", summary: "x", retries: 2 }, onlyIf: ["open"], size: "shrink" }]), [id]);
  assert.equal((await loadBatchSizes(db, ["app", "other"])).get("app"), 5);
  assert.equal((await loadBatchSizes(db, ["other"])).get("other"), 20);
  const b = (await loadBatches(db, [id])).get(id)!;
  assert.equal(b.state, "failed");
  assert.equal(b.retries, 2);
  assert.equal(b.members.length, 2);
  return b.state;
});
