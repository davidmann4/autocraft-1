// Fixtures of the inference module's tests: a migrated database on each engine.
import { test } from "node:test";
import type { Db, Dialect } from "../../src/db/index.ts";
import { TEST_PG_URL, testDatabase, type TestDatabase } from "../test-db.ts";

export type Opened = { t: TestDatabase; db: Db };
export const dialects = (): Dialect[] => ["sqlite", ...(TEST_PG_URL ? ["postgres" as const] : [])];

export async function openApp(dialect: Dialect): Promise<Opened> {
  const t = await testDatabase("", dialect);
  return { t, db: await t.open({ app: true }) };
}

/** Runs `fn` on SQLite, and on Postgres when AUTOCRAFT_TEST_PG_URL names a server. */
export function both(name: string, fn: (o: Opened) => Promise<unknown>): void {
  for (const dialect of dialects()) {
    test(`${name} (${dialect})`, async () => {
      const o = await openApp(dialect);
      try { await fn(o); } finally { await o.t.close(); }
    });
  }
}

export const scrub = (s: string): string => s.replaceAll("SECRET", "[removed]");
export const openBoth = { jobId: null, stage: 1, promptId: "p.one", promptVersion: "v1", provider: "claude" as const, model: "opus" };
