import { test } from "node:test";
import assert from "node:assert/strict";
import type { Kysely } from "kysely";
import { queryDb, type QueryDb } from "../src/db/query-db.ts";
import { testDatabase, type TestDatabase } from "./test-db.ts";

type T = { t: { id: number; v: string | null; flag: number | null } };

const SCHEMA = "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, flag BOOLEAN); INSERT INTO t (id, v, flag) VALUES (1, 'a', TRUE), (2, 'b', FALSE), (3, 'c', TRUE)";

async function open(dialect?: "sqlite"): Promise<{ tdb: TestDatabase; db: QueryDb; k: Kysely<T> }> {
  const tdb = await testDatabase(SCHEMA, dialect);
  const db = queryDb(await tdb.open());
  return { tdb, db, k: db.k as unknown as Kysely<T> };
}

test("reads issued together return what they return alone, as copies of their own, and count the same statements", async () => {
  const { tdb, db, k } = await open();
  try {
    const all = () => db.all(k.selectFrom("t").select(["id", "v", "flag"]).orderBy("id", "desc"));
    const reads = () => Promise.all([all(), all(), db.get(k.selectFrom("t").select("v").where("id", "=", 2)), db.all(k.selectFrom("t").select("id").where("id", ">", 5))]);
    const alone = await db.meter(reads);
    const fused = await db.meter(() => db.together(reads));
    assert.deepEqual(fused.value, alone.value);
    assert.equal(fused.stats.statements, alone.stats.statements);
    assert.equal(fused.stats.rows, alone.stats.rows);
    if (db.dialect === "postgres") assert.ok(fused.stats.roundTrips < alone.stats.roundTrips, `${fused.stats.roundTrips} round trips together, ${alone.stats.roundTrips} alone`);
    const [x, y] = fused.value;
    x[0]!.v = "changed";
    assert.notEqual(y[0]!.v, "changed", "a caller's changes do not reach the other reader of the same statement");
  } finally {
    await tdb.close();
  }
});

test("reads of a wave that declare the same leading CTE share one copy of it; a CTE of that name with other content stays in its read", async () => {
  const { tdb, db, k } = await open();
  try {
    const marked = (min: number) => (db.k as any).with("m", () => k.selectFrom("t").select(["id", "v"]).where("id", ">=", min));
    const reads = () => Promise.all([
      db.all(marked(2).selectFrom("m").select("v").orderBy("v")),
      db.all(marked(2).selectFrom("m").select("id").orderBy("id")),
      db.all(marked(3).selectFrom("m").select("v")),
    ]);
    const alone = await reads();
    const texts: string[] = [];
    const stop = db.observe((e) => { if (e.kind === "query") texts.push(e.sql); });
    const fused = await db.together(reads);
    stop();
    assert.deepEqual(fused, alone);
    if (db.dialect === "postgres") {
      const wave = texts.find((t) => t.includes("json_agg")) ?? "";
      assert.ok(wave.startsWith('with "m" as'), wave);
      assert.equal(wave.match(/"m" as \(/g)?.length, 2, `the shared CTE once at the head, the other kept in its read: ${wave}`);
    }
  } finally {
    await tdb.close();
  }
});

test("a wave reads one snapshot on SQLite while another connection commits between its reads", async () => {
  const { tdb, db, k } = await open("sqlite");
  try {
    const other = await tdb.open();
    // Commits a row on the other connection right after the first read of t.
    const commitAfterFirstRead = () => {
      let done = false;
      return db.observe((e) => {
        if (done || e.kind !== "query" || !/from "t"/.test(e.sql)) return;
        done = true;
        other.sync!.exec("INSERT INTO t (id, v) VALUES ((SELECT max(id) + 1 FROM t), 'during')");
      });
    };
    const reads = () => Promise.all([
      db.get(k.selectFrom("t").select((eb) => eb.fn.countAll<number>().as("n"))),
      db.get(k.selectFrom("t").select((eb) => eb.fn.max("id").as("n"))),
    ]);
    let stop = commitAfterFirstRead();
    const [plainCount, plainMax] = await reads();
    stop();
    assert.ok(plainMax!.n > plainCount!.n, "reads outside together see the commit between them");
    stop = commitAfterFirstRead();
    const [count, max] = await db.together(reads);
    stop();
    assert.equal(max!.n, count!.n, "both reads of the wave see the table as it was at the first");
  } finally {
    await tdb.close();
  }
});

test("a write inside together goes after the reads issued before it; a wave inside db.write reads the transaction's writes; a failed read names its loader", { timeout: 10_000 }, async () => {
  const { tdb, db, k } = await open();
  try {
    const ids = () => db.all(k.selectFrom("t").select("id").orderBy("id"));
    const [before, after] = await db.together(async () => {
      const read = ids();
      const write = db.run(k.insertInto("t").values({ id: 10, v: "x" }));
      const [rows] = await Promise.all([read, write]);
      return [rows, await ids()];
    });
    assert.equal(after.length, before.length + 1);

    const seen = await db.write(async () => {
      await db.run(k.insertInto("t").values({ id: 11, v: "y" }));
      return await db.together(() => Promise.all([ids(), db.get(k.selectFrom("t").select("v").where("id", "=", 11))]));
    });
    assert.ok(seen[0].some((r) => r.id === 11));
    assert.equal(seen[1]?.v, "y");

    const missing = (db.k as unknown as Kysely<{ missing: { id: number } }>).selectFrom("missing").select("id");
    let error: unknown;
    await db.together(() => Promise.all([ids().catch(() => []), db.all(missing, { label: "test.loadMissing" }).catch((e: unknown) => void (error = e))]));
    assert.match((error as Error).message, /^test\.loadMissing: /);
  } finally {
    await tdb.close();
  }
});

test("a read of bytes inside together must be alone, whatever it goes through; a value made from the bytes may join a wave", async () => {
  const tdb = await testDatabase();
  try {
    const db = queryDb(await tdb.open({ app: true }));
    const { k } = db;
    await db.run(k.insertInto("items").values({ repo: "app", number: 1, kind: "pr", state: "OPEN" }));
    await db.run(k.insertInto("main.item_embeddings").values({ repo: "app", number: 1, model: "m", hash: "h", vec: new Uint8Array([1, 2, 3, 4]), at: "2026-01-01T00:00:00Z" }));
    const refused = [
      k.selectFrom("main.item_embeddings").select("vec"),
      k.selectFrom("item_embeddings as e").selectAll(),
      k.selectFrom("items as i").innerJoin("item_embeddings as e", (j) => j.onRef("e.repo", "=", "i.repo").onRef("e.number", "=", "i.number")).select(["i.number", "e.vec as bytes"]),
      k.with("v", (w) => w.selectFrom("item_embeddings").select(["repo", "vec"])).selectFrom("v").selectAll("v"),
      k.selectFrom(k.selectFrom("item_embeddings").select((eb) => eb.fn.coalesce("vec", "vec").as("x")).as("s")).select("s.x"),
      k.selectFrom("items as i").select((eb) => eb.selectFrom("item_embeddings as e").select("e.vec").limit(1).as("v")),
    ];
    for (const q of refused) {
      await assert.rejects(db.together(() => db.all(q as never, { label: "test.bytes" })), /^Error: test\.bytes: a read of bytes \(item_embeddings\.vec\)/, (q as { compile(): { sql: string } }).compile().sql);
    }
    const [alone, made, other] = await db.together(() => Promise.all([
      db.all(k.selectFrom("item_embeddings").select("vec"), { alone: true }),
      db.get(k.selectFrom("item_embeddings").select((eb) => eb.fn<number>("length", ["vec"]).as("n"))),
      db.all(k.selectFrom("items as i").innerJoin("item_embeddings as e", "e.repo", "i.repo").selectAll("i")),
    ]));
    assert.deepEqual([...alone[0]!.vec], [1, 2, 3, 4]);
    assert.equal(made!.n, 4);
    assert.equal(other.length, 1);
  } finally {
    await tdb.close();
  }
});
