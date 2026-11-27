// Test files that open no database (test/no-database.txt, one path from test/ per line): the Postgres suite leaves them to the
// SQLite suite, since they would run the same code twice. In a suite, a listed file that opens a database fails.
import { existsSync, readFileSync } from "node:fs";
import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";
import { join, relative } from "node:path";

const TEST_DIR = import.meta.dirname;

/** The listed files, as paths from the repository root. */
export function noDatabaseFiles(): string[] {
  const files = readFileSync(join(TEST_DIR, "no-database.txt"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const missing = files.filter((f) => !existsSync(join(TEST_DIR, f)));
  if (missing.length) throw new Error(`test/no-database.txt names files that do not exist: ${missing.join(", ")}`);
  return files.map((f) => `test/${f}`);
}

/** In the process of a listed file, and the Node processes it spawns with the preload: opening a database throws, and the process fails even if that is caught. */
export function guardNoDatabase(): void {
  const inherited = process.env.AUTOCRAFT_TEST_NO_DATABASE;
  const main = inherited ?? (process.argv[1] ? relative(join(TEST_DIR, ".."), process.argv[1]) : "");
  if (!inherited && !(main.endsWith(".test.ts") && noDatabaseFiles().includes(main))) return;
  if (!inherited) {
    process.env.AUTOCRAFT_TEST_NO_DATABASE = main;
    const preload = `--import=${join(TEST_DIR, "suite-preload.ts")}`;
    if (!process.env.NODE_OPTIONS?.includes(preload)) process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, preload].filter(Boolean).join(" ");
  }
  let opened = false;
  const refuse = (what: string): never => {
    opened = true;
    throw new Error(`${main} is listed in test/no-database.txt and opens ${what}: take it off the list`);
  };
  const sqlite = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: unknown };
  sqlite.DatabaseSync = class {
    constructor() {
      refuse("a SQLite database");
    }
  };
  syncBuiltinESMExports();
  registerHooks({ resolve: (spec, ctx, next) => (spec === "pg" ? refuse("a Postgres database") : next(spec, ctx)) });
  process.on("exit", () => {
    if (!opened) return;
    console.error(`${main} opened a database`);
    process.exitCode = 1;
  });
}
