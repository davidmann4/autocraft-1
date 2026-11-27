// Raw SQL in src/: app code builds queries with Kysely (`db.k`) and the typed helpers in src/db/kx.ts, so a query that
// passes on SQLite runs the same code on Postgres. test/no-raw-sql.test.ts fails on raw SQL outside the files below.
//
//   node scripts/raw-sql.ts           lists every file with raw SQL outside PERMANENT and how many uses it has
//   node scripts/raw-sql.ts --write   writes that list to test/raw-sql-not-converted.txt
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/**
 * Where raw SQL stays: the database layer, the SQLite migrations, and code on other SQLite files (the item tools snapshot,
 * which is built by ATTACHing the app database, and the reference corpus). A path ending in `/` covers its directory.
 */
export const PERMANENT: readonly string[] = [
  "src/db/",
  "src/db.ts",
  "src/data/views/snapshot.ts",
  "src/itemtools/server/tools.ts",
  "src/data/external/",
];

export const TODO_FILE = join(ROOT, "test/raw-sql-not-converted.txt");

// Statement text, Kysely's raw `sql` tag (with type arguments nested up to three deep), an import that renames the tag,
// CompiledQuery.raw, and DatabaseSync's exec with literal SQL text (not a command's name such as `d.exec("gh", ...)`).
const USE = /\.prepare\(|\.script\(|\bsql(?:<(?:[^<>\n]|<(?:[^<>\n]|<[^<>\n]*>)*>)*>)?`|\bsql\.(?:raw|lit)\(|\bimport\s*\{[^}]*\bsql\s+as\s+\w+[^}]*\}\s*from\s*["']kysely["']|\bCompiledQuery\.raw\(|\.exec\(\s*[`"']/g;
// SQLite maintenance that has no builder form and runs on SQLite only: PRAGMA, ATTACH/DETACH, and reads of sqlite_master.
const SQL_START = /^\s*(?:select|insert|update|delete|replace|with|create|drop|alter|pragma|attach|detach|begin|commit|rollback|savepoint|release|vacuum|analyze|reindex|explain)\b/i;
const MAINTENANCE = /^\s*[`"'](?:PRAGMA|ATTACH|DETACH)\b|^\s*[`"']\s*SELECT\b[^;]*?\bFROM\s+(?:main\.)?sqlite_master\b/;

/** The raw SQL uses in `text` (comment lines skipped), each as its 1-based line number. */
export function rawSqlUses(text: string): number[] {
  const code = text.replace(/^[ \t]*(\/\/|\*|\/\*).*$/gm, "");
  const out: number[] = [];
  for (const m of code.matchAll(USE)) {
    const after = code.slice(m.index + m[0].length, m.index + m[0].length + 200);
    if (m[0].startsWith(".exec(") && !SQL_START.test(after)) continue;
    if (m[0].startsWith(".prepare(") || m[0].startsWith(".exec(")) {
      const arg = m[0].startsWith(".exec(") ? m[0].slice(5) + after : after;
      if (MAINTENANCE.test(arg.split("\n").slice(0, 2).join(" "))) continue;
    }
    out.push(code.slice(0, m.index).split("\n").length);
  }
  return out;
}

export const permanent = (file: string): boolean => PERMANENT.some((p) => (p.endsWith("/") ? file.startsWith(p) : file === p));

function* tsFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* tsFiles(p);
    else if (/\.tsx?$/.test(e.name)) yield relative(ROOT, p);
  }
}

/** Every file in src/ outside PERMANENT with raw SQL, and its uses' line numbers. */
export function rawSqlFiles(): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const f of [...tsFiles(join(ROOT, "src"))].sort()) {
    if (permanent(f)) continue;
    const uses = rawSqlUses(readFileSync(join(ROOT, f), "utf8"));
    if (uses.length) out.set(f, uses);
  }
  return out;
}

/** The files listed in test/raw-sql-not-converted.txt. */
export function notYetConverted(): string[] {
  return readFileSync(TODO_FILE, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

if (import.meta.main) {
  const files = rawSqlFiles();
  if (process.argv.includes("--write")) {
    // One file per line with a blank line between, so branches that each delete their own line merge without conflicts.
    const head = [
      "# Files in src/ that still have raw SQL (scripts/raw-sql.ts --write). Delete a file's line when its queries use",
      "# db.k and src/db/kx.ts; test/no-raw-sql.test.ts fails while a listed file has none left, and on raw SQL in a file",
      "# not listed. Keep the blank lines: they let branches that delete different lines merge cleanly.",
    ];
    writeFileSync(TODO_FILE, `${head.join("\n")}\n\n${[...files.keys()].join("\n\n")}\n`);
  } else for (const [f, uses] of files) console.log(`${String(uses.length).padStart(4)} ${f}`);
  console.error(`${files.size} files, ${[...files.values()].reduce((n, u) => n + u.length, 0)} uses`);
}
