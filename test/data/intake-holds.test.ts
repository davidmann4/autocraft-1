// intake module: the hold rule (pure), the candidate statement and the hold readers (SQLite; Postgres when AUTOCRAFT_TEST_PG_URL is set).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db, Dialect } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import { TEST_PG_URL, testDatabase } from "../test-db.ts";
import { expectFlat } from "../helpers/query-count.ts";
import { computeHolds, countHolds, holdAuthors, holdWait, isOutsideAuthor, loadHoldStatus, loadHolds, parseOutsideLimits, OutsideError } from "../../src/data/intake/index.ts";
import { loadCandidates } from "../../src/data/intake/candidates.ts";
import type { Candidate, HoldInput, OutsideLimits } from "../../src/data/intake/types.ts";

const NOW = Date.parse("2026-03-10T12:00:00.000Z");
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const limits = (o: Partial<OutsideLimits> = {}): OutsideLimits => ({ prsPerDay: 2, issuesPerDay: 2, surgePerHour: 30, ...o });
const cand = (author: string, number: number, hoursAgo: number, o: Partial<Candidate> = {}): Candidate =>
  ({ repo: "app", number, author, author_id: 1, kind: "pr", state: "OPEN", created_at: iso(hoursAgo), released: false, admitted: false, ...o });
const input = (rows: Candidate[], o: Partial<HoldInput> = {}): HoldInput => ({ rows, limits: limits(), nowMs: NOW, trip: null, whitelisted: new Set(), ...o });
const key = (a: string) => `${a.toLowerCase()}|1`;

test("items past an author's daily limit are held, the first ones are admitted, and the hold lapses 24 hours after the first", () => {
  const r = computeHolds(input([cand("Eve", 1, 5), cand("eve", 2, 4), cand("EVE", 3, 3), cand("eve", 4, 2)]));
  assert.deepEqual(r.holds.map((h) => [h.number, h.reason]), [[3, "limit"], [4, "limit"]]);
  assert.deepEqual(r.admissions.map((a) => a.number), [1, 2]);
  assert.equal(r.wakeAt, Date.parse(iso(5)) + 24 * 3_600_000);
  assert.equal(r.tripSurge, null);
});

test("admitted, released and closed items are never held, but still count toward the limit; a whitelisted author is skipped", () => {
  const rows = [cand("eve", 1, 5), cand("eve", 2, 4), cand("eve", 3, 3, { admitted: true }), cand("eve", 4, 2, { released: true }), cand("eve", 5, 1, { state: "CLOSED" })];
  assert.deepEqual(computeHolds(input(rows)).holds, []);
  assert.deepEqual(computeHolds(input([cand("eve", 1, 5), cand("eve", 2, 4), cand("eve", 3, 3)], { whitelisted: new Set([key("eve")]) })).holds, []);
  assert.deepEqual(computeHolds(input([cand("eve", 1, 5), cand("eve", 2, 4), cand("eve", 3, 3, { kind: "issue" })])).holds, []);
});

test("a surge trips when real items of the last hour pass the threshold, and holds items from an hour before the trip", () => {
  const rows = Array.from({ length: 4 }, (_, i) => cand(`u${i}`, i + 1, 0.5)).concat([cand("early", 9, 0.9)]);
  const r = computeHolds(input(rows, { limits: limits({ surgePerHour: 3 }) }));
  assert.ok(r.tripSurge);
  assert.match(r.tripSurge!.reason, /5 new items .* \(more than 3\)/);
  assert.equal(r.holds.length, 5);
  assert.ok(r.holds.every((h) => h.reason === "surge"));
  // Whitelisted authors do not count; nobody is held then.
  const ok = new Set(rows.map((x) => key(x.author)));
  assert.equal(computeHolds(input(rows, { limits: limits({ surgePerHour: 3 }), whitelisted: ok })).tripSurge, null);
  // A breaker already tripped holds items created from an hour before its trip, however old, and does not trip again.
  const old = cand("late", 7, 30);
  const tripped = computeHolds(input([old, cand("fresh", 8, 0.2)], { limits: limits({ surgePerHour: 3 }), trip: { active: true, trippedAt: iso(29.5), clearedAt: null } }));
  assert.equal(tripped.tripSurge, null);
  assert.deepEqual(tripped.holds.map((h) => h.number), [7, 8]);
});

test("only the authors whose standing the rule may read are listed, and none with the protections off", () => {
  const rows = [cand("eve", 1, 5), cand("eve", 2, 4), cand("eve", 3, 3), cand("bob", 4, 2)];
  assert.deepEqual(holdAuthors(input(rows)).map((a) => a.login), ["eve"]);
  assert.deepEqual(holdAuthors(input(rows, { limits: limits({ prsPerDay: 0, issuesPerDay: 0, surgePerHour: 0 }) })), []);
  assert.deepEqual(computeHolds(input(rows, { limits: limits({ prsPerDay: 0, issuesPerDay: 0, surgePerHour: 0 }) })).holds, []);
});

test("outside authors are those without association, bot status or an insider login; limits parse as whole numbers", () => {
  const row = (o: Partial<{ author: string | null; author_association: string | null; author_type: string | null }>) => ({ author: "x", author_association: null, author_type: null, ...o });
  const insiders = new Set(["staff"]);
  assert.equal(isOutsideAuthor(row({}), insiders), true);
  assert.equal(isOutsideAuthor(row({ author_association: "MEMBER" }), insiders), false);
  assert.equal(isOutsideAuthor(row({ author_type: "Bot" }), insiders), false);
  assert.equal(isOutsideAuthor(row({ author: "dependabot[bot]", author_type: "User" }), insiders), false);
  assert.equal(isOutsideAuthor(row({ author: "Staff" }), insiders), false);
  assert.equal(isOutsideAuthor(row({ author: null }), insiders), false);
  assert.deepEqual(parseOutsideLimits({ prsPerDay: 0 }, limits()), limits({ prsPerDay: 0 }));
  assert.throws(() => parseOutsideLimits({ issuesPerDay: 1.5 }, limits()), OutsideError);
  assert.match(holdWait({ reason: "limit", kind: "pr", limit: 5 }), /5 new PRs a day/);
});

async function withDb(dialect: Dialect, fn: (db: Db) => Promise<unknown>): Promise<unknown> {
  const t = await testDatabase("", dialect);
  try { return await fn(await t.open({ app: true })); } finally { await t.close(); }
}

function both(name: string, fn: (db: Db) => Promise<unknown>): void {
  test(name, async () => {
    const lite = await withDb("sqlite", fn);
    if (TEST_PG_URL) assert.deepEqual(await withDb("postgres", fn), lite);
  });
}

type ItemSeed = { number: number; author: string; kind?: string; state?: string; assoc?: string | null; type?: string | null; at?: string; repo?: string };
async function seed(db: Db, items: ItemSeed[]): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.tracked_repos").values([{ name: "app" }, { name: "off" }]));
  await q.run(q.k.updateTable("main.tracked_repos").set({ pipeline: 1 }).where("name", "=", "app"));
  await q.run(q.k.insertInto("main.items").values(items.map((i) => ({
    repo: i.repo ?? "app", number: i.number, kind: i.kind ?? "pr", state: i.state ?? "OPEN", author: i.author, author_association: i.assoc ?? null, author_type: i.type ?? null, created_at: i.at ?? iso(1),
  }))));
}

both("candidates are in-scope items of outside authors with their admission and release flags", async (db) => {
  const q = queryDb(db);
  await seed(db, [
    { number: 1, author: "eve" }, { number: 2, author: "eve", state: "CLOSED" }, { number: 3, author: "member", assoc: "MEMBER" }, { number: 4, author: "app-bot[bot]" },
    { number: 5, author: "mr-bot", type: "Bot" }, { number: 6, author: "dependabot" }, { number: 7, author: "Maint" }, { number: 8, author: "ours" },
    { number: 9, author: "eve", at: iso(28.5) }, { number: 13, author: "eve", at: iso(30) }, { number: 10, author: "eve", repo: "off" }, { number: 11, author: "busy" }, { number: 12, author: "eve", kind: "issue" },
  ]);
  await q.run(q.k.insertInto("main.access").values({ login: "maint", role: "maintainer" }));
  await q.run(q.k.insertInto("main.item_workflows").values({ repo: "app", number: 11, kind: "pr", entry: "review", state: "running", started_by: "x", started_at: iso(2), started_via: "github", updated_at: iso(2) }));
  await q.run(q.k.insertInto("main.outside_released").values({ repo: "app", number: 1, by: "op", at: iso(1) }));
  await q.run(q.k.insertInto("main.outside_admitted").values({ repo: "app", number: 12, at: iso(1) }));
  const rows = await loadCandidates(db, { dayAgo: iso(24), surge: false, own: ["ours"], bots: ["dependabot"] });
  assert.deepEqual(rows.map((r) => r.number), [1, 2, 12]);
  assert.deepEqual(rows.map((r) => [r.released, r.admitted]), [[true, false], [false, false], [false, true]]);
  assert.equal(rows[2]!.kind, "issue");
  // An active breaker keeps older items from an hour before its trip.
  await q.run(q.k.insertInto("main.stage_trips").values({ stage: "outside-surge", active: 1, reason: "r", evidence: "[]", tripped_at: iso(28) }));
  const kept = (await loadCandidates(db, { dayAgo: iso(24), surge: true, own: [], bots: [] })).map((r) => r.number);
  assert.ok(kept.includes(9) && !kept.includes(13));
  assert.ok(!(await loadCandidates(db, { dayAgo: iso(24), surge: false, own: [], bots: [] })).some((r) => r.number === 9));
});

both("a post-merge follow-up issue counts as an item of the merged PR's author", async (db) => {
  const q = queryDb(db);
  await seed(db, [{ number: 20, author: "eve" }, { number: 21, author: "pipeline-user", kind: "issue" }]);
  await q.run(q.k.insertInto("main.postmerge_followups").values({ repo: "app", number: 20, review_at: iso(2), finding: 1, title: "t", issue_number: 21, state: "filed", at: iso(2) }));
  const rows = await loadCandidates(db, { dayAgo: iso(24), surge: false, own: [], bots: [] });
  assert.deepEqual(rows.map((r) => [r.number, r.author]), [[20, "eve"], [21, "eve"]]);
});

both("holds are read by key with the limit of their kind; a held item shows its hold, a released one its release", async (db) => {
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.outside_holds").values([
    { repo: "app", number: 1, author: "eve", kind: "pr", reason: "limit" }, { repo: "app", number: 2, author: "Eve", kind: "issue", reason: "surge" }, { repo: "app", number: 3, author: "bob", kind: "pr", reason: "limit" },
  ]));
  await q.run(q.k.insertInto("main.outside_released").values([{ repo: "app", number: 4, by: "op", at: iso(1) }, { repo: "app", number: 1, by: "op", at: iso(1) }]));
  await q.run(q.k.insertInto("main.settings").values({ key: "outside_issues_per_day", value: "9" }));
  const refs = [1, 2, 4, 5].map((number) => ({ repo: "app", number }));
  const h = await loadHolds(db, refs);
  assert.deepEqual([...h.keys()], ["app#1", "app#2"]);
  assert.equal(h.get("app#2")!.limit, 9);
  assert.equal(h.get("app#1")!.limit, 5);
  const s = await loadHoldStatus(db, refs);
  assert.deepEqual(s.get("app#1"), { author: "eve", reason: "limit", releasedBy: null });
  assert.deepEqual(s.get("app#4"), { author: null, reason: null, releasedBy: "op" });
  assert.equal(s.has("app#5"), false);
  assert.deepEqual(await countHolds(db, {}), { limit: 2, surge: 1, authors: 3 });
  assert.deepEqual(await countHolds(db, { reason: "surge" }), { limit: 0, surge: 1, authors: 1 });
  assert.deepEqual(await countHolds(db, { hidden: Object.assign(["app"], {}) }), { limit: 0, surge: 0, authors: 0 });
  return [...h.keys()];
});

test("candidates, hold loaders and counts issue the same number of statements at 2 and 12 items", async () => {
  const unit = (run: (db: Db, n: number) => Promise<unknown>) => async (size: number) => {
    const t = await testDatabase("", "sqlite");
    const db = await t.open({ app: true });
    await seed(db, Array.from({ length: size }, (_, i) => ({ number: i + 1, author: `u${i}` })));
    const q = queryDb(db);
    await q.run(q.k.insertInto("main.outside_holds").values(Array.from({ length: size }, (_, i) => ({ repo: "app", number: i + 1, author: `u${i}`, kind: "pr", reason: "limit" }))));
    return { db, run: () => run(db, size), close: () => t.close() };
  };
  const refs = (n: number) => Array.from({ length: n }, (_, i) => ({ repo: "app", number: i + 1 }));
  await expectFlat(unit((db) => loadCandidates(db, { dayAgo: iso(24), surge: true, own: ["a"], bots: [] })), 2, 12);
  await expectFlat(unit((db, n) => Promise.all([loadHolds(db, refs(n)), loadHoldStatus(db, refs(n)), countHolds(db, {})])), 2, 12);
});
