// Live topics and the planner's change log on Postgres: the same writes touch the same topics and log the same items as on
// SQLite; counters move once per transaction at commit; a log row that commits after a later one is read once, by the next
// pass. The Postgres tests need a server (AUTOCRAFT_TEST_PG_URL; `pnpm test:pg` starts one) and are skipped otherwise.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bulkWrites, changeCursor, changesSince, planTriggers, pruneChanges, type ChangeCursor } from "../src/core/plan-changes.ts";
import { pgExpr } from "../src/core/pg-expr.ts";
import type { Db } from "../src/db/index.ts";
import { loadPg } from "../src/db/open.ts";
import { PG_COLUMNS_SQL, pgColumns } from "../src/db/pg-triggers.ts";
import { liveTriggers, readSeqs } from "../src/live.ts";
import { needsPg, testDatabase, type TestDatabase } from "./test-db.ts";

const T = "2026-01-01T00:00:00Z";

/** Writes over most kinds of trigger: item, cross-item and global inputs, bookkeeping-only updates, malformed JSON, a transaction, a bulk write. */
const STEPS: [string, (db: Db) => Promise<unknown>][] = [
  ["new PR", (db) => db.run(db.k.insertInto("items").values({ repo: "app", number: 1, kind: "pr", state: "OPEN", title: "t1", created_at: T }))],
  ["new issue", (db) => db.run(db.k.insertInto("items").values({ repo: "app", number: 2, kind: "issue", state: "OPEN", title: "t2", created_at: T }))],
  ["text hash only", (db) => db.run(db.k.updateTable("items").set({ embed_hash: "e2" }).where("number", "=", 2))],
  ["issue title", (db) => db.run(db.k.updateTable("items").set({ title: "retitled" }).where("number", "=", 2))],
  ["comment", (db) => db.prepare("INSERT INTO comments (repo, number, id, author, body, created_at) VALUES ('app', 2, 'c1', 'someone', 'hi', ?)").run(T)],
  ["bookkeeping setting", (db) => db.prepare("INSERT INTO settings (key, value) VALUES ('runner_heartbeat', ?)").run(T)],
  ["planner setting", (db) => db.prepare("INSERT INTO settings (key, value) VALUES ('pipeline_enabled', '1')").run()],
  ["rank", (db) => db.prepare("INSERT INTO item_rank (repo, number, score, breakdown, computed_at) VALUES ('app', 7, 1, '{}', ?)").run(T)],
  ["rank stamp only", (db) => db.prepare("UPDATE item_rank SET computed_at = '2026-01-02T00:00:00Z' WHERE number = 7").run()],
  ["rank key move", (db) => db.prepare("UPDATE item_rank SET number = 8 WHERE number = 7").run()],
  ["batch", async (db) => {
    await db.prepare("INSERT INTO merge_batches (id, repo, branch, state, base_sha, commit_sha, pr_number, created_at, updated_at) VALUES (1, 'app', 'integration-1', 'open', 'b', 'c', 50, ?, ?)").run(T, T);
    await db.prepare("INSERT INTO merge_batch_prs (batch_id, number, head_oid, position) VALUES (1, 3, 'h3', 0), (1, 4, 'h4', 1)").run();
  }],
  ["batch merged", (db) => db.prepare("UPDATE merge_batches SET state = 'merged' WHERE id = 1").run()],
  ["hold review", (db) => db.prepare(`INSERT INTO opus_reviews (repo, number, head_oid, at, mode, verdict, blocked_by) VALUES ('app', 1, 'h1', ?, 'full', 'hold', '["app#2", 7, "app#2"]')`).run(T)],
  ["blocker closes", (db) => db.run(db.k.updateTable("items").set({ state: "CLOSED" }).where("number", "=", 2))],
  ["decision with a list", (db) => db.run(db.k.insertInto("decisions").values({ id: "d1", kind: "merge", repo: "app", number: 3, items: '[{"repo": "app", "number": 5}, "app#6"]', asked_at: T, asked_by: "x", question: "q", options: "[]" }))],
  ["decision list malformed", (db) => db.run(db.k.updateTable("decisions").set({ items: '{"repo": "app"' }).where("id", "=", "d1"))],
  ["pair decision", (db) => db.run(db.k.insertInto("decisions").values({ id: "dup:app#3@12x", kind: "duplicate", repo: "app", number: 3, asked_at: T, asked_by: "x", question: "q", options: "[]" }))],
  ["assign", (db) => db.prepare("INSERT INTO audit (at, login, action, target) VALUES (?, 'op', 'assign', 'app#9')").run(T)],
  ["assign odd target", (db) => db.prepare("INSERT INTO audit (at, login, action, target) VALUES (?, 'op', 'assign', 'app#x9')").run(T)],
  ["fast track", (db) => db.prepare("INSERT INTO fast_track (repo, number, added_by, added_at) VALUES ('app', 9, 'op', ?)").run(T)],
  ["surge breaker", (db) => db.prepare("INSERT INTO stage_trips (stage, reason, evidence, tripped_at) VALUES ('outside-surge', 'r', 'e', ?)").run(T)],
  ["env", (db) => db.prepare("INSERT INTO build_envs (id, label, kind, slots, key_hash, created_at) VALUES ('e1', 'E', 'remote', 1, 'k', ?)").run(T)],
  ["env poll", (db) => db.prepare("UPDATE build_envs SET last_seen_at = ? WHERE id = 'e1'").run(T)],
  ["transaction", (db) => db.write(async () => {
    await db.prepare("INSERT INTO merge_holds (repo, number, held_by, held_at) VALUES ('app', 11, 'op', ?)").run(T);
    await db.prepare("INSERT INTO merge_holds (repo, number, held_by, held_at) VALUES ('app', 12, 'op', ?)").run(T);
    await db.run(db.k.updateTable("items").set({ title: "again" }).where("number", "=", 1));
  })],
  ["bulk", (db) => bulkWrites(db, "test", async () => {
    await db.prepare("INSERT INTO item_rank (repo, number, score, breakdown, computed_at) VALUES ('app', 20, 1, '{}', ?)").run(T);
    await db.prepare("UPDATE item_rank SET score = 2 WHERE number = 8").run();
  })],
];

/** Per step: the topics whose counter moved and what the change log answers. */
async function observe(db: Db): Promise<string[]> {
  let seqs = await readSeqs(db);
  let cursor = await changeCursor(db);
  const out: string[] = [];
  for (const [label, run] of STEPS) {
    await run(db);
    const now = await readSeqs(db);
    const c = await changesSince(db, cursor);
    const topics = Object.keys(now).filter((t) => now[t] !== seqs[t]).sort();
    out.push(`${label}: topics ${topics.join(" ")}; ${c.full ? "full" : `items ${[...c.refs].sort().join(" ")}`}`);
    await pruneChanges(db, c.cursor);
    seqs = now;
    cursor = c.cursor;
  }
  assert.equal((await db.get(db.k.selectFrom("item_changes").select((eb) => eb.fn.countAll<number>().as("n"))))!.n, 0);
  return out;
}

async function appDb(dialect: Db["dialect"]): Promise<{ t: TestDatabase; db: Db }> {
  const t = await testDatabase("", dialect);
  return { t, db: await t.open({ app: true }) };
}

test("the same writes touch the same topics and log the same items on SQLite and Postgres", { skip: needsPg }, async () => {
  const lite = await appDb("sqlite");
  const pg = await appDb("postgres");
  try {
    const want = await observe(lite.db);
    // The steps reach the paths they are for.
    assert.ok(want.some((s) => s.startsWith("bulk:") && s.endsWith("full")));
    assert.ok(want.some((s) => s.startsWith("blocker closes:") && / app#1\b/.test(s)));
    assert.deepEqual(await observe(pg.db), want);
  } finally {
    await lite.t.close();
    await pg.t.close();
  }
});

/** A raw connection: BEGIN and COMMIT by hand, outside db.write and its writer lock. */
async function client(t: TestDatabase): Promise<{ q: (sql: string) => Promise<unknown>; end: () => Promise<void> }> {
  const pg = await loadPg();
  const db = await t.open();
  // The test database's URL is not exposed; current_database() on its own pool names it.
  const name = (await db.prepare("SELECT current_database() AS d").get() as { d: string }).d;
  const url = new URL(process.env.AUTOCRAFT_TEST_PG_URL!);
  url.pathname = `/${name}`;
  const c = new pg.Client({ connectionString: url.toString() });
  await c.connect();
  return { q: (sql) => c.query(sql), end: () => c.end() };
}

test("a log row that commits after a later seq is read once, by the next pass, and a late full mark still forces a full pass", { skip: needsPg }, async () => {
  const { t, db } = await appDb("postgres");
  const a = await client(t), b = await client(t);
  try {
    const pass = async (cursor: ChangeCursor) => {
      const c = await db.read(() => changesSince(db, cursor));
      await pruneChanges(db, c.cursor);
      return c;
    };
    let cursor = await db.read(() => changeCursor(db));
    await a.q("BEGIN");
    await a.q(`INSERT INTO item_rank (repo, number, score, breakdown, computed_at) VALUES ('app', 1, 1, '{}', '${T}')`);
    await a.q(`INSERT INTO fast_track (repo, number, added_by, added_at) VALUES ('app', 1, 'op', '${T}')`);
    await b.q("BEGIN");
    await b.q(`INSERT INTO item_rank (repo, number, score, breakdown, computed_at) VALUES ('app', 2, 1, '{}', '${T}')`);
    await b.q("COMMIT");
    let c = await pass(cursor);
    assert.deepEqual([c.full, c.refs], [false, ["app#2"]]);
    cursor = c.cursor;
    await a.q("COMMIT");
    c = await pass(cursor);
    assert.equal(c.full, true);
    // The full pass covers the late row: nothing is read twice after it.
    cursor = c.cursor;
    c = await pass(cursor);
    assert.deepEqual([c.full, c.refs], [false, []]);
    // Without a full mark the late row itself comes back.
    cursor = c.cursor;
    await a.q("BEGIN");
    await a.q(`INSERT INTO item_rank (repo, number, score, breakdown, computed_at) VALUES ('app', 3, 1, '{}', '${T}')`);
    await b.q(`INSERT INTO item_rank (repo, number, score, breakdown, computed_at) VALUES ('app', 4, 1, '{}', '${T}')`);
    c = await pass(cursor);
    assert.deepEqual(c.refs, ["app#4"]);
    cursor = c.cursor;
    await a.q("COMMIT");
    c = await pass(cursor);
    assert.deepEqual(c.refs, ["app#3"]);
    c = await pass(c.cursor);
    assert.deepEqual(c.refs, []);
    assert.equal((await db.get(db.k.selectFrom("item_changes").select((eb) => eb.fn.countAll<number>().as("n"))))!.n, 0);
  } finally {
    await a.end();
    await b.end();
    await t.close();
  }
});

test("counters move once per transaction, at commit, and not for a rolled-back savepoint", { skip: needsPg }, async () => {
  const { t, db } = await appDb("postgres");
  const a = await client(t);
  try {
    // The full-pass cause of a new PR, named after its planner input.
    const source = planTriggers("postgres").flatMap((p) => ("full" in p && p.table === "items" && p.op === "INSERT" ? [p.full] : []))[0]!;
    const seqs = async () => {
      const s = await readSeqs(db);
      const gen = (await db.get(db.k.selectFrom("plan_full").select("seq")))!.seq;
      const n = (await db.get(db.k.selectFrom("plan_full_causes").select("n").where("source", "=", source)))?.n ?? 0;
      return { items: s.items!, fasttrack: s.fasttrack!, gen, n };
    };
    const before = await seqs();
    await a.q("BEGIN");
    await a.q(`INSERT INTO items (repo, number, kind, state, title, created_at) VALUES ('app', 1, 'pr', 'OPEN', 'a', '${T}'), ('app', 2, 'pr', 'OPEN', 'b', '${T}')`);
    await a.q("UPDATE items SET title = 'c' WHERE number = 1");
    await a.q("SAVEPOINT s");
    await a.q(`INSERT INTO fast_track (repo, number, added_by, added_at) VALUES ('app', 1, 'op', '${T}')`);
    await a.q("ROLLBACK TO SAVEPOINT s");
    assert.deepEqual(await seqs(), before);
    await a.q("COMMIT");
    const after = await seqs();
    assert.equal(after.items, before.items + 1);
    assert.equal(after.gen, before.gen + 1);
    assert.equal(after.n, before.n + 1);
    assert.equal(after.fasttrack, before.fasttrack);
  } finally {
    await a.end();
    await t.close();
  }
});

test("every Postgres trigger condition and log query plans against the schema", { skip: needsPg }, async () => {
  const { t, db } = await appDb("postgres");
  try {
    const columns = pgColumns(await db.prepare(PG_COLUMNS_SQL).all() as { t: string; c: string }[]);
    const rows = (table: string) => `${table} AS new, ${table} AS old`;
    const checks = [
      ...planTriggers("postgres", columns).map((p) => "full" in p
        ? `SELECT 1 FROM ${rows(p.table)} WHERE ${p.cond || "true"}`
        : `INSERT INTO item_changes (repo, number) SELECT s.repo, s.number FROM ${rows(p.table)}, LATERAL (${p.refs}) AS s WHERE ${p.cond || "true"}`),
      ...liveTriggers(columns).map((l) => `SELECT 1 FROM ${rows(l.table)} WHERE ${l.cond ? pgExpr(l.cond) : "true"}`),
    ];
    assert.ok(checks.length > 300);
    const failed: string[] = [];
    for (const sql of checks) await db.prepare(`EXPLAIN ${sql}`).all().catch((e: Error) => failed.push(`${e.message}: ${sql.slice(0, 300)}`));
    assert.deepEqual(failed, []);
  } finally {
    await t.close();
  }
});
