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
 *
 * A `Db` carries transactions, waves, locks and notifications and has no query methods: the statements live in the data
 * modules (src/data/**) and in infrastructure (src/db/**), which take the query surface of a handle with `queryDb`
 * (src/db/query-db.ts; test/data-layer.test.ts keeps it there).
 *
 * Transactions are routed through AsyncLocalStorage: every call made inside `db.write(fn)` / `db.read(fn)`, at any depth
 * of awaits, runs in that transaction.
 */
import type { SQLInputValue, SQLOutputValue } from "node:sqlite";

export type Dialect = "sqlite" | "postgres";

/** What a process (or worker thread) uses its handle for; on Postgres it sets the connection pool size. */
export type DbRole = "dashboard" | "dashboard-remote" | "runner" | "job" | "planner" | "periodic" | "cli";

/** The table types Kysely queries are checked against, generated from the migrated schema (scripts/gen-db-types.ts). */
export type { DB } from "./types.ts";

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

/** Options of a QueryDb read. */
export interface QueryOpts {
  /**
   * Runs the statement on its own inside `together`, never fused into a wave: for loaders of blobs (`bytea` comes back
   * from JSON as hex text), of more than about 10,000 rows, of ids above 2^53, or that can be slow (embedding scans).
   */
  alone?: boolean;
  /** The loader's name: an error of the statement starts with it, and observers see it as the site of a fused statement. */
  label?: string;
}

/** What `db.meter` counted. */
export interface DbStats {
  /** Logical statements: each Kysely query, raw statement and script, and each member of a fused wave. BEGIN and COMMIT are not statements. */
  statements: number;
  /** Postgres round trips (every query sent, BEGIN, locks and COMMIT included); 0 on SQLite, which runs in-process. */
  roundTrips: number;
  /** Rows the statements returned (a fused wave counts its members' rows). */
  rows: number;
  /** Time spent in the database: Postgres round trips, SQLite statements. */
  ms: number;
  /** External effects (`effect()` in src/db/effects.ts): GitHub calls, model calls, build launches. */
  effects: number;
}

export interface ListenOptions {
  /** The subscription does not keep the process alive: a cache that drops entries on a notification, not a wait for one. */
  background?: boolean;
}

/** One `Db.listen` registration. */
export interface Subscription {
  /** Whether the channel's notifications arrive now. */
  listening(): boolean;
  off(): void;
}

export interface Db {
  readonly dialect: Dialect;
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
   * Runs `fn` with its Kysely SELECTs gathered into waves: the ones issued in the same event-loop turn go out together.
   * Postgres sends a wave as one statement, which reads one snapshot (each read a JSON array column of it; top-level
   * booleans come back as 1/0 as on the plain path); past 40 reads, and for `alone` reads, it sends more statements at
   * once, each its own snapshot outside a transaction. SQLite runs a wave's reads one after another in one read
   * transaction. Load with `Promise.all` inside it: each `await` on an earlier result starts another wave. Works
   * inside `read` and `write` (the wave runs in the transaction). A write inside `fn` first sends the reads issued before
   * it, then runs at once, so they see the state before it. A failed fused statement fails every read in it. Reads that
   * shareReads already holds are served from it and join no wave.
   */
  together<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Runs `fn` and counts what it did in the database (statements, round trips, rows, time) and its external effects, in
   * this async context at any depth of awaits. A meter inside another adds its counts to the outer one when it ends.
   */
  meter<T>(fn: () => Promise<T>): Promise<{ value: T; stats: DbStats }>;
  /**
   * Inside a write transaction (a joined nested write included): queues `fn` to run once that transaction has committed,
   * in the order queued, before `db.write` returns; a rollback drops the queue. Anywhere else it runs `fn` at once,
   * synchronously. An error from `fn`, thrown or rejected, is logged and never reaches the caller.
   */
  afterCommit(fn: () => void | Promise<void>): void;
  /** Whether a transaction is open in the current async context; with `mode`, one of that kind (a read snapshot or a write). */
  inTransaction(mode?: "read" | "write"): boolean;
  /** The open transaction of the current async context, as a key for what belongs to it alone; undefined outside one. */
  transaction(): object | undefined;
  /**
   * Makes this handle see tracked repos only: views filtered to tracked_repos shadow the mirror and work tables
   * (src/db/scoped.ts), and writes to those tables name them with `main.`. On SQLite they are TEMP views on the
   * connection; on Postgres the handle moves to connections whose search path puts the views first. Call it right after
   * opening, outside any transaction.
   */
  scope(): Promise<void>;
  /**
   * Postgres: NOTIFY `channel` with `payload` for every process listening; inside a write transaction it is sent when the
   * transaction commits. SQLite: nothing, since its processes poll.
   */
  notify(channel: string, payload: string): Promise<void>;
  /**
   * The change counters (src/db/live.ts) of `topics`, or of every topic. One statement; inside `together` it joins the wave.
   * A topic with no row has no entry.
   */
  seqs(topics?: readonly string[]): Promise<Record<string, number>>;
  /**
   * Postgres: calls `fn` with the payload of each notification on `channel` until `off()`, on the handle's one listening
   * connection, which opens in the background; with null after that connection was lost and opened again, when some may
   * have been missed. `listening()` is false until the LISTEN is in effect and while the connection is down: poll at the
   * short interval then. A notification is a hint to look again, never the data. SQLite: null, and the caller polls.
   * The connection keeps the process alive while a subscription that is not `background` (a cache's invalidation) is on.
   */
  listen(channel: string, fn: (payload: string | null) => void, o?: ListenOptions): Subscription | null;
  /** Calls `fn` for every round trip and write-lock release; returns the function that stops it. */
  observe(fn: (e: DbEvent) => void): () => void;
  close(): Promise<void>;
}
