// Statement counts of the Task Runner snapshot and the reads built on it (hot spot 4): they must not grow with the number of runners.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db, Dialect } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import { hasFreshRunners, loadHelpers, loadRunnerBoard, loadRunnerHealth, loadRunnerSnapshot, loadTakerSignature, loadUserSettings, noteDrops } from "../../src/data/runners/index.ts";
import { expectFlat } from "../helpers/query-count.ts";
import { dialects, fakeDeps as deps, NOW, openApp, seedCall, seedRunners } from "./runners-helpers.ts";

const unit = (dialect: Dialect, run: (db: Db, n: number) => Promise<unknown>) => async (n: number) => {
  const o = await openApp(dialect);
  const ids = await seedRunners(o.db, n);
  await seedCall(o.db, { state: "leased", tokenId: ids[0], userLogin: "u0" });
  await seedCall(o.db, { state: "queued" });
  return { db: o.db, close: () => o.t.close(), run: () => run(o.db, n) };
};

for (const dialect of dialects()) {
  test(`runner snapshot: statements do not grow with the number of runners (${dialect})`, async () => {
    const { large } = await expectFlat(unit(dialect, async (db, n) => {
      const s = await loadRunnerSnapshot(db, NOW, deps);
      assert.equal(s.runners.length, n);
      assert.equal(s.runners[0]!.leased, 1);
      assert.equal(s.leasedByLogin.get("u0")?.leased, 1);
      assert.ok(s.denied.has("u0\norg/a"));
      assert.equal(s.started.live[0]!.started_by, "u0");
    }), 1, 4);
    assert.ok(large.statements > 0);
  });

  test(`taker signature: statements do not grow with the number of runners (${dialect})`, async () => {
    await expectFlat(unit(dialect, async (db, n) => {
      const sig = await loadTakerSignature(db, NOW, deps);
      assert.equal(sig.split("|")[0]!.split(";").length, n);
      assert.match(sig, /2026-06-01T11:59:00/);
      const other = { ...deps, denials: async () => new Map([["not-a-taker\norg/a", { checkedAt: "2026-06-01T11:58:00.000Z" }]]) };
      assert.doesNotMatch(await loadTakerSignature(db, NOW, other), /11:58:00/, "a denial of a login that takes nothing now does not change it");
    }), 1, 4);
  });

  test(`runner health, board, helpers and settings reads: statements do not grow with runners (${dialect})`, async () => {
    await expectFlat(unit(dialect, async (db, n) => {
      const logins = Array.from({ length: n }, (_, i) => `u${i}`);
      const th = { queuedMs: 1000, tierWaitMs: { top: 1000, mid: 1000, small: 1000 }, interactiveWaitMs: 1000, callerStaleMs: 600_000, noTakerMs: 1000 };
      const [health, board, helpers, fresh, settings] = await Promise.all([
        loadRunnerHealth(db, NOW, th), loadRunnerBoard(db, NOW, 3600_000), loadHelpers(db, logins, NOW), hasFreshRunners(db, logins, NOW), loadUserSettings(db, logins),
      ]);
      assert.equal(health.ready, n);
      assert.equal(health.queued.total, 1);
      assert.equal(health.operatorRunners.length, n);
      assert.equal(board.helpers.length, n);
      assert.equal(helpers.size, n);
      assert.equal(fresh.size, n);
      assert.equal(settings.size, n);
    }), 1, 4);
  });

  test(`noteDrops: statements do not grow with the number of drops (${dialect})`, async () => {
    await expectFlat(unit(dialect, async (db, n) => {
      const drops = Array.from({ length: n }, (_, i) => ({ tokenId: i + 1, login: `u${i}`, callId: i + 1 }));
      assert.deepEqual(await noteDrops(db, drops, NOW), []);
      const q = queryDb(db);
      assert.equal((await q.all(q.k.selectFrom("main.remote_lease_drops").select("token_id"))).length, n);
    }), 1, 4);
  });
}
