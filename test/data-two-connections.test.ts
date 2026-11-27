// The Task Runner claim race on Postgres: two handles, each with a pool of its own as two processes have, lease through the runners module at the same time.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../src/db/index.ts";
import { queryDb } from "../src/db/query-db.ts";
import { leaseCall } from "../src/data/runners/calls-lease.ts";
import { loadLeaseSource } from "../src/data/runners/calls-claim.ts";
import type { Lease } from "../src/data/runners/types.ts";
import { packPrompt } from "../src/data/inference/types.ts";
import { seedCall, seedRunners } from "./data/runners-helpers.ts";
import { needsPg, testDatabase, type TestDatabase } from "./test-db.ts";

const NOW = Date.parse("2026-06-01T12:00:00.000Z");

const leased = (r: Lease | "limit" | "gone" | null): r is Lease => typeof r === "object" && r !== null;

async function claim(db: Db, id: number, caller: { tokenId: number; login: string }, perLogin: number | null = null): Promise<Lease | "limit" | "gone" | null> {
  return await leaseCall(db, {
    id, caller: { ...caller, role: "operator" }, claim: { harness: "claude", harnessVersion: "1" }, model: "m", now: NOW, caps: { perLogin, interactive: null }, started: false,
    clearIdle: false, source: (await loadLeaseSource(db, id))!, prompt: packPrompt("p", (x) => x), rewrite: null, live: () => true,
  });
}

/** Waits until `n` sessions of this database wait for a lock. */
async function waitForWaiters(db: Db, n: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const r = (await queryDb(db).prepare("SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'").get()) as { n: number };
    if (Number(r.n) >= n) return;
    if (Date.now() > deadline) throw new Error(`${r.n} of ${n} sessions wait for a lock after 20 s`);
    await new Promise((f) => setTimeout(f, 20));
  }
}

async function opened(fn: (t: TestDatabase, a: Db, b: Db, runners: { tokenId: number; login: string }[]) => Promise<void>): Promise<void> {
  const t = await testDatabase("", "postgres");
  try {
    const [a, b] = [await t.open({ app: true }), await t.open({ app: true })];
    const ids = await seedRunners(a, 2);
    await fn(t, a, b, ids.map((tokenId, i) => ({ tokenId, login: `u${i}` })));
  } finally {
    await t.close();
  }
}

test("two connections leasing one queued call at the same time: exactly one gets it, and the other's run is rolled back", { skip: needsPg }, async () => {
  await opened(async (t, a, b, [one, two]) => {
    const id = await seedCall(a);
    // A third connection holds the call's row until both updates wait for it, so neither sees the other's result first.
    const holder = await t.open();
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let holding!: () => void;
    const held = new Promise<void>((r) => (holding = r));
    const hold = holder.write(async () => {
      const q = queryDb(holder);
      await q.run(q.k.updateTable("main.remote_calls").set({ seen_at: NOW }).where("id", "=", id));
      holding();
      await released;
    });
    await held;
    const claims = Promise.all([claim(a, id, one!), claim(b, id, two!)]);
    try {
      await waitForWaiters(await t.open(), 2);
    } finally {
      release();
      await hold;
    }
    const results = await claims;
    assert.equal(results.filter(leased).length, 1, "one lease");
    assert.equal(results.filter((r) => r === null).length, 1, "the other claim found the call taken");
    const q = queryDb(a);
    const row = (await q.get(q.k.selectFrom("main.remote_calls").select(["state", "user_login", "run_id"]).where("id", "=", id)))!;
    const win = results.findIndex(leased);
    assert.deepEqual([row.state, row.user_login, Number(row.run_id)], ["leased", `u${win}`, (results[win] as Lease).runId]);
    assert.deepEqual((await q.all(q.k.selectFrom("main.agent_runs").select("id"))).map((r) => Number(r.id)), [(results[win] as Lease).runId]);
  });
});

test("two connections leasing two calls for one login with one slot left: one lease, the other is at the limit", { skip: needsPg }, async () => {
  await opened(async (_t, a, b, [one]) => {
    const ids = [await seedCall(a), await seedCall(a)];
    const results = await Promise.all([claim(a, ids[0]!, one!, 1), claim(b, ids[1]!, one!, 1)]);
    assert.equal(results.filter(leased).length, 1);
    assert.equal(results.filter((r) => r === "limit").length, 1);
  });
});
