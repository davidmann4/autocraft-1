// The plan step's reply handling: a plan that is not ready asks its author question and leaves the attempt waiting on it;
// a reply that breaks the format is refused rather than guessed at. Our own comment does not count as the author's answer,
// and a stuck attempt's blocker answered Open as draft PR hands the attempt to the PR step.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePlanReply, recordPlan } from "../src/implement/plan.ts";
import { currentImplementation, roundsOf, startImplementation } from "./implement-rows.ts";
import type { PlanReply, QuestionRound } from "../src/implement/types.ts";
import { join } from "node:path";
import { connectDb } from "./helpers/raw-db.ts";
import { OPERATOR, tmpdir, world } from "./world-db.ts";
import { loadItemFact } from "../src/core/issue-facts.ts";
import { rememberSlug } from "../src/github/identity.ts";
import { applyStuckAnswer, markStuck, opensAsDraft, STUCK_OPTIONS, type StuckQuestion } from "../src/implement/stuck.ts";
import { implementationById } from "./implement-rows.ts";
import { recordAnswers } from "../src/data/implement/index.ts";
import { attemptNow } from "../src/implement/attempt.ts";
import { setFeature } from "../src/build/features.ts";
import { textHash } from "../src/core/open-prs.ts";

const notReady: PlanReply = {
  ready: false, kind: "bugfix", summary: "The export dialog should reopen in the last folder.", plan: "Found the dialog in src/export.rs; the folder is not stored.",
  acceptance: [], verification: { tests: [], app: null }, size: "S", risks: [],
  questions: [{ audience: "author", text: "Which version shows this, and does it happen with every file type?", options: [], recommended: null }],
};

test("a plan with an author question posts it once and leaves the attempt asked on that question", async () => {
  const db = await connectDb(join(tmpdir("implement-plan"), "t.db"));
  try {
    const impl = await startImplementation(db, { repo: "app", number: 7, queuedBy: "maint", textHash: "h" });
    const posted: string[] = [];
    const state = await recordPlan(db, impl, { callId: 41, reply: notReady }, {
      commentsApproved: true, postComment: async (text) => { posted.push(text); return "123"; }, log: () => {},
    });
    assert.equal(state, "asked");
    assert.equal(posted.length, 1);
    assert.ok(posted[0]!.includes(notReady.questions[0]!.text));
    const row = await currentImplementation(db, "app", 7);
    assert.equal(row?.state, "asked");
    assert.equal(row?.plan?.ready, false);
    const qs = (await roundsOf(db, impl.id)).filter((r) => r.kind === "question").map((r) => r.result as QuestionRound);
    assert.deepEqual(qs.map((q) => [q.audience, q.commentId]), [["author", "123"]]);
  } finally {
    await db.close();
  }
});

test("a malformed plan reply is refused with what is wrong", () => {
  const ok = JSON.stringify(notReady);
  assert.equal(parsePlanReply(`Here it is:\n\`\`\`json\n${ok}\n\`\`\``).ready, false);
  assert.throws(() => parsePlanReply(JSON.stringify({ ...notReady, questions: [] })), /questions/);
  assert.throws(() => parsePlanReply(JSON.stringify({ ...notReady, questions: [{ ...notReady.questions[0], audience: "maintainer" }] })), /options/);
  assert.throws(() => parsePlanReply(`${ok.slice(0, -1)}`), /JSON/);
  assert.throws(() => parsePlanReply(ok, true), /assume/);
});

test("our own comment under the app identity does not wake an asked attempt; the author's reply does", async () => {
  const w = await (await (await world()).repo()).issue(7);
  const db = w.db;
  const impl = await startImplementation(db, { repo: "app", number: 7, queuedBy: OPERATOR, textHash: "h" });
  await recordPlan(db, impl, { callId: 41, reply: notReady }, { commentsApproved: true, postComment: async () => "123", log: () => {} });
  await rememberSlug(db, "craft-bot");
  const comment = (id: string, author: string) => db.run(db.k.insertInto("comments").values({ repo: "app", number: 7, id, kind: "comment", author, created_at: "2099-01-01T00:00:00Z", body: "text" }));
  const woken = async () => (await loadItemFact(db, "app", 7))!.implement.row!.newCommentAfterQuestion;
  await comment("C1", "craft-bot");
  assert.equal(await woken(), false, "the mirror stores the app's comments under its bare slug");
  await comment("C2", "someone");
  assert.equal(await woken(), true);
});

test("a stuck attempt's blocker answered Open as draft PR hands it to the PR step as a draft; an answer it does not offer is asked again", async () => {
  const w = await (await (await world()).repo()).issue(7);
  const db = w.db;
  await setFeature(db, "implement", true, OPERATOR, "app");
  const it = (await db.get(db.k.selectFrom("items").select(["title", "body"]).where("repo", "=", "app").where("number", "=", 7)))!;
  const impl = await startImplementation(db, { repo: "app", number: 7, queuedBy: OPERATOR, textHash: textHash(it.title ?? "", it.body ?? "") });
  await markStuck(db, impl, "blocked", "the session could not finish", { diffCheck: async () => ({ ok: true }) });
  const blocker = async () => (await attemptNow(db, impl))!.rounds.filter((r) => r.kind === "question").at(-1)!;
  const first = await blocker();
  assert.deepEqual((first.result as StuckQuestion).options!.map((o) => o.key), [STUCK_OPTIONS.tryAgain.key, STUCK_OPTIONS.draft.key]);

  await recordAnswers(db, [{ id: impl.id, question: first.id, by: OPERATOR, via: "github", option: "close-issue" }]);
  const refused = await applyStuckAnswer(db, (await attemptNow(db, impl))!);
  assert.match(refused!.did, /asked again/);
  const second = await blocker();
  assert.ok(second.id > first.id, "the answer that cannot be carried out no longer stands");
  assert.equal(await applyStuckAnswer(db, (await attemptNow(db, impl))!), null);

  await recordAnswers(db, [{ id: impl.id, question: second.id, by: OPERATOR, via: "github", option: STUCK_OPTIONS.draft.key }]);
  const r = await applyStuckAnswer(db, (await attemptNow(db, impl))!);
  assert.match(r!.did, /draft/);
  assert.equal((await implementationById(db, impl.id))!.state, "opening");
  assert.ok(opensAsDraft((await attemptNow(db, impl))!.rounds));
});
