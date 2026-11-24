// Applies src/schema.pg.sql to a Postgres database under a transaction-scoped advisory lock, so two processes opening
// the database at once cannot migrate it at the same time: the second waits for the first to commit, then applies the
// (idempotent) schema again, which changes nothing.
import { readFileSync } from "node:fs";

/** One connection (a pg Client or a pool's checked-out client): the lock and the statements must share it. */
export interface PgQueryable {
  query(text: string): Promise<unknown>;
}

/** The advisory lock key every AutoCraft schema migration takes: "autocraf" in ASCII as a 64-bit integer. */
export const MIGRATION_LOCK_KEY = 0x6175746f63726166n;

export const pgSchemaSql = (): string => readFileSync(new URL("../schema.pg.sql", import.meta.url), "utf8");

/** The stamp in the schema file's header (it covers the dialect and the whole file body). */
export function pgSchemaStamp(sql: string = pgSchemaSql()): string {
  const m = /^-- dialect: postgres; stamp: ([0-9a-f]{16})$/m.exec(sql);
  if (!m) throw new Error("src/schema.pg.sql has no stamp line");
  return m[1]!;
}

/** SQLSTATE codes worth retrying: deadlock_detected and lock_not_available (lock_timeout expired). */
const RETRYABLE_CODES = new Set(["40P01", "55P03"]);
const MIGRATION_RETRY_DELAYS_MS = [2000, 4000, 8000, 16000];

export interface MigrationLockOpts {
  /** Replaced in tests so retries do not wait. */
  sleep?: (ms: number) => Promise<void>;
}

async function lockedAttempt<T>(client: PgQueryable, fn: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
    // DDL queues behind running queries of older processes during a rolling deploy; give up and retry rather than deadlock or hang.
    await client.query("SET LOCAL lock_timeout = '15s'");
    const out = await fn();
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

/**
 * Runs `fn` in one transaction that holds the migration lock; rolls back if it throws. A deadlock or lock timeout against
 * another process's queries restarts the whole transaction (up to 5 attempts, 2 s to 16 s apart); `fn` must therefore
 * recheck its own preconditions.
 */
export async function withMigrationLock<T>(client: PgQueryable, fn: () => Promise<T>, opts: MigrationLockOpts = {}): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await lockedAttempt(client, fn);
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      const delay = MIGRATION_RETRY_DELAYS_MS[attempt - 1];
      if (typeof code !== "string" || !RETRYABLE_CODES.has(code) || delay === undefined) throw e;
      console.warn(`schema migration attempt ${attempt} failed (${code}); retrying in ${delay / 1000}s`);
      await sleep(delay);
    }
  }
}

/**
 * Applies the schema under the migration lock. `then` runs in the same transaction after it (triggers generated at
 * runtime, value migrations, writing the stored stamp), so a concurrent opener sees all of it or none. `unless` runs first
 * under the lock: true skips everything (another opener migrated while this one waited). `before` runs just before the
 * schema.
 */
export async function applyPgSchema(client: PgQueryable, then?: () => Promise<void>, opts: { unless?: () => Promise<boolean>; before?: () => Promise<void> } & MigrationLockOpts = {}): Promise<void> {
  await withMigrationLock(client, async () => {
    if (await opts.unless?.()) return;
    await opts.before?.();
    // ADD COLUMN IF NOT EXISTS and friends report every skipped object as a notice.
    await client.query("SET LOCAL client_min_messages = warning");
    await client.query(pgSchemaSql());
    await then?.();
  }, opts);
}
