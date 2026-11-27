// Duplicate pairs of a repo no Task Runner takes are not sent to Jev, and pairs whose Haiku batch no
// Task Runner took do not count as handled, so the dupes job ends idle and the planner parks it. A job
// stopped part way keeps every answer it got, and the next one asks only the pairs without one.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { VectorIndex } from "../src/embed/vectors.ts";
import { checkPairs, type PairKey } from "../src/dupes/check.ts";
import { askKey, groupPairs, pairRef, type DupeAsk, type DupePair, type PairItem } from "../src/dupes/pair.ts";
import { runDupes } from "../src/dupes/index.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { parseStatus, storeStatus } from "../src/remote/helpers.ts";
import { setUserRepos } from "../src/remote/my-repos.ts";
import { fillEmbedHashes } from "../src/itemhash.ts";
import { pruneJevUnsure } from "../src/agents/step.ts";
import type { Db } from "./helpers/raw-db.ts";
import { T0, world } from "./world-db.ts";

const hashOf = async (db: Db, n: number): Promise<string> => (await db.get(db.k.selectFrom("items").select("embed_hash").where("repo", "=", "app").where("number", "=", n)))!.embed_hash!;
/** A ready Task Runner of the maintainer bob. */
async function runnerOf(db: Db): Promise<void> {
  await db.run(db.k.insertInto("access").values({ login: "bob", role: "maintainer" }));
  const runner = await createToken(db, "bob", "runner", { kind: "runner" });
  await storeStatus(db, runner.row.id, "bob", parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus", small: "haiku" }, reserve: { fiveHour: 0, weekly: 0 } }));
}
const index = { embedder: { id: "m" }, ready: async () => {} } as unknown as VectorIndex;

test("pairs of a repo no Task Runner takes are neither sent to Jev nor counted as handled", async () => {
  const w = await (await (await (await world()).repo()).issue(1, { title: "crash on open" })).issue(2, { title: "crashes when opening" });
  await fillEmbedHashes(w.db);
  const key: PairKey = { repo: "app", a: 1, b: 2, a_hash: await hashOf(w.db, 1), b_hash: await hashOf(w.db, 2), similarity: 0.9 };
  await w.db.run(w.db.k.insertInto("duplicate_pairs").values({ repo: "app", a: 1, b: 2, a_hash: key.a_hash, b_hash: key.b_hash, similarity: 0.9, created_at: T0 }));
  await runnerOf(w.db);
  const lines: string[] = [];
  await runDupes(w.db, { dryRun: true }, (l) => lines.push(l), { index, check: {} as never });
  assert.match(lines.join("\n"), /1 pairs to check/, "a Task Runner takes the pair");
  await setUserRepos(w.db, "bob", ["other"]);

  let jev = 0, haiku = 0;
  const handled: number[] = [];
  const check = { jev: async (a: DupeAsk) => (jev++, Object.fromEntries(a.candidates.map((c) => [c.ref, 0.5]))), haiku: async () => (haiku++, null), now: () => new Date(T0) };
  const s = await runDupes(w.db, { onHandled: (n) => handled.push(n) }, () => {}, { index, check });
  assert.deepEqual([jev, haiku, s.checked, handled.length], [0, 0, 0, 0], "no pair was sent and none counted");

  // A pair Jev was unsure of whose Haiku batch nobody took: Jev's call counted while it ran, the skipped batch is taken off again.
  const c = await checkPairs(w.db, [key], check, { onHandled: (n) => handled.push(n) });
  assert.deepEqual([jev, haiku, c.unanswered], [1, 0, 1]);
  assert.equal(handled.at(-1), 0, "the job ends with nothing handled");

  // Jev's unsure answer was kept: a later pass asks only Haiku, while the pair has an open item.
  await checkPairs(w.db, [key], check, { onHandled: (n) => handled.push(n) });
  assert.deepEqual([jev, handled.at(-1)], [1, 0], "Jev is not asked again");
  assert.equal(await pruneJevUnsure(w.db, Date.parse(T0)), 0);
  await w.db.run(w.db.k.updateTable("items").set({ state: "CLOSED" }).where("repo", "=", "app"));
  assert.equal(await pruneJevUnsure(w.db, Date.parse(T0)), 1, "both items are closed");
});

test("a stopped dupes job keeps the answers it got, and the next one asks only the other pairs", async () => {
  const w = await (await world()).repo();
  const n = 30;
  for (let i = 1; i <= n; i++) await w.issue(i, { title: `crash ${i}` });
  await fillEmbedHashes(w.db);
  await runnerOf(w.db);
  const hashes = new Map<number, string>();
  for (let i = 1; i <= n; i++) hashes.set(i, await hashOf(w.db, i));
  const rows = [];
  for (let a = 1; a <= n; a++) for (let b = a + 1; b <= n; b++) rows.push({ repo: "app", a, b, a_hash: hashes.get(a)!, b_hash: hashes.get(b)!, similarity: 0.9, created_at: T0 });
  await w.db.run(w.db.k.insertInto("duplicate_pairs").values(rows));
  const checked = async () => (await w.db.all(w.db.k.selectFrom("duplicate_pairs").select("a").where("checked_at", "is not", null))).length;

  const asked: string[] = [], handled: number[] = [], progress: string[] = [];
  const check = { jev: async (a: DupeAsk) => { asked.push(...a.candidates.map((c) => c.ref)); return Object.fromEntries(a.candidates.map((c) => [c.ref, 0.01])); }, haiku: async () => null, now: () => new Date(T0) };
  const first = await runDupes(w.db, { timeUp: async () => asked.length > 0, onHandled: (x) => handled.push(x), progress: async (t) => void progress.push(t) }, () => {}, { index, check });
  assert.ok(asked.length > 0 && asked.length < rows.length, "the first slice runs whole, the next one does not start");
  assert.deepEqual([await checked(), first.checked, handled.at(-1), first.left], [asked.length, asked.length, asked.length, rows.length - asked.length]);
  assert.equal(progress.length, 1);

  const before = asked.length;
  await runDupes(w.db, { cancelled: async () => asked.length >= before + 5 }, () => {}, { index, check });
  assert.ok(asked.length > before && asked.length < rows.length, "a cancel stops the calls inside a slice");
  assert.equal(await checked(), asked.length, "the answers that came are stored");

  handled.length = 0;
  const left = rows.length - asked.length; // more than one slice: the count adds up over them
  await runDupes(w.db, { onHandled: (x) => handled.push(x) }, () => {}, { index, check });
  assert.deepEqual([await checked(), new Set(asked).size, asked.length, handled.at(-1)], [rows.length, rows.length, rows.length, left]);
});

test("an item with three candidates makes one Jev request, and a pair Jev is unsure of still goes to Haiku", async () => {
  const w = await (await world()).repo();
  for (let i = 1; i <= 4; i++) await w.issue(i, { title: `crash ${i}` });
  await fillEmbedHashes(w.db);
  await runnerOf(w.db);
  const keys: PairKey[] = [];
  for (const b of [2, 3, 4]) keys.push({ repo: "app", a: 1, b, a_hash: await hashOf(w.db, 1), b_hash: await hashOf(w.db, b), similarity: 0.9 });
  await w.db.run(w.db.k.insertInto("duplicate_pairs").values(keys.map((k) => ({ ...k, created_at: T0 }))));
  const asks: DupeAsk[] = [], haiku: string[] = [];
  const check = {
    jev: async (a: DupeAsk) => (asks.push(a), { "app#1~2": 0.5, "app#1~3": 0.97, "app#1~4": 0.02 }),
    haiku: async (ps: { ref: string }[]) => (haiku.push(...ps.map((p) => p.ref)), JSON.stringify(ps.map((p) => ({ ref: p.ref, verdict: "distinct", reason: "" })))),
    now: () => new Date(T0),
  };
  const c = await checkPairs(w.db, keys, check);
  assert.equal(asks.length, 1);
  assert.equal(asks[0]!.candidates.length, 3);
  assert.deepEqual(haiku, ["app#1~2"]);
  assert.deepEqual([c.checked, c.verdicts.duplicate, c.verdicts.distinct], [3, 1, 2]);
});

test("pairs of two repos with the same numbers go in separate requests, each answer named for its own pair", () => {
  const item = (number: number): PairItem => ({ number, kind: "issue", state: "OPEN", title: `crash ${number}`, body: "" });
  const pairs: DupePair[] = [];
  for (const repo of ["app", "lib"]) for (const b of [2, 3]) pairs.push({ ref: pairRef(repo, 1, b), repo, a: item(1), b: item(b) });
  const asks = groupPairs(pairs);
  assert.deepEqual(asks.flatMap((a) => a.candidates.map((c) => c.ref)).sort(), pairs.map((p) => p.ref).sort(), "every pair is asked once");
  for (const a of asks) {
    assert.ok(a.candidates.every((c) => c.ref.startsWith(`${a.repo}#`)), `${a.ref} asks only about its own repo`);
    assert.equal(new Set(a.candidates.map(askKey)).size, a.candidates.length, "the answer names in a request are distinct");
  }
});
