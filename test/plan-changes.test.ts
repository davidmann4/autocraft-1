// The planner's change log: which writes re-decide which items, and which force a full pass.
import { withConfig } from "../src/data/control/index.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { bulkWrites, changeCursor, changesSince, pruneChanges, type ChangeCursor } from "../src/core/plan-changes.ts";
import { PLAN_INPUTS } from "../src/trigger-sources.ts";
import { loadPrFacts } from "../src/core/facts.ts";
import { loadPlanSet } from "../src/core/plan-set.ts";
import { inReadSnapshot, planPass } from "../src/core/plan-engine.ts";
import { writePlanCache } from "../src/core/plan-cache.ts";
import { loadDueRefs } from "../src/data/planner/index.ts";
import { planned } from "../src/core/select.ts";
import { classifyRun as latestRun } from "../src/data/triage/index.ts";
import { setReviewMinInterval } from "../src/review/gate.ts";
import { fillEmbedHashes } from "../src/itemhash.ts";
import { saveOpus } from "../src/review/opus.ts";
import { SCRATCH } from "./scratch.ts";
import { world } from "./world-db.ts";
import { everySeq, filterSeq } from "../src/async-seq.ts";
import { connectDb, type Db } from "./helpers/raw-db.ts";
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

  // A classify failure row (classify_state jev_failed) logs its item, with no full pass.
  await db.run(db.k.insertInto("items").values({ repo: "app", number: 20, kind: "issue", state: "OPEN", title: "t", body: "b", author: "someone", created_at: T, updated_at: T }));
  seq = (await since(seq)).cursor;
  await db.run(db.k.insertInto("classify_state").values({ kind: "jev_failed", repo: "app", number: 20, value: "h", at: T }));
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

  // Cross-item without a readable set (a workflow's start moves its item's scope): a full pass, and later logged items after it still count.
  await db.run(db.k.insertInto("item_workflows").values({ repo: "app", number: 9, kind: "pr", entry: "review", state: "running", started_by: "op", started_at: T, started_via: "dashboard", updated_at: T }));
  c = await since(seq);
  assert.equal(c.full, true);
  assert.ok(c.cursor.gen > seq.gen);
  // The mark is counted under the trigger that made it, with the generation it made.
  assert.deepEqual({ ...await db.get(db.k.selectFrom("plan_full_causes").select(["n", "last_seq"]).where("source", "=", "plan_item_workflows_full_i")) }, { n: 1, last_seq: c.cursor.gen });
  seq = c.cursor;
  // Its weight and approval are the item's alone, its recommendation is no fact, and its end is cross-item again.
  const workflow = (set: { weight?: number; approved_by?: string; rec?: string; state?: string }) => db.run(db.k.updateTable("item_workflows").set({ ...set, updated_at: new Date().toISOString() }).where("number", "=", 9));
  for (const set of [{ weight: 8 }, { approved_by: "op" }]) {
    await workflow(set);
    c = await since(seq);
    assert.deepEqual([c.refs, c.full], [["app#9"], false]);
    seq = c.cursor;
  }
  // Its state is also a fact of the PRs held for it (a person is asked or not), the implementation PR of its issue reads it, and neither needs a full pass.
  await db.run(db.k.insertInto("opus_reviews").values({ repo: "app", number: 12, head_oid: "h12", at: T, mode: "full", verdict: "hold", blocked_by: '["app#9"]' }));
  await db.run(db.k.insertInto("implementations").values({ repo: "app", number: 9, pr_number: 13, state: "pr-opened", text_hash: "h", attempt: 1, created_at: T, updated_at: T, queued_by: "op" }));
  for (const n of [12, 13]) await db.run(db.k.insertInto("items").values({ repo: "app", number: n, kind: "pr", state: "OPEN", title: "t", created_at: T }));
  seq = (await since(seq)).cursor;
  for (const state of ["recommending", "running"]) {
    await workflow({ state });
    c = await since(seq);
    assert.deepEqual([c.refs, c.full], [["app#12", "app#13", "app#9"], false]);
    seq = c.cursor;
  }
  await workflow({ rec: "{}" });
  c = await since(seq);
  assert.deepEqual([c.refs, c.full], [[], false]);
  // Its link to a PR (item_workflows.pr_number): the issue and the linked PR, with no full pass.
  await db.run(db.k.updateTable("item_workflows").set({ pr_number: 14 }).where("number", "=", 9));
  c = await since(seq);
  assert.ok(c.refs.includes("app#9") && c.refs.includes("app#14") && !c.full, c.refs.join(" "));
  seq = c.cursor;
  await workflow({ state: "stopped" });
  c = await since(seq);
  assert.equal(c.full, true);
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
  await db.prepare("INSERT INTO item_rank (repo, number, score, breakdown, computed_at) VALUES ('app', 11, 1, '{}', ?)").run(T);
  c = await since(seq);
  assert.deepEqual([c.refs, c.full], [["app#11"], false]);
  seq = c.cursor;

  // The planner's own Plan cache is no input, so a pass does not reload the items it plans, also those with a live workflow.
  await db.run(db.k.insertInto("item_workflows").values({ repo: "app", number: 31, kind: "pr", entry: "review", state: "recommending", started_by: "op", started_at: T, started_via: "dashboard", updated_at: T }));
  seq = (await since(seq)).cursor;
  for (const [number, actions] of [[30, "[]"], [31, "[]"], [31, '[{"kind":"review","head":"h"}]']] as const) {
    await db.run(db.k.insertInto("main.item_plans").values({ repo: "app", number, kind: "pr", state: "s", actions, reasons: "[]", view: "{}", planned_at: T })
      .onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet({ actions })));
  }
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

test("a person's fix-up request stops counting at the PR's refreshAt, when GitHub has not confirmed their write access again", async () => {
  const w = await (await (await (await world()).repo()).acting("mira")).pr(1, { head: "h1" });
  const now = Date.now(), checked = new Date(now - 30 * 60_000).toISOString();
  await w.db.run(w.db.k.updateTable("repo_permissions").set({ checked_at: checked }).where("login", "=", "mira"));
  await w.db.run(w.db.k.insertInto("operator_fixups").values({ repo: "app", number: 1, from_head: "h1", instructions: "x", by: "Mira", at: checked, state: "queued" }));
  const load = async (at: number) => (await loadPrFacts(w.db, { now: at, refs: ["app#1"] }))[0]!;
  const f = await load(now);
  assert.ok(f.operator?.fix);
  assert.ok(f.refreshAt! > now && f.refreshAt! <= now + 30 * 60_000);
  assert.equal((await load(f.refreshAt!)).operator?.fix ?? null, null);
});

test("the incremental pass reloads only logged and due items, and its PlanSet equals a full load after each write", async () => {
  const prev = process.env.AUTOCRAFT_PLAN_SHADOW;
  process.env.AUTOCRAFT_PLAN_SHADOW = "throw";
  try {
    const w = await (await (await (await (await (await (await world()).repo()).pr(1)).pr(2)).issue(3)).review(1)).review(2, { verdict: "take-fix" });
    let now = Date.parse(T) + 3600_000;
    const pass = async () => {
      const p = await withConfig(w.db, () => inReadSnapshot(w.db, async () => await planPass(w.db, { now, run: await latestRun(w.db), fullEveryMs: 30 * 60_000 })));
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
    // A duplicate pair of PRs 1 and 4: its verdict, a state or a start of either, and a person's ruling move the other's facts.
    await fillEmbedHashes(w.db);
    const hash = async (n: number) => (await w.db.get(w.db.k.selectFrom("items").select("embed_hash").where("repo", "=", "app").where("number", "=", n)))!.embed_hash!;
    const held = async () => { await pass(); return (await loadPlanSet(w.db, { now })).prs.filter((x) => x.facts.duplicates).map((x) => x.facts.number); };
    await w.db.run(w.db.k.insertInto("duplicate_pairs").values({ repo: "app", a: 1, b: 4, a_hash: await hash(1), b_hash: await hash(4), similarity: 0.9, by_operator: 0, created_at: T }));
    assert.deepEqual(await held(), []);
    await w.db.run(w.db.k.updateTable("duplicate_pairs").set({ verdict: "duplicate" }));
    assert.deepEqual(await held(), [1, 4]);
    await w.db.run(w.db.k.updateTable("items").set({ state: "MERGED" }).where("repo", "=", "app").where("number", "=", 4));
    assert.deepEqual(await held(), [1]);
    await w.db.run(w.db.k.updateTable("duplicate_pairs").set({ by_operator: 1 }));
    assert.deepEqual(await held(), []);
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
    const p = await withConfig(w.db, () => inReadSnapshot(w.db, async () => await planPass(w.db, { now: Date.now(), run: await latestRun(w.db), fullEveryMs: 30 * 60_000 })));
    await writePlanCache(w.db, p.plans);
    await p.finish();
  };
  const candidates = async () => (await loadDueRefs(w.db, "verify", "pr"))!.sort();
  const due = async () => (await planned(w.db, "verify")).map((p) => p.facts.number);
  await pass();
  assert.deepEqual(await candidates(), ["app#1"], "only the reviewed PR's stored Plan holds verify");
  await w.db.run(w.db.k.insertInto("comments").values({ id: "c2", repo: "app", number: 2, author: "someone", body: "ping", created_at: T }));
  await w.pr(3);
  assert.deepEqual(await candidates(), ["app#1", "app#2", "app#3"], "a change after the stored Plans and a PR without one are decided again");
  assert.deepEqual(await due(), [1]);
  await pass();
  assert.deepEqual(await candidates(), ["app#1"], "the pass that planned the changes took them out of the log");
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

  // A PR whose issue links are not lists is still written and logs its own item.
  for (const set of [{ closing_issues: '["app#1", 5]' }, { closing_issues: '{"repo": "app"}', text_refs: '{"a": 1}' }, { closing_issues: "[5", text_refs: "[[]" }]) {
    await db.run(db.k.updateTable("items").set(set).where("number", "=", 3));
    c = await since(seq);
    assert.ok(c.full || c.refs.includes("app#3"), JSON.stringify(set));
    seq = c.cursor;
  }

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
