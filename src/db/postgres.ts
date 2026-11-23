// The Postgres engine: Kysely's PostgresDialect on a pg.Pool. No session state beyond the fixed settings every connection
// SETs once when it opens (setSession): settings a transaction needs are SET LOCAL,
// locks are transaction-scoped advisory locks, statements are unnamed (no server-side prepared statements). LISTEN runs
// only on a handle's one dedicated listening connection (pgListener), never on the pool.
// Values come back in node:sqlite's shapes (see `types`), so a query returns the same rows on both backends.
import type * as K from "kysely";
import type * as Pg from "pg";
import type { Args, Engine, EngineContext, Listener, Op, Tx } from "./handle.ts";
import { callSite, siteError, withoutInsertId } from "./handle.ts";
import type { DB, DbRole, Row } from "./index.ts";
import { bindParams, parseParams, rewriteForPostgres, rewriteScriptForPostgres, type ParsedParams } from "./params.ts";
import { plainSchema, SCOPED_SCHEMA } from "./scoped.ts";
import { fenceSql } from "./fence.ts";

/** Connections per process role: the database allows 100 direct connections, shared by every process of the instance. */
export const POOL_MAX: Record<DbRole, number> = { dashboard: 8, "dashboard-remote": 4, runner: 4, planner: 2, periodic: 2, cli: 1 };

/** Key of the one writer lock every write takes (a write transaction, or a write statement outside one), so writes run one at a time as on SQLite. */
const WRITER_LOCK = 0x61637772; // "acwr"
/** First key of the named locks (WriteOptions.lock), taken as two 32-bit keys: a space apart from the single-key writer and migration locks. */
const NAMED_LOCKS = 0x61636e6c; // "acnl"

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
/** A transaction whose client sends nothing for this long is ended by the server, so a dead process cannot keep the writer lock. */
const DEFAULT_IDLE_IN_TRANSACTION_MS = 60_000;

/**
 * Server-side TCP settings of every connection: the server drops a client that went silent (a lost node) after about
 * 5 + 3 × 2 = 11 seconds, with the locks its session held, instead of after the system default of hours.
 */
export const SERVER_KEEPALIVE = { tcp_keepalives_idle: 5, tcp_keepalives_interval: 2, tcp_keepalives_count: 3, tcp_user_timeout: 10_000 } as const;
const DEFAULT_STATEMENT_TIMEOUT_MS = 120_000;

/** Parsed statement texts kept per handle. */
const PARSE_CACHE = 1000;

export interface PgOptions {
  role: DbRole;
  /** How long a write transaction waits for the writer lock (and a statement for any lock). Default 30 s. */
  busyTimeoutMs?: number;
  /** Longest a statement may run; 0 for no limit. Default 120 s. */
  statementTimeoutMs?: number;
  /** The app schema of a scoped handle (src/db/scoped.ts): its connections put the scoped views first on the search path. */
  scope?: string;
  /** How long a transaction may sit idle before the server ends its session; 0 for no limit. Default 60 s. */
  idleInTransactionMs?: number;
  /** Write statements outside a transaction run without the writer lock (ConnectOptions.rowWrites). */
  rowWrites?: boolean;
}

/** A query that got no answer within its limit (`within`). */
export class QueryTimeout extends Error {}

/** `p`, or a QueryTimeout after `ms`. */
export function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => { t = setTimeout(() => reject(new QueryTimeout(`${what} took over ${ms} ms`)), ms); })])
    .finally(() => clearTimeout(t));
}

/** Settings already logged as refused or unanswered, by `where` and name: each is logged once per process. */
const settingsLogged = new Set<string>();

/**
 * SETs `settings` on a connection and resolves once the server has answered. Session SETs rather than startup
 * parameters: a server or proxy that does not accept one refuses that statement alone, where a startup parameter it
 * does not accept would refuse the connection. A refused or unanswered setting keeps the server's default and is logged
 * once per process and `where`.
 */
export async function setSession(query: (text: string) => Promise<unknown>, settings: Record<string, number>, where: string, log: (line: string) => void, timeoutMs?: number): Promise<void> {
  const entries = Object.entries(settings).map(([k, v]) => [k, Math.floor(v)] as const);
  const run = (text: string, what: string): Promise<unknown> => (timeoutMs ? within(query(text), timeoutMs, what) : query(text));
  const note = (id: string, line: string): void => {
    if (settingsLogged.has(`${where}\0${id}`)) return;
    settingsLogged.add(`${where}\0${id}`);
    log(line);
  };
  // One round trip. The statements of one query run as one implicit transaction, so a refusal undoes them all; then
  // each is sent alone, to keep the ones the server accepts.
  try {
    await run(entries.map(([k, v]) => `SET ${k} = ${v}`).join("; "), "the session settings");
    return;
  } catch (e) {
    if (e instanceof QueryTimeout) return note("", `db: the session settings on ${where} timed out after ${timeoutMs} ms`);
  }
  for (const [k, v] of entries) {
    await run(`SET ${k} = ${v}`, `SET ${k}`).catch((e: Error) => note(k, e instanceof QueryTimeout
      ? `db: SET ${k} = ${v} on ${where} timed out after ${timeoutMs} ms`
      : `db: the server refused ${k} = ${v} on ${where}: ${e.message}`));
  }
}

/** `url` with `-c name=value` startup options added after any options it has. */
function withStartupOptions(url: string, settings: Record<string, string | number>): string {
  const u = new URL(url);
  const own = u.searchParams.get("options");
  u.searchParams.set("options", [own, ...Object.entries(settings).map(([k, v]) => `-c ${k}=${v}`)].filter(Boolean).join(" "));
  return u.toString();
}

/** `url` with the startup option that puts the scoped views before the tables of `schema`. */
const scopedUrl = (url: string, schema: string): string => withStartupOptions(url, { search_path: `${SCOPED_SCHEMA},${plainSchema(schema)}` });

const LOCAL_HOSTS = new Set(["", "localhost", "[::1]"]);

/**
 * The connection string the pool uses. A remote host always gets TLS with certificate and host name checks
 * (sslmode=verify-full against the system CAs), whatever weaker mode the URL names, unless it says sslmode=disable.
 * Loopback hosts and Unix sockets keep the URL's own setting.
 */
export function pgConnectionString(url: string): string {
  const u = new URL(url);
  if (LOCAL_HOSTS.has(u.hostname) || u.hostname.startsWith("127.") || u.searchParams.get("sslmode") === "disable") return url;
  u.searchParams.set("sslmode", "verify-full");
  // libpq's "use the system CAs"; pg would read it as a file name. Node verifies against the system CAs by default.
  if (u.searchParams.get("sslrootcert") === "system") u.searchParams.delete("sslrootcert");
  return u.toString();
}

/** Parsers that give node:sqlite's value shapes: int8 and numeric as numbers, bool as 1/0, bytea as a plain Uint8Array. */
function typesFor(pg: typeof Pg.default): Pg.CustomTypesConfig {
  const { builtins, getTypeParser } = pg.types;
  const bytea = getTypeParser(builtins.BYTEA, "text") as (v: string) => Buffer;
  const parsers = new Map<number, (v: string) => unknown>([
    [builtins.INT8, Number],
    [builtins.NUMERIC, Number],
    [builtins.BOOL, (v) => (v === "t" ? 1 : 0)],
    [builtins.BYTEA, (v) => new Uint8Array(bytea(v))],
  ]);
  return {
    getTypeParser: ((oid: number, format?: "text" | "binary") => parsers.get(oid) ?? getTypeParser(oid, format as "text")) as Pg.CustomTypesConfig["getTypeParser"],
  };
}

const STATEMENT_HEAD = /^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*(\w+)/;

/** Whether a statement writes rows: INSERT, UPDATE, DELETE or MERGE, also inside WITH (a WITH that only mentions one of the words is taken as a write too). */
export function writesRows(text: string): boolean {
  const head = STATEMENT_HEAD.exec(text)?.[1]?.toLowerCase();
  if (head === "with") return /\b(?:insert|update|delete|merge)\b/i.test(text);
  return head === "insert" || head === "update" || head === "delete" || head === "merge";
}

/** `s` as an SQL string literal (standard_conforming_strings, the default: only quotes are doubled). */
const quoteLiteral = (s: string): string => `'${s.replaceAll("'", "''")}'`;

/** Emits a query event for every round trip on `client` while someone observes. */
function observeClient(client: Pg.PoolClient, ctx: EngineContext): void {
  const query = client.query.bind(client) as (...a: unknown[]) => unknown;
  (client as { query: unknown }).query = (...a: unknown[]): unknown => {
    const text = a[0];
    if (!ctx.observed() || typeof text !== "string" || typeof a.at(-1) === "function") return query(...a);
    const site = callSite(siteError());
    const t0 = performance.now();
    return (query(...a) as Promise<Pg.QueryResult | Pg.QueryResult[]>).then((r) => {
      // A script with several statements answers with one result per statement.
      const rows = (Array.isArray(r) ? r : [r]).flatMap((x) => x.rows ?? []);
      ctx.emit({ kind: "query", sql: text, rows: rows.length, bytes: rows.length ? Buffer.byteLength(JSON.stringify(rows)) : 0, ms: performance.now() - t0, site });
      return r;
    });
  };
}

/**
 * Kysely's counterpart of the `main.`/`temp.` rewrite raw statements get (src/db/params.ts rewriteForPostgres): table
 * names `main.x` and `temp.x` (typed in src/db/types.ts for code that reads past the scoped views or writes a shadowed
 * table) lose the schema, or with `mainSchema` (a scoped handle) `main.x` names `<mainSchema>.x`, past the views.
 */
function schemaPlugin(k: typeof K, mainSchema: string | undefined): K.KyselyPlugin {
  class Transformer extends k.OperationNodeTransformer {
    protected override transformSchemableIdentifier(node: K.SchemableIdentifierNode, queryId?: K.QueryId): K.SchemableIdentifierNode {
      const t = super.transformSchemableIdentifier(node, queryId);
      const schema = t.schema?.name.toLowerCase();
      if (schema !== "main" && schema !== "temp") return t;
      return { ...t, schema: schema === "main" && mainSchema ? k.IdentifierNode.create(mainSchema) : undefined };
    }
  }
  const transformer = new Transformer();
  return {
    transformQuery: (args) => transformer.transformNode(args.node, args.queryId),
    transformResult: async (args) => args.result,
  };
}

/** An engine on the Postgres database at `url`. `k` and `pg` are the modules src/db/open.ts loaded. */
export function postgresEngine(k: typeof K, pg: typeof Pg.default, url: string, opts: PgOptions, ctx: EngineContext): Engine {
  const lockTimeout = (tx: Tx | undefined) => Math.max(1, Math.floor(tx?.lockTimeoutMs ?? opts.busyTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS));
  const pool = new pg.Pool({
    connectionString: pgConnectionString(opts.scope ? scopedUrl(url, opts.scope) : url),
    max: POOL_MAX[opts.role],
    keepAlive: true,
    allowExitOnIdle: true,
    application_name: `autocraft-${opts.role}`,
    // A startup parameter of every connection, so it also bounds statements outside transactions; no SET is sent.
    statement_timeout: opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    // A lone write of a rowWrites handle waits for row locks no longer than a transaction waits for its lock.
    ...(opts.rowWrites && { lock_timeout: lockTimeout(undefined) }),
    types: typesFor(pg),
  });
  // An idle connection that fails (server restart, network) is dropped by the pool; without a listener it would crash the process.
  pool.on("error", (e) => console.warn(`db: idle Postgres connection failed: ${e.message}`));
  pool.on("connect", (client) => {
    observeClient(client, ctx);
    // The pool listens only while a connection is idle. One the server ends while it is checked out (an idle transaction
    // past its limit, a terminated backend) must not crash the process: its next statement fails, and the pool drops it.
    client.on("error", () => {});
  });
  const raw = (text: string, values?: unknown[]) => k.CompiledQuery.raw(text, values);
  const sessionSettings = { ...SERVER_KEEPALIVE, idle_in_transaction_session_timeout: opts.idleInTransactionMs ?? DEFAULT_IDLE_IN_TRANSACTION_MS };
  /**
   * The driver awaits this once per new pool client before the client's first statement (pg's own `connect` event cannot
   * wait), so every statement runs with the session settings in effect.
   */
  const prepareConnection = async (conn: K.DatabaseConnection): Promise<void> => {
    lockWrites(conn);
    await setSession((text) => conn.executeQuery(raw(text)), sessionSettings, "pool connections", (l) => console.warn(l));
  };
  // A fenced process (src/db/fence.ts) checks its epoch after the writer lock: the check sees every write committed before
  // it. So it takes the writer lock under a named lock too, first, as every holder of both takes them.
  const beginWrite = (tx: Tx | undefined) => {
    const fence = fenceSql();
    const locks = [...(!tx?.lock || fence ? [`SELECT pg_advisory_xact_lock(${WRITER_LOCK})`] : []), ...(tx?.lock ? [`SELECT pg_advisory_xact_lock(${NAMED_LOCKS}, hashtext(${quoteLiteral(tx.lock)}))`] : [])];
    return `BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL lock_timeout = ${lockTimeout(tx)}; ${locks.join("; ")}${fence}`;
  };
  /** Connections between their BEGIN and its COMMIT or ROLLBACK. */
  const inTransaction = new WeakSet<K.DatabaseConnection>();

  /**
   * Every statement on `conn` passes here. Outside a transaction, a write runs as a transaction of its own under the writer
   * lock, so it waits for an open write transaction as on SQLite, where a count-then-write inside db.write would otherwise
   * race with it. Reads outside a transaction take no lock, nor do the writes of a rowWrites handle in a process without a fence.
   */
  const lockWrites = (conn: K.DatabaseConnection): void => {
    const run = conn.executeQuery.bind(conn);
    conn.executeQuery = async <R>(q: K.CompiledQuery): Promise<K.QueryResult<R>> => {
      if (inTransaction.has(conn) || !writesRows(q.sql) || (opts.rowWrites && !fenceSql())) return await run<R>(q);
      try {
        await run(raw(beginWrite(undefined)));
        const r = await run<R>(q);
        await run(raw("COMMIT"));
        return r;
      } catch (e) {
        await run(raw("ROLLBACK")).catch(() => undefined);
        throw e;
      }
    };
  };

  class Driver extends k.PostgresDriver {
    // One round trip opens the transaction: BEGIN, its settings and, for a write, the writer lock. A write runs READ
    // COMMITTED under the one writer lock, so writes see each other's commits in order as on SQLite; a read is one
    // REPEATABLE READ snapshot that refuses writes.
    override async beginTransaction(conn: K.DatabaseConnection, settings: K.TransactionSettings): Promise<void> {
      const tx = ctx.tx();
      if (tx) tx.conn = conn;
      inTransaction.add(conn);
      const text = settings.accessMode === "read only" ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : beginWrite(tx);
      try {
        await conn.executeQuery(raw(text));
      } catch (e) {
        // Kysely rolls back only a transaction that began; a failed lock wait leaves this one open on the connection.
        await super.rollbackTransaction(conn as Parameters<K.PostgresDriver["rollbackTransaction"]>[0]).catch(() => undefined);
        inTransaction.delete(conn);
        throw e;
      }
    }

    override async commitTransaction(conn: K.DatabaseConnection): Promise<void> {
      try { await super.commitTransaction(conn); } finally { inTransaction.delete(conn); }
    }

    override async rollbackTransaction(conn: K.DatabaseConnection): Promise<void> {
      try { await super.rollbackTransaction(conn as Parameters<K.PostgresDriver["rollbackTransaction"]>[0]); } finally { inTransaction.delete(conn); }
    }
  }

  class Dialect extends k.PostgresDialect {
    override createDriver(): K.Driver {
      return new Driver({ pool, onCreateConnection: prepareConnection });
    }
  }

  const kysely = new k.Kysely<DB>({ dialect: new Dialect({ pool }), plugins: [schemaPlugin(k, opts.scope)] });
  const parsed = new Map<string, ParsedParams>();
  const parse = (text: string): ParsedParams => {
    let p = parsed.get(text);
    if (p) parsed.delete(text);
    else {
      p = parseParams(rewriteForPostgres(text, opts.scope));
      if (parsed.size >= PARSE_CACHE) parsed.delete(parsed.keys().next().value!);
    }
    parsed.set(text, p);
    return p;
  };
  // Inside a transaction a statement runs on the connection the transaction holds; outside one, on any pooled connection.
  const on = async <T>(tx: Tx | undefined, f: (conn: K.DatabaseConnection) => Promise<T>): Promise<T> => {
    if (!tx) return kysely.getExecutor().provideConnection(f);
    if (!tx.conn) throw new Error("db: transaction has no connection");
    return f(tx.conn);
  };

  const engine: Engine = {
    dialect: "postgres",
    kysely,
    listener: () => pgListener(pg, url),
    exec: async (op: Op, text: string, args: Args, tx: Tx | undefined) => {
      const { text: q, values } = bindParams(parse(text), args, (i) => `$${i + 1}`);
      const r = await on(tx, (conn) => conn.executeQuery<Row>(raw(q, values)));
      if (op === "get") return r.rows[0];
      if (op === "all") return [...r.rows];
      return withoutInsertId(Number(r.numAffectedRows ?? 0n));
    },
    script: async (text, tx) => void (await on(tx, (conn) => conn.executeQuery(raw(rewriteScriptForPostgres(text, opts.scope))))),
    configure: (b, mode) => (mode === "read" ? b.setIsolationLevel("repeatable read").setAccessMode("read only") : b.setIsolationLevel("read committed")),
    // A pool of its own: the search path is a startup parameter of each connection, never a session SET.
    scope: async () => {
      if (opts.scope) return engine;
      const r = await on(undefined, (conn) => conn.executeQuery<{ s: string }>(raw("SELECT current_schema() AS s")));
      return postgresEngine(k, pg, url, { ...opts, scope: r.rows[0]!.s }, ctx);
    },
    close: () => kysely.destroy(),
  };
  return engine;
}

/** Channel names a handle may listen on: plain lower-case identifiers, so LISTEN needs no quoting. */
const CHANNEL = /^[a-z][a-z0-9_]{0,62}$/;
const RECONNECT_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const LISTEN_CONNECT_MS = 5_000;

/**
 * LISTEN on one connection of its own, outside the pool, opened in the background at the first listen (5 s connect
 * limit). A lost connection is opened again (1 s, then backing off to 30 s) while anything listens; after a reconnect
 * every listener is called with null, since notifications sent meanwhile are lost. `listening(channel)` says whether the
 * channel's LISTEN is in effect now; callers poll at their short interval while it is not. The connection must be a
 * direct or session-mode one: a transaction-mode pooler drops LISTEN between statements.
 */
export function pgListener(pg: typeof Pg.default, url: string): Listener {
  const fns = new Map<string, Set<(payload: string | null) => void>>();
  /** Channels whose LISTEN went through on `client`. */
  const active = new Set<string>();
  let client: Pg.Client | null = null;
  let connecting: Promise<Pg.Client | null> | null = null;
  let closed = false, failures = 0, warned = false;
  let retry: NodeJS.Timeout | undefined;

  // The connection keeps the process alive only while something listens, so a process can end once its waits are over.
  const hold = (): void => {
    const c = client as (Pg.Client & { ref?: () => void; unref?: () => void }) | null;
    if (fns.size) c?.ref?.();
    else c?.unref?.();
  };
  const dispatch = (channel: string, payload: string | null): void => {
    for (const fn of fns.get(channel) ?? []) {
      try { fn(payload); } catch (e) { console.warn(`db: listener of ${channel} failed: ${(e as Error).message}`); }
    }
  };
  const lost = (c: Pg.Client, why: string): void => {
    if (client !== c) return;
    client = null;
    active.clear();
    c.removeAllListeners("notification");
    void c.end().catch(() => undefined);
    if (!warned) console.warn(`db: listening connection lost (${why}); reconnecting`);
    warned = true;
    schedule();
  };
  const schedule = (): void => {
    if (closed || retry || !fns.size) return;
    retry = setTimeout(() => { retry = undefined; void connect(); }, RECONNECT_MS[Math.min(failures, RECONNECT_MS.length - 1)]!);
    retry.unref();
  };
  /** LISTENs every registered channel not yet in effect on the connection. */
  const sync = async (c: Pg.Client): Promise<void> => {
    for (const ch of [...fns.keys()]) {
      if (active.has(ch)) continue;
      try {
        await c.query(`LISTEN ${ch}`);
        if (client === c && fns.has(ch)) active.add(ch);
      } catch (e) {
        lost(c, (e as Error).message);
        return;
      }
    }
  };
  const connect = (): Promise<Pg.Client | null> => {
    if (client) return Promise.resolve(client);
    connecting ??= (async () => {
      const reconnect = failures > 0 || warned;
      const c = new pg.Client({ connectionString: pgConnectionString(url), application_name: "autocraft-listen", keepAlive: true, connectionTimeoutMillis: LISTEN_CONNECT_MS });
      c.on("error", (e) => lost(c, e.message));
      c.on("end", () => lost(c, "closed"));
      try {
        await c.connect();
        if (closed) { await c.end(); return null; }
        c.on("notification", (m) => dispatch(m.channel, m.payload ?? ""));
        client = c;
        hold();
        await sync(c);
        if (client !== c) return null;
        failures = 0;
        warned = false;
        if (reconnect) for (const ch of fns.keys()) dispatch(ch, null);
        return c;
      } catch (e) {
        if (!warned) console.warn(`db: cannot open the listening connection: ${(e as Error).message}`);
        warned = true;
        failures++;
        await c.end().catch(() => undefined);
        schedule();
        return null;
      } finally {
        connecting = null;
      }
    })();
    return connecting;
  };

  return {
    listen(channel, fn) {
      if (!CHANNEL.test(channel)) throw new Error(`db: bad channel name ${channel}`);
      if (closed) throw new Error("db: the handle is closed");
      let set = fns.get(channel);
      if (!set) fns.set(channel, set = new Set());
      set.add(fn);
      hold();
      if (client) void sync(client);
      else void connect();
      return {
        listening: () => client !== null && active.has(channel),
        off: () => {
          set.delete(fn);
          if (set.size || fns.get(channel) !== set) return;
          fns.delete(channel);
          active.delete(channel);
          if (client) void client.query(`UNLISTEN ${channel}`).catch(() => undefined);
          hold();
        },
      };
    },
    async close() {
      closed = true;
      clearTimeout(retry);
      fns.clear();
      active.clear();
      const c = client ?? await connecting;
      client = null;
      if (c) { c.removeAllListeners("notification"); await c.end().catch(() => undefined); }
    },
  };
}
