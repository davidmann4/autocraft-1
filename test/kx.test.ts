// src/db/kx.ts and the Kysely features the conversion guide relies on: each case runs on SQLite, and on Postgres when
// AUTOCRAFT_TEST_PG_URL names a server (`pnpm test:pg test/kx.test.ts`), where its rows must equal SQLite's.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Generated } from "kysely";
import type { Dialect } from "../src/db/index.ts";
import { queryDb } from "../src/db/query-db.ts";
import type { Db } from "./helpers/raw-db.ts";
import * as kx from "../src/db/kx.ts";
import { namedKeys, registerKeySource, resolveKeys, type KeySource } from "../src/data/keys.ts";
import { parseSearch } from "../src/db/search.ts";
import { TEST_PG_URL, testDatabase } from "./test-db.ts";

type T = {
  t: { id: Generated<number>; name: string | null; login: string | null; j: string | null; n: number | null; m: number | null };
  r: { repo: string; number: number; v: string | null };
};

const J = JSON.stringify({ a: { b: "x", "c d": "y" }, n: 5, r: 1.5, ok: true, no: false, arr: ["p", "q"], nul: null, objs: [{ k: "u" }, { k: "v" }] });

async function small(dialect: Dialect, fn: (db: Db) => Promise<unknown>): Promise<unknown> {
  const t = await testDatabase("", dialect);
  try {
    const db = await t.open();
    const ci = dialect === "postgres" ? 'citext COLLATE "C"' : "TEXT COLLATE NOCASE";
    if (dialect === "postgres") await db.script("CREATE EXTENSION IF NOT EXISTS citext");
    await db.script(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, login ${ci}, j TEXT, n INTEGER, m INTEGER);
      CREATE TABLE r (repo TEXT NOT NULL, number INTEGER NOT NULL, v TEXT, PRIMARY KEY (repo, number));
      INSERT INTO t (id, name, login, j, n, m) VALUES
        (1, 'alice', 'Alice', '${J}', 3, 7),
        (2, 'Bob', 'bob', '[1, 2, 3]', NULL, 4),
        (3, 'a\\b', 'Carol', 'nope', 9, NULL);
      INSERT INTO r (repo, number, v) VALUES ('app', 1, 'one'), ('app', 2, 'two'), ('lib', 1, 'three');`);
    return await fn(db);
  } finally {
    await t.close();
  }
}

/** Runs `fn` (which asserts the expected rows) on SQLite, then on Postgres, whose result must equal SQLite's. */
function both(name: string, fn: (db: Db) => Promise<unknown>, setup = small): void {
  test(name, async () => {
    const lite = await setup("sqlite", fn);
    if (TEST_PG_URL) assert.deepEqual(await setup("postgres", fn), lite);
  });
}

const k = (db: Db) => db.k.withTables<T>();

both("JSON fields read as SQLite's json_extract, json_type, json_valid and json_remove give them", async (db) => {
  const row = await db.get(k(db).selectFrom("t").where("id", "=", 1).select([
    kx.jsonText(db, "j", "$.a.b").as("ab"), kx.jsonText(db, "j", '$.a."c d"').as("cd"), kx.jsonText(db, "j", "$.arr[1]").as("arr1"),
    kx.jsonText(db, "j", "$.missing").as("missing"), kx.jsonNum(db, "j", "$.n").as("n"), kx.jsonNum(db, "j", "$.r").as("r"),
    kx.jsonBool(db, "j", "$.ok").as("ok"), kx.jsonBool(db, "j", "$.no").as("no"), kx.jsonType(db, "j", "$.a").as("ta"),
    kx.jsonType(db, "j", "$.arr").as("tarr"), kx.jsonType(db, "j", "$.n").as("tn"), kx.jsonType(db, "j", "$.r").as("tr"),
    kx.jsonType(db, "j", "$.ok").as("tok"), kx.jsonType(db, "j", "$.nul").as("tnul"), kx.jsonType(db, "j", "$.missing").as("tmissing"),
    kx.jsonType(db, kx.json([])).as("whole"),
    kx.jsonText(db, kx.jsonRemoveKey(db, "j", "a"), "$.a").as("removed"), kx.jsonNum(db, kx.jsonRemoveKey(db, "j", "a"), "$.n").as("kept"),
  ]));
  assert.deepEqual(row, {
    ab: "x", cd: "y", arr1: "q", missing: null, n: 5, r: 1.5, ok: 1, no: 0, ta: "object", tarr: "array", tn: "integer", tr: "real",
    tok: "true", tnul: "null", tmissing: null, whole: "array", removed: null, kept: 5,
  });
  const valid = await db.all(k(db).selectFrom("t").select(["id", kx.jsonValid(db, "j").as("ok")]).where(kx.jsonValid(db, "j")).orderBy("id"));
  assert.deepEqual(valid, [{ id: 1, ok: 1 }, { id: 2, ok: 1 }]);
  return [row, valid];
});

both("jsonEachField reads one key of each object and takes any other text for an empty list", async (db) => {
  const of = async (text: string) => {
    const f = kx.jsonEachField(db, "v.j", "name", "e");
    return (await db.all(k(db).selectFrom(kx.valuesTable(db, [{ j: text }], { j: "text" }, "v")).crossJoin(f.from).select(f.value.as("name")))).map((r) => r.name).sort();
  };
  assert.deepEqual(await of('[{"name":"b","x":1},{"name":"a"}]'), ["a", "b"]);
  assert.deepEqual(await of('[{"x":1},"s",5,null,[1]]'), [null, null, null, null, null]);
  for (const text of ['{"name":"a"}', "not json", "", "5"]) assert.deepEqual(await of(text), [], text);
  return null;
});

both("jsonEach joins array elements as `value` after the table it reads", async (db) => {
  const arr = await db.all(k(db).selectFrom("t").crossJoin(kx.jsonEach(db, kx.jsonText(db, "t.j", "$.arr"), "e")).select(["t.id", "e.value"]).where("t.id", "=", 1).orderBy("e.value"));
  assert.deepEqual(arr, [{ id: 1, value: "p" }, { id: 1, value: "q" }]);
  const sum = await db.get(k(db).selectFrom(["t", kx.jsonEach(db, "t.j", "e", "bigint")]).select((eb) => eb.fn.sum<number>("e.value").as("s")).where("t.id", "=", 2));
  assert.deepEqual(sum, { s: 6 });
  const objs = await db.all(k(db).selectFrom(kx.jsonEach(db, kx.json([{ k: "v" }, { k: "u" }]), "e")).select(kx.jsonText(db, "e.value", "$.k").as("k")).orderBy("k"));
  assert.deepEqual(objs, [{ k: "u" }, { k: "v" }]);
  const left = await db.all(k(db).selectFrom("t").leftJoin(kx.jsonEach(db, kx.jsonText(db, "t.j", "$.none"), "e"), (j) => j.onTrue()).select(["t.id", "e.value"]).where("t.id", "=", 1));
  assert.deepEqual(left, [{ id: 1, value: null }]);
  return [arr, sum, objs, left];
});

both("inList matches a JS list bound as one parameter; empty matches nothing", async (db) => {
  const ids = async (cond: ReturnType<typeof kx.inList>) =>
    (await db.all(k(db).selectFrom("t").select("id").where(cond).orderBy("id"))).map((r) => r.id);
  const out = [
    await ids(kx.inList(db, "id", [1, 3], "bigint")),
    await ids(kx.inList(db, "name", ["Bob", "x"])),
    await ids(kx.inList(db, "login", ["alice", "CAROL"], "citext")),
    await ids(kx.inList(db, "id", [2], "bigint", true)),
    await ids(kx.inList(db, "id", [], "bigint")),
  ];
  assert.deepEqual(out, [[1, 3], [2], [1, 3], [1, 3], []]);
  return out;
});

both("refPairs and refIn select rows by repo#number refs", async (db) => {
  const joined = await db.all(k(db).selectFrom("r").innerJoin(kx.refPairs(db, ["app#2", "lib#1", "bad", "nope#x"], "rp"), (j) => j.onRef("rp.repo", "=", "r.repo").onRef("rp.number", "=", "r.number"))
    .select(["r.v", "rp.number"]).orderBy("r.v"));
  assert.deepEqual(joined, [{ v: "three", number: 1 }, { v: "two", number: 2 }]);
  const inn = await db.all(k(db).selectFrom("r as x").select("x.v").where(kx.refIn(db, "x", [["app", 1], ["lib", 1]])).orderBy("x.v"));
  assert.deepEqual(inn, [{ v: "one" }, { v: "three" }]);
  assert.deepEqual(await db.all(k(db).selectFrom("r").select("v").where(kx.refIn(db, "r", []))), []);
  return [joined, inn];
});

both("indexedBy reads through a partial index on SQLite and the plain table on Postgres; literal values match the index's WHERE", async (db) => {
  await db.script("CREATE INDEX r_lib ON r(number) WHERE repo = 'lib'");
  const rows = await db.all(k(db).selectFrom(kx.indexedBy<"r", "x", T>(db, "r", "r_lib", "x")).select(["x.number", "x.v"])
    .where("x.repo", "=", kx.literal("lib")).where("x.number", ">", 0).orderBy("x.number"));
  assert.deepEqual(rows, [{ number: 1, v: "three" }]);
  // A bound value does not match the partial index's WHERE: SQLite refuses the hint.
  if (db.dialect === "sqlite") await assert.rejects(db.all(k(db).selectFrom(kx.indexedBy<"r", "x", T>(db, "r", "r_lib", "x")).select("x.v").where("x.repo", "=", "lib")));
  return rows;
});

both("onConflict skips a duplicate key or updates the row in place; INSERT ... SELECT needs a WHERE on SQLite", async (db) => {
  const ins = (id: number, name: string) => k(db).insertInto("t").values({ id, name }).onConflict((oc) => oc.doNothing());
  assert.equal((await db.run(ins(1, "dup"))).changes, 0);
  assert.equal((await db.run(ins(4, "dan"))).changes, 1);
  assert.deepEqual(await db.all(ins(5, "eve").returning("id")), [{ id: 5 }]);
  assert.deepEqual(await db.all(ins(5, "eve").returning("id")), []);
  await db.run(k(db).insertInto("t").values({ id: 2, name: "bobby", n: 1 }).onConflict((oc) => oc.column("id").doUpdateSet(kx.excluded(["name", "n"]))));
  await db.run(k(db).insertInto("t").values({ id: 3, name: "ignored" }).onConflict((oc) => oc.column("id").doNothing()));
  // SQLite reads `SELECT ... FROM x ON CONFLICT` as a join constraint without a WHERE before ON CONFLICT.
  await db.run(k(db).insertInto("r").columns(["repo", "number", "v"])
    .expression((eb) => eb.selectFrom("t").select([eb.val("t").as("repo"), "id", "name"]).where(eb.lit(true)))
    .onConflict((oc) => oc.columns(["repo", "number"]).doNothing()));
  const rows = await db.all(k(db).selectFrom("t").select(["id", "name", "n", "m"]).where("id", "in", [2, 3]).orderBy("id"));
  assert.deepEqual(rows, [{ id: 2, name: "bobby", n: 1, m: 4 }, { id: 3, name: "a\\b", n: 9, m: null }]);
  const copied = await db.get(k(db).selectFrom("r").select((eb) => eb.fn.countAll<number>().as("c")).where("repo", "=", "t"));
  assert.deepEqual(copied, { c: 5 });
  return [rows, copied];
});

both("ciEq, nocase and like compare as SQLite's NOCASE, bytewise by code point; a backslash in a pattern is literal", async (db) => {
  const sel = () => k(db).selectFrom("t").select("id").orderBy("id");
  const col = async (q: ReturnType<typeof sel>) => (await db.all(q)).map((r) => r.id);
  const out = [
    await col(sel().where((eb) => kx.ciEq(db, "name", eb.val("ALICE")))),
    await col(sel().where(kx.ciEq(db, "login", "name"))),
    await col(sel().where((eb) => kx.like(db, "name", eb.val("B%")))),
    await col(sel().where((eb) => kx.like(db, "name", eb.val("a\\b")))),
    await col(sel().where((eb) => kx.like(db, "name", eb.val(`${kx.likeEscape("a\\")}%`), "\\"))),
    await col(sel().where((eb) => kx.like(db, "name", eb.val(`%${kx.likeEscape("_")}%`), "\\"))),
    (await db.all(k(db).selectFrom("t").select("name").orderBy(kx.nocase(db, "name")))).map((r) => r.name),
    (await db.all(k(db).selectFrom(kx.jsonEach(db, kx.json(["b", "B", "a"]), "e")).select("e.value").orderBy(kx.bytewise(db, "e.value")))).map((r) => r.value),
  ];
  assert.deepEqual(out, [[1], [1, 2], [2], [3], [3], [], ["a\\b", "alice", "Bob"], ["B", "a", "b"]]);
  return out;
});

both("nocase sorts ASCII-folded by code point, not in the database's collation: `_` before letters", async (db) => {
  const e = kx.jsonEach(db, kx.json(["b", "B", "a", "_x"]), "e");
  const out = (await db.all(k(db).selectFrom(e).select("e.value").orderBy(kx.nocase(db, "e.value")).orderBy(kx.bytewise(db, "e.value")))).map((r) => r.value);
  assert.deepEqual(out, ["_x", "a", "B", "b"]);
  return out;
});

both("NULL order, IS DISTINCT FROM, scalar greatest/least and ordered group concat", async (db) => {
  const ids = (rows: { id: number }[]) => rows.map((r) => r.id);
  const out = [
    ids(await db.all(k(db).selectFrom("t").select("id").orderBy("n", (o) => o.asc().nullsFirst()))),
    ids(await db.all(k(db).selectFrom("t").select("id").orderBy("n", (o) => o.desc().nullsLast()))),
    ids(await db.all(k(db).selectFrom("t").select("id").where("n", "is distinct from", 3).orderBy("id"))),
    ids(await db.all(k(db).selectFrom("t").select("id").where("n", "is not distinct from", null))),
    await db.all(k(db).selectFrom("t").select((eb) => [kx.greatest(db, ["n", "m", eb.val(5)]).as("g"), kx.least(db, ["n", "m"]).as("l")]).orderBy("id")),
    await db.get(k(db).selectFrom("t").select([kx.groupConcat(db, "name", "|", "id", "desc").as("names"), kx.groupConcat(db, "n", ",", "n").as("ns")])),
  ];
  assert.deepEqual(out, [[2, 1, 3], [3, 1, 2], [2, 3], [2], [{ g: 7, l: 3 }, { g: null, l: null }, { g: null, l: null }], { names: "a\\b|Bob|alice", ns: "3,9" }]);
  return out;
});

async function app(dialect: Dialect, fn: (db: Db) => Promise<unknown>): Promise<unknown> {
  const t = await testDatabase("", dialect);
  try {
    const db = await t.open({ app: true });
    await db.run(db.k.insertInto("main.tracked_repos").values({ name: "app" }));
    await db.run(db.k.insertInto("main.items").values([
      { repo: "app", number: 1, kind: "issue", state: "OPEN", title: "Crash when saving files", body: "The editor crashes on save." },
      { repo: "app", number: 2, kind: "issue", state: "OPEN", title: "Slow startup", body: "Saving is fine, startup takes long." },
      { repo: "other", number: 3, kind: "pr", state: "OPEN", title: "Fix saving", body: "Fixes the crash." },
    ]));
    await db.run(db.k.insertInto("main.comments").values([
      { repo: "app", number: 2, id: "c1", author: "ann", body: "It crashes for me too when I save." },
      { repo: "app", number: 1, id: "c2", author: "bo", body: "Unrelated note." },
    ]));
    return await fn(db);
  } finally {
    await t.close();
  }
}

both("itemHits and commentHits find matches by title, body and comment with snippets", async (db) => {
  const s = parseSearch("crash")!;
  const items = await db.all(db.k.selectFrom(kx.itemHits(db, s, { snippets: { open: "[", close: "]", words: 8 } }, "h"))
    .innerJoin("items as i", (j) => j.on(kx.rowid("items", "i"), "=", (eb) => eb.ref("h.rid")))
    .select(["i.repo", "i.number", "h.title_snippet", "h.body_snippet"]).orderBy("h.rid"));
  assert.deepEqual(items.map((r) => `${r.repo}#${r.number}`), ["app#1", "other#3"]);
  assert.match(items[0]!.title_snippet ?? "", /\[Crash\]/);
  const titles = await db.all(db.k.selectFrom(kx.itemHits(db, parseSearch("sav", true)!, { titleOnly: true, score: true }, "h")).select("h.rid").orderBy("h.score").orderBy("h.rid"));
  assert.equal(titles.length, 2);
  const comments = await db.all(db.k.selectFrom(kx.commentHits(db, s, { score: true, snippet: { open: "[", close: "]", words: 8 } }, "c")).select(["c.repo", "c.number", "c.id", "c.author", "c.snippet"]).orderBy("c.score"));
  assert.deepEqual(comments.map((c) => [c.id, c.author]), [["c1", "ann"]]);
  assert.match(comments[0]!.snippet ?? "", /\[crashes\]/);
  // Snippet text and ranking scores differ in detail between the engines; compare the matched rows.
  return [items.map((r) => [r.repo, r.number]), titles.length, comments.map((c) => [c.repo, c.number, c.id])];
}, app);

both("rowid names the key or rowid; main. reaches past the scoped views on both engines", async (db) => {
  const rids = await db.all(db.k.selectFrom("items").select(["repo", kx.rowid("items").as("rid")]).orderBy(kx.rowid("items")));
  assert.deepEqual(rids.map((r) => r.repo), ["app", "app", "other"]);
  assert.ok(rids.every((r) => typeof r.rid === "number"));
  await db.scope();
  const scoped = await db.all(db.k.selectFrom("items").select("number").orderBy("number"));
  const all = await db.all(db.k.selectFrom("main.items").select("main.items.number").orderBy("main.items.number"));
  await db.run(db.k.updateTable("main.items").set({ state: "CLOSED" }).where("repo", "=", "other"));
  const closed = await db.all(db.k.selectFrom("main.items as i").select("i.number").where("i.state", "=", "CLOSED"));
  assert.deepEqual([scoped, all, closed], [[{ number: 1 }, { number: 2 }], [{ number: 1 }, { number: 2 }, { number: 3 }], [{ number: 3 }]]);
  return [scoped, all, closed];
}, app);

both("jsonObject builds an object whose values are JSON texts; Postgres spaces the text differently", async (db) => {
  const row = await db.get(k(db).selectFrom("t").where("id", "=", 2).select(kx.jsonObject(db, { d: "j", a: kx.json(["x", 1]) }).as("o")));
  const o = JSON.parse(row!.o!);
  assert.deepEqual(o, { d: [1, 2, 3], a: ["x", 1] });
  return o;
});

both("rowArray reads the first row of each of several queries as a JSON array in select order, in one statement", async (db) => {
  const qs = [
    k(db).selectFrom("t").select(["name", "n", "m as other"]).where("id", "=", 2),
    k(db).selectFrom("r").select((eb) => [eb.fn.countAll<number>().as("count"), kx.groupConcat(db, "v", ",", "number").as("vs"), eb.fn.max<number | null>("number").as("top")]).where("repo", "=", "app"),
    k(db).selectFrom("r").select("v").orderBy("number", "desc").limit(1),
    k(db).selectFrom("t").select("name").where("id", "=", 99),
  ];
  const row = await db.get(db.k.selectNoFrom(qs.map((q, i) => kx.rowArray(db, q).as(`c${i}`))));
  const arrays = Object.values(row!).map((v) => (v === null ? null : JSON.parse(v as string)));
  assert.deepEqual(arrays, [["Bob", null, 4], [2, "one,two", 2], ["two"], null]);
  return arrays;
});

both("trimChars strips the given characters from both ends only", async (db) => {
  const row = await db.get(db.k.selectNoFrom((eb) => [kx.trimChars(db, eb.val(" \n\ta b\t\n "), " \n\t").as("t"), kx.trimChars(db, eb.val("xxaxbxx"), "x").as("x")]));
  assert.deepEqual(row, { t: "a b", x: "axb" });
  return row;
});

both("cols selects a table's whole row: every column selectAll() reads, without rowid or Postgres' full-text column", async (db) => {
  const whole = await db.all(db.k.selectFrom("main.items as i").select(kx.cols("main.items", "i")).orderBy("i.number"));
  const all: Record<string, unknown>[] = await db.all(db.k.selectFrom("main.items").selectAll().orderBy("number"));
  for (const r of all) { delete r.rowid; delete r.fts; }
  assert.deepEqual(whole, all);
  assert.ok(!("rowid" in whole[0]!) && !("fts" in whole[0]!));
  assert.deepEqual(whole.map((r) => [r.repo, r.number, r.title]), [["app", 1, "Crash when saving files"], ["app", 2, "Slow startup"], ["other", 3, "Fix saving"]]);
  return [Object.keys(whole[0]!), whole.map((r) => [r.repo, r.number])];
}, app);

both("tupleIn matches rows of any width against a list of tuples; an empty list matches nothing", async (db) => {
  const three = await db.all(k(db).selectFrom("r").select(["repo", "number"])
    .where(() => kx.tupleIn(db, ["repo", "number", "v"], [["app", 1, "one"], ["lib", 1, "three"], ["app", 2, "nope"]], ["text", "bigint", "text"]))
    .orderBy("repo").orderBy("number"));
  assert.deepEqual(three, [{ repo: "app", number: 1 }, { repo: "lib", number: 1 }]);
  const ci = await db.all(k(db).selectFrom("t").select("id").where(() => kx.tupleIn(db, ["login", "n"], [["alice", 3], ["BOB", null], ["carol", 9]], ["citext", "bigint"])).orderBy("id"));
  assert.deepEqual(ci, [{ id: 1 }, { id: 3 }]);
  const none = await db.all(k(db).selectFrom("r").select("repo").where(() => kx.tupleIn(db, ["repo", "number", "v"], [], ["text", "bigint", "text"])));
  assert.deepEqual(none, []);
  return [three, ci, none];
});

both("jsonRows returns a subselect's rows as one JSON array in order, [] when none", async (db) => {
  const rows = await db.all(k(db).selectFrom("t as a").select([
    "a.id",
    kx.jsonRows(db, k(db).selectFrom("r").select(["r.repo", "r.number", "r.v"]).where("r.number", "<=", kx.ref<number>("a.id")).orderBy("r.v", "desc")).as("rs"),
  ]).orderBy("a.id"));
  const parsed = rows.map((r) => ({ id: r.id, rs: kx.parseJsonRows(r.rs) }));
  assert.deepEqual(parsed, [
    { id: 1, rs: [{ repo: "app", number: 1, v: "one" }, { repo: "lib", number: 1, v: "three" }].sort((a, b) => (a.v < b.v ? 1 : -1)) },
    { id: 2, rs: [{ repo: "app", number: 2, v: "two" }, { repo: "lib", number: 1, v: "three" }, { repo: "app", number: 1, v: "one" }] },
    { id: 3, rs: [{ repo: "app", number: 2, v: "two" }, { repo: "lib", number: 1, v: "three" }, { repo: "app", number: 1, v: "one" }] },
  ]);
  const none = await db.get(db.k.selectNoFrom(kx.jsonRows(db, k(db).selectFrom("r").select("v").where("v", "=", "zzz")).as("x")));
  assert.deepEqual(kx.parseJsonRows(none?.x), []);
  return parsed;
});

both("valuesTable binds rows as one parameter, typed per column", async (db) => {
  const rows = [{ id: 2, label: "b" }, { id: 1, label: "a" }, { id: 7, label: null }];
  const joined = await db.all(k(db).selectFrom("t").innerJoin(kx.valuesTable(db, rows, { id: "bigint", label: "text" }, "v"), (j) => j.onRef("v.id", "=", "t.id"))
    .select(["t.name", "v.label"]).orderBy("v.id"));
  assert.deepEqual(joined, [{ name: "alice", label: "a" }, { name: "Bob", label: "b" }]);
  const empty = await db.all(k(db).selectFrom(kx.valuesTable(db, [], { id: "bigint" }, "v")).select("v.id"));
  assert.deepEqual(empty, []);
  return [joined, empty];
});

both("updateFrom sets different values on many rows in one statement and counts the rows changed", async (db) => {
  const changed = await kx.updateFrom(db, "t", ["id"], [{ id: 1, name: "one", n: 10 }, { id: 3, name: "three", n: null }, { id: 99, name: "none", n: 1 }]);
  assert.equal(changed, 2);
  assert.equal(await kx.updateFrom(db, "t", ["id"], []), 0);
  await kx.updateFrom(db, "t", ["id"], [{ id: 2, name: "x", n: 5 }], ["name"]);
  const rows = await db.all(k(db).selectFrom("t").select(["id", "name", "n"]).orderBy("id"));
  assert.deepEqual(rows, [{ id: 1, name: "one", n: 10 }, { id: 2, name: "x", n: null }, { id: 3, name: "three", n: null }]);
  return rows;
});

both("blobTable carries blobs and NULLs beside keys", async (db) => {
  const v = kx.blobTable(db, [{ id: 1, vec: new Uint8Array([1, 2]), name: "one" }, { id: 3, vec: new Uint8Array([]), name: null }], { id: "bigint", vec: "bytea", name: "text" }, "v");
  const rows = await db.all(k(db).selectFrom("t").innerJoin(v, (j) => j.onRef("v.id", "=", "t.id")).select(["t.id", "t.login", "v.vec", "v.name"]).orderBy("t.id"));
  const seen = rows.map((r) => [r.id, r.login, [...r.vec], r.name]);
  assert.deepEqual(seen, [[1, "Alice", [1, 2], "one"], [3, "Carol", [], null]]);
  return seen;
});

both("byteLength counts UTF-8 bytes; isoMinusHours keeps toISOString's form", async (db) => {
  const row = await db.get(k(db).selectFrom("t").where("id", "=", 1).select((eb) => [
    kx.byteLength(db, kx.literal("naïve ✓")).as("bytes"), kx.isoMinusHours(db, kx.literal("2026-03-01T00:30:00.250Z"), 1).as("before"), kx.isoMinusHours(db, eb.val(null), 1).as("none"),
  ]));
  assert.deepEqual({ ...row, bytes: Number(row!.bytes) }, { bytes: Buffer.byteLength("naïve ✓"), before: "2026-02-28T23:30:00.250Z", none: null });
  return row;
});

test("chunks slices a list, 10,000 by default", () => {
  assert.deepEqual(kx.chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(kx.chunks([]), []);
  assert.equal(kx.chunks(Array.from({ length: 25_000 }, (_, i) => i)).length, 3);
});

registerKeySource("test.repoKeys", (d, args: { repo: string }) => queryDb(d).k.withTables<T>().selectFrom("r").select(["repo", "number"]).where("repo", "=", args.repo) as never);

both("resolveKeys turns a ref list or a registered descriptor into a (repo, number) table", async (db) => {
  const keys = async (ks: KeySource) => await db.all(k(db).selectFrom(resolveKeys(db, ks, "ks")).select(["ks.repo", "ks.number"]).orderBy("ks.repo").orderBy("ks.number"));
  const list = await keys([{ repo: "app", number: 2 }, { repo: "lib", number: 1 }]);
  assert.deepEqual(list, [{ repo: "app", number: 2 }, { repo: "lib", number: 1 }]);
  assert.deepEqual(await keys([]), []);
  const named = await keys(namedKeys("test.repoKeys", { repo: "app" }));
  assert.deepEqual(named, [{ repo: "app", number: 1 }, { repo: "app", number: 2 }]);
  assert.throws(() => resolveKeys(db, namedKeys("test.unregistered", {}), "ks"), /test\.unregistered/);
  return [list, named];
});
