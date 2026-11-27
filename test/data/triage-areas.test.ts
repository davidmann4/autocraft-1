// triage module, part b: areas, item areas and proposals (SQLite; Postgres when AUTOCRAFT_TEST_PG_URL is set).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db, Dialect } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import { TEST_PG_URL, testDatabase } from "../test-db.ts";
import { expectFlat } from "../helpers/query-count.ts";
import {
  AreaError, acceptProposal, decideSuggestion, dismissProposal, editAreas, listAreaVersions, loadAreaDue, loadAreaDueLists, loadAreaLists, loadAreaOverview, loadItemAreas,
  loadOpenTitles, loadProposal, loadProposals, loadUnassignedSample, saveItemAreas, saveProposal,
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

const AREAS = [{ name: "ui", description: "screens" }, { name: "api", description: "endpoints" }, { name: "docs", description: "writing" }];
const refs = (n: number, repo = "app") => Array.from({ length: n }, (_, i) => ({ repo, number: i + 1 }));

/** A tracked repo with pipeline on, a list of three areas (version 1) and `n` open issues. */
async function seed(db: Db, n: number, repos = ["app"]): Promise<void> {
  const q = queryDb(db), k = q.k as any;
  for (const repo of repos) {
    await q.run(k.insertInto("tracked_repos").values({ name: repo, added_by: "t", added_at: T0, pipeline: 1 }));
    await q.run(k.insertInto("area_lists").values({ repo, version: 1, areas: JSON.stringify(AREAS), at: T0, by: null, note: null }));
    if (n) await q.run(k.insertInto("items").values(refs(n, repo).map((r) => ({ ...r, kind: "issue", state: "OPEN", title: `issue ${r.number}`, body: "text", updated_at: `2026-01-0${(r.number % 9) + 1}T00:00:00.000Z` }))));
  }
}

const areaOf = async (db: Db, number: number) => (await loadItemAreas(db, [{ repo: "app", number }])).get(`app#${number}`);

both("editing a list moves renamed and merged items, drops operator choices of removed areas and versions the rest", async (db) => {
  await seed(db, 6);
  const put = (number: number, area: string | null, source: string) => ({ repo: "app", number, area, source, confidence: null });
  assert.deepEqual(await saveItemAreas(db, "app", 1, [put(1, "ui", "jev"), put(2, "api", "operator"), put(3, "docs", "haiku"), put(4, "docs", "operator"), put(5, null, "jev")]), { stored: 5, stale: false });

  assert.equal(await editAreas(db, "app", { op: "rename", from: "ui", to: "screens" }, "ann"), 2);
  assert.equal((await areaOf(db, 1))?.area, "screens");
  assert.equal((await areaOf(db, 1))?.listVersion, 2);

  assert.equal(await editAreas(db, "app", { op: "remove", name: "docs" }, "ann"), 3);
  assert.equal((await areaOf(db, 3))?.area, null, "a model's answer for a removed area is unassigned");
  assert.equal(await areaOf(db, 4), undefined, "an operator's choice for a removed area is dropped");
  assert.equal((await areaOf(db, 2))?.listVersion, 3);
  assert.equal((await areaOf(db, 5))?.listVersion, 1, "an unassigned item stays on the version it was asked against");

  assert.equal(await editAreas(db, "app", { op: "merge", from: "screens", into: "api" }, "ann"), 4);
  assert.equal((await areaOf(db, 1))?.area, "api");
  await assert.rejects(editAreas(db, "app", { op: "add", name: "api", description: "again" }, "ann"), AreaError);
  await assert.rejects(editAreas(db, "nowhere", { op: "add", name: "x", description: "y" }, "ann"), /not tracked/);
  assert.deepEqual((await listAreaVersions(db, "app")).map((v) => v.version), [4, 3, 2, 1]);
  assert.deepEqual([...(await loadAreaLists(db, ["app"])).get("app")!.areas.map((a) => a.name)], ["api"]);
});

both("a chunk written against an older list version is refused whole", async (db) => {
  await seed(db, 3);
  await editAreas(db, "app", { op: "add", name: "ops", description: "running it" }, "ann");
  const r = await saveItemAreas(db, "app", 1, [{ repo: "app", number: 1, area: "ui", source: "jev", confidence: 0.9 }]);
  assert.deepEqual(r, { stored: 0, stale: true });
  assert.equal(await areaOf(db, 1), undefined);
  assert.deepEqual(await saveItemAreas(db, "app", 2, [{ repo: "app", number: 1, area: "ui", source: "jev", confidence: 0.9 }]), { stored: 1, stale: false });
  assert.equal((await areaOf(db, 1))?.listVersion, 2);
});

both("overview counts per area and unassigned open items; due items follow the list version", async (db) => {
  await seed(db, 5);
  const put = (number: number, area: string | null, source = "jev") => ({ repo: "app", number, area, source, confidence: null });
  await saveItemAreas(db, "app", 1, [put(1, "ui"), put(2, "ui"), put(3, "api"), put(4, null), put(5, "docs", "operator")]);
  const o = await loadAreaOverview(db, "app");
  assert.equal(o.list?.version, 1);
  assert.deepEqual([...o.counts], [["ui", 2], ["api", 1], ["docs", 1]]);
  assert.equal(o.unassigned, 1);

  assert.deepEqual((await loadAreaDue(db, {})).length, 0, "all answered at the current version");
  assert.deepEqual((await loadAreaDue(db, { rescan: true })).map((x) => x.number), [4], "a none-of-these answer is asked again on rescan");
  await editAreas(db, "app", { op: "add", name: "ops", description: "running it" }, "ann");
  assert.deepEqual((await loadAreaDue(db, {})).map((x) => x.number).sort(), [4], "unassigned and asked against an older version; an operator's choice is never due");
  const due = await loadAreaDue(db, { refs: [{ repo: "app", number: 4 }] });
  assert.equal(due[0]!.version, 2);
  assert.equal(due[0]!.kind, "issue");
  assert.equal((await loadAreaDueLists(db, refs(5))).get("app#4")?.version, 2);
  assert.equal((await loadAreaDueLists(db, [])).size, 0);
  assert.deepEqual((await loadUnassignedSample(db, "app", 1, 10)).map((x) => x.number), [4], "answered none of these under version 1");
  assert.equal((await loadUnassignedSample(db, "app", 2, 10)).length, 0);
  assert.equal((await loadOpenTitles(db, "app", 3)).length, 3);
});

both("proposals: a new one replaces the older open one of its kind; accepting runs the edit once", async (db) => {
  await seed(db, 0);
  const first = await saveProposal(db, "app", "propose", [{ name: "core", description: "engine" }], "bot");
  const second = await saveProposal(db, "app", "propose", [{ name: "core", description: "engine" }, { name: "ui", description: "screens" }], "bot");
  assert.equal((await loadProposal(db, first))?.state, "dismissed");
  assert.deepEqual((await loadProposals(db, "app")).map((p) => p.id), [second]);
  assert.equal((await loadProposals(db, "app", false)).length, 2);

  assert.equal(await acceptProposal(db, second, "ann"), 2);
  assert.equal((await loadProposal(db, second))?.state, "accepted");
  assert.deepEqual((await loadAreaLists(db, "all")).get("app")!.areas.map((a) => a.name), ["core", "ui"]);
  await assert.rejects(acceptProposal(db, second, "ann"), /not open/);

  const s = await saveProposal(db, "app", "suggest", [{ name: "ops", description: "running it" }, { name: "qa", description: "tests" }], "bot");
  assert.equal(await decideSuggestion(db, s, "ann", ["ops"], ["qa"]), 3);
  assert.deepEqual((await loadProposal(db, s))?.areas.map((a) => a.state), ["accepted", "ignored"]);
  assert.equal((await loadProposal(db, s))?.state, "accepted");
  const t = await saveProposal(db, "app", "propose", [{ name: "x", description: "y" }], "bot");
  await dismissProposal(db, t, "ann");
  await assert.rejects(dismissProposal(db, t, "ann"), /not open/);
});

test("area loaders and the chunk write issue the same number of statements at 2 and 12 items or repos", async () => {
  const unit = (run: (db: Db, n: number) => Promise<unknown>, repos = false) => async (size: number) => {
    const t = await testDatabase("", "sqlite");
    const db = await t.open({ app: true });
    await seed(db, repos ? 1 : size, repos ? Array.from({ length: size }, (_, i) => `r${i}`) : ["app"]);
    return { db, run: () => run(db, size), close: () => t.close() };
  };
  const put = (n: number) => refs(n).map((r) => ({ ...r, area: "ui", source: "jev", confidence: 0.5 }));
  await expectFlat(unit((db, n) => loadItemAreas(db, refs(n))), 2, 12);
  await expectFlat(unit((db, n) => saveItemAreas(db, "app", 1, put(n))), 2, 12);
  await expectFlat(unit((db, n) => loadAreaDueLists(db, refs(n))), 2, 12);
  await expectFlat(unit((db) => loadAreaDue(db, {})), 2, 12);
  await expectFlat(unit((db, n) => loadAreaLists(db, Array.from({ length: n }, (_, i) => `r${i}`)), true), 2, 12);
});
