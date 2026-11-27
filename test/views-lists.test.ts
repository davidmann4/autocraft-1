// The list views behind Home, Items, Repos, Stats and the top-bar search (src/data/views): filters, hidden repos and counts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { connectDb } from "./helpers/raw-db.ts";
import { loadMaintainRepos } from "../src/data/views/maintain.ts";
import { loadItemsBase } from "../src/data/views/maintain-items.ts";
import { loadMaintainStats } from "../src/data/views/stats.ts";
import { loadRankedOpen } from "../src/data/views/work.ts";
import { loadQuickSearch } from "../src/data/views/items.ts";
import { visibleNames } from "../src/data/views/visibility.ts";

const NOW = "2026-11-10T12:00:00.000Z";

test("the lists leave out repos the viewer may not see, filter by hold and count closed items", async () => {
  const db = await connectDb(":memory:");
  try {
    for (const name of ["app", "secret"]) await db.run(db.k.insertInto("tracked_repos").values({ name, pipeline: 1 }));
    const item = (repo: string, number: number, state: string, o: Record<string, unknown> = {}) => ({ repo, number, kind: "issue", state, title: `t${number}`, author: "ann", updated_at: NOW, ...o });
    await db.run(db.k.insertInto("main.items").values([
      item("app", 1, "OPEN"), item("app", 2, "OPEN"), item("app", 3, "CLOSED", { closed_at: NOW }), item("app", 4, "MERGED", { kind: "pr", closed_at: NOW, merged_at: NOW }),
      item("secret", 1, "OPEN"),
    ]));
    await db.run(db.k.insertInto("main.outside_holds").values({ repo: "app", number: 2, author: "eve", kind: "issue", reason: "limit" }));
    const scope = { repos: ["app"], hidden: Object.assign(["secret"], { visible: ["app"] }) };
    const f = { show: "open" as const, filters: [], areas: [], text: null, refs: [], sort: "priority" as const, normalWeight: 5, limit: 50 };

    assert.deepEqual((await loadItemsBase(db, scope, f)).rows.map((r) => r.number).sort(), [1, 2]);
    assert.deepEqual((await loadItemsBase(db, scope, { ...f, filters: ["outside"] })).rows.map((r) => r.number), [2]);
    const closed = await loadItemsBase(db, scope, { ...f, show: "closed", limit: 1 });
    assert.equal(closed.rows.length, 1);
    assert.equal(closed.closedTotal, 2);

    const repos = await loadMaintainRepos(db, { allRepos: ["app"] }, { nowMs: Date.parse(NOW) + 1000 });
    assert.deepEqual([...repos.open], [["app", 2]]);
    assert.deepEqual([...repos.mergedWeek], [["app", 1]]);

    const stats = await loadMaintainStats(db, scope, { days: 7, today: NOW.slice(0, 10) });
    assert.equal(stats.backlog, 2);
    assert.equal(stats.closed.reduce((n, r) => n + r.n, 0), 2);

    assert.deepEqual((await loadQuickSearch(db, scope, "#1", { limit: 20 })).map((r) => r.repo), ["app"]);
    assert.deepEqual((await loadQuickSearch(db, scope, "ann", { limit: 20 })).map((r) => r.repo).sort(), ["app", "app", "app", "app"]);
  } finally {
    await db.close?.();
  }
});

test("Recently merged lists what AutoCraft merged, by a merge or in a batch, newest first", async () => {
  const db = await connectDb(":memory:");
  try {
    const pr = (number: number, o: Record<string, unknown> = {}) => ({ repo: "app", number, kind: "pr", state: "MERGED", title: `t${number}`, author: "ann", updated_at: NOW, ...o });
    await db.run(db.k.insertInto("main.items").values([
      pr(1, { merged_at: "2026-11-10T01:00:00.000Z" }), pr(2, { merged_at: "2026-11-10T02:00:00.000Z" }), pr(3, { state: "OPEN" }), pr(4, { merged_at: "2026-11-10T05:00:00.000Z" }), pr(5, { state: "OPEN" }),
    ]));
    const merge = (number: number, path: string, outcome = "merged", at = "2026-11-10T01:00:00.000Z") => ({ repo: "app", number, head_oid: "h", run_id: "r", at, path, outcome });
    await db.run(db.k.insertInto("main.merges").values([merge(1, "rule"), merge(2, "operator", "refused"), merge(2, "operator"), merge(5, "rule", "refused")]));
    const batch = { repo: "app", branch: "b", base_sha: "b", commit_sha: "c", created_at: NOW };
    await db.run(db.k.insertInto("main.merge_batches").values([{ ...batch, id: 1, state: "merged", updated_at: "2026-11-10T03:00:00.000Z" }, { ...batch, id: 2, state: "failed", updated_at: NOW }]));
    await db.run(db.k.insertInto("main.merge_batch_prs").values([[1, 2], [1, 3], [2, 5]].map(([batch_id, number]) => ({ batch_id: batch_id!, number: number!, head_oid: "h", position: number! }))));
    const f = { show: "merged" as const, filters: [], areas: [], text: null, refs: [], sort: "priority" as const, normalWeight: 5, limit: 50 };
    const shown = await loadItemsBase(db, { repos: ["app"], hidden: [] }, f);
    // 3 merged in a batch the mirror has not read; 4 was merged by someone else, 5 not at all.
    assert.deepEqual(shown.rows.map((r) => [r.number, r.merged!.how]), [[3, "batch"], [2, "approval"], [1, "rule"]]);
    const first = await loadItemsBase(db, { repos: ["app"], hidden: [] }, { ...f, limit: 1 });
    assert.deepEqual([first.rows.map((r) => r.number), first.closedTotal], [[3], 3]);
  } finally {
    await db.close?.();
  }
});

test("a viewer sees public repos and those with a cached permission; an operator sees every tracked repo", () => {
  const repo = (name: string, visibility: string) => ({ name, visibility }) as never;
  const inputs = {
    tracked: new Map([["a", { name: "a" }], ["b", { name: "b" }], ["c", { name: "c" }]]) as never,
    everTracked: new Set<string>(), repos: new Map([["a", repo("a", "public")], ["b", repo("b", "private")], ["c", repo("c", "private")]]),
  };
  assert.deepEqual(visibleNames(inputs, "viewer", new Map([["c", "read" as const]])), ["a", "c"]);
  assert.deepEqual(visibleNames(inputs, "operator", new Map()), ["a", "b", "c"]);
});

test("the work list counts every next step, cuts each in work order and finds the asked item's place", async () => {
  const db = await connectDb(":memory:");
  try {
    const n = 40, next = (i: number) => (i % 5 === 0 ? null : `step${i % 3}`);
    const items = Array.from({ length: n }, (_, i) => ({ repo: i % 2 ? "a" : "b", number: i + 1, kind: "pr", state: i % 13 === 12 ? "CLOSED" : "OPEN", title: `t${i}` }));
    await db.run(db.k.insertInto("main.items").values(items));
    await db.run(db.k.insertInto("main.item_rank").values(items.map((x, i) => ({ repo: x.repo, number: x.number, score: i % 7, breakdown: JSON.stringify({ level: "P1" }), computed_at: NOW }))));
    await db.run(db.k.insertInto("main.item_plans").values(items.map((x, i) => ({
      repo: x.repo, number: x.number, kind: "pr", state: "s", actions: "[]", reasons: "[]", planned_at: NOW, view: JSON.stringify({ ...(next(i) ? { next: next(i) } : {}), ...(i % 4 ? { scope: true } : {}) }),
    }))));
    const wf = (repo: string, number: number, weight: number, entry = "review") => ({ repo, number, kind: "pr", entry, weight, state: "running", started_by: "op", started_at: NOW, started_via: "cli", updated_at: NOW });
    await db.run(db.k.insertInto("main.item_workflows").values([wf("a", 10, 5), wf("b", 3, 8), wf("a", 900, 9, "implement")]));
    await db.run(db.k.insertInto("main.implementations").values({ repo: "a", number: 900, queued_by: "op", state: "in-review", attempt: 1, text_hash: "x", pr_number: 22, created_at: NOW, updated_at: NOW }));
    const started = ["a#22", "b#3", "a#10"];
    for (const scope of [false, true]) {
      const listed = items.map((x, i) => ({ ...x, i, ref: `${x.repo}#${x.number}` })).filter((x) => x.state === "OPEN" && (!scope || x.i % 4))
        .sort((x, y) => (started.includes(x.ref) ? started.indexOf(x.ref) : 9) - (started.includes(y.ref) ? started.indexOf(y.ref) : 9) || (y.i % 7) - (x.i % 7) || (x.repo < y.repo ? -1 : x.repo > y.repo ? 1 : 0) || x.number - y.number);
      const item = { repo: "a", number: 18 };
      const got = await loadRankedOpen(db, { repos: ["a", "b"], scope, top: 3, item });
      const at = listed.findIndex((x) => x.ref === "a#18");
      for (const s of got.steps) {
        const mine = listed.filter((x) => next(x.i) === s.next);
        assert.deepEqual([s.count, s.hasItem, s.before], [mine.length, mine.some((x) => x.ref === "a#18"), mine.filter((x) => listed.indexOf(x) < at).length]);
        assert.deepEqual(got.rows.filter((r) => r.next === s.next).map((r) => `${r.repo}#${r.number}`), mine.slice(0, 3).map((x) => x.ref));
      }
      assert.equal(got.steps.length, 4);
      const all = await loadRankedOpen(db, { repos: ["a", "b"], scope, top: n });
      assert.deepEqual(all.rows.map((r) => `${r.repo}#${r.number}`), listed.map((x) => x.ref));
      assert.deepEqual((await loadRankedOpen(db, { repos: ["a"], scope, top: 1, item: { repo: "a", number: 999 } })).steps.map((s) => s.before), got.steps.map(() => null));
    }
  } finally {
    await db.close();
  }
});

test("the Duplicates filter shows a stored group's item only while a confirmed pair of it holds", async () => {
  const db = await connectDb(":memory:");
  try {
    await db.run(db.k.insertInto("main.items").values([1, 2].map((number) => ({ repo: "app", number, kind: "issue", state: "OPEN", title: `t${number}`, updated_at: NOW, embed_hash: `h${number}` }))));
    await db.run(db.k.insertInto("main.dupe_groups").values({ id: "g", decision_id: "g", repo: "app", source: "model" }));
    await db.run(db.k.insertInto("main.dupe_group_items").values([1, 2].map((number) => ({ group_id: "g", decision_id: "g", repo: "app", number, kind: "issue", role: number === 1 ? "keep" : "close", base_role: "close" }))));
    await db.run(db.k.insertInto("main.duplicate_pairs").values({ repo: "app", a: 1, b: 2, a_hash: "h1", b_hash: "h2", similarity: 0.9, verdict: "duplicate", by_operator: 0, created_at: NOW }));
    const f = { show: "open" as const, filters: ["duplicates" as const], areas: [], text: null, refs: [], sort: "priority" as const, normalWeight: 5, limit: 50 };
    const shown = async () => (await loadItemsBase(db, { repos: ["app"], hidden: [] }, f)).rows.map((r) => r.number);
    assert.deepEqual(await shown(), [2]);
    await db.run(db.k.updateTable("main.items").set({ embed_hash: "edited" }).where("number", "=", 1));
    assert.deepEqual(await shown(), []);
  } finally {
    await db.close();
  }
});

test("the Items base cuts each kind of place in the asked order and counts all of it", async () => {
  const db = await connectDb(":memory:");
  try {
    const at = (i: number) => `2026-11-10T12:00:${String(i).padStart(2, "0")}Z`;
    await db.run(db.k.insertInto("main.items").values(Array.from({ length: 20 }, (_, i) => ({ repo: "app", number: i + 1, kind: "issue", state: "OPEN", title: `t${i}`, updated_at: at(i) }))));
    await db.run(db.k.insertInto("main.item_rank").values(Array.from({ length: 10 }, (_, i) => ({ repo: "app", number: i + 1, score: i, breakdown: "{}", computed_at: NOW }))));
    await db.run(db.k.insertInto("main.item_plans").values(Array.from({ length: 8 }, (_, i) => ({ repo: "app", number: i + 1, kind: "issue", state: "backlog", actions: "[]", reasons: "[]", planned_at: NOW, view: "{}" }))));
    const f = { show: "open" as const, filters: [], areas: [], text: null, refs: [], sort: "priority" as const, normalWeight: 5, limit: 2 };
    const base = async (sort: "priority" | "updated") => {
      const b = await loadItemsBase(db, { repos: ["app"], hidden: [] }, { ...f, sort });
      const of = (state: string | null) => b.rows.filter((r) => r.planState === state).map((r) => r.number).sort((x, y) => x - y);
      assert.deepEqual(b.places.map((p) => [p.item.planState, p.count]).sort(), [["backlog", 8], [null, 12]].sort());
      return [of("backlog"), of(null)];
    };
    assert.deepEqual(await base("priority"), [[7, 8], [9, 10]], "the highest rank first, then the unranked");
    assert.deepEqual(await base("updated"), [[7, 8], [19, 20]]);
  } finally {
    await db.close();
  }
});
