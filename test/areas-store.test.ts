// Area lists: an edit saves a new version, moves or unassigns the items of changed areas, and keeps operator choices only while their area exists.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { acceptProposal, decideSuggestion, editAreas, listAreaVersions, loadAreaLists, loadAreaOverview, loadItemAreas, loadProposals, saveItemAreas, saveProposal } from "../src/data/triage/index.ts";
import { connectDb, type Db } from "./helpers/raw-db.ts";
import { SCRATCH } from "./scratch.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const area = (name: string) => ({ name, description: `${name} things` });
const setItemArea = async (db: Db, repo: string, number: number, a: string | null, source: string, confidence: number | null, version: number) => void await saveItemAreas(db, repo, version, [{ repo, number, area: a, source, confidence }]);
const itemAreaOf = async (db: Db, repo: string, number: number) => (await loadItemAreas(db, [{ repo, number }])).get(`${repo}#${number}`) ?? null;
const currentList = async (db: Db, repo: string) => (await loadAreaLists(db, [repo])).get(repo) ?? null;
const unassignedCount = async (db: Db, repo: string) => (await loadAreaOverview(db, repo)).unassigned;
const areaCounts = async (db: Db, repo: string) => [...(await loadAreaOverview(db, repo)).counts].map(([a, open]) => ({ area: a, open }));
const proposalsOf = loadProposals;

async function fresh(name: string) {
  mkdirSync(SCRATCH, { recursive: true });
  const db = await connectDb(join(SCRATCH, `areas-store-${name}-${process.pid}.db`));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: T0, pipeline: 1 }));
  await db.run(db.k.insertInto("items").values([1, 2, 3, 4].map((number) => ({ repo: "app", number, kind: "issue", state: "OPEN", title: `t${number}`, body: "b", created_at: T0, updated_at: T0, labels: "[]" }))));
  return db;
}

test("an edit moves items of a renamed area, drops operator choices of a removed one and unassigns what a running pass wrote", async () => {
  const db = await fresh("edit");
  assert.equal(await editAreas(db, "app", { op: "replace", areas: [area("Filters"), area("Export"), area("Zoom")] }, "op"), 1);
  await setItemArea(db, "app", 1, "Filters", "jev", 0.95, 1);
  await setItemArea(db, "app", 2, "Export", "operator", null, 1);
  await setItemArea(db, "app", 3, "Ghost", "haiku", null, 1);
  await setItemArea(db, "app", 4, "Zoom", "haiku", null, 1);

  assert.equal(await editAreas(db, "app", { op: "rename", from: "Filters", to: "Effects" }, "op"), 2);
  assert.equal(await editAreas(db, "app", { op: "remove", name: "Export" }, "op"), 3);

  assert.equal((await itemAreaOf(db, "app", 1))?.area, "Effects");
  assert.equal(await itemAreaOf(db, "app", 2), null, "the operator's choice of a removed area is dropped");
  assert.equal((await itemAreaOf(db, "app", 3))?.area, null, "a name that is not in the list is unassigned");
  assert.equal((await itemAreaOf(db, "app", 4))?.listVersion, 3, "an assigned item moves to the new version");
  assert.equal((await currentList(db, "app"))?.version, 3);
  assert.deepEqual((await listAreaVersions(db, "app")).map((v) => v.version), [3, 2, 1]);
  assert.equal(await unassignedCount(db, "app"), 2);
  await assert.rejects(editAreas(db, "app", { op: "rename", from: "Nope", to: "X" }, "op"), /no area/);
  await assert.rejects(editAreas(db, "other", { op: "add", name: "X", description: "d" }, "op"), /not tracked/);
});

test("area counts list the busiest area first, ties by name", async () => {
  const db = await fresh("counts");
  await editAreas(db, "app", { op: "replace", areas: [area("B"), area("A"), area("C")] }, null);
  await setItemArea(db, "app", 1, "B", "jev", 0.9, 1);
  await setItemArea(db, "app", 2, "A", "jev", 0.9, 1);
  await setItemArea(db, "app", 3, "C", "jev", 0.9, 1);
  await setItemArea(db, "app", 4, "C", "jev", 0.9, 1);
  assert.deepEqual(await areaCounts(db, "app"), [{ area: "C", open: 2 }, { area: "A", open: 1 }, { area: "B", open: 1 }]);
  await setItemArea(db, "app", 4, null, "haiku", null, 1);
  assert.equal((await areaCounts(db, "app")).length, 3);
  assert.equal(await unassignedCount(db, "app"), 1);
  assert.deepEqual(await itemAreaOf(db, "app", 4), { area: null, source: "haiku", confidence: null, listVersion: 1, at: (await itemAreaOf(db, "app", 4))!.at });
});

test("a new proposal replaces an open one of its kind; accepting and deciding settle them", async () => {
  const db = await fresh("proposals");
  const first = await saveProposal(db, "app", "propose", [area("A")], "op");
  const second = await saveProposal(db, "app", "propose", [area("A"), area("B")], "op");
  assert.notEqual(first, second);
  assert.deepEqual((await proposalsOf(db, "app")).map((p) => p.id), [second]);
  assert.deepEqual((await proposalsOf(db, "app", false)).map((p) => p.state), ["open", "dismissed"]);
  assert.equal(await acceptProposal(db, second, "op"), 1);
  assert.equal((await proposalsOf(db, "app", false))[0]!.state, "accepted");

  const suggest = await saveProposal(db, "app", "suggest", [area("C"), area("D")], null);
  assert.equal(await decideSuggestion(db, suggest, "op", ["C"], []), 2);
  const [open] = await proposalsOf(db, "app");
  assert.deepEqual(open!.areas.map((a) => a.state), ["accepted", "open"]);
  assert.equal(await decideSuggestion(db, suggest, "op", [], ["D"]), null);
  assert.equal((await proposalsOf(db, "app")).length, 0);
  assert.deepEqual((await currentList(db, "app"))?.areas.map((a) => a.name), ["A", "B", "C"]);
});
