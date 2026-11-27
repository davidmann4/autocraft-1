import assert from "node:assert/strict";
import { test } from "node:test";
import { insertRun } from "../src/agents/runs.ts";
import { activity } from "../src/dash/api/activity.ts";
import type { Req } from "../src/dash/types.ts";
import type { ActivityPage } from "../web/src/api/types.ts";
import { connectDb, type Db } from "./helpers/raw-db.ts";

const as = (role: "viewer" | "operator", query: Record<string, string> = {}): Req => ({
  method: "GET", path: "", params: {}, query: new URLSearchParams(query), form: new URLSearchParams(), csrf: "", nonce: "",
  user: { login: "u", role, canWrite: async () => true, canRead: async (r: string) => r !== "secret" },
});
const get = async (db: Db, role: "viewer" | "operator", q: Record<string, string> = {}) => (await activity(db, as(role, q))) as ActivityPage;

test("the stream merges the sources of every item newest first, pages by cursor and hides what the viewer may not see", async () => {
  const db = await connectDb(":memory:");
  await db.run(db.k.insertInto("repos").values([{ name: "photocraft", visibility: "public" }, { name: "secret", visibility: "private" }]));
  await db.run(db.k.insertInto("tracked_repos").values([{ name: "photocraft" }, { name: "secret" }]).onConflict((oc) => oc.doNothing()));
  for (const [repo, n] of [["photocraft", 1], ["photocraft", 2], ["secret", 3]] as const)
    await db.run(db.k.insertInto("items").values({ repo, number: n, kind: "pr", state: "OPEN", title: `Item ${n}`, author: "dev", created_at: "2026-01-01T00:00:00Z" }));
  await db.run(db.k.insertInto("comments").values({ repo: "photocraft", number: 1, id: "c1", kind: "comment", author: "dev", created_at: "2026-01-01T01:00:00Z", body: "hi" }));
  const run = await insertRun(db, { jobId: null, step: "opus-review", stage: 5, promptId: "p", promptVersion: "1", provider: "claude", model: "opus", items: [{ repo: "photocraft", number: 2 }, { repo: "photocraft", number: 1 }], prompt: "p" });
  await db.run(db.k.updateTable("agent_runs").set({ started_at: "2026-01-01T02:00:00Z" }));
  await db.run(db.k.insertInto("opus_review_history").values({ repo: "photocraft", number: 2, head_oid: "a".repeat(40), at: "2026-01-01T03:00:00Z", model: "opus", mode: "full", verdict: "take", sure: 1, reason: "ok" }));
  await db.run(db.k.insertInto("audit").values([
    { at: "2026-01-01T04:00:00Z", login: "bot", action: "review-post", target: "photocraft#1", details: "{}" },
    { at: "2026-01-01T05:00:00Z", login: "maint", action: "set-priority", target: "photocraft#2", details: "{}" },
    { at: "2026-01-01T06:00:00Z", login: "bot", action: "review-post", target: "secret#3", details: "{}" },
  ]));
  await db.run(db.k.insertInto("comments").values({ repo: "secret", number: 3, id: "c2", kind: "comment", author: "dev", created_at: "2026-01-01T07:00:00Z", body: "hidden" }));

  const op = await get(db, "operator");
  const ids = op.events.map((e) => e.id);
  assert.deepEqual(ids.slice(0, 7), ["comment:c2", "audit:3", "audit:2", "audit:1", "review:opus:1", `run:${run}`, "comment:c1"]);
  assert.deepEqual(op.events.find((e) => e.id === `run:${run}`)!.item, { repo: "photocraft", number: 1, kind: "pr", state: "open", title: "Item 1" }, "a run over two items shows once, at its first item");
  assert.equal(ids.filter((i) => i === `run:${run}`).length, 1);

  const first = await get(db, "operator", { limit: "3" });
  assert.deepEqual(first.events.map((e) => e.id), ids.slice(0, 3));
  assert.ok(first.nextCursor);
  const second = await get(db, "operator", { limit: "3", cursor: first.nextCursor! });
  assert.deepEqual(second.events.map((e) => e.id), ids.slice(3, 6));
  assert.deepEqual((await activity(db, as("operator", { since: op.stamp }))), { unchanged: true, stamp: op.stamp });

  const own = await get(db, "operator", { autocraftOnly: "1", limit: "2" });
  assert.deepEqual(own.events.map((e) => e.id), ["review:opus:1", `run:${run}`], "Only AutoCraft fills the page from AutoCraft's own rows, past newer people's events");

  const viewer = await get(db, "viewer");
  assert.deepEqual(viewer.events.filter((e) => e.item.repo === "secret").map((e) => e.id), [], "a hidden repo's events are left out");
  assert.ok(!viewer.events.some((e) => e.id === "audit:2"), "a dashboard action is not a GitHub write");
  assert.ok(viewer.events.some((e) => e.id === "audit:1"));
  assert.ok(!(await get(db, "operator", { kinds: "plan" })).events.length, "plan events show only when asked for");
});
