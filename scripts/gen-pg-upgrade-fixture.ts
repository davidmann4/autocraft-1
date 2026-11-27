// Writes test/fixtures/pg-upgrade.sql.gz: the whole Postgres schema of an earlier commit (tables, trigger functions, triggers,
// scoped views and the schema stamp), for the upgrade test (test/pg-upgrade.test.ts).
//
//   node scripts/gen-pg-upgrade-fixture.ts <commit>
//
// It runs that commit's own schema code on a copy of its source. The columns the triggers watch come from its SQLite schema,
// which names the same columns.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));
const git = (...args: string[]): Buffer => execFileSync("git", args, { cwd: root, maxBuffer: 1 << 28 });

const DRIVER = `
import { connect } from "./src/db.ts";
import { PIN_SEARCH_PATH, pgSchemaSql } from "./src/db/pg-migrate.ts";
import { PG_SCHEMA_GENERATION } from "./src/db/pg-generation.ts";
import { pgStamp, pgTriggerParts } from "./src/db/pg-triggers.ts";
import { pgScopeViews, SCOPED_SCHEMA } from "./src/db/scoped.ts";
const db = connect(":memory:");
const columns = new Map(db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table'").all()
  .map((t) => [t.name, db.prepare("SELECT name FROM pragma_table_info(?)").all(t.name).map((c) => c.name)]));
const p = pgTriggerParts(columns);
process.stdout.write([
  "-- The Postgres schema of COMMIT, written by scripts/gen-pg-upgrade-fixture.ts. Do not edit.",
  pgSchemaSql(), p.ddl, ...p.functions, ...[...p.triggers.values()].flat().map((t) => t.sql), p.flush, PIN_SEARCH_PATH + ";",
  "CREATE SCHEMA IF NOT EXISTS " + SCOPED_SCHEMA + ";", ...pgScopeViews("public").map((v) => v.sql + ";"),
  "INSERT INTO settings (key, value) VALUES ('schema_stamp', '" + pgStamp() + "'), ('schema_generation', '" + PG_SCHEMA_GENERATION.generation + "');",
].join("\\n"));
`;

const ref = process.argv[2];
if (!ref) throw new Error("usage: node scripts/gen-pg-upgrade-fixture.ts <commit>");
const commit = git("rev-parse", "--short=12", `${ref}^{commit}`).toString().trim();
const dir = mkdtempSync(join(tmpdir(), "pg-upgrade-"));
try {
  execFileSync("tar", ["-x", "-C", dir], { input: git("archive", commit, "src", "package.json") });
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
  writeFileSync(join(dir, "driver.ts"), DRIVER.replace("COMMIT", commit));
  const sql = execFileSync(process.execPath, ["--no-warnings", "driver.ts"], { cwd: dir, maxBuffer: 1 << 28 });
  const gz = gzipSync(sql, { level: 9 });
  writeFileSync(join(root, "test/fixtures/pg-upgrade.sql.gz"), gz);
  console.log(`test/fixtures/pg-upgrade.sql.gz: ${sql.length} bytes of SQL from ${commit}, ${gz.length} compressed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
