// The planner's change log: which writes re-decide which items, and which force a full pass.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { bulkWrites, changeCursor, changesSince, pruneChanges, type ChangeCursor } from "../src/core/plan-changes.ts";
import { PLAN_INPUTS } from "../src/core/plan-inputs.ts";
import { loadPrFacts } from "../src/core/facts.ts";
import { loadPlanSet } from "../src/core/plan-set.ts";
import { inReadSnapshot, planPass } from "../src/core/plan-engine.ts";
import { writePlanCache } from "../src/core/plan-cache.ts";
import { dueCandidates } from "../src/core/plan-read.ts";
import { planned } from "../src/core/select.ts";
import { latestRun } from "../src/classify/settled.ts";
import { setReviewMinInterval } from "../src/review/gate.ts";
import { saveOpus } from "../src/review/opus.ts";
import { SCRATCH } from "./scratch.ts";
import { world } from "./world-db.ts";
import { everySeq, filterSeq } from "../src/async-seq.ts";
import type { Db } from "../src/db/index.ts";
import { connectDb } from "../src/db/open.ts";
import { sqliteOnly } from "./test-db.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "plan-changes-"));
const T = "2026-01-01T00:00:00Z";

test("writes log the items they re-decide; stamp-only updates log nothing; cross-item and global writes reach every affected item or force a full pass", async () => {
  const db = await connectDb(join(dir, "log.db"));
  const since = async (cursor: ChangeCursor) => { const c = await changesSince(db, cursor); return { ...c, refs: [...c.refs].sort() }; };
  let seq = await changeCursor(db);

  // Item-keyed: the row's own item.
  await db.run(db.k.insertInto("item_rank").values({ repo: "app", number: 7, score: 1, breakdown: "{}", computed_at: T }));
  let c = await since(seq);
  assert.deepEqual([c.refs, c.full], [["app#7"], false]);
  seq = c.cursor;

  // A bookkeeping column alone: nothing.
  await db.run(db.k.updateTable("item_rank").set({ computed_at: "2026-01-02T00:00:00Z" }).where("repo", "=", "app").where("number", "=", 7));
  c = await since(seq);
  assert.deepEqual([c.refs, c.full], [[], false]);
  assert.deepEqual(c.cursor, seq);

  // A bookkeeping column the Plan reads (jev_failed_hash) logs its item, with no full pass.
  await db.run(db.k.insertInto("items").values({ repo: "app", number: 20, kind: "issue", state: "OPEN", title: "t", body: "b", author: "someone", created_at: T, updated_at: T }));
  seq = (await since(seq)).cursor;
  await db.run(db.k.updateTable("items").set({ jev_failed_hash: "h" }).where("repo", "=", "app").where("number", "=", 20));
  c = await since(seq);
  assert.deepEqual([c.refs, c.full], [["app#20"], false]);
  seq = c.cursor;

  // A key move logs the old and the new item.
  await db.run(db.k.updateTable("item_rank").set({ number: 8 }).where("repo", "=", "app").where("number", "=", 7));
  c = await since(seq);
  assert.deepEqual(c.refs, ["app#7", "app#8"]);
  seq = c.cursor;

  // Cross-item: a batch row reaches its integration PR and every member.
  const batch = Number((await db.get(db.k.insertInto("merge_batches").values({ repo: "app", branch: "integration-1", state: "open", base_sha: "b", commit_sha: "c", pr_number: 50, created_at: T, updated_at: T }).returning("id")))!.id);
  await db.run(db.k.insertInto("merge_batch_prs").values([{ batch_id: batch, number: 3, head_oid: "h3", position: 0 }, { batch_id: batch, number: 4, head_oid: "h4", position: 1 }]));
  seq = (await since(seq)).cursor;
  await db.run(db.k.updateTable("merge_batches").set({ state: "merged" }).where("id", "=", batch));
  c = await since(seq);
  assert.deepEqual([c.refs, c.full], [["app#3", "app#4", "app#50"], false]);
  seq = c.cursor;

  // Cross-item without a readable set: a full pass, and later logged items after it still count.
  await db.prepare("INSERT INTO fast_track (repo, number, added_by, added_at) VALUES ('app', 9, 'op', ?)").run(T);
  c = await since(seq);
  assert.equal(c.full, true);
  assert.ok(c.cursor.gen > seq.gen);
  // The mark is counted under the trigger that made it, with the generation it made.
  assert.deepEqual({ ...await db.get(db.k.selectFrom("plan_full_causes").select(["n", "last_seq"]).where("source", "=", "plan_fast_track_full_i")) }, { n: 1, last_seq: c.cursor.gen });
  seq = c.cursor;

  // Global: a planner input setting forces a full pass; the planner's own bookkeeping setting does not.
  await db.prepare("INSERT INTO settings (key, value) VALUES ('runner_heartbeat', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(T);
  assert.equal((await since(seq)).full, false);
  // The leader's status row, rewritten every few seconds, is bookkeeping too.
  await db.prepare("INSERT INTO settings (key, value) VALUES ('leader:runner', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(T);
  assert.equal((await since(seq)).full, false);
  // A write permission: a new row forces a full pass, a refresh of a fresh row does not, a refresh of an expired one does.
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  await db.run(db.k.insertInto("repo_permissions").values({ login: "maint", repo: "app", permission: "write", checked_at: ago(8) }));
  c = await since(seq);
  assert.equal(c.full, true);
  seq = c.cursor;
  await db.run(db.k.updateTable("repo_permissions").set({ checked_at: ago(0) }).where("login", "=", "maint"));
  assert.equal((await since(seq)).full, false);
  await db.run(db.k.updateTable("repo_permissions").set({ checked_at: ago(30) }).where("login", "=", "maint"));
  seq = (await since(seq)).cursor;
  await db.run(db.k.updateTable("repo_permissions").set({ checked_at: ago(0) }).where("login", "=", "maint"));
  c = await since(seq);
  assert.equal(c.full, true);
  seq = c.cursor;
  await db.prepare("INSERT INTO settings (key, value) VALUES ('pipeline_enabled', '1') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();
  c = await since(seq);
  assert.equal(c.full, true);
  seq = c.cursor;
  // Default-branch CI: a running head's check list alone moves no fact, its state does.
  await db.run(db.k.insertInto("main_ci").values({ repo: "app", head_sha: "m1", branch: "main", state: "running", failing: "[]", checks: "[]", first_seen_at: T, state_changed_at: T, updated_at: T }));
  seq = (await since(seq)).cursor;
  await db.run(db.k.updateTable("main_ci").set({ checks: '[{"name":"build","state":"success","url":null}]' }).where("head_sha", "=", "m1"));
  assert.equal((await since(seq)).full, false);
  await db.run(db.k.updateTable("main_ci").set({ state: "green" }).where("head_sha", "=", "m1"));
  c = await since(seq);
  assert.equal(c.full, true);
  seq = c.cursor;

  // A PR's text edit as sync writes it (the row, then its references): the issues the old and the new text name, no full pass.
  await db.run(db.k.insertInto("items").values({ repo: "app", number: 60, kind: "pr", state: "OPEN", title: "t", body: "Fixes #61", text_refs: "[[61],[61]]", closing_issues: "[62]", created_at: T }));
  seq = (await since(seq)).cursor;
  await db.write(async () => {
    await db.run(db.k.updateTable("items").set({ body: "See #63" }).where("number", "=", 60));
    await db.run(db.k.updateTable("items").set({ text_refs: "[[],[63]]" }).where("number", "=", 60));
  });
  c = await since(seq);
  assert.equal(c.full, false);
  assert.deepEqual(c.refs.filter((r) => ["app#60", "app#61", "app#62", "app#63"].includes(r)), ["app#60", "app#61", "app#62", "app#63"]);
  seq = c.cursor;
  // Without stored references the issues the old text named are unknown.
  await db.run(db.k.updateTable("items").set({ text_refs: null }).where("number", "=", 60));
  seq = (await since(seq)).cursor;
  await db.run(db.k.updateTable("items").set({ body: "Fixes #64" }).where("number", "=", 60));
  c = await since(seq);
  assert.equal(c.full, true);
  seq = c.cursor;

  // A prune deletes what was read; the next write is read after it.
  await pruneChanges(db, seq);
  assert.equal((await db.get(db.k.selectFrom("item_changes").select((eb) => eb.fn.countAll<number>().as("n"))))!.n, 0);
  await db.prepare("INSERT INTO merge_holds (repo, number, held_by, held_at) VALUES ('app', 11, 'op', ?)").run(T);
  c = await since(seq);
  assert.deepEqual([c.refs, c.full], [["app#11"], false]);
  seq = c.cursor;

  // The planner's own Plan cache is an input only of items with an open decision, so its writes do not reload every item it plans.
  const plan = (number: number, actions: string) => db.run(db.k.insertInto("main.item_plans").values({ repo: "app", number, kind: "pr", state: "s", actions, reasons: "[]", view: "{}", planned_at: T })
    .onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet({ actions })));
  await db.run(db.k.insertInto("decisions").values({ id: "dq", kind: "merge", repo: "app", number: 31, asked_at: T, asked_by: "x", question: "q", options: "[]" }));
  seq = (await since(seq)).cursor;
  await plan(30, "[]");
  await plan(31, "[]");
  c = await since(seq);
  assert.deepEqual(c.refs, ["app#31"]);
  seq = c.cursor;
  await db.run(db.k.updateTable("decisions").set({ answer: "merge" }).where("id", "=", "dq"));
  seq = (await since(seq)).cursor;
  await plan(31, '[{"kind":"review","head":"h"}]');
  c = await since(seq);
  assert.deepEqual([c.refs, c.full], [[], false]);
  await db.close();
});

test("every table the fact loaders read is classified", { skip: sqliteOnly("reads sqlite_master") }, async () => {
  const db = await connectDb(join(dir, "reads.db"));
  const tables = (await db.prepare("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").all() as { name: string; type: string; sql: string }[]);
  const views = new Map(tables.filter((t) => t.type === "view").map((t) => [t.name, t.sql]));
  // A view stands for the tables its own SQL names. Query builder statements quote their names ("main"."items").
  const named = (sql: string, out: Set<string>, seen = new Set<string>()): void => {
    for (const t of tables) {
      if (seen.has(t.name) || !new RegExp(`(?<![\\w.'"])(?:(?:main|"main")\\.)?(?:${t.name}|"${t.name}")(?![\\w'"])`).test(sql)) continue;
      if (views.has(t.name)) named(views.get(t.name)!, out, new Set([...seen, t.name])); else out.add(t.name);
    }
  };
  const read = new Set<string>();
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (this: Db, sql: string, ...rest: unknown[]) {
    named(sql, read);
    return (prepare as (...a: unknown[]) => ReturnType<typeof prepare>).call(this, sql, ...rest);
  } as typeof prepare;
  try { await loadPlanSet(db, { now: Date.parse(T) }); } finally { DatabaseSync.prototype.prepare = prepare; }
  const listed = new Set(PLAN_INPUTS.map((p) => p.table));
  assert.ok(read.size > 20);
  assert.deepEqual([...read].filter((t) => !listed.has(t)).sort(), []);
  // An item input without its own refs is logged by its repo and number columns.
  const cols = async (t: string) => (await db.prepare("SELECT name FROM pragma_table_info(?)").all(t) as { name: string }[]).map((c) => c.name);
  assert.deepEqual((await filterSeq(PLAN_INPUTS, async (p) => p.class === "item" && !p.refs && !await everySeq(["repo", "number"], async (c) => (await cols(p.table)).includes(c)))).map((p) => p.table), []);
  await db.close();
});

test("a PR's facts change with the clock alone no earlier than its refreshAt: a review held on another item stops waiting when the blocker list expires", async () => {
  const w = await (await (await (await world()).repo()).pr(1, { head: "h1" })).pr(2);
  await setReviewMinInterval(w.db, 0, "test");
  await saveOpus(w.db, "rv", { repo: "app", number: 1, head_oid: "h1" }, {
    mode: "full", base: null, model: "m",
    review: { ref: "app#1", verdict: "hold", sure: true, reason: "r", fixes: [], risks: [], summary: null, why: null, public: null, conflicts: [], claims: [], blocked_by: ["app#2"] },
  });
  await w.synced(1, "h2");
  const at = Date.parse((await w.db.get(w.db.k.selectFrom("opus_reviews").select("at").where("number", "=", 1)))!.at);
  const load = async (now: number) => (await loadPrFacts(w.db, { now, refs: ["app#1"] }))[0]!;
  const f = await load(at + 3600_000);
  assert.equal(f.reviewHold?.kind, "blocked");
  assert.ok(f.refreshAt! > f.now);
  // Up to refreshAt a load gives the same facts at another time; at refreshAt they differ.
  assert.deepEqual({ ...await load(f.refreshAt! - 1), now: f.now }, f);
  const after = await load(f.refreshAt!);
  assert.notEqual(after.reviewHold?.kind, "blocked");
  assert.equal(after.review?.stale, true);
});

test("the incremental pass reloads only logged and due items, and its PlanSet equals a full load after each write", async () => {
  const prev = process.env.AUTOCRAFT_PLAN_SHADOW;
  process.env.AUTOCRAFT_PLAN_SHADOW = "throw";
  try {
    const w = await (await (await (await (await (await (await world()).repo()).pr(1)).pr(2)).issue(3)).review(1)).review(2, { verdict: "take-fix" });
    let now = Date.parse(T) + 3600_000;
    const pass = async () => {
      const p = await inReadSnapshot(w.db, async () => await planPass(w.db, { now, run: await latestRun(w.db), fullEveryMs: 30 * 60_000 }));
      await p.finish();
      return { kind: p.kind, refs: p.refs };
    };
    assert.equal((await pass()).kind, "full:start");
    assert.deepEqual(await pass(), { kind: "incremental", refs: 0 });
    // A new item moves other items' facts (open PRs of an issue, duplicate sets): a full load.
    await w.pr(4);
    assert.equal((await pass()).kind, "full:marker");
    await w.review(4, { verdict: "hold" });
    await w.db.run(w.db.k.insertInto("comments").values({ id: "c1", repo: "app", number: 3, author: "someone", body: "still broken", created_at: T }));
    assert.deepEqual(await pass(), { kind: "incremental", refs: 2 });
    await w.db.run(w.db.k.updateTable("items").set({ state: "CLOSED" }).where("repo", "=", "app").where("number", "=", 2));
    await pass();
    await w.db.prepare("INSERT INTO settings (key, value) VALUES ('plan_shadow', 'on')").run();
    assert.deepEqual(await pass(), { kind: "incremental", refs: 0 });
    now += 31 * 60_000;
    assert.equal((await pass()).kind, "full:floor");
    // The pass's records are not planner inputs.
    assert.deepEqual(await pass(), { kind: "incremental", refs: 0 });
  } finally {
    if (prev === undefined) delete process.env.AUTOCRAFT_PLAN_SHADOW; else process.env.AUTOCRAFT_PLAN_SHADOW = prev;
  }
});

test("a step outside the planner decides the items its stored Plans hold and the changes no stored Plan covers yet", async () => {
  const w = await (await (await (await (await world()).repo()).pr(1)).pr(2)).review(1);
  const pass = async () => {
    const p = await inReadSnapshot(w.db, async () => await planPass(w.db, { now: Date.now(), run: await latestRun(w.db), fullEveryMs: 30 * 60_000 }));
    await writePlanCache(w.db, p.plans);
    await p.finish();
  };
  const candidates = async () => (await dueCandidates(w.db, "verify", "pr"))!.sort();
  const due = async () => (await planned(w.db, "verify")).map((p) => p.facts.number);
  // A pass that writes the Plan of an item with an open decision logs the item (item_plans is its input); the next pass covers that.
  await pass();
  await pass();
  assert.deepEqual(await candidates(), ["app#1"], "only the reviewed PR's stored Plan holds verify");
  await w.db.run(w.db.k.insertInto("comments").values({ id: "c2", repo: "app", number: 2, author: "someone", body: "ping", created_at: T }));
  await w.pr(3);
  assert.deepEqual(await candidates(), ["app#1", "app#2", "app#3"], "a change after the stored Plans and a PR without one are decided again");
  assert.deepEqual(await due(), [1]);
  await pass();
  await pass();
  assert.deepEqual(await candidates(), ["app#1"], "the passes that planned the changes took them out of the log");
  assert.deepEqual(await due(), [1]);
});

test("a held PR is logged when its blocker closes; a bulk write logs nothing and takes one full mark; malformed rows and a lost marker row fail no write", async () => {
  const db = await connectDb(join(dir, "robust.db"));
  const since = async (cursor: ChangeCursor) => { const c = await changesSince(db, cursor); return { ...c, refs: [...c.refs].sort() }; };
  for (const n of [1, 2, 3]) await db.run(db.k.insertInto("items").values({ repo: "app", number: n, kind: "pr", state: "OPEN", title: "t", created_at: T }));
  await db.run(db.k.insertInto("opus_reviews").values({ repo: "app", number: 1, head_oid: "h1", at: T, mode: "full", verdict: "hold", blocked_by: '["app#2", 7, "app#2"]' }));
  let seq = await changeCursor(db);
  await db.run(db.k.updateTable("items").set({ state: "CLOSED" }).where("number", "=", 2));
  let c = await since(seq);
  assert.ok(c.full || c.refs.includes("app#1"), "the PR held for app#2 is decided again");
  seq = c.cursor;

  // A decision whose items are not a list of objects is still written and logs its own item.
  await db.run(db.k.insertInto("decisions").values({ id: "d1", kind: "merge", repo: "app", number: 3, items: '["app#1", 5]', asked_at: T, asked_by: "x", question: "q", options: "[]" }));
  await db.run(db.k.updateTable("decisions").set({ items: '{"repo": "app"}' }).where("id", "=", "d1"));
  c = await since(seq);
  assert.ok(c.full || c.refs.includes("app#3"));
  seq = c.cursor;

  await bulkWrites(db, "test", async () => { for (const n of [1, 3]) await db.run(db.k.updateTable("items").set({ embed_hash: `e${n}` }).where("number", "=", n)); });
  c = await since(seq);
  assert.equal(c.full, true);
  assert.deepEqual((await db.all(db.k.selectFrom("item_changes").select("seq"))).filter((r) => !seq.seen.has(r.seq)), []);
  seq = c.cursor;

  await db.run(db.k.deleteFrom("plan_full"));
  await db.script(db.dialect === "postgres"
    ? "SELECT setval(pg_get_serial_sequence('item_changes', 'seq'), 1, false)"
    : "DELETE FROM sqlite_sequence WHERE name = 'item_changes'");
  await db.prepare("INSERT INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('other', 'op', ?, 1)").run(T);
  assert.equal((await changesSince(db, seq)).full, true);
});
