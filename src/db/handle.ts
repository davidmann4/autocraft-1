// The Db handle over one backend engine: transaction routing through AsyncLocalStorage, the statement API and the
// observers. Backend specifics (dialect, drivers, BEGIN forms, statement execution) live in the engine.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Compilable, DatabaseConnection, Kysely, TransactionBuilder } from "kysely";
import type { DatabaseSync } from "node:sqlite";
import type { DB, Db, DbEvent, Dialect, NamedParams, Param, Row, RunResult, Statement, Subscription, WriteOptions } from "./index.ts";

export type Op = "get" | "all" | "run";
export type Args = readonly (Param | NamedParams)[];

/** The transaction open in an async context. `state` is "opening" until BEGIN succeeded and "closed" once `fn` settled. */
export interface Tx {
  mode: "read" | "write";
  state: "opening" | "open" | "closed";
  lockTimeoutMs?: number;
  /** The named lock the transaction takes in place of the writer lock (WriteOptions.lock). */
  lock?: string;
  /** The connection the transaction runs on, recorded by the engine's driver at BEGIN. */
  conn?: DatabaseConnection;
  /** The transaction's Kysely (a Transaction<DB> typed as its base class, assigned through `unknown`: checking the subclass against the base over the full DB type is too large for the checker). */
  trx?: Kysely<DB>;
  /** Savepoints taken by `attempt`, for unique names. */
  savepoints?: number;
}

/** What a handle gives its engine. */
export interface EngineContext {
  /** The transaction of the current async context, in any state. */
  tx(): Tx | undefined;
  /** Whether any observer listens: events cost a stack capture and a JSON size, so engines skip them otherwise. */
  observed(): boolean;
  emit(e: DbEvent): void;
}

export interface Engine {
  readonly dialect: Dialect;
  readonly kysely: Kysely<DB>;
  readonly sync?: DatabaseSync;
  /** Runs one raw statement: on `tx`'s connection when given, otherwise on a connection of its own. */
  exec(op: Op, text: string, args: Args, tx: Tx | undefined): Promise<Row | Row[] | RunResult | undefined>;
  script(text: string, tx: Tx | undefined): Promise<void>;
  /** An engine whose statements see tracked repos only (src/db/scoped.ts): this one with its views, or a new one. */
  scope(): Promise<Engine>;
  /** The transaction settings for `mode` (the driver turns them into its BEGIN). */
  configure(b: TransactionBuilder<DB>, mode: Tx["mode"]): TransactionBuilder<DB>;
  /** A new listener on a connection of its own; absent where the backend has no notifications (SQLite). */
  listener?(): Listener;
  close(): Promise<void>;
}

/** Notifications from other connections: what `Db.listen` sits on. */
export interface Listener {
  listen(channel: string, fn: (payload: string | null) => void): Subscription;
  close(): Promise<void>;
}

/** Write transactions holding the lock longer than this log their site. */
const SLOW_HOLD_MS = 1000;

/** An Error whose stack reaches past the layers of Kysely and this module. The stack text is formatted only when read. */
export function siteError(): Error {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 40;
  const e = new Error();
  Error.stackTraceLimit = limit;
  return e;
}

/** The first stack frame outside src/db/, Kysely and node internals: the code that made the call. */
export function callSite(e: Error): string {
  for (const line of (e.stack ?? "").split("\n").slice(1)) {
    const f = line.trim();
    if (/\/src\/db\/|node_modules|\(node:|at node:/.test(f)) continue;
    return f.replace(/^at (async )?/, "");
  }
  return "";
}

/**
 * A write result without an insert id: Postgres has no lastInsertRowid. Reading it throws, so code that relies on it fails
 * where it reads it instead of using 0 as a key; such statements add RETURNING.
 */
export function withoutInsertId(changes: number): RunResult {
  return Object.defineProperty({ changes }, "lastInsertRowid", {
    get(): never {
      throw new Error("lastInsertRowid is not available on Postgres: add RETURNING to the statement and read the row");
    },
  }) as RunResult;
}

/** Whether a call that outlived its transaction throws (tests) or falls back to autocommit with a warning. */
const strayThrows = (): boolean => process.env.NODE_TEST_CONTEXT !== undefined;

/** The most statements one shareReads scope keeps. */
const SHARED_READS_MAX = 2000;

export class Handle implements Db {
  readonly dialect: Dialect;
  readonly sync?: DatabaseSync;
  #engine: Engine;
  readonly #als = new AsyncLocalStorage<Tx>();
  /** The reads shared in this async context (shareReads), by statement and parameters; `open` is false once its `fn` has ended, and inside fresh. */
  readonly #shared = new AsyncLocalStorage<{ open: boolean; rows: Map<string, Promise<readonly unknown[]>> }>();
  readonly #observers = new Set<(e: DbEvent) => void>();
  readonly #warned = new Set<string>();
  /** The handle's one listening connection, opened at the first listen; it outlives a scope() change of engine. */
  #listener: Listener | undefined;

  constructor(make: (ctx: EngineContext) => Engine) {
    this.#engine = make({
      tx: () => this.#als.getStore(),
      observed: () => this.#observers.size > 0,
      emit: (e) => this.#emit(e),
    });
    this.dialect = this.#engine.dialect;
    this.sync = this.#engine.sync;
  }

  #emit(e: DbEvent): void {
    for (const o of this.#observers) o(e);
  }

  /** The open transaction of this async context; a closed one is a call that outlived it. */
  #current(): Tx | undefined {
    const tx = this.#als.getStore();
    if (!tx || tx.state !== "closed") return tx?.state === "open" ? tx : undefined;
    const msg = "database call after its transaction ended: a promise started inside db.write/db.read was left running";
    if (strayThrows()) throw new Error(msg);
    const site = callSite(siteError());
    if (!this.#warned.has(site)) {
      this.#warned.add(site);
      console.warn(`db: ${msg} (${site}); it ran outside the transaction`);
    }
    return undefined;
  }

  get k(): Kysely<DB> {
    return this.#current()?.trx ?? this.#engine.kysely;
  }

  async get<O>(q: Compilable<O>): Promise<O | undefined> {
    return (await this.all(q))[0];
  }

  async all<O>(q: Compilable<O>): Promise<O[]> {
    const c = q.compile();
    const shared = this.#sharedReads();
    if (!shared || this.#current()) return [...(await this.k.executeQuery(c)).rows];
    if (c.query.kind !== "SelectQueryNode") return [...(await this.#forgetting(() => this.k.executeQuery(c))).rows];
    const key = `${c.sql}\0${JSON.stringify(c.parameters, (_, v: unknown) => (typeof v === "bigint" ? `${v}n` : v))}`;
    let read = shared.get(key);
    // A request that reads this many different statements reads the rest uncached.
    if (!read && shared.size >= SHARED_READS_MAX) return [...(await this.k.executeQuery(c)).rows];
    if (!read) {
      read = this.#engine.kysely.executeQuery(c).then((r) => r.rows);
      shared.set(key, read);
      void read.catch(() => shared.get(key) === read && shared.delete(key));
    }
    // Copies, so a caller that changes its rows does not change another's.
    return (await read).map((r) => ({ ...(r as object) }) as O);
  }

  /** The shared reads of this async context, or undefined outside shareReads or after it ended. */
  #sharedReads(): Map<string, Promise<readonly unknown[]>> | undefined {
    const s = this.#shared.getStore();
    return s?.open ? s.rows : undefined;
  }

  /** Runs a write, forgetting the shared reads before and after it: a read that ran alongside may hold the rows from before. */
  async #forgetting<T>(write: () => Promise<T>): Promise<T> {
    this.#sharedReads()?.clear();
    try {
      return await write();
    } finally {
      this.#sharedReads()?.clear();
    }
  }

  async fresh<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.#sharedReads()) return await fn();
    return await this.#shared.run({ open: false, rows: new Map() }, fn);
  }

  async shareReads<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#sharedReads()) return await fn();
    const store = { open: true, rows: new Map<string, Promise<readonly unknown[]>>() };
    try {
      return await this.#shared.run(store, fn);
    } finally {
      store.open = false;
      store.rows.clear();
    }
  }

  async run(q: Compilable<unknown>): Promise<RunResult> {
    const r = await this.#forgetting(() => this.k.executeQuery(q.compile()));
    const changes = Number(r.numAffectedRows ?? 0n);
    return this.dialect === "postgres" ? withoutInsertId(changes) : { changes, lastInsertRowid: Number(r.insertId ?? 0n) };
  }

  prepare(text: string): Statement {
    const exec = async (op: Op, args: Args) => {
      const go = () => this.#engine.exec(op, text, args, this.#current());
      return op === "run" ? await this.#forgetting(go) : await go();
    };
    async function* iterate(args: Args): AsyncGenerator<Row> {
      yield* (await exec("all", args)) as Row[];
    }
    return {
      get: (...args: Args) => exec("get", args),
      all: (...args: Args) => exec("all", args),
      run: (...args: Args) => exec("run", args),
      iterate: (...args: Args) => iterate(args),
    } as Statement;
  }

  async attempt<T>(fn: () => Promise<T>): Promise<T> {
    const tx = this.#current();
    if (this.dialect !== "postgres" || !tx) return await fn();
    tx.savepoints = (tx.savepoints ?? 0) + 1;
    const name = `attempt_${tx.savepoints}`;
    await this.#engine.script(`SAVEPOINT ${name}`, tx);
    let r: T;
    try {
      r = await fn();
    } catch (e) {
      await this.#engine.script(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`, tx);
      throw e;
    }
    await this.#engine.script(`RELEASE SAVEPOINT ${name}`, tx);
    return r;
  }

  inTransaction(mode?: Tx["mode"]): boolean {
    const tx = this.#current();
    return tx !== undefined && (mode === undefined || tx.mode === mode);
  }

  async scope(): Promise<void> {
    if (this.#als.getStore()) throw new Error("db.scope inside a transaction");
    const next = await this.#engine.scope();
    if (next === this.#engine) return;
    const old = this.#engine;
    this.#engine = next;
    await old.close();
  }

  script(text: string): Promise<void> {
    return this.#forgetting(() => this.#engine.script(text, this.#current()));
  }

  read<T>(fn: () => Promise<T>): Promise<T> {
    return this.#transaction("read", fn, {});
  }

  write<T>(fn: () => Promise<T>, opts: WriteOptions = {}): Promise<T> {
    return this.#forgetting(() => this.#transaction("write", fn, opts));
  }

  async #transaction<T>(mode: Tx["mode"], fn: () => Promise<T>, opts: WriteOptions): Promise<T> {
    const cur = this.#current();
    if (cur) {
      if (mode === "write" && cur.mode === "read") throw new Error("db.write inside db.read: a read snapshot cannot write");
      // Taking a second lock inside a transaction could deadlock, and running under the outer lock alone would not exclude the inner one's other holders.
      if (mode === "write" && cur.lock !== opts.lock) throw new Error(`db.write under ${opts.lock ? `the lock "${opts.lock}"` : "the writer lock"} inside a transaction under ${cur.lock ? `the lock "${cur.lock}"` : "the writer lock"}`);
      return fn();
    }
    const site = mode === "write" ? siteError() : undefined;
    const tx: Tx = { mode, state: "opening", lockTimeoutMs: opts.lockTimeoutMs, lock: opts.lock };
    let lockedAt: number | undefined;
    try {
      return await this.#als.run(tx, () =>
        this.#engine.configure(this.#engine.kysely.transaction(), mode).execute(async (trx) => {
          tx.trx = trx as unknown as Kysely<DB>;
          tx.state = "open";
          lockedAt = performance.now();
          try {
            return await fn();
          } finally {
            tx.state = "closed";
          }
        }),
      );
    } finally {
      tx.state = "closed";
      if (site && lockedAt !== undefined) {
        const holdMs = performance.now() - lockedAt;
        if (holdMs > SLOW_HOLD_MS) console.warn(`db: ${tx.lock ? `lock "${tx.lock}"` : "write lock"} held ${Math.round(holdMs)} ms by ${callSite(site)}`);
        if (this.#observers.size) this.#emit({ kind: "write-lock", holdMs, site: callSite(site) });
      }
    }
  }

  observe(fn: (e: DbEvent) => void): () => void {
    this.#observers.add(fn);
    return () => void this.#observers.delete(fn);
  }

  async notify(channel: string, payload: string): Promise<void> {
    if (this.dialect !== "postgres") return;
    await this.prepare("SELECT pg_notify(?, ?) AS n").get(channel, payload);
  }

  listen(channel: string, fn: (payload: string | null) => void): Subscription | null {
    if (!this.#engine.listener) return null;
    this.#listener ??= this.#engine.listener();
    return this.#listener.listen(channel, fn);
  }

  async close(): Promise<void> {
    const l = this.#listener;
    this.#listener = undefined;
    await l?.close();
    await this.#engine.close();
  }
}
