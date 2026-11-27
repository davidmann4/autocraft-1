/**
 * The SQLite test suite on Postgres (`pnpm test:pg:suite`). test/suite-preload.ts calls `install()` in every process
 * when AUTOCRAFT_TEST_PG_URL is set; from then on `connectDb(<SQLite path or :memory:>)` opens a Postgres database:
 *
 * - The same resolved path gives the same database, so a test that reopens a file (or a child process given the path
 *   in AUTOCRAFT_DB) sees its data. `:memory:` always gives a new one.
 * - Each database is a copy of a template migrated to the app schema and triggers once per server and schema stamp
 *   (`t_tmpl_<stamp>`), so opening one costs a CREATE DATABASE, not a migration. The copy is of files (STRATEGY
 *   FILE_COPY), about a third of the cost of the default copy through the WAL.
 * - Names are `t_<run>_<key>`: the first process that opens one sets AUTOCRAFT_TEST_PG_RUN, children it spawns inherit
 *   it and share its databases, and that process drops all of the run's databases when its event loop empties.
 * - The process's database role becomes "dashboard" (8 connections per handle), not the CLI's single connection.
 *
 * Tests that need SQLite itself skip here with `sqliteOnly(reason)` from test/test-db.ts. Code that opens SQLite without
 * connectDb (`connect()`, `new DatabaseSync`, `dbFor`) still gets SQLite.
 */
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { setDbRole, setTestDbRedirect } from "../src/db/role.ts";

const SERVER = process.env.AUTOCRAFT_TEST_PG_URL || undefined;

/** Whether this process runs the suite on Postgres. */
export let pgSuite = false;

/** A session-scoped advisory lock key for building the template ("actmpl"). */
const TEMPLATE_LOCK = 0x6163746d706c;

const urlOf = (name: string): string => {
  const u = new URL(SERVER!);
  u.pathname = `/${name}`;
  return u.toString();
};

async function withClient<T>(url: string, fn: (c: import("pg").Client) => Promise<T>): Promise<T> {
  const pg = (await import("pg")).default;
  const c = new pg.Client({ connectionString: url, application_name: "autocraft-test-suite" });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

let template: Promise<string> | undefined;

/** The migrated template database's name, built under a lock by the first process that needs it. */
function templateDb(): Promise<string> {
  return (template ??= (async () => {
    // Loaded with the first database: this module is in every process of the run, and the schema modules read environment
    // variables on import that a test file sets first, and take a second to load in a process that opens no database.
    const { migratePg, pgStamp } = await import("../src/db/pg-triggers.ts");
    const name = `t_tmpl_${pgStamp()}`;
    await withClient(SERVER!, async (c) => {
      await c.query(`SELECT pg_advisory_lock(${TEMPLATE_LOCK})`);
      try {
        if ((await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rowCount) return;
        const build = `${name}_build`;
        await c.query(`DROP DATABASE IF EXISTS ${build} WITH (FORCE)`);
        await c.query(`CREATE DATABASE ${build}`);
        await withClient(urlOf(build), (b) => migratePg(b));
        // The rename publishes it: other processes see either no template or a complete one.
        await c.query(`ALTER DATABASE ${build} RENAME TO ${name}`);
      } finally {
        await c.query(`SELECT pg_advisory_unlock(${TEMPLATE_LOCK})`);
      }
    });
    return name;
  })());
}

/** Creates the database `name` on the test server as a copy of the migrated template. */
export async function createFromTemplate(name: string): Promise<void> {
  const tmpl = await templateDb();
  await withClient(SERVER!, (c) => c.query(`CREATE DATABASE ${name} TEMPLATE ${tmpl} STRATEGY FILE_COPY`));
}

let run = process.env.AUTOCRAFT_TEST_PG_RUN;
let owner = false;
let memory = 0;
const created = new Map<string, Promise<string>>();

function runId(): string {
  if (!run) {
    run = `${process.pid.toString(36)}${randomBytes(2).toString("hex")}`;
    process.env.AUTOCRAFT_TEST_PG_RUN = run;
    owner = true;
    process.on("beforeExit", dropRun);
  }
  return run;
}

/** The Postgres URL for a SQLite target. */
async function redirect(target: string): Promise<string> {
  const key = target === ":memory:" || target === "" ? `m${process.pid.toString(36)}_${memory++}` : createHash("sha256").update(resolve(target)).digest("hex").slice(0, 16);
  const name = `t_${runId()}_${key}`;
  let url = created.get(name);
  if (!url) {
    created.set(name, (url = (async () => {
      await createFromTemplate(name).catch((e) => {
        // Another process of the run (a child given the same path) created it first.
        if ((e as { code?: string }).code !== "42P04") throw e;
      });
      return urlOf(name);
    })()));
    void url.catch(() => created.delete(name));
  }
  return url;
}

let dropping = false;

async function dropRun(): Promise<void> {
  if (dropping || !owner) return;
  dropping = true;
  await withClient(SERVER!, async (c) => {
    // All at once: DROP DATABASE ... FORCE waits 100 ms for the connections of each database in turn.
    await c.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE starts_with(datname, $1)", [`t_${run}_`]);
    const rows = (await c.query("SELECT datname FROM pg_database WHERE starts_with(datname, $1)", [`t_${run}_`])).rows as { datname: string }[];
    for (const r of rows) await c.query(`DROP DATABASE IF EXISTS ${r.datname} WITH (FORCE)`);
  });
}

export function install(): void {
  if (!SERVER || pgSuite) return;
  pgSuite = true;
  setDbRole("dashboard");
  setTestDbRedirect(redirect);
}
