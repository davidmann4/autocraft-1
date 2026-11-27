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
import { COLUMNS } from "./types.ts";

/**
 * Connections per process role: the database allows 100 direct connections, shared by every process of the instance, and each
 * process that listens holds one more outside its pool. Up to 32 job processes run at once (DEFAULT_MAX_JOBS): 32 x (1 pool + 1 listener) = 64,
 * the dashboard 8 + 4 + 2 listeners, runner 4 + 1, planner 2, periodic 2 + 1 come to about 88, leaving room for CLI sessions; a job pool of 2 would reach about 120.
 */
export const POOL_MAX: Record<DbRole, number> = { dashboard: 8, "dashboard-remote": 4, runner: 4, job: 1, planner: 2, periodic: 2, cli: 1 };

/** Key of the one writer lock every write takes (a write transaction, or a write statement outside one), so writes run one at a time as on SQLite. */
const WRITER_LOCK = 0x61637772; // "acwr"
/** First key of the named locks (WriteOptions.lock), taken as two 32-bit keys: a space apart from the single-key writer and migration locks. */
const NAMED_LOCKS = 0x61636e6c; // "acnl"
/** First key of the session locks of Db.exclusive, taken on a connection of their own. */
const EXCLUSIVE_LOCKS = 0x61636578; // "acex"

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
/** A transaction whose client sends nothing for this long is ended by the server, so a dead process cannot keep the writer lock. */
const DEFAULT_IDLE_IN_TRANSACTION_MS = 10_000;

/**
 * Server-side TCP settings of every connection: the server drops a client that went silent (a lost node) after about
 * 5 + 3 × 2 = 11 seconds, with the locks its session held, instead of after the system default of hours.
 */
export const SERVER_KEEPALIVE = { tcp_keepalives_idle: 5, tcp_keepalives_interval: 2, tcp_keepalives_count: 3, tcp_user_timeout: 10_000 } as const;
const DEFAULT_STATEMENT_TIMEOUT_MS = 120_000;
/**
 * How much longer than the statement timeout (at most twice it) a pool connection waits for the server's answer before it
 * gives the connection up. The server ends every statement and lock wait within the statement timeout, so an answer still
 * missing after it is lost: the server or a proxy between went away without closing the connection.
 */
const ANSWER_MARGIN_MS = 30_000;
/**
 * Idle time before the client's first TCP keepalive probe on a pool, lock or listening connection; the system default is two hours. With the
 * system's probe interval and count, a connection whose server vanished fails within minutes instead of hours.
 */
const CLIENT_KEEPALIVE_MS = 10_000;
/**
 * JIT compilation off (0 is a boolean's false). The planner's cost estimates for the facts loads' correlated subqueries pass
 * jit_above_cost while the queries run in milliseconds, and each compile costs 100 ms or more, up to seconds for the full load.
 */
const NO_JIT = { jit: 0 } as const;

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
  // A host that is a path (%2F...) names a Unix socket's directory.
  if (LOCAL_HOSTS.has(u.hostname) || u.hostname.startsWith("127.") || /^%2f/i.test(u.hostname) || u.searchParams.get("sslmode") === "disable") return url;
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

/** The error a statement fails with when its answer did not come within the limit (`answerWithin`). */
export class AnswerTimeout extends Error {}

/**
 * Bounds every round trip on `client`: an answer missing after `ms` fails the statement with an AnswerTimeout and closes
 * the connection, since a late answer would be read as the answer to the next statement. The pool drops the closed client
 * once it is released. Nothing is bounded when `ms` is 0.
 */
function answerWithin(client: Pg.PoolClient, ms: number): void {
  if (ms <= 0) return;
  const query = client.query.bind(client) as (...a: unknown[]) => unknown;
  (client as { query: unknown }).query = (...a: unknown[]): unknown => {
    const r = query(...a);
    if (!(r instanceof Promise)) return r;
    let t: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      t = setTimeout(() => {
        // With a statement in flight, end() closes the socket at once, and the pool drops a client that is ending.
        void client.end().catch(() => undefined);
        reject(new AnswerTimeout(`db: no answer from the server within ${ms} ms; the connection is closed`));
      }, ms);
    });
    // The statement's own failure once the connection is closed is not the one the caller sees.
    void r.catch(() => undefined);
    return Promise.race([r, late]).finally(() => clearTimeout(t));
  };
}

/** Counts every round trip on `client` in the current meter, and emits a query event for it while someone observes. */
function observeClient(client: Pg.PoolClient, ctx: EngineContext): void {
  const query = client.query.bind(client) as (...a: unknown[]) => unknown;
  (client as { query: unknown }).query = (...a: unknown[]): unknown => {
    const text = a[0];
    const m = ctx.meter();
    if (m) m.roundTrips++;
    const observed = ctx.observed();
    if ((!m && !observed) || typeof text !== "string" || typeof a.at(-1) === "function") return query(...a);
    const site = observed ? (ctx.site() ?? callSite(siteError())) : "";
    const t0 = performance.now();
    return (query(...a) as Promise<Pg.QueryResult | Pg.QueryResult[]>).then((r) => {
      const ms = performance.now() - t0;
      if (m) m.ms += ms;
      if (!observed) return r;
      // A script with several statements answers with one result per statement.
      const rows = (Array.isArray(r) ? r : [r]).flatMap((x) => x.rows ?? []);
      ctx.emit({ kind: "query", sql: text, rows: rows.length, bytes: rows.length ? Buffer.byteLength(JSON.stringify(rows)) : 0, ms, site });
      return r;
    }, (e: unknown) => {
      if (m) m.ms += performance.now() - t0;
      throw e;
    });
  };
}

/**
 * Kysely's counterpart of the `main.`/`temp.` rewrite raw statements get (src/db/params.ts rewriteForPostgres): table
 * names `main.x` and `temp.x` (typed in src/db/types.ts for code that reads past the scoped views or writes a shadowed
 * table) lose the schema, or with `mainSchema` (a scoped handle) `main.x` names `<mainSchema>.x`, past the views. Done
 * while compiling: a plugin would copy every query's tree.
 */
function schemaCompiler(k: typeof K, mainSchema: string | undefined): K.QueryCompiler {
  class Compiler extends k.PostgresQueryCompiler {
    protected override visitSchemableIdentifier(node: K.SchemableIdentifierNode): void {
      const schema = node.schema?.name.toLowerCase();
      if (schema !== "main" && schema !== "temp") return super.visitSchemableIdentifier(node);
      if (schema === "main" && mainSchema) {
        this.append(`"${this.sanitizeIdentifier(mainSchema)}".`);
      }
      this.visitNode(node.identifier);
    }
  }
  return new Compiler();
}

/** An engine on the Postgres database at `url`. `k` and `pg` are the modules src/db/open.ts loaded. */
export function postgresEngine(k: typeof K, pg: typeof Pg.default, url: string, opts: PgOptions, ctx: EngineContext): Engine {
  const lockTimeout = (tx: Tx | undefined) => Math.max(1, Math.floor(tx?.lockTimeoutMs ?? opts.busyTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS));
  const statementTimeout = opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  const answerMs = statementTimeout > 0 ? statementTimeout + Math.min(ANSWER_MARGIN_MS, statementTimeout) : 0;
  const pool = new pg.Pool({
    connectionString: pgConnectionString(opts.scope ? scopedUrl(url, opts.scope) : url),
    max: POOL_MAX[opts.role],
    // Bounds both opening a connection and waiting for a free one: the holders' statements end within the statement timeout.
    connectionTimeoutMillis: answerMs,
    keepAlive: true,
    keepAliveInitialDelayMillis: CLIENT_KEEPALIVE_MS,
    allowExitOnIdle: true,
    application_name: `autocraft-${opts.role}`,
    // A startup parameter of every connection, so it also bounds statements outside transactions; no SET is sent.
    statement_timeout: statementTimeout,
    // A lone write of a rowWrites handle waits for row locks no longer than a transaction waits for its lock.
    ...(opts.rowWrites && { lock_timeout: lockTimeout(undefined) }),
    types: typesFor(pg),
  });
  // An idle connection that fails (server restart, network) is dropped by the pool; without a listener it would crash the process.
  pool.on("error", (e) => console.warn(`db: idle Postgres connection failed: ${e.message}`));
  pool.on("connect", (client) => {
    answerWithin(client, answerMs);
    observeClient(client, ctx);
    // The pool listens only while a connection is idle. One the server ends while it is checked out (an idle transaction
    // past its limit, a terminated backend) must not crash the process: its next statement fails, and the pool drops it.
    client.on("error", () => {});
  });
  const raw = (text: string, values?: unknown[]) => k.CompiledQuery.raw(text, values);
  const sessionSettings = { ...SERVER_KEEPALIVE, ...NO_JIT, idle_in_transaction_session_timeout: opts.idleInTransactionMs ?? DEFAULT_IDLE_IN_TRANSACTION_MS };
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

    override createQueryCompiler(): K.QueryCompiler {
      return schemaCompiler(k, opts.scope);
    }
  }

  const kysely = new k.Kysely<DB>({ dialect: new Dialect({ pool }) });
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
    exclusiveLock: async (name: string, waitMs: number) => {
      // A connection of its own, outside the pool (a job's pool has one connection), closed with the lock: closing the
      // session releases it, and so does the server when this process dies (SERVER_KEEPALIVE).
      const wait = Math.max(1, Math.floor(waitMs));
      const c = new pg.Client({ connectionString: pgConnectionString(url), application_name: "autocraft-lock", keepAlive: true, keepAliveInitialDelayMillis: CLIENT_KEEPALIVE_MS, connectionTimeoutMillis: 10_000, query_timeout: wait + 5_000 });
      let held = false;
      c.on("error", () => (held = false));
      c.on("end", () => (held = false));
      const end = async (): Promise<void> => {
        held = false;
        await c.end().catch(() => undefined);
      };
      try {
        await c.connect();
        await setSession((text) => c.query(text), SERVER_KEEPALIVE, "the lock connection", (l) => console.warn(l), 10_000);
        await c.query(`SET lock_timeout = ${wait}`);
        await c.query(`SELECT pg_advisory_lock(${EXCLUSIVE_LOCKS}, hashtext($1))`, [name]);
        held = true;
      } catch (e) {
        await end();
        throw e;
      }
      return { release: end, held: () => held };
    },
    exec: async (op: Op, text: string, args: Args, tx: Tx | undefined) => {
      const { text: q, values } = bindParams(parse(text), args, (i) => `$${i + 1}`);
      const r = await on(tx, (conn) => conn.executeQuery<Row>(raw(q, values)));
      if (op === "get") return r.rows[0];
      if (op === "all") return [...r.rows];
      return withoutInsertId(Number(r.numAffectedRows ?? 0n));
    },
    script: async (text, tx) => void (await on(tx, (conn) => conn.executeQuery(raw(rewriteScriptForPostgres(text, opts.scope))))),
    // Each read becomes `(select coalesce(json_agg(agg), '[]') from (<read>) as agg) AS qN`, as Kysely's jsonArrayFrom
    // helper writes it; the compiler puts the parentheses around a SELECT inside raw SQL. CTEs the reads share head the statement.
    fuse: (kysely, nodes) => {
      const { shared, reads } = hoistShared(nodes);
      const parts = reads.map((n, i) => k.sql`(select coalesce(json_agg(agg), '[]') from ${{ toOperationNode: () => n }} as agg) as ${k.sql.ref(`q${i}`)}`);
      const head = shared ? k.sql`${{ toOperationNode: () => shared }} ` : k.sql``;
      return k.sql<Row>`${head}select ${k.sql.join(parts)}`.compile(kysely);
    },
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

/**
 * The CTEs that two or more reads of a wave declare alike (same name, query and parameters), moved to one WITH at the head of the fused
 * statement, so Postgres plans and runs each once; `reads` are the reads without them. A read gives up only a leading run of its CTEs: a
 * later CTE may refer to an earlier one, and one left in place shadows a hoisted CTE of its name. Two different CTEs of one name are
 * never both hoisted, nor one named as a table, which would shadow the table in every read.
 */
export function hoistShared(nodes: readonly K.OperationNode[]): { shared: K.WithNode | undefined; reads: K.OperationNode[] } {
  const ctes = (n: K.OperationNode): readonly K.CommonTableExpressionNode[] => {
    const w = n.kind === "SelectQueryNode" ? (n as K.SelectQueryNode).with : undefined;
    return w && !w.recursive ? w.expressions : [];
  };
  const keyOf = (c: K.CommonTableExpressionNode): string => JSON.stringify(c, (_, v: unknown) => (typeof v === "bigint" ? `${v}n` : v));
  const nameOf = (c: K.CommonTableExpressionNode): string => c.name.table.table.identifier.name;
  const uses = new Map<string, number>();
  for (const n of nodes) for (const key of new Set(ctes(n).map(keyOf))) uses.set(key, (uses.get(key) ?? 0) + 1);
  const hoisted = new Map<string, K.CommonTableExpressionNode>();
  const byName = new Map<string, string>();
  const reads = nodes.map((n) => {
    const list = ctes(n);
    let i = 0;
    for (; i < list.length; i++) {
      const c = list[i]!, key = keyOf(c), name = nameOf(c);
      if ((uses.get(key) ?? 0) < 2 || (byName.get(name) ?? key) !== key || Object.hasOwn(COLUMNS, name)) break;
      byName.set(name, key);
      hoisted.set(key, c);
    }
    if (i === 0) return n;
    const s = n as K.SelectQueryNode;
    return { ...s, with: i < list.length ? { ...s.with!, expressions: list.slice(i) } : undefined } as K.SelectQueryNode;
  });
  return { shared: hoisted.size ? ({ kind: "WithNode", expressions: [...hoisted.values()] } as K.WithNode) : undefined, reads };
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

  /** Subscriptions that are not `background`. */
  let waits = 0;
  // The connection keeps the process alive only while something waits for a notification, so a process can end once its
  // waits are over; a background subscription (a cache) never holds it.
  const hold = (): void => {
    const c = client as (Pg.Client & { ref?: () => void; unref?: () => void }) | null;
    if (waits) c?.ref?.();
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
      const c = new pg.Client({ connectionString: pgConnectionString(url), application_name: "autocraft-listen", keepAlive: true, keepAliveInitialDelayMillis: CLIENT_KEEPALIVE_MS, connectionTimeoutMillis: LISTEN_CONNECT_MS });
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
    listen(channel, fn, o) {
      if (!CHANNEL.test(channel)) throw new Error(`db: bad channel name ${channel}`);
      if (closed) throw new Error("db: the handle is closed");
      let set = fns.get(channel);
      if (!set) fns.set(channel, set = new Set());
      set.add(fn);
      const waiting = !o?.background;
      if (waiting) waits++;
      hold();
      if (client) void sync(client);
      else void connect();
      return {
        listening: () => client !== null && active.has(channel),
        off: () => {
          if (!set.delete(fn)) return;
          if (waiting) waits--;
          hold();
          if (set.size || fns.get(channel) !== set) return;
          fns.delete(channel);
          active.delete(channel);
          if (client) void client.query(`UNLISTEN ${channel}`).catch(() => undefined);
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
