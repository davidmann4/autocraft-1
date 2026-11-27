// Fixtures of the planner module's tests: a migrated database on each engine, and rows seeded the way the app writes them.
import { test } from "node:test";
import type { Db, Dialect } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import type { PlanRow } from "../../src/data/planner/index.ts";
import { TEST_PG_URL, testDatabase, type TestDatabase } from "../test-db.ts";

export type Opened = { t: TestDatabase; db: Db };

export async function openApp(dialect: Dialect): Promise<Opened> {
  const t = await testDatabase("", dialect);
  return { t, db: await t.open({ app: true }) };
}

/** Runs `fn` on SQLite, and on Postgres when AUTOCRAFT_TEST_PG_URL names a server. */
export function both(name: string, fn: (o: Opened) => Promise<unknown>): void {
  for (const dialect of ["sqlite", ...(TEST_PG_URL ? ["postgres"] : [])] as Dialect[]) {
    test(`${name} (${dialect})`, async () => {
      const o = await openApp(dialect);
      try { await fn(o); } finally { await o.t.close(); }
    });
  }
}

export async function seedPrs(db: Db, repos: string[], perRepo: number): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.tracked_repos").values(repos.map((name) => ({ name }))));
  const rows = repos.flatMap((repo) => Array.from({ length: perRepo }, (_, i) => ({ repo, number: i + 1, kind: "pr", state: "OPEN" })));
  await q.run(q.k.insertInto("main.items").values(rows));
}

export const AT = "2026-01-01T00:00:00.000Z";

/** A plan row with the view's status, as `planRows` builds it. */
export function planRow(repo: string, number: number, o: { state?: string; wait?: string | null; phase?: string; since?: string } = {}): PlanRow {
  const wait = o.wait ?? null;
  return {
    repo, number, kind: "pr", head: "abc", state: o.state ?? "ready", item_state: null, actions: "[]", wait, reasons: "[]", note: null,
    view: JSON.stringify({ gh: "OPEN", status: { phase: o.phase ?? "Review", waiting: wait, next: null, since: o.since ?? AT } }),
  };
}
