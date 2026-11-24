import { test } from "node:test";
import assert from "node:assert/strict";
import { withMigrationLock } from "../src/db/pg-migrate.ts";

function fakeClient() {
  const log: string[] = [];
  return { log, query: async (text: string) => void log.push(text.split(/[ (]/)[0]!) };
}
const pgError = (code: string) => Object.assign(new Error("pg"), { code });

test("a deadlock aborts the attempt, rolls back, and the next attempt commits", async () => {
  const c = fakeClient();
  const waits: number[] = [];
  let calls = 0;
  const out = await withMigrationLock(c, async () => {
    if (++calls === 1) throw pgError("40P01");
    return "done";
  }, { sleep: async (ms) => void waits.push(ms) });
  assert.equal(out, "done");
  assert.equal(calls, 2);
  assert.equal(waits.length, 1);
  assert.ok(c.log.indexOf("ROLLBACK") !== -1 && c.log.indexOf("ROLLBACK") < c.log.lastIndexOf("COMMIT"));
  assert.ok(c.log.includes("SET"));
});

test("other errors throw at once, and retries stop after five attempts", async () => {
  const c = fakeClient();
  let calls = 0;
  await assert.rejects(withMigrationLock(c, async () => { calls++; throw pgError("42P01"); }, { sleep: async () => {} }), { code: "42P01" });
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(withMigrationLock(c, async () => { calls++; throw pgError("55P03"); }, { sleep: async () => {} }), { code: "55P03" });
  assert.equal(calls, 5);
});
