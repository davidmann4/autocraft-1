// Postgres schema migrations that can run while an older process keeps serving on the same database.
//
// - One migration at a time: the migrating connection holds a session advisory lock (MIGRATION_LOCK_KEY) for the whole run.
// - Small transactions: the work is split into steps that each lock at most one table, so a busy table holds up only its
//   own step, and no step keeps locks on other tables while it waits.
// - Short lock waits: every step runs with a lock_timeout of LOCK_TIMEOUT_MS. A lock request that cannot be granted makes
//   every later request on that table queue behind it, so it is given up quickly and retried with jittered backoff until
//   the migration window (MIGRATION_WINDOW_MS) runs out. Each retry logs who holds the table.
// - Statements that would change nothing are skipped rather than run for their IF NOT EXISTS, because ALTER TABLE takes
//   ACCESS EXCLUSIVE and CREATE INDEX takes SHARE before looking: existing tables, columns and valid indexes.
// - A new index on a table that existed before the migration is built CONCURRENTLY, outside a transaction.
// Every step is idempotent, so a migration that fails part-way is completed by the next one; the caller writes the
// schema stamp as its last step.
import { readFileSync } from "node:fs";

/** One connection (a pg Client): the advisory lock and every step must share it. */
export interface PgClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** The advisory lock key every AutoCraft schema migration takes: "autocraf" in ASCII as a 64-bit integer. */
export const MIGRATION_LOCK_KEY = 0x6175746f63726166n;

/** How long one step waits for a table lock before it gives up and retries. */
export const LOCK_TIMEOUT_MS = 1500;
/** How long a migration keeps retrying, waiting for the advisory lock included. Startup probes must allow longer. */
export const MIGRATION_WINDOW_MS = 10 * 60_000;

export const pgSchemaSql = (): string => readFileSync(new URL("../schema.pg.sql", import.meta.url), "utf8");

/** The stamp in the schema file's header (it covers the dialect and the whole file body). */
export function pgSchemaStamp(sql: string = pgSchemaSql()): string {
  const m = /^-- dialect: postgres; stamp: ([0-9a-f]{16})$/m.exec(sql);
  if (!m) throw new Error("src/schema.pg.sql has no stamp line");
  return m[1]!;
}

/**
 * Pins the search path of every plpgsql function in the app schema (trigger bodies and their helpers) to that schema, so a
 * trigger fired from a scoped handle (src/db/scoped.ts) reads the tables, as SQLite resolves a trigger's names in its
 * own schema. SQL-language functions are left alone: a SET clause would stop them being inlined. CREATE OR REPLACE
 * FUNCTION clears the setting, so every step that replaces a function ends with this.
 */
export const PIN_SEARCH_PATH = `DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
    WHERE p.pronamespace = current_schema()::regnamespace AND l.lanname = 'plpgsql'
      AND NOT format('search_path=%I', current_schema()) = ANY (COALESCE(p.proconfig, '{}'))
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = %I', f.sig, current_schema());
  END LOOP;
END $$`;

/** SQLSTATE codes worth retrying: deadlock_detected and lock_not_available (lock_timeout expired). */
const RETRYABLE_CODES = new Set(["40P01", "55P03"]);
/** CREATE OR REPLACE VIEW cannot drop, rename or retype a column (42P16, 42804): the view is dropped and created instead. */
const VIEW_SHAPE_CODES = new Set(["42P16", "42804"]);

export interface MigrationOpts {
  /** Replaced in tests so retries do not wait. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  windowMs?: number;
  /** Builds new indexes inside their table's step rather than CONCURRENTLY: for a database nothing else is using. */
  plainIndexes?: boolean;
}

/** A unit of work in its own transaction. `table` is the one table it locks, named in the wait log. */
export interface Step {
  label: string;
  table?: string;
  sql?: string[];
  /** Runs inside the transaction after `sql`. */
  run?: () => Promise<void>;
  /** Runs instead of `sql` when `sql` fails because a view's columns changed shape. */
  fallback?: string[];
}

/** A new index on a table that existed before the migration, built concurrently. */
interface IndexStep {
  label: string;
  table: string;
  index: string;
  create: string;
}

const errCode = (e: unknown): string | undefined => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : undefined;
};

/** Splits SQL text into statements at semicolons outside quotes, dollar quotes and comments. */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const push = (end: number) => {
    const s = sql.slice(start, end).trim();
    if (s.replace(/^\s*--.*$/gm, "").trim()) out.push(s);
  };
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "-" && sql[i + 1] === "-") {
      const e = sql.indexOf("\n", i);
      i = e < 0 ? sql.length : e + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const e = sql.indexOf("*/", i + 2);
      i = e < 0 ? sql.length : e + 2;
    } else if (c === "'") {
      const escapes = /[Ee]/.test(sql[i - 1] ?? "") && !/[A-Za-z0-9_]/.test(sql[i - 2] ?? "");
      i++;
      while (i < sql.length) {
        if (escapes && sql[i] === "\\") i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i++;
      }
      i++;
    } else if (c === '"') {
      const e = sql.indexOf('"', i + 1);
      i = e < 0 ? sql.length : e + 1;
    } else if (c === "$" && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? "")) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64))?.[0];
      if (tag) {
        const e = sql.indexOf(tag, i + tag.length);
        i = e < 0 ? sql.length : e + tag.length;
      } else i++;
    } else {
      if (c === ";") {
        push(i);
        start = i + 1;
      }
      i++;
    }
  }
  push(sql.length);
  return out;
}

/** The statement without its leading comment lines. */
const bare = (s: string): string => s.replace(/^(\s*--.*\n)+/, "").trimStart();

const LOCKED_TABLE = [
  /^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?([\w.]+)/i,
  /^CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?\w+ ON (?:ONLY )?([\w.]+)/i,
  /^CREATE (?:UNLOGGED )?TABLE (?:IF NOT EXISTS )?([\w.]+)/i,
  /^CREATE (?:OR REPLACE )?(?:CONSTRAINT )?TRIGGER \w+\s[\s\S]*?\sON ([\w.]+)/i,
  /^DROP TRIGGER (?:IF EXISTS )?\w+ ON ([\w.]+)/i,
  /^(?:CREATE (?:OR REPLACE )?|DROP )VIEW (?:IF EXISTS )?([\w.]+)/i,
];

/** The table (or view) a DDL statement locks, or undefined for one that locks none (functions) or only rows (DML). */
export function lockedTable(stmt: string): string | undefined {
  const s = bare(stmt);
  for (const r of LOCKED_TABLE) {
    const m = r.exec(s);
    if (m) return m[1];
  }
  return undefined;
}

/** What the database has, for skipping statements that would change nothing. */
export interface Catalog {
  tables: Set<string>;
  /** "table.column" */
  columns: Set<string>;
  /** Index name to whether it is valid (a failed CREATE INDEX CONCURRENTLY leaves an invalid one). */
  indexes: Map<string, boolean>;
}

export async function readCatalog(client: PgClient): Promise<Catalog> {
  const { rows } = await client.query(`SELECT 't' AS k, relname::text AS n, NULL::text AS c, true AS ok FROM pg_class
      WHERE relnamespace = current_schema()::regnamespace AND relkind IN ('r', 'p')
    UNION ALL SELECT 'c', table_name::text, column_name::text, true FROM information_schema.columns WHERE table_schema = current_schema()
    UNION ALL SELECT 'i', c.relname::text, NULL, x.indisvalid FROM pg_class c JOIN pg_index x ON x.indexrelid = c.oid
      WHERE c.relnamespace = current_schema()::regnamespace`);
  const cat: Catalog = { tables: new Set(), columns: new Set(), indexes: new Map() };
  for (const r of rows as { k: string; n: string; c: string | null; ok: boolean }[]) {
    if (r.k === "t") cat.tables.add(r.n);
    else if (r.k === "c") cat.columns.add(`${r.n}.${r.c}`);
    else cat.indexes.set(r.n, r.ok);
  }
  return cat;
}

/**
 * The steps that apply `sql` (idempotent DDL and seed rows) to a database with catalog `cat`. Statements that would change
 * nothing are dropped; the rest are grouped in order into steps that each lock at most one table. A new index on a table
 * in `existed` (tables that were serving before the migration) is built concurrently.
 */
export function planDdl(sql: string, cat: Catalog, existed: Set<string>, label: string): (Step | IndexStep)[] {
  const out: (Step | IndexStep)[] = [];
  let cur: (Step & { sql: string[] }) | undefined;
  const flush = () => {
    if (cur?.sql.length) {
      if (cur.sql.some((s) => /^CREATE OR REPLACE FUNCTION/i.test(bare(s)))) cur.sql.push(PIN_SEARCH_PATH);
      out.push(cur);
    }
    cur = undefined;
  };
  for (const stmt of splitSql(sql)) {
    const s = bare(stmt);
    const table = /^CREATE (?:UNLOGGED )?TABLE IF NOT EXISTS (\w+)/i.exec(s);
    if (table && cat.tables.has(table[1]!)) continue;
    const col = /^ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+)/i.exec(s);
    if (col && !/,\s*ADD\s/i.test(s) && cat.columns.has(`${col[1]}.${col[2]}`)) continue;
    const ix = /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+) ON (\w+)/i.exec(s);
    if (ix && cat.indexes.get(ix[1]!) === true) continue;
    if (ix && existed.has(ix[2]!)) {
      flush();
      out.push({ label: `index ${ix[1]}`, table: ix[2]!, index: ix[1]!, create: s.replace(/INDEX IF NOT EXISTS/i, "INDEX CONCURRENTLY IF NOT EXISTS") });
      continue;
    }
    const t = lockedTable(s);
    if (cur?.table && t && cur.table !== t) flush();
    cur ??= { label, sql: [] };
    if (t && !cur.table) {
      cur.table = t;
      cur.label = `${label}: ${t}`;
    }
    cur.sql.push(stmt);
  }
  flush();
  return out;
}

const isIndexStep = (s: Step | IndexStep): s is IndexStep => "index" in s;

export interface Migration {
  /** Runs one step in its own transaction, retrying lock waits until the window ends. */
  step(s: Step): Promise<void>;
  /** Plans `sql` against the current catalog (planDdl) and runs its steps. */
  ddl(sql: string, label: string): Promise<void>;
}

/**
 * Runs `fn` while `client`'s session holds the migration lock. A second process waits here while the first migrates,
 * so `fn` must recheck whether there is anything left to do.
 */
export async function withMigrationLock<T>(client: PgClient, fn: (m: Migration) => Promise<T>, opts: MigrationOpts = {}): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line: string) => console.warn(line));
  const windowMs = opts.windowMs ?? MIGRATION_WINDOW_MS;
  const started = now();
  const deadline = started + windowMs;
  const elapsed = () => `${Math.round((now() - started) / 1000)} s of ${Math.round(windowMs / 1000)} s`;

  // ADD COLUMN IF NOT EXISTS and friends report every skipped object as a notice.
  await client.query("SET client_min_messages = warning");
  for (let attempt = 1; ; attempt++) {
    if ((await client.query(`SELECT pg_try_advisory_lock(${MIGRATION_LOCK_KEY}) AS ok`)).rows[0]?.ok) break;
    if (now() >= deadline) throw new Error(`schema migration: another process held the migration lock for the whole window (${elapsed()})`);
    if (attempt % 10 === 1) {
      const holder = (await client.query(`SELECT a.pid, a.application_name AS app FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.granted AND l.classid = ${MIGRATION_LOCK_KEY >> 32n} AND l.objid = ${MIGRATION_LOCK_KEY & 0xffffffffn}`)).rows[0];
      log(`schema migration: waiting for the migration lock held by ${holder ? `${holder.app || "?"} pid ${holder.pid}` : "another process"} (${elapsed()})`);
    }
    await sleep(1000);
  }

  // Who holds `table` (with no table: the oldest open transactions holding any), for the wait log.
  const holders = async (table: string | undefined): Promise<string> => {
    const { rows } = await client.query(`SELECT a.pid, COALESCE(NULLIF(a.application_name, ''), a.usename::text) AS app, a.state,
        string_agg(DISTINCT l.mode, ', ') AS modes, floor(extract(epoch FROM now() - a.xact_start))::int AS secs
      FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.granted AND l.pid <> pg_backend_pid() AND l.locktype = 'relation' AND a.xact_start IS NOT NULL
        AND CASE WHEN $1::text IS NULL THEN a.xact_start < now() - interval '1 second' ELSE l.relation = to_regclass($1::text) END
      GROUP BY a.pid, a.application_name, a.usename, a.state, a.xact_start ORDER BY a.xact_start LIMIT 3`, [table ?? null]);
    if (!rows.length) return "no holder left";
    return "held by " + rows.map((r) => `${r.app} pid ${r.pid} (${r.modes}; ${r.state}; transaction open ${r.secs} s)`).join(", ");
  };

  const retry = async (label: string, table: string | undefined, attempt: number, e: unknown): Promise<void> => {
    const code = errCode(e);
    if (!code || !RETRYABLE_CODES.has(code)) throw e;
    if (now() >= deadline) {
      throw Object.assign(new Error(`schema migration: step "${label}" could not get its locks within the window (${elapsed()}): ${(e as Error).message}`), { code });
    }
    const delay = Math.round(Math.min(5000, 250 * 2 ** Math.min(attempt, 5)) * (0.5 + Math.random()));
    const what = code === "40P01" ? "deadlocked" : `waited ${LOCK_TIMEOUT_MS / 1000} s for a lock${table ? ` on ${table}` : ""}`;
    log(`schema migration: step "${label}" ${what} (try ${attempt}, ${elapsed()}): ${await holders(table)}; retrying in ${(delay / 1000).toFixed(1)} s`);
    await sleep(delay);
  };

  const begin = `BEGIN;\nSET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`;
  const step = async (s: Step): Promise<void> => {
    let sql = s.sql ?? [];
    for (let attempt = 1; ; attempt++) {
      try {
        // One round trip for the whole step.
        await client.query([begin, ...sql].join(";\n"));
        await s.run?.();
        await client.query("COMMIT");
        return;
      } catch (e) {
        await client.query("ROLLBACK");
        if (s.fallback && sql !== s.fallback && VIEW_SHAPE_CODES.has(errCode(e) ?? "")) {
          sql = s.fallback;
          continue;
        }
        await retry(s.label, s.table, attempt, e);
      }
    }
  };

  const index = async (s: IndexStep): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      try {
        // A concurrent build waits for older transactions without blocking writers, so it may wait out the window.
        await client.query(`SET lock_timeout = '${Math.max(deadline - now(), LOCK_TIMEOUT_MS)}ms'`);
        const found = (await client.query("SELECT x.indisvalid AS ok FROM pg_index x WHERE x.indexrelid = to_regclass($1::text)", [s.index])).rows[0];
        if (found?.ok === true) return;
        if (found) await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${s.index}`);
        await client.query(s.create);
        return;
      } catch (e) {
        await retry(s.label, s.table, attempt, e);
      } finally {
        await client.query("RESET lock_timeout");
      }
    }
  };

  let existed: Set<string> | undefined;
  const m: Migration = {
    step,
    async ddl(sql, label) {
      const cat = await readCatalog(client);
      existed ??= opts.plainIndexes ? new Set() : cat.tables;
      for (const s of planDdl(sql, cat, existed, label)) await (isIndexStep(s) ? index(s) : step(s));
    },
  };
  try {
    return await fn(m);
  } finally {
    await client.query(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`).catch(() => {});
  }
}
