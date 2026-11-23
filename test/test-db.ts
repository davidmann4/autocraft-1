// Databases for tests on either backend: SQLite files in the scratch directory by default, Postgres databases when
// AUTOCRAFT_TEST_PG_URL names a server (`pnpm test:pg` starts a throwaway one). Every call makes a new empty database.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCRATCH } from "./scratch.ts";
import type { Db } from "../src/db/index.ts";
import { connect } from "../src/db.ts";
import { connectDb, dbFor } from "../src/db/open.ts";
import { pgSuite } from "./pg-suite.ts";

/** The Postgres server tests run against, if any. */
export const TEST_PG_URL = process.env.AUTOCRAFT_TEST_PG_URL || undefined;

/** `skip` option for tests that need Postgres: false when a server is configured, otherwise the reason shown. */
export const needsPg: false | string = TEST_PG_URL ? false : "needs Postgres: AUTOCRAFT_TEST_PG_URL is not set (pnpm test:pg runs these against a container)";

/**
 * `skip` option for tests that need SQLite itself (a raw DatabaseSync, db.sync, sqlite_master, VACUUM, copying the
 * file): false normally, the reason when the suite runs on Postgres (`pnpm test:pg:suite`, test/pg-suite.ts).
 */
export const sqliteOnly = (reason: string): false | string => (pgSuite ? `SQLite only: ${reason}` : false);

export interface TestDatabase {
  readonly dialect: Db["dialect"];
  /** The database file (SQLite only). */
  readonly file?: string;
  /** The SQLite file or the Postgres URL. */
  readonly target: string;
  /**
   * Another handle on the same database, over its own connection (SQLite) or pool (Postgres). `app` opens it the way the
   * app does, with the app's schema and triggers brought up to date.
   */
  open(opts?: { busyTimeoutMs?: number; app?: boolean; /** Postgres only. */ idleInTransactionMs?: number; /** Postgres only. */ rowWrites?: boolean }): Promise<Db>;
  /** Closes every handle opened here and drops the database. */
  close(): Promise<void>;
}

let n = 0;

/**
 * A new empty database with `schema` run on it (statements both dialects accept). `dialect` defaults to Postgres when
 * AUTOCRAFT_TEST_PG_URL is set, else SQLite.
 */
export async function testDatabase(schema = "", dialect: Db["dialect"] = TEST_PG_URL ? "postgres" : "sqlite"): Promise<TestDatabase> {
  // Each handle's own close, taken before testDb replaces it with this database's close.
  const closers: (() => Promise<void>)[] = [];
  const track = (db: Db): Db => (closers.push(db.close.bind(db)), db);
  const closeAll = async () => void (await Promise.all(closers.splice(0).map((c) => c())));
  if (dialect === "sqlite") {
    const file = join(SCRATCH, `test-db-${process.pid}-${n++}.db`);
    const open = async (opts: { busyTimeoutMs?: number; app?: boolean } = {}) => {
      // connect(), not connectDb(): an explicit SQLite database stays SQLite under the Postgres suite.
      if (opts.app) return track(await dbFor(connect(file, { busyTimeoutMs: opts.busyTimeoutMs })));
      const sync = new DatabaseSync(file, { timeout: opts.busyTimeoutMs ?? 5000 });
      sync.exec("PRAGMA journal_mode=WAL");
      return track(await dbFor(sync));
    };
    if (schema) await (await open()).script(schema);
    return { dialect, file, target: file, open, close: closeAll };
  }
  if (!TEST_PG_URL) throw new Error("testDatabase: Postgres needs AUTOCRAFT_TEST_PG_URL");
  const admin = new URL(TEST_PG_URL);
  const name = `test_${process.pid}_${n++}_${randomBytes(3).toString("hex")}`;
  const server = await connectDb(admin.toString(), { role: "cli", migrate: false });
  await server.script(`CREATE DATABASE ${name}`);
  const url = new URL(admin);
  url.pathname = `/${name}`;
  const open = async ({ app, ...opts }: { busyTimeoutMs?: number; app?: boolean; idleInTransactionMs?: number; rowWrites?: boolean } = {}) =>
    track(await connectDb(url.toString(), { role: "dashboard", migrate: !!app, ...opts }));
  if (schema) await (await open()).script(schema);
  return {
    dialect,
    target: url.toString(),
    open,
    close: async () => {
      await closeAll();
      await server.script(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await server.close();
    },
  };
}

/** One handle on a new empty database (see `testDatabase`); closing it drops the database. */
export async function testDb(schema = ""): Promise<Db> {
  const t = await testDatabase(schema);
  const db = await t.open();
  return Object.assign(db, { close: () => t.close() });
}
