// Opus conversations: the prompt keeps a stable start across turns, card validation, Do it runs once through fake writers,
// and viewers read but cannot write. Model calls go to a fake runner; GitHub to a fake querier.
import { cols } from "../src/db/kx.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { useTestAccount } from "./accounts-fixture.ts";
import { SCRATCH } from "./scratch.ts";
import { setCommentApproval } from "../src/act/approval.ts";
import { setApproval as setLabelApproval } from "../src/labels/approval.ts";
import { setRunner } from "../src/classify/run.ts";
import { applicableSteps, cleanComment, headline, parseReply } from "../src/conversations/cards.ts";
import { doCard } from "../src/conversations/act.ts";
import { addMessage, ensureConversation, insertTurn, staleOf, turnsOf } from "../src/conversations/store.ts";
import { answerPending } from "../src/conversations/run.ts";
import { ask, getDecision } from "../src/decisions.ts";
import { cleanReason } from "../src/act/templates.ts";
import { commentPreview } from "../src/act/index.ts";
import { apiRoutes } from "../src/dash/api/index.ts";
import * as conv from "../src/dash/api/conversations.ts";
import { HttpError } from "../src/dash/server/util.ts";
import { setInferenceMode } from "../src/remote/mode.ts";
import { parseStatus, storeStatus } from "../src/remote/helpers.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { allocation } from "../src/agents/call.ts";
import { setEnabled } from "../src/runner/autopilot.ts";
import type { Req } from "../src/dash/types.ts";
import type { Db } from "../src/db/index.ts";
import { connectDb } from "../src/db/open.ts";

mkdirSync(SCRATCH, { recursive: true });
const quiet = () => {};
const T0 = "2026-01-01T00:00:00Z";

async function fresh(): Promise<Db> {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "conv-test-")), "t.db"));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: T0, pipeline: 1 }).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.insertInto("repos").values({ name: "app", visibility: "public" }));
  await useTestAccount(db);
  const item = async (number: number, kind: string, title: string, head_oid: string | null) =>
    await db.run(db.k.insertInto("items").values({ repo: "app", number, kind, state: "OPEN", title, body: "Body text", author: "someone", head_oid, created_at: T0, updated_at: T0, labels: "[]" }));
  await item(1, "issue", "Issue 1", null);
  await item(2, "pr", "PR 2", "sha2");
  await item(3, "issue", "Issue 3", null);
  await ask(db, [{ id: "app#1:scope", kind: "scope", repo: "app", number: 1, question: "Scope?", options: [{ key: "take", label: "Wanted" }, { key: "close", label: "Out of scope" }] }]);
  await setCommentApproval(db, "op", "app", true);
  return db;
}

/** Answers every call with the next reply and records the prompts sent. */
function fakeModel(replies: string[], prompts: string[] = [], during?: () => Promise<void>) {
  let k = 0;
  const restore = setRunner(async (_cmd, _args, input) => {
    prompts.push(input);
    await during?.();
    return { code: 0, stdout: JSON.stringify({ type: "result", result: replies[Math.min(k++, replies.length - 1)], usage: { input_tokens: 10, output_tokens: 5 } }), stderr: "" };
  });
  return { prompts, restore };
}

const answerAll = (db: Db) => answerPending(db, { checkout: async () => null, usageRun: "conv-test", log: quiet });

describe("conversation prompt", () => {

});

describe("turn order and claims", () => {



});

describe("cards", () => {
  test("comment text loses entities that hide mentions, HTML, images and links", () => {
    assert.equal(cleanComment("Thanks &#64;bob and &commat;amy and &amp;#x40;cy"), "Thanks bob and amy and cy");
    assert.equal(cleanComment("See [the docs](https://x.test/a) <b>now</b> ![img](https://x.test/i.png) https://y.test/z"), "See the docs now");
    assert.equal(cleanComment("Line one\n\n\n\nLine two @team"), "Line one\n\nLine two team");
  });






  test("invalid resolutions are dropped with a note and valid ones get lines from the parameters", async () => {
    const db = await fresh();
    const R = (steps: unknown[], settle: unknown, extra: Record<string, unknown> = {}) => ({ kind: "resolution", steps, settle, ...extra });
    const reply = `Text.\n\`\`\`actions\n${JSON.stringify([
      { kind: "delete-everything" },
      { kind: "comment", text: "an old kind" },
      R([], { kind: "answer", option: "nope" }),
      R([{ kind: "label", label: "my own label" }], { kind: "backlog" }),
      R([{ kind: "label", label: "Plugin Candidate" }], { kind: "answer", option: "take" }),
      R([{ kind: "duplicate", of: 1 }], null),
      R([{ kind: "duplicate", of: 3 }], null),
      R([{ kind: "duplicate", of: 99 }], null),
      R([{ kind: "close", reason: "completed" }, { kind: "comment" }], null, { text: "Done." }),
      R([{ kind: "comment" }, { kind: "comment" }], { kind: "backlog" }, { text: "Twice." }),
      R([{ kind: "comment" }], { kind: "answer", option: "close" }, { text: "Closing." }),
      R([{ kind: "comment" }], { kind: "backlog" }, { text: "Thanks @bob, see the pack." }),
      R([{ kind: "comment" }], { kind: "answer", option: "take" }, { text: "Same option again." }),
      R([{ kind: "comment" }], { kind: "backlog" }, { text: "" }),
      R([{ kind: "label", label: "bugfix" }], null),
      R([{ kind: "comment" }], null, { text: "Which version?" }),
      R([{ kind: "comment" }], null, { text: "Second question?" }),
    ])}\n\`\`\``;
    const p = (await parseReply(db, "app", 1, reply))!;
    const kinds = p.cards.map((c) => JSON.stringify(c.params.kind === "resolution" ? [c.params.steps.map((x) => x.kind), c.params.settle?.kind ?? null] : null));
    assert.deepEqual(kinds, [
      '[["label"],"answer"]', '[["duplicate"],"handled"]', '[["comment"],"backlog"]', '[["comment"],null]',
    ]);
    assert.equal(p.notes.length, 13);
    assert.equal(p.cards[0]!.description, 'On app#1: Add the label "plugin candidate"; Answers the scope question with "Wanted"');
    assert.equal(p.cards[2]!.text, "Thanks bob, see the pack.");
    assert.equal(await parseReply(db, "app", 1, "```actions\n[]\n```"), null, "no text, no reply");
    assert.equal((await parseReply(db, "app", 1, "Hi\n```actions\nnot json\n```"))!.notes.length, 1);
    // No open decision: a settle is refused and steps alone are fine.
    const none = (await parseReply(db, "app", 3, `Hi\n\`\`\`actions\n${JSON.stringify([R([{ kind: "label", label: "bugfix" }], null), R([], { kind: "backlog" })])}\n\`\`\``))!;
    assert.equal(none.cards.length, 1);
    assert.equal(none.notes.length, 1);
  });

  test("a quiet pull request gets no card that posts model-written text", async () => {
    const db = await fresh();
    const R = (steps: unknown[], settle: unknown, extra: object = {}) => ({ kind: "resolution", steps, settle, ...extra });
    const reply = `Review found an unrelated defect.\n\`\`\`actions\n${JSON.stringify([
      R([{ kind: "label", label: "bugfix" }], null),
      R([{ kind: "open_issue", repo: "app", title: "Follow up", body: "details" }], null),
      R([{ kind: "comment" }], null, { text: "Which version?" }),
    ])}\n\`\`\``;
    assert.deepEqual((await parseReply(db, "app", 2, reply))!.cards.map((c) => c.params.kind === "resolution" ? c.params.steps.map((x) => x.kind).join() : ""), ["label", "open_issue"]);
    await db.run(db.k.insertInto("security_scans").values({ id: 900, repo: "app", state: "done", started_by: "op", started_at: T0 }));
    await db.run(db.k.insertInto("security_findings").values({ repo: "app", number: 900, scan_id: 900, area: "a", title: "t", severity: "high", urgent: 0, state: "landing", refs: "[]", reach: "r", impact: "i", fingerprint: "fp900", fix_pr: 2, created_at: T0, updated_at: T0 }));
    const p = (await parseReply(db, "app", 2, reply))!;
    assert.deepEqual(p.cards.map((c) => c.params.kind === "resolution" ? c.params.steps.map((x) => x.kind).join() : ""), ["label"]);
    assert.equal(p.notes.length, 2);
    assert.ok(!(await applicableSteps(db, "app", 2)).some((k) => k === "comment" || k === "open_issue" || k === "transfer"));
  });
});

describe("new step kinds", () => {
  const R = (steps: unknown[], settle: unknown = null, extra: Record<string, unknown> = {}) => ({ kind: "resolution", steps, settle, ...extra });
  const issue = { kind: "open_issue", repo: "lib", title: "Follow up", body: "Check the edge case." };
  const run = async (db: Db, n: number, cards: unknown[]) => (await parseReply(db, "app", n, `Text.\n\`\`\`actions\n${JSON.stringify(cards)}\n\`\`\``))!;

  test("transfer is for issues and last, an answer that writes takes open_issue but not a comment, fixup that merges needs a merge or scope decision", async () => {
    const db = await fresh();
    await db.run(db.k.insertInto("tracked_repos").values({ name: "lib", added_by: "op", added_at: T0, pipeline: 1 }));
    await ask(db, [{ id: "app#2:merge", kind: "merge", repo: "app", number: 2, question: "Merge?", options: [{ key: "merge", label: "Merge" }, { key: "hold", label: "Hold" }] }]);
    const p1 = await run(db, 3, [
      R([{ kind: "transfer", to: "lib" }]),
      R([{ kind: "transfer", to: "lib" }, { kind: "comment" }], null, { text: "Moved." }),
      R([{ kind: "transfer", to: "app" }]),
      R([{ kind: "comment" }, { kind: "transfer", to: "lib" }], null, { text: "Moving it." }),
      R([{ kind: "open_issue", repo: "nowhere", title: "x", body: "y" }]),
      R([{ kind: "review" }]),
    ]);
    assert.deepEqual(p1.cards.map((c) => c.params.kind === "resolution" ? c.params.steps.map((x) => x.kind).join("+") : ""), ["transfer", "comment+transfer"]);
    assert.equal(p1.notes.length, 4);
    // Issue 1 has the scope decision "close", which writes to GitHub.
    const p2 = await run(db, 1, [
      R([issue], { kind: "answer", option: "close" }),
      R([{ kind: "comment" }, issue], { kind: "answer", option: "close" }, { text: "Closing." }),
    ]);
    assert.equal(p2.cards.length, 1);
    assert.equal(p2.cards[0]!.description.includes('Open an issue in lib: "Follow up"'), true);
    const fix = (merge: boolean) => ({ kind: "fixup", instructions: "Rename the helper.", merge });
    const p3 = await run(db, 2, [R([fix(true)]), R([fix(false)], { kind: "answer", option: "hold" })]);
    assert.equal(p3.cards.length, 1, "the answer settle is refused with a fixup");
    assert.equal(p3.cards[0]!.params.kind === "resolution" && p3.cards[0]!.params.settle?.kind, "handled");
    assert.equal((await run(db, 3, [R([fix(true)])])).cards.length, 0, "an issue has no fix-up");
    const st3 = await applicableSteps(db, "app", 3), st2 = await applicableSteps(db, "app", 2);
    assert.ok(st3.includes("transfer") && !st3.includes("fixup") && !st3.includes("request_reviewers"));
    assert.ok(st2.includes("fixup with merge") && !st2.includes("transfer") && !st3.includes("fixup with merge"));
    await ensureConversation(db, "app", 3, "op");
    await db.run(db.k.updateTable("items").set({ state: "CLOSED" }).where("repo", "=", "app").where("number", "=", 3));
    await addMessage(db, "app", 3, { login: "op", kind: "operator" }, "Reopen it?", undefined, false);
    assert.ok((await turnsOf(db, "app", 3)).at(-1)!.block.includes("<steps>[") && (await applicableSteps(db, "app", 3)).includes("reopen"));
    const none = await run(db, 2, [R([{ kind: "fixup", instructions: "x", merge: true }, { kind: "request_reviewers", logins: ["someone"] }])]);
    assert.equal(none.cards.length, 0);
  });
});

describe("Do it", () => {
  test("a close card comments, closes with the state reason and answers the item's open decision as handled", async () => {
    const db = await fresh();
    const sent: { q: string; v: Record<string, unknown> }[] = [];
    const querier = { query: async (q: string, v: Record<string, unknown> = {}) => {
      sent.push({ q, v });
      return q.includes("issueOrPullRequest") ? { repository: { issueOrPullRequest: { __typename: "Issue", id: "I_1", state: "OPEN" } } } : {};
    } };
    const params = JSON.stringify({ kind: "close", reason: "completed", pr: false });
    const id = Number((await db.get(db.k.insertInto("conversation_cards").values({ turn_id: 0, repo: "app", number: 1, kind: "close", params, text: "Done in an earlier PR.", description: "x" }).returning("id")))!.id);
    const { card } = await doCard(db, id, "op", { querier: querier as never });
    assert.equal(card.state, "done", card.error ?? "");
    assert.ok(sent.some((x) => x.q.includes("closeIssue") && x.v.reason === "COMPLETED"));
    const d = (await db.get(db.k.selectFrom("decisions").select(["answer", "applied_at"]).where("id", "=", "app#1:scope")))!;
    assert.equal(d.answer, "handled");
    assert.ok(d.applied_at);
  });

  const resolution = async (db: Db, steps: unknown[], settle: unknown, text: string | null) => {
    const p = (await parseReply(db, "app", 1, `Text.\n\`\`\`actions\n${JSON.stringify([{ kind: "resolution", steps, settle, ...(text && { text }) }])}\n\`\`\``))!;
    assert.equal(p.cards.length, 1, p.notes.join("; "));
    return Number((await db.get(db.k.insertInto("conversation_cards")
      .values({ turn_id: 0, repo: "app", number: 1, kind: "resolution", params: JSON.stringify(p.cards[0]!.params), text: p.cards[0]!.text, description: p.cards[0]!.description }).returning("id")))!.id);
  };
  const github = (failLabel: boolean) => {
    const sent: string[] = [];
    const querier = { query: async (q: string) => {
      sent.push(q.includes("addComment") ? "comment" : q.includes("addLabelsToLabelable") ? "label" : q.includes("issueOrPullRequest") ? "read" : "other");
      if (q.includes("issueOrPullRequest")) return { repository: { issueOrPullRequest: { __typename: "Issue", id: "I_1", state: "OPEN" } } };
      if (q.includes("addComment")) return { addComment: { commentEdge: { node: { url: "https://x.test/c" } } } };
      if (q.includes("repository(")) return { repository: { id: "R_1", l0: { id: "L_1", name: "bugfix" }, l1: null } };
      if (failLabel) throw new Error("label add failed");
      return { m0: { clientMutationId: null } };
    } };
    return { sent, querier };
  };

  test("a card answering Out of scope with a reason makes the close comment carry it", async () => {
    const db = await fresh();
    const { querier } = github(false);
    const id = await resolution(db, [], { kind: "answer", option: "close", reason: "The reference app does not do this, so it stays out. See https://x.test/a @bob" }, null);
    const card = await doCard(db, id, "op", { querier: querier as never });
    assert.equal(card.card.state, "done", card.card.error ?? "");
    const comment = commentPreview((await getDecision(db, "app#1:scope"))!)!;
    assert.match(comment, /out of scope/);
    assert.match(comment, /Reason: The reference app does not do this, so it stays out\. See bob\./);
    assert.doesNotMatch(comment, /@|https/);
  });

  test("a transfer needs the comment approval of the target repository too", async () => {
    const db = await fresh();
    await db.run(db.k.insertInto("tracked_repos").values({ name: "lib", added_by: "op", added_at: T0, pipeline: 1 }));
    const sent: string[] = [];
    const querier = { query: async (q: string) => {
      if (q.includes("issueOrPullRequest")) return { repository: { issueOrPullRequest: { __typename: "Issue", id: "I_1", state: "OPEN" } } };
      sent.push(q.includes("transferIssue") ? "transfer" : "other");
      return q.includes("transferIssue") ? { transferIssue: { issue: { url: "https://x.test/lib/1" } } } : { repository: { id: "R_lib" } };
    } };
    const first = await doCard(db, await resolution(db, [{ kind: "transfer", to: "storytold/lib" }], null, null), "op", { querier: querier as never });
    assert.equal(first.card.state, "failed");
    assert.match(first.card.error ?? "", /lib/);
    assert.equal(sent.includes("transfer"), false);
    await setCommentApproval(db, "op", "lib", true);
    const second = await doCard(db, await resolution(db, [{ kind: "transfer", to: "lib" }], null, null), "op", { querier: querier as never });
    assert.equal(second.card.state, "done", second.card.error ?? "");
    assert.ok(sent.includes("transfer"));
  });

  test("a resolution runs its steps in order, then answers the decision with the operator's login; a failing step leaves it open", async () => {
    const ok = await fresh();
    await setLabelApproval(ok, "op", "app", true);
    const g = github(false);
    const id = await resolution(ok, [{ kind: "comment" }, { kind: "label", label: "bugfix" }], { kind: "answer", option: "take" }, "Thanks.");
    const { card } = await doCard(ok, id, "op", { querier: g.querier as never });
    assert.equal(card.state, "done", card.error ?? "");
    assert.deepEqual(g.sent.filter((x) => x === "comment" || x === "label"), ["comment", "label"]);
    const d = (await ok.get(ok.k.selectFrom("decisions").select(["answer", "answered_by"]).where("id", "=", "app#1:scope")))!;
    assert.deepEqual({ ...d }, { answer: "take", answered_by: "op" });

    const bad = await fresh();
    await setLabelApproval(bad, "op", "app", true);
    const b = github(true);
    const failed = (await doCard(bad, await resolution(bad, [{ kind: "comment" }, { kind: "label", label: "bugfix" }], { kind: "answer", option: "take" }, "Thanks."), "op", { querier: b.querier as never })).card;
    assert.equal(failed.state, "failed");
    assert.match(failed.error ?? "", /Already done: Post the comment below/);
    assert.equal((await bad.get(bad.k.selectFrom("decisions").select("answer").where("id", "=", "app#1:scope")))!.answer, null);
  });

  /** Stores an Opus turn with one proposed card (as a reply would) and returns the card's id. */
  const propose = async (db: Db, n: number, steps: unknown[], settle: unknown, text: string | null) => {
    await ensureConversation(db, "app", n, "op");
    const p = (await parseReply(db, "app", n, `Text.\n\`\`\`actions\n${JSON.stringify([{ kind: "resolution", steps, settle, ...(text && { text }) }])}\n\`\`\``))!;
    assert.equal(p.cards.length, 1, p.notes.join("; "));
    const turn = await insertTurn(db, "app", n, { kind: "opus", login: "opus", body: "Text.", block: "x", cards: p.cards });
    return Number((await db.get(db.k.selectFrom("conversation_cards").select("id").where("turn_id", "=", turn)))!.id);
  };

  test("skipped steps do not run, a card with nothing left is refused, a later reply replaces drafts and a PR change blocks them", async () => {
    const db = await fresh();
    await setLabelApproval(db, "op", "app", true);
    const g = github(false);
    const a = await propose(db, 1, [{ kind: "comment" }, { kind: "label", label: "bugfix" }], { kind: "answer", option: "take" }, "Thanks.");
    const done = (await doCard(db, a, "op", { querier: g.querier as never, skip: [0], note: "Because of the pack" })).card;
    assert.equal(done.state, "done", done.error ?? "");
    assert.deepEqual(g.sent.filter((x) => x === "comment" || x === "label"), ["label"]);
    assert.match(done.result ?? "", /skipped: Post the comment below/);
    const dec = (await db.get(db.k.selectFrom("decisions").select(["answer", "answer_note"]).where("id", "=", "app#1:scope")))!;
    assert.deepEqual({ ...dec }, { answer: "take", answer_note: "Because of the pack" });
    assert.ok((await db.get(db.k.selectFrom("conversation_turns").select("body").where("kind", "=", "system").where("number", "=", 1).orderBy("id", "desc").limit(1)))!.body.endsWith("Note: Because of the pack"));

    const ask = await propose(db, 3, [{ kind: "comment" }], null, "Which version?");
    await assert.rejects(() => doCard(db, ask, "op", { skip: [0] }), /no steps left/);
    await assert.rejects(() => doCard(db, ask, "op", { skip: [5] }), /step positions/);
    // A later Opus turn replaces the proposed draft.
    await propose(db, 3, [{ kind: "comment" }], null, "Which OS?");
    await assert.rejects(() => doCard(db, ask, "op"), /replaced by a later reply/);
    assert.equal((await db.get(db.k.selectFrom("conversation_cards").select("state").where("id", "=", ask)))!.state, "replaced");

    // After a push a card that does not rest on the code still runs; one with a drafted comment is refused.
    const light = await propose(db, 2, [{ kind: "label", label: "bugfix" }], null, null);
    await db.run(db.k.updateTable("items").set({ head_oid: "sha3" }).where("number", "=", 2));
    assert.equal((await doCard(db, light, "op", { querier: g.querier as never })).card.state, "done");
    const pr = await propose(db, 2, [{ kind: "comment" }], null, "Thanks.");
    await db.run(db.k.updateTable("items").set({ head_oid: "sha4" }).where("number", "=", 2));
    await assert.rejects(() => doCard(db, pr, "op", { querier: g.querier as never }), /PR changed since/);
    assert.equal((await conv.cardView(db, (await db.get(db.k.selectFrom("conversation_cards").select(cols("conversation_cards")).where("id", "=", pr)))!)).stale, "pr-changed");
  });

  test("a message with ask false is stored without a pending state and queues no Opus reply", async () => {
    const db = await fresh();
    await conv.postMessage(db, req("operator", { repo: "app", n: "3" }, { text: "Note for later", ask: false }));
    const row = (await db.get(db.k.selectFrom("conversation_turns").select(["status", "seq"]).where("repo", "=", "app").where("number", "=", 3)))!;
    assert.equal(row.status, null);
    assert.ok(row.seq);
    assert.equal((await db.get(db.k.selectFrom("conversation_turns").select((eb) => eb.fn.countAll<number>().as("n")).where("status", "=", "pending")))!.n, 0);
    // A shared maintainer post rides in the next asked turn once.
    await db.run(db.k.insertInto("decision_comments").values({ id: "c1", decision_id: "app#1:scope", login: "maint", at: T0, body: "I think it is fine @x" }));
    await conv.postInclude(db, req("operator", { repo: "app", n: "1" }, { source: "decision-comment:c1", on: true }));
    await conv.postMessage(db, req("operator", { repo: "app", n: "1" }, { text: "Look at this" }));
    const blocks = await db.all(db.k.selectFrom("conversation_turns").select("block").where("repo", "=", "app").where("number", "=", 1).where("kind", "=", "operator").orderBy("id"));
    assert.equal(blocks.filter((b) => b.block.includes('<included from="maintainer" login="maint"') && b.block.includes("I think it is fine ")).length, 1);
    assert.ok(!blocks[0]!.block.includes("@x"));
    // A source from another item's decision is refused.
    await db.run(db.k.insertInto("decisions").values({ id: "app#3:scope", kind: "scope", repo: "app", number: 3, question: "Scope?", options: "[]", asked_at: T0 }));
    await db.run(db.k.insertInto("decision_comments").values({ id: "c3", decision_id: "app#3:scope", login: "maint", at: T0, body: "Other item" }));
    await assert.rejects(() => conv.postInclude(db, req("operator", { repo: "app", n: "1" }, { source: "decision-comment:c3", on: true })), (e) => e instanceof HttpError && e.status === 400);
    // The next asked message carries nothing again.
    await db.run(db.k.updateTable("conversation_turns").set({ status: "answered" }).where("repo", "=", "app").where("number", "=", 1));
    await conv.postMessage(db, req("operator", { repo: "app", n: "1" }, { text: "And now?" }));
    const last = (await db.get(db.k.selectFrom("conversation_turns").select("block").where("repo", "=", "app").where("number", "=", 1).where("kind", "=", "operator").orderBy("id", "desc").limit(1)))!;
    assert.ok(last.block.includes("And now?") && !last.block.includes("<included"));
    await assert.rejects(() => conv.postInclude(db, req("operator", { repo: "app", n: "1" }, { source: "decision-comment:c1", on: false })), (e) => e instanceof HttpError && e.status === 409);
    // A question can follow at once.
    await conv.postMessage(db, req("operator", { repo: "app", n: "3" }, { text: "What do you think?" }));
    assert.equal((await db.get(db.k.selectFrom("conversation_turns").select((eb) => eb.fn.countAll<number>().as("n")).where("status", "=", "pending").where("number", "=", 3)))!.n, 1);
  });
});

function req(role: "operator" | "viewer", params: Record<string, string>, json?: unknown): Req {
  return { method: "POST", path: "", params, query: new URLSearchParams(), form: new URLSearchParams(), json, csrf: "", nonce: "",
    user: { login: role === "operator" ? "op" : "view", role, canWrite: async () => role === "operator", canRead: async () => true } };
}

describe("access", () => {
  test("a viewer reads the conversation and cannot write; chat routes are operator-only", async () => {
    const db = await fresh();
    const { restore } = fakeModel(["Reply.\n```choices\n{\"pick\":{\"core\":null,\"reason\":null},\"ask\":{\"text\":\"Which version do you run?\"}}\n```"]);
    try {
      await conv.postMessage(db, req("operator", { repo: "app", n: "1" }, { text: "Hi" }));
      await answerAll(db);
    } finally {
      restore();
    }
    const view = await conv.getConversation(db, req("viewer", { repo: "app", n: "1" }));
    assert.equal(view.exists, true);
    assert.deepEqual(view.turns.map((t) => t.login), ["op", "opus"]);
    assert.equal(view.turns[1]!.actions[0]!.state, "proposed");
    const cardId = String(view.turns[1]!.actions[0]!.id);
    for (const f of [
      () => conv.postMessage(db, req("viewer", { repo: "app", n: "1" }, { text: "Hi" })),
      () => conv.doIt(db, req("viewer", { id: cardId })),
      () => conv.dismiss(db, req("viewer", { id: cardId })),
      () => conv.editCardText(db, req("viewer", { id: cardId }, { text: "x" })),
      () => conv.postInclude(db, req("viewer", { repo: "app", n: "1" }, { source: "decision-comment:1", on: true })),
    ]) await assert.rejects(f, (e) => e instanceof HttpError && e.status === 403);
    assert.equal((await db.get(db.k.selectFrom("conversation_cards").select("state")))!.state, "proposed");
    const writes = apiRoutes().filter((r) => r.method === "POST" && /conversation/.test(r.pattern));
    assert.equal(writes.length, 8);
    // No route is operator-only: messages, includes and the card routes check who may write or settle in the handler (refused for the viewer above).
    assert.deepEqual(writes.filter((r) => r.operator === true).map((r) => r.pattern), []);
    // A second message while Opus has not answered the first is refused.
    await conv.postMessage(db, req("operator", { repo: "app", n: "1" }, { text: "More" }));
    await assert.rejects(() => conv.postMessage(db, req("operator", { repo: "app", n: "1" }, { text: "Again" })), (e) => e instanceof HttpError && e.status === 409);
  });
});

describe("maintainers talk to Opus", () => {
  test("a maintainer asks Opus only with write access, on users' own Task Runners, with the pipeline on and a ready runner of theirs; a post without Opus needs only the first two", async () => {
    const db = await fresh();
    const maint = (write: boolean, json: unknown): Req => ({ ...req("viewer", { repo: "app", n: "1" }, json), user: { login: "maint", role: "maintainer", canWrite: async () => write, canRead: async () => true } });
    const refused = async (r: Req, status: number, re?: RegExp) => await assert.rejects(() => conv.postMessage(db, r), (e) => e instanceof HttpError && e.status === status && (!re || re.test(e.message)));
    await refused(maint(true, { text: "Hi" }), 403, /write in conversations/);
    await setInferenceMode(db, "user-local", "test");
    await refused(maint(false, { text: "Hi" }), 403, /write in conversations/);
    await refused(maint(true, { text: "Hi" }), 409, /pipeline is off/);
    await setEnabled(db, true, "test");
    await refused(maint(true, { text: "Hi" }), 409, /Task Runner must be connected and ready/);
    const view = await conv.postMessage(db, maint(true, { text: "A note", ask: false }));
    assert.equal(view.canTalk, true);
    assert.deepEqual(view.turns.map((t) => [t.kind, t.login]), [["maintainer", "maint"]]);
  });
});

describe("maintainers' messages wait and are withdrawn", () => {
  test("a maintainer's message no runner of theirs took in time waits again, uncounted; they or an operator withdraw one, another maintainer cannot", async () => {
    const db = await fresh();
    await setInferenceMode(db, "user-local", "test");
    await db.run(db.k.insertInto("access").values({ login: "maint", role: "maintainer" }));
    const token = (await createToken(db, "maint", "runner", { kind: "runner" })).row.id;
    await storeStatus(db, token, "maint", parseStatus({ slots: 2, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus", small: "haiku" }, reserve: { fiveHour: 0, weekly: 0 } }));
    await addMessage(db, "app", 1, { login: "maint", kind: "maintainer" }, "Is this in scope?");
    const turn = async () => (await db.get(db.k.selectFrom("conversation_turns").select(["status", "error"]).where("number", "=", 1).where("kind", "=", "maintainer").orderBy("id", "desc").limit(1)))!;
    let handled = 0;
    const was = allocation.pollMs;
    allocation.pollMs = 10;
    try {
      assert.equal(await answerPending(db, { kind: "maintainer", ownWaitMs: 50, checkout: async () => null, usageRun: "t", log: quiet, onHandled: () => void handled++ }), 0);
    } finally {
      allocation.pollMs = was;
    }
    assert.equal((await turn()).status, "pending");
    assert.equal(handled, 0, "a message given back is no work done");
    const as = (login: string, role: "maintainer" | "operator"): Req => ({ ...req("viewer", { repo: "app", n: "1" }), user: { login, role, canWrite: async () => true, canRead: async () => true } });
    assert.equal((await conv.getConversation(db, as("maint", "maintainer"))).canWithdraw, true);
    await assert.rejects(() => conv.postWithdraw(db, as("someone", "maintainer")), (e) => e instanceof HttpError && e.status === 403);
    const view = await conv.postWithdraw(db, as("maint", "maintainer"));
    assert.equal(view.pending, false);
    assert.match((await turn()).error ?? "", /withdrawn by maint/);
    await addMessage(db, "app", 1, { login: "maint", kind: "maintainer" }, "And now?");
    await conv.postWithdraw(db, as("op", "operator"));
    assert.equal((await turn()).status, "failed");
    assert.equal((await conv.getConversation(db, as("op", "operator"))).canWithdraw, false, "nothing waits any more");
  });

  test("withdrawing a turn that is being answered withdraws its model call", async () => {
    const db = await fresh();
    await db.run(db.k.insertInto("access").values({ login: "maint", role: "maintainer" }));
    await addMessage(db, "app", 1, { login: "maint", kind: "maintainer" }, "Is this in scope?");
    const { claimPending, withdrawTurn } = await import("../src/conversations/store.ts");
    assert.ok(await claimPending(db, "app", 1));
    const call = (id: number, forLogin: string, number: number) => ({ id, step: "conversation", stage: 0, max_attempts: 1, timeout_ms: 1, prompt_id: "conversation.turn", prompt_version: "1", tier: "top", effort: "medium", asked_model: "opus", bundle: "{}", state: "leased", items: JSON.stringify([{ repo: "app", number }]), repo: "app", class: 0, level: 0, since: 1, seen_at: 1, for_login: forLogin });
    await db.run(db.k.insertInto("main.remote_calls").values([call(901, "Maint", 1), call(902, "other", 1), call(903, "maint", 2)] as never));
    await withdrawTurn(db, "app", 1, { login: "maint", operator: false });
    const state = async (id: number) => (await db.get(db.k.selectFrom("main.remote_calls").select("state").where("id", "=", id)))!.state;
    assert.equal(await state(901), "failed");
    assert.equal(await state(902), "leased", "another login's call is left");
    assert.equal(await state(903), "leased", "another item's call is left");
  });
});

describe("Opus starts a conversation", () => {
});

describe("stale cards", () => {
  test("review bots and our own note-line posts do not make a card stale; a person's comment does", async () => {
    const db = await fresh();
    const add = async (id: string, at: string, author: string, body: string) =>
      await db.run(db.k.insertInto("comments").values({ repo: "app", number: 1, id, kind: "comment", author, created_at: at, body }));
    await add("c1", "2026-01-02T00:00:00Z", "alice", "first");
    const seen = JSON.stringify({ head: null, last_comment: "c1" });
    assert.equal(await staleOf(db, "app", 1, seen), undefined);
    await add("c2", "2026-01-02T01:00:00Z", "coderabbitai", "review summary");
    await add("c3", "2026-01-02T02:00:00Z", "alice", "_AI-generated review (Opus). Not a maintainer decision._\n\nLooks fine");
    await add("c4", "2026-01-02T03:00:00Z", "alice", "_Automated message. Not a maintainer decision._\n\nHello");
    assert.equal(await staleOf(db, "app", 1, seen), undefined);
    await add("c5", "2026-01-02T04:00:00Z", "bob", "what about X?");
    assert.equal(await staleOf(db, "app", 1, seen), "new-comments");
  });
});

describe("cleanReason", () => {
  test("cuts at a sentence end or a word boundary, never inside a word", () => {
    const long = "The change reworks the fonts toast and a Save As filename field in ways nobody asked for. It also touches the layout of the panel and renames several unrelated helper functions across the code base without tests";
    const a = cleanReason(long)!;
    assert.equal(a, "The change reworks the fonts toast and a Save As filename field in ways nobody asked for.");
    const b = cleanReason(long.replace(/\. /, ", "))!;
    assert.ok(b.length <= 200 && b.endsWith("…"), b);
    assert.ok(long.replace(/\. /, ", ").includes(b.slice(0, -1)));
    assert.match(long, new RegExp(`${b.slice(0, -1).split(" ").pop()}\\b`));
    assert.equal(cleanReason("short one"), "short one.");
  });
});

describe("card headline", () => {
  test("names the action with its key parameter", async () => {
    const db = await connectDb(":memory:");
    const res = (steps: import("../src/conversations/cards.ts").Step[]) => ({ kind: "resolution" as const, steps, settle: null });
    assert.equal(await headline(db, res([{ kind: "close", reason: "completed", pr: false }])), "Close issue as completed");
    assert.equal(await headline(db, res([{ kind: "close", reason: "not_planned", pr: false }])), "Close issue as not planned");
    assert.equal(await headline(db, res([{ kind: "close", reason: "completed", pr: true }])), "Close PR");
    assert.equal(await headline(db, res([{ kind: "duplicate", of: 12 }])), "Close as duplicate of #12");
    assert.equal(await headline(db, res([{ kind: "transfer", to: "storytold/x" }])), "Move issue to storytold/x");
  });
});
