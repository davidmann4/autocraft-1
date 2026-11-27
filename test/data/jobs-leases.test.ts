import { test } from "node:test";
import assert from "node:assert/strict";
import { clearLeases, loadHeldLeaseKeys, releaseLeases, takeLeases } from "../../src/data/jobs/index.ts";
import { expectFlat } from "../helpers/query-count.ts";
import { both, flat, seedJobs } from "./jobs-fixture.ts";

both("takeLeases takes free keys, keys of the same job and keys of jobs that are not running, and leaves a running job's keys", async (db) => {
  const [a, b, ended] = await seedJobs(db, [{ state: "running" }, { state: "running" }, { state: "done" }]);
  assert.deepEqual([...await takeLeases(db, ["k1", "k2", "k2"], { id: ended!, step: "review" })].sort(), ["k1", "k2"]);
  assert.deepEqual([...await takeLeases(db, ["k1", "k3"], { id: a!, step: "review" })].sort(), ["k1", "k3"], "a key of an ended job is free");
  assert.deepEqual([...await takeLeases(db, ["k1", "k3", "k4"], { id: b!, step: "verify" })], ["k4"], "keys of a running job are not taken");
  assert.deepEqual([...await takeLeases(db, ["k1"], { id: a!, step: "review" })], ["k1"], "the holder takes its own key again");
  assert.deepEqual([...await loadHeldLeaseKeys(db)].sort(), ["k1", "k3", "k4"]);
  assert.equal(await releaseLeases(db, { keys: ["k1"], jobId: b! }), 0, "only the holder releases a key");
  assert.equal(await releaseLeases(db, { keys: ["k1"], jobId: a! }), 1);
  assert.equal(await releaseLeases(db, { jobIds: [b!] }), 1);
  assert.equal(await clearLeases(db), 2);
  return null;
});

test("taking leases is one statement for 2 or 12 keys", async () => {
  await expectFlat(flat(async (db, size) => {
    const [id] = await seedJobs(db, [{ state: "running" }]);
    return async () => { assert.equal((await takeLeases(db, Array.from({ length: size }, (_, i) => `k${i}`), { id: id!, step: "review" })).size, size); };
  }), 2, 12);
});
