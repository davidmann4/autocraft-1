// triage module, part b: duplicate scans, pair checks, comparison sets, groups and the classifier read models (SQLite; Postgres when AUTOCRAFT_TEST_PG_URL is set).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db, Dialect } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import { TEST_PG_URL, testDatabase } from "../test-db.ts";
import { expectFlat } from "../helpers/query-count.ts";
import { compareOf, dueSets, dupeGroups, kindSets, prDuplicates } from "../../src/data/triage/dupe-sets.ts";
import { loadTriageFacts } from "../../src/data/triage/facts.ts";
import type { DupeMember, DupeState } from "../../src/data/triage/types.ts";
import {
  listDisagreements, loadClassifiedCount, loadClassifierReport, loadDupeSignals, loadDupeState, loadDuplicatesOf, loadScanContext, loadUncheckedPairCounts, loadUncheckedPairs,
  loadVerdictStamp, markComparisonsStale, saveComparisons, saveDrops, saveDupeGroups, savePairVerdicts, saveScans,
} from "../../src/data/triage/index.ts";

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

/** Items 1..2n of the pipeline repo `app`, open issues hashed `h<number>`; pair i is (2i-1, 2i). */
const items = (n: number) => Array.from({ length: 2 * n }, (_, i) => ({ repo: "app", number: i + 1 }));
const pair = (i: number, extra: Record<string, unknown> = {}) => ({ repo: "app", a: 2 * i - 1, b: 2 * i, a_hash: `h${2 * i - 1}`, b_hash: `h${2 * i}`, similarity: 0.9, ...extra });
const pairs = (n: number) => Array.from({ length: n }, (_, i) => pair(i + 1));

async function seed(db: Db, n: number, withPairs = true): Promise<void> {
  const q = queryDb(db), k = q.k as any;
  await q.run(k.insertInto("tracked_repos").values({ name: "app", added_by: "t", added_at: T0, pipeline: 1 }));
  if (n) await q.run(k.insertInto("items").values(items(n).map((r) => ({ ...r, kind: "issue", state: "OPEN", title: `issue ${r.number}`, body: "b", embed_hash: `h${r.number}`, comments_count: 0 }))));
  if (withPairs && n) await q.run(k.insertInto("duplicate_pairs").values(pairs(n).map((p) => ({ ...p, created_at: T0 }))));
}

both("a scan chunk stores new pairs once, keeps operator rulings visible and writes the scan hashes", async (db) => {
  await seed(db, 3, false);
  await queryDb(db).run((queryDb(db).k as any).insertInto("duplicate_pairs").values({ ...pair(3), by_operator: 1, verdict: "distinct", created_at: T0 }));
  const ctx0 = await loadScanContext(db, items(3));
  assert.equal(ctx0.operatorPairs.length, 1);
  assert.equal(ctx0.operatorPairs[0]!.a, 5);
  assert.equal(ctx0.stored.size, 1);
  assert.equal(ctx0.scans.size, 0);

  const fresh = [pair(1), pair(2)];
  assert.equal(await saveScans(db, [...fresh, pair(1)], items(2).map((r) => ({ ...r, hash: `h${r.number}`, at: T0 }))), 2, "a pair named twice counts once");
  assert.equal(await saveScans(db, fresh, [{ repo: "app", number: 1, hash: "h1b", at: T0 }]), 0, "stored pairs are not added again");
  const ctx = await loadScanContext(db, items(3));
  assert.equal(ctx.stored.size, 3);
  assert.equal(ctx.scans.get("app#1"), "h1b", "a rescan replaces the stored hash");
  assert.equal(ctx.scans.get("app#2"), "h2");
  assert.equal((await loadScanContext(db, [{ repo: "app", number: 1 }])).stored.size, 0, "a pair counts only when both items are asked for");
  assert.equal((await loadScanContext(db, [])).stored.size, 0);
});

both("unchecked pairs need matching hashes, scope and an open item; verdicts remove them and set the canonical", async (db) => {
  await seed(db, 3);
  const q = queryDb(db), k = q.k as any;
  assert.deepEqual((await loadUncheckedPairs(db)).map((p) => p.a), [1, 3, 5]);
  assert.deepEqual((await loadUncheckedPairs(db, { limit: 2 })).length, 2);
  assert.deepEqual((await loadUncheckedPairs(db, { refs: [{ repo: "app", number: 4 }] })).map((p) => p.a), [3]);
  assert.deepEqual([...(await loadUncheckedPairCounts(db, [{ repo: "app", number: 3 }, { repo: "app", number: 6 }]))], [["app#3", 1], ["app#6", 1]]);
  assert.equal((await loadUncheckedPairCounts(db, [])).size, 0);

  await q.run(k.updateTable("items").set({ embed_hash: "edited" }).where("number", "=", 2));
  assert.deepEqual((await loadUncheckedPairs(db)).map((p) => p.a), [3, 5], "a pair checked at other text is not current");
  await q.run(k.updateTable("items").set({ state: "CLOSED" }).where("number", "in", [3, 4]));
  assert.deepEqual((await loadUncheckedPairs(db)).map((p) => p.a), [5], "a pair of two closed items is left alone");
  await q.run(k.updateTable("tracked_repos").set({ pipeline: 0 }).where("name", "=", "app"));
  assert.deepEqual(await loadUncheckedPairs(db), [], "a repo outside the pipeline is out of scope");
  await q.run(k.updateTable("tracked_repos").set({ pipeline: 1 }).where("name", "=", "app"));

  const verdict = (p: ReturnType<typeof pair>, verdict: string, canonical: number | null) => ({ ...p, jev_p: 0.95, haiku: null, verdict, canonical, checked_at: T0 });
  assert.equal(await savePairVerdicts(db, [verdict(pair(3), "duplicate", 5), verdict(pair(1), "distinct", null)]), 2);
  assert.equal(await savePairVerdicts(db, [verdict({ ...pair(3), a_hash: "other" }, "distinct", null)]), 0, "a verdict for other hashes touches nothing");
  const stored = (await q.get(k.selectFrom("duplicate_pairs").select(["verdict", "canonical", "jev_p"]).where("a", "=", 5))) as { verdict: string; canonical: number; jev_p: number };
  assert.deepEqual([stored.verdict, stored.canonical, stored.jev_p], ["duplicate", 5, 0.95]);
  assert.deepEqual(await loadUncheckedPairs(db), []);
});

both("duplicate state holds the edges, their members, comparisons and drops; groups and signals follow the comparison", async (db) => {
  await seed(db, 2);
  const q = queryDb(db), k = q.k as any;
  await q.run(k.updateTable("duplicate_pairs").set({ verdict: "duplicate", canonical: 1, checked_at: T0 }).where("a", "=", 1));
  const cmp = { repo: "app", key: "issue:1,2", kind: "issue" as const, members: [1, 2], hash: "set1", kept: 1, source: "model", model: "m", reason: "same bug", result: { rounds: 1 }, error: null, attempts: 1, at: T0, summary: null, why: null, sizes: null, heads: null };
  await saveComparisons(db, [cmp, { ...cmp, hash: "set2" }]);
  await saveDrops(db, [{ repo: "app", key: "issue:1,2", hash: "set2", at: T0 }]);
  const s = await loadDupeState(db);
  assert.deepEqual(s.edges.map((e) => [e.a, e.b]), [[1, 2]]);
  assert.deepEqual([...s.members.keys()], ["app#1", "app#2"]);
  assert.equal(s.members.get("app#1")!.in_scope, true);
  assert.equal(s.comparisons.get("app\nissue:1,2")!.hash, "set2", "the later row of a key wins");
  assert.equal(s.drops.get("app\nissue:1,2")!.hash, "set2");
  assert.equal((await loadDupeState(db, { repo: "other" })).edges.length, 0);
  assert.equal(await markComparisonsStale(db, "app", 99, "ann"), 0);

  await saveDupeGroups(db, "app", [{ id: "app:dupegroup:1", repo: "app", source: "model", items: [{ number: 1, kind: "issue", role: "keep", target: null, detail: null }, { number: 2, kind: "issue", role: "close", target: 1, detail: "{}" }] }]);
  const sig = await loadDupeSignals(db, [{ repo: "app", number: 2 }, { repo: "app", number: 3 }]);
  assert.deepEqual(sig.get("app#2"), { groupId: "app:dupegroup:1", role: "close", target: 1, reason: "same bug" });
  assert.equal(sig.has("app#3"), false);
  const text = (hash: string) => queryDb(db).run((queryDb(db).k as any).updateTable("items").set({ embed_hash: hash }).where("repo", "=", "app").where("number", "=", 1));
  await text("edited");
  assert.equal((await loadDupeSignals(db, items(2))).size, 0, "the stored group is no signal while its edge does not hold");
  await text("h1");
  assert.deepEqual([...(await loadDupeSignals(db, items(2))).keys()].sort(), ["app#1", "app#2"]);
  await saveDupeGroups(db, "app", []);
  assert.equal((await loadDupeSignals(db, items(2))).size, 0, "saving replaces the repo's groups");

  const of = await loadDuplicatesOf(db, [{ repo: "app", number: 1 }, { repo: "app", number: 2 }]);
  assert.deepEqual(of.get("app#1"), [{ other: 2, canonical: false }]);
  assert.deepEqual(of.get("app#2"), [{ other: 1, canonical: true }]);
});

test("duplicate loaders and writers issue the same number of statements at 2 and 12 pairs", async () => {
  const unit = (run: (db: Db, n: number) => Promise<unknown>, prepare?: (db: Db, n: number) => Promise<void>, withPairs = true) => async (size: number) => {
    const t = await testDatabase("", "sqlite");
    const db = await t.open({ app: true });
    await seed(db, size, withPairs);
    await prepare?.(db, size);
    return { db, run: () => run(db, size), close: () => t.close() };
  };
  const duplicates = async (db: Db, n: number) => {
    await queryDb(db).run((queryDb(db).k as any).updateTable("duplicate_pairs").set({ verdict: "duplicate", canonical: 1 }));
    await saveDupeGroups(db, "app", pairs(n).map((p) => ({ id: `app:dupegroup:${p.a}`, repo: "app", source: "model", items: [{ number: p.a, kind: "issue", role: "keep", target: null, detail: null }, { number: p.b, kind: "issue", role: "close", target: p.a, detail: null }] })));
  };
  // The scan inputs: one context read and one chunk write whatever the number of items.
  await expectFlat(unit(async (db, n) => {
    await loadScanContext(db, items(n));
    await saveScans(db, pairs(n), items(n).map((r) => ({ ...r, hash: `h${r.number}`, at: T0 })));
  }, undefined, false), 2, 12);
  await expectFlat(unit((db, n) => loadUncheckedPairs(db, { refs: items(n) })), 2, 12);
  await expectFlat(unit((db, n) => loadUncheckedPairCounts(db, items(n))), 2, 12);
  await expectFlat(unit((db, n) => savePairVerdicts(db, pairs(n).map((p) => ({ ...p, jev_p: 1, haiku: null, verdict: "distinct", canonical: null, checked_at: T0 })))), 2, 12);
  await expectFlat(unit((db) => loadDupeState(db), duplicates), 2, 12);
  await expectFlat(unit((db, n) => loadDupeSignals(db, items(n)), duplicates), 2, 12);
  await expectFlat(unit((db, n) => loadDuplicatesOf(db, items(n)), duplicates), 2, 12);
  await expectFlat(unit((db, n) => saveComparisons(db, pairs(n).map((p) => ({ repo: "app", key: `issue:${p.a},${p.b}`, kind: "issue" as const, members: [p.a, p.b], hash: "h", kept: p.a, source: "model", model: null, reason: null, result: null, error: null, attempts: 1, at: T0, summary: null, why: null, sizes: null, heads: null })))), 2, 12);
  await expectFlat(unit(async (db, n) => {
    const r = await loadTriageFacts(db, items(n), { model: "m", run: null, nowMs: Date.parse(T0) });
    assert.equal(r.facts.get("app#1")!.compare, "model", "a duplicate pair with no comparison is due for the model");
  }, duplicates), 2, 12);
  await expectFlat(unit((db, n) => saveDrops(db, pairs(n).map((p) => ({ repo: "app", key: `issue:${p.a},${p.b}`, hash: "h", at: T0 })))), 2, 12);
});

/** Verdict rows of two classifiers over `n` items of one run; Jev rates every item `bug`, Haiku every even one `feature`. */
async function seedVerdicts(db: Db, n: number): Promise<void> {
  const q = queryDb(db), k = q.k as any;
  const rows = Array.from({ length: n }, (_, i) => i + 1).flatMap((number) => [
    { repo: "app", number, classifier: "jev", run_id: "r1", at: `2026-01-0${(number % 9) + 1}T00:00:00.000Z`, type_label: "bug", flags: "[]", probs: JSON.stringify({ top: 0.95 }), input_hash: "x" },
    { repo: "app", number, classifier: "haiku", run_id: "r1", at: T0, type_label: number % 2 ? "bug" : "feature", flags: "[]", probs: null, input_hash: "x" },
  ]);
  await q.run(k.insertInto("classifications").values(rows));
  if (n) await q.run(k.insertInto("items").values(Array.from({ length: n }, (_, i) => ({ repo: "app", number: i + 1, kind: i % 2 ? "pr" : "issue", state: "OPEN", title: "t" }))));
}

both("the classifier report picks the newest run and its largest pair, and lists the items both rated", async (db) => {
  await seedVerdicts(db, 4);
  const r = await loadClassifierReport(db, { hidden: [] });
  assert.equal(r.run, "r1");
  assert.deepEqual([r.a, r.b], ["jev", "haiku"], "the classifier with probabilities goes first");
  assert.equal(r.rows.length, 4);
  assert.deepEqual(r.rows.map((x) => x.kind).sort(), ["issue", "issue", "pr", "pr"]);
  assert.equal((await loadClassifierReport(db, { hidden: Object.assign(["app"], {}) })).rows.length, 0, "a hidden repo is left out");
  assert.equal((await loadClassifierReport(db, { run: "none", a: "haiku", b: "jev", hidden: [] })).a, "jev");

  const d = await listDisagreements(db, { run: "r1", a: "jev", b: "haiku", hidden: [], limit: 1, offset: 0 });
  assert.equal(d.total, 2);
  assert.equal(d.rows.length, 1);
  assert.deepEqual(d.rows[0]!.a, { label: "bug", prob: 0.95 });
  assert.equal((await listDisagreements(db, { run: "r1", a: "jev", b: "haiku", hidden: [], limit: 5, offset: 0, band: { lo: 0.99, hi: 2 } })).total, 0);
  assert.equal(await loadClassifiedCount(db, { run: "r1" }), 4);
  assert.equal(await loadClassifiedCount(db, { run: "r2" }), 0);
  assert.equal(await loadClassifiedCount(db, { since: "2026-01-03T00:00:00.000Z" }), 3);
  const stamp = await loadVerdictStamp(db, { repo: "app", number: 1 });
  assert.equal(stamp.n, 2);
  assert.ok(stamp.newest);
});

test("the classifier read models issue the same number of statements at 2 and 12 items", async () => {
  const unit = (run: (db: Db) => Promise<unknown>) => async (size: number) => {
    const t = await testDatabase("", "sqlite");
    const db = await t.open({ app: true });
    await seedVerdicts(db, size);
    return { db, run: () => run(db), close: () => t.close() };
  };
  await expectFlat(unit((db) => loadClassifierReport(db, { hidden: [] })), 2, 12);
  await expectFlat(unit((db) => listDisagreements(db, { run: "r1", a: "jev", b: "haiku", hidden: [], limit: 50, offset: 0 })), 2, 12);
  await expectFlat(unit((db) => loadClassifiedCount(db, { run: "r1" })), 2, 12);
});

test("due comparison sets: an uncompared set is due for the model, a fresh rule result waits for its retry, a dropped snapshot pauses", () => {
  const member = (number: number, o: Partial<DupeMember> = {}): DupeMember => ({
    repo: "o/a", number, kind: "issue", state: "OPEN", title: null, head_oid: null, embed_hash: `e${number}`, comments_count: 0, additions: null, deletions: null,
    closing_issues: null, state_reason: null, in_scope: true, started: false, ruled: null, ...o,
  });
  const now = Date.parse("2026-03-01T12:00:00.000Z");
  const edge = (a: number, b: number) => ({ repo: "o/a", a, b, similarity: 0.9, jev_p: null, haiku: null });
  const base = (members: DupeMember[]): DupeState => ({ edges: [edge(1, 2), edge(3, 4)], members: new Map(members.map((m) => [`o/a#${m.number}`, m])), comparisons: new Map(), drops: new Map() });
  const state = base([member(1), member(2), member(3), member(4, { state: "CLOSED" })]);
  const fresh = dueSets(state, now);
  assert.deepEqual(fresh.sets.map((s) => s.key), ["issue:1,2", "issue:3,4"]);
  assert.deepEqual([...compareOf(fresh.sets)], [["o/a#1", "model"], ["o/a#2", "model"], ["o/a#3", "rule"], ["o/a#4", "rule"]]);

  const [set12] = fresh.sets;
  const ruleAt = new Date(now - 60_000).toISOString();
  state.comparisons.set(`o/a\n${set12!.key}`, { repo: "o/a", key: set12!.key, kind: "issue", members: "[1,2]", hash: set12!.hash, kept: 1, source: "rule", model: null, reason: null,
    result: null, error: null, attempts: 1, at: ruleAt, heads: null, summary: null, why: null, sizes: null });
  state.drops.set(`o/a\n${fresh.sets[1]!.key}`, { hash: fresh.sets[1]!.hash, at: new Date(now - 60_000).toISOString() });
  const waiting = dueSets(state, now);
  assert.deepEqual(waiting.sets, []);
  assert.equal(waiting.dueAt.get("o/a#1"), Date.parse(ruleAt) + 15 * 60_000);
  assert.equal(waiting.dueAt.get("o/a#3"), now - 60_000 + 10 * 60_000);
  assert.deepEqual(dueSets(state, now + 20 * 60_000).sets.map((s) => s.key), ["issue:1,2", "issue:3,4"], "both waits over");

  const out = base([member(1, { in_scope: false }), member(2, { in_scope: false }), member(3), member(4, { state_reason: "DUPLICATE" })]);
  assert.deepEqual(dueSets(out, now).sets.map((s) => s.key), ["issue:3"], "out of scope sets and items closed as duplicates are left out");
});

test("a comparison in rounds: a PR it found different leads the PRs that lost to it, and a person's ruling frees one", () => {
  const member = (number: number, o: Partial<DupeMember> = {}): DupeMember => ({
    repo: "o/a", number, kind: "pr", state: "OPEN", title: null, head_oid: null, embed_hash: `e${number}`, comments_count: 0, additions: 1, deletions: 0,
    closing_issues: null, state_reason: null, in_scope: true, started: false, ruled: null, ...o,
  });
  const edge = (a: number, b: number) => ({ repo: "o/a", a, b, similarity: 0.9, jev_p: null, haiku: null });
  const of = (over: { [n: number]: Partial<DupeMember> } = {}) => {
    const members = [1, 2, 3, 4].map((n) => member(n, over[n]));
    const state: DupeState = { edges: [edge(1, 2), edge(2, 3), edge(3, 4)], members: new Map(members.map((m) => [`o/a#${m.number}`, m])), comparisons: new Map(), drops: new Map() };
    const set = kindSets(state, dupeGroups(state)[0]!)[0]!;
    const result = { rounds: 2, others: [{ number: 2, duplicate: true }, { number: 3, duplicate: false }, { number: 4, duplicate: true, via: 3 }] };
    state.comparisons.set(`o/a\n${set.key}`, { repo: "o/a", key: set.key, kind: "pr", members: "[1,2,3,4]", hash: set.hash, kept: 1, source: "model", model: "m", reason: null,
      result: JSON.stringify(result), error: null, attempts: 0, at: T0, heads: null, summary: null, why: null, sizes: null });
    return Object.fromEntries([...prDuplicates(state)].map(([ref, d]) => [ref, d.of]));
  };
  assert.deepEqual(of(), { "o/a#2": [1], "o/a#4": [3] });
  assert.deepEqual(of({ 1: { ruled: "2" } }), { "o/a#4": [3] });
  assert.deepEqual(of({ 4: { started: true } }), { "o/a#2": [1], "o/a#3": [4], "o/a#4": [3] }, "a person chose one that lost");
});
