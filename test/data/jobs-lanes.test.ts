import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import { claimMark, loadHeldLeaseKeys, loadLaneInputs, loadLaneState, loadLanes, removeLaneState, saveLaneState, saveLanes, takeLeases } from "../../src/data/jobs/index.ts";
import type { StreakRow } from "../../src/data/jobs/index.ts";
import { expectFlat } from "../helpers/query-count.ts";
import { both, flat, seedJobs } from "./jobs-fixture.ts";

/** The failure run at the head of `rows` (newest first) and the id of the row after it, as `failureBackoff` reads them. */
const headOf = (rows: { id: number; state: string }[]): [number, number | null] => {
  let failures = 0;
  while (failures < rows.length && rows[failures]!.state === "failed") failures++;
  return [failures, rows[failures]?.id ?? null];
};

both("the loaded streaks give the same failure runs as the 12-row query, per repo and merged per step", async (db) => {
  let seed = 3;
  const rnd = (n: number) => Math.floor((seed = (seed * 1103515245 + 12345) % 2147483648) / 65536) % n;
  const repos = ["a", "b", "c"];
  await seedJobs(db, Array.from({ length: 150 }, () => ({ step: rnd(2) ? "review" : "verify", repo: repos[rnd(3)]!, state: rnd(4) ? "failed" : "done", requested_by: "pipeline", error: rnd(9) ? "boom" : "write paced: later" })));
  const q = queryDb(db);
  const old = async (step: string, repo: string | null) => (await q.all(q.k.selectFrom("jobs").select(["id", "state"]).where("step", "=", step).$if(repo !== null, (b) => b.where("repo", "=", repo!))
    .where("requested_by", "=", "pipeline").where("state", "in", ["done", "failed"]).where("error", "not like", "write paced:%").orderBy("id", "desc").limit(12)));
  const { streaks } = await loadLaneInputs(db, Date.now());
  const rowsOf = (step: string, repo: string | null) => streaks.filter((s: StreakRow) => s.step === step && (repo === null || s.repo === repo)).sort((x, y) => y.id - x.id).slice(0, 12);
  const got: unknown[] = [];
  for (const step of ["review", "verify"]) for (const repo of [null, ...repos]) {
    const want = headOf(await old(step, repo));
    assert.deepEqual(headOf(rowsOf(step, repo)), want, `${step} ${repo}`);
    got.push(want);
  }
  return got;
});

both("loadLaneInputs counts today's items since the later of the day start and the step's reset, and reads fingerprints, marks and held leases", async (db) => {
  const q = queryDb(db);
  const day = new Date().toISOString().slice(0, 10);
  const [a, b, held] = await seedJobs(db, [
    { step: "review", state: "done", items: 5, started_at: `${day}T01:00:00.000Z` }, { step: "review", state: "done", items: 7, started_at: `${day}T05:00:00.000Z` },
    { step: "verify", state: "running", items: 1, started_at: `${day}T02:00:00.000Z` },
  ]);
  await q.run(q.k.insertInto("stage_limits").values({ step: "review", per_day: 10, reset_at: `${day}T03:00:00.000Z` }));
  await saveLaneState(db, [{ kind: "fp", step: "review", repo: "app", value: "f1", job_id: a }, { kind: "mark", step: "planned_at", value: "t" }, { kind: "cursor", step: "review", value: "app" }]);
  await takeLeases(db, ["pr:app#1"], { id: held!, step: "verify" });
  const li = await loadLaneInputs(db, Date.parse(`${day}T12:00:00.000Z`));
  assert.deepEqual([li.usedToday.get("review"), li.usedToday.get("verify")], [7, 1]);
  assert.deepEqual([li.fps.get("review|app")], [{ job: a, fp: "f1" }]);
  assert.deepEqual([li.marks.get("planned_at"), li.marks.get("review")], ["t", "app"]);
  assert.deepEqual([...li.heldLeaseKeys], ["pr:app#1"]);
  assert.deepEqual(li.live.map((j) => j.id), [held]);
  assert.equal(li.resets.get("review"), `${day}T03:00:00.000Z`);
  assert.equal(b !== undefined, true);
  return [li.usedToday.get("review")];
});

test("a planner pass load reads the same number of statements for 2 and 12 jobs, repos and leases", async () => {
  await expectFlat(flat(async (db, size) => {
    await seedJobs(db, Array.from({ length: size * 3 }, (_, i) => ({ step: i % 2 ? "review" : "verify", repo: `r${i % size}`, state: ["done", "failed", "queued"][i % 3]!, requested_by: "pipeline" })));
    await saveLaneState(db, Array.from({ length: size }, (_, i) => ({ kind: "fp" as const, step: "review", repo: `r${i}`, value: "x" })));
    return async () => { assert.ok((await loadLaneInputs(db, Date.now())).streaks.length > 0); };
  }), 2, 12);
});

async function lanesOf(db: Db): Promise<string[]> { return [...(await loadLanes(db)).keys()].sort(); }

both("saveLanes upserts lanes with items, drops empty ones, and with keepOthers false drops every lane not named", async (db) => {
  const at = "2026-01-01T00:00:00.000Z";
  await saveLanes(db, [{ lane: "review", total: 2, items: [{ n: 1 }, { n: 2 }], at }, { lane: "merge", total: 1, items: [{ n: 3 }], at }, { lane: "fixup", total: 1, items: [{ n: 4 }], at }], true);
  assert.deepEqual(await lanesOf(db), ["fixup", "merge", "review"]);
  await saveLanes(db, [{ lane: "merge", total: 0, items: [], at }], true);
  assert.deepEqual(await lanesOf(db), ["fixup", "review"]);
  await saveLanes(db, [{ lane: "review", total: 3, items: [1, 2, 3], at }], false);
  assert.deepEqual([...(await loadLanes(db)).values()].map((l) => [l.lane, l.total, l.items.length]), [["review", 3, 3]]);
  assert.deepEqual([...(await loadLanes(db, ["nope"])).keys()], []);
  return null;
});

both("claimMark lets one caller win per interval, and lane state rows upsert and delete by key", async (db) => {
  const t = Date.parse("2026-01-01T00:00:00.000Z");
  assert.equal(await claimMark(db, "security_poll_at", t, 60_000), true);
  assert.equal(await claimMark(db, "security_poll_at", t + 30_000, 60_000), false);
  assert.equal(await claimMark(db, "security_poll_at", t + 61_000, 60_000), true);
  await saveLaneState(db, [{ kind: "fp", step: "s", repo: "r", value: "1" }, { kind: "fp", step: "s", repo: "r", value: "2" }, { kind: "reset", step: "s", value: "x" }]);
  const rows = await loadLaneState(db, ["fp", "reset"]);
  assert.deepEqual([...rows.keys()].sort(), ["fp|s|r", "reset|s|"]);
  assert.equal(rows.get("fp|s|r")!.value, "2");
  assert.equal(await removeLaneState(db, [{ kind: "fp", step: "s", repo: "r" }, { kind: "reset", step: "s" }]), 2);
  assert.equal((await loadLaneState(db, ["fp", "reset"])).size, 0);
  assert.equal((await loadHeldLeaseKeys(db)).size, 0);
  return null;
});

