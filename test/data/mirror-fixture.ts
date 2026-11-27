// Shared setup of the mirror data-layer tests: a database with the app schema on SQLite, and on Postgres too when AUTOCRAFT_TEST_PG_URL names a server.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Dialect } from "../../src/db/index.ts";
import type { Db } from "../helpers/raw-db.ts";
import type { FlatUnit } from "../helpers/query-count.ts";
import { expectFlat } from "../helpers/query-count.ts";
import { TEST_PG_URL, testDatabase } from "../test-db.ts";
import type { ItemEntry, ItemRowInput } from "../../src/data/mirror/index.ts";
import * as kx from "../../src/db/kx.ts";

export async function withDb<T>(dialect: Dialect, fn: (db: Db) => Promise<T>): Promise<T> {
  const t = await testDatabase("", dialect);
  try {
    return await fn(await t.open({ app: true }));
  } finally {
    await t.close();
  }
}


/** Runs `fn` on SQLite, then on Postgres when configured; `fn` asserts, and its result on Postgres must equal SQLite's. */
export function both(name: string, fn: (db: Db) => Promise<unknown>): void {
  test(name, async () => {
    const lite = await withDb("sqlite", fn);
    if (TEST_PG_URL) assert.deepEqual(await withDb("postgres", fn), lite);
  });
}

/** `expectFlat` on both engines: a fresh database per size, seeded by `seed` with `size` items before the meter starts. */
export function bothFlat(name: string, seed: (db: Db, size: number) => Promise<void>, run: (db: Db, size: number) => Promise<unknown>): void {
  test(name, async () => {
    for (const dialect of TEST_PG_URL ? (["sqlite", "postgres"] as const) : (["sqlite"] as const)) {
      await expectFlat(async (size): Promise<FlatUnit> => {
        const t = await testDatabase("", dialect);
        const db = await t.open({ app: true });
        await seed(db, size);
        return { db, run: () => run(db, size), close: () => t.close() };
      }, 2, 12);
    }
  });
}

type Seed = Partial<Record<string, string | number | null>>;

/** An `items` row with the columns a test sets; the rest stay null. */
export const itemRow = (repo: string, number: number, o: Seed = {}): ItemRowInput => ({
  ...Object.fromEntries(kx.cols("items").filter((c) => c !== "jev_failed_hash").map((c) => [c, null])),
  repo, number, kind: "pr", state: "OPEN", title: `title ${number}`, body: `body ${number}`, ...o,
}) as unknown as ItemRowInput;

export const entry = (repo: string, number: number, o: Seed = {}, extra: Partial<ItemEntry> = {}): ItemEntry =>
  ({ repo, kind: (o.kind as "pr" | "issue" | undefined) ?? "pr", detail: "full", row: itemRow(repo, number, o), comments: [], ...extra });

export async function seedItems(db: Db, repo: string, numbers: number[], o: Seed = {}): Promise<void> {
  if (!numbers.length) return;
  await db.write(async () => { await db.run(db.k.insertInto("main.items").values(numbers.map((n) => itemRow(repo, n, o)) as never)); });
}

export const comment = (repo: string, number: number, id: string, o: Record<string, string | number | null> = {}) =>
  ({ repo, number, id, kind: "comment", author: "alice", created_at: "2026-01-01T00:00:00Z", body: `text ${id}`, review_state: null, commit_oid: null, counted: 1, author_association: null, mentions_pipeline: 0, url: null, ...o });
