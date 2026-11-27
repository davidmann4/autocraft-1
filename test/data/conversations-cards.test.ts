// Conversations module: the card queue and its writers, held follow-ups, and owner statements.
import assert from "node:assert/strict";
import { test } from "node:test";
import { queryDb } from "../../src/db/query-db.ts";
import {
  addHeld, addTurns, collectStatements, failCards, loadCards, loadHeld, loadQueue, loadStatementPools, loadStatements, loadStatementViews, loadStatementWork, markCard, markHeld, saveConversations, setStatementVectors,
  sweepRunningCards,
} from "../../src/data/conversations/index.ts";
import { statementSources } from "../../src/data/conversations/statements.ts";
import { statementsDue } from "../../src/memory/statements.ts";
import { expectFlat } from "../helpers/query-count.ts";
import { AT, both, conv, dialects, flat, openApp, person } from "./conversations-helpers.ts";

const card = (n: number, o: { repo?: string; state?: string; queued_at?: string | null; acted_at?: string | null } = {}) => ({
  turn_id: 1, repo: o.repo ?? "o/a", number: n, kind: "comment", params: "{}", text: null, description: `card ${n}`, state: o.state ?? "queued", queued_at: o.queued_at === undefined ? AT : o.queued_at, acted_at: o.acted_at ?? null,
});
const seedCards = async (db: Parameters<typeof loadQueue>[0], rows: ReturnType<typeof card>[]) => { const q = queryDb(db); await q.run(q.k.insertInto("main.conversation_cards").values(rows)); };

both("the queue runs higher rank level first, then the earlier press (none first), then id; place follows that order", async ({ db }) => {
  const q = queryDb(db);
  await seedCards(db, [card(1, { queued_at: "2026-01-02T00:00:00.000Z" }), card(2, { queued_at: AT }), card(3, { queued_at: null }), card(4, { queued_at: AT }), card(5, { state: "proposed" })]);
  await q.run(q.k.insertInto("main.item_rank").values({ repo: "o/a", number: 4, score: 40000, breakdown: "{}", computed_at: AT }));
  const queue = await loadQueue(db, { all: true });
  assert.deepEqual(queue.rows.map((r) => [r.number, r.place]), [[4, 1], [3, 2], [2, 3], [1, 4]]);
  assert.equal(queue.blocked.size, 0);
});

both("markCard moves a card only from the states given; failCards and the sweep end the rest", async ({ db }) => {
  await seedCards(db, [card(1, { state: "proposed" }), card(2), card(3, { state: "running", acted_at: "2026-01-01T00:00:00.000Z" }), card(4, { state: "running", acted_at: "2026-03-01T00:00:00.000Z" })]);
  const ids = [...(await loadCards(db, [1, 2, 3, 4])).keys()];
  assert.equal(await markCard(db, ids[0]!, ["proposed"], { state: "queued", acted_by: "op", queued_at: AT }), true);
  assert.equal(await markCard(db, ids[0]!, ["proposed"], { state: "dismissed" }), false);
  assert.equal(await markCard(db, ids[1]!, ["queued", "proposed"], { text: "edited", edited_by: "op", error: null }), true);
  assert.equal(await failCards(db, [ids[0]!, ids[1]!, ids[2]!], "no room", AT, "queued"), 2);
  assert.equal(await sweepRunningCards(db, "2026-02-01T00:00:00.000Z"), 1);
  const now = await loadCards(db, ids);
  assert.deepEqual(ids.map((i) => now.get(i)!.state), ["failed", "failed", "failed", "running"]);
  assert.equal(now.get(ids[1]!)!.text, "edited");
});

for (const dialect of dialects()) {
  test(`the queue and card loads keep their statement count as cards grow (${dialect})`, async () => {
    await expectFlat(flat(dialect, async (db, n) => {
      await seedCards(db, Array.from({ length: n }, (_, i) => card(i + 1, { repo: `o/r${i % 5}` })));
      return async () => { await loadQueue(db, { all: true }); await loadCards(db, Array.from({ length: n }, (_, i) => i + 1)); };
    }), 2, 40);
  });
  test(`held follow-up writes keep their statement count as rows grow (${dialect})`, async () => {
    await expectFlat(flat(dialect, async (db, n) => {
      const rows = Array.from({ length: n }, (_, i) => ({ card_id: 1, workflow_id: 7, approved_at: AT, repo: `o/r${i % 3}`, number: i + 1, issue_repo: "o/x", title: `t${i}`, body: "b", by: "op", at: AT }));
      return async () => {
        const ids = await addHeld(db, rows);
        await markHeld(db, ids.map((id) => ({ id, from: "held" as const, set: { state: "dropped" as const, reason: "closed", updated_at: AT } })));
      };
    }), 2, 40);
  });
}

both("markHeld moves only rows still in the state it expects, with a different patch per row", async ({ db }) => {
  const mk = (n: number) => ({ card_id: 1, workflow_id: 7, approved_at: AT, repo: "o/a", number: 1, issue_repo: "o/x", title: `t${n}`, body: "b", by: "op", at: AT });
  const [a, b, c] = await addHeld(db, [mk(1), mk(2), mk(3)]);
  assert.deepEqual(await markHeld(db, [{ id: b!, from: "held", set: { state: "filing", attempts: 1, updated_at: AT } }]), new Set([b]));
  const moved = await markHeld(db, [
    { id: a!, from: "held", set: { state: "dropped", reason: "closed", updated_at: AT } },
    { id: b!, from: "filing", set: { state: "filed", issue_number: 9, url: "https://x/9", reason: null, updated_at: AT } },
    { id: c!, from: "filing", set: { state: "filed", updated_at: AT } },
  ]);
  assert.deepEqual(moved, new Set([a, b]));
  const rows = (await loadHeld(db, ["o/a#1"])).get("o/a#1")!;
  assert.deepEqual(rows.map((r) => [r.state, r.issue_number, r.workflow_id]), [["dropped", null, 7], ["filed", 9, 7], ["held", null, 7]]);
});

both("collectStatements keeps operators' conversation messages once and answers 'due' and embedding work", async ({ db }) => {
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.access").values({ login: "Op", role: "operator" }));
  await q.run(q.k.insertInto("main.items").values({ repo: "o/a", number: 1, kind: "pr", state: "OPEN", title: "The PR" }));
  await saveConversations(db, [conv("o/a", 1)]);
  await addTurns(db, [person("o/a#1", "we never take generated code here", "operator"), person("o/a#1", "short", "operator"), person("o/a#1", "a maintainer says something long enough", "maintainer")]);
  assert.equal(await collectStatements(db), 1);
  assert.equal(await collectStatements(db), 0, "a source is collected once");
  const work = await loadStatementWork(db, "m1", 10);
  assert.deepEqual(work.map((w) => [w.source_kind, w.item_title, w.embedded]), [["conversation", "The PR", false]]);
  assert.equal((await loadStatementWork(db, "m1", 1)).length, 1);
  await setStatementVectors(db, [{ id: work[0]!.id, vec: new Uint8Array([1, 2, 3, 4]), model: "m1" }]);
  assert.equal((await loadStatementWork(db, "m1", 10)).length, 0);
  assert.equal((await loadStatementWork(db, "m2", 10)).length, 1, "another model needs a new vector");
  const pools = await loadStatementPools(db, ["o/a", "o/b"], ["m1"]);
  assert.deepEqual([...pools.keys()], ["o/a"]);
  assert.deepEqual([...pools.get("o/a")![0]!.vec], [1, 2, 3, 4]);
  assert.equal((await loadStatementPools(db, ["o/a"], ["m2"])).size, 0);
  assert.equal((await loadStatements(db, [work[0]!.id])).get(work[0]!.id)!.repo, "o/a");
  assert.equal((await loadStatementViews(db, [work[0]!.id])).get(work[0]!.id)!.title, "The PR");
});

for (const dialect of dialects()) {
  test(`statement pools keep their statement count as repos grow (${dialect})`, async () => {
    await expectFlat(flat(dialect, async (db, n) => {
      const q = queryDb(db);
      await q.run(q.k.insertInto("main.owner_statements").values(Array.from({ length: n }, (_, i) => ({ source_kind: "conversation", source_id: String(i), repo: `o/r${i}`, number: i + 1, author: "op", text: "text", at: AT, embedding: new Uint8Array([1]), model: "m" }))));
      return async () => { await loadStatementPools(db, Array.from({ length: n }, (_, i) => `o/r${i}`), ["m"]); await loadStatements(db, Array.from({ length: n }, (_, i) => i + 1)); await loadStatementViews(db, Array.from({ length: n }, (_, i) => i + 1)); };
    }), 2, 40);
  });
}

both("statementsDue collects what operators wrote since it last looked, also after a role change, in any letter case", async ({ db }) => {
  const q = queryDb(db);
  const comment = (id: string, author: string) => q.run(q.k.insertInto("main.comments").values({ repo: "o/a", number: 1, id, kind: "comment", author, created_at: AT, body: "we never vendor dictionaries in an app" }));
  const collected = async () => (await q.all(q.k.selectFrom("main.owner_statements").select("source_id").orderBy("source_id"))).map((r) => r.source_id);
  await q.run(q.k.insertInto("main.access").values({ login: "Op", role: "operator" }));
  assert.equal(await statementsDue(db, "m1"), false);
  await comment("c1", "op");
  await comment("c2", "Guest");
  assert.equal(await statementsDue(db, "m1"), true);
  assert.deepEqual(await collected(), ["c1"]);
  await q.run(q.k.insertInto("main.access").values({ login: "guest", role: "operator" }));
  await statementsDue(db, "m1");
  assert.deepEqual(await collected(), ["c1", "c2"], "a new operator's earlier comments are collected");
});

if (dialects().includes("postgres")) {
  test("the owner-statement candidates reach comments through an author lookup, not a walk of every comment (postgres)", async () => {
    const { t, db } = await openApp("postgres");
    try {
      const q = queryDb(db);
      const c = statementSources(db).compile();
      // Tables this small are scanned whatever the indexes: with scans disabled, the planner reaches comments through an author lookup
      // when an index serves the join, and otherwise walks them all (a disabled scan, or a full walk of another index).
      const plan = await db.write(async () => {
        await q.script("SET LOCAL enable_seqscan = off");
        return (await q.all<Record<string, string>>({ compile: () => ({ ...c, sql: `EXPLAIN ${c.sql}` }) })).map((r) => Object.values(r)[0]!);
      });
      const reads = plan.flatMap((line, i) => (/ on comments c\b/.test(line) ? [plan[i + 1] ?? ""] : []));
      assert.ok(reads.length > 0 && reads.every((cond) => /Cond: .*\bauthor\b/.test(cond)), plan.join("\n"));
    } finally {
      await t.close();
    }
  });
}
