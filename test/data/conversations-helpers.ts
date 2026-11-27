// Fixtures of the conversations module's tests: a migrated database on each engine and rows seeded through the module's own writers.
import { test } from "node:test";
import type { Db, Dialect } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import { saveConversations, addTurns } from "../../src/data/conversations/index.ts";
import type { FlatUnit } from "../helpers/query-count.ts";
import { TEST_PG_URL, testDatabase, type TestDatabase } from "../test-db.ts";

export type Opened = { t: TestDatabase; db: Db };

export async function openApp(dialect: Dialect): Promise<Opened> {
  const t = await testDatabase("", dialect);
  const db = await t.open({ app: true });
  await addHeldColumns(db);
  return { t, db };
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

/** A fresh database per size, seeded by `seed`, for `expectFlat`. */
export const flat = (dialect: Dialect, seed: (db: Db, size: number) => Promise<() => Promise<unknown>>) => async (size: number): Promise<FlatUnit> => {
  const { t, db } = await openApp(dialect);
  const run = await seed(db, size);
  return { db, run, close: async () => await t.close() };
};

export const dialects = (): Dialect[] => ["sqlite", ...(TEST_PG_URL ? ["postgres"] : [])] as Dialect[];

/** The held-follow-up columns of the new schema (workflow binding), until the schema generation adds them. */
async function addHeldColumns(db: Db): Promise<void> {
  const q = queryDb(db);
  for (const col of ["workflow_id INTEGER", "approved_at TEXT"]) {
    try { await q.script(`ALTER TABLE main.held_followups ADD COLUMN ${col}`); } catch { /* present */ }
  }
}

export const AT = "2026-01-01T00:00:00.000Z";
export const conv = (repo: string, number: number, sig = JSON.stringify({ head: "h1", last_comment: null })) => ({ repo, number, item_block: "{}", item_sig: sig, created_by: "op", created_at: AT });

export const sys = (ref: string, body: string, extra: object = {}) => ({ ref, kind: "system" as const, login: "system", body, block: `<turn from="system">\n${body}\n</turn>\n`, ...extra });
export const person = (ref: string, body: string, kind: "operator" | "maintainer" = "operator", extra: object = {}) => ({ ref, kind, login: kind === "operator" ? "op" : "mt", body, block: `<turn from="${kind}">\n${body}\n</turn>\n`, ...extra });

/** Items with a conversation each, one system turn on every item. */
export async function seedThreads(db: Db, refs: string[]): Promise<void> {
  await saveConversations(db, refs.map((r) => conv(r.slice(0, r.lastIndexOf("#")), Number(r.slice(r.lastIndexOf("#") + 1)))));
  await addTurns(db, refs.map((r) => sys(r, "hello")));
}
