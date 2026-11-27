// src/db/portable.ts: each helper gives the same rows on SQLite and Postgres. The Postgres cases run when
// AUTOCRAFT_TEST_PG_URL names a server (`pnpm test:pg test/portable.test.ts`) and skip otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Dialect } from "../src/db/index.ts";
import type { Db } from "./helpers/raw-db.ts";
import * as P from "../src/db/portable.ts";
import { sql } from "../src/db/sql.ts";
import { needsPg, testDatabase } from "./test-db.ts";
import type { Generated } from "kysely";

/** The test table, for Kysely. */
type T = { t: { id: Generated<number>; name: string | null; login: string | null; j: string | null; n: number | null; m: number | null } };

const J = JSON.stringify({ a: { b: "x", "c d": "y" }, n: 5, r: 1.5, ok: true, no: false, arr: ["p", "q"], nul: null, objs: [{ k: "u" }, { k: "v" }] });

async function withDb(dialect: Dialect, fn: (db: Db) => Promise<void>): Promise<void> {
  const t = await testDatabase("", dialect);
  try {
    const db = await t.open();
    const ci = dialect === "postgres" ? "citext" : "TEXT COLLATE NOCASE";
    if (dialect === "postgres") await db.script("CREATE EXTENSION IF NOT EXISTS citext");
    await db.script(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, login ${ci}, j TEXT, n INTEGER, m INTEGER);
      INSERT INTO t (id, name, login, j, n, m) VALUES
        (1, 'alice', 'Alice', '${J}', 3, 7),
        (2, 'Bob', 'bob', '[1, 2, 3]', NULL, 4),
        (3, 'a\\b', 'Carol', 'nope', 9, NULL);`);
    await fn(db);
  } finally {
    await t.close();
  }
}

const both = (name: string, fn: (db: Db) => Promise<void>): void => {
  test(`${name} (sqlite)`, () => withDb("sqlite", fn));
  test(`${name} (postgres)`, { skip: needsPg }, () => withDb("postgres", fn));
};

const col = async (db: Db, text: string, ...params: (string | number | null)[]): Promise<unknown[]> =>
  (await db.prepare(text).all(...params)).map((r) => Object.values(r)[0]);

both("inList matches the elements of a JSON array parameter, with one statement text for any length", async (db) => {
  assert.deepEqual(await col(db, `SELECT id FROM t WHERE ${P.inList(db, "id", "?", "bigint")} ORDER BY id`, "[1, 3]"), [1, 3]);
  assert.deepEqual(await col(db, `SELECT id FROM t WHERE ${P.inList(db, "name", ":names")} ORDER BY id`, { names: '["Bob", "x"]' } as never), [2]);
  assert.deepEqual(await col(db, `SELECT id FROM t WHERE ${P.inList(db, "login", "?", "citext")} ORDER BY id`, '["alice", "CAROL"]'), [1, 3]);
  assert.deepEqual(await col(db, `SELECT id FROM t WHERE ${P.inList(db, "id", "?", "bigint", true)} ORDER BY id`, "[2]"), [1, 3]);
  assert.deepEqual(await col(db, `SELECT id FROM t WHERE ${P.inList(db, "id", "?", "bigint")}`, "[]"), []);
});

both("inValues binds JS values in a Kysely query", async (db) => {
  const ids = async (values: number[]) => (await db.all(db.k.withTables<T>().selectFrom("t").select("id").where(P.inValues(db, sql.ref("id"), values)).orderBy("id"))).map((r) => r.id);
  assert.deepEqual(await ids([3, 1]), [1, 3]);
  assert.deepEqual(await ids([]), []);
});

both("JSON fields read as SQLite's json_extract, json_type and json_valid give them", async (db) => {
  const row = await db.prepare(`SELECT ${[
    P.jsonText(db, "j", "$.a.b"), P.jsonText(db, "j", '$.a."c d"'), P.jsonText(db, "j", "$.arr[1]"), P.jsonText(db, "j", "$.missing"),
    P.jsonNum(db, "j", "$.n"), P.jsonNum(db, "j", "$.r"), P.jsonBool(db, "j", "$.ok"), P.jsonBool(db, "j", "$.no"),
    P.jsonType(db, "j", "$.a"), P.jsonType(db, "j", "$.arr"), P.jsonType(db, "j", "$.a.b"), P.jsonType(db, "j", "$.n"), P.jsonType(db, "j", "$.r"),
    P.jsonType(db, "j", "$.ok"), P.jsonType(db, "j", "$.no"), P.jsonType(db, "j", "$.nul"), P.jsonType(db, "j", "$.missing"), P.jsonType(db, "?"),
  ].map((e, i) => `${e} AS c${i}`).join(", ")} FROM t WHERE id = ?`).get("[]", 1);
  assert.deepEqual(Object.values(row!), ["x", "y", "q", null, 5, 1.5, 1, 0, "object", "array", "text", "integer", "real", "true", "false", "null", null, "array"]);
  assert.deepEqual(await col(db, `SELECT id FROM t WHERE ${P.jsonValid(db, "j")} ORDER BY id`), [1, 2]);
  assert.deepEqual(await col(db, `SELECT CASE WHEN ${P.jsonValid(db, "j")} THEN 1 ELSE 0 END FROM t ORDER BY id`), [1, 1, 0]);
});

both("jsonEach lists array elements as `value`, objects as JSON text", async (db) => {
  const rows = await db.prepare(`SELECT t.id, e.value FROM t, ${P.jsonEach(db, P.jsonText(db, "t.j", "$.arr"), "e")} WHERE t.id = 1 ORDER BY e.value`).all();
  assert.deepEqual(rows.map((r) => r.value), ["p", "q"]);
  assert.deepEqual(await col(db, `SELECT sum(e.value) FROM t, ${P.jsonEach(db, "t.j", "e", "bigint")} WHERE t.id = 2`), [6]);
  assert.deepEqual(await col(db, `SELECT ${P.jsonText(db, "e.value", "$.k")} FROM ${P.jsonEach(db, "?", "e")} ORDER BY 1`, JSON.stringify([{ k: "v" }, { k: "u" }])), ["u", "v"]);
  assert.deepEqual(await col(db, `SELECT count(*) FROM ${P.jsonEach(db, "?", "e")}`, null), [0]);
});

both("insertIgnore skips a duplicate key; upsert updates the row in place", async (db) => {
  assert.equal((await db.prepare(P.insertIgnore(db, "t (id, name) VALUES (?, ?)")).run(1, "dup")).changes, 0);
  assert.equal((await db.prepare(P.insertIgnore(db, "t (id, name) VALUES (?, ?)")).run(4, "dan")).changes, 1);
  assert.deepEqual(await col(db, P.insertIgnore(db, "t (id, name) VALUES (?, ?)", "id"), 5, "eve"), [5]);
  assert.deepEqual(await col(db, P.insertIgnore(db, "t (id, name) VALUES (?, ?)", "id"), 5, "eve"), []);
  await db.prepare(P.upsert(db, { table: "t", cols: ["id", "name", "n"], key: ["id"] })).run(2, "bobby", 1);
  await db.prepare(P.upsert(db, { table: "t", cols: ["id", "name"], key: ["id"], update: [] })).run(3, "ignored");
  assert.deepEqual(await db.prepare("SELECT name, n, m FROM t WHERE id IN (2, 3) ORDER BY id").all(), [{ name: "bobby", n: 1, m: 4 }, { name: "a\\b", n: 9, m: null }]);
});

both("ciEq and like compare case-insensitively; a backslash in a pattern is literal", async (db) => {
  assert.deepEqual(await col(db, `SELECT id FROM t WHERE ${P.ciEq(db, "name", "?")}`, "ALICE"), [1]);
  assert.deepEqual(await col(db, `SELECT id FROM t WHERE ${P.ciEq(db, "login", "name")} ORDER BY id`), [1, 2]);
  assert.deepEqual(await col(db, `SELECT id FROM t WHERE ${P.like(db, "name", "?")} ORDER BY id`, "B%"), [2]);
  assert.deepEqual(await col(db, `SELECT id FROM t WHERE ${P.like(db, "name", "?")}`, "a\\b"), [3]);
  assert.deepEqual(await col(db, `SELECT id FROM t WHERE ${P.like(db, "name", "?", "!")} ORDER BY id`, "a!\\%"), [3]);
});

both("NULL ordering, NULL-safe comparison and SQLite's scalar max/min", async (db) => {
  assert.deepEqual(await col(db, `SELECT id FROM t ORDER BY ${P.nullsFirst(db, "n")}`), [2, 1, 3]);
  assert.deepEqual(await col(db, `SELECT id FROM t ORDER BY ${P.nullsLast(db, "n", "DESC")}`), [3, 1, 2]);
  assert.deepEqual(await col(db, `SELECT id FROM t WHERE ${P.distinctFrom(db, "n", "?")} ORDER BY id`, 3), [2, 3]);
  assert.deepEqual(await col(db, `SELECT id FROM t WHERE ${P.notDistinctFrom(db, "n", "?")}`, null), [2]);
  assert.deepEqual(await col(db, `SELECT ${P.greatest(db, "n", "m", "?")} FROM t ORDER BY id`, 5), [7, null, null]);
  assert.deepEqual(await col(db, `SELECT ${P.least(db, "n", "m")} FROM t ORDER BY id`), [3, null, null]);
});

both("groupConcat joins in the given order; chr builds characters", async (db) => {
  assert.deepEqual(await col(db, `SELECT ${P.groupConcat(db, "name", "|", "id DESC")} FROM t`), ["a\\b|Bob|alice"]);
  assert.deepEqual(await col(db, `SELECT ${P.groupConcat(db, "n", ",", "n")} FROM t`), ["3,9"]);
  assert.deepEqual(await col(db, `SELECT ${P.chr(db, 65, 66)}`), ["AB"]);
});

test("nowParam has strftime's text forms; rowidOf names the key or rowid", () => {
  const now = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
  assert.equal(P.nowParam({ now }), "2026-01-02T03:04:05.678Z");
  assert.equal(P.nowParam({ now, seconds: true, offsetMs: -5000 }), "2026-01-02T03:04:00Z");
  assert.equal(P.rowidOf("jobs"), "id");
  assert.equal(P.rowidOf("items"), "rowid");
  assert.throws(() => P.rowidOf("no_such_table"));
});
