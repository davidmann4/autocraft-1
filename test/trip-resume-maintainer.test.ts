// Push breakers trip per repo (a trip stops its stage on that repo only, and a maintainer who can write to that repo resumes it)
// and on every repo when broken pushes come from several repos (an operator resumes it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePushBreakers, loadTrips, tripStage } from "../src/data/control/index.ts";
import { connectDb, type Db } from "./helpers/raw-db.ts";
import { resumeTrip } from "../src/dash/api/pipeline.ts";
import { loadItemFact } from "../src/core/issue-facts.ts";
import { gates } from "../src/core/gates.ts";

const trip = async (db: Db, key: string, reason: string, evidence: string[], at: string): Promise<void> => void await tripStage(db, [{ key, reason, evidence, at }]);
const evaluatePushBreaker = async (db: Db, stage: string, repo: string, at: string): Promise<void> => void await evaluatePushBreakers(db, [{ stage, repo }], at);
const activeTrips = async (db: Db): Promise<Record<string, string>> => Object.fromEntries([...await loadTrips(db, { active: true })].map(([k, t]) => [k, t.reason]));

const as = (role: string, stage: string, writable: string[]) => ({
  method: "POST", path: "", params: { stage }, query: new URLSearchParams(), form: new URLSearchParams(), csrf: "", nonce: "",
  user: { login: "m1", role, canWrite: async (r: string) => writable.includes(r), canRead: async () => true },
}) as never;

test("a maintainer resumes a push breaker only with write access to its repo", async () => {
  const db = await connectDb(":memory:");
  const at = "2026-01-01T00:00:00Z";
  await trip(db, "fixup:a", "2 of the last 10 fixup pushes in a broke a required check", ["a#1@abcd1234", "a#2@ef012345"], at);
  await assert.rejects(resumeTrip(db, as("maintainer", "fixup:a", ["b"])), { status: 403 });
  await assert.rejects(resumeTrip(db, as("viewer", "fixup:a", ["a"])), { status: 403 });
  assert.ok((await activeTrips(db))["fixup:a"]);
  await resumeTrip(db, as("maintainer", "fixup:a", ["a"]));
  assert.equal((await activeTrips(db))["fixup:a"], undefined);
  assert.equal((await db.get(db.k.selectFrom("stage_trips").select("cleared_by").where("stage", "=", "fixup:a")))?.cleared_by, "m1");
  // A key that names no push stage and repo, and the outside-author surge breaker, stay with operators.
  await assert.rejects(resumeTrip(db, as("maintainer", "fixup", ["a"])), { status: 403 });
  await trip(db, "outside-surge", "41 new items", [], at);
  await assert.rejects(resumeTrip(db, as("maintainer", "outside-surge", ["a"])), { status: 403 });
  await resumeTrip(db, as("operator", "outside-surge", []));
  assert.equal((await db.get(db.k.selectFrom("stage_trips").select("active").where("stage", "=", "outside-surge")))?.active, 0);
});

test("broken pushes on one repo stop Implement there; broken pushes on two repos stop it everywhere", async () => {
  const db = await connectDb(":memory:");
  const start = Date.now() - 3_600_000;
  const t = (m: number) => new Date(start + m * 60_000).toISOString();
  const push = (repo: string, number: number, m: number, outcome = "broke") => db.run(db.k.insertInto("push_outcomes").values({
    at: t(m), stage: "implement", action: "implement-push", repo, number, from_oid: null, to_oid: `${repo}${number}`.padEnd(40, "0"), before_res: "green", after_res: outcome === "broke" ? "red" : "green", outcome, resolved_at: t(m),
  }));
  for (const repo of ["a", "b"]) {
    await db.prepare("INSERT INTO tracked_repos (name, pipeline) VALUES (?, 1)").run(repo);
    await db.run(db.k.insertInto("items").values({ repo, number: 10, kind: "issue", state: "OPEN", title: "Crash on start" }));
  }
  // Two broken pushes on a and one on b: a's own breaker stops a, and a's pushes then no longer count for every repo.
  await push("a", 1, 1);
  await push("b", 2, 2);
  await push("a", 3, 3);
  for (const repo of ["a", "b"]) await evaluatePushBreaker(db, "implement", repo, t(4));
  assert.deepEqual(Object.keys(await activeTrips(db)), ["implement:a"]);
  const why = async (repo: string) => gates((await loadItemFact(db, repo, 10))!, { kind: "implement" }, { operator: "op" }) ?? "";
  assert.match(await why("a"), /is paused/);
  assert.doesNotMatch(await why("b"), /is paused/);

  await assert.rejects(resumeTrip(db, as("maintainer", "implement:a", ["b"])), { status: 403 });
  await resumeTrip(db, as("maintainer", "implement:a", ["a"]));
  assert.doesNotMatch(await why("a"), /is paused/);
  // a's broken pushes up to its resume stay dealt with: b's alone do not stop every repo.
  await push("b", 4, 5, "kept-green");
  await evaluatePushBreaker(db, "implement", "b", t(6));
  assert.deepEqual(Object.keys(await activeTrips(db)), []);

  // A fresh broken push on a after its resume, with b's: broken pushes from two repos stop the stage on every repo.
  await push("a", 5, 61);
  await evaluatePushBreaker(db, "implement", "a", t(62));
  assert.deepEqual(Object.keys(await activeTrips(db)), ["implement"]);
  assert.match(await why("b"), /is paused/);
  await assert.rejects(resumeTrip(db, as("maintainer", "implement", ["a", "b"])), { status: 403 });
  await resumeTrip(db, as("operator", "implement", []));
  assert.doesNotMatch(await why("b"), /is paused/);
});
