// Build module: the `build_state` rows, repository sizes and the warm gates. Query counts must not grow with the number of repos.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import {
  AUTO_MIN_BUILDS, clearWorkerUpdate, loadBusyLocalTasks, loadSizings, loadTrimmedPublish, loadWarmBytes, loadWarmFacts, loadWarmReport, loadWorkerUpdate,
  recordTrimmedPublish, releaseWarmGc, saveWarmBytes, saveWarmReport, saveWorkerUpdate, setSizes, takeWarmGc, warmClaimGate, warmGate, WARM_GC_EVERY_MS, WARM_GC_RETRY_MS,
} from "../../src/data/build/index.ts";
import { expectFlat } from "../helpers/query-count.ts";
import { testDatabase } from "../test-db.ts";
import { both } from "./planner-helpers.ts";

const AT = "2026-01-01T00:00:00.000Z";
const SPEC = { sha: "a".repeat(40), ssh: "w@host", keyFile: "/k", gitDir: "/g" };

async function fresh(): Promise<{ db: Db; close: () => Promise<void> }> {
  const t = await testDatabase("", "sqlite");
  return { db: await t.open({ app: true }), close: () => t.close() };
}

async function seedEnv(db: Db, id = "kube", kind = "kubernetes", settings: object = {}): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.build_envs").values({ id, label: id, kind, slots: 1, key_hash: "x", created_at: AT, settings: JSON.stringify(settings) }));
}

async function seedTask(db: Db, t: { repo: string; step?: string; state?: string; head?: string; env?: string; claimed?: string | null; results?: string; endedAt?: string | null; rev?: number | null; version?: string | null }): Promise<number> {
  const q = queryDb(db);
  const r = await q.get(q.k.insertInto("main.build_tasks").values({
    step: t.step ?? "warm", repo: t.repo, head_sha: t.head ?? "h1", requires: "{}", plan: JSON.stringify([{ name: "build" }]), state: t.state ?? "done", queued_at: AT,
    claimed_at: t.claimed ?? null, ended_at: t.endedAt ?? new Date().toISOString(), results: t.results ?? "[]", env_id: t.env ?? "kube", warm_rev: t.rev ?? null, warm_version: t.version ?? null,
  }).returning("id"));
  return Number(r!.id);
}

const seedHead = async (db: Db, repo: string, sha = "h1"): Promise<void> => {
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.main_ci").values({ repo, head_sha: sha, branch: "main", state: "success", failing: "[]", checks: "[]", first_seen_at: AT, state_changed_at: AT, updated_at: AT }));
};

both("the warm gc lock is taken once a day, a corrupt value counts as due, and a release makes it due after the retry delay", async ({ db }) => {
  const q = queryDb(db);
  const now = Date.parse(AT);
  assert.equal(await takeWarmGc(db, now), true);
  assert.equal(await takeWarmGc(db, now + 60_000), false);
  assert.equal(await takeWarmGc(db, now + WARM_GC_EVERY_MS), true);
  await releaseWarmGc(db, now + WARM_GC_EVERY_MS);
  assert.equal(await takeWarmGc(db, now + WARM_GC_EVERY_MS + WARM_GC_RETRY_MS - 1000), false);
  assert.equal(await takeWarmGc(db, now + WARM_GC_EVERY_MS + WARM_GC_RETRY_MS + 1000), true);
  await q.run(q.k.updateTable("main.build_state").set({ value: "garbage" }).where("key", "=", "warm_gc_at"));
  assert.equal(await takeWarmGc(db, now), true);
});

both("worker update fields are set, left alone or removed independently; the report, bytes and trimmed publish round-trip", async ({ db }) => {
  await saveWorkerUpdate(db, { pending: SPEC, failures: { count: 2, error: "x" } });
  assert.deepEqual(await loadWorkerUpdate(db), { pending: SPEC, failures: { count: 2, error: "x" } });
  await saveWorkerUpdate(db, { failures: null });
  assert.deepEqual(await loadWorkerUpdate(db), { pending: SPEC, failures: null });
  await clearWorkerUpdate(db);
  assert.deepEqual(await loadWorkerUpdate(db), { pending: null, failures: null });
  const report = { version: 1 as const, readAt: 5, nodes: [], placement: null, placementNote: null, mirror: null };
  assert.equal(await loadWarmReport(db), null);
  await saveWarmReport(db, JSON.stringify(report));
  assert.deepEqual(await loadWarmReport(db), report);
  await saveWarmBytes(db, [{ key: "a", bytes: 5 }, { key: "a", bytes: 7 }, { key: "b", bytes: -1 }]);
  assert.deepEqual([...(await loadWarmBytes(db, ["a", "b", "c"]))], [["a", 7]]);
  assert.equal(await loadTrimmedPublish(db), null);
  await recordTrimmedPublish(db, "o/a", Date.parse(AT));
  await recordTrimmedPublish(db, "o/b", Date.parse(AT) + 1000);
  assert.deepEqual(await loadTrimmedPublish(db), { repo: "o/a", at: AT });
  assert.equal(await loadBusyLocalTasks(db), 0);
});

both("loadSizings takes the history of measured default-branch builds, and an operator's row wins over it", async ({ db }) => {
  await seedEnv(db);
  const q = queryDb(db);
  const ok = JSON.stringify([{ step: "build", exitCode: 0, peakMemBytes: 3 * 1024 ** 3 }]);
  for (let i = 0; i < AUTO_MIN_BUILDS; i++) await seedTask(db, { repo: "o/a", results: ok, head: `h${i}` });
  await seedTask(db, { repo: "o/b", results: ok });
  const sizings = await loadSizings(db, ["o/a", "o/b", "o/c"]);
  assert.equal(sizings.get("o/a")!.memorySource, "history");
  assert.ok(sizings.get("o/a")!.memory!.limitBytes > sizings.get("o/a")!.memory!.requestBytes);
  assert.equal(sizings.get("o/b")!.memorySource, "environment", "below the minimum of measured builds");
  assert.equal(sizings.get("o/c")!.warmTarget, "none");
  await q.run(q.k.insertInto("main.build_sizes").values({ repo: "o/a", memory_request_bytes: 1, memory_limit_bytes: 2, updated_at: AT, reason: "r", memory_source: "operator", warm_target: "pvc" }));
  const again = await loadSizings(db, "all");
  assert.deepEqual([...again.keys()], ["o/a"]);
  assert.equal(again.get("o/a")!.memorySource, "operator");
  assert.equal(again.get("o/a")!.warmSource, "operator");
  assert.ok(again.get("o/a")!.history, "the history stays visible under an operator's size");
});

test("loadSizings: statements do not grow with the number of repos", async () => {
  await expectFlat(async (n) => {
    const { db, close } = await fresh();
    await seedEnv(db);
    for (let i = 0; i < n; i++) await seedTask(db, { repo: `o/r${i}`, results: "[]" });
    return { db, close, run: () => loadSizings(db, Array.from({ length: n }, (_, i) => `o/r${i}`)) };
  }, 2, 12);
});

test("setSizes: tidy removes rows left automatic, reset and clear report what they changed", async () => {
  const { db, close } = await fresh();
  try {
    const q = queryDb(db);
    await setSizes(db, [{ repo: "o/a", memory: { requestBytes: 10, limitBytes: 20 } }, { repo: "o/b", warmTarget: "pvc" }, { repo: "o/c", memory: { requestBytes: 5, limitBytes: 6 }, memorySource: "oom" }], "me");
    const rows = (await q.all(q.k.selectFrom("main.build_sizes").select(["repo", "memory_source", "warm_target"]).orderBy("repo"))).map((r) => `${r.repo}:${r.memory_source}:${r.warm_target}`);
    assert.deepEqual(rows, ["o/a:operator:auto", "o/b:auto:pvc", "o/c:oom:auto"]);
    const out = await setSizes(db, [{ repo: "o/a", reset: true }, { repo: "o/b", warmTarget: null }, { repo: "o/z", clear: true }, { repo: "o/c", clear: true }], "me");
    assert.deepEqual([...out].sort(), [["o/a", true], ["o/b", true], ["o/c", true], ["o/z", false]]);
    assert.equal((await q.all(q.k.selectFrom("main.build_sizes").select("repo"))).length, 0, "rows with nothing set are gone");
  } finally { await close(); }
});

both("warm gates: a built head is skipped unless forced, an open task blocks, and the claim waits for the interval and a running build", async ({ db }) => {
  await seedEnv(db);
  const o = { version: "v2", rev: 2, image: "img" };
  await seedHead(db, "o/a");
  await seedHead(db, "o/b");
  await seedHead(db, "o/c");
  await seedTask(db, { repo: "o/a", state: "done", rev: 2, head: "h1" });
  await seedTask(db, { repo: "o/b", state: "done", rev: 1, head: "h1" });
  await seedTask(db, { repo: "o/c", state: "running", head: "h1", claimed: new Date(Date.parse(AT) + 60_000).toISOString() });
  const f = await loadWarmFacts(db, ["o/a", "o/b", "o/c", "o/none"], o);
  const now = Date.parse(AT) + 120_000;
  assert.equal(warmGate(f.get("o/a")!, now), "skip");
  assert.equal(warmGate(f.get("o/a")!, now, true), "queue");
  assert.equal(warmGate(f.get("o/b")!, now), "queue", "a build under an older producer revision does not count");
  assert.equal(warmGate(f.get("o/c")!, now), "skip", "an open task blocks");
  assert.equal(warmGate(f.get("o/none")!, now), "skip", "no head");
  assert.equal(warmClaimGate(f.get("o/c")!, now, 99), "wait");
  assert.equal(warmClaimGate(f.get("o/b")!, now, 99, 10 * 60_000), "claim");
  assert.equal(warmClaimGate({ ...f.get("o/b")!, newestClaimedAt: new Date(now - 60_000).toISOString() }, now, 99), "wait", "claimed under the interval ago");
  assert.equal(warmClaimGate({ ...f.get("o/a")!, forcedTask: 99 }, now, 99), "claim", "the forced task passes");
});

test("loadWarmFacts: statements do not grow with the number of repos", async () => {
  await expectFlat(async (n) => {
    const { db, close } = await fresh();
    await seedEnv(db);
    const repos = Array.from({ length: n }, (_, i) => `o/r${i}`);
    for (const r of repos) { await seedHead(db, r); await seedTask(db, { repo: r, state: "done", rev: 2 }); }
    return { db, close, run: () => loadWarmFacts(db, repos, { version: "v", rev: 2, image: "i" }) };
  }, 2, 12);
});
