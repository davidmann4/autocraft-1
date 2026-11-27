// workflow module, part b: person actions, the commands inbox, autorepin and the PR status comment
// (SQLite; Postgres when AUTOCRAFT_TEST_PG_URL is set).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db, Dialect } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import { TEST_PG_URL, testDatabase } from "../test-db.ts";
import { expectFlat } from "../helpers/query-count.ts";
import {
  queueActions, loadActionsDue, saveActions, loadActions, retryActions,
  queueCommands, loadCommandWork, hasCommandWork, saveCommandProgress, pruneCommands, loadNudges, recordNudges,
  requestRepin, loadRepinsDue, hasRepinDue, loadRepins, loadRepinOffs, saveRepins,
  loadStatusComments, loadLatestWorkflows, saveStatusComments, loadStatusRetriesAt, countStatusRetriesDue,
} from "../../src/data/workflow/index.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T00:00:00.000Z";
const T2 = "2026-01-03T00:00:00.000Z";

async function withDb(dialect: Dialect, fn: (db: Db) => Promise<unknown>): Promise<unknown> {
  const t = await testDatabase("", dialect);
  try { return await fn(await t.open({ app: true })); } finally { await t.close(); }
}

function both(name: string, fn: (db: Db) => Promise<unknown>): void {
  test(name, async () => {
    const lite = await withDb("sqlite", fn);
    if (TEST_PG_URL) assert.deepEqual(await withDb("postgres", fn), lite);
  });
}

const k = (db: Db) => queryDb(db).k as any;
const items = (db: Db, n: number, state = "OPEN", repo = "app") =>
  queryDb(db).run(k(db).insertInto("items").values(Array.from({ length: n }, (_, i) => ({ repo, number: i + 1, kind: "pr", state, title: "t", body: "b", is_draft: 0, head_oid: `h${i + 1}`, created_at: T0, updated_at: T0 }))));
const workflow = (db: Db, repo: string, number: number, state: string, weight = 5) =>
  queryDb(db).get(k(db).insertInto("item_workflows").values({ repo, number, kind: "pr", entry: "merge", weight, state, started_by: "ann", started_at: T0, started_via: "github", updated_at: T0 }).returning("id")) as Promise<{ id: number }>;

both("actions: a failed row restarts, a done row stays, due rows come heaviest first with the item's head", async (db) => {
  await items(db, 3);
  const light = await workflow(db, "app", 1, "running", 2), heavy = await workflow(db, "app", 2, "running", 9);
  const ids = await queueActions(db, [
    { workflowId: light.id, repo: "app", number: 1, kind: "close", by: "ann", head: "h1", at: T0 },
    { workflowId: heavy.id, repo: "app", number: 2, kind: "merge", by: "bob", head: "h2", at: T1 },
  ]);
  assert.equal(ids.size, 2);
  const due = await loadActionsDue(db);
  assert.deepEqual(due.map((d) => d.number), [2, 1]);
  assert.equal(due[0].itemHead, "h2");
  assert.equal(due[0].itemState, "OPEN");
  assert.equal((await loadActionsDue(db, { kinds: ["close"] })).length, 1);
  assert.equal((await loadActionsDue(db, { refs: [{ repo: "app", number: 2 }] })).length, 1);

  const [a, b] = [ids.get("app#1:close")!, ids.get("app#2:merge")!];
  await saveActions(db, [{ id: a, state: "failed", reason: "boom", attempts: 3, at: T1 }, { id: b, state: "done", commentUrl: "u", at: T1 }]);
  assert.equal((await loadActionsDue(db)).length, 0);
  const again = await queueActions(db, [
    { workflowId: light.id, repo: "app", number: 1, kind: "close", by: "cat", head: "h9", at: T2 },
    { workflowId: heavy.id, repo: "app", number: 2, kind: "merge", by: "dan", head: "h9", at: T2 },
  ]);
  assert.equal(again.get("app#1:close"), a);
  const rows = await loadActions(db, { refs: [{ repo: "app", number: 1 }, { repo: "app", number: 2 }] });
  const [one, two] = [rows.get("app#1")![0], rows.get("app#2")![0]];
  assert.equal(one.state, "pending");
  assert.equal(one.attempts, 0);
  assert.equal(one.reason, null);
  assert.equal(one.by, "cat");
  assert.equal(two.state, "done");
  assert.equal(two.by, "bob");
  assert.equal(two.done_at, T1);
  return rows;
});

both("actions: saveActions leaves an unchanged state and reason alone; retryActions wakes a login's waiting rows", async (db) => {
  await items(db, 2);
  const w = await workflow(db, "app", 1, "running");
  const ids = await queueActions(db, [
    { workflowId: w.id, repo: "app", number: 1, kind: "merge", by: "Ann", head: null, state: "waiting-token", at: T0 },
    { workflowId: w.id, repo: "app", number: 1, kind: "close", by: "bob", head: null, state: "waiting-token", at: T0 },
  ]);
  await saveActions(db, [{ id: ids.get("app#1:merge")!, state: "waiting-token", reason: null, at: T2 }]);
  assert.equal((await loadActions(db, { workflowIds: [w.id] })).get("app#1")![0].updated_at, T0);
  await saveActions(db, [{ id: ids.get("app#1:merge")!, state: "waiting-permission", reason: "no write", at: T2 }]);
  assert.equal((await loadActions(db, { workflowIds: [w.id] })).get("app#1")![0].updated_at, T2);
  assert.equal((await loadActions(db, { waitingFor: "ann" })).get("app#1")!.length, 1);
  assert.equal(await retryActions(db, { login: "ANN" }), 1);
  assert.equal((await loadActionsDue(db)).length, 1);
  assert.equal(await retryActions(db, { ids: [ids.get("app#1:close")!] }), 1);
  assert.equal((await loadActionsDue(db)).length, 2);
});

test("actions: statements do not grow with the number of rows", async () => {
  await expectFlat(async (size) => {
    const t = await testDatabase("", "sqlite");
    const db = await t.open({ app: true });
    const w = await workflow(db, "app", 1, "running");
    const rows = Array.from({ length: size }, (_, i) => ({ workflowId: w.id, repo: "app", number: i + 1, kind: "close" as const, by: "ann", head: null, at: T0 }));
    return { db, close: () => t.close(), run: async () => {
      const ids = await queueActions(db, rows);
      await saveActions(db, [...ids.values()].map((id) => ({ id, state: "done" as const, reason: "x", at: T1 })));
      await loadActionsDue(db);
      await loadActions(db, { refs: rows });
    } };
  }, 3, 60);
});

const cmd = (id: number, at = T0) => ({ comment_id: id, repo: "app", number: 1, pr: 1, login: "Ann", github_id: 7, created_at: at, requested_at: at, parsed: JSON.stringify({ kind: "yes" }) });

both("commands: a redelivered comment adds nothing; progress counts retries; work leaves the queue when settled and replied", async (db) => {
  assert.equal(await queueCommands(db, [cmd(1), cmd(2, T1)]), 2);
  assert.equal(await queueCommands(db, [cmd(1), cmd(3, T2)]), 1);
  assert.deepEqual((await loadCommandWork(db, { limit: 10 })).map((c) => c.comment_id), [1, 2, 3]);
  assert.equal((await loadCommandWork(db, { limit: 2 })).length, 2);
  await saveCommandProgress(db, [{ commentId: 1, triedAt: T2, retryInc: true }, { commentId: 2, triedAt: T2 }]);
  const rows = await loadCommandWork(db, { limit: 10 });
  assert.equal(rows.at(-1)!.comment_id, 2, "tried commands come after never-tried ones");
  assert.deepEqual(rows.map((c) => [c.comment_id, c.retries]), [[3, 0], [1, 1], [2, 0]]);
  assert.deepEqual((await loadCommandWork(db, { limit: 10, retryBefore: T1 })).map((c) => c.comment_id), [3]);
  await queryDb(db).run(k(db).updateTable("github_commands").set({ state: "done", reply: "posted", done_at: T0 }).where("comment_id", "in", [1, 3]));
  assert.equal(await queryDb(db).run(k(db).updateTable("github_commands").set({ state: "done", done_at: T0 }).where("comment_id", "=", 2)).then((r) => r.changes), 1);
  assert.equal(await hasCommandWork(db), true, "a settled command whose answer is still to post is work");
  await saveCommandProgress(db, [{ commentId: 2, reply: "posted" }]);
  assert.equal(await hasCommandWork(db), false);
  assert.equal(await pruneCommands(db, Date.parse(T2) + 31 * 86400_000), 3);
});

both("commands: nudges are matched without regard to case", async (db) => {
  await recordNudges(db, [{ login: "Ann", at: T0 }, { login: "bob", at: T0 }]);
  await recordNudges(db, [{ login: "ANN", at: T1 }]);
  const n = await loadNudges(db, ["ann", "bob", "cat"]);
  assert.deepEqual([...n], [["ann", T1], ["bob", T0]]);
});

test("commands: progress and queue statements do not grow with the number of rows", async () => {
  await expectFlat(async (size) => {
    const t = await testDatabase("", "sqlite");
    const db = await t.open({ app: true });
    const ids = Array.from({ length: size }, (_, i) => i + 1);
    return { db, close: () => t.close(), run: async () => {
      await queueCommands(db, ids.map((i) => cmd(i)));
      await saveCommandProgress(db, ids.flatMap((i) => [{ commentId: i, triedAt: T1 }, { commentId: i, reply: "none" as const }].slice(0, i % 2 + 1)));
      await loadCommandWork(db, { limit: 100 });
    } };
  }, 3, 60);
});

const repin = (o: Partial<Parameters<typeof requestRepin>[1]> = {}) => ({ repo: "app", number: 1, refRepo: "lib", refNumber: 5, refBranch: null, login: "ann", githubId: 7, at: T1, ...o });

both("autorepin: a newer command replaces the row, an off cancels waiting and locking rows and keeps the later command out", async (db) => {
  await items(db, 1, "OPEN", "app");
  assert.equal((await requestRepin(db, repin())).result, "set");
  await assert.rejects(requestRepin(db, repin({ at: T0, refNumber: 6 })), /later autorepin command/);
  assert.equal((await requestRepin(db, repin({ at: T2, refNumber: 6, login: "bob" }))).result, "set");
  const row = (await loadRepins(db, [{ repo: "app", number: 1 }])).get("app#1")![0];
  assert.deepEqual([row.ref_number, row.login, row.state], [6, "bob", "waiting"]);
  assert.equal(await saveRepins(db, [{ key: { repo: "app", number: 1, refRepo: "lib", refNumber: 6, login: "bob", requestedAt: T2 }, expectState: "waiting", patch: { state: "locking", task_id: 42, head: "h1" } }]), 1);
  assert.equal(await saveRepins(db, [{ key: { repo: "app", number: 1, refRepo: "lib", refNumber: 6, login: "bob" }, expectState: "waiting", patch: { state: "failed" } }]), 0, "the row no longer waits");
  const off = await requestRepin(db, repin({ off: true, at: "2026-01-04T00:00:00.000Z" }));
  assert.deepEqual([off.result, off.cancelledTasks, off.cancelled], ["off", [42], 1]);
  await assert.rejects(requestRepin(db, repin({ at: T2 })), /later autorepin off/);
  assert.equal((await loadRepinOffs(db, [{ repo: "app", number: 1 }])).get("app#1"), "2026-01-04T00:00:00.000Z");
  assert.equal((await loadRepins(db, [{ repo: "app", number: 1 }], { states: ["cancelled"] })).get("app#1")!.length, 1);
});

both("autorepin: due when the dependency is no longer open, or its lockfile task ended", async (db) => {
  await items(db, 1, "OPEN", "app");
  await queryDb(db).run(k(db).insertInto("items").values({ repo: "lib", number: 5, kind: "pr", state: "OPEN", title: "t", body: "b", is_draft: 0, created_at: T0, updated_at: T0 }));
  await requestRepin(db, repin());
  const now = new Date("2026-02-01T00:00:00.000Z");
  assert.equal(await hasRepinDue(db, now), false);
  await queryDb(db).run(k(db).updateTable("items").set({ state: "MERGED" }).where("repo", "=", "lib"));
  assert.equal(await hasRepinDue(db, now), true);
  assert.deepEqual((await loadRepinsDue(db, now)).map((r) => r.ref_number), [5]);
});

both("status comments: a Closed line on a closed item is final; the latest workflow of each item with its open state", async (db) => {
  await items(db, 3);
  await queryDb(db).run(k(db).updateTable("items").set({ state: "CLOSED" }).where("number", "=", 2));
  const row = (number: number, line: string, o: object = {}) => ({ repo: "app", number, comment_id: `c${number}`, author: "bot", line, steps: "[]", final: 0, failures: 0, retry_at: null, updated_at: T0, ...o });
  await saveStatusComments(db, [row(1, "In review"), row(2, "Closed"), row(3, "Closed"), row(4, "Merged", { final: 1 })]);
  await saveStatusComments(db, [row(1, "Waiting for CI", { retry_at: "2026-06-01T00:00:00.000Z" })]);
  const rows = await loadStatusComments(db, ["app"]);
  assert.deepEqual(rows.map((r) => [r.number, r.line]), [[1, "Waiting for CI"], [3, "Closed"]]);
  assert.equal((await loadStatusRetriesAt(db, ["app"], Date.parse(T0))).get("app"), Date.parse("2026-06-01T00:00:00.000Z"));
  assert.equal((await loadStatusRetriesAt(db, ["app"], Date.parse(T2) + 1e11)).get("app"), undefined);
  assert.equal(await countStatusRetriesDue(db, Date.parse("2026-07-01T00:00:00.000Z")), 1);
  assert.equal(await countStatusRetriesDue(db, Date.parse(T0)), 0);

  await workflow(db, "app", 1, "stopped");
  const latest = await workflow(db, "app", 1, "running");
  await workflow(db, "app", 2, "running");
  const m = await loadLatestWorkflows(db, ["app"]);
  assert.equal(m.get("app#1")!.wf.id, latest.id);
  assert.equal(m.get("app#1")!.open, true);
  assert.equal(m.get("app#2")!.open, false);
});
