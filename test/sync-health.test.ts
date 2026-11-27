import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { computeChecks, serveChecks } from "../src/health-checks.ts";
import { GithubError, reconcileNext, runSync } from "../src/mirror.ts";
import { reloadRepoOwners } from "../src/repos.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { excluded } from "../src/db/kx.ts";
import { sqliteOnly } from "./test-db.ts";
import { saveSyncState, loadSyncState } from "../src/data/mirror/index.ts";

async function scratchDb() {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "synchealth-")), "m.db"));
  await db.run(db.k.deleteFrom("tracked_repos"));
  await db.run(db.k.insertInto("tracked_repos").values([{ name: "a", added_by: "t", added_at: "x" }, { name: "b", added_by: "t", added_at: "x" }]));
  return db;
}

test("a repo that no longer resolves is skipped and recorded; failures and recoveries keep per-repo reads right", { skip: sqliteOnly("per-repo sync writes in src/mirror.ts are raw SQL with an untyped parameter") }, async () => {
  await recoveryScenarios();
  const db = await scratchDb();
  await db.run(db.k.insertInto("repos").values([
    { name: "a", synced_at: "2026-11-02T09:00:00Z", high_water: "2026-11-02T09:00:00Z", reconciled_at: "2026-11-01T00:00:00Z" },
    { name: "b", synced_at: "2026-11-02T09:00:00Z", high_water: "2026-11-02T09:00:00Z", reconciled_at: "2026-11-02T00:00:00Z" },
  ]));
  await saveSyncState(db, { org_high_water: "2026-11-02T09:30:00Z", repos_refreshed_at: "2999-01-01T00:00:00Z", search_catchup_at: "2999-01-01T00:00:00Z" });
  const client = {
    spent: 0, remaining: 4000 as number | null,
    repoMovedTo: (owner: string, name: string) => `elsewhere/${name}-${owner.length}`,
    async query(query: string) {
      if (query.includes("search(")) return { search: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } };
      throw new GithubError('graphql error: [{"type":"NOT_FOUND","message":"Could not resolve to a Repository"}]', 0, "NOT_FOUND");
    },
  };
  const r = await runSync(db, client, { only: [], all: false, full: false, perRepo: false }, new Date("2026-11-02T10:05:00Z"));
  assert.equal(r.mode, "search");
  assert.equal(await reconcileNext(db, client, new Date("2026-11-02T10:05:00Z"), () => {}), "a");
  const err = await db.all(db.k.selectFrom("sync_repo_errors").select(["repo", "kind", "moved_to"]));
  assert.deepEqual(err.map((e) => ({ ...e })), [{ repo: "a", kind: "not-found", moved_to: "elsewhere/a-9" }]);
  // The failing repo gives up its place at the front of the daily reconcile, so repo b is next.
  assert.equal((await db.get(db.k.selectFrom("repos").select("reconciled_at as t").where("name", "=", "a")))!.t, "2026-11-02T10:05:00Z");
  const check = (await computeChecks(db, Date.parse("2026-11-02T10:06:00Z"))).find((c) => c.id === "sync-repo:a");
  assert.equal(check?.state, "warn");
  assert.match(check!.text, /storytold\/a no longer resolves on GitHub \(moved to elsewhere\/a-9\)/);
});

const issue = (repo: string, number: number, updatedAt: string) => ({
  __typename: "Issue", repository: { name: repo }, number, title: `t${number}`, body: "", url: "u", author: { login: "a" },
  authorAssociation: "NONE", createdAt: "2026-01-01T00:00:00Z", updatedAt, closedAt: null, state: "OPEN",
  labels: { nodes: [] }, assignees: { nodes: [] }, commentCount: { totalCount: 0 }, stateReason: null, comments: { nodes: [] },
});
const conn = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });

/** A new repo's first failure leaves it unsynced; a recovered repo re-reads its outage window. */
async function recoveryScenarios(): Promise<void> {
  // A new repo whose first read fails with a plain error is retried per repo, not marked synced by a search.
  const db = await scratchDb();
  await db.run(db.k.insertInto("repos").values({ name: "a", synced_at: "2026-11-02T09:00:00Z", high_water: "2026-11-02T09:00:00Z", reconciled_at: "2026-11-02T09:00:00Z" }));
  await saveSyncState(db, { org_high_water: "2026-11-02T09:30:00Z", search_catchup_at: "2999-01-01T00:00:00Z" });
  const client = {
    spent: 0, remaining: 4000 as number | null,
    async query(query: string, v: Record<string, unknown>) {
      if (query.includes("search(")) return { search: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } };
      if (query.includes("repositoryOwner")) {
        const repo = (name: string) => ({ name, visibility: "PUBLIC", defaultBranchRef: { name: "main" }, pullRequests: { totalCount: 0 }, issues: { totalCount: 0 } });
        return { repositoryOwner: { repositories: { nodes: [repo("a"), repo("b")], pageInfo: { hasNextPage: false, endCursor: null } } } };
      }
      if (v.name === "b") throw new GithubError("gh failed: HTTP 500", 500, null);
      return { repository: { issues: conn([]), pullRequests: conn([]) } };
    },
  };
  const o = { only: [], all: false, full: false, perRepo: false };
  assert.equal((await runSync(db, client, o, new Date("2026-11-02T10:05:00Z"))).mode, "per-repo");
  await saveSyncState(db, { repos_refreshed_at: "2999-01-01T00:00:00Z" });
  assert.equal((await runSync(db, client, o, new Date("2026-11-02T10:06:00Z"))).mode, "per-repo");
  assert.equal((await db.get(db.k.selectFrom("repos").select("synced_at as t").where("name", "=", "b")))!.t, null);

  // A repo of another owner that failed for hours reads from its own high water when it recovers.
  const db2 = await scratchDb();
  await db2.run(db2.k.deleteFrom("tracked_repos"));
  await db2.run(db2.k.insertInto("tracked_repos").values({ name: "c", added_by: "t", added_at: "x" }));
  await db2.run(db2.k.insertInto("repos").values({ name: "c", owner: "other", synced_at: "2026-11-02T08:00:00Z", high_water: "2026-11-02T08:00:00Z", reconciled_at: "2026-11-02T09:00:00Z" }));
  await saveSyncState(db2, { org_high_water: "2026-11-02T10:00:00Z", repos_refreshed_at: "2999-01-01T00:00:00Z", search_catchup_at: "2999-01-01T00:00:00Z" });
  await db2.run(db2.k.insertInto("sync_repo_errors").values({ repo: "c", kind: "transient", message: "x", moved_to: "", since: "2026-11-02T08:30:00Z", at: "2026-11-02T10:00:00Z" }));
  await reloadRepoOwners(db2);
  const c2 = {
    spent: 0, remaining: 4000 as number | null,
    async query(query: string, v: Record<string, unknown>) {
      if (query.includes("search(")) return { search: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } };
      const open = (v.states as string[]).includes("OPEN");
      return { repository: { issues: conn(open ? [issue("c", 1, "2026-11-02T08:30:00Z")] : []), pullRequests: conn([]) } };
    },
  };
  await runSync(db2, c2, o, new Date("2026-11-02T10:05:00Z"));
  assert.equal((await db2.get(db2.k.selectFrom("items").select((eb) => eb.fn.countAll<number>().as("n")).where("repo", "=", "c")))!.n, 1);
  assert.equal((await db2.get(db2.k.selectFrom("sync_repo_errors").select((eb) => eb.fn.countAll<number>().as("n"))))!.n, 0);
}

test("GET /healthz/checks answers 503 with a stale worker and shows no repo names", async () => {
  const db = await scratchDb();
  const now = Date.parse("2026-11-05T12:00:00Z");
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  await db.run(db.k.insertInto("lane_state").values({ kind: "mark", step: "heartbeat", repo: "", value: at(5_000), at: at(5_000) }));
  await db.run(db.k.insertInto("sync_runs").values({ started_at: at(70_000), ended_at: at(60_000), mode: "search", items: 0 }));
  await db.run(db.k.insertInto("build_envs").values({ id: "sandbox", label: "Sandbox", kind: "local-sandbox", enabled: 1, slots: 2, key_hash: "h", last_seen_at: at(6 * 60_000), created_at: at(86_400_000) }));
  await db.run(db.k.insertInto("sync_repo_errors").values({ repo: "a", kind: "not-found", message: "x", since: at(1000), at: at(1000) }));
  // The header stands in for a staff session: anonymous callers get names and states only.
  const server = createServer(async (req, res) => { if (!await serveChecks(req, res, db, now, 0, async (r) => r.headers["x-staff"] === "1")) res.writeHead(404).end(); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/healthz/checks`;
  try {
    const bad = await fetch(url);
    assert.equal(bad.status, 503);
    const body = await bad.json() as { status: string; checks: { id: string; state: string; count?: number }[] };
    assert.equal(body.checks.find((c) => c.id === "workers")?.state, "fail");
    assert.deepEqual(body.checks.find((c) => c.id === "sync-repos"), { id: "sync-repos", state: "warn" });
    const staff = await (await fetch(url, { headers: { "x-staff": "1" } })).json() as typeof body;
    assert.equal(staff.checks.find((c) => c.id === "sync-repos")?.count, 1);
    assert.ok(!JSON.stringify(staff).includes("storytold/a") && !JSON.stringify(staff).includes("sandbox"));
    await db.run(db.k.updateTable("build_envs").set({ last_seen_at: at(10_000) }));
    assert.equal((await fetch(url)).status, 200);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
