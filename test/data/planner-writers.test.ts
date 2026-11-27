// Planner writers whose logic changed shape: the plan diff with its revision check, multi-row pass records, the conditional stage
// insert, the change-log prune and the bulk marker.
import assert from "node:assert/strict";
import { queryDb } from "../../src/db/query-db.ts";
import {
  addStageEvents, addStageEventsOnce, beginBulk, endBulk, loadChangeCursor, loadDueRefs, loadLiveness, loadPassReport, loadPlanHistory, loadPlans, loadStageFacts,
  loadStoredPlans, listPlans, loadStuck, logChanged, pruneChanges, readChanges, recordPass, saveLiveness, savePlans, SHADOW_ROWS,
} from "../../src/data/planner/index.ts";
import { AT, both, planRow, seedPrs } from "./planner-helpers.ts";

const count = async (db: Parameters<typeof queryDb>[0], table: "item_plans" | "plan_history" | "plan_shadow_diffs" | "item_changes" | "stages") => {
  const q = queryDb(db);
  return Number((await q.get(q.k.selectFrom(`main.${table}`).select((eb) => eb.fn.countAll<number>().as("n"))))!.n);
};

both("savePlans writes only what changed, keeps since while phase and wait stand, and records exits", async ({ db }) => {
  const q = queryDb(db);
  const rows = [planRow("o/a", 1), planRow("o/a", 2), planRow("o/b", 1)];
  assert.deepEqual(await savePlans(db, rows, AT), { written: 3, deleted: 0 });
  const rev = (await q.get(q.k.selectFrom("main.item_plans_rev").select("rev")))!.rev;
  assert.deepEqual(await savePlans(db, rows, "2026-01-02T00:00:00.000Z"), { written: 0, deleted: 0 });
  assert.equal((await q.get(q.k.selectFrom("main.item_plans_rev").select("rev")))!.rev, rev, "a quiet pass writes nothing");
  // Same phase and wait with a later `since`: not a change. A new state: a change with one history row.
  const later = "2026-01-03T00:00:00.000Z";
  const out = await savePlans(db, [planRow("o/a", 1, { since: later }), planRow("o/a", 2, { state: "waiting-ci", since: later })], later);
  assert.deepEqual(out, { written: 1, deleted: 1 });
  const plans = await loadPlans(db, [{ repo: "o/a", number: 1 }, { repo: "o/a", number: 2 }, { repo: "o/b", number: 1 }]);
  assert.equal(plans.get("o/a#1")!.view.status.since, AT);
  assert.equal(plans.get("o/a#2")!.state, "waiting-ci");
  assert.ok(!plans.has("o/b#1"));
  const history = await loadPlanHistory(db, ["o/b#1", "o/a#2"]);
  assert.equal(history.get("o/b#1")![0]!.newState, "gone");
  assert.deepEqual(history.get("o/a#2")!.map((h) => h.newState), ["waiting-ci", "ready"]);
});

both("savePlans against a stale read diffs again under the lock, so a concurrent writer's rows do not survive", async ({ t, db }) => {
  const other = await t.open({ app: true });
  await savePlans(db, [planRow("o/a", 1)], AT);
  const stale = await loadStoredPlans(db);
  await savePlans(other, [planRow("o/a", 1), planRow("o/x", 9)], AT);
  await savePlans(db, [planRow("o/a", 1, { state: "conflict" })], AT, stale);
  const q = queryDb(db);
  const left = (await q.all(q.k.selectFrom("main.item_plans").select(["repo", "number", "state"]).orderBy("repo"))).map((r) => `${r.repo}#${r.number}:${r.state}`);
  assert.deepEqual(left, ["o/a#1:conflict"]);
});

both("recordPass sums counts of one kind and hour, adds to earlier hours, and keeps the newest shadow diffs", async ({ db }) => {
  const c = (kind: string, hour: string, passes: number, maxMs: number) => ({ kind, passes, refs: 2, at: `${hour}:30:00.000Z`, ms: 10, maxMs, dbStatements: 5, dbRoundTrips: 1, dbMs: 3.25, hour });
  await recordPass(db, [c("incremental", "2026-01-01T10", 1, 40), c("incremental", "2026-01-01T10", 2, 90), c("full:start", "2026-01-01T10", 1, 5)], []);
  await recordPass(db, [c("incremental", "2026-01-01T11", 1, 7), c("incremental", "2026-01-01T10", 1, 20)], []);
  const diffs = Array.from({ length: SHADOW_ROWS + 5 }, (_, i) => ({ at: new Date(Date.parse(AT) + i * 1000).toISOString(), ref: `o/a#${i}`, side: "pr" as const, fields: "state", detail: "x" }));
  await recordPass(db, [], diffs);
  const report = await loadPassReport(db);
  const inc = report.passes.find((p) => p.kind === "incremental")!;
  assert.equal(inc.passes, 5);
  assert.equal(inc.maxMs, 90);
  assert.equal(report.hours.filter((h) => h.kind === "incremental").length, 2);
  assert.equal(report.hours.find((h) => h.kind === "incremental" && h.hour.endsWith("T10"))!.passes, 4);
  assert.equal(report.shadowDiffs, SHADOW_ROWS);
});

both("addStageEventsOnce inserts a row once per note prefix, treating % and _ in the prefix as text", async ({ db }) => {
  const row = (note: string, prefix: string) => ({ repo: "o/a", number: 1, stage: "batched", at: AT, actor: "merge", note, notePrefix: prefix });
  assert.equal(await addStageEventsOnce(db, [row("queued at 1a2b: ready", "queued at 1a2b"), row("queued at 1a2b: again", "queued at 1a2b")]), 1);
  assert.equal(await addStageEventsOnce(db, [row("queued at 1a2b: ready", "queued at 1a2b")]), 0);
  assert.equal(await addStageEventsOnce(db, [row("queued at 3c4d: ready", "queued at 3c4d")]), 1);
  assert.equal(await addStageEventsOnce(db, [row("queued at xzy: ok", "queued at xzy")]), 1);
  assert.equal(await addStageEventsOnce(db, [row("queued at x_y: ok", "queued at x_y")]), 1, "`_` in the prefix does not match the z of the earlier note");
  assert.equal(await count(db, "stages"), 4);
});

both("loadStageFacts returns the latest stage and the latest labeled note by time then insertion", async ({ db }) => {
  const ev = (stage: string, at: string, note: string | null) => ({ repo: "o/a", number: 1, stage, at, actor: "t", note });
  await addStageEvents(db, [ev("labeled", "2026-01-02T00:00:00.000Z", "added: bug"), ev("labeled", "2026-01-02T00:00:00.000Z", "added: ui"), ev("labeled", "2026-01-01T00:00:00.000Z", "added: old"), ev("reviewed", "2026-01-03T00:00:00.000Z", null)]);
  const facts = (await loadStageFacts(db, [{ repo: "o/a", number: 1 }])).get("o/a#1")!;
  assert.equal(facts.stage, "reviewed");
  assert.equal(facts.reviewed, true);
  assert.equal(facts.labeledNote, "added: ui");
});

both("pruneChanges deletes the seqs its cursor read and leaves later rows; the cursor is not mutated", async ({ db }) => {
  await seedPrs(db, ["o/a"], 3);
  const cursor = await loadChangeCursor(db);
  assert.ok(cursor.seen.size >= 3);
  await logChanged(db, [{ repo: "o/a", number: 1 }]);
  const before = cursor.seen.size;
  assert.equal(await pruneChanges(db, cursor), before);
  assert.equal(cursor.seen.size, before);
  assert.equal(await count(db, "item_changes"), 1);
  const next = await readChanges(db, { gen: cursor.gen, seen: new Set() });
  assert.deepEqual(next.refs, ["o/a#1"]);
});

both("a bulk write logs no per-row changes and moves the full-pass generation once", async ({ db }) => {
  const q = queryDb(db);
  await assert.rejects(beginBulk(db), /inside db.write/);
  await seedPrs(db, ["o/a"], 1);
  const cursor = await loadChangeCursor(db);
  await db.write(async () => {
    await beginBulk(db);
    await q.run(q.k.insertInto("main.items").values(Array.from({ length: 5 }, (_, i) => ({ repo: "o/a", number: 10 + i, kind: "pr", state: "OPEN" }))));
    await endBulk(db, "test");
  });
  assert.equal(await count(db, "item_changes"), cursor.seen.size, "no rows logged inside the bulk write");
  const changes = await readChanges(db, cursor);
  assert.equal(changes.full, true);
  assert.equal(changes.cause, "marker");
});

both("saveLiveness replaces the stored items, and loadStuck reports only stuck refs among the keys", async ({ db }) => {
  const item = (number: number, verdict: "stuck" | "long") => ({ repo: "o/a", number, kind: "pr" as const, verdict, cause: "no-plan", state: "ready", wait: null, phase: "Review", since: AT });
  assert.equal(await loadLiveness(db), null);
  await saveLiveness(db, { checkedAt: AT, stuck: 1, long: 1, open: 9, causes: { "no-plan": 1 }, items: [item(1, "stuck"), item(2, "long")] });
  await saveLiveness(db, { checkedAt: "2026-01-02T00:00:00.000Z", stuck: 1, long: 0, open: 7, causes: { "no-plan": 1 }, items: [item(3, "stuck")] });
  const l = (await loadLiveness(db))!;
  assert.deepEqual([l.open, l.stuck, l.items.length, l.causes["no-plan"]], [7, 1, 1, 1]);
  assert.deepEqual([...await loadStuck(db, ["o/a#1", "o/a#3", "o/a#4"])], ["o/a#3"]);
});

both("loadDueRefs is null without stored plans, then names planned, logged and unplanned items", async ({ db }) => {
  await seedPrs(db, ["o/a"], 3);
  assert.equal(await loadDueRefs(db, "review", "pr"), null);
  const q = queryDb(db);
  await q.run(q.k.deleteFrom("main.item_changes"));
  await savePlans(db, [{ ...planRow("o/a", 1), actions: JSON.stringify([{ kind: "review" }]) }, planRow("o/a", 2)], AT);
  await q.run(q.k.deleteFrom("main.item_changes"));
  await logChanged(db, [{ repo: "o/a", number: 2 }]);
  assert.deepEqual((await loadDueRefs(db, "review", "pr"))!.sort(), ["o/a#1", "o/a#2", "o/a#3"]);
  assert.deepEqual((await loadDueRefs(db, "review", "pr", "o/other"))!, []);
});

both("listPlans filters on the view's JSON fields and action params, open items, hidden repos and a keyset page", async ({ db }) => {
  await seedPrs(db, ["o/a", "o/b"], 2);
  const view = (v: object) => JSON.stringify({ status: { phase: "Review", waiting: null, next: null, since: AT }, ...v });
  const act = (kind: string, params: object) => JSON.stringify([{ kind, params }]);
  await savePlans(db, [
    { ...planRow("o/a", 1), view: view({ gh: "OPEN", scope: true, fixup: "hold" }), actions: act("fixup", { bucket: "hold" }) },
    { ...planRow("o/a", 2), view: view({ gh: "MERGED" }), wait: "ci", actions: act("fixup", { source: "premerge" }) },
    { ...planRow("o/b", 1), view: view({ gh: "OPEN", scope: true }) },
    { ...planRow("o/b", 2), head: "other", view: view({ gh: "OPEN" }) },
    { ...planRow("o/c", 1), view: view({ gh: "OPEN" }) },
  ], AT);
  const refs = async (f: Parameters<typeof listPlans>[1]) => (await listPlans(db, f)).map((p) => `${p.repo}#${p.number}`);
  assert.deepEqual(await refs({ scope: true }), ["o/a#1", "o/b#1"]);
  assert.deepEqual(await refs({ scope: false, repos: ["o/a", "o/b"] }), ["o/a#2", "o/b#2"]);
  assert.deepEqual(await refs({ gh: ["MERGED"] }), ["o/a#2"]);
  assert.deepEqual(await refs({ fixup: "hold" }), ["o/a#1"]);
  assert.deepEqual(await refs({ hasWait: true }), ["o/a#2"]);
  assert.deepEqual(await refs({ action: { kind: "fixup", bucket: "hold" } }), ["o/a#1"]);
  assert.deepEqual(await refs({ action: { kind: "fixup", bucket: "premerge" } }), ["o/a#2"]);
  assert.deepEqual(await refs({ open: true, hidden: Object.assign(["o/b"], {}) }), ["o/a#1", "o/a#2"], "o/c has no mirror row and o/b is hidden");
  assert.deepEqual(await refs({ after: { repo: "o/a", number: 2 }, limit: 2 }), ["o/b#1", "o/b#2"]);
});
