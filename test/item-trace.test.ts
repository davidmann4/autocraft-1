import assert from "node:assert/strict";
import { test } from "node:test";
import { insertRun, finishRun } from "../src/agents/runs.ts";
import { saveTools } from "../src/agents/tools.ts";
import { syncActivity } from "../src/activity.ts";
import { trace, traceDetail } from "../src/dash/api/trace.ts";
import { itemPage } from "../src/dash/api/item-page.ts";
import type { Req } from "../src/dash/types.ts";
import type { ItemTrace } from "../web/src/api/types.ts";
import { connectDb, type Db } from "./helpers/raw-db.ts";
import { rowid } from "../src/db/kx.ts";

const req = (n: number, query: Record<string, string> = {}, extra: Record<string, string> = {}): Req => ({
  method: "GET", path: "", params: { repo: "photocraft", n: String(n) }, query: new URLSearchParams({ ...query, ...extra }), form: new URLSearchParams(), user: { login: "op", role: "operator", canWrite: async () => true, canRead: async () => true },
  csrf: "", nonce: "",
});
const full = async (db: Db, q: Record<string, string> = {}) => (await trace(db, req(7, q))) as ItemTrace;

test("the trace lists every source of an item oldest first, with heads, a cursor and a since check", async () => {
  const db = await connectDb(":memory:");
  const H1 = "a".repeat(40), H2 = "b".repeat(40);
  await db.run(db.k.insertInto("items").values({ repo: "photocraft", number: 7, kind: "pr", state: "OPEN", author: "dev", created_at: "2026-01-01T00:00:00Z", head_oid: H2, assignees: '["bot"]' }));
  await db.run(db.k.insertInto("settings").values({ key: "pipeline_login", value: "bot" }));
  await db.run(db.k.insertInto("comments").values({ repo: "photocraft", number: 7, id: "c1", kind: "comment", author: "dev", created_at: "2026-01-01T01:00:00Z", body: "please look", commit_oid: null }));
  await db.run(db.k.insertInto("plan_history").values({ repo: "photocraft", number: 7, head: H1, old_state: "reviewing", new_state: "verifying", wait: "CI", reasons: "[]", at: "2026-01-01T02:00:00Z" }));
  const run = await insertRun(db, { jobId: null, step: "opus-review", stage: 5, promptId: "p", promptVersion: "1", provider: "claude", model: "opus", items: [{ repo: "photocraft", number: 7 }], prompt: "secret prompt" });
  await db.run(db.k.updateTable("agent_runs").set({ started_at: "2026-01-01T03:00:00Z" }));
  await saveTools(db, run, [{ type: "assistant", message: { content: [{ type: "tool_use", id: "a", name: "Read", input: { file_path: "x" } }] } }]);
  await finishRun(db, run, { state: "done", output: "o", costUsd: 0.5 });
  await db.run(db.k.insertInto("opus_review_history").values({ repo: "photocraft", number: 7, head_oid: H1, at: "2026-01-01T04:00:00Z", model: "opus", mode: "full", verdict: "hold", sure: 1, reason: "why" }));
  await db.run(db.k.insertInto("opus_review_history").values({ repo: "photocraft", number: 7, head_oid: H2, at: "2026-01-01T05:00:00Z", model: "opus", mode: "delta", verdict: "take", sure: 1, reason: "fine" }));
  await db.run(db.k.insertInto("audit").values({ at: "2026-01-01T06:00:00Z", login: "bot", action: "review-post", target: "photocraft#7", details: JSON.stringify({ head: H2, state: "done", text: "long posted text" }) }));

  const asked: unknown[] = [];
  const client = {
    spent: 0, remaining: 4000,
    async query(_q: string, v: object) {
      asked.push(v);
      return { repository: { issueOrPullRequest: {
        __typename: "PullRequest", headRefOid: H2,
        files: { nodes: [{ path: "src/a.rs", additions: 3, deletions: 1, changeType: "MODIFIED" }] },
        commits: { nodes: [{ commit: { oid: H1, committedDate: "2026-01-01T00:30:00Z", author: { user: { login: "dev" } } } }] },
        prTimeline: { nodes: [{ __typename: "LabeledEvent", id: "L1", createdAt: "2026-01-01T00:45:00Z", actor: { login: "maint" }, label: { name: "bug" } }] },
      } } };
    },
  };
  assert.equal(await syncActivity(db, client), 1);
  assert.equal(await syncActivity(db, client), 0, "an item whose head and update time are unchanged is not read again");
  assert.deepEqual(asked, [{ owner: "storytold", name: "photocraft", number: 7 }]);

  const t = await full(db);
  assert.deepEqual(t.events.map((e) => e.id.replace(/:\d+$/, "")), ["gh:opened", `commit:${H1}`, "activity:L1", "comment:c1", "plan", "run", "review:opus", "review:opus", "audit"]);
  assert.deepEqual(t.events.filter((e) => e.id.startsWith("activity") || e.id.startsWith("commit")).map((e) => e.summary), ["Pushed commit aaaaaaa", "Added label bug"]);
  assert.deepEqual((await db.all(db.k.selectFrom("pr_files").select("path").where("repo", "=", "photocraft").where("number", "=", 7).where("head", "=", H2))).map((r) => r.path), ["src/a.rs"]);
  assert.deepEqual(t.events.slice(-5).map((e) => e.head), [H1, H1, H1, H2, H2], "a model call takes the head current at its time");
  const call = t.events.find((e) => e.kind === "model-call")!;
  assert.equal(call.call?.toolCalls, 1);
  assert.equal(call.call?.costUsd, 0.5);
  assert.equal(call.ref.runId, run);
  assert.ok(!JSON.stringify(t).includes("long posted text") && !JSON.stringify(t).includes("secret prompt"), "no bodies in the list");
  assert.equal(t.header.now.state, null);
  assert.deepEqual(t.header.who.assignees, ["bot"]);
  assert.equal(t.header.who.autocraftAssigned, true);

  const p1 = await full(db, { limit: "3" });
  assert.equal(p1.events.length, 3);
  const p2 = await full(db, { limit: "3", cursor: p1.nextCursor! });
  assert.deepEqual([...p1.events, ...p2.events.slice(0, 3)].map((e) => e.id), t.events.slice(0, 6).map((e) => e.id));
  assert.equal((await full(db, { limit: "3", cursor: (await full(db, { limit: "6" })).nextCursor! })).nextCursor, null);

  assert.deepEqual((await full(db, { kinds: "write,decision" })).events.map((e) => e.kind), ["write"]);
  assert.ok((await full(db, { autocraftOnly: "1" })).events.every((e) => e.actor.type !== "person"));
  assert.deepEqual(await trace(db, req(7, { since: t.stamp })), { unchanged: true, stamp: t.stamp });
  await db.run(db.k.insertInto("comments").values({ repo: "photocraft", number: 7, id: "c2", kind: "comment", author: "dev", created_at: "2026-01-02T00:00:00Z", body: "x" }));
  assert.notEqual((await trace(db, req(7, { since: t.stamp }))).stamp, t.stamp);

  const d = await traceDetail(db, req(7, { id: `review:opus:${(await db.get(db.k.selectFrom("opus_review_history").select(rowid("opus_review_history").as("rowid")).where("verdict", "=", "hold")))!.rowid}` }));
  assert.equal(d.fields.reason, "why");
  const w = await traceDetail(db, req(7, { id: t.events[t.events.length - 1]!.id }));
  assert.equal(w.fields.textLength, 16);
});

test("a viewer gets no staff-only post-merge fields and only the GitHub writes of the audit", async () => {
  const db = await connectDb(":memory:");
  await db.run(db.k.insertInto("items").values({ repo: "photocraft", number: 7, kind: "pr", state: "MERGED", created_at: "2026-01-01T00:00:00Z" }));
  await db.run(db.k.insertInto("postmerge_reviews").values({ repo: "photocraft", number: 7, merge_sha: "c".repeat(40), at: "2026-01-02T00:00:00Z", model: "opus",
    findings: JSON.stringify([{ severity: "major", title: "t", body: "b", missed_by: "review", missed_why: "secret reason" }]) }));
  await db.run(db.k.insertInto("audit").values([
    { at: "2026-01-02T01:00:00Z", login: "bot", action: "review-post", target: "photocraft#7", details: '{"state":"done","text":"posted"}' },
    { at: "2026-01-02T02:00:00Z", login: "someone", action: "answer", target: "photocraft#7", details: "{}" },
    { at: "2026-01-02T03:00:00Z", login: "admin", action: "access-add", target: "photocraft#7", details: "{}" },
  ]));
  const as = (role: "viewer" | "maintainer" | "operator"): Req => ({ ...req(7, { id: `review:postmerge:${"c".repeat(40)}` }), user: { login: "u", role, canWrite: async () => true, canRead: async () => true } });
  const writesOf = async (role: "viewer" | "maintainer" | "operator") => ((await trace(db, { ...as(role), query: new URLSearchParams({ kinds: "write" }) })) as ItemTrace).events;
  assert.equal(((await traceDetail(db, as("viewer"))).fields.findings as Record<string, unknown>[])[0]!.missed_why, undefined);
  assert.equal(((await traceDetail(db, as("maintainer"))).fields.findings as Record<string, unknown>[])[0]!.missed_why, "secret reason");
  const v = await writesOf("viewer");
  assert.deepEqual(v.map((e) => [e.summary, e.actor.name]), [["Posted review", "AutoCraft"]]);
  assert.equal((await writesOf("maintainer")).length, 2, "a maintainer also sees the dashboard answer, not the operator-only access change");
  assert.equal((await writesOf("operator")).length, 3);
  await db.run(db.k.insertInto("workflow_events").values([
    { repo: "photocraft", number: 7, login: "admin", via: "dashboard", kind: "answered", line: "Merging when CI is green.", at: "2026-01-03T00:00:00Z" },
    { repo: "pdfcraft", number: 7, login: "admin", via: "dashboard", kind: "answered", line: "another item", at: "2026-01-04T00:00:00Z" },
  ]));
  const answers = async (role: "viewer" | "maintainer") => ((await trace(db, { ...as(role), query: new URLSearchParams({ kinds: "decision" }) })) as ItemTrace).events.map((e) => e.summary);
  assert.deepEqual(await answers("maintainer"), ["Merging when CI is green."]);
  assert.deepEqual(await answers("viewer"), ["Answered"], "a viewer sees that it was answered, not the text");
  await db.run(db.k.insertInto("workflow_events").values({ repo: "photocraft", number: 7, login: "admin", via: "cli", kind: "archived", line: "Merge? Answer: Take it.", at: "2026-01-02T00:00:00Z" }));
  assert.deepEqual(await answers("maintainer"), ["Merge? Answer: Take it.", "Merging when CI is green."], "an archived answer shows at its own time");
  assert.deepEqual(await answers("viewer"), ["Answered: Take it", "Answered"], "a viewer reads which answer it was, not the question");
  const f = (await trace(db, { ...as("viewer"), query: new URLSearchParams({ kinds: "review" }) })) as ItemTrace;
  assert.equal(f.events[0]!.head, "c".repeat(40));
});

test("the activity pass skips a missing item, retries a failed one later and goes on to the others", async () => {
  const db = await connectDb(":memory:");
  await db.run(db.k.insertInto("items").values([1, 2, 3].map((n) => ({
    repo: "photocraft", number: n, kind: "issue", state: "OPEN", author: "dev", created_at: "2026-01-01T00:00:00Z", updated_at: `2026-01-0${n}T00:00:00Z`, head_oid: null,
  }))));
  const asked: number[] = [];
  let fails = true;
  const client = { spent: 0, remaining: 5000, async query(_q: string, v: { number: number }) {
    asked.push(v.number);
    if (v.number === 3) return { repository: { issueOrPullRequest: null } };
    if (v.number === 2 && fails) throw new Error("boom");
    return { repository: { issueOrPullRequest: { __typename: "Issue", issueTimeline: { nodes: [] } } } };
  } };
  const now = new Date("2026-01-10T00:00:00Z");
  assert.equal(await syncActivity(db, client, now), 3, "the failure does not stop the older item");
  assert.deepEqual(asked, [3, 2, 1]);
  asked.length = 0;
  assert.equal(await syncActivity(db, client, now), 0, "a missing item and a failed one wait");
  fails = false;
  assert.equal(await syncActivity(db, client, new Date(now.getTime() + 2 * 3_600_000)), 1);
  assert.deepEqual(asked, [2]);
  const state = await db.get(db.k.selectFrom("activity_sync").select(["error", "retry_at"]).where("repo", "=", "photocraft").where("number", "=", 2));
  assert.deepEqual(state, { error: null, retry_at: null }, "a successful read clears the earlier failure");
});

test("an item whose activity cannot be stored is a failed attempt and the others of the pass are stored", async () => {
  const db = await connectDb(":memory:");
  await db.run(db.k.insertInto("items").values([1, 2, 3].map((n) => ({
    repo: "photocraft", number: n, kind: "issue", state: "OPEN", author: "dev", created_at: "2026-01-01T00:00:00Z", updated_at: `2026-01-0${n}T00:00:00Z`, head_oid: null,
  }))));
  const client = { spent: 0, remaining: 5000, async query(_q: string, v: { number: number }) {
    // Item 2's event has no time, which the table refuses.
    return { repository: { issueOrPullRequest: { __typename: "Issue", issueTimeline: { nodes: [{ __typename: "LabeledEvent", id: `E${v.number}`, createdAt: v.number === 2 ? null : "2026-01-01T00:00:00Z" }] } } } };
  } };
  const now = new Date("2026-01-10T00:00:00Z");
  assert.equal(await syncActivity(db, client, now), 3);
  assert.deepEqual((await db.all(db.k.selectFrom("item_activity").select("id").orderBy("id"))).map((r) => r.id), ["E1", "E3"]);
  const synced = await db.all(db.k.selectFrom("activity_sync").select(["number", "error", "retry_at"]).orderBy("number"));
  assert.deepEqual(synced.map((r) => [Number(r.number), r.error !== null, r.retry_at !== null]), [[1, false, false], [2, true, true], [3, false, false]]);
  assert.equal(await syncActivity(db, client, now), 0, "it waits for its retry time");
});

test("decision_items follows a decision that changes or goes away", async () => {
  const db = await connectDb(":memory:");
  await db.run(db.k.insertInto("decisions").values({ id: "d", kind: "merge", repo: "photocraft", number: null, items: null, question: "q", options: "[]", asked_at: "2026-01-01T00:00:00Z" }));
  const n = async () => (await db.get(db.k.selectFrom("decision_items").select((eb) => eb.fn.countAll<number>().as("c"))))!.c;
  const setDecision = async (set: { number?: number | null; items?: string | null }) => { await db.run(db.k.updateTable("decisions").set(set).where("id", "=", "d")); };
  await setDecision({ number: null, items: JSON.stringify([{ repo: "photocraft", number: 1 }]) });
  assert.equal(await n(), 1);
  await setDecision({ number: 5 });
  assert.equal(await n(), 0, "a decision with its own number names no batch items");
  await setDecision({ number: null });
  await setDecision({ items: "not json" });
  assert.equal(await n(), 0);
  await setDecision({ items: JSON.stringify([{ repo: "photocraft", number: 2 }]) });
  await db.run(db.k.deleteFrom("decisions").where("id", "=", "d"));
  assert.equal(await n(), 0);
});


test("item history discloses only the reader's own-item calls and preserves unknown costs", async () => {
  // The real trace-to-history join must not reintroduce a mixed hidden-repo run.
  const db = await connectDb(":memory:");
  try {
    await db.prepare("INSERT INTO items (repo, number, kind, state, title, created_at, head_oid) VALUES ('photocraft', 7, 'pr', 'OPEN', 'Own item', '2026-01-01T00:00:00Z', ?)").run("a".repeat(40));
    await db.prepare("INSERT INTO repos (name, visibility) VALUES ('photocraft', 'public'), ('pdfcraft', 'private') ON CONFLICT (name) DO UPDATE SET visibility = excluded.visibility").run();
    const make = async (promptId: string, items: { repo: string; number: number }[], at: string, costUsd: number | null) => {
      const id = await insertRun(db, { jobId: null, step: "opus-review", stage: 5, promptId, promptVersion: "1", provider: "claude", model: "opus", items, prompt: "private prompt" });
      await finishRun(db, id, { state: "done", output: "private output", costUsd });
      await db.prepare("UPDATE agent_runs SET started_at = ?, ended_at = ? WHERE id = ?").run(at, at, id);
      return id;
    };
    const own = [{ repo: "photocraft", number: 7 }];
    const standalone = await make("classify", own, "2026-01-01T01:00:00Z", null);
    const review = await make("review.opus", own, "2026-01-01T02:00:00Z", 0.25);
    const mixed = await make("review.opus", [...own, { repo: "pdfcraft", number: 1 }], "2026-01-01T03:00:00Z", 2);
    const other = await make("classify", [{ repo: "photocraft", number: 8 }], "2026-01-01T01:30:00Z", 3);
    await db.prepare("INSERT INTO opus_review_history (repo, number, head_oid, at, model, mode, verdict, sure, reason) VALUES ('photocraft', 7, ?, '2026-01-01T04:00:00Z', 'opus', 'full', 'hold', 1, 'private reason')").run("a".repeat(40));
    const read = async (role: "viewer" | "maintainer" | "operator") => {
      const request = { ...req(7), user: { login: "reader", role, canWrite: async () => false, canRead: async (repo: string) => repo !== "pdfcraft" } };
      const page = await itemPage(db, request);
      assert.ok("timeline" in page);
      return page.timeline;
    };
    const staff = await read("maintainer");
    const calls = staff.flatMap((entry) => entry.calls);
    assert.deepEqual(new Set(calls.map((call) => call.runId)), new Set([standalone, review]));
    assert.equal(calls.find((call) => call.runId === standalone)?.costUsd, null);
    assert.equal(calls.find((call) => call.runId === review)?.costUsd, 0.25);
    assert.deepEqual(staff.find((entry) => entry.reviewId)?.calls.map((call) => call.runId), [review]);
    assert.ok(!JSON.stringify(staff).includes("private prompt") && !JSON.stringify(staff).includes("private output"));
    assert.deepEqual((await read("viewer")).flatMap((entry) => entry.calls), []);
    const operatorIds = (await read("operator")).flatMap((entry) => entry.calls.map((call) => call.runId));
    assert.ok(operatorIds.includes(mixed) && !operatorIds.includes(other));
  } finally { await db.close(); }
});
