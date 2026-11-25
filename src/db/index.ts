/**
 * The database handle that SQLite and Postgres both sit behind. Types only: values come from `./open.ts`, which is the one
 * module that loads the `kysely` and `pg` packages (with a dynamic import, so the build worker runs without them).
 *
 * How callers get a handle:
 * - `await openDb()`: the process's handle on the configured database, memoized; `closeDb()` at exit. The database is
 *   `AUTOCRAFT_DB_URL` (a postgres:// URL) or else `AUTOCRAFT_DB` (a SQLite file); see `dbTarget()`.
 * - `await connectDb(target, { busyTimeoutMs, role })`: a handle of its own (tests, the dashboard's second handle, worker
 *   threads). `target` is a SQLite path or a postgres:// URL.
 * - `await dbFor(sync)`: the handle over a `DatabaseSync` that `connect()` (src/db.ts) returned, memoized per connection.
 *   Code that still holds a `DatabaseSync` reaches the async API this way while the rest of the call graph is converted.
 *
 * Target shape of the sync → async conversion (statement API mirrors node:sqlite's, but every call returns a promise):
 * - `db: DatabaseSync`                         → `db: Db`
 * - `db.prepare(X).get(a)` / `.all` / `.run`   → `await db.prepare(X).get(a)` / ...  (`?` and `:name` parameters as today)
 * - `db.prepare(X).iterate(a)` in `for`        → `for await (... of db.prepare(X).iterate(a))`
 * - `db.exec(X)`                               → `await db.script(X)`
 * - `db.isTransaction`                         → `db.inTransaction()`
 * - `BEGIN IMMEDIATE; ...; COMMIT`             → `await db.write(async () => { ... })`
 * - `BEGIN; ...; COMMIT` (read snapshot)       → `await db.read(async () => { ... })`
 * - `connect(path, opts)`                      → `await connectDb(path, opts)`; the default database → `await openDb()`
 * `db.sync` is the underlying `DatabaseSync` on SQLite, for residue that cannot await yet; it bypasses transaction
 * routing (it runs on the same connection, so inside whatever transaction is open on it) and goes away after the move.
 *
 * Transactions are routed through AsyncLocalStorage: every call made inside `db.write(fn)` / `db.read(fn)`, at any depth
 * of awaits, runs in that transaction. Read `db.k` at each use; a `Kysely` captured outside a transaction stays outside it.
 */
import type { Compilable, Kysely } from "kysely";
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";

export type Dialect = "sqlite" | "postgres";

/** What a process (or worker thread) uses its handle for; on Postgres it sets the connection pool size. */
export type DbRole = "dashboard" | "dashboard-remote" | "runner" | "job" | "planner" | "periodic" | "cli";

/** The table types Kysely queries are checked against, generated from the migrated schema (scripts/gen-db-types.ts). */
export type { DB } from "./types.ts";
import type { DB } from "./types.ts";

export type Value = SQLOutputValue;
export type Row = Record<string, Value>;
export type Param = SQLInputValue;
export type NamedParams = Record<string, Param>;

/** What a write statement did. Numbers on both backends. */
export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

/** A statement from `db.prepare(text)`: node:sqlite's API, async. Rows are plain objects. */
export interface Statement {
  get<T = Row>(...params: Param[]): Promise<T | undefined>;
  get<T = Row>(named: NamedParams, ...params: Param[]): Promise<T | undefined>;
  all<T = Row>(...params: Param[]): Promise<T[]>;
  all<T = Row>(named: NamedParams, ...params: Param[]): Promise<T[]>;
  run(...params: Param[]): Promise<RunResult>;
  run(named: NamedParams, ...params: Param[]): Promise<RunResult>;
  /** Rows one at a time. The result is read whole first, so the loop body may use the database freely. */
  iterate<T = Row>(...params: Param[]): AsyncIterableIterator<T>;
  iterate<T = Row>(named: NamedParams, ...params: Param[]): AsyncIterableIterator<T>;
}

export interface WriteOptions {
  /** How long to wait for the write lock before failing with a lock timeout. Defaults to the handle's busy timeout. */
  lockTimeoutMs?: number;
  /**
   * Postgres: a named lock the transaction takes in place of the one writer lock, so it runs alongside other writes and
   * waits only for transactions under the same name. For a transaction whose read-then-write concerns only rows that
   * writes under this name change, its other writes being compare-and-set. A fenced process takes the writer lock too. A
   * write inside an open transaction must name the same lock. SQLite runs every write alone and ignores it.
   */
  lock?: string;
}

/** One event for `db.observe`. */
export type DbEvent =
  /** One round trip: a statement, a script, BEGIN or COMMIT. `bytes` is the size of the result rows as JSON. */
  | { kind: "query"; sql: string; rows: number; bytes: number; ms: number; site: string }
  /** A write transaction ended; `holdMs` is how long it held the write lock. */
  | { kind: "write-lock"; holdMs: number; site: string };

/** One `Db.listen` registration. */
export interface Subscription {
  /** Whether the channel's notifications arrive now. */
  listening(): boolean;
  off(): void;
}

export interface Db {
  readonly dialect: Dialect;
  /** Kysely, routed to the transaction open in the current async context. */
  readonly k: Kysely<DB>;
  /** Runs a Kysely query: its first row. */
  get<O>(q: Compilable<O>): Promise<O | undefined>;
  /** Runs a Kysely query: all rows. */
  all<O>(q: Compilable<O>): Promise<O[]>;
  /** Runs a Kysely write. */
  run(q: Compilable<unknown>): Promise<RunResult>;
  /** Transitional raw SQL in the SQLite dialect, with `?` and `:name` parameters. */
  prepare(text: string): Statement;
  /**
   * Runs `fn` with its Kysely SELECTs outside a transaction shared: one with the same text and parameters as an earlier
   * one in this async context gets that read's rows (fresh copies) instead of another round trip. A write through the
   * handle in the context, and the end of `fn`, forget them. For read-only requests, whose parts read the same rows.
   */
  shareReads<T>(fn: () => Promise<T>): Promise<T>;
  /** Runs `fn` with every read going to the database, inside shareReads too: for code that reads until a row changes. */
  fresh<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Runs `fn` while holding the lock `name`, which excludes only other holders of the same name. Postgres: every process,
   * through a session advisory lock on a connection of its own. SQLite: this process only, so a dashboard and a runner
   * sharing one file are not excluded from each other. It holds no writer lock, so `fn` may wait on the network; its own
   * reads and writes run as usual. `held()` turns false once the lock's connection failed: another process may then hold
   * it too, so `fn` should read again before a final decision. Not inside a transaction.
   */
  exclusive<T>(name: string, fn: (held: () => boolean) => Promise<T>, waitMs?: number): Promise<T>;
  /**
   * Runs `fn` in one read snapshot (SQLite BEGIN; Postgres REPEATABLE READ READ ONLY). Inside an open transaction it
   * joins that one.
   */
  read<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Runs `fn` in one write transaction (SQLite BEGIN IMMEDIATE; Postgres READ COMMITTED with the global writer lock),
   * committed when `fn` resolves and rolled back when it throws. Inside an open write transaction it joins that one;
   * inside a read snapshot it throws. Never retries itself.
   */
  write<T>(fn: () => Promise<T>, opts?: WriteOptions): Promise<T>;
  /**
   * Runs `fn` so that a statement error inside it leaves the open transaction usable: on Postgres, where a failed
   * statement aborts the whole transaction, `fn` runs under a savepoint that is rolled back when it throws; on SQLite, and
   * outside a transaction, it is a plain call. The error still reaches the caller, which catches it and carries on.
   * Attempts in one transaction run one at a time, like its statements.
   */
  attempt<T>(fn: () => Promise<T>): Promise<T>;
  /** Whether a transaction is open in the current async context; with `mode`, one of that kind (a read snapshot or a write). */
  inTransaction(mode?: "read" | "write"): boolean;
  /**
   * Makes this handle see tracked repos only: views filtered to tracked_repos shadow the mirror and work tables
   * (src/db/scoped.ts), and writes to those tables name them with `main.`. On SQLite they are TEMP views on the
   * connection; on Postgres the handle moves to connections whose search path puts the views first. Call it right after
   * opening, outside any transaction.
   */
  scope(): Promise<void>;
  /** Runs several statements with no parameters (schema scripts, PRAGMAs). */
  script(text: string): Promise<void>;
  /**
   * Postgres: NOTIFY `channel` with `payload` for every process listening; inside a write transaction it is sent when the
   * transaction commits. SQLite: nothing, since its processes poll.
   */
  notify(channel: string, payload: string): Promise<void>;
  /**
   * Postgres: calls `fn` with the payload of each notification on `channel` until `off()`, on the handle's one listening
   * connection, which opens in the background; with null after that connection was lost and opened again, when some may
   * have been missed. `listening()` is false until the LISTEN is in effect and while the connection is down: poll at the
   * short interval then. A notification is a hint to look again, never the data. SQLite: null, and the caller polls.
   */
  listen(channel: string, fn: (payload: string | null) => void): Subscription | null;
  /** Calls `fn` for every round trip and write-lock release; returns the function that stops it. */
  observe(fn: (e: DbEvent) => void): () => void;
  close(): Promise<void>;
  /** The underlying SQLite connection, for code that cannot await yet. Absent on Postgres. */
  readonly sync?: DatabaseSync;
}
