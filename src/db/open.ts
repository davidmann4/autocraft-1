// Opens database handles. The only module that loads the kysely and pg packages, with dynamic imports: the build worker
// runs src/ without node_modules and never opens the app database (test/no-package-imports.test.ts).
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { connect, dbPath } from "../db.ts";
import { envVar } from "../env.ts";
import { Handle } from "./handle.ts";
import type { Db, DbRole } from "./index.ts";
import { migratePg, newerPgSchema, pgStamp, storedPgStamp } from "./pg-triggers.ts";
import { pgConnectionString, postgresEngine } from "./postgres.ts";
import { queryDb } from "./query-db.ts";
import { dbRole, setDbRole, testRedirect } from "./role.ts";
import { bindSql } from "./sql.ts";
import { sqliteEngine } from "./sqlite.ts";

let kysely: Promise<typeof import("kysely")> | undefined;

function loadKysely(): Promise<typeof import("kysely")> {
  return (kysely ??= import("kysely").then((k) => {
    bindSql(k.sql);
    return k;
  }));
}

/** The pg module, for the Postgres engine. */
export async function loadPg(): Promise<typeof import("pg").default> {
  return (await import("pg")).default;
}

const bySync = new WeakMap<DatabaseSync, Promise<Db>>();

/** The handle over a connection from `connect()`, one per connection. Closing it closes the connection. */
export function dbFor(sync: DatabaseSync): Promise<Db> {
  let h = bySync.get(sync);
  if (!h) bySync.set(sync, (h = loadKysely().then((k) => new Handle((ctx) => sqliteEngine(k, sync, ctx)))));
  return h;
}

export const isPgUrl = (target: string): boolean => /^postgres(ql)?:\/\//.test(target);

/**
 * The configured database: `AUTOCRAFT_DB_URL` (Postgres) or else `AUTOCRAFT_DB` (a SQLite file, default under the home).
 * Both set to different values is refused: one of them would be ignored without a word.
 */
export function dbTarget(env: NodeJS.ProcessEnv = process.env): string {
  const url = envVar("DB_URL", env);
  const path = envVar("DB", env);
  if (url !== undefined && path !== undefined && url !== path) throw new Error("AUTOCRAFT_DB_URL and AUTOCRAFT_DB are both set and differ: set only one");
  if (url !== undefined && !isPgUrl(url)) throw new Error("AUTOCRAFT_DB_URL must be a postgres:// or postgresql:// URL");
  return url ?? dbPath(env);
}

const DB_VARS = ["AUTOCRAFT_DB", "CRAFT_AUTO_DB", "AUTOCRAFT_DB_URL", "CRAFT_AUTO_DB_URL"];

/** `env` for a child process that opens `target`: the one variable that names it, and no other database variable. */
export function dbEnv(target: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of DB_VARS) delete out[k];
  out[isPgUrl(target) ? "AUTOCRAFT_DB_URL" : "AUTOCRAFT_DB"] = target;
  return out;
}

/**
 * A file-name-safe name for `target`, for lock files that exclude a second run on the same database: a SQLite file's
 * base name, or for Postgres a hash of the host, port and database name (no credentials).
 */
export function dbLockName(target: string = dbTarget()): string {
  if (!isPgUrl(target)) return basename(target);
  const u = new URL(target);
  return `pg-${createHash("sha256").update(`${u.hostname}:${u.port || "5432"}${u.pathname}`).digest("hex").slice(0, 12)}`;
}

export { setDbRole };

export interface ConnectOptions {
  /** How long a write waits for the write lock before failing with a lock timeout. */
  busyTimeoutMs?: number;
  /** The handle's use, for its pool size on Postgres. Defaults to the process's role (`setDbRole`). */
  role?: DbRole;
  /** Postgres: bring the schema and triggers up to date first (default). False opens the database as it is. */
  migrate?: boolean;
  /** Postgres: how long a transaction may sit idle before the server ends its session (default 10 s). */
  idleInTransactionMs?: number;
  /** Postgres: longest a statement may run (default 120 s); a connection waits this long plus a margin for an answer. */
  statementTimeoutMs?: number;
  /**
   * Postgres: write statements outside a transaction run under their row locks only, not as a transaction under the writer
   * lock, so they never wait for another process's long write; a row-lock wait still ends after busyTimeoutMs. For a
   * handle whose lone writes are single-row upserts and compare-and-set updates (the Task Runner routes). A fenced
   * process keeps the writer lock.
   */
  rowWrites?: boolean;
}

/**
 * A handle of its own on `target`: a SQLite file or a Postgres URL, schema brought up to date (see `connect()` and
 * `migratePg()`).
 */
export async function connectDb(target: string = dbTarget(), opts: ConnectOptions = {}): Promise<Db> {
  const redirect = testRedirect();
  if (redirect && !isPgUrl(target)) target = await redirect(target);
  if (!isPgUrl(target)) return dbFor(connect(target, opts));
  const [k, pg] = await Promise.all([loadKysely(), loadPg()]);
  const db = new Handle((ctx) => postgresEngine(k, pg, target, { role: opts.role ?? dbRole(), busyTimeoutMs: opts.busyTimeoutMs, idleInTransactionMs: opts.idleInTransactionMs, statementTimeoutMs: opts.statementTimeoutMs, rowWrites: opts.rowWrites }, ctx));
  if (opts.migrate === false) return db;
  try {
    // A current database costs two reads on the pool; only a stale one opens a connection of its own for the migration, and
    // only when no newer version has migrated it.
    const rows = (sql: string) => db.prepare(sql).all() as Promise<Record<string, unknown>[]>;
    if (await storedPgStamp(rows) !== pgStamp() && !(await newerPgSchema(rows))) {
      const client = new pg.Client({ connectionString: pgConnectionString(target), application_name: "autocraft-migrate" });
      await client.connect();
      try {
        await migratePg(client);
      } finally {
        await client.end();
      }
    }
  } catch (e) {
    await db.close();
    throw e;
  }
  return db;
}

let proc: Promise<{ db: Db; close: () => Promise<void> }> | undefined;

/**
 * The process's handle on the configured database. It is shared by everything in the process, so its `close()` does
 * nothing: a module that closes the handle it was given must not end it for the job or server still using it. Only
 * `closeDb()` closes it.
 */
export async function openDb(): Promise<Db> {
  proc ??= connectDb().then(async (db) => {
    const close = db.close.bind(db);
    db.close = async () => {};
    // The GitHub App's keys of this process (job processes, commands, the runner) come from this database.
    await (await import("../github/app-keys.ts")).openAppKeys(db).catch(async (e: Error) => {
      // A process without the file never reads the keys by design (a build worker); say so only when a stored app is going unread.
      const file = envVar("SECRETS_FILE");
      if (!file || !existsSync(file)) return;
      const q = queryDb(db);
      const stored = await q.get(q.k.selectFrom("github_app").select("id").where("id", "=", 1).where("keys_enc", "is not", null)).catch(() => undefined);
      if (stored) console.error(`GitHub App keys not read: ${e.message}`);
    });
    return { db, close };
  });
  return (await proc).db;
}

/** Closes the process's handle (CLI exit). */
export async function closeDb(): Promise<void> {
  const p = proc;
  proc = undefined;
  if (p) await (await p).close();
}
