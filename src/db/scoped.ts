// Scoped handles: the dashboard and the runner see tracked repos only. Views with the names of the mirror and work tables
// shadow them, filtered to the repos in tracked_repos; rows of untracked repos stay in the database. Code that must see
// everything, and every write to a shadowed table, names the table with `main.`.
//
// - SQLite: TEMP views on the handle's connection (`sqliteScopeSql`).
// - Postgres: permanent views in schema `scoped`, kept current by migratePg (`pgScopeViews`). A scoped handle connects with
//   `search_path=scoped,<app schema>`, so unqualified names find the views first, and its statements turn `main.x` into
//   `<app schema>.x` (src/db/params.ts rewriteForPostgres).
import { jsonEach, jsonText } from "./portable.ts";
import type { Dialect } from "./index.ts";

/** The schema of the Postgres views. */
export const SCOPED_SCHEMA = "scoped";

const TRACKED = "IN (SELECT name FROM main.tracked_repos)";

/** Each shadowed table and the condition its view keeps rows by. */
function views(d: Dialect): [string, string][] {
  const byRepo = (col: string): string => `${col} ${TRACKED}`;
  // A batch (repo NULL) is hidden when any of its items is in an untracked repo.
  const items = d === "postgres" ? "CASE WHEN items IS JSON ARRAY THEN items ELSE '[]' END" : "CASE WHEN json_valid(items) THEN items ELSE '[]' END";
  const batch = `repo IS NULL AND NOT EXISTS (SELECT 1 FROM ${jsonEach(d, items, "j")} WHERE ${jsonText(d, "j.value", "$.repo")} NOT ${TRACKED})`;
  return [
    ["repos", byRepo("name")],
    ["items", byRepo("repo")],
    ["comments", byRepo("repo")],
    ["stages", byRepo("repo")],
    ["classifications", byRepo("repo")],
    ["decisions", `${byRepo("repo")} OR (${batch})`],
    ["token_usage", `repo IS NULL OR ${byRepo("repo")}`],
  ];
}

/** Every table name a scoped handle shadows with a view; writes to them go through `main.`. */
export const SHADOWED_TABLES: readonly string[] = views("sqlite").map(([t]) => t);

/** The TEMP views that scope a SQLite connection. They carry rowid explicitly because queries order by it. */
export function sqliteScopeSql(): string {
  return views("sqlite").map(([t, where]) => `CREATE TEMP VIEW IF NOT EXISTS ${t} AS SELECT rowid AS rowid, * FROM main.${t} WHERE ${where};`).join("\n");
}

/** A schema name that needs no quoting: it goes into a connection's startup options and into statement text. */
export function plainSchema(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`db: schema name ${JSON.stringify(name)} is not a plain lowercase identifier`);
  return name;
}

/**
 * The Postgres views over the tables of `schema` (the app schema), each replaced in place so it picks up added columns
 * (`*` is expanded when a view is created). The tables carry rowid as a column there, so `*` includes it.
 */
export function pgScopeViews(schema: string): { view: string; sql: string }[] {
  const app = plainSchema(schema);
  return views("postgres").map(([t, where]) => ({
    view: `${SCOPED_SCHEMA}.${t}`,
    sql: `CREATE OR REPLACE VIEW ${SCOPED_SCHEMA}.${t} AS SELECT * FROM ${app}.${t} WHERE ${where.replaceAll("main.", `${app}.`)}`,
  }));
}
