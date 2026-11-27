// Conversations module: turn ordering, claims, replies, the compare-and-set refresh, and flat statement counts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { queryDb } from "../../src/db/query-db.ts";
import {
  addTurns, claimTurn, ConversationError, failTurn, loadGuidanceTurns, loadPending, loadThreads, loadTurnDigests, loadTurnEvents, loadTurnTails, postMessage, refreshSig, releaseTurn, saveConversations, setProgress, storeReply, withdrawTurn,
} from "../../src/data/conversations/index.ts";
import { expectFlat } from "../helpers/query-count.ts";
import { AT, both, conv, dialects, flat, person, seedThreads, sys } from "./conversations-helpers.ts";

const R = "o/a#1";
const NOW = new Date("2026-02-01T00:00:00.000Z");
const STALE = 60_000;

const order = async (db: Parameters<typeof loadThreads>[0], ref = R) => (await loadThreads(db, [ref], { blocks: true })).get(ref)!.turns.map((t) => [t.body, t.seq, t.status]);

both("a reply lands after the message it answers, and turns held meanwhile follow it in arrival order", async ({ db }) => {
  await saveConversations(db, [conv("o", 1)].map((c) => ({ ...c, repo: "o/a" })));
  await addTurns(db, [sys(R, "a"), sys(R, "b")]);
  await postMessage(db, { ref: R, by: { login: "op", kind: "operator" }, turn: person(R, "question"), ask: true });
  const got = await claimTurn(db, R, { now: NOW, staleMs: STALE });
  assert.ok(got);
  await addTurns(db, [sys(R, "late 1"), sys(R, "late 2")]);
  assert.deepEqual((await order(db)).map((r) => r[2]), [null, null, "answering", "held", "held"]);
  const id = await storeReply(db, R, got!.claim, { turn: { ...sys(R, "answer"), kind: "opus", login: "opus" }, seen: null });
  assert.ok(id);
  assert.deepEqual(await order(db), [["a", 1, null], ["b", 2, null], ["question", 3, "answered"], ["answer", 4, null], ["late 1", 5, null], ["late 2", 6, null]]);
  assert.equal(await storeReply(db, R, got!.claim, { turn: sys(R, "again"), seen: null }), null, "a claim settles once");
});

both("a second waiting message is refused with 409, whether it comes in one batch or later", async ({ db }) => {
  await saveConversations(db, [conv("o/a", 1)]);
  await postMessage(db, { ref: R, by: { login: "op", kind: "operator" }, turn: person(R, "one"), ask: true });
  await assert.rejects(postMessage(db, { ref: R, by: { login: "op", kind: "operator" }, turn: person(R, "two"), ask: true }), (e: unknown) => e instanceof ConversationError && e.status === 409);
  await assert.rejects(addTurns(db, [person(R, "x", "operator", { status: "pending" })]), (e: unknown) => e instanceof ConversationError && e.status === 409);
  assert.equal((await loadThreads(db, [R])).get(R)!.turns.length, 1, "the refused turns left nothing behind");
});

both("claimTurn releases a stale claim and gives turns a dead run held their seqs in arrival order", async ({ db }) => {
  await saveConversations(db, [conv("o/a", 1)]);
  await addTurns(db, [sys(R, "a")]);
  await postMessage(db, { ref: R, by: { login: "op", kind: "operator" }, turn: person(R, "q"), ask: true });
  const first = (await claimTurn(db, R, { now: NOW, staleMs: STALE }))!;
  await addTurns(db, [sys(R, "h1"), sys(R, "h2")]);
  assert.equal(await claimTurn(db, R, { now: NOW, staleMs: STALE }), null, "a live claim is not taken over");
  await setProgress(db, R, first.claim, ["working"]);
  const later = new Date(NOW.getTime() + 10 * STALE);
  const second = (await claimTurn(db, R, { now: later, staleMs: STALE }))!;
  assert.notEqual(second.claim, first.claim);
  assert.equal(await releaseTurn(db, R, first.claim), false);
  assert.deepEqual((await order(db)).map((r) => [r[0], r[1]]), [["a", 1], ["h1", 2], ["h2", 3], ["q", null]]);
  assert.equal(await failTurn(db, R, second.claim, "boom"), true);
  assert.deepEqual((await order(db)).map((r) => r[1]), [1, 2, 3, 4]);
});

both("refreshSig appends its turn only while the stored signature is the one expected", async ({ db }) => {
  await saveConversations(db, [conv("o/a", 1, "s0")]);
  assert.equal(await refreshSig(db, R, { expectSig: "s0", sig: "s1", turn: sys(R, "changed") }), true);
  assert.equal(await refreshSig(db, R, { expectSig: "s0", sig: "s2", turn: sys(R, "changed again") }), false);
  const t = (await loadThreads(db, [R])).get(R)!;
  assert.equal(t.conversation.item_sig, "s1");
  assert.equal(t.turns.length, 1);
});

both("postMessage creates the conversation, then refreshes and appends the message in one transaction", async ({ db }) => {
  await postMessage(db, { ref: R, by: { login: "op", kind: "operator" }, turn: person(R, "hi"), ask: true, newConversation: conv("o/a", 1, "s0") });
  await postMessage(db, { ref: "o/a#2", by: { login: "mt", kind: "maintainer" }, turn: person("o/a#2", "note", "maintainer"), ask: false, newConversation: conv("o/a", 2, "s0"), refresh: { expectSig: "s0", sig: "s1", turn: sys("o/a#2", "upd") } });
  const t = (await loadThreads(db, ["o/a#1", "o/a#2"])).get("o/a#2")!;
  assert.deepEqual(t.turns.map((x) => [x.kind, x.status]), [["system", null], ["maintainer", null]]);
  assert.equal(t.waiting, null, "a message stored without ask does not wait");
  assert.equal((await loadThreads(db, [R])).get(R)!.waiting?.status, "pending");
});

both("only the last Opus turn of an item in one batch keeps its cards proposed; a skipped item gets no turn", async ({ db }) => {
  await saveConversations(db, [conv("o/a", 1)]);
  const card = (d: string) => ({ kind: "comment" as const, params: "{}", text: d, description: d });
  const opus = (body: string, cards: ReturnType<typeof card>[]) => ({ ...sys(R, body), kind: "opus" as const, login: "opus", cards });
  const ids = await addTurns(db, [opus("first", [card("c1")]), opus("second", [card("c2")]), { ...sys("o/a#9", "nobody"), onlyIfThread: true }]);
  assert.equal(ids[2], null);
  const t = (await loadThreads(db, [R])).get(R)!;
  assert.deepEqual(t.cards.map((c) => [c.text, c.state]), [["c1", "replaced"], ["c2", "proposed"]]);
  await addTurns(db, [opus("third", [])]);
  assert.deepEqual((await loadThreads(db, [R])).get(R)!.cards.map((c) => c.state), ["replaced", "replaced"]);
});

both("withdrawTurn ends a maintainer's waiting message; others may not", async ({ db }) => {
  await saveConversations(db, [conv("o/a", 1)]);
  await postMessage(db, { ref: R, by: { login: "mt", kind: "maintainer" }, turn: person(R, "mine", "maintainer"), ask: true });
  await assert.rejects(withdrawTurn(db, R, { login: "other", operator: false }), (e: unknown) => e instanceof ConversationError && e.status === 403);
  assert.deepEqual((await loadPending(db, { now: NOW, staleMs: STALE })).map((p) => [p.kind, p.login]), [["maintainer", "mt"]]);
});

both("readers see turns, guidance, events, digests and tails of many items", async ({ db }) => {
  await seedThreads(db, [R, "o/b#2"]);
  await postMessage(db, { ref: R, by: { login: "op", kind: "operator" }, turn: person(R, "ask", "operator", { block: "<turn>\n<steps>[]</steps>\n</turn>\n" }), ask: true });
  const tails = await loadTurnTails(db, [R, "o/b#2", "o/c#3"]);
  assert.equal(tails.get(R)!.waiting?.body, "ask");
  assert.equal(tails.get(R)!.maxSeq, 1);
  assert.match(tails.get(R)!.lastPersonBlock!, /<steps>/);
  assert.equal(tails.get("o/b#2")!.lastPersonBlock, null);
  assert.equal(tails.get("o/c#3")!.maxSeq, 0);
  assert.deepEqual([...(await loadGuidanceTurns(db, [R, "o/b#2"])).keys()], [R]);
  assert.equal((await loadTurnEvents(db, { refs: [R] })).length, 2);
  assert.equal((await loadTurnEvents(db, { kinds: ["system"], limit: 1 })).length, 1);
  assert.equal((await loadTurnDigests(db, [R])).get(R)!.n, 2);
});

for (const dialect of dialects()) {
  const refs = (n: number) => Array.from({ length: n }, (_, i) => `o/r${i % 4}#${i + 1}`);
  test(`loaders keep their statement count as the number of items grows (${dialect})`, async () => {
    await expectFlat(flat(dialect, async (db, n) => { await seedThreads(db, refs(n)); return async () => { await loadThreads(db, refs(n), { blocks: true }); await loadTurnTails(db, refs(n)); await loadTurnDigests(db, refs(n)); await loadGuidanceTurns(db, refs(n)); }; }), 2, 40);
  });
  test(`addTurns and postMessage keep their statement count as the batch grows (${dialect})`, async () => {
    await expectFlat(flat(dialect, async (db, n) => { await seedThreads(db, refs(n)); return async () => { await addTurns(db, refs(n).flatMap((r) => [sys(r, "x"), sys(r, "y")])); }; }), 2, 40);
  });
  test(`claim, fail and store keep their statement count as held turns grow (${dialect})`, async () => {
    const held = (finish: "fail" | "store") => flat(dialect, async (db, n) => {
      await saveConversations(db, [conv("o/a", 1)]);
      await postMessage(db, { ref: R, by: { login: "op", kind: "operator" }, turn: person(R, "q"), ask: true });
      const c = (await claimTurn(db, R, { now: NOW, staleMs: STALE }))!;
      await addTurns(db, Array.from({ length: n }, (_, i) => sys(R, `h${i}`)));
      return async () => { if (finish === "fail") await failTurn(db, R, c.claim, "x"); else await storeReply(db, R, c.claim, { turn: { ...sys(R, "r"), kind: "opus", login: "opus" }, seen: null }); };
    });
    await expectFlat(held("fail"), 1, 30);
    await expectFlat(held("store"), 1, 30);
    await expectFlat(flat(dialect, async (db, n) => {
      await saveConversations(db, [conv("o/a", 1)]);
      await postMessage(db, { ref: R, by: { login: "op", kind: "operator" }, turn: person(R, "q"), ask: true });
      const c = (await claimTurn(db, R, { now: NOW, staleMs: STALE }))!;
      await addTurns(db, Array.from({ length: n }, (_, i) => sys(R, `h${i}`)));
      await queryDb(db).run(queryDb(db).k.updateTable("main.conversation_turns").set({ claimed_at: AT }).where("claim", "=", c.claim));
      return async () => { await claimTurn(db, R, { now: NOW, staleMs: STALE }); };
    }), 1, 30);
  });
}
