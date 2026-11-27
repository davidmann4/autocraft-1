import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { redeliverWebhook } from "../src/github/write.ts";
import { safeEqual } from "../src/dash/server/crypto.ts";
import { checkDeliveries, parseDeliveries, type Delivery, type DeliveryPage } from "../src/github/deliveries.ts";
import { drainSyncRequests, handleDelivery, resetDeliveryNote, signatureOf } from "../src/github/webhooks.ts";
import { loadSyncState, saveSyncState } from "../src/data/mirror/index.ts";
import { pollReason, writeItemNode } from "../src/mirror.ts";
import type { AppSecrets } from "../src/dash/server/config.ts";
import { validating } from "./gql.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

const SECRET = "hook-secret";
async function scratch() {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "hook-")), "m.db"));
  await db.run(db.k.deleteFrom("tracked_repos"));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "a", added_by: "t", added_at: "x", pipeline: 1 }));
  return db;
}
const deliver = async (db: Awaited<ReturnType<typeof scratch>>, event: string, payload: unknown, sign = true) => {
  const raw = Buffer.from(JSON.stringify(payload));
  return await handleDelivery(db, SECRET, { event, ...(sign ? { signature: signatureOf(SECRET, raw) } : {}) }, raw, safeEqual);
};
const queued = async (db: Awaited<ReturnType<typeof scratch>>) => (await db.all(db.k.selectFrom("sync_requests").select(["repo", "number"]).orderBy("number"))).map((r) => ({ ...r }));

test("a signed delivery queues one row per item, a bad or missing signature and an untracked repo queue nothing", async () => {
  const db = await scratch();
  const body = (n: number, full = "storytold/a") => ({ repository: { full_name: full, name: full.split("/")[1] }, issue: { number: n } });
  assert.equal((await deliver(db, "issues", body(7))).status, 202);
  assert.equal((await deliver(db, "issue_comment", body(7))).status, 202);
  assert.equal((await deliver(db, "issues", body(8))).status, 202);
  assert.deepEqual(await queued(db), [{ repo: "a", number: 7 }, { repo: "a", number: 8 }], "a burst collapses to one row per item");
  assert.equal((await deliver(db, "issues", body(9), false)).status, 401);
  const raw = Buffer.from(JSON.stringify(body(9)));
  assert.equal((await handleDelivery(db, SECRET, { event: "issues", signature: signatureOf("other", raw) }, raw, safeEqual)).status, 401);
  assert.equal((await handleDelivery(db, null, { event: "issues", signature: signatureOf("", raw) }, raw, safeEqual)).status, 401, "no secret set: refused");
  assert.equal((await deliver(db, "issues", body(10, "storytold/zzz"))).status, 202);
  assert.equal((await deliver(db, "issues", body(11, "someoneelse/a"))).status, 202);
  assert.equal((await deliver(db, "ping", {})).status, 200);
  const suite = (action: string, prs: unknown[], sha = "s1") => ({ action, repository: { full_name: "storytold/a", name: "a", id: 1 }, check_suite: { head_sha: sha, pull_requests: prs } });
  assert.equal((await deliver(db, "check_suite", suite("requested", [{ number: 13, base: { repo: { id: 1 } } }]))).status, 202);
  assert.equal((await deliver(db, "check_suite", suite("completed", [{ number: 12, base: { repo: { id: 1 } } }, { number: 99, base: { repo: { id: 2 } } }]))).status, 202);
  await db.run(db.k.insertInto("items").values({ repo: "a", number: 14, kind: "pr", state: "OPEN", head_oid: "fork-sha" }));
  assert.equal((await deliver(db, "check_suite", suite("completed", [], "fork-sha"))).status, 202);
  assert.deepEqual(await queued(db), [{ repo: "a", number: 7 }, { repo: "a", number: 8 }, { repo: "a", number: 12 }, { repo: "a", number: 14 }]);
});

test("the drain re-reads a queued item, sets synced_at and clears the request", async () => {
  const db = await scratch();
  await deliver(db, "issues", { repository: { full_name: "storytold/a", name: "a" }, issue: { number: 5 } });
  const node = {
    __typename: "Issue", repository: { name: "a", owner: { login: "storytold" } }, number: 5, title: "t", body: "", url: "u", author: { login: "x" },
    authorAssociation: "NONE", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-11-02T10:00:00Z", closedAt: null, state: "OPEN",
    labels: { nodes: [] }, assignees: { nodes: [] }, commentCount: { totalCount: 0 }, stateReason: null, comments: { nodes: [] },
  };
  const calls: Record<string, unknown>[] = [];
  const c = validating({ spent: 0, remaining: 4000 as number | null, async query(_q: string, v: Record<string, unknown>) { calls.push(v); return { repository: { issueOrPullRequest: node } }; } });
  assert.equal(await drainSyncRequests(db, c), 1);
  assert.deepEqual(calls, [{ owner: "storytold", name: "a", number: 5 }]);
  const row = (await db.get(db.k.selectFrom("items as i").select((eb) => ["i.title",
    eb.selectFrom("item_reads as r").select("r.synced_at").whereRef("r.repo", "=", "i.repo").whereRef("r.number", "=", "i.number").as("synced_at")])
    .where("i.repo", "=", "a").where("i.number", "=", 5)))!;
  assert.equal(row.title, "t");
  assert.match(row.synced_at!, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(await queued(db), []);
});

test("synced_at is when the re-read was sent, not when its answer was written", async () => {
  const db = await scratch();
  await deliver(db, "issues", { repository: { full_name: "storytold/a", name: "a" }, issue: { number: 5 } });
  const node = {
    __typename: "Issue", repository: { name: "a", owner: { login: "storytold" } }, number: 5, title: "t", body: "", url: "u", author: { login: "x" },
    authorAssociation: "NONE", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-11-02T10:00:00Z", closedAt: null, state: "OPEN",
    labels: { nodes: [] }, assignees: { nodes: [] }, commentCount: { totalCount: 0 }, stateReason: null, comments: { nodes: [] },
  };
  let sent = 0;
  // GitHub takes more than a second to answer: a comment made meanwhile is newer than this read.
  const c = { spent: 0, remaining: 4000 as number | null, async query() { sent = Date.now(); await new Promise((r) => setTimeout(r, 1100)); return { repository: { issueOrPullRequest: node } }; } };
  assert.equal(await drainSyncRequests(db, c), 1);
  const at = (await db.get(db.k.selectFrom("item_reads").select("synced_at").where("repo", "=", "a").where("number", "=", 5)))!.synced_at;
  assert.ok(Date.parse(at) <= sent, `${at} is not after the request went out`);
});

test("a read that started before the stored one does not replace it: the item and its read time stay the newer read's", async () => {
  const db = await scratch();
  const node = (title: string) => ({
    __typename: "Issue", repository: { name: "a", owner: { login: "storytold" } }, number: 6, title, body: "", url: "u", author: { login: "x" },
    authorAssociation: "NONE", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-11-02T10:00:00Z", closedAt: null, state: "OPEN",
    labels: { nodes: [] }, assignees: { nodes: [] }, commentCount: { totalCount: 0 }, stateReason: null, comments: { nodes: [] },
  });
  const row = async () => (await db.get(db.k.selectFrom("items as i").innerJoin("item_reads as r", (j) => j.onRef("r.repo", "=", "i.repo").onRef("r.number", "=", "i.number"))
    .select(["i.title", "r.synced_at"]).where("i.repo", "=", "a").where("i.number", "=", 6)))!;
  assert.ok(await writeItemNode(db, "a", node("new"), new Date("2026-11-20T12:00:10Z")));
  // A reconcile that started earlier writes its answer afterwards.
  await writeItemNode(db, "a", node("old"), new Date("2026-11-20T12:00:05Z"));
  assert.deepEqual({ ...await row() }, { title: "new", synced_at: "2026-11-20T12:00:10Z" });
  await writeItemNode(db, "a", node("newer"), new Date("2026-11-20T12:00:20Z"));
  assert.deepEqual({ ...await row() }, { title: "newer", synced_at: "2026-11-20T12:00:20Z" });
});

test("a request that fails for a reason other than a transient one is dropped so the queue moves on", async () => {
  const db = await scratch();
  for (const n of [1, 2]) await deliver(db, "issues", { repository: { full_name: "storytold/a", name: "a" }, issue: { number: n } });
  let calls = 0;
  const c = { spent: 0, remaining: 4000 as number | null, async query() { if (calls++ === 0) throw new Error("graphql error"); return { repository: { issueOrPullRequest: null } }; } };
  await drainSyncRequests(db, c);
  assert.equal(calls, 2);
  assert.deepEqual(await queued(db), []);
});

test("re-reading an unchanged item bumps no items topic and keeps its newest comments", async () => {
  const db = await scratch();
  const comment = (i: number) => ({ id: `c${i}`, author: { login: "x", __typename: "User" }, authorAssociation: "NONE", createdAt: "2026-01-02T00:00:00Z", body: `b${i}`, url: "u" });
  const node = {
    __typename: "Issue", repository: { name: "a", owner: { login: "storytold" } }, number: 5, title: "t", body: "", url: "u", author: { login: "x" },
    authorAssociation: "NONE", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-11-02T10:00:00Z", closedAt: null, state: "OPEN",
    labels: { nodes: [] }, assignees: { nodes: [] }, commentCount: { totalCount: 2 }, stateReason: null, comments: { nodes: [comment(1), comment(2)] },
  };
  const c = validating({ spent: 0, remaining: 4000 as number | null, async query() { return { repository: { issueOrPullRequest: node } }; } });
  const read = async () => { await deliver(db, "issues", { repository: { full_name: "storytold/a", name: "a" }, issue: { number: 5 } }); await drainSyncRequests(db, c); };
  const seq = async () => (await db.prepare("SELECT seq FROM change_seq WHERE topic = 'items'").get() as { seq: number }).seq;
  await read();
  const before = await seq();
  await read();
  assert.equal(await seq(), before);
  node.comments = { nodes: [comment(2)] };
  await read();
  assert.deepEqual((await db.all(db.k.selectFrom("comments").select("id").where("repo", "=", "a").where("number", "=", 5))).map((r) => r.id), ["c2"]);
});

test("with webhooks arriving the poll waits for the backstop; a failed delivery is asked for again once per attempt and makes the run poll", async () => {
  const db = await scratch();
  resetDeliveryNote();
  const t0 = Date.now();
  const none = { webhooks: true, unread: false, deliveries: null };
  assert.equal(pollReason(await loadSyncState(db), t0, none), "no webhook delivery yet");
  await deliver(db, "ping", {});
  const state = await loadSyncState(db);
  assert.ok(state.webhook_at && state.webhook_started_at, "a delivery records that webhooks arrive");
  // A poll right after the receiver started: nothing is due until the backstop.
  await saveSyncState(db, { polled_at: new Date(t0 + 1000).toISOString() });
  assert.equal(pollReason(await loadSyncState(db), t0 + 60_000, none), null);
  assert.equal(pollReason(await loadSyncState(db), t0 + 60_000, { ...none, webhooks: false }), "webhooks are not set up");
  assert.equal(pollReason(await loadSyncState(db), t0 + 16 * 60_000, none), "backstop");

  const at = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
  const page: Delivery[] = [
    { id: "1", guid: "ok", delivered_at: at(t0 - 120_000), status_code: 202, event: "issues" },
    { id: "2", guid: "down", delivered_at: at(t0 - 110_000), status_code: 502, event: "issue_comment" },
    { id: "3", guid: "refused", delivered_at: at(t0 - 100_000), status_code: 401, event: "issues" },
    { id: "4", guid: "fresh", delivered_at: at(t0 - 5_000), status_code: 0, event: "issues" },
  ];
  const asked: string[] = [];
  const deps = { list: async () => ({ deliveries: [...page], next: null }), redeliver: async (d: Delivery) => { asked.push(d.guid); }, log: () => {} };
  const app = {} as AppSecrets;
  const first = await checkDeliveries(db, app, t0, deps);
  assert.deepEqual(asked, ["down"], "only a delivery that got no good answer, settled and worth retrying, is asked for again");
  assert.equal(first.failed, 2);
  assert.ok(pollReason(await loadSyncState(db), t0 + 1000, { ...none, deliveries: first }), "a failed delivery makes the run poll");
  // The same list read again (a redelivery of the check) asks for nothing new; the in-flight one is looked at once it settles.
  const again = await checkDeliveries(db, app, t0 + 20_000, deps);
  assert.deepEqual(asked, ["down"]);
  assert.equal(again.failed, 0);
  page.push({ id: "5", guid: "down", delivered_at: at(t0 + 25_000), status_code: 202, event: "issue_comment" });
  await checkDeliveries(db, app, t0 + 60_000, deps);
  assert.deepEqual(asked, ["down", "fresh"], "the redelivered one succeeded; the in-flight one failed once settled");
});

test("a failed delivery a check could not have sent again is asked for on the next check, past newer ones and on a later page, and its comment command arrives", async () => {
  const db = await scratch();
  const t0 = Date.now();
  const at = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
  const slug = "autocraft-bot";
  const comment = { action: "created", repository: { full_name: "storytold/a", name: "a" }, issue: { number: 3 },
    comment: { id: 77, body: `@${slug} review`, created_at: new Date(t0 - 90_000).toISOString(), user: { login: "someone", id: 5, type: "User" } } };
  const lost: Delivery = { id: "9", guid: "cmd", delivered_at: at(t0 - 90_000), status_code: 502, event: "issue_comment" };
  const newest: Delivery[] = [{ id: "10", guid: "newer", delivered_at: at(t0 - 40_000), status_code: 202, event: "issues" }];
  const pages = (): Record<string, DeliveryPage> => ({
    first: { deliveries: [...newest], next: "p2" },
    p2: { deliveries: [lost, { id: "1", guid: "old", delivered_at: at(t0 - 4000_000), status_code: 202, event: "issues" }], next: null },
  });
  let down = true;
  const asked: string[] = [];
  const deps = {
    list: async (cursor: string | null) => pages()[cursor ?? "first"]!,
    redeliver: async (d: Delivery) => {
      asked.push(d.guid);
      if (down) throw new Error("HTTP 502");
      const raw = Buffer.from(JSON.stringify(comment));
      await handleDelivery(db, SECRET, { event: d.event, signature: signatureOf(SECRET, raw) }, raw, safeEqual, slug);
    },
    log: () => {},
  };
  await checkDeliveries(db, {} as AppSecrets, t0, deps);
  assert.deepEqual(asked, ["cmd"]);
  down = false;
  newest.unshift({ id: "11", guid: "newest", delivered_at: at(t0 + 20_000), status_code: 202, event: "issues" });
  await checkDeliveries(db, {} as AppSecrets, t0 + 60_000, deps);
  assert.deepEqual(asked, ["cmd", "cmd"], "the next check reads back to the delivery left over and asks for it again");
  const commands = await db.all(db.k.selectFrom("github_commands").select(["comment_id", "number"]));
  assert.deepEqual(commands.map((r) => ({ ...r })), [{ comment_id: 77, number: 3 }]);
});

test("a delivery id above 2^53 reaches the redelivery request exactly", async () => {
  const db = await scratch();
  const id = "3856181105461821437";
  const list = parseDeliveries(`[{"id":${id},"guid":"g","delivered_at":"2026-01-01T00:00:00Z","status_code":502,"event":"issues"}]`) as Delivery[];
  assert.equal(list[0]!.id, id);
  const paths: string[] = [];
  const server = createServer((req, res) => { paths.push(`${req.method} ${req.url}`); res.statusCode = 202; res.end("{}"); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const app = { clientId: "c", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
    await redeliverWebhook({ db, login: "t" }, { app, id: list[0]!.id, guid: "g", event: "issues", apiBase: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
  } finally { server.close(); }
  assert.deepEqual(paths, [`POST /app/hook/deliveries/${id}/attempts`]);
});
