// Loaders and writers that call other modules inside their own waves and transactions, run against real modules (no fakes), so a
// statement one module builds for another's wave, or a writer one module calls inside another's transaction, fails here first.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import { testDatabase } from "../test-db.ts";
import { loadItemDetail } from "../../src/data/mirror/index.ts";
import { loadCanonicalInfo, loadItemTriage, loadRankInputs, setClassifyRun } from "../../src/data/triage/index.ts";
import { clearCooloff, loadRunnerSnapshot, loadTakerSignature } from "../../src/data/runners/index.ts";
import { recordAttempts } from "../../src/data/merge/index.ts";
import { listAudit } from "../../src/data/control/index.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const NOW = Date.parse("2026-01-02T00:00:00.000Z");

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  const t = await testDatabase("", "sqlite");
  try { await fn(await t.open({ app: true })); } finally { await t.close(); }
}

async function seed(db: Db): Promise<void> {
  const q = queryDb(db), k = q.k as any;
  await q.run(k.insertInto("tracked_repos").values({ name: "app", added_by: "t", added_at: T0, pipeline: 1 }));
  await q.run(k.insertInto("items").values([
    { repo: "app", number: 1, kind: "issue", state: "OPEN", title: "bug", body: "b", created_at: T0, comments_count: 2, embed_hash: "h1" },
    { repo: "app", number: 2, kind: "pr", state: "OPEN", title: "fix", body: "Fixes #1", created_at: T0, head_oid: "abc", author: "ann" },
  ]));
}

test("composed reads: item detail, item triage, canonical info, rank inputs and the runner snapshot run on the real modules", async () => {
  await withDb(async (db) => {
    await seed(db);
    const d = await loadItemDetail(db, "app#2", ["item", "comments", "activity", "commits", "files", "checks", "read"]);
    assert.equal(d.item?.title, "fix");
    assert.deepEqual([d.comments.length, d.checks], [0, null]);
    const t = await loadItemTriage(db, { repo: "app", number: 1 }, null);
    assert.deepEqual([t.verdicts.length, t.settled, t.dupe], [0, null, null]);
    const canon = await loadCanonicalInfo(db, [{ repo: "app", number: 1 }, { repo: "app", number: 9 }]);
    assert.equal(canon.get("app#1")?.state, "OPEN");
    assert.equal(canon.has("app#9"), false);
    const rank = await loadRankInputs(db, null);
    assert.ok(rank);
    const snap = await loadRunnerSnapshot(db, NOW, { started: async () => ({ live: [], prs: [] }), denials: async () => new Map() });
    assert.deepEqual(snap.runners, []);
    const real = await loadRunnerSnapshot(db, NOW);
    assert.deepEqual([real.runners.length, real.denied.size], [0, 0]);
    assert.equal(await loadTakerSignature(db, NOW), "");
  });
});

test("composed writes: writers that audit or record stage events through other modules commit with their own rows", async () => {
  await withDb(async (db) => {
    await seed(db);
    assert.deepEqual(await setClassifyRun(db, "run-1", "op"), { previous: null });
    assert.deepEqual(await setClassifyRun(db, "run-2", "op"), { previous: "run-1" });
    const q = queryDb(db);
    await q.run((q.k as any).insertInto("remote_cooloffs").values({ login: "ann", until: NOW + 60_000, reason: "drops" }));
    assert.equal(await clearCooloff(db, "ann", "op", NOW), true);
    await recordAttempts(db, [{ repo: "app", number: 2, head: "abc", runId: "r1", at: T0, path: "rule", method: "squash", outcome: "refused", reason: "red CI", ci: "failure", mergeable: "MERGEABLE" }]);
    const audit = await listAudit(db, { since: "2000-01-01T00:00:00.000Z" });
    assert.ok(audit.length >= 2, "the writers audited through control");
  });
});
