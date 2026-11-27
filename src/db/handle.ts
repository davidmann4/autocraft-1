// The Db handle over one backend engine: transaction routing through AsyncLocalStorage, the statement API and the
// observers. Backend specifics (dialect, drivers, BEGIN forms, statement execution) live in the engine.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Compilable, CompiledQuery, DatabaseConnection, Kysely, OperationNode, OperationNodeSource, SelectQueryNode, TransactionBuilder } from "kysely";
import type { DatabaseSync } from "node:sqlite";
import { bytesRead } from "./bytes-read.ts";
import type { DB, DbEvent, DbStats, Dialect, ListenOptions, NamedParams, Param, QueryOpts, Row, RunResult, Statement, Subscription, WriteOptions } from "./index.ts";
import type { QueryDb } from "./query-db.ts";

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
  /** What `afterCommit` queued, run once the transaction committed. */
  afterCommit?: (() => void | Promise<void>)[];
}

/** What a handle gives its engine. */
export interface EngineContext {
  /** The transaction of the current async context, in any state. */
  tx(): Tx | undefined;
  /** Whether any observer listens: events cost a stack capture and a JSON size, so engines skip them otherwise. */
  observed(): boolean;
  emit(e: DbEvent): void;
  /** The counts of the meter running in the current async context (`db.meter`), which engines add round trips and time to. */
  meter(): DbStats | undefined;
  /** The site observers see for a statement `together` sends for several callers (their labels or call sites). */
  site(): string | undefined;
}

export interface Engine {
  readonly dialect: Dialect;
  readonly kysely: Kysely<DB>;
  readonly sync?: DatabaseSync;
  /** Runs one raw statement: on `tx`'s connection when given, otherwise on a connection of its own. */
  exec(op: Op, text: string, args: Args, tx: Tx | undefined): Promise<Row | Row[] | RunResult | undefined>;
  script(text: string, tx: Tx | undefined): Promise<void>;
  /**
   * One statement that reads every one of `nodes` (SELECTs) as a JSON array column `q0`, `q1`, ..., compiled for `k`:
   * how `together` fuses a wave. Absent where reads cost no round trip (SQLite), which runs a wave's reads in turn.
   */
  fuse?(k: Kysely<DB>, nodes: readonly OperationNode[]): CompiledQuery<Row>;
  /** An engine whose statements see tracked repos only (src/db/scoped.ts): this one with its views, or a new one. */
  scope(): Promise<Engine>;
  /** The transaction settings for `mode` (the driver turns them into its BEGIN). */
  configure(b: TransactionBuilder<DB>, mode: Tx["mode"]): TransactionBuilder<DB>;
  /** A new listener on a connection of its own; absent where the backend has no notifications (SQLite). */
  listener?(): Listener;
  /**
   * Takes the lock `name` across processes, waiting at most `waitMs`. It holds no writer lock and no pooled connection.
   * `held()` turns false when the lock's connection fails. Absent on SQLite, where Db.exclusive excludes only the holders
   * in this process.
   */
  exclusiveLock?(name: string, waitMs: number): Promise<{ release: () => Promise<void>; held: () => boolean }>;
  close(): Promise<void>;
}

/** Notifications from other connections: what `Db.listen` sits on. */
export interface Listener {
  listen(channel: string, fn: (payload: string | null) => void, o?: ListenOptions): Subscription;
  close(): Promise<void>;
}

/** Write transactions holding the lock longer than this log their site. */
const SLOW_HOLD_MS = 1000;

/** Most sites `slowWriteHolds` keeps. */
const SLOW_HOLD_SITES = 200;
const slowHolds = new Map<string, { count: number; maxMs: number }>();

/** Write transactions of this process that held their lock over a second, per site, for the health checks. */
export function slowWriteHolds(): ReadonlyMap<string, { readonly count: number; readonly maxMs: number }> {
  return slowHolds;
}

function noteSlowHold(site: string, ms: number): void {
  const s = slowHolds.get(site);
  if (s) {
    s.count++;
    s.maxMs = Math.max(s.maxMs, ms);
  } else if (slowHolds.size < SLOW_HOLD_SITES) slowHolds.set(site, { count: 1, maxMs: ms });
}

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

/** Whether this process runs under the test runner, where a misuse throws; in production it is logged instead. */
export const testing = (): boolean => process.env.NODE_TEST_CONTEXT !== undefined;

/** The handles with a meter, a transaction or a `together` scope open, with how many: the ones an effect may concern. */
const busy = new Map<Handle, number>();

async function whileBusy<T>(h: Handle, fn: () => Promise<T>): Promise<T> {
  busy.set(h, (busy.get(h) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    const n = busy.get(h)! - 1;
    if (n) busy.set(h, n);
    else busy.delete(h);
  }
}

/** The transaction or `together` wave open in this async context, on any handle, as text; `count` counts an effect in its meters. */
export function busyScopes(count: boolean): string | undefined {
  let scope: string | undefined;
  for (const h of busy.keys()) scope = h.effectScope(count) ?? scope;
  return scope;
}

/** The most statements one shareReads scope keeps. */
const SHARED_READS_MAX = 2000;

/** Statements that write the settings table, which a settings snapshot must notice whoever issues them. */
const SETTINGS_WRITE = /^\s*(?:insert\s+into|update|delete\s+from)\s+"?(?:main"?\."?)?settings"?(?![\w.])/i;
let settingsWriteHook: ((db: object) => void) | null = null;
export const onSettingsWrite = (fn: (db: object) => void): void => { settingsWriteHook = fn; };

/** Runs an `afterCommit` callback; its error is logged, since the transaction it waited for has committed. */
async function runAfterCommit(fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.warn(`db: afterCommit callback failed: ${(e as Error)?.message ?? String(e)}`);
  }
}

/** The most reads one fused statement carries: its text, and the planner's work on it, grow with each. */
const FUSED_MAX = 40;

/** The event loop's setImmediate as the module found it, so tests that mock timers do not hold waves back. */
const immediate = globalThis.setImmediate.bind(globalThis);

/** A read waiting in a `together` wave. */
interface Member {
  node: SelectQueryNode;
  c: CompiledQuery<unknown>;
  alone: boolean;
  label?: string;
  /** What observers see as its site; only taken while someone observes. */
  site?: string;
  resolve(rows: readonly unknown[]): void;
  reject(e: unknown): void;
}

/** The reads issued in one turn on one Kysely (the handle's, or a transaction's). `done` is set once it was sent. */
interface Wave {
  k: Kysely<DB>;
  members: Member[];
  done?: Promise<void>;
}

/** A `together` scope: its waves not yet sent, per Kysely. `open` is false once its `fn` has ended. */
interface Together {
  open: boolean;
  waves: Map<Kysely<DB>, Wave>;
}

/** The cache key of a compiled query: its text and parameters. */
const readKey = (c: CompiledQuery<unknown>): string => `${c.sql}\0${JSON.stringify(c.parameters, (_, v: unknown) => (typeof v === "bigint" ? `${v}n` : v))}`;

/** `e` with its message starting with the loader's `label`; the original is its cause, and its fields (code, errcode) are kept. */
function labelled(e: unknown, label: string | undefined): unknown {
  if (!label || !(e instanceof Error)) return e;
  return Object.assign(new Error(`${label}: ${e.message}`, { cause: e }), e);
}

/** A fused member's rows: Postgres JSON gives booleans as true/false, where a plain read gives 1/0 (src/db/postgres.ts typesFor). */
function jsonRows(v: unknown): Record<string, unknown>[] {
  const rows = (typeof v === "string" ? JSON.parse(v) : (v ?? [])) as Record<string, unknown>[];
  for (const r of rows) for (const key in r) if (typeof r[key] === "boolean") r[key] = r[key] ? 1 : 0;
  return rows;
}

/** Copies, so a caller that changes its rows does not change another's. */
const copies = (rows: readonly unknown[]): unknown[] => rows.map((r) => ({ ...(r as object) }));

export class Handle implements QueryDb {
  readonly dialect: Dialect;
  readonly sync?: DatabaseSync;
  #engine: Engine;
  readonly #als = new AsyncLocalStorage<Tx>();
  /** The reads shared in this async context (shareReads), by statement and parameters; `open` is false once its `fn` has ended, and inside fresh. */
  readonly #shared = new AsyncLocalStorage<{ open: boolean; rows: Map<string, Promise<readonly unknown[]>> }>();
  /** The `together` scope of this async context. */
  readonly #together = new AsyncLocalStorage<Together>();
  /** The meter of this async context (`meter`). */
  readonly #meters = new AsyncLocalStorage<DbStats>();
  /** The site of the statement a wave sends for several callers, for observers. */
  readonly #site = new AsyncLocalStorage<string>();
  readonly #observers = new Set<(e: DbEvent) => void>();
  readonly #warned = new Set<string>();
  /** The handle's one listening connection, opened at the first listen; it outlives a scope() change of engine. */
  #listener: Listener | undefined;

  constructor(make: (ctx: EngineContext) => Engine) {
    this.#engine = make({
      tx: () => this.#als.getStore(),
      observed: () => this.#observers.size > 0,
      emit: (e) => this.#emit(e),
      meter: () => this.#meters.getStore(),
      site: () => this.#site.getStore(),
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
    if (testing()) throw new Error(msg);
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

  async get<O>(q: Compilable<O>, o?: QueryOpts): Promise<O | undefined> {
    return (await this.all(q, o))[0];
  }

  async all<O>(q: Compilable<O>, o?: QueryOpts): Promise<O[]> {
    const c = q.compile();
    const shared = this.#sharedReads();
    if (!shared || this.#current()) return [...(await this.#query(q, c, this.k, o))] as O[];
    if (c.query.kind !== "SelectQueryNode") return [...(await this.#forgetting(() => this.#query(q, c, this.k, o)))] as O[];
    const key = readKey(c);
    let read = shared.get(key);
    // A request that reads this many different statements reads the rest uncached.
    if (!read && shared.size >= SHARED_READS_MAX) return [...(await this.#query(q, c, this.k, o))] as O[];
    if (!read) {
      read = this.#query(q, c, this.#engine.kysely, o);
      shared.set(key, read);
      void read.catch(() => shared.get(key) === read && shared.delete(key));
    }
    return copies(await read) as O[];
  }

  /**
   * Runs a compiled Kysely query on `k`, counted by the meter. Inside `together` a SELECT joins the wave of `k`, and any
   * other statement sends that wave first, so the reads issued before it see the state before it.
   */
  async #query(q: Compilable<unknown>, c: CompiledQuery<unknown>, k: Kysely<DB>, o: QueryOpts | undefined): Promise<readonly unknown[]> {
    const m = this.#meters.getStore();
    if (m) m.statements++;
    const t = this.#together.getStore();
    let rows: readonly unknown[];
    if (t?.open && c.query.kind === "SelectQueryNode") {
      const node = (q as Partial<OperationNodeSource>).toOperationNode?.();
      rows = node?.kind === "SelectQueryNode" ? await this.#join(t, k, node as SelectQueryNode, c, o) : await this.#direct(c, k, o);
    } else {
      if (t && c.query.kind !== "SelectQueryNode") await this.#flush(k);
      rows = await this.#direct(c, k, o);
    }
    if (m) m.rows += rows.length;
    return rows;
  }

  async #direct(c: CompiledQuery<unknown>, k: Kysely<DB>, o: QueryOpts | undefined): Promise<readonly unknown[]> {
    try {
      return (await k.executeQuery(c)).rows;
    } catch (e) {
      throw labelled(e, o?.label);
    }
  }

  /** Queues a read in the wave of `k`, which goes out at the end of this turn (or earlier, when a write flushes it). */
  #join(t: Together, k: Kysely<DB>, node: SelectQueryNode, c: CompiledQuery<unknown>, o: QueryOpts | undefined): Promise<readonly unknown[]> {
    let wave = t.waves.get(k);
    if (!wave) {
      const w: Wave = { k, members: [] };
      t.waves.set(k, w);
      immediate(() => void this.#send(t, w));
      wave = w;
    }
    // A locking read (FOR UPDATE) or an EXPLAIN cannot be a subquery.
    const alone = !!o?.alone || !!node.endModifiers?.length || !!node.explain;
    if (!alone && (this.#engine.fuse || testing())) {
      const bytes = bytesRead(node, c.sql);
      if (bytes) throw new Error(`${o?.label ? `${o.label}: ` : ""}a read of bytes (${bytes}) inside db.together must be marked \`alone\`: a fused wave would return them as hex text`);
    }
    const site = this.#observers.size ? (o?.label ?? callSite(siteError())) : undefined;
    const members = wave.members;
    return new Promise((resolve, reject) => members.push({ node, c, alone, label: o?.label, site, resolve, reject }));
  }

  /** Sends `w` once; later reads in `t` on its Kysely form a new wave. Never rejects: each member gets its own outcome. */
  #send(t: Together, w: Wave): Promise<void> {
    if (t.waves.get(w.k) === w) t.waves.delete(w.k);
    return (w.done ??= this.#runWave(w));
  }

  /** Sends the wave of `k` waiting in this context's `together` scope now, and waits for it. */
  #flush(k: Kysely<DB>): Promise<void> | undefined {
    const t = this.#together.getStore();
    const w = t?.waves.get(k);
    return w && this.#send(t!, w);
  }

  async #runWave(w: Wave): Promise<void> {
    const ms = w.members;
    const sites = ms.some((m) => m.site !== undefined) ? [...new Set(ms.map((m) => m.site ?? ""))].join(" + ") : undefined;
    const go = (): Promise<void> => (this.#engine.fuse ? this.#fused(w.k, ms) : this.#inSnapshot(w.k, ms));
    try {
      await (sites === undefined ? go() : this.#site.run(sites, go));
    } catch (e) {
      // BEGIN or COMMIT failed; members already answered keep their answer.
      for (const m of ms) m.reject(e);
    }
  }

  /** Runs one read, or several identical ones as one, on `k`. */
  async #lone(k: Kysely<DB>, same: readonly Member[]): Promise<void> {
    try {
      const rows = (await k.executeQuery(same[0]!.c)).rows;
      same.forEach((m, i) => m.resolve(i ? copies(rows) : rows));
    } catch (e) {
      for (const m of same) m.reject(labelled(e, m.label));
    }
  }

  /** SQLite: the reads one after another, in one read transaction unless one is open already (or there is one read). */
  async #inSnapshot(k: Kysely<DB>, ms: readonly Member[]): Promise<void> {
    const each = async (on: Kysely<DB>): Promise<void> => {
      for (const m of ms) await this.#lone(on, [m]);
    };
    if (ms.length < 2 || k !== this.#engine.kysely) return await each(k);
    await this.#transaction("read", () => each(this.k), {});
  }

  /** Postgres: identical reads share one subquery, up to FUSED_MAX subqueries per statement; `alone` reads go by themselves. */
  async #fused(k: Kysely<DB>, ms: readonly Member[]): Promise<void> {
    const alone: Member[][] = [];
    const byKey = new Map<string, Member[]>();
    for (const m of ms) {
      if (m.alone) alone.push([m]);
      else {
        const key = readKey(m.c);
        const same = byKey.get(key);
        if (same) same.push(m);
        else byKey.set(key, [m]);
      }
    }
    const parts = [...byKey.values()];
    const sends: Promise<void>[] = alone.map((same) => this.#lone(k, same));
    for (let i = 0; i < parts.length; i += FUSED_MAX) {
      const chunk = parts.slice(i, i + FUSED_MAX);
      sends.push(chunk.length === 1 ? this.#lone(k, chunk[0]!) : this.#fuseChunk(k, chunk));
    }
    await Promise.all(sends);
  }

  async #fuseChunk(k: Kysely<DB>, chunk: readonly Member[][]): Promise<void> {
    let row: Row | undefined;
    try {
      row = (await k.executeQuery(this.#engine.fuse!(k, chunk.map((same) => same[0]!.node)))).rows[0];
    } catch (e) {
      // One statement: its error is every member's.
      for (const same of chunk) for (const m of same) m.reject(labelled(e, m.label));
      return;
    }
    chunk.forEach((same, i) => {
      const rows = jsonRows(row?.[`q${i}`]);
      same.forEach((m, j) => m.resolve(j ? copies(rows) : rows));
    });
  }

  /** The shared reads of this async context, or undefined outside shareReads or after it ended. */
  #sharedReads(): Map<string, Promise<readonly unknown[]>> | undefined {
    const s = this.#shared.getStore();
    return s?.open ? s.rows : undefined;
  }

  /**
   * Runs a write, forgetting the shared reads before and after it: a read that ran alongside may hold the rows from before.
   * Inside `together` it first sends the reads issued before it on the same connection or transaction.
   */
  async #forgetting<T>(write: () => Promise<T>): Promise<T> {
    if (this.#together.getStore()) await this.#flush(this.#current()?.trx ?? this.#engine.kysely);
    this.#sharedReads()?.clear();
    try {
      return await write();
    } finally {
      this.#sharedReads()?.clear();
    }
  }

  /**
   * Runs a statement, telling the settings hook about it before and after it runs (a parallel read between the two must not keep the old
   * rows), and again once the enclosing transaction ends, since a read inside it may have cached a value that rolled back.
   */
  async #settingsWrite<T>(text: string, go: () => Promise<T>): Promise<T> {
    if (!settingsWriteHook || !SETTINGS_WRITE.test(text)) return await go();
    const tx = this.#current();
    if (tx) this.#settingsTx.add(tx);
    settingsWriteHook(this);
    try {
      return await go();
    } finally {
      settingsWriteHook(this);
    }
  }

  #settingsTx = new WeakSet<Tx>();

  #exclusive = new Map<string, Promise<void>>();

  async exclusive<T>(name: string, fn: (held: () => boolean) => Promise<T>, waitMs = 30_000): Promise<T> {
    if (this.#current()) throw new Error(`db.exclusive("${name}") inside a transaction`);
    // One holder per name in this process, then (Postgres) one across processes: a session-level lock alone would let this
    // process in twice. SQLite has no cross-process step, so a runner sharing the file is not excluded.
    const prev = this.#exclusive.get(name) ?? Promise.resolve();
    let done!: () => void;
    const tail = prev.then(() => new Promise<void>((r) => (done = r)));
    this.#exclusive.set(name, tail);
    try {
      await prev;
      const lock = await this.#engine.exclusiveLock?.(name, waitMs);
      try {
        return await fn(lock?.held ?? (() => true));
      } finally {
        await lock?.release();
      }
    } finally {
      // `done` is set once `prev` settled, which it has by now unless the wait above threw (it never rejects).
      done?.();
      if (this.#exclusive.get(name) === tail) this.#exclusive.delete(name);
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

  async together<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#together.getStore()?.open) return await fn();
    const store: Together = { open: true, waves: new Map() };
    try {
      return await whileBusy(this, () => this.#together.run(store, fn));
    } finally {
      store.open = false;
    }
  }

  async meter<T>(fn: () => Promise<T>): Promise<{ value: T; stats: DbStats }> {
    const parent = this.#meters.getStore();
    const stats: DbStats = { statements: 0, roundTrips: 0, rows: 0, ms: 0, effects: 0 };
    try {
      const value = await whileBusy(this, () => this.#meters.run(stats, fn));
      return { value, stats: { ...stats } };
    } finally {
      if (parent) {
        parent.statements += stats.statements;
        parent.roundTrips += stats.roundTrips;
        parent.rows += stats.rows;
        parent.ms += stats.ms;
        parent.effects += stats.effects;
      }
    }
  }

  afterCommit(fn: () => void | Promise<void>): void {
    const tx = this.#current();
    if (tx?.mode === "write") (tx.afterCommit ??= []).push(fn);
    else void runAfterCommit(fn);
  }

  /** For `effect()` (src/db/effects.ts): the transaction or wave open in this async context; `count` counts an effect in its meter. */
  effectScope(count: boolean): string | undefined {
    const m = this.#meters.getStore();
    if (m && count) m.effects++;
    if (this.#als.getStore()?.state === "open") return "a database transaction";
    return this.#together.getStore()?.open ? "a db.together wave" : undefined;
  }

  async run(q: Compilable<unknown>): Promise<RunResult> {
    const compiled = q.compile();
    const m = this.#meters.getStore();
    if (m) m.statements++;
    const r = await this.#settingsWrite(compiled.sql, () => this.#forgetting(() => this.k.executeQuery(compiled)));
    const changes = Number(r.numAffectedRows ?? 0n);
    return this.dialect === "postgres" ? withoutInsertId(changes) : { changes, lastInsertRowid: Number(r.insertId ?? 0n) };
  }

  prepare(text: string): Statement {
    const exec = async (op: Op, args: Args) => {
      const m = this.#meters.getStore();
      if (m) m.statements++;
      const go = () => this.#engine.exec(op, text, args, this.#current());
      const r = op === "run" ? await this.#settingsWrite(text, () => this.#forgetting(go)) : await go();
      if (m && op !== "run") m.rows += Array.isArray(r) ? r.length : r ? 1 : 0;
      return r;
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
      if (settingsWriteHook && this.#settingsTx.has(tx)) settingsWriteHook(this);
      throw e;
    }
    await this.#engine.script(`RELEASE SAVEPOINT ${name}`, tx);
    return r;
  }

  inTransaction(mode?: Tx["mode"]): boolean {
    const tx = this.#current();
    return tx !== undefined && (mode === undefined || tx.mode === mode);
  }

  transaction(): object | undefined {
    const tx = this.#als.getStore();
    return tx?.state === "open" ? tx : undefined;
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
    const m = this.#meters.getStore();
    if (m) m.statements++;
    return this.#forgetting(() => this.#engine.script(text, this.#current()));
  }

  async read<T>(fn: () => Promise<T>): Promise<T> {
    // On SQLite a wave waiting outside would wait for the snapshot's connection, which `fn` may be waiting on.
    if (this.#together.getStore()) await this.#flush(this.#current()?.trx ?? this.#engine.kysely);
    return await this.#transaction("read", fn, {});
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
    let value: T;
    let failure: unknown;
    try {
      value = await whileBusy(this, () => this.#als.run(tx, () =>
        this.#engine.configure(this.#engine.kysely.transaction(), mode).execute(async (trx) => {
          tx.trx = trx as unknown as Kysely<DB>;
          tx.state = "open";
          lockedAt = performance.now();
          try {
            return await fn();
          } catch (e) {
            failure = e;
            throw e;
          } finally {
            tx.state = "closed";
          }
        }),
      ));
    } catch (e) {
      // A rollback that fails too (the connection is gone) replaces the error that ended the transaction; keep that one as its cause.
      if (failure !== undefined && e !== failure && e instanceof Error && e.cause === undefined) e.cause = failure;
      throw e;
    } finally {
      tx.state = "closed";
      if (settingsWriteHook && this.#settingsTx.has(tx)) settingsWriteHook(this);
      if (site && lockedAt !== undefined) {
        const holdMs = performance.now() - lockedAt;
        if (holdMs > SLOW_HOLD_MS) {
          const where = callSite(site);
          noteSlowHold(where, holdMs);
          console.warn(`db: ${tx.lock ? `lock "${tx.lock}"` : "write lock"} held ${Math.round(holdMs)} ms by ${where}`);
        }
        if (this.#observers.size) this.#emit({ kind: "write-lock", holdMs, site: callSite(site) });
      }
    }
    // Committed: outside the transaction and its lock now.
    for (const fn of tx.afterCommit ?? []) await runAfterCommit(fn);
    return value;
  }

  observe(fn: (e: DbEvent) => void): () => void {
    this.#observers.add(fn);
    return () => void this.#observers.delete(fn);
  }

  async seqs(topics?: readonly string[]): Promise<Record<string, number>> {
    let q = this.k.selectFrom("change_seq").select(["topic", "seq"]);
    if (topics) q = q.where("topic", "in", [...topics]);
    const out: Record<string, number> = {};
    for (const r of await this.all(q)) out[r.topic] = Number(r.seq);
    return out;
  }

  async notify(channel: string, payload: string): Promise<void> {
    if (this.dialect !== "postgres") return;
    await this.prepare("SELECT pg_notify(?, ?) AS n").get(channel, payload);
  }

  listen(channel: string, fn: (payload: string | null) => void, o?: ListenOptions): Subscription | null {
    if (!this.#engine.listener) return null;
    this.#listener ??= this.#engine.listener();
    return this.#listener.listen(channel, fn, o);
  }

  async close(): Promise<void> {
    const l = this.#listener;
    this.#listener = undefined;
    await l?.close();
    await this.#engine.close();
  }
}
