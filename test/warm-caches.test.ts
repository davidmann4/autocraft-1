// The caches report combines the runner's node reads with the warm tasks: a placed node holds a key's newest version
// only at the last successful warm build's commit, stale nodes do not count, and keys of hidden repos are left out.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cacheReport, type StoredCaches } from "../src/build/caches.ts";
import { warmKeyOf } from "../src/build/tasks.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { saveWarmReport } from "../src/data/build/index.ts";
import type { HiddenRepos } from "../src/hidden-sql.ts";

test("caches report: placement against the published version, stale nodes and hidden repos", async () => {
  const d = await connectDb(":memory:");
  await d.script("INSERT INTO tracked_repos (name, pipeline) VALUES ('app', 1), ('secret', 1); INSERT INTO repos (name, visibility) VALUES ('app', 'public'), ('secret', 'private')");
  const now = Date.parse("2026-11-20T12:00:00Z");
  const at = (min: number) => new Date(now - min * 60_000).toISOString();
  const task = (repo: string, head: string, state: string, endedMin: number) => d.run(d.k.insertInto("build_tasks").values({
    step: "warm", repo, head_sha: head, requires: "{}", plan: "[]", state, queued_at: at(endedMin + 5), ended_at: at(endedMin), warm_key: warmKeyOf(repo), warm_role: "build", warm_image: "img:1",
  }));
  await task("app", "a".repeat(40), "done", 120);
  await task("app", "b".repeat(40), "failed", 10);
  await task("secret", "c".repeat(40), "done", 60);
  await d.run(d.k.insertInto("main_ci").values({ repo: "app", head_sha: "b".repeat(40), branch: "main", state: "green", failing: "[]", checks: "[]", first_seen_at: at(15), state_changed_at: at(15), updated_at: at(1) }));

  const app = warmKeyOf("app"), secret = warmKeyOf("secret");
  const held = (commit: string) => ({ commit, stored: now - 3600_000, bytes: 5e9, image: "img:1", envHash: "h", synced: now - 1800_000 });
  const node = (name: string, updatedMin: number, keys: Record<string, ReturnType<typeof held>>) => ({
    version: 1 as const, node: name, updated: now - updatedMin * 60_000, fs: { sizeBytes: 1e12, usedBytes: 4e11, usedPct: 40 }, warmBytes: { current: 5e9, grace: 0 }, keys, pending: {}, badBlobs: {},
  });
  const stored: StoredCaches = {
    version: 1, readAt: now - 30_000, placementNote: null, mirror: null,
    nodes: [
      node("n1", 2, { [app]: held("a".repeat(40)), [secret]: held("c".repeat(40)) }),
      node("n2", 3, { [app]: held("9".repeat(40)) }),
      node("n3", 40, { [app]: held("a".repeat(40)) }),
      node("n4", 1, {}),
    ],
    placement: { version: 1, keys: [{ key: app, nodes: ["n1", "n2", "n4"] }, { key: secret, nodes: ["n1"] }] },
  };
  await saveWarmReport(d, JSON.stringify(stored));

  const all = await cacheReport(d, [], now);
  const placed = all.placement!.find((p) => p.key === app)!;
  assert.deepEqual(placed.nodes.map((n) => [n.node, n.holds]), [["n1", "newest"], ["n2", "older"], ["n4", "none"]]);
  const r = all.repos.find((x) => x.repo === "app")!;
  assert.equal(r.published?.headSha, "a".repeat(40), "the failed build of the new head does not replace the published version");
  assert.equal(r.last?.state, "failed");
  assert.equal(r.freshness, "behind");
  // n3 holds the published version but is stale: it counts neither as holding nor among the nodes.
  assert.deepEqual([r.nodes, r.of], [1, 3]);
  assert.equal(all.nodes.find((n) => n.node === "n3")?.fresh, false);
  assert.equal(all.nodes.find((n) => n.node === "n2")?.keys[0]?.newest, false);

  const hidden: HiddenRepos = Object.assign(["secret"], { visible: ["app"] });
  const shown = await cacheReport(d, hidden, now);
  assert.ok(!shown.repos.some((x) => x.repo === "secret"));
  assert.ok(!shown.placement!.some((p) => p.key === secret));
  assert.ok(!shown.nodes.some((n) => n.keys.some((k) => k.key === secret)));
});
