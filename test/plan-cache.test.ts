// The planner's Plan cache (item_plans) and what a pass writes.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { decideItem } from "../src/core/decide-item.ts";
import { decidePr } from "../src/core/decide.ts";
import { planRows, prunePlanHistory, refreshPlanCache, writePlanCache, type PlanView } from "../src/core/plan-cache.ts";
import type { PlanSet } from "../src/core/plan-set.ts";
import { loadPlanHistory } from "../src/data/planner/index.ts";
import { connectDb, type Db } from "./helpers/raw-db.ts";
import { detectAutopilot, planDue, setEnabled } from "../src/runner/autopilot.ts";
import { SCRATCH } from "./scratch.ts";
import { mapSeq } from "../src/async-seq.ts";
import { excluded } from "../src/db/kx.ts";
import { sqliteOnly } from "./test-db.ts";
import { itemFacts, prFacts } from "./world.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "plan-cache-"));
const T0 = "2026-01-01T00:00:00Z";

/** An item's plan history, oldest first. */
const planHistory = async (db: Db, repo: string, number: number) => (await loadPlanHistory(db, [`${repo}#${number}`])).get(`${repo}#${number}`)?.reverse() ?? [];

describe("Plan cache", async () => {
  const db = await connectDb(join(dir, "t.db"));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", pipeline: 1 }));
  await db.run(db.k.insertInto("items").values([1, 2].map((number) => ({ repo: "app", number, kind: "issue", state: "OPEN", title: "t", body: "b", is_draft: 0, created_at: T0, updated_at: T0 }))));
  await db.run(db.k.updateTable("items").set({ embed_hash: null }));
  await setEnabled(db, true, "op");
  const cache = async () => await db.all(db.k.selectFrom("item_plans").select(["number", "kind", "state", "actions"]).orderBy("number"));
  const seq = async () => (await db.get(db.k.selectFrom("change_seq").select("seq").where("topic", "=", "plans")))!.seq;
  const unhashed = async () => (await db.get(db.k.selectFrom("items").select((eb) => eb.fn.countAll<number>().as("n")).where("embed_hash", "is", null)))!;

  test("a pass writes one row per item, writes nothing else, and writes only changed rows the next time", async () => {
    const before = await unhashed();
    const first = await detectAutopilot(db);
    assert.equal(first.timing!.written, 2);
    assert.deepEqual((await cache()).map((r) => [r.number, r.kind]), [[1, "issue"], [2, "issue"]]);
    assert.ok(JSON.parse((await cache())[0]!.actions).some((a: { kind: string }) => a.kind === "embed"), "the embed action is cached");
    assert.deepEqual(await unhashed(), before, "planning fills no hashes");
    const s = await seq();
    const second = await detectAutopilot(db);
    assert.deepEqual([second.timing!.written, second.timing!.deleted], [0, 0]);
    assert.equal(await seq(), s);
  });

  test("an unchanged pass changes no row in any table", { skip: sqliteOnly("counts row changes with SQLite's total_changes()") }, async () => {
    const changes = async () => (await db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const n = await changes();
    await detectAutopilot(db);
    assert.equal(await changes(), n, "an unchanged pass writes nothing");
  });

  test("a changed item rewrites its row only, and an item that closed leaves the cache", async () => {
    await db.run(db.k.updateTable("items").set({ state: "CLOSED" }).where("number", "=", 2));
    const r = await detectAutopilot(db);
    assert.deepEqual([r.timing!.written, r.timing!.deleted], [0, 1]);
    assert.deepEqual((await cache()).map((x) => x.number), [1]);
  });

  test("with the pipeline off the planner is still due and caches the Plans (the runner queues no proposal then)", async () => {
    await setEnabled(db, false, "op");
    await db.run(db.k.updateTable("items").set({ state: "OPEN" }).where("number", "=", 2));
    assert.equal(await planDue(db), true);
    const r = await detectAutopilot(db);
    assert.ok(r.proposals.every((p) => p.lane), "proposals are only data; applyProposals is not called while off");
    assert.equal(r.timing!.written, 1);
    assert.deepEqual((await cache()).map((x) => x.number), [1, 2]);
  });

  test("with the pipeline off a wake time that has passed makes one pass due, not every tick", async () => {
    await setEnabled(db, false, "op");
    await planDue(db);
    await db.run(db.k.insertInto("lane_state").values({ kind: "mark", step: "wake_at", repo: "", value: new Date(Date.now() - 60_000).toISOString(), at: new Date().toISOString() }).onConflict((oc) => oc.columns(["kind", "step", "repo"]).doUpdateSet(excluded(["value", "at"]))));
    assert.equal(await planDue(db), true);
    assert.equal(await planDue(db), false);
  });

  test("the history gets a row for each change of an item's state, none for a pass that changes nothing else", async () => {
    const before = (await planHistory(db, "app", 1)).length;
    await refreshPlanCache(db);
    assert.equal((await planHistory(db, "app", 1)).length, before, "an unchanged pass adds no row");
    await db.run(db.k.updateTable("item_plans").set({ state: "earlier" }).where("number", "=", 1));
    await refreshPlanCache(db);
    await db.run(db.k.updateTable("item_plans").set({ state: "before-that", wait: "x" }).where("number", "=", 1));
    await refreshPlanCache(db);
    const h = await planHistory(db, "app", 1);
    assert.deepEqual(h.slice(before).map((r) => [r.oldState, r.wait === null]), [["earlier", true], ["before-that", true]]);
    await db.run(db.k.updateTable("item_plans").set({ wait: "y" }).where("number", "=", 1));
    await refreshPlanCache(db);
    const w = (await planHistory(db, "app", 1)).at(-1)!;
    assert.deepEqual([w.oldWait, w.wait === null], ["y", true], "a wait-only change is recorded with the old wait");
    await db.run(db.k.updateTable("items").set({ state: "CLOSED" }).where("number", "=", 2));
    await refreshPlanCache(db);
    const gone = (await planHistory(db, "app", 2)).at(-1)!;
    await db.run(db.k.updateTable("items").set({ state: "OPEN" }).where("number", "=", 2));
    await refreshPlanCache(db);
    assert.deepEqual([gone.newState, gone.oldState === null], ["gone", false], "an item leaving the plan set gets a row");
    assert.equal(h[h.length - 1]!.newState, (await cache())[0]!.state);
    assert.equal(h[0]!.oldState, null, "the first plan has no old state");
    assert.ok(await prunePlanHistory(db, 0, Date.now() + 1000) >= h.length);
    assert.equal((await planHistory(db, "app", 1)).length, 0);
  });
});

describe("the cached next step of a PR outside the pipeline's scope", () => {
  test("names the step its stored rows wait on, not Review", async () => {
    const db = await connectDb(join(dir, "scope.db"));
    await db.run(db.k.insertInto("tracked_repos").values({ name: "off", pipeline: 0 }));
    for (const [n, verdict] of [[1, "hold"], [2, "take-fix"], [3, "take"]] as const) {
      await db.run(db.k.insertInto("items").values({ repo: "off", number: n, kind: "pr", state: "OPEN", title: "t", body: "b", is_draft: 0, head_oid: `h${n}`, created_at: T0, updated_at: T0 }));
      await db.run(db.k.insertInto("classifications").values({ repo: "off", number: n, classifier: "jev", run_id: "r1", at: T0, type_label: "bugfix", flags: "[]", probs: '{"top":0.95}' }));
      await db.run(db.k.insertInto("opus_reviews").values({ repo: "off", number: n, head_oid: `h${n}`, run_id: "rv", at: T0, model: "sonnet", verdict, reason: "why", sure: 1, mode: "full" }));
    }
    await db.run(db.k.insertInto("items").values({ repo: "off", number: 4, kind: "pr", state: "OPEN", title: "t", body: "b", is_draft: 0, head_oid: "h4", created_at: T0, updated_at: T0 }));
    await db.run(db.k.insertInto("classifications").values({ repo: "off", number: 4, classifier: "jev", run_id: "r1", at: T0, type_label: "bugfix", flags: "[]", probs: '{"top":0.95}' }));
    await db.run(db.k.insertInto("verifications").values({ repo: "off", number: 3, head_sha: "h3", kind: "tests", reason: "r", state: "passed", created_at: T0 }));
    await refreshPlanCache(db);
    const next = async (n: number) => JSON.parse((await db.get(db.k.selectFrom("item_plans").select("view").where("repo", "=", "off").where("number", "=", n)))!.view).next;
    assert.deepEqual(await mapSeq([1, 2, 3, 4], next), ["Needs a person", "Fix-up", "Merge queue", "Review"]);
    assert.equal((await db.get(db.k.selectFrom("item_plans").select("state").where("number", "=", 3)))!.state, "out-of-scope");
  });
});

describe("the stored row of a plan whose work is refused", () => {
  type Over = Parameters<typeof prFacts>[0];
  const planSet = (over: Over, item?: Parameters<typeof itemFacts>[0]): PlanSet => {
    const f = prFacts({ ...over, workflow: null });
    const i = item && itemFacts({ kind: "pr", number: f.number, repo: f.repo, ...item });
    return { run: "r1", now: f.now, pass: { rereadPaceAt: 0 }, prs: [{ facts: f, plan: decidePr(f) }], items: i ? [{ facts: i, plan: decideItem(i) }] : [] };
  };
  const rowOf = (over: Over, item?: Parameters<typeof itemFacts>[0]) => {
    const r = planRows(planSet(over, item), T0)[0]!;
    const v = JSON.parse(r.view) as PlanView;
    return { actions: (JSON.parse(r.actions) as { kind: string; refused?: string }[]).map((a) => [a.kind, a.refused ?? null]), wait: [r.wait, v.waitKind ?? null, v.waitCode ?? null] };
  };

  test("it keeps each refusal's code and waits on what ends the first", () => {
    assert.deepEqual(rowOf({}), { actions: [["merge", null]], wait: [null, null, null] });
    assert.deepEqual(rowOf({ may: { repoMerge: null } }), { actions: [["merge", "repo-approval"]], wait: ["merge approval for the repo", "person", "repo-approval"] });
    assert.deepEqual(rowOf({ tripped: { merge: "main is red" } }), { actions: [["merge", "breaker"]], wait: ["the circuit breaker of merge to be resumed", "person", "breaker"] });
  });

  test("a label or a review comment that is refused leaves the wait as it is, and other work that may run ends it", () => {
    const post = { post: { postable: true, posted: null }, repoFacts: { commentApproved: false } };
    const ci = rowOf({ ...post, ci: "pending" });
    assert.deepEqual(ci.actions, [["post-review", "repo-approval"]]);
    assert.equal(ci.wait[2], "ci");
    const label = { repoFacts: { labelsApproved: false }, labels: { existing: [] } };
    assert.deepEqual(rowOf({ ci: "pending" }, label).wait[2], "ci");
    assert.deepEqual(rowOf({ tripped: { merge: "x" } }, { ...label, embeddedHash: null }).wait, [null, null, null], "the item is embedded first");
    const issue = decideItem(itemFacts({ ...label, openPr: { number: 4, closes: true } as never }));
    assert.deepEqual([issue.actions.map((a) => [a.kind, a.permission?.ok]), issue.waitCode], [[["label", false]], "open-pr"]);
  });

  test("a flip of the pipeline switch changes no row", () => {
    for (const over of [{}, { may: { repoMerge: null } }] as Over[]) assert.deepEqual(planRows(planSet({ ...over, pipelineOn: false }), T0), planRows(planSet(over), T0));
  });

  test("a row without the codes is rewritten once", async () => {
    const db = await connectDb(join(mkdtempSync(join(SCRATCH, "plan-cache-codes-")), "t.db"));
    const plans = planSet({ may: { repoMerge: null } });
    await writePlanCache(db, plans, T0);
    const r = (await db.get(db.k.selectFrom("item_plans").select(["view"])))!;
    const { waitCode: _, ...view } = JSON.parse(r.view) as PlanView;
    await db.run(db.k.updateTable("item_plans").set({ actions: '[{"kind":"merge","head":"h1"}]', view: JSON.stringify(view) }));
    assert.deepEqual(await writePlanCache(db, plans, T0), { written: 1, deleted: 0 });
    assert.deepEqual(await writePlanCache(db, plans, T0), { written: 0, deleted: 0 });
  });
});
