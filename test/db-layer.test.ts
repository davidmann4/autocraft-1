import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { SCRATCH } from "./scratch.ts";
import { isBusy } from "../src/db.ts";
import { countQueries } from "../src/db/counter.ts";
import { dbFor, openDb, type Db } from "./helpers/raw-db.ts";
import { closeDb } from "../src/db/open.ts";
import { bindParams, parseParams } from "../src/db/params.ts";
import { sql } from "../src/db/sql.ts";
import type { Generated, Kysely } from "kysely";

/** The test table, for Kysely. */
type T = { t: { id: Generated<number>; v: string | null } };

let n = 0;
/** A fresh WAL database file and `count` handles on it, each over its own connection. */
async function handles(count: number): Promise<{ file: string; dbs: Db[] }> {
  const file = join(SCRATCH, `layer-${n++}.db`);
  const first = new DatabaseSync(file, { timeout: 5000 });
  first.exec("PRAGMA journal_mode=WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  const dbs = [await dbFor(first)];
  for (let i = 1; i < count; i++) dbs.push(await dbFor(new DatabaseSync(file, { timeout: 5000 })));
  return { file, dbs };
}
const count = async (db: Db): Promise<number> => ((await db.prepare("SELECT count(*) AS c FROM t").get()) as { c: number }).c;

test("a write transaction holds the write lock from BEGIN; a second writer times out and its busy timeout is restored", async () => {
  const { dbs: [a, b] } = await handles(2);
  let failure: unknown;
  await a!.write(async () => {
    await a!.prepare("INSERT INTO t (v) VALUES (?)").run("a");
    // b takes the lock at BEGIN, before any statement of its own.
    failure = await b!.write(async () => undefined, { lockTimeoutMs: 50 }).catch((e: unknown) => e);
    // Readers are not blocked, and do not see the open write.
    assert.equal(await count(b!), 0);
  });
  assert.ok(isBusy(failure), String(failure));
  assert.equal((b!.sync!.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout, 5000);
  assert.equal(await count(b!), 1);
});

test("a nested write joins the outer one and rolls back with it", async () => {
  const { dbs: [db] } = await handles(1);
  await assert.rejects(
    db!.write(async () => {
      await db!.prepare("INSERT INTO t (v) VALUES ('outer')").run();
      await db!.write(async () => {
        assert.ok(db!.inTransaction());
        await db!.run(db!.k.withTables<T>().insertInto("t").values({ v: "inner" }));
      });
      assert.equal(await count(db!), 2);
      throw new Error("abort");
    }),
    /abort/,
  );
  assert.equal(db!.inTransaction(), false);
  assert.equal(await count(db!), 0);
  await assert.rejects(db!.read(() => db!.write(async () => undefined)), /inside db.read/);
});

test("calls inside db.write run in the transaction, other callers wait for it, and a call left running after it throws", { timeout: 5000 }, async () => {
  const { dbs: [db] } = await handles(1);
  let outside: number | undefined;
  let stray: Promise<unknown> | undefined;
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  // Started outside the transaction, so another async context: it waits for the connection and sees only committed rows.
  const other = opened.then(async () => (outside = await count(db!)));
  await db!.write(async () => {
    await db!.prepare("INSERT INTO t (v) VALUES ('x')").run();
    open();
    await sleep(20);
    assert.equal(outside, undefined);
    // Deeper in this context, across timers, still the transaction (a call routed elsewhere would wait for it forever).
    await sleep(5).then(async () => assert.equal((await db!.all(db!.k.withTables<T>().selectFrom("t").select(sql<number>`count(*)`.as("c"))))[0]?.c, 1));
    stray = sleep(30).then(() => db!.prepare("SELECT 1").get());
  });
  await other;
  assert.equal(outside, 1);
  await assert.rejects(stray!, /after its transaction ended/);
});

test("a read snapshot keeps one view while another connection commits", async () => {
  const { dbs: [db, other] } = await handles(2);
  await db!.prepare("INSERT INTO t (v) VALUES ('before')").run();
  const seen = await db!.read(async () => {
    const first = await count(db!);
    await other!.write(() => other!.prepare("INSERT INTO t (v) VALUES ('during')").run());
    return [first, await count(db!)];
  });
  assert.equal(seen[0], seen[1]);
  assert.ok((await count(db!)) > seen[1]!);
});

test("the counter totals round trips, rows, result bytes and write-lock time by calling site", async () => {
  const { dbs: [db] } = await handles(1);
  const { counts, stop } = countQueries(db!);
  await db!.write(async () => {
    for (const v of ["a", "b", "c"]) await db!.prepare("INSERT INTO t (v) VALUES (?)").run(v);
  });
  const rows = await db!.prepare("SELECT v FROM t").all();
  stop();
  await count(db!);
  assert.ok(counts.roundTrips >= 4 + 2, `${counts.roundTrips}`); // BEGIN, 3 inserts, COMMIT, the select
  assert.equal(counts.rows, rows.length);
  assert.ok(counts.bytes >= JSON.stringify(rows).length);
  assert.ok(counts.writeLockMs > 0);
  assert.ok([...counts.sites.keys()].some((s) => s.includes("db-layer.test.ts")), [...counts.sites.keys()].join("\n"));
});

test("shared reads: a repeated select is read once and handed out as copies; a write or the end of the scope forgets it", async () => {
  const { dbs: [db] } = await handles(1);
  const k = db!.k as unknown as Kysely<T>;
  await db!.run(k.insertInto("t").values({ v: "a" }));
  const read = () => db!.all(k.selectFrom("t").select(["id", "v"]).orderBy("id"));
  const { counts, stop } = countQueries(db!);
  const after = await db!.shareReads(async () => {
    const [x, y] = await Promise.all([read(), read()]);
    x[0]!.v = "changed";
    x.push({ id: 0, v: "extra" });
    assert.deepEqual(await read(), y, "a caller's changes do not reach the others");
    const trips = counts.roundTrips;
    await db!.run(k.insertInto("t").values({ v: "b" }));
    return { trips, rows: await read() };
  });
  stop();
  assert.equal(after.trips, 1);
  assert.equal(after.rows.length, 2, "the write's row is read");
  await db!.run(k.insertInto("t").values({ v: "c" }));
  assert.equal((await db!.shareReads(read)).length, 3, "a new scope reads again");
});

test("a fresh read inside shared reads sees a row another connection changed", async () => {
  const { dbs: [db, other] } = await handles(2);
  const k = db!.k as unknown as Kysely<T>;
  await db!.run(k.insertInto("t").values({ v: "old" }));
  const read = async () => (await db!.get(k.selectFrom("t").select("v").where("id", "=", 1)))?.v;
  const seen = await db!.shareReads(async () => {
    const before = await read();
    await other!.prepare("UPDATE t SET v = 'new' WHERE id = 1").run();
    return [before, await read(), await db!.fresh(read)];
  });
  assert.deepEqual(seen, ["old", "old", "new"]);
});

test("rows are plain objects named by the statement's columns, also after the table gains a column", async () => {
  const { dbs: [db] } = await handles(1);
  await db!.prepare("INSERT INTO t (v) VALUES (?)").run("a");
  const row = await db!.prepare("SELECT * FROM t").get();
  assert.equal(Object.getPrototypeOf(row), Object.prototype);
  assert.deepEqual(row, { id: 1, v: "a" });
  await db!.script("ALTER TABLE t ADD COLUMN w TEXT DEFAULT 'x'");
  assert.deepEqual(await db!.prepare("SELECT * FROM t").all(), [{ id: 1, v: "a", w: "x" }]);
});

test("placeholders outside literals and comments bind by node:sqlite's rules", () => {
  const p = parseParams("SELECT ?, :x, '?:y', \"a?\" -- ?\n, ?3, @x, ? /* :z */, $w, a::text");
  const { text, values } = bindParams(p, [{ x: "X", w: "W" }, 1, 2, 3], (i) => `$${i + 1}`);
  assert.equal(text, "SELECT $1, $2, '?:y', \"a?\" -- ?\n, $3, $2, $4 /* :z */, $5, a::text");
  assert.deepEqual(values, [1, "X", 2, 3, "W"]);
  assert.throws(() => bindParams(p, [{ q: 1 }], String), /Unknown named parameter/);
});

test("a module closing the process's shared handle doesn't end it for the rest of the process", async () => {
  const before = process.env.AUTOCRAFT_DB;
  process.env.AUTOCRAFT_DB = join(SCRATCH, `shared-${process.pid}.db`);
  try {
    const job = await openDb();
    await (await openDb()).close();
    assert.deepEqual(await job.prepare("SELECT 1 AS one").get(), { one: 1 });
  } finally {
    await closeDb();
    if (before === undefined) delete process.env.AUTOCRAFT_DB; else process.env.AUTOCRAFT_DB = before;
  }
});
