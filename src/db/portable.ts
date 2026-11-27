/**
 * SQL that means the same on SQLite and Postgres. Each helper takes the handle (or its dialect) and returns SQL text for
 * `db.prepare(...)`; inside a Kysely query, wrap the text in `sql.raw(...)` (src/db/sql.ts). The one exception is
 * `inValues`, which binds JS values and so returns a Kysely fragment.
 *
 * Arguments named `expr`, `a`, `b` are SQL expression text (a column, `?`, `:name`, a subquery). A helper writes each
 * expression argument exactly once into its output, so `?` placeholders keep their positions and count.
 *
 * | SQLite text                                   | helper                                   |
 * | --------------------------------------------- | ---------------------------------------- |
 * | `x IN (SELECT value FROM json_each(?))`       | `inList(db, "x", "?", "bigint")`          |
 * | `x IN (?, ?, ?)` from JS values (Kysely)      | `inValues(db, sql.ref("x"), values)`      |
 * | `(a, b) IN (SELECT value ->> 0, value ->> 1 FROM json_each(?))` | `inTuples(db, ["a", "b"], "?", ["text", "bigint"])` |
 * | `json_extract(c, '$.a.b')` (a string)         | `jsonText(db, "c", "$.a.b")`              |
 * | `json_extract(c, '$.n')` (a number)           | `jsonNum(db, "c", "$.n")`                 |
 * | `json_extract(c, '$.ok')` (true/false → 1/0)  | `jsonBool(db, "c", "$.ok")`               |
 * | `json_type(c, '$.a')`                         | `jsonType(db, "c", "$.a")`                |
 * | `json_valid(c)`                               | `jsonValid(db, "c")` (a predicate)        |
 * | `json_remove(c, '$.k')` (an object)           | `jsonRemoveKey(db, "c", "k")`             |
 * | `FROM t, json_each(t.c) j` (an array)         | `` `FROM t, ${jsonEach(db, "t.c", "j")}` ``|
 * | `INSERT OR IGNORE INTO t ...`                 | `insertIgnore(db, "t (a, b) VALUES (?, ?)")` |
 * | `INSERT OR REPLACE INTO t ...`                | `upsert(db, { table, cols, key })`        |
 * | `a = b COLLATE NOCASE`, citext vs text        | `ciEq(db, "a", "b")`                      |
 * | `ORDER BY a COLLATE NOCASE`                 | `` `ORDER BY ${nocase(db, "a")}` ``       |
 * | `a LIKE p` (case-insensitive)                 | `like(db, "a", "p")`                      |
 * | `ORDER BY x` on a nullable column             | `nullsFirst(db, "x")` / `nullsLast(db, "x", "DESC")` |
 * | `a IS NOT b` / `a IS b`                       | `distinctFrom(db, "a", "b")` / `notDistinctFrom` |
 * | `max(a, b)` / `min(a, b)` (scalar)            | `greatest(db, "a", "b")` / `least(...)`   |
 * | `group_concat(x, ',')`                        | `groupConcat(db, "x", ",", "x")`          |
 * | `char(10)`                                    | `chr(db, 10)`                             |
 * | `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`       | `?` bound to `nowParam()`                 |
 * | `rowid`                                       | `rowidOf("table")`                        |
 * | `t INDEXED BY idx`                            | `` `t${indexedBy(db, "idx")}` ``          |
 *
 * JSON stays TEXT on Postgres: the JSON helpers cast with `::json` in the query. Paths are SQLite's (`$.a.b`, `$[0]`,
 * `$.a[2].b`, `$."odd key"`).
 */
import { readFileSync } from "node:fs";
import type { Dialect, Param } from "./index.ts";
import type { RawBuilder, Expression } from "kysely";
import { sql } from "./sql.ts";

type D = Dialect | { readonly dialect: Dialect };

const pgOf = (d: D): boolean => (typeof d === "string" ? d : d.dialect) === "postgres";

/** A SQL string literal. */
export const quote = (s: string): string => `'${s.replaceAll("'", "''")}'`;

/** Element types `inList` and `jsonEach` can cast to on Postgres (JSON elements come out as text there). */
export type ElemType = "text" | "citext" | "bigint" | "numeric";

/**
 * `expr IN (the elements of a JSON array)`, the array bound as one parameter (`param`, e.g. `?` or `:ids`, bound to
 * `JSON.stringify(list)`): the statement text stays the same for any list length. `type` is the elements' type on
 * Postgres; compare a citext column with `citext` to keep SQLite's NOCASE match. `not` gives NOT IN.
 */
export function inList(d: D, expr: string, param = "?", type: ElemType = "text", not = false): string {
  const op = not ? "NOT IN" : "IN";
  if (!pgOf(d)) return `${expr} ${op} (SELECT value FROM json_each(${param}))`;
  const v = type === "text" ? "value" : `value::${type}`;
  return `${expr} ${op} (SELECT ${v} FROM json_array_elements_text((${param})::json) AS value)`;
}

/**
 * `(a, b, ...) IN (the rows of a JSON array of arrays)`, bound as one parameter like `inList`: `[["app", 7], ...]` matches
 * `a = 'app' AND b = 7`. `types` are the columns' types on Postgres, one per column.
 */
export function inTuples(d: D, cols: readonly string[], param: string, types: readonly ElemType[]): string {
  if (!pgOf(d)) return `(${cols.join(", ")}) IN (SELECT ${cols.map((_, k) => `value ->> ${k}`).join(", ")} FROM json_each(${param}))`;
  return `(${cols.join(", ")}) IN (SELECT ${types.map((t, k) => `(value ->> ${k})::${t}`).join(", ")} FROM json_array_elements((${param})::json) AS value)`;
}

/** Kysely: `expr IN (values)`: one parameter per value on SQLite, one array parameter on Postgres (`= ANY`). */
export function inValues(d: D, expr: Expression<unknown>, values: readonly Param[]): RawBuilder<boolean> {
  if (pgOf(d)) return sql<boolean>`${expr} = ANY(${values as unknown as Param})`;
  if (!values.length) return sql<boolean>`0`;
  return sql<boolean>`${expr} IN (${sql.join(values as Param[])})`;
}

/** A SQLite JSON path as Postgres path-array text: `$.a[2]."b c"` → `'{a,2,"b c"}'`. */
export function pgPath(path: string): string {
  if (!path.startsWith("$")) throw new Error(`JSON path must start with $: ${path}`);
  const keys: string[] = [];
  const re = /\.(?:"((?:[^"\\]|\\.)*)"|([^.[\]"]+))|\[(\d+)\]/y;
  re.lastIndex = 1;
  while (re.lastIndex < path.length) {
    const at = re.lastIndex;
    const m = re.exec(path);
    if (!m || m.index !== at) throw new Error(`unsupported JSON path: ${path}`);
    keys.push(m[1] ?? m[2] ?? m[3]!);
  }
  const elem = (k: string) => (/^[A-Za-z0-9_]+$/.test(k) ? k : `"${k.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`);
  return quote(`{${keys.map(elem).join(",")}}`);
}

/** The value at `path` as text (string fields). On SQLite this is `json_extract`, so a number field stays a number there. */
export function jsonText(d: D, expr: string, path: string): string {
  return pgOf(d) ? `((${expr})::json #>> ${pgPath(path)})` : `json_extract(${expr}, ${quote(path)})`;
}

/** The number at `path`. */
export function jsonNum(d: D, expr: string, path: string): string {
  return pgOf(d) ? `((${expr})::json #>> ${pgPath(path)})::numeric` : `json_extract(${expr}, ${quote(path)})`;
}

/** The boolean at `path` as 1/0 (what SQLite's json_extract gives for true/false); NULL when absent or not a boolean. */
export function jsonBool(d: D, expr: string, path: string): string {
  if (!pgOf(d)) return `json_extract(${expr}, ${quote(path)})`;
  return `(CASE (${expr})::json #>> ${pgPath(path)} WHEN 'true' THEN 1 WHEN 'false' THEN 0 END)`;
}

/**
 * SQLite's json_type names: 'null', 'true', 'false', 'integer', 'real', 'text', 'array', 'object'; NULL when the path
 * is absent. `path` defaults to the whole value.
 */
export function jsonType(d: D, expr: string, path?: string): string {
  if (!pgOf(d)) return path === undefined ? `json_type(${expr})` : `json_type(${expr}, ${quote(path)})`;
  const v = path === undefined ? `(${expr})::json` : `(${expr})::json #> ${pgPath(path)}`;
  return `(SELECT CASE json_typeof(v) WHEN 'string' THEN 'text' WHEN 'boolean' THEN v::text`
    + ` WHEN 'number' THEN CASE WHEN v::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE json_typeof(v) END`
    + ` FROM (SELECT ${v} AS v) AS jt)`;
}

/** Whether `expr` is valid JSON, as a predicate: use it bare (`WHERE ${jsonValid(...)}`), never compare it with 1. */
export function jsonValid(d: D, expr: string): string {
  return pgOf(d) ? `((${expr}) IS JSON)` : `json_valid(${expr})`;
}

/**
 * The JSON object `expr` without its top-level key `key`, as text. Postgres goes through jsonb, so the text may differ
 * from SQLite's in key order and spacing (the parsed value is the same); guard text that may not be valid JSON.
 */
export function jsonRemoveKey(d: D, expr: string, key: string): string {
  return pgOf(d) ? `((${expr})::jsonb - ${quote(key)})::text` : `json_remove(${expr}, ${quote(`$.${key}`)})`;
}

/**
 * A FROM item over the elements of the JSON array `expr`, named `alias`, with a `value` column (SQLite's json_each
 * columns otherwise differ). Elements that are objects or arrays come out as JSON text on both. Strings come out as
 * text; numbers are numbers on SQLite and text on Postgres unless `type` casts them. Arrays only: guard text that may
 * not be a JSON array (`CASE WHEN ${jsonValid(...)} THEN c ELSE '[]' END`); NULL gives no rows.
 */
export function jsonEach(d: D, expr: string, alias: string, type: ElemType = "text"): string {
  if (!pgOf(d)) return `json_each(${expr}) AS ${alias}`;
  const v = type === "text" ? "e" : `e::${type}`;
  return `LATERAL (SELECT ${v} AS value FROM json_array_elements_text((${expr})::json) AS e) AS ${alias}`;
}

/**
 * `INSERT ... ` that skips rows conflicting with a unique key. `rest` is everything after `INSERT INTO` (table,
 * columns, VALUES or SELECT); `returning` is an optional RETURNING list. On Postgres only unique conflicts are skipped:
 * a NOT NULL or CHECK failure still raises, where SQLite's OR IGNORE skips the row.
 */
export function insertIgnore(d: D, rest: string, returning?: string): string {
  const ret = returning ? ` RETURNING ${returning}` : "";
  // SQLite needs WHERE true before ON CONFLICT after a SELECT; OR IGNORE avoids that and keeps today's text.
  return pgOf(d) ? `INSERT INTO ${rest} ON CONFLICT DO NOTHING${ret}` : `INSERT OR IGNORE INTO ${rest}${ret}`;
}

export interface UpsertSpec {
  table: string;
  cols: readonly string[];
  /** The unique key the conflict is on. */
  key: readonly string[];
  /** Columns a conflict overwrites; default every column not in `key`. Empty: a conflict changes nothing. */
  update?: readonly string[];
  /** The row source; default `VALUES (?, ?, ...)`, one `?` per column. A SELECT needs a WHERE clause (SQLite parsing). */
  values?: string;
  returning?: string;
}

/**
 * `INSERT ... ON CONFLICT (key) DO UPDATE`, the same text on both. Use it for INSERT OR REPLACE: REPLACE deletes and
 * inserts (two trigger runs and a new rowid), this updates the row in place.
 */
export function upsert(_d: D, s: UpsertSpec): string {
  const update = s.update ?? s.cols.filter((c) => !s.key.includes(c));
  const values = s.values ?? `VALUES (${s.cols.map(() => "?").join(", ")})`;
  const action = update.length ? `DO UPDATE SET ${update.map((c) => `${c} = excluded.${c}`).join(", ")}` : "DO NOTHING";
  return `INSERT INTO ${s.table} (${s.cols.join(", ")}) ${values} ON CONFLICT (${s.key.join(", ")}) ${action}${s.returning ? ` RETURNING ${s.returning}` : ""}`;
}

/**
 * Case-insensitive equality (ASCII, as SQLite's NOCASE). Also for comparing a citext column with a text one on
 * Postgres, where `=` would pick text equality.
 */
export function ciEq(d: D, a: string, b: string): string {
  return pgOf(d) ? `(${a})::citext = (${b})::citext` : `${a} = ${b} COLLATE NOCASE`;
}

/**
 * Case-insensitive LIKE (SQLite's LIKE; ILIKE on Postgres). With no `escape`, a backslash is an ordinary character on
 * both (Postgres would treat it as the escape).
 */
export function like(d: D, a: string, pattern: string, escape?: string): string {
  const esc = ` ESCAPE ${quote(escape ?? "")}`;
  return pgOf(d) ? `${a} ILIKE ${pattern}${esc}` : `${a} LIKE ${pattern}${escape === undefined ? "" : esc}`;
}

/** An ORDER BY term with NULLs first. SQLite sorts NULLs first ascending and last descending, Postgres the reverse. */
export function nullsFirst(_d: D, expr: string, dir: "ASC" | "DESC" = "ASC"): string {
  return `${expr} ${dir} NULLS FIRST`;
}

/** An ORDER BY term with NULLs last. */
export function nullsLast(_d: D, expr: string, dir: "ASC" | "DESC" = "ASC"): string {
  return `${expr} ${dir} NULLS LAST`;
}

/** NULL-safe inequality (SQLite `a IS NOT b`). */
export function distinctFrom(_d: D, a: string, b: string): string {
  return `${a} IS DISTINCT FROM ${b}`;
}

/** NULL-safe equality (SQLite `a IS b`). */
export function notDistinctFrom(_d: D, a: string, b: string): string {
  return `${a} IS NOT DISTINCT FROM ${b}`;
}

/** Postgres GREATEST/LEAST skip NULLs; SQLite's scalar max/min give NULL when any argument is NULL. */
function extreme(d: D, fn: "max" | "min", args: string[]): string {
  if (args.length < 2) throw new Error(`${fn === "max" ? "greatest" : "least"} needs two or more arguments`);
  if (!pgOf(d)) return `${fn}(${args.join(", ")})`;
  return `(SELECT CASE WHEN count(*) = count(x) THEN ${fn}(x) END FROM (VALUES ${args.map((a) => `(${a})`).join(", ")}) AS g(x))`;
}

/** The largest argument, NULL when any is NULL (SQLite's scalar max). */
export const greatest = (d: D, ...args: string[]): string => extreme(d, "max", args);

/** The smallest argument, NULL when any is NULL (SQLite's scalar min). */
export const least = (d: D, ...args: string[]): string => extreme(d, "min", args);

/** Aggregate: the non-NULL values of `expr` as text joined by `sep`, in `orderBy` order (required: Postgres has no default order). */
export function groupConcat(d: D, expr: string, sep: string, orderBy: string): string {
  return pgOf(d) ? `string_agg((${expr})::text, ${quote(sep)} ORDER BY ${orderBy})` : `group_concat(${expr}, ${quote(sep)} ORDER BY ${orderBy})`;
}

/** The characters with these code points (SQLite `char(...)`). */
export function chr(d: D, ...codes: (number | string)[]): string {
  if (!codes.length) throw new Error("chr needs a code point");
  return pgOf(d) ? `(${codes.map((c) => `chr(${c})`).join(" || ")})` : `char(${codes.join(", ")})`;
}

/**
 * The current UTC time to bind as a parameter in place of SQLite's `strftime(..., 'now')`, in the same text form:
 * `2026-01-02T03:04:05.678Z` (`%fZ`), or without milliseconds for `seconds` (`%SZ`). `offsetMs` shifts it
 * (`'now', '-30 seconds'` → `-30_000`).
 */
export function nowParam(opts: { seconds?: boolean; offsetMs?: number; now?: number } = {}): string {
  const iso = new Date((opts.now ?? Date.now()) + (opts.offsetMs ?? 0)).toISOString();
  return opts.seconds ? `${iso.slice(0, 19)}Z` : iso;
}

let rowids: Map<string, string> | undefined;

/**
 * The column to use for `table`'s rowid on both dialects: its INTEGER PRIMARY KEY (on SQLite that is the rowid; on
 * Postgres the identity key), otherwise `rowid` (SQLite's own; on Postgres an identity column of that name). Throws for
 * a table with no rowid (WITHOUT ROWID, virtual) or an unknown one.
 */
export function rowidOf(table: string): string {
  if (!rowids) {
    rowids = new Map();
    const text = readFileSync(new URL("../schema.pg.sql", import.meta.url), "utf8");
    for (const m of text.matchAll(/^CREATE TABLE IF NOT EXISTS (\w+) \(\n([\s\S]*?)\n\);$/gm)) {
      const id = /^ {2}(\w+) bigint GENERATED BY DEFAULT AS IDENTITY/m.exec(m[2]!);
      if (id) rowids.set(m[1]!, id[1]!);
    }
  }
  const col = rowids.get(table);
  if (!col) throw new Error(`rowidOf: table ${table} has no rowid`);
  return col;
}

/** ` INDEXED BY index` after a table name on SQLite; nothing on Postgres, whose planner takes no index hints. */
export function indexedBy(d: D, index: string): string {
  return pgOf(d) ? "" : ` INDEXED BY ${index}`;
}

/** `expr` compared and sorted case-insensitively (ASCII, as SQLite's NOCASE), for ORDER BY and GROUP BY terms. */
export function nocase(d: D, expr: string): string {
  return pgOf(d) ? `(${expr})::citext` : `${expr} COLLATE NOCASE`;
}
