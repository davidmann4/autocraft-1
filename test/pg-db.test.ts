// The Db handle on Postgres: transaction semantics, the writer lock, parameter rewriting and value shapes. Runs only
// against a server (AUTOCRAFT_TEST_PG_URL; `pnpm test:pg` starts one) and is skipped with the reason otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { connect as netConnect, createServer, type AddressInfo, type Socket } from "node:net";
import { join } from "node:path";
import { SCRATCH } from "./scratch.ts";
import { countQueries } from "../src/db/counter.ts";
import { isLockTimeout } from "../src/db/errors.ts";
import { rewriteScriptForPostgres } from "../src/db/params.ts";
import { connectDb, type Db } from "./helpers/raw-db.ts";
import { needsPg, TEST_PG_URL, testDatabase } from "./test-db.ts";
import type { Generated } from "kysely";

/** The test table, for Kysely. */
type T = { t: { id: Generated<number>; v: string | null } };

const SCHEMA = "CREATE TABLE t (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, v TEXT, b BYTEA)";
const count = async (db: Db): Promise<number> => ((await db.prepare("SELECT count(*) AS c FROM t").get()) as { c: number }).c;

test("a read is one snapshot that refuses writes", { skip: needsPg }, async () => {
  const t = await testDatabase(SCHEMA);
  try {
    const [a, b] = [await t.open(), await t.open()];
    await a.read(async () => {
      assert.equal(await count(a), 0);
      await b.prepare("INSERT INTO t (v) VALUES ('other')").run();
      assert.equal(await count(a), 0, "a commit after the snapshot began is not visible in it");
    });
    assert.equal(await count(a), 1);
    // A failed statement aborts a Postgres transaction, so the refusal ends the read.
    await assert.rejects(a.read(() => a.prepare("INSERT INTO t (v) VALUES ('mine')").run()), { code: "25006" });
    assert.equal(await count(a), 1);
  } finally {
    await t.close();
  }
});

test("writes take the one writer lock: a second writer waits for the commit, and a short wait fails as a lock timeout", { skip: needsPg }, async () => {
  const t = await testDatabase(SCHEMA);
  try {
    const [a, b] = [await t.open(), await t.open()];
    let waiter: Promise<number> | undefined;
    let failure: unknown;
    await a.write(async () => {
      await a.prepare("INSERT INTO t (v) VALUES ('a')").run();
      failure = await b.write(async () => undefined, { lockTimeoutMs: 100 }).catch((e: unknown) => e);
      // This one waits for a's commit, then sees a's row: writes run one after another, each seeing the last.
      waiter = b.write(() => count(b));
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(await count(b), 0, "readers are not blocked and do not see the open write");
    });
    assert.ok(isLockTimeout(failure), String(failure));
    assert.equal(await waiter, 1);
    // The handle that timed out still works: its transaction was rolled back, not left open on a pooled connection.
    await b.write(() => b.prepare("INSERT INTO t (v) VALUES ('b')").run());
    assert.equal(await count(a), 2);
  } finally {
    await t.close();
  }
});

test("a write under a named lock, and a lone write of a rowWrites handle, run while another write holds the writer lock", { skip: needsPg }, async () => {
  const t = await testDatabase(SCHEMA);
  try {
    const [a, b] = [await t.open(), await t.open({ busyTimeoutMs: 200, rowWrites: true })];
    await a.prepare("INSERT INTO t (v) VALUES ('first')").run();
    let writer: unknown, sameName: unknown;
    await a.write(async () => {
      await a.prepare("INSERT INTO t (v) VALUES ('a')").run();
      await b.prepare("UPDATE t SET v = 'lone' WHERE v = 'first'").run();
      await b.write(() => b.prepare("INSERT INTO t (v) VALUES ('named')").run(), { lock: "k" });
      writer = await b.write(async () => undefined).catch((e: unknown) => e);
    });
    assert.ok(isLockTimeout(writer), `a write under the writer lock still waits for it: ${String(writer)}`);
    assert.equal(await count(a), 3);
    // Writes under the same name run one at a time.
    await b.write(async () => {
      sameName = await a.write(async () => undefined, { lock: "k", lockTimeoutMs: 100 }).catch((e: unknown) => e);
    }, { lock: "k" });
    assert.ok(isLockTimeout(sameName), String(sameName));
  } finally {
    await t.close();
  }
});

test("db.exclusive excludes holders of one name across handles, and a holder that throws releases it", { skip: needsPg }, async () => {
  const t = await testDatabase(SCHEMA);
  try {
    const [a, b] = [await t.open(), await t.open()];
    let inside = 0;
    let overlapped = false;
    const hold = (db: Db) => db.exclusive("refresh:x", async () => {
      overlapped ||= ++inside > 1;
      await new Promise((r) => setTimeout(r, 30));
      inside--;
    });
    await Promise.all([hold(a), hold(b), hold(a), hold(b)]);
    assert.equal(overlapped, false);
    await assert.rejects(a.exclusive("refresh:x", async () => { throw new Error("boom"); }), /boom/);
    assert.equal(await b.exclusive("refresh:x", async () => "free", 1000), "free");
  } finally {
    await t.close();
  }
});

test("a nested write joins the outer one on its connection and rolls back with it", { skip: needsPg }, async () => {
  const t = await testDatabase(SCHEMA);
  try {
    const [a, b] = [await t.open(), await t.open()];
    await assert.rejects(
      a.write(async () => {
        await a.prepare("INSERT INTO t (v) VALUES ('outer')").run();
        await a.write(async () => {
          assert.ok(a.inTransaction());
          await a.run(a.k.withTables<T>().insertInto("t").values({ v: "inner" }));
        });
        // Calls in parallel inside the transaction all run in it.
        const seen = await Promise.all([count(a), count(a), a.read(() => count(a))]);
        assert.deepEqual(seen, [2, 2, 2]);
        assert.equal(await count(b), 0);
        throw new Error("abort");
      }),
      /abort/,
    );
    assert.equal(a.inTransaction(), false);
    assert.equal(await count(a), 0);
  } finally {
    await t.close();
  }
});

test("a statement error inside db.attempt leaves the write usable: its own changes are undone, the rest commit", { skip: needsPg }, async () => {
  const t = await testDatabase(`${SCHEMA}; CREATE UNIQUE INDEX t_v ON t (v)`);
  try {
    const a = await t.open();
    await a.write(async () => {
      await a.prepare("INSERT INTO t (v) VALUES ('kept')").run();
      const dup = await a.attempt(async () => {
        await a.prepare("INSERT INTO t (v) VALUES ('undone')").run();
        await a.prepare("INSERT INTO t (v) VALUES ('kept')").run();
      }).catch((e: unknown) => e);
      assert.equal((dup as { code?: string }).code, "23505");
      assert.equal(await a.attempt(() => count(a)), 1);
      await a.prepare("INSERT INTO t (v) VALUES ('after')").run();
    });
    const rows = await a.prepare("SELECT v FROM t ORDER BY id").all();
    assert.deepEqual(rows.map((r) => r.v), ["kept", "after"]);
  } finally {
    await t.close();
  }
});

test("? and :name placeholders become $n by node:sqlite's binding rules, outside literals and casts", { skip: needsPg }, async () => {
  const t = await testDatabase();
  try {
    const db = await t.open();
    const row = await db.prepare("SELECT ? AS a, :x AS b, '?:y' AS lit, ? AS c, ?::int AS n, :x AS again").get({ x: "X" }, "A", "C", "7");
    assert.deepEqual(row, { a: "A", b: "X", lit: "?:y", c: "C", n: 7, again: "X" });
    await assert.rejects(db.prepare("SELECT ? AS a").get("1", "2"), /Too many parameters/);
  } finally {
    await t.close();
  }
});

test("values come back in node:sqlite's shapes, and run results have no insert id", { skip: needsPg }, async () => {
  const t = await testDatabase(SCHEMA);
  try {
    const db = await t.open();
    const r = await db.prepare("INSERT INTO t (v, b) VALUES (?, ?), (?, ?)").run("x", new Uint8Array([1, 2]), "y", null);
    assert.equal(r.changes, 2);
    assert.throws(() => r.lastInsertRowid, /RETURNING/);
    const row = await db.prepare("SELECT count(*) AS big, sum(id)::numeric / 2 AS num, bool_or(v = 'x') AS yes, bool_and(v = 'x') AS no, (SELECT b FROM t WHERE v = 'x') AS bin FROM t").get() as Record<string, unknown>;
    assert.equal(typeof row.big, "number");
    assert.equal(typeof row.num, "number");
    assert.deepEqual([row.yes, row.no], [1, 0]);
    assert.equal(Object.getPrototypeOf(row.bin), Uint8Array.prototype);
    assert.deepEqual(row.bin, new Uint8Array([1, 2]));
  } finally {
    await t.close();
  }
});

test("the counter sees round trips, rows and write-lock time on Postgres", { skip: needsPg }, async () => {
  const t = await testDatabase(SCHEMA);
  try {
    const db = await t.open();
    const { counts, stop } = countQueries(db);
    await db.write(async () => {
      await db.prepare("INSERT INTO t (v) VALUES ('a'), ('b')").run();
      await db.prepare("SELECT v FROM t").all();
    });
    stop();
    // BEGIN with the lock, two statements, COMMIT.
    assert.ok(counts.roundTrips >= 4, String(counts.roundTrips));
    assert.ok(counts.rows >= 2);
    assert.ok(counts.maxWriteLockMs > 0);
    assert.ok([...counts.sites.keys()].some((s) => s.includes("pg-db.test.ts")), [...counts.sites.keys()].join("\n"));
  } finally {
    await t.close();
  }
});

test("SQLite-only statement text is rewritten: schema prefixes, INSERT OR IGNORE, and INSERT OR REPLACE is refused", { skip: needsPg }, async () => {
  const t = await testDatabase("CREATE TABLE u (id BIGINT PRIMARY KEY, v TEXT)");
  try {
    const db = await t.open();
    await db.prepare("INSERT OR IGNORE INTO main.u (id, v) VALUES (1, 'main.x')").run();
    await db.prepare("insert or ignore into u (id, v) values (1, 'dup')").run();
    const r = await db.prepare("INSERT OR IGNORE INTO u (id, v) VALUES (?, 'b') RETURNING id").all(2);
    assert.deepEqual(r, [{ id: 2 }]);
    assert.deepEqual(await db.prepare("INSERT OR IGNORE INTO u (id, v) VALUES (2, 'dup') RETURNING id").all(), []);
    const rows = await db.prepare("SELECT a.v FROM main.u a JOIN main.u b ON b.id = a.id WHERE a.id = 1 AND a.v = 'main.x'").all();
    assert.deepEqual(rows, [{ v: "main.x" }], "the literal keeps its prefix");
    await assert.rejects(db.prepare("INSERT OR IGNORE INTO u (id) VALUES (3) ON CONFLICT DO NOTHING").run(), /ON CONFLICT/);
    await assert.rejects(db.prepare("INSERT OR REPLACE INTO u (id, v) VALUES (1, 'z')").run(), /INSERT OR REPLACE/);
  } finally {
    await t.close();
  }
});

test("a script is rewritten statement by statement, leaving literals and dollar-quoted bodies alone", () => {
  assert.equal(
    rewriteScriptForPostgres("CREATE TABLE main.x (a int); INSERT OR IGNORE INTO main.x VALUES (1); SELECT 'a;main.b'"),
    "CREATE TABLE x (a int); INSERT INTO x VALUES (1) ON CONFLICT DO NOTHING; SELECT 'a;main.b'",
  );
  const fn = "CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN INSERT INTO main.t VALUES (1); RETURN NEW; END $$ LANGUAGE plpgsql;";
  assert.equal(rewriteScriptForPostgres(fn), fn);
});

test("a statement whose answer is lost fails after the statement timeout and its margin, the pool opens a new connection, and a connection that never opens fails too", { skip: needsPg, timeout: 30_000 }, async () => {
  // A proxy to the test server that can drop what the server sends, as a server or proxy that vanished without closing the connection.
  const server = new URL(TEST_PG_URL!);
  const host = decodeURIComponent(server.hostname);
  const to = host.startsWith("/") ? { path: `${host}/.s.PGSQL.${server.port || 5432}` } : { host, port: Number(server.port || 5432) };
  let drop = false;
  const sockets: Socket[] = [];
  const proxy = createServer((client) => {
    const up = netConnect(to);
    sockets.push(client, up);
    client.on("data", (b) => up.write(b));
    up.on("data", (b) => { if (!drop) client.write(b); });
    client.on("error", () => up.destroy());
    up.on("error", () => client.destroy());
    client.on("close", () => up.destroy());
    up.on("close", () => client.destroy());
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  const url = new URL(server);
  url.host = `127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  const db = await connectDb(url.toString(), { role: "cli", migrate: false, statementTimeoutMs: 1_000 });
  try {
    assert.equal((await db.prepare("SELECT 1 AS n").get() as { n: number }).n, 1);
    drop = true;
    const t0 = Date.now();
    await assert.rejects(db.prepare("SELECT 2 AS n").get(), /no answer from the server/);
    assert.ok(Date.now() - t0 >= 1_000, "the answer is awaited for at least the statement timeout");
    drop = false;
    assert.equal((await db.prepare("SELECT 3 AS n").get() as { n: number }).n, 3, "the next statement runs on a new connection");
    // A connection whose server never answers its startup fails within the same bound.
    drop = true;
    const fresh = await connectDb(url.toString(), { role: "cli", migrate: false, statementTimeoutMs: 1_000 });
    await assert.rejects(fresh.prepare("SELECT 4 AS n").get(), /timeout/);
    await fresh.close();
  } finally {
    await db.close();
    for (const s of sockets) s.destroy();
    await new Promise((r) => proxy.close(r));
  }
});

test("a process whose identity cache listens for settings changes still ends when its work is done", { skip: needsPg, timeout: 30_000 }, async () => {
  const t = await testDatabase("", "postgres", { empty: true });
  try {
    await (await t.open({ app: true })).close();
    const src = (m: string) => JSON.stringify(new URL(`../src/${m}`, import.meta.url).href);
    const script = join(SCRATCH, `listen-exit-${process.pid}.ts`);
    writeFileSync(script, `import { connectDb } from ${src("db/open.ts")};
import { watchIdentity } from ${src("data/access/index.ts")};
const db = await connectDb(process.argv[2], { migrate: false });
const sub = watchIdentity(db);
while (!sub.listening()) await new Promise((r) => setTimeout(r, 20));
console.log("listening");
`);
    const out = await new Promise<string>((resolve, reject) => execFile(process.execPath, ["--no-warnings", script, t.target], { timeout: 15_000 }, (e, stdout) => (e ? reject(e) : resolve(stdout))));
    assert.match(out, /listening/);
  } finally {
    await t.close();
  }
});
