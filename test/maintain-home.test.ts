// Home's own items and the asked count (src/dash/api/maintain.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { asked, home, items, repos } from "../src/dash/api/maintain.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { addEvent, insertWorkflow } from "../src/workflow/store.ts";
import { recordMessage } from "../src/data/chat/index.ts";
import { RULE_STARTER } from "../src/workflow/types.ts";

const T = "2026-11-01T00:00:00.000Z";
const as = (role: string, writable: string[]) => ({
  method: "GET", path: "", params: {}, query: new URLSearchParams(), form: new URLSearchParams(), csrf: "", nonce: "",
  user: { login: "u1", role, canWrite: async (r: string) => writable.includes(r), canRead: async () => true },
}) as never;

const item = (db: Awaited<ReturnType<typeof connectDb>>, repo: string, number: number, extra: Record<string, unknown> = {}) =>
  db.run(db.k.insertInto("main.items").values({ repo, number, kind: "pr", state: "OPEN", title: `t${number}`, body: "", head_oid: "h", author: "a", created_at: T, updated_at: T, ...extra } as never));

test("mine holds the items the reader started, approved, answered or wrote about, not authored or rule-started ones; done items drop after 7 days", async () => {
  const db = await connectDb(":memory:");
  await db.run(db.k.insertInto("repos").values({ name: "app", visibility: "public" }));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: T, pipeline: 1 }));
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
  const wf = { kind: "pr" as const, entry: "review" as const, startedAt: T, startedVia: "github" as const };
  for (const n of [1, 2, 3, 4, 5, 6, 7]) await item(db, "app", n, n === 6 ? { author: "u1" } : n === 7 ? { state: "MERGED", merged_at: old } : {});
  await insertWorkflow(db, { ...wf, repo: "app", number: 1, startedBy: "u1", state: "recommending", rec: { text: "Fix 1, then merge?", parts: { fix: [1], drop: [] }, merges: true } });
  await insertWorkflow(db, { ...wf, repo: "app", number: 2, startedBy: "m2", approvedBy: "u1", approvedAt: T, approvedVia: "github", state: "running" });
  await insertWorkflow(db, { ...wf, repo: "app", number: 3, startedBy: RULE_STARTER, state: "running" });
  await insertWorkflow(db, { ...wf, repo: "app", number: 7, startedBy: "u1", state: "done" });
  // Item 4: the reader only wrote a message. Item 6 is only authored by the reader.
  await recordMessage(db, { repo: "app", number: 4, author: "u1", via: "dashboard", kind: "said", body: "what about this?", at: now });
  const five = await insertWorkflow(db, { ...wf, repo: "app", number: 5, startedBy: "m2", state: "running" });
  await addEvent(db, { workflowId: five, repo: "app", number: 5, login: "u1", via: "github", kind: "answered" });

  const refs = (rows: { repo: string; number: number }[]) => rows.map((r) => r.number).sort();
  const m = await home(db, as("maintainer", ["app"]));
  assert.deepEqual(refs(m.mine), [1, 2, 4, 5]);
  assert.equal(m.mineTotal, 4);
  assert.deepEqual(m.recent, []);
  const four = m.mine.find((r) => r.number === 4)!;
  assert.deepEqual([four.last?.by, four.last?.text, four.last?.question], ["u1", "what about this?", false]);
  assert.equal(m.mine.find((r) => r.number === 1)!.waits, true);
  assert.deepEqual(refs((await items(db, { ...(as("maintainer", ["app"]) as object), query: new URLSearchParams("filter=mine") } as never)).rows), [1, 2, 4, 5]);
  assert.deepEqual((await asked(db, as("maintainer", ["app"]))).count, 1);
  assert.deepEqual((await asked(db, as("operator", [])).then((r) => r.count)), 1);

  const viewer = await home(db, as("viewer", ["app"]));
  assert.deepEqual([viewer.mine, viewer.mineTotal], [[], 0]);
  assert.equal(viewer.recent.length, 7);
});

test("an item stopped at a blocker shows its recommendation and needs an answer in every list and count; viewers read none of a quiet pull request", async () => {
  const db = await connectDb(":memory:");
  await db.run(db.k.insertInto("repos").values({ name: "app", visibility: "public" }));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: T, pipeline: 1 }));
  for (const number of [1, 2]) {
    await db.run(db.k.insertInto("main.items").values({ repo: "app", number, kind: "pr", state: "OPEN", title: "Fix", body: "", head_oid: "h", author: "a", created_at: T, updated_at: T }));
    await insertWorkflow(db, {
      repo: "app", number, kind: "pr", entry: "merge", state: "blocked", startedBy: "u1", startedAt: T, startedVia: "github", approvedBy: "u1", approvedAt: T, approvedVia: "github", blocker: "other",
      rec: { text: "Merge past the stop.", parts: { fix: [], drop: [] }, merges: true },
    });
  }
  await db.run(db.k.insertInto("security_scans").values({ id: 7, repo: "app", state: "done", started_by: "boss", started_at: T }));
  await db.run(db.k.insertInto("security_findings").values({
    repo: "app", number: 7, scan_id: 7, area: "a", title: "Path escape", severity: "high", urgent: 0, state: "landing", refs: "[]", reach: "r", impact: "i", fingerprint: "fp7", fix_pr: 2, created_at: T, updated_at: T,
  }));
  const shown = (rows: { number: number; line: string | null }[]) => rows.map((r) => [r.number, r.line?.startsWith("Merge past the stop. Reply yes") ?? false]).sort();

  const m = as("maintainer", ["app"]), v = as("viewer", []);
  assert.deepEqual(shown((await home(db, m)).mine), [[1, true], [2, true]]);
  const list = await items(db, m);
  assert.deepEqual([shown(list.rows.filter((r) => r.group === "started")), list.counts.started], [[[1, true], [2, true]], 2]);
  assert.equal((await repos(db, m))[0]!.waiting, 2);
  assert.deepEqual(shown((await home(db, v)).recent), [[1, true], [2, false]]);
  assert.deepEqual(shown((await items(db, v)).rows), [[1, true], [2, false]]);
});

test("a close that was not made is a problem for those who act on the repo, until someone takes the item up again", async () => {
  const db = await connectDb(":memory:");
  await db.run(db.k.insertInto("repos").values({ name: "app", visibility: "public" }));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: T, pipeline: 1 }));
  for (const number of [1, 2]) await db.run(db.k.insertInto("items").values({ repo: "app", number, kind: "issue", state: "OPEN", title: `t${number}`, created_at: T }));
  const wf = { repo: "app", kind: "issue" as const, entry: "review" as const, startedBy: "m2", startedAt: T, startedVia: "github" as const };
  const close = async (number: number, state: string) => {
    const workflow_id = await insertWorkflow(db, { ...wf, number, state: "closed" });
    await db.run(db.k.insertInto("workflow_actions").values({ workflow_id, repo: "app", number, kind: "close", by: "m2", state, reason: "GitHub refused", created_at: T, updated_at: T }));
  };
  await close(1, "failed");
  await close(2, "done");
  const listed = async (role: string, writable: string[]) => (await home(db, as(role, writable))).attention.filter((p) => p.kind === "gave-up").map((p) => [p.title, p.detail]);
  assert.deepEqual(await listed("maintainer", ["app"]), [["app#1: not closed", "GitHub refused"]]);
  assert.deepEqual(await listed("maintainer", []), []);
  await insertWorkflow(db, { ...wf, number: 1, state: "running" });
  assert.deepEqual(await listed("maintainer", ["app"]), []);
});
