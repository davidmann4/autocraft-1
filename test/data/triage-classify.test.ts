// Triage classify module: the run cursor, verdict writers whose logic changed shape (replace with new rowids, one transaction per
// Jev chunk, set-based Haiku-alone marking) and the settled table against the same rule applied to the raw rows.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db, Dialect } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import { TEST_PG_URL } from "../test-db.ts";
import { expectFlat } from "../helpers/query-count.ts";
import {
  classifyRun, classifyRunInfo, countVerdicts, currentRunReady, ensureSettled, loadJevFailed, loadLatestVerdicts, loadRefereeRows, loadSettled, loadSettledRows,
  loadVerdicts, markHaikuAlone, markJevFailed, markSpotCheck, pruneClassifyState, recordRefereeFailures, saveJevChunk, saveVerdicts,
} from "../../src/data/triage/index.ts";
import type { VerdictInput } from "../../src/data/triage/index.ts";
import { AT, both, openApp } from "./planner-helpers.ts";

const RUN = "run-1";
const jevProbs = (top: number, extra: Record<string, number> = {}) => JSON.stringify({ top, security: 0.05, needs_decision: 0.05, type: { bugfix: top }, ...extra });
const verdict = (repo: string, number: number, classifier: string, o: Partial<VerdictInput> = {}): VerdictInput => ({
  repo, number, classifier, run_id: RUN, at: AT, type_label: "bugfix", flags: "[]", probs: classifier === "jev" ? jevProbs(0.97) : null, reason: null, input_hash: null, ...o,
});
const refs = (repo: string, n: number) => Array.from({ length: n }, (_, i) => ({ repo, number: i + 1 }));
const rowids = async (db: Db) => {
  const q = queryDb(db);
  return new Map((await q.all(q.k.selectFrom("main.classifications").select(["repo", "number", "classifier", "input_hash"]).select((eb) => eb.ref("rowid" as never).as("rid")))).map((r) => [`${r.repo}#${r.number}#${r.classifier}`, Number(r.rid)]));
};

both("classifyRun reads the run set by an operator first, else the run of the newest verdict (a tie goes to Jev)", async ({ db }) => {
  const q = queryDb(db);
  assert.equal(await classifyRun(db), null);
  await saveVerdicts(db, [verdict("o/a", 1, "jev", { run_id: "old", at: "2026-01-01T00:00:00.000Z" })]);
  assert.equal(await classifyRun(db), "old");
  // Haiku counts only when it classified alone (it carries the input hash).
  await saveVerdicts(db, [verdict("o/a", 2, "haiku", { run_id: "second-opinion", at: "2026-01-02T00:00:00.000Z" })]);
  assert.equal(await classifyRun(db), "old");
  await saveVerdicts(db, [verdict("o/a", 3, "haiku", { run_id: "alone", at: "2026-01-02T00:00:00.000Z", input_hash: "h" })]);
  assert.equal(await classifyRun(db), "alone");
  await saveVerdicts(db, [verdict("o/a", 4, "jev", { run_id: "tie", at: "2026-01-02T00:00:00.000Z" })]);
  assert.equal(await classifyRun(db), "tie");
  await q.run(q.k.insertInto("main.classify_state").values({ kind: "current_run", repo: "", number: 0, value: "chosen", at: AT }));
  assert.equal(await classifyRun(db), "chosen");
  assert.deepEqual(await classifyRunInfo(db), { set: "chosen", derived: "tie" });
});

both("saveVerdicts replaces a key's row with a new rowid and keeps the others", async ({ db }) => {
  await saveVerdicts(db, [verdict("o/a", 1, "jev"), verdict("o/a", 2, "jev")]);
  const before = await rowids(db);
  const stored = await saveVerdicts(db, [verdict("o/a", 1, "jev", { type_label: "infra" }), verdict("o/a", 1, "jev", { type_label: "performance" })]);
  assert.deepEqual([...stored], ["o/a#1"]);
  const after = await rowids(db);
  assert.ok(after.get("o/a#1#jev")! > Math.max(...before.values()), "the replaced row is newer than every other");
  assert.equal(after.get("o/a#2#jev"), before.get("o/a#2#jev"));
  const rows = await loadVerdicts(db, [{ repo: "o/a", number: 1 }], RUN);
  assert.equal(rows.get("o/a#1")!.length, 1);
  assert.equal(rows.get("o/a#1")![0]!.type_label, "performance", "the last row of one key counts");
});

both("a verdict a Jev chunk cannot store leaves what is written with the chunk, and its error is returned for after the commit", async ({ db }) => {
  const r = await db.write(async () => {
    await markJevFailed(db, [{ repo: "o/a", number: 9, hash: "h" }]);
    return await saveJevChunk(db, { verdicts: [verdict("o/a", 1, "jev"), verdict("o/a", 2, "jev", { at: null as unknown as string })], failed: [] });
  });
  assert.deepEqual([...r.stored], ["o/a#1"]);
  assert.ok(r.error);
  assert.equal((await loadVerdicts(db, refs("o/a", 2), RUN)).size, 1);
  assert.equal((await loadJevFailed(db, [{ repo: "o/a", number: 9 }])).get("o/a#9"), "h");
});

both("saveJevChunk stores verdicts and failed marks together, and a failed mark is replaced by a later one", async ({ db }) => {
  const { stored } = await saveJevChunk(db, { verdicts: [verdict("o/a", 1, "jev")], failed: [{ repo: "o/a", number: 2, hash: "h1" }, { repo: "o/a", number: 3, hash: "h2" }] });
  assert.deepEqual([...stored], ["o/a#1"]);
  assert.deepEqual([...(await loadJevFailed(db, refs("o/a", 3)))], [["o/a#2", "h1"], ["o/a#3", "h2"]]);
  assert.equal(await markJevFailed(db, [{ repo: "o/a", number: 2, hash: "h3" }]), 1);
  assert.equal((await loadJevFailed(db, [{ repo: "o/a", number: 2 }])).get("o/a#2"), "h3");
  assert.equal(await markJevFailed(db, []), 0);
});

both("pruneClassifyState drops marks of items that left the mirror or whose classify input changed", async ({ db }) => {
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.items").values([{ repo: "o/a", number: 1, kind: "issue", state: "OPEN", class_hash: "h" }, { repo: "o/a", number: 3, kind: "issue", state: "OPEN", class_hash: "h2" }]));
  await markJevFailed(db, [{ repo: "o/a", number: 1, hash: "h" }, { repo: "o/a", number: 2, hash: "h" }, { repo: "o/a", number: 3, hash: "h" }]);
  assert.equal(await pruneClassifyState(db), 2);
  assert.deepEqual([...(await loadJevFailed(db, refs("o/a", 3))).keys()], ["o/a#1"]);
});

both("markHaikuAlone sets the hash on this pass's Haiku rows and removes only the item's Jev rows of another hash", async ({ db }) => {
  const since = "2026-02-01T00:00:00.000Z", later = "2026-02-02T00:00:00.000Z", earlier = "2026-01-01T00:00:00.000Z";
  await saveVerdicts(db, [
    verdict("o/a", 1, "haiku", { at: later }), verdict("o/a", 1, "jev", { input_hash: "old" }),
    verdict("o/a", 2, "haiku", { at: later }), verdict("o/a", 2, "jev", { input_hash: null }),
    verdict("o/a", 3, "haiku", { at: earlier }), verdict("o/a", 3, "jev", { input_hash: "old" }),
    verdict("o/a", 4, "haiku", { at: later }), verdict("o/a", 4, "jev", { input_hash: "new" }),
  ]);
  const hit = await markHaikuAlone(db, RUN, since, new Map([["o/a#1", "new"], ["o/a#2", "new"], ["o/a#3", "new"], ["o/a#4", "new"]]));
  assert.deepEqual(hit.sort(), ["o/a#1", "o/a#2", "o/a#4"]);
  const rows = await loadVerdicts(db, refs("o/a", 4), RUN);
  const has = (n: number, c: string) => rows.get(`o/a#${n}`)!.some((r) => r.classifier === c);
  assert.equal(rows.get("o/a#1")!.find((r) => r.classifier === "haiku")!.input_hash, "new");
  assert.ok(!has(1, "jev"), "a Jev row of earlier text goes");
  assert.ok(has(2, "jev"), "a Jev row without a hash stays");
  assert.ok(has(3, "jev") && rows.get("o/a#3")!.find((r) => r.classifier === "haiku")!.input_hash === null, "an earlier Haiku row is left alone");
  assert.ok(has(4, "jev"), "a Jev row at the same hash stays");
});

both("recordRefereeFailures counts on the sonnet row and keeps its answer; markSpotCheck flags only the picks", async ({ db }) => {
  await saveVerdicts(db, [verdict("o/a", 1, "sonnet", { reason: "why", probs: JSON.stringify({ sure: true }), flags: "[]" }), verdict("o/a", 2, "sonnet", { probs: JSON.stringify({ sure: false, opusFailures: 1 }) }), verdict("o/a", 3, "jev")]);
  assert.equal(await recordRefereeFailures(db, RUN, [{ repo: "o/a", number: 1 }, { repo: "o/a", number: 2 }, { repo: "o/a", number: 3 }], "2026-03-01T00:00:00.000Z"), 2);
  const rows = await loadRefereeRows(db, RUN, refs("o/a", 3));
  assert.deepEqual([...rows.keys()].sort(), ["o/a#1", "o/a#2"]);
  assert.deepEqual(JSON.parse(rows.get("o/a#1")!.probs!), { sure: true, opusFailures: 1, opusFailedAt: "2026-03-01T00:00:00.000Z" });
  assert.equal(JSON.parse(rows.get("o/a#2")!.probs!).opusFailures, 2);
  assert.equal(rows.get("o/a#1")!.reason, "why");
  assert.equal(rows.get("o/a#1")!.at, AT);
  await markSpotCheck(db, RUN, [{ repo: "o/a", number: 2 }]);
  await markSpotCheck(db, RUN, [{ repo: "o/a", number: 1 }]);
  const flags = (await loadVerdicts(db, refs("o/a", 3), RUN)).get("o/a#1")![0]!.flags;
  assert.equal(flags, '["spot-check"]');
  assert.equal((await loadVerdicts(db, refs("o/a", 3), RUN)).get("o/a#2")![0]!.flags, "[]", "an earlier pick is cleared");
  assert.equal(await countVerdicts(db, { run: RUN, classifier: "sonnet" }), 2);
  assert.equal(await countVerdicts(db, { run: RUN, since: "2099-01-01T00:00:00.000Z" }), 0);
});

both("the settled table gives the same verdicts as the rule over the raw rows, and follows later changes", async ({ db }) => {
  assert.equal(await currentRunReady(db), null);
  await saveVerdicts(db, [
    verdict("o/a", 1, "jev"),
    verdict("o/a", 2, "jev", { probs: jevProbs(0.5), type_label: "bugfix" }), verdict("o/a", 2, "haiku", { type_label: "bugfix" }),
    verdict("o/a", 3, "jev", { probs: jevProbs(0.5), type_label: "bugfix" }),
    verdict("o/a", 4, "jev", { probs: jevProbs(0.5), type_label: "bugfix" }), verdict("o/a", 4, "haiku", { type_label: "infra" }),
    verdict("o/a", 5, "haiku", { input_hash: "h", flags: '["security"]' }),
  ]);
  const run = await currentRunReady(db);
  assert.equal(run, RUN);
  const all = refs("o/a", 6);
  const direct = await loadSettled(db, all, run);
  const table = await loadSettledRows(db, run!);
  assert.equal(direct.size, 5, "an unclassified item has no row");
  for (const [ref, s] of direct) assert.deepEqual(table.get(ref), s, ref);
  assert.equal(table.get("o/a#2")!.source, "haiku");
  assert.equal(table.get("o/a#3")!.status, "waiting");
  assert.equal(table.get("o/a#4")!.status, "disagree");
  assert.deepEqual(table.get("o/a#5")!.flags, ["security"]);
  assert.deepEqual([...(await loadSettledRows(db, run!, [{ repo: "o/a", number: 2 }])).keys()], ["o/a#2"]);
  // A verdict written later is picked up by the next refresh.
  await saveVerdicts(db, [verdict("o/a", 3, "haiku", { type_label: "bugfix" })]);
  await ensureSettled(db, run);
  assert.equal((await loadSettledRows(db, run!)).get("o/a#3")!.status, "settled");
  assert.deepEqual((await loadLatestVerdicts(db, [{ repo: "o/a", number: 2 }])).get("o/a#2")!.map((r) => r.classifier), ["haiku", "jev"]);
});

for (const dialect of ["sqlite", ...(TEST_PG_URL ? ["postgres"] : [])] as Dialect[]) {
  test(`verdict loaders and writers issue the same statements for any number of items (${dialect})`, async () => {
    const unit = (run: (db: Db, n: number) => Promise<unknown>) => async (n: number) => {
      const { t, db } = await openApp(dialect);
      await saveVerdicts(db, Array.from({ length: n }, (_, i) => verdict("o/a", i + 1, i % 2 ? "jev" : "haiku", { input_hash: "h" })));
      return { db, run: () => run(db, n), close: () => t.close() };
    };
    await expectFlat(unit(async (db, n) => { await loadVerdicts(db, refs("o/a", n), RUN); await loadSettled(db, refs("o/a", n), RUN); await loadLatestVerdicts(db, refs("o/a", n)); }), 3, 40);
    await expectFlat(unit(async (db, n) => { await saveVerdicts(db, Array.from({ length: n }, (_, i) => verdict("o/b", i + 1, "jev"))); }), 3, 40);
    await expectFlat(unit(async (db, n) => { await saveJevChunk(db, { verdicts: refs("o/c", n).map((r) => verdict(r.repo, r.number, "jev")), failed: refs("o/d", n).map((r) => ({ ...r, hash: "x" })) }); }), 3, 40);
    await expectFlat(unit(async (db, n) => { await markHaikuAlone(db, RUN, "2000-01-01", new Map(refs("o/a", n).map((r) => [`o/a#${r.number}`, "z"]))); }), 3, 40);
    await expectFlat(unit(async (db, n) => { await currentRunReady(db); await loadSettledRows(db, RUN, refs("o/a", n)); }), 3, 40);
    await expectFlat(unit(async (db, n) => { await recordRefereeFailures(db, RUN, refs("o/a", n), AT); await markSpotCheck(db, RUN, refs("o/a", n)); }), 3, 40);
  });
}
