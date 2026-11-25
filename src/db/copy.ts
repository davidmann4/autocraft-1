// Copies a whole AutoCraft database between SQLite and Postgres, in either direction, and compares two databases by row
// counts and digests. `autocraft-server db copy|verify` (src/db/cli.ts) runs these.
//
// A copy into Postgres applies src/schema.pg.sql without its triggers, copies every table in key order keeping rowid and
// identity values, sets every identity sequence past the copied keys (or to SQLite's AUTOINCREMENT counter), then
// migrates it (triggers, runtime tables, stamp), copies the runtime tables' counters and logs, and runs ANALYZE. A copy into SQLite creates the schema with `connect()`, drops the triggers for
// the copy, then restores them, rebuilds the full-text indexes and review_blockers, and sets sqlite_sequence.
//
// Digests are read through each side's Db, so they see the values the app sees: an integer stored as bigint, a bytea
// read back, a text column that came back as something else all show up as a mismatch.
import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import { planChangesSql } from "../core/plan-changes.ts";
import type { Db, Param, Row, Value } from "./index.ts";
import { connect } from "../db.ts";
import { connectDb, dbFor, isPgUrl, loadPg } from "./open.ts";
import { MIGRATION_LOCK_KEY, pgSchemaSql } from "./pg-migrate.ts";
import { migratePg } from "./pg-triggers.ts";
import { pgConnectionString } from "./postgres.ts";
import { HAND_TRIGGERS } from "./pg-schema.ts";

/**
 * Tables the app creates when it opens a database (src/live.ts, src/core/plan-changes.ts), not in the schema file. On
 * Postgres they come with the runtime triggers (`migratePgTarget`), so a copy into Postgres copies them after that, values
 * as they are. A copy or comparison skips them when only one side has them; live_flush exists only on Postgres.
 */
export const RUNTIME_TABLES = new Set(["change_seq", "item_changes", "plan_full", "plan_full_causes", "plan_shadow_diffs", "plan_pass_stats", "plan_bulk", "review_blockers", "live_flush"]);

/**
 * Rows a copy leaves where they are and a comparison leaves out: the schema stamp and the Postgres schema generation
 * belong to each database's own migration (SQLite and Postgres stamps differ), so the target keeps or writes its own.
 */
const ROW_FILTER: Record<string, string> = { settings: "key NOT IN ('schema_stamp', 'schema_generation')" };

/**
 * Columns that Postgres stores as bytea and SQLite rows may hold as plain text from before texts were gzipped
 * (src/agents/runs.ts packText). The copy into Postgres gzips such text; digests compare the unpacked text on both sides.
 */
const PACKED: Record<string, ReadonlySet<string>> = { agent_run_texts: new Set(["prompt", "output"]) };

/** Bound parameters per INSERT, under both backends' limits (SQLite 32766, Postgres 65535). */
const MAX_PARAMS = 30_000;

export const DEFAULT_BATCH = 2000;

type Log = (line: string) => void;

/** One table as one side sees it. */
interface Table {
  name: string;
  /** Column names as rows carry them; on a SQLite rowid table without an INTEGER PRIMARY KEY, includes `rowid`. */
  columns: string[];
  /** Select-list expressions, one per column. */
  select: string[];
  /** Columns that order the rows uniquely, for paging. */
  key: string[];
  /** Columns that hold bytes (BLOB, bytea). */
  bytes: Set<string>;
}

interface Side {
  db: Db;
  label: string;
  tables: Map<string, Table>;
}

const qi = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** A target for messages: a SQLite path, or a Postgres URL without its password. */
export function describeTarget(target: string): string {
  if (!isPgUrl(target)) return target;
  const u = new URL(target);
  if (u.password) u.password = "***";
  return u.toString();
}

async function sqliteTables(db: Db): Promise<Map<string, Table>> {
  const out = new Map<string, Table>();
  const list = (await db.prepare("PRAGMA main.table_list").all()) as { name: string; type: string; wr: number }[];
  for (const t of list) {
    if (t.type !== "table" || t.name.startsWith("sqlite_")) continue;
    const info = (await db.prepare(`PRAGMA main.table_info(${qi(t.name)})`).all()) as { name: string; type: string; pk: number }[];
    const pk = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
    const rowidTable = t.wr === 0;
    const alias = rowidTable && pk.length === 1 && pk[0]!.type.toUpperCase() === "INTEGER" ? pk[0]!.name : null;
    const columns = info.map((c) => c.name);
    const select = columns.map(qi);
    if (rowidTable && !alias) {
      columns.push("rowid");
      select.push("rowid AS rowid");
    }
    out.set(t.name, {
      name: t.name,
      columns,
      select,
      key: rowidTable ? [alias ?? "rowid"] : pk.map((c) => c.name),
      bytes: new Set(info.filter((c) => c.type.toUpperCase() === "BLOB").map((c) => c.name)),
    });
  }
  return out;
}

async function pgTables(db: Db): Promise<Map<string, Table>> {
  const cols = (await db.prepare(`SELECT c.relname AS t, a.attname AS c, a.attgenerated AS gen, format_type(a.atttypid, a.atttypmod) AS type
    FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum`).all()) as { t: string; c: string; gen: string; type: string }[];
  const pks = (await db.prepare(`SELECT c.relname AS t, a.attname AS c
    FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, n)
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
    WHERE i.indisprimary AND c.relnamespace = current_schema()::regnamespace
    ORDER BY c.relname, k.n`).all()) as { t: string; c: string }[];
  const out = new Map<string, Table>();
  for (const r of cols) {
    let t = out.get(r.t);
    if (!t) out.set(r.t, (t = { name: r.t, columns: [], select: [], key: [], bytes: new Set() }));
    // Generated columns (the tsvector search columns) are computed by Postgres, not copied.
    if (r.gen !== "") continue;
    t.columns.push(r.c);
    t.select.push(qi(r.c));
    if (r.type === "bytea") t.bytes.add(r.c);
  }
  for (const t of out.values()) {
    if (t.columns.includes("rowid")) t.key = ["rowid"];
    else t.key = pks.filter((p) => p.t === t.name).map((p) => p.c);
  }
  return out;
}

const tablesOf = (db: Db): Promise<Map<string, Table>> => (db.dialect === "postgres" ? pgTables(db) : sqliteTables(db));

async function openSide(target: string, opts: { readOnly: boolean }): Promise<Side> {
  let db: Db;
  // Postgres opens as it is: the target gets its triggers after the rows are in, and a source is never migrated.
  if (isPgUrl(target)) db = await connectDb(target, { role: "cli", migrate: false });
  else if (opts.readOnly) {
    if (!existsSync(target)) throw new Error(`no SQLite database at ${target}`);
    db = await dbFor(new DatabaseSync(target, { readOnly: true }));
  } else db = await dbFor(connect(target)); // The file itself, also where a test hook makes connectDb open Postgres for a path.
  return { db, label: describeTarget(target), tables: new Map() };
}

/** What a copy or comparison covers, and what it leaves out. */
interface Match {
  both: [Table, Table][];
  /** Runtime tables only one side has. */
  skipped: string[];
  /** With `skipExtra`: tables and columns (`table.column`) only one side has. */
  extra: string[];
}

/**
 * The tables a copy or comparison covers: those both sides have, with the same columns. Any other difference throws,
 * unless `skipExtra`: then tables and columns only one side has are left out and listed (a database migrated by SQLite
 * keeps the tables and columns of retired features, which the Postgres schema does not have).
 */
function matchTables(a: Pick<Side, "label" | "tables">, b: Pick<Side, "label" | "tables">, skipExtra: boolean): Match {
  const problems: string[] = [];
  const out: Match = { both: [], skipped: [], extra: [] };
  const narrow = (t: Table, keep: string[]): Table => {
    const idx = keep.map((c) => t.columns.indexOf(c));
    return { ...t, columns: keep, select: idx.map((i) => t.select[i]!) };
  };
  for (const name of [...new Set([...a.tables.keys(), ...b.tables.keys()])].sort()) {
    let ta = a.tables.get(name);
    let tb = b.tables.get(name);
    if (!ta || !tb) {
      if (RUNTIME_TABLES.has(name)) out.skipped.push(name);
      else if (skipExtra) out.extra.push(name);
      else problems.push(`table ${name} only in ${ta ? a.label : b.label}`);
      continue;
    }
    const onlyA = ta.columns.filter((c) => !tb!.columns.includes(c));
    const onlyB = tb.columns.filter((c) => !ta!.columns.includes(c));
    if (onlyA.length || onlyB.length) {
      if (!skipExtra) {
        problems.push(`table ${name}: columns only in ${a.label}: ${onlyA.join(", ") || "-"}; only in ${b.label}: ${onlyB.join(", ") || "-"}`);
        continue;
      }
      out.extra.push(...[...onlyA, ...onlyB].map((c) => `${name}.${c}`));
      const shared = ta.columns.filter((c) => tb!.columns.includes(c));
      ta = narrow(ta, shared);
      tb = narrow(tb, shared);
    }
    if (!ta.key.length || !tb.key.length || !ta.key.every((k) => ta!.columns.includes(k)) || !tb.key.every((k) => tb!.columns.includes(k))) {
      problems.push(`table ${name} has no shared key to page by`);
      continue;
    }
    out.both.push([ta, tb]);
  }
  if (problems.length) throw new Error(`the two schemas differ (bring both to the same release first, or pass --skip-extra to leave out what only one side has):\n  ${problems.join("\n  ")}`);
  return out;
}

/** The table's rows in key order, `batch` at a time. Inside a db.read every page comes from one snapshot. */
async function* pages(db: Db, t: Table, batch: number): AsyncGenerator<Row[]> {
  const sqlite = db.dialect === "sqlite";
  const keyRef = (k: string) => (sqlite && k === "rowid" && !t.select.includes(qi("rowid")) ? "rowid" : qi(k));
  const keys = t.key.map(keyRef);
  const keyList = keys.length === 1 ? keys[0]! : `(${keys.join(", ")})`;
  const marks = keys.length === 1 ? "?" : `(${keys.map(() => "?").join(", ")})`;
  const filter = ROW_FILTER[t.name];
  const head = `SELECT ${t.select.join(", ")} FROM ${qi(t.name)}`;
  const tail = `ORDER BY ${keys.join(", ")} LIMIT ${batch}`;
  let last: Param[] | undefined;
  for (;;) {
    const where = [filter, last && `${keyList} > ${marks}`].filter(Boolean);
    const rows = await db.prepare(`${head} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ${tail}`).all(...(last ?? []));
    if (rows.length) yield rows;
    if (rows.length < batch) return;
    const end = rows[rows.length - 1]!;
    last = t.key.map((k) => end[k] as Param);
  }
}

/** Approximate stored size of a row, for progress output. */
function rowBytes(r: Row): number {
  let n = 0;
  for (const v of Object.values(r)) n += typeof v === "string" ? v.length : v instanceof Uint8Array ? v.byteLength : 8;
  return n;
}

const insertCache = new Map<string, string>();

function insertSql(table: string, columns: string[], rows: number): string {
  const key = `${table}\0${columns.join(",")}\0${rows}`;
  let sql = insertCache.get(key);
  if (!sql) {
    const one = `(${columns.map(() => "?").join(", ")})`;
    sql = `INSERT INTO ${qi(table)} (${columns.map(qi).join(", ")}) VALUES ${Array(rows).fill(one).join(", ")}`;
    insertCache.set(key, sql);
  }
  return sql;
}

/** A source value as the target column takes it. Postgres would read text bound to bytea as an escape string, so only known columns convert. */
function toTarget(v: Value, table: string, column: string, target: Table, pg: boolean): Param {
  if (!pg || v === null) return v as Param;
  const bytesCol = target.bytes.has(column);
  if (bytesCol && typeof v === "string") {
    if (PACKED[table]?.has(column)) return gzipSync(v);
    throw new Error(`${table}.${column}: text value in a bytea column`);
  }
  if (!bytesCol && v instanceof Uint8Array) throw new Error(`${table}.${column}: bytes in a column that is not bytea`);
  return v as Param;
}

interface TableStats {
  table: string;
  rows: number;
  bytes: number;
  ms: number;
}

async function copyTable(src: Side, dst: Side, from: Table, to: Table, batch: number): Promise<TableStats> {
  const t0 = performance.now();
  const pg = dst.db.dialect === "postgres";
  const columns = from.columns;
  const perInsert = Math.max(1, Math.min(batch, Math.floor(MAX_PARAMS / columns.length)));
  let rows = 0;
  let bytes = 0;
  await dst.db.write(async () => {
    for await (const page of pages(src.db, from, batch)) {
      for (let i = 0; i < page.length; i += perInsert) {
        const chunk = page.slice(i, i + perInsert);
        const params: Param[] = [];
        for (const r of chunk) {
          bytes += rowBytes(r);
          for (const c of columns) params.push(toTarget(r[c] ?? null, from.name, c, to, pg));
        }
        await dst.db.prepare(insertSql(from.name, columns, chunk.length)).run(...params);
      }
      rows += page.length;
    }
  });
  return { table: from.name, rows, bytes, ms: performance.now() - t0 };
}

// ---- Sequences ----

/**
 * The last key handed out per table, where the backend keeps a counter: SQLite AUTOINCREMENT tables (the larger of
 * sqlite_sequence and the largest rowid), Postgres identity sequences (0 before the first value).
 */
async function sequences(db: Db): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (db.dialect === "sqlite") {
    const auto = (await db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table' AND sql LIKE '%AUTOINCREMENT%'").all()) as { name: string }[];
    if (!auto.length) return out;
    const seq = new Map(((await db.prepare("SELECT name, seq FROM main.sqlite_sequence").all()) as { name: string; seq: number }[]).map((r) => [r.name, r.seq]));
    for (const { name } of auto) {
      const max = ((await db.prepare(`SELECT max(rowid) AS m FROM ${qi(name)}`).get()) as { m: number | null }).m ?? 0;
      out.set(name, Math.max(max, seq.get(name) ?? 0));
    }
    return out;
  }
  for (const r of await pgIdentities(db)) out.set(r.t, r.v ?? 0);
  return out;
}

async function pgIdentities(db: Db): Promise<{ t: string; col: string; seq: string; v: number | null }[]> {
  return (await db.prepare(`SELECT c.relname AS t, a.attname AS col, s.seq,
      (SELECT p.last_value FROM pg_sequences p WHERE format('%I.%I', p.schemaname, p.sequencename) = s.seq) AS v
    FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
    CROSS JOIN LATERAL (SELECT pg_get_serial_sequence(format('%I.%I', current_schema(), c.relname), a.attname) AS seq) s
    WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' AND a.attidentity <> '' AND NOT a.attisdropped
    ORDER BY c.relname`).all()) as { t: string; col: string; seq: string; v: number | null }[];
}

/** Sets each identity sequence of the copied tables past the copied keys and the source's own counter. */
async function setPgSequences(db: Db, copied: Set<string>, source: Map<string, number>): Promise<void> {
  await db.write(async () => {
    for (const { t, col, seq } of await pgIdentities(db)) {
      if (!copied.has(t)) continue;
      const max = ((await db.prepare(`SELECT coalesce(max(${qi(col)}), 0) AS m FROM ${qi(t)}`).get()) as { m: number }).m;
      const v = Math.max(max, source.get(t) ?? 0);
      if (v > 0) await db.prepare("SELECT setval(?, ?, true)").get(seq, v);
      else await db.prepare("SELECT setval(?, 1, false)").get(seq);
    }
  });
}

/** Sets sqlite_sequence of the copied AUTOINCREMENT tables to at least the source's counter. */
async function setSqliteSequences(db: Db, copied: Set<string>, source: Map<string, number>): Promise<void> {
  const auto = (await db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table' AND sql LIKE '%AUTOINCREMENT%'").all()) as { name: string }[];
  await db.write(async () => {
    for (const { name } of auto) {
      const v = source.get(name);
      if (!copied.has(name) || v === undefined) continue;
      const r = await db.prepare("UPDATE main.sqlite_sequence SET seq = max(seq, ?) WHERE name = ?").run(v, name);
      if (r.changes === 0) await db.prepare("INSERT INTO main.sqlite_sequence (name, seq) VALUES (?, ?)").run(name, v);
    }
  });
}

// ---- Targets ----

/** The hand-translated triggers of src/schema.pg.sql (src/db/pg-schema.ts HAND_TRIGGERS), as statement texts. */
function handTriggerSql(): string[] {
  return Object.values(HAND_TRIGGERS).flatMap((h) => (typeof h.pg === "string" ? [h.pg] : []));
}

/** src/schema.pg.sql without its triggers: tables, indexes, views, seeds and the compat functions. */
export function pgSchemaWithoutTriggers(sql: string = pgSchemaSql()): string {
  let out = sql;
  for (const t of handTriggerSql()) {
    if (!out.includes(t)) throw new Error("a hand-translated trigger is missing from src/schema.pg.sql: run pnpm pg-schema");
    out = out.replace(t, "-- (trigger installed after the data copy)");
  }
  return out;
}

/**
 * Brings a Postgres target to the app's schema and triggers once the copied rows are in, under the migration lock; the
 * triggers are created after the rows, so the copied rows fire nothing. This is the one place the copy migrates: `migratePg`
 * applies the schema file with its hand-translated triggers, creates the RUNTIME_TABLES with their runtime triggers and
 * stores the stamp. With no other session working on the target, the indexes are built plainly, which is faster than
 * CONCURRENTLY.
 */
async function migratePgTarget(url: string): Promise<void> {
  const pg = await loadPg();
  const client = new pg.Client({ connectionString: pgConnectionString(url), application_name: "autocraft-copy" });
  await client.connect();
  try {
    const busy = (await client.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'")).rows[0]!.n as number;
    await migratePg(client, { plainIndexes: busy === 0 });
  } finally {
    await client.end();
  }
}

async function hasRows(db: Db, tables: Iterable<string>): Promise<string | undefined> {
  for (const t of tables) if (await db.prepare(`SELECT 1 AS x FROM ${qi(t)} LIMIT 1`).get()) return t;
  return undefined;
}

/**
 * Opens the target with its schema in place and no triggers, after checking that it has no rows (unless `replace`).
 * `match` checks the target's tables against the source; when it throws, the target is left as it was: on Postgres the
 * schema is applied in the same transaction, a SQLite file created here is removed.
 */
async function prepareTarget(target: string, replace: boolean, match: (tables: Map<string, Table>, label: string) => Match, log: Log): Promise<{ side: Side; match: Match; sqliteTriggers: string[] }> {
  const notEmpty = (label: string, table: string) => new Error(`target ${label} is not empty (table ${table} has rows); pass --replace to overwrite it`);
  if (isPgUrl(target)) {
    const side = await openSide(target, { readOnly: false });
    const db = side.db;
    try {
      const full = await hasRows(db, (await pgTables(db)).keys());
      if (full && !replace) throw notEmpty(side.label, full);
      const m = await db.write(async () => {
        await db.script(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
        await db.script("SET LOCAL client_min_messages = warning");
        // Triggers left by an earlier schema or copy would fire on the copied rows.
        const triggers = (await db.prepare(`SELECT t.tgname AS name, c.relname AS tbl FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          WHERE NOT t.tgisinternal AND c.relnamespace = current_schema()::regnamespace`).all()) as { name: string; tbl: string }[];
        for (const t of triggers) await db.script(`DROP TRIGGER ${qi(t.name)} ON ${qi(t.tbl)}`);
        await db.script(pgSchemaWithoutTriggers());
        // Indexes other than keys are built in one pass after the rows are in, by the migration (its schema file creates
        // every index IF NOT EXISTS): far faster than updating them row by row, above all the search columns' GIN indexes.
        const indexes = (await db.prepare(`SELECT i.relname AS name FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
          WHERE t.relnamespace = current_schema()::regnamespace AND NOT x.indisprimary
            AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = x.indexrelid)`).all()) as { name: string }[];
        for (const ix of indexes) await db.script(`DROP INDEX ${qi(ix.name)}`);
        side.tables = await pgTables(db);
        return match(side.tables, side.label);
      });
      if (full) log("target had rows: replacing them");
      return { side, match: m, sqliteTriggers: [] };
    } catch (e) {
      await db.close();
      throw e;
    }
  }
  if (existsSync(target)) {
    const probe = new DatabaseSync(target, { readOnly: true });
    let full: string | undefined;
    try {
      const pdb = await dbFor(probe);
      full = await hasRows(pdb, (await sqliteTables(pdb)).keys());
    } finally {
      probe.close();
    }
    if (full && !replace) throw notEmpty(target, full);
  }
  const removeFiles = () => {
    for (const f of [target, `${target}-wal`, `${target}-shm`]) rmSync(f, { force: true });
  };
  removeFiles();
  const side = await openSide(target, { readOnly: false });
  const db = side.db;
  try {
    side.tables = await sqliteTables(db);
    const m = match(side.tables, side.label);
    const triggers = (await db.prepare("SELECT name, sql FROM main.sqlite_master WHERE type = 'trigger'").all()) as { name: string; sql: string }[];
    await db.write(async () => {
      for (const t of triggers) await db.script(`DROP TRIGGER main.${qi(t.name)}`);
    });
    return { side, match: m, sqliteTriggers: triggers.map((t) => t.sql) };
  } catch (e) {
    await db.close();
    removeFiles();
    throw e;
  }
}

/**
 * Empties the tables a copy fills. A SQLite target keeps the rows ROW_FILTER leaves out (its own schema stamp): they are
 * read here and written back by the returned function after the copy, under new rowids, since the copied rows bring
 * theirs and may take the old ones.
 */
async function clearTables(db: Db, tables: string[]): Promise<() => Promise<void>> {
  const kept: { table: string; rows: Row[] }[] = [];
  if (!tables.length) return async () => undefined;
  await db.write(async () => {
    if (db.dialect === "postgres") return db.script(`TRUNCATE ${tables.map(qi).join(", ")} RESTART IDENTITY`);
    for (const t of tables) {
      if (ROW_FILTER[t]) kept.push({ table: t, rows: await db.prepare(`SELECT * FROM main.${qi(t)} WHERE NOT (${ROW_FILTER[t]})`).all() });
      await db.script(`DELETE FROM main.${qi(t)}`);
    }
    await db.prepare(`DELETE FROM main.sqlite_sequence WHERE name IN (${tables.map(() => "?").join(", ")})`).run(...tables);
  });
  return () =>
    db.write(async () => {
      for (const { table, rows } of kept) {
        for (const r of rows) {
          const cols = Object.keys(r);
          await db.prepare(insertSql(table, cols, 1)).run(...cols.map((c) => r[c] as Param));
        }
      }
    });
}

async function finishSqlite(db: Db, triggers: string[]): Promise<void> {
  const sync = db.sync;
  if (!sync) throw new Error("SQLite target without a connection");
  const fts = (await db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%fts5%'").all()) as { name: string }[];
  await db.write(async () => {
    for (const sql of triggers) await db.script(sql);
    for (const { name } of fts) await db.script(`INSERT INTO main.${qi(name)} (${qi(name)}) VALUES ('rebuild')`);
    // Rebuilds review_blockers from opus_reviews (and the plan triggers again): the source may not have the table.
    await db.script(planChangesSql(sync));
  });
}

// ---- Copy ----

export interface CopyOptions {
  from: string;
  to: string;
  /** Overwrite a target that has rows. */
  replace?: boolean;
  /** Compare the two databases after the copy. */
  verify?: boolean;
  /** Rows per page read from the source. */
  batch?: number;
  /** Leave out tables and columns only one side has, instead of refusing (see matchTables). */
  skipExtra?: boolean;
  log?: Log;
}

export interface CopyResult {
  tables: TableStats[];
  skipped: string[];
  extra: string[];
  totalMs: number;
  verify?: VerifyResult;
}

const fmtMs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const fmtMb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;

export async function copyDatabase(o: CopyOptions): Promise<CopyResult> {
  const log = o.log ?? ((l: string) => console.log(l));
  const batch = o.batch ?? DEFAULT_BATCH;
  if (!Number.isInteger(batch) || batch < 1) throw new Error("--batch must be a positive integer");
  if (o.from === o.to) throw new Error("--from and --to are the same database");
  const t0 = performance.now();
  const src = await openSide(o.from, { readOnly: true });
  let dst: Side | undefined;
  try {
    src.tables = await tablesOf(src.db);
    log(`copy ${src.label} -> ${describeTarget(o.to)}`);
    let t = performance.now();
    const prepared = await prepareTarget(o.to, o.replace === true, (tables, label) => matchTables(src, { label, tables }, o.skipExtra === true), log);
    dst = prepared.side;
    const { both, skipped, extra } = prepared.match;
    const names = both.map(([a]) => a.name);
    const restoreKept = await clearTables(dst.db, names);
    log(`schema ready (${fmtMs(performance.now() - t)}); ${both.length} tables`);
    if (skipped.length) log(`skipped (runtime tables on one side only): ${skipped.join(", ")}`);
    if (extra.length) log(`left out (only on one side): ${extra.join(", ")}`);
    const stats: TableStats[] = [];
    const d = dst;
    const copyAll = async (tables: [Table, Table][]) => {
      for (const [from, to] of tables) {
        const s = await copyTable(src, d, from, to, batch);
        stats.push(s);
        log(`  ${s.table.padEnd(32)} ${String(s.rows).padStart(10)} rows ${fmtMb(s.bytes).padStart(11)} ${fmtMs(s.ms).padStart(9)}`);
      }
    };
    const copied = new Set(names);
    // One source snapshot for everything, including the runtime tables copied after the migration.
    await src.db.read(async () => {
      await copyAll(both);
      const srcSeqs = await sequences(src.db);
      t = performance.now();
      if (d.db.dialect === "postgres") {
        await setPgSequences(d.db, copied, srcSeqs);
        await migratePgTarget(o.to);
        log(`sequences, migration: indexes and triggers (${fmtMs(performance.now() - t)})`);
        // The migration created the runtime tables the target lacked; their counters and logs come over as they are.
        d.tables = await pgTables(d.db);
        const late = matchTables(src, d, o.skipExtra === true).both.filter(([a]) => !copied.has(a.name));
        if (late.length) {
          await clearTables(d.db, late.map(([a]) => a.name));
          await copyAll(late);
          for (const [a] of late) copied.add(a.name);
          await setPgSequences(d.db, new Set(late.map(([a]) => a.name)), srcSeqs);
        }
      } else {
        await restoreKept();
        await setSqliteSequences(d.db, copied, srcSeqs);
        await finishSqlite(d.db, prepared.sqliteTriggers);
        log(`sequences, triggers, search index (${fmtMs(performance.now() - t)})`);
      }
    });
    if (d.db.dialect === "postgres") {
      t = performance.now();
      await d.db.script("ANALYZE");
      log(`ANALYZE (${fmtMs(performance.now() - t)})`);
    }
    const rows = stats.reduce((n, s) => n + s.rows, 0);
    const bytes = stats.reduce((n, s) => n + s.bytes, 0);
    const totalMs = performance.now() - t0;
    log(`copied ${rows} rows, ${fmtMb(bytes)} in ${fmtMs(totalMs)}`);
    const result: CopyResult = { tables: stats, skipped, extra, totalMs };
    if (o.verify) result.verify = await verifySides(src, dst, batch, o.skipExtra === true, log);
    return result;
  } finally {
    await src.db.close();
    await dst?.db.close();
  }
}

// ---- Verify ----

/** A value as the digest sees it: packed texts unpacked, bytes as base64, everything else as JSON has it. */
function canonical(v: Value, table: string, column: string): unknown {
  if (PACKED[table]?.has(column) && v instanceof Uint8Array) return gunzipSync(v).toString("utf8");
  if (v instanceof Uint8Array) return { bytes: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64") };
  if (typeof v === "bigint") return { bigint: v.toString() };
  return v;
}

export interface TableDigest {
  rows: number;
  /** SHA-256 over the sorted SHA-256 digests of the rows' canonical JSON (columns in name order). */
  digest: string;
}

/**
 * The table's row count and digest. Rows hash as canonical JSON with columns in name order; the table digest is over the
 * sorted row digests, so it does not depend on how each backend orders equal-looking keys (citext against NOCASE).
 */
async function digestTable(db: Db, t: Table, batch: number): Promise<TableDigest> {
  const cols = [...t.columns].sort();
  const rowHashes: Buffer[] = [];
  for await (const page of pages(db, t, batch)) {
    for (const r of page) {
      const obj: Record<string, unknown> = {};
      for (const c of cols) obj[c] = canonical(r[c] ?? null, t.name, c);
      rowHashes.push(createHash("sha256").update(JSON.stringify(obj)).digest());
    }
  }
  rowHashes.sort(Buffer.compare);
  const h = createHash("sha256");
  for (const x of rowHashes) h.update(x);
  return { rows: rowHashes.length, digest: h.digest("hex") };
}

export interface VerifyRow {
  table: string;
  a: TableDigest;
  b: TableDigest;
  ok: boolean;
}

export interface VerifyResult {
  ok: boolean;
  tables: VerifyRow[];
  /** Tables with a key counter on both sides whose last handed-out keys differ. */
  sequences: { table: string; a: number; b: number }[];
  skipped: string[];
  extra: string[];
  ms: number;
}

async function verifySides(a: Side, b: Side, batch: number, skipExtra: boolean, log: Log): Promise<VerifyResult> {
  const t0 = performance.now();
  a.tables = await tablesOf(a.db);
  b.tables = await tablesOf(b.db);
  const { both, skipped, extra } = matchTables(a, b, skipExtra);
  const rows: VerifyRow[] = [];
  const [sa, sb] = await Promise.all([
    a.db.read(async () => {
      const out = new Map<string, TableDigest>();
      for (const [ta] of both) out.set(ta.name, await digestTable(a.db, ta, batch));
      return { digests: out, seqs: await sequences(a.db) };
    }),
    b.db.read(async () => {
      const out = new Map<string, TableDigest>();
      for (const [, tb] of both) out.set(tb.name, await digestTable(b.db, tb, batch));
      return { digests: out, seqs: await sequences(b.db) };
    }),
  ]);
  log(`verify ${a.label} against ${b.label}`);
  log(`  ${"table".padEnd(32)} ${"rows".padStart(10)} ${"rows".padStart(10)}  digest`);
  for (const [ta] of both) {
    const da = sa.digests.get(ta.name)!;
    const db = sb.digests.get(ta.name)!;
    const ok = da.rows === db.rows && da.digest === db.digest;
    rows.push({ table: ta.name, a: da, b: db, ok });
    log(`  ${ta.name.padEnd(32)} ${String(da.rows).padStart(10)} ${String(db.rows).padStart(10)}  ${ok ? `${da.digest.slice(0, 16)} ok` : `${da.digest.slice(0, 16)} != ${db.digest.slice(0, 16)} MISMATCH`}`);
  }
  const names = new Set(both.map(([t]) => t.name));
  const seqDiffs = [...sa.seqs].filter(([t, v]) => names.has(t) && sb.seqs.has(t) && sb.seqs.get(t) !== v).map(([t, v]) => ({ table: t, a: v, b: sb.seqs.get(t)! }));
  for (const s of seqDiffs) log(`  sequence ${s.table}: last key ${s.a} != ${s.b} MISMATCH`);
  if (skipped.length) log(`  skipped (runtime tables on one side only): ${skipped.join(", ")}`);
  if (extra.length) log(`  left out (only on one side): ${extra.join(", ")}`);
  const ok = rows.every((r) => r.ok) && seqDiffs.length === 0;
  const ms = performance.now() - t0;
  log(`verify ${ok ? "passed" : "FAILED"}: ${rows.filter((r) => !r.ok).length} of ${rows.length} tables differ, ${seqDiffs.length} sequences differ (${fmtMs(ms)})`);
  return { ok, tables: rows, sequences: seqDiffs, skipped, extra, ms };
}

/** Compares two databases (SQLite paths or Postgres URLs) table by table; SQLite files are opened read-only. */
export async function verifyDatabases(a: string, b: string, opts: { batch?: number; skipExtra?: boolean; log?: Log } = {}): Promise<VerifyResult> {
  const sa = await openSide(a, { readOnly: true });
  try {
    const sb = await openSide(b, { readOnly: true });
    try {
      return await verifySides(sa, sb, opts.batch ?? DEFAULT_BATCH, opts.skipExtra === true, opts.log ?? ((l) => console.log(l)));
    } finally {
      await sb.db.close();
    }
  } finally {
    await sa.db.close();
  }
}
