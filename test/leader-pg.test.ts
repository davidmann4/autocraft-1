// Leader election on Postgres (src/db/leader.ts): a leader rides out a dropped lease connection, a frozen leader is
// replaced once its lease expires and its writes are fenced, and a transaction left idle by a client that stopped
// talking no longer holds the writer lock. Runs only against a server (AUTOCRAFT_TEST_PG_URL; scripts/pg-test.sh).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { elect, type Lease } from "../src/db/leader.ts";
import { isFenced, setFence } from "../src/db/fence.ts";
import type { Db } from "./helpers/raw-db.ts";
import { needsPg, testDatabase } from "./test-db.ts";

const FAST = { retryMs: 100, checkMs: 100, leaseMs: 2_000, lossMs: 1_500, beatMs: 200, log: () => {} };
const SETTINGS = "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE leader_leases (role TEXT PRIMARY KEY, holder TEXT NOT NULL, epoch BIGINT NOT NULL, expires_ms BIGINT NOT NULL)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const timeout = (ms: number) => new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`not within ${ms} ms`)), ms));
const leaseBackend = async (admin: Db): Promise<number | undefined> =>
  (await admin.prepare("SELECT pid FROM pg_stat_activity WHERE application_name = 'autocraft-leader-runner' AND datname = current_database()").get() as { pid: number } | undefined)?.pid;

test("a leader whose lease connection drops renews on a new one and keeps leading", { skip: needsPg }, async () => {
  const t = await testDatabase(SETTINGS);
  try {
    const [db, admin] = [await t.open(), await t.open()];
    const a = (await elect(db, "runner", { ...FAST, url: t.target, holder: "a", replicas: 2 }))!;
    await sleep(300);
    const before = await leaseBackend(admin);
    await admin.prepare(`SELECT pg_terminate_backend(${before})`).all();
    await sleep(2_500);
    const after = await leaseBackend(admin);
    assert.ok(after !== undefined && after !== before, "the lease is renewed on a new connection");
    assert.ok(!a.lost.aborted, "the drop alone is not a loss");
    setFence({ role: "runner", epoch: a.epoch });
    await db.prepare("INSERT INTO settings (key, value) VALUES ('x', 'a')").run();
    await a.release();
  } finally {
    setFence(null);
    await t.close();
  }
});

// A leader in a process of its own, so the test can freeze it: its connections stay open (the kernel still answers),
// but it renews nothing. It prints its epoch once it leads and "lost" when it notices the loss. It writes no status
// during the test, so it is not frozen inside a write transaction (whose writer lock would hold the takeover until the
// server ends the transaction).
const FROZEN = `
import { connectDb } from ${JSON.stringify(new URL("../src/db/open.ts", import.meta.url).href)};
import { elect } from ${JSON.stringify(new URL("../src/db/leader.ts", import.meta.url).href)};
const url = process.argv[1];
const db = await connectDb(url, { role: "dashboard", migrate: false });
const l = await elect(db, "runner", { ...${JSON.stringify(FAST)}, beatMs: 600000, log: () => {}, url, holder: "frozen", replicas: 2 });
process.stdout.write(l.epoch + "\\n");
l.lost.addEventListener("abort", () => process.stdout.write("lost\\n"));
setInterval(() => {}, 1000);
`;

test("a leader that stops renewing is replaced once its lease expires; its writes are refused and it stops when it runs again", { skip: needsPg }, async () => {
  const t = await testDatabase(SETTINGS);
  const stop = new AbortController();
  const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", FROZEN, t.target], { stdio: ["ignore", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async (): Promise<string> => String((await Promise.race([lines.next(), timeout(10_000)])).value);
  try {
    const epochA = Number(await next());
    assert.ok(epochA > 0, "the first copy leads");
    const db = await t.open();
    let standby = false;
    let b: Lease | null = null;
    // The fence is this process's, so B writes no status while the test swaps it.
    const bWon = elect(db, "runner", { ...FAST, beatMs: 600_000, url: t.target, holder: "b", replicas: 2, signal: stop.signal, onStandby: () => (standby = true) }).then((l) => (b = l));
    await sleep(1_000);
    assert.ok(standby && !b, "the second copy waits while the first renews");

    child.kill("SIGSTOP");
    await Promise.race([bWon, timeout(5_000)]);
    const leaseB = b as Lease | null;
    assert.ok(leaseB && leaseB.epoch > epochA, "the standby leads under a later epoch");
    await sleep(300); // B's first status write, which is not awaited
    setFence({ role: "runner", epoch: epochA });
    await assert.rejects(db.prepare("INSERT INTO settings (key, value) VALUES ('x', 'a')").run(), (e) => isFenced(e));
    setFence({ role: "runner", epoch: leaseB.epoch });
    await db.prepare("INSERT INTO settings (key, value) VALUES ('x', 'b')").run();
    setFence(null);

    child.kill("SIGCONT");
    assert.equal(await next(), "lost", "the thawed leader notices it no longer leads");
    await sleep(500);
    assert.ok(!leaseB.lost.aborted, "and the new leader keeps leading");
    await leaseB.release();
  } finally {
    setFence(null);
    stop.abort();
    child.kill("SIGKILL");
    await t.close();
  }
});

test("a write transaction left idle no longer holds the writer lock once the server ends it", { skip: needsPg }, async () => {
  const t = await testDatabase(SETTINGS);
  try {
    const [a, b] = [await t.open({ idleInTransactionMs: 300 }), await t.open()];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const stuck = a.write(async () => {
      await a.prepare("INSERT INTO settings (key, value) VALUES ('a', '1')").run();
      await held;
    }).catch((e: unknown) => e);
    await sleep(100);
    const t0 = Date.now();
    await b.write(() => b.prepare("INSERT INTO settings (key, value) VALUES ('b', '1')").run(), { lockTimeoutMs: 5_000 });
    assert.ok(Date.now() - t0 < 3_000, "the waiting writer got the lock well before its limit");
    release();
    assert.ok(await stuck instanceof Error, "the idle transaction was ended, not committed");
    assert.equal(await b.prepare("SELECT value FROM settings WHERE key = 'a'").get(), undefined);
  } finally {
    await t.close();
  }
});
