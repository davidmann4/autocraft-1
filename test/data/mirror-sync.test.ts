// mirror module, part b (repos, sync bookkeeping, main CI): behaviour of the batched writers and flat statement counts
// (SQLite; Postgres when AUTOCRAFT_TEST_PG_URL is set).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db, Dialect } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import { derive, type MainCiState } from "../../src/mainci/classify.ts";
import type { MainHeadSummary } from "../../src/data/mirror/types.ts";
import { TEST_PG_URL, testDatabase } from "../test-db.ts";
import { expectFlat } from "../helpers/query-count.ts";
import {
  advanceOrgHighWater, advanceRepoHighWater, clearRepoFailures, finishSyncRun, hasSyncRequests, loadDecidingHeads, loadLastSyncEnd, loadLatestMainHeads, loadMainCi, loadMainCiAt, loadRepoErrors, loadRepos,
  loadSyncPlan, loadSyncRequests, loadSyncRuns, loadSyncState, markReposRead, markReposReconciled, markReposSyncedByError, purgeRepoMirror, queueSyncRequests, recordRepoFailures,
  removeSyncRequests, requestReadsAfter, saveMainHeads, saveRepoList, saveSyncState, startSyncRun, countItemsByRepo,
} from "../../src/data/mirror/index.ts";

const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-02T00:00:00Z";
const T2 = "2026-01-03T00:00:00Z";

async function withDb(dialect: Dialect, fn: (db: Db) => Promise<unknown>): Promise<unknown> {
  const t = await testDatabase("", dialect);
  try { return await fn(await t.open({ app: true })); } finally { await t.close(); }
}

/** Runs on SQLite, and on Postgres when a server is configured; the results must be equal. */
function both(name: string, fn: (db: Db) => Promise<unknown>): void {
  test(name, async () => {
    const lite = await withDb("sqlite", fn);
    if (TEST_PG_URL) assert.deepEqual(await withDb("postgres", fn), lite);
  });
}

const names = (n: number) => Array.from({ length: n }, (_, i) => `r${i + 1}`);

both("repo list upsert keeps the owner guard and clears not-found rows of written names", async (db) => {
  await saveRepoList(db, [{ name: "a", owner: "storytold", default_branch: "main" }, { name: "b", owner: "storytold" }]);
  await recordRepoFailures(db, [
    { repo: "a", kind: "not-found", message: "gone", movedTo: null, at: T0 },
    { repo: "b", kind: "transient", message: "slow", movedTo: null, at: T0 },
  ]);
  const written = await saveRepoList(db, [{ name: "a", owner: "storytold", default_branch: "trunk" }, { name: "b", owner: "someone-else" }]);
  assert.deepEqual(written, ["a"]);
  const repos = await loadRepos(db, { all: true });
  assert.equal(repos.get("a")!.default_branch, "trunk");
  assert.equal(repos.get("b")!.owner, "storytold");
  const q = queryDb(db);
  const left = await q.all(q.k.selectFrom("main.sync_repo_errors").select(["repo", "kind"]).orderBy("repo"));
  assert.deepEqual(left.map((r) => r.repo), ["b"]);
});

both("read marks move the high water forward only and mark repos with no error as synced", async (db) => {
  await saveRepoList(db, names(3).map((name) => ({ name, owner: "storytold" })));
  await markReposRead(db, [{ name: "r1", syncedAt: T0, highWater: T1 }, { name: "r2", syncedAt: T0 }]);
  await markReposRead(db, [{ name: "r1", syncedAt: T2, highWater: T0 }, { name: "r2", syncedAt: T2, highWater: T0 }]);
  await advanceRepoHighWater(db, [{ name: "r1", t: T0 }, { name: "r3", t: T1 }, { name: "r3", t: T2 }]);
  let repos = await loadRepos(db, { all: true });
  assert.equal(repos.get("r1")!.high_water, T1);
  assert.equal(repos.get("r1")!.synced_at, T2);
  assert.equal(repos.get("r2")!.high_water, T0);
  assert.equal(repos.get("r3")!.high_water, T2);

  await recordRepoFailures(db, [{ repo: "r1", kind: "error", message: "x", movedTo: null, at: T0 }]);
  await markReposSyncedByError(db, names(3), "2026-02-01T00:00:00Z");
  repos = await loadRepos(db, { all: true });
  assert.equal(repos.get("r1")!.synced_at, T2, "a repo with an error row keeps its mark");
  assert.equal(repos.get("r2")!.synced_at, "2026-02-01T00:00:00Z");
  await markReposReconciled(db, [{ name: "r2", at: T1 }]);
  assert.equal((await loadRepos(db, { names: ["r2"], all: true })).get("r2")!.reconciled_at, T1);
  const plan = await loadSyncPlan(db);
  assert.deepEqual([...plan.synced].sort(), ["r1", "r2", "r3"]);
  assert.deepEqual([...plan.broken], []);
});

both("sync state: patch writes only the named columns, the org high water moves forward only", async (db) => {
  assert.equal((await loadSyncState(db)).org_high_water, null);
  await saveSyncState(db, { full_sync_cursor: "all|a", rate_remaining: 100 });
  await saveSyncState(db, { rate_remaining: 90, author_ids_error: null });
  const s = await loadSyncState(db);
  assert.equal(s.full_sync_cursor, "all|a");
  assert.equal(s.rate_remaining, 90);
  assert.equal(await advanceOrgHighWater(db, T1), true);
  assert.equal(await advanceOrgHighWater(db, T0), false);
  assert.equal(await advanceOrgHighWater(db, T1), false);
  assert.equal(await advanceOrgHighWater(db, T2), true);
  assert.equal((await loadSyncState(db)).org_high_water, T2);
  assert.equal((await loadSyncState(db)).full_sync_cursor, "all|a");
});

both("sync runs: started rows are pruned after two days, finished rows carry their fields", async (db) => {
  const old = await startSyncRun(db, "2026-01-01T00:00:00Z");
  await finishSyncRun(db, old, { endedAt: "2026-01-01T00:01:00Z", mode: "search", items: 3 });
  const bad = await startSyncRun(db, "2026-01-05T00:00:00Z");
  await finishSyncRun(db, bad, { endedAt: "2026-01-05T00:02:00Z", error: "boom" });
  const runs = await loadSyncRuns(db, 10);
  assert.deepEqual(runs.map((r) => r.started_at), ["2026-01-05T00:00:00Z"]);
  assert.equal(await loadLastSyncEnd(db), null);
  const ok = await startSyncRun(db, "2026-01-05T01:00:00Z");
  await finishSyncRun(db, ok, { endedAt: "2026-01-05T01:01:00Z", mode: "per-repo", items: 1 });
  assert.equal(await loadLastSyncEnd(db), "2026-01-05T01:01:00Z");
});

both("sync requests: queue keeps the first unless replaced, removal skips a request that arrived later, reads after a time are asked for once", async (db) => {
  await queueSyncRequests(db, [{ repo: "a", number: 1, event: "push", requestedAt: T0 }, { repo: "a", number: 1, event: "other", requestedAt: T1 }]);
  assert.deepEqual((await loadSyncRequests(db, 10)).map((r) => [r.event, r.requested_at]), [["push", T0]]);
  await queueSyncRequests(db, [{ repo: "a", number: 1, event: "other", requestedAt: T1 }], { replace: true });
  await removeSyncRequests(db, [{ repo: "a", number: 1, requestedAt: T0 }]);
  assert.equal(await hasSyncRequests(db), true);
  await removeSyncRequests(db, [{ repo: "a", number: 1, requestedAt: T1 }]);
  assert.equal(await hasSyncRequests(db), false);

  const q = queryDb(db);
  await q.run(q.k.insertInto("main.item_reads").values([{ repo: "a", number: 2, synced_at: T1 }, { repo: "a", number: 3, synced_at: T0 }]));
  const { stale, asked } = await requestReadsAfter(db, [{ ref: "a#2", after: T0 }, { ref: "a#3", after: T1 }, { ref: "a#4", after: T0 }], T2);
  assert.deepEqual([stale.sort(), asked.sort()], [["a#3", "a#4"], ["a#3", "a#4"]]);
  assert.deepEqual((await loadSyncRequests(db, 10)).map((r) => r.number), [3, 4]);
  assert.deepEqual(await requestReadsAfter(db, [{ ref: "a#3", after: T1 }], T2), { stale: ["a#3"], asked: [] });
  assert.equal((await loadSyncRequests(db, 10)).length, 2, "a ref with a request is not queued again");
});

both("repo failures keep `since` while the kind is unchanged; tracked repos only are listed; clearing honours kind and time", async (db) => {
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.tracked_repos").values([{ name: "a" }, { name: "b" }]));
  await recordRepoFailures(db, [{ repo: "a", kind: "transient", message: "m1", movedTo: null, at: T0 }, { repo: "b", kind: "error", message: "m1", movedTo: null, at: T0 }, { repo: "c", kind: "error", message: "m1", movedTo: null, at: T0 }]);
  await recordRepoFailures(db, [{ repo: "a", kind: "transient", message: "m2", movedTo: null, at: T1 }, { repo: "b", kind: "forbidden", message: "m2", movedTo: null, at: T1 }]);
  const errs = await loadRepoErrors(db);
  assert.deepEqual(errs.map((e) => [e.repo, e.kind, e.since, e.at]), [["a", "transient", T0, T1], ["b", "forbidden", T1, T1]]);
  await clearRepoFailures(db, ["a", "b"], { kinds: ["transient", "error"], before: T2 });
  assert.deepEqual((await loadRepoErrors(db)).map((e) => e.repo), ["b"]);
  await clearRepoFailures(db, ["b"]);
  assert.equal((await loadRepoErrors(db)).length, 0);
});

both("purge deletes the repo's comments and items and resets its marks", async (db) => {
  const q = queryDb(db);
  await saveRepoList(db, [{ name: "a", owner: "storytold" }]);
  await markReposRead(db, [{ name: "a", syncedAt: T0, highWater: T0 }]);
  await q.run(q.k.insertInto("main.items").values([{ repo: "a", number: 1, kind: "pr", state: "OPEN" }, { repo: "a", number: 2, kind: "issue", state: "OPEN" }, { repo: "b", number: 1, kind: "pr", state: "OPEN" }]));
  await q.run(q.k.insertInto("main.comments").values({ repo: "a", number: 1, id: "c1", kind: "comment" }));
  assert.deepEqual([...await countItemsByRepo(db)].sort(), [["a", 2], ["b", 1]]);
  assert.deepEqual(await purgeRepoMirror(db, "a"), { comments: 1, items: 2 });
  const r = (await loadRepos(db, { all: true })).get("a")!;
  assert.equal(r.synced_at, null);
  assert.equal(r.high_water, null);
  assert.deepEqual([...await countItemsByRepo(db)], [["b", 1]]);
});

const head = (repo: string, sha: string, state: string, at: string) => ({ repo, sha, branch: "main", state, failing: "[]", checks: "[]", committed_at: at, headline: sha });

both("main CI: the deciding heads say the same as every stored head", async (db) => {
  const q = queryDb(db);
  const histories = ["r", "g", "gr", "rgrr", "grgyrr", "grrg", "ygrryr", "rr", "grry", "y"];
  await q.run(q.k.insertInto("main.tracked_repos").values(histories.map((name) => ({ name }))));
  const STATES: Record<string, string> = { r: "red", g: "green", y: "running" };
  for (const h of histories) {
    // Two heads of one time are ordered by when they were first seen, then by sha; a head without a commit time counts from when it was seen.
    await q.run(q.k.insertInto("main.main_ci").values([...h].map((c, i) => ({
      repo: h, head_sha: `s${i}`, branch: "main", state: STATES[c]!, failing: "[]", checks: "[]", headline: `#${i}`, committed_at: i % 3 === 2 ? null : `2026-01-0${1 + Math.floor(i / 2)}T00:00:00Z`,
      first_seen_at: `2026-01-0${1 + Math.floor(i / 2)}T00:00:00Z`, state_changed_at: `c${i}`, updated_at: T0,
    }))));
  }
  const of = (rows: MainHeadSummary[]) => derive(rows.map((x) => ({ sha: x.head_sha, state: x.state as MainCiState, committedAt: x.committed_at, headline: x.headline, firstSeenAt: x.first_seen_at, stateChangedAt: x.state_changed_at })));
  const all = await loadMainCi(db), few = await loadDecidingHeads(db, ["y"]);
  for (const h of histories.slice(0, -1)) {
    assert.deepEqual(of(few.get(h)!), of(all.get(h)!), h);
    assert.ok(few.get(h)!.length <= 3);
  }
  assert.equal(few.has("y"), false);
});

both("main CI: state change time moves only with the state, and only the newest 50 heads of a repo stay", async (db) => {
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.tracked_repos").values([{ name: "a" }, { name: "b" }]));
  const states = await saveMainHeads(db, [head("a", "s1", "green", T0), head("b", "s1", "red", T0)], T0);
  assert.equal(states.get("a@s1"), "green");
  await saveMainHeads(db, [head("a", "s1", "green", T0), head("b", "s1", "green", T0)], T1);
  const at = await loadMainCiAt(db, [{ repo: "a", sha: "s1" }, { repo: "b", sha: "s1" }, { repo: "b", sha: "none" }]);
  assert.equal(at.get("a@s1")!.state_changed_at, T0);
  assert.equal(at.get("a@s1")!.updated_at, T1);
  assert.equal(at.get("b@s1")!.state_changed_at, T1);
  assert.equal(at.size, 2);

  const many = Array.from({ length: 55 }, (_, i) => head("a", `m${String(i).padStart(2, "0")}`, "green", `2026-02-${String(1 + (i % 28)).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00Z`));
  await saveMainHeads(db, many, T2);
  const kept = (await loadMainCi(db)).get("a")!;
  assert.equal(kept.length, 50);
  assert.equal((await loadMainCi(db)).get("b")!.length, 1, "other repos are not pruned");
  assert.ok(!("checks" in kept[0]!), "a summary carries no check list");
  const latest = await loadLatestMainHeads(db, ["b"]);
  assert.equal(latest.get("b")!.head_sha, "s1");
  assert.equal(latest.has("a"), false);
});

// ---- statement counts -----------------------------------------------------------------------------------------------

async function flat(name: string, run: (db: Db, size: number) => Promise<unknown>, prepare: (db: Db, size: number) => Promise<void> = async () => {}): Promise<void> {
  test(`${name}: statements do not grow with the number of repos`, async () => {
    await expectFlat(async (size) => {
      const t = await testDatabase("", "sqlite");
      const db = await t.open({ app: true });
      await prepare(db, size);
      return { db, run: () => run(db, size), close: () => t.close() };
    }, 2, 12);
  });
}

const repoRows = (size: number) => names(size).map((name) => ({ name, owner: "storytold" }));

await flat("repo list and marks", async (db, size) => {
  await saveRepoList(db, repoRows(size));
  await markReposRead(db, names(size).map((name) => ({ name, syncedAt: T0, highWater: T1 })));
  await advanceRepoHighWater(db, names(size).map((name) => ({ name, t: T2 })));
  await markReposReconciled(db, names(size).map((name) => ({ name, at: T1 })));
  await markReposSyncedByError(db, names(size), T2);
  await recordRepoFailures(db, names(size).map((repo) => ({ repo, kind: "error", message: "x", movedTo: null, at: T0 })));
  await clearRepoFailures(db, names(size), { kinds: ["error"] });
  await loadSyncPlan(db);
  await loadRepos(db, { names: names(size), all: true });
});

await flat("main heads", async (db, size) => {
  await saveMainHeads(db, names(size).map((r) => head(r, "s1", "green", T0)), T0);
  await loadMainCiAt(db, names(size).map((repo) => ({ repo, sha: "s1" })));
  await loadLatestMainHeads(db, names(size));
}, async (db, size) => { const q = queryDb(db); await q.run(q.k.insertInto("main.tracked_repos").values(names(size).map((name) => ({ name })))); });

await flat("read requests", async (db, size) => {
  await requestReadsAfter(db, names(size).map((r) => ({ ref: `${r}#1`, after: T1 })), T2);
  await queueSyncRequests(db, names(size).map((repo) => ({ repo, number: 2, event: "push", requestedAt: T0 })));
  await removeSyncRequests(db, names(size).map((repo) => ({ repo, number: 2, requestedAt: T0 })));
});
