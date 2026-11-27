// Shared setup of the jobs module tests: an app database per dialect, a `both()` runner and job seeding.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db, Dialect } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import type { FlatUnit } from "../helpers/query-count.ts";
import { TEST_PG_URL, testDatabase } from "../test-db.ts";

export async function withDb<T>(dialect: Dialect, fn: (db: Db) => Promise<T>): Promise<T> {
  const t = await testDatabase("", dialect);
  try {
    return await fn(await t.open({ app: true }));
  } finally {
    await t.close();
  }
}

/** Runs `fn` on SQLite, then on Postgres when a server is configured; the results must be equal. */
export function both(name: string, fn: (db: Db) => Promise<unknown>): void {
  test(name, async () => {
    const lite = await withDb("sqlite", fn);
    if (TEST_PG_URL) assert.deepEqual(await withDb("postgres", fn), lite);
  });
}

/** A `FlatUnit` factory on SQLite (and Postgres when configured is covered by running the same body in `both`). */
export function flat(setup: (db: Db, size: number) => Promise<() => Promise<unknown>>): (size: number) => Promise<FlatUnit> {
  return async (size) => {
    const t = await testDatabase("", TEST_PG_URL ? "postgres" : "sqlite");
    const db = await t.open({ app: true });
    const run = await setup(db, size);
    return { db, run, close: () => t.close() };
  };
}

let seeded = 0;
type Seed = { step?: string; state?: string; repo?: string | null; params?: Record<string, unknown>; requested_by?: string; resumes?: number; items?: number | null; started_at?: string | null; ended_at?: string | null; error?: string | null };

/** Inserts job rows directly; returns their ids. */
export async function seedJobs(db: Db, rows: Seed[]): Promise<number[]> {
  const q = queryDb(db);
  const ids: number[] = [];
  for (const r of rows) {
    const t = new Date(Date.UTC(2026, 0, 1, 0, 0, seeded++)).toISOString();
    ids.push((await q.get(q.k.insertInto("jobs").values({
      step: r.step ?? "review", params: JSON.stringify(r.params ?? (r.repo ? { repo: r.repo } : {})), repo: r.repo ?? null, requested_by: r.requested_by ?? "pipeline", requested_at: t,
      state: r.state ?? "queued", resumes: r.resumes ?? 0, items: r.items ?? null, started_at: r.started_at === undefined ? (r.state && r.state !== "queued" ? t : null) : r.started_at,
      ended_at: r.ended_at === undefined ? (["done", "failed", "cancelled"].includes(r.state ?? "") ? t : null) : r.ended_at, error: r.error ?? null,
    }).returning("id")))!.id);
  }
  return ids;
}
