// What opening a database takes from its process: the role of its handles, and the test hooks that redirect SQLite targets
// to Postgres and seed new SQLite databases. A module of its own, without the schema and data modules: the test preload loads it into every process of a
// test run, before the test sets the environment variables those modules read on import.
import type { DbRole } from "./index.ts";

let role: DbRole = "cli";
let redirect: ((sqliteTarget: string) => Promise<string>) | undefined;

/** Sets the role of this process's handles (pool size on Postgres). Called by long-running commands before they open one. */
export function setDbRole(r: DbRole): void {
  role = r;
}

export const dbRole = (): DbRole => role;

/**
 * Test hook: `connectDb` on a SQLite target opens the Postgres URL `map(target)` gives instead. test/pg-suite.ts installs
 * it to run the SQLite tests on Postgres; refused unless AUTOCRAFT_TEST_PG_URL is set.
 */
export function setTestDbRedirect(map: (sqliteTarget: string) => Promise<string>): void {
  if (!process.env.AUTOCRAFT_TEST_PG_URL) throw new Error("setTestDbRedirect is for tests on Postgres: AUTOCRAFT_TEST_PG_URL is not set");
  redirect = map;
}

export const testRedirect = (): typeof redirect => redirect;

/** A migrated, empty SQLite database that new test databases start from. */
export interface NewDbSeed {
  /** A file to copy, or undefined to open the new file as it is. */
  file(): string | undefined;
  /** The same database as bytes that an in-memory database can load (not in WAL mode). */
  bytes(): Uint8Array | undefined;
}

let seed: NewDbSeed | undefined;

/**
 * Test hook: a SQLite file that does not exist yet, and `:memory:`, start as a copy of `s` (a database migrated to the
 * current schema), so opening one takes the up-to-date path instead of migrating from nothing. Files that exist open as
 * they are.
 */
export function setNewDbSeed(s: NewDbSeed | undefined): void {
  seed = s;
}

export const newDbSeed = (): NewDbSeed | undefined => seed;
