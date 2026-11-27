// mirror module, part b (activity, authors, releases, branches): behaviour of the batched writers and flat statement counts
// (SQLite; Postgres when AUTOCRAFT_TEST_PG_URL is set).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db, Dialect } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import { TEST_PG_URL, testDatabase } from "../test-db.ts";
import { expectFlat } from "../helpers/query-count.ts";
import {
  bindAuthorIds, bindKnownAuthorIds, countItemEvents, foldDeltas, listActivityDue, loadActivity, loadActivityStats, loadAuthorHistory, loadAuthorIds, loadAuthorPermissions, loadCommits,
  loadDownloadsReport, loadFiles, loadLongLivedBranches, loadMergedClosures, loadReleaseState, loadUnboundLoginPrs, saveActivity, saveAuthorPermissions, saveReleaseReadings,
  type ActivityRead, type ReleaseReading,
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

const prs = (n: number) => Array.from({ length: n }, (_, i) => ({ repo: "app", number: i + 1 }));

async function seedItems(db: Db, rows: Record<string, unknown>[]): Promise<void> {
  const q = queryDb(db);
  await q.run((q.k as any).insertInto("main.items").values(rows.map((r) => ({ kind: "pr", state: "OPEN", ...r }))));
}

const read = (n: number, head = "h1", files = 2): ActivityRead => ({
  repo: "app", number: n, head, updatedAt: T0, readAt: T1,
  events: [{ id: `e${n}a`, kind: "labeled", at: T0, actor: "bob", label: "bug", before_oid: null, after_oid: null }, { id: `e${n}b`, kind: "force-push", at: T1, actor: "bob", label: null, before_oid: "x", after_oid: "y" }],
  pr: {
    head,
    files: Array.from({ length: files }, (_, i) => ({ path: `f${i}.ts`, additions: 1, deletions: 2, change_type: "MODIFIED" })),
    commits: [{ oid: `c${n}`, committed_at: T0, author: "bob", message: "msg", co_authors: null }],
  },
});

both("activity: a read replaces the PR's files, keeps stored commit text when the new read has none, and marks the item read", async (db) => {
  await seedItems(db, [{ repo: "app", number: 1, head_oid: "h1", updated_at: T0 }]);
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.tracked_repos").values({ name: "app" }));
  assert.deepEqual((await listActivityDue(db, { since: "2025-01-01T00:00:00Z", now: T1, limit: 10 })).map((r) => r.number), [1]);
  await saveActivity(db, { reads: [read(1, "h1", 3)], attempts: [] });
  assert.equal((await loadFiles(db, prs(1))).get("app#1")!.length, 3);
  assert.deepEqual((await loadActivity(db, prs(1))).get("app#1")!.map((e) => e.id), ["e1a", "e1b"]);
  assert.deepEqual((await loadActivity(db, prs(1), { kinds: ["force-push"] })).get("app#1")!.map((e) => e.id), ["e1b"]);
  assert.equal((await listActivityDue(db, { since: "2025-01-01T00:00:00Z", now: T1, limit: 10 })).length, 0, "the read item is not due");

  const again = read(1, "h1", 1);
  again.pr!.commits = [{ oid: "c1", committed_at: T1, author: "bob", message: null, co_authors: null }];
  await saveActivity(db, { reads: [again], attempts: [] });
  assert.equal((await loadFiles(db, prs(1))).get("app#1")!.length, 1);
  assert.equal((await loadCommits(db, prs(1))).get("app#1")![0]!.message, "msg");
  const stats = (await loadActivityStats(db, prs(1))).get("app#1")!;
  assert.equal(stats.events, 2);
  assert.equal(stats.commits, 1);
  assert.equal(stats.files, 1);
  assert.equal(stats.lines, 3);
  assert.equal(stats.readAt, null);

  await saveActivity(db, { reads: [], attempts: [{ repo: "app", number: 1, head: "h1", updatedAt: T0, at: T1, error: "boom", retryAt: "2026-01-02T01:00:00Z" }] });
  assert.equal((await listActivityDue(db, { since: "2025-01-01T00:00:00Z", now: T1, limit: 10 })).length, 0);
  assert.equal((await listActivityDue(db, { since: "2025-01-01T00:00:00Z", now: "2026-01-02T02:00:00Z", limit: 10 })).length, 1, "a failed read is due once its retry time passed");
});

both("author ids: known logins bind from their oldest item unless a row has no id; unbound logins list their oldest finished PR", async (db) => {
  await seedItems(db, [
    { repo: "app", number: 1, author: "ann", author_id: 11, created_at: T0, state: "MERGED" },
    { repo: "app", number: 2, author: "ann", author_id: 99, created_at: T1, state: "MERGED" },
    { repo: "app", number: 3, author: "ben", author_id: 22, created_at: T0, state: "CLOSED" },
    { repo: "app", number: 4, author: "ben", author_id: null, created_at: T1, state: "CLOSED" },
    { repo: "app", number: 5, author: "cat", author_id: 33, created_at: T0, state: "OPEN" },
    { repo: "app", number: 6, author: "dan", author_id: null, created_at: T1, state: "MERGED" },
    { repo: "lib", number: 7, author: "dan", author_id: null, created_at: T0, state: "CLOSED" },
  ]);
  assert.equal(await bindKnownAuthorIds(db), 2);
  assert.equal(await bindKnownAuthorIds(db), 0);
  assert.deepEqual([...(await loadAuthorIds(db, ["ann", "ben", "cat", "zed"]))].sort(), [["ann", 11], ["cat", 33]]);
  assert.deepEqual(await loadUnboundLoginPrs(db), [{ login: "ben", repo: "app", number: 3 }, { login: "dan", repo: "lib", number: 7 }]);
  assert.equal(await bindAuthorIds(db, [{ login: "ben", id: 22 }, { login: "ann", id: 1 }, { login: "ben", id: 5 }]), 1);
  assert.equal((await loadAuthorIds(db, "all")).get("ann"), 11);
  assert.deepEqual((await loadUnboundLoginPrs(db, ["dan"])).map((r) => r.login), ["dan"]);
});

both("author history counts per account over every repo and lists only logins with a PR in the asked repo", async (db) => {
  await seedItems(db, [
    { repo: "app", number: 1, author: "ann", author_id: 11, state: "MERGED", merged_at: T1 },
    { repo: "lib", number: 2, author: "ann", author_id: 11, state: "CLOSED" },
    { repo: "lib", number: 3, author: "ann", author_id: 12, state: "MERGED", merged_at: T0 },
    { repo: "lib", number: 4, author: "ben", author_id: null, state: "OPEN" },
    { repo: "lib", number: 5, author: "ben", kind: "issue" },
  ]);
  const all = await loadAuthorHistory(db, {});
  assert.deepEqual(all.map((h) => [h.login, h.author_id, h.merged, h.closed, h.open]), [["ann", 11, 1, 1, 0], ["ann", 12, 1, 0, 0], ["ben", null, 0, 0, 1]]);
  assert.equal(all[0]!.lastMerge, T1);
  assert.deepEqual(all[0]!.repos, ["app", "lib"]);
  const inApp = await loadAuthorHistory(db, { repo: "app" });
  assert.deepEqual(inApp.map((h) => [h.login, h.author_id, h.closed, h.repos]), [["ann", 11, 1, ["app"]]]);
});

both("author permissions: a success clears the failures, failures count up and keep the first time", async (db) => {
  await saveAuthorPermissions(db, [{ login: "Ann", repo: "app", authorId: 11, at: T0, permission: null }]);
  await saveAuthorPermissions(db, [{ login: "Ann", repo: "app", authorId: 11, at: T1, permission: null }, { login: "ben", repo: "app", authorId: 22, at: T1, permission: "write" }]);
  let p = await loadAuthorPermissions(db, { repos: ["app"] });
  assert.equal(p.get("app\nAnn")!.failures, 2);
  assert.equal(p.get("app\nAnn")!.first_failure_at, T0);
  assert.equal(p.get("app\nben")!.permission, "write");
  await saveAuthorPermissions(db, [{ login: "Ann", repo: "app", authorId: 11, at: T2, permission: "admin" }]);
  p = await loadAuthorPermissions(db, { logins: ["Ann"] });
  assert.deepEqual([p.size, p.get("app\nAnn")!.failures, p.get("app\nAnn")!.first_failure_at, p.get("app\nAnn")!.permission], [1, 0, null, "admin"]);
});

both("branches: default branch, every PR base and shared same-repo heads; merged closures name the lowest PR", async (db) => {
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.repos").values([{ name: "app", owner: "storytold", default_branch: "main" }, { name: "lib", owner: "acme", default_branch: "dev" }]));
  await seedItems(db, [
    { repo: "app", number: 1, base_ref: "rel-1", head_ref: "topic", head_repo: "storytold/app", author_association: "MEMBER" },
    { repo: "app", number: 2, base_ref: "main", head_ref: "topic", head_repo: "Storytold/App", author_association: "OWNER" },
    { repo: "app", number: 3, base_ref: "main", head_ref: "solo", head_repo: "storytold/app", author_association: "MEMBER" },
    { repo: "app", number: 4, base_ref: "main", head_ref: "fork", head_repo: "x/app", author_association: "MEMBER" },
    { repo: "app", number: 5, base_ref: "main", head_ref: "fork", head_repo: "x/app", author_association: "MEMBER" },
    { repo: "lib", number: 1, base_ref: "dev", head_ref: "same", head_repo: "acme/lib", author_association: "MEMBER" },
    { repo: "lib", number: 2, base_ref: "dev", head_ref: "same", head_repo: "acme/lib", author_association: "MEMBER" },
    { repo: "app", number: 10, state: "MERGED", closing_issues: "[20,21]" },
    { repo: "app", number: 11, state: "MERGED", closing_issues: "[20]" },
    { repo: "app", number: 12, state: "OPEN", closing_issues: "[22]" },
    { repo: "app", number: 13, state: "MERGED", closing_issues: "not json" },
  ]);
  const b = await loadLongLivedBranches(db);
  assert.deepEqual([...b.get("app")!].sort(), ["main", "rel-1", "topic"]);
  assert.deepEqual([...b.get("lib")!].sort(), ["dev", "same"]);
  assert.deepEqual([...(await loadLongLivedBranches(db, ["lib"])).keys()], ["lib"]);
  const c = await loadMergedClosures(db, ["app"]);
  assert.deepEqual([...c].sort(), [["app#20", "app#10"], ["app#21", "app#10"]]);
});

const reading = (repo: string, ids: number[], o: { delta?: number; gone?: number[]; app?: ReleaseReading["app"]; downloads?: number } = {}): ReleaseReading => ({
  repo, gone: o.gone ?? [], app: o.app === undefined ? { name: repo.toUpperCase(), stars: 5 } : o.app,
  assets: ids.map((asset_id) => ({ asset_id, repo, release_id: 1, tag: "v1", release_name: null, published_at: T0, prerelease: 0, name: `a${asset_id}.zip`, platform: "win", processor: "x64", format: "zip", downloads: o.downloads ?? 10, delta: o.delta ?? 0 })),
});

both("releases: readings upsert assets, add increases to their bucket, mark gone, keep a star sample per change and fold old hours into days", async (db) => {
  await saveReleaseReadings(db, [reading("app", [1, 2]), reading("lib", [3])], "2026-01-01T10:30:00Z");
  let st = await loadReleaseState(db, ["app", "lib", "none"]);
  assert.deepEqual([...st.assets.keys()].sort(), [1, 2, 3]);
  assert.equal(st.lastRead.get("app"), "2026-01-01T10:30:00Z");
  assert.equal(st.lastStars.get("lib"), 5);
  await saveReleaseReadings(db, [reading("app", [1], { delta: 4, downloads: 14, gone: [2] })], "2026-01-01T10:45:00Z");
  await saveReleaseReadings(db, [reading("app", [1], { delta: 1, downloads: 15, app: { name: "APP", stars: 7 } })], "2026-01-01T11:10:00Z");
  st = await loadReleaseState(db, ["app"]);
  assert.equal(st.assets.get(1)!.downloads, 15);
  assert.equal(st.lastStars.get("app"), 7);
  const q = queryDb(db);
  assert.equal((await q.all(q.k.selectFrom("main.star_samples").select("t").where("repo", "=", "app"))).length, 2, "an unchanged count adds no sample");
  const gone = await q.get(q.k.selectFrom("main.release_assets").select("gone_at").where("asset_id", "=", 2));
  assert.equal(gone!.gone_at, "2026-01-01T10:45:00Z");

  const report = await loadDownloadsReport(db, { repos: ["app", "lib"], from: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z", to: "2026-01-02T00:00:00Z" });
  assert.deepEqual(report.apps.map((a) => a.repo), ["app", "lib"]);
  assert.equal(report.assets.find((a) => a.asset_id === 1)!.delta, 5);
  assert.equal(report.assets.find((a) => a.asset_id === 3)!.delta, 0);
  assert.deepEqual(report.stars.get("app"), { atStart: null, first: 5, atEnd: 7 });
  assert.equal((await loadDownloadsReport(db, { repos: ["app"], from: null, end: T2, to: T2 })).assets.every((a) => a.delta === 0), true);

  await saveReleaseReadings(db, [reading("lib", [3], { app: null, gone: [] })], "2026-01-01T12:00:00Z");
  assert.equal((await q.all(q.k.selectFrom("main.release_apps").select("repo"))).length, 2, "an app with counted files stays");

  await foldDeltas(db, "2026-01-10T00:00:00Z");
  const days = await q.all(q.k.selectFrom("main.download_deltas").select(["asset_id", "t", "span", "delta"]).orderBy("asset_id"));
  assert.deepEqual(days.map((d) => [d.asset_id, d.t, d.span, Number(d.delta)]), [[1, "2026-01-01T00:00:00Z", "d", 5]]);
});

both("item event counts per window", async (db) => {
  await seedItems(db, [
    { repo: "app", number: 1, kind: "issue", created_at: "2026-01-01T05:00:00Z" },
    { repo: "app", number: 2, kind: "issue", created_at: "2026-01-03T05:00:00Z" },
    { repo: "app", number: 3, kind: "pr", created_at: "2026-01-01T06:00:00Z" },
    { repo: "lib", number: 1, kind: "issue", created_at: "2026-01-01T07:00:00Z" },
  ]);
  const n = await countItemEvents(db, { kind: "issue", col: "created_at", windows: [
    { repo: "app", from: T0, to: T1 }, { repo: "app", from: T0, to: "2026-02-01T00:00:00Z" }, { repo: "lib", from: T1, to: T2 }, { repo: "app", from: T0, to: T0 },
  ] });
  assert.deepEqual(n, [1, 2, 0, 0]);
});

// ---- statement counts -----------------------------------------------------------------------------------------------

async function flat(name: string, run: (db: Db, size: number) => Promise<unknown>, prepare: (db: Db, size: number) => Promise<void> = async () => {}): Promise<void> {
  test(`${name}: statements do not grow with the number of items`, async () => {
    await expectFlat(async (size) => {
      const t = await testDatabase("", "sqlite");
      const db = await t.open({ app: true });
      await prepare(db, size);
      return { db, run: () => run(db, size), close: () => t.close() };
    }, 2, 12);
  });
}

const seedPrs = async (db: Db, size: number): Promise<void> => {
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.tracked_repos").values({ name: "app" }));
  await seedItems(db, prs(size).map((r) => ({ ...r, head_oid: "h1", updated_at: T0, author: `u${r.number}`, author_id: r.number, state: "MERGED", closing_issues: "[100]", created_at: T0, base_ref: "main" })));
};

await flat("activity pass", async (db, size) => {
  await listActivityDue(db, { since: T0, now: T1, limit: 20 });
  await saveActivity(db, { reads: prs(size).map((r) => read(r.number)), attempts: [] });
  await loadActivity(db, prs(size));
  await loadCommits(db, prs(size));
  await loadFiles(db, prs(size));
  await loadActivityStats(db, prs(size));
}, seedPrs);

await flat("authors, branches and closures", async (db, size) => {
  await bindKnownAuthorIds(db);
  await loadUnboundLoginPrs(db);
  await loadAuthorHistory(db, {});
  await loadAuthorIds(db, "all");
  await saveAuthorPermissions(db, prs(size).map((r) => ({ login: `u${r.number}`, repo: "app", authorId: r.number, at: T0, permission: r.number % 2 ? "write" : null })));
  await loadAuthorPermissions(db, {});
  await loadLongLivedBranches(db);
  await loadMergedClosures(db, ["app"]);
}, seedPrs);

await flat("release flush", async (db, size) => {
  const repos = Array.from({ length: size }, (_, i) => `r${i}`);
  await loadReleaseState(db, repos);
  await saveReleaseReadings(db, repos.map((r, i) => reading(r, [i * 10 + 1, i * 10 + 2], { delta: 1 })), "2026-01-01T10:30:00Z");
  await foldDeltas(db, "2026-02-01T00:00:00Z");
  await loadDownloadsReport(db, { repos, from: T0, end: T2, to: T2 });
  await countItemEvents(db, { kind: "issue", col: "created_at", windows: repos.map((repo) => ({ repo, from: T0, to: T2 })) });
});
