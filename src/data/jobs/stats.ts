// Query-count records (M07 jobs).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import type { StatRow, StepQueryStat } from "./types.ts";

/** `INSERT ... ON CONFLICT (scope, minute) DO UPDATE` adding to the counters; the runner flushes once a minute, unmetered. Rows of one scope and minute are added up first. */
export async function addStats(db: Db, rows: StatRow[]): Promise<void> {
  if (!rows.length) return;
  const q = queryDb(db);
  const merged = new Map<string, StatRow>();
  for (const r of rows) {
    const k = `${r.scope}\0${r.minute}`, m = merged.get(k);
    if (m) { m.statements += r.statements; m.round_trips += r.round_trips; m.ms += r.ms; m.calls += r.calls; } else merged.set(k, { ...r });
  }
  const parts = kx.batches([...merged.values()]);
  const write = async () => {
    for (const part of parts) {
      await q.run(q.k.insertInto("db_stats").values(part).onConflict((oc) => oc.columns(["scope", "minute"]).doUpdateSet((eb) => ({
        statements: eb("db_stats.statements", "+", eb.ref("excluded.statements")), round_trips: eb("db_stats.round_trips", "+", eb.ref("excluded.round_trips")),
        ms: eb("db_stats.ms", "+", eb.ref("excluded.ms")), calls: eb("db_stats.calls", "+", eb.ref("excluded.calls")),
      }))));
    }
  };
  if (parts.length === 1) await write(); else await db.write(write);
}

/** Jobs with a query count started in the last `sinceDays` days, oldest first; for the `query-growth` health check. */
export async function loadStepQueryStats(db: Db, sinceDays: number): Promise<StepQueryStat[]> {
  const q = queryDb(db);
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const rows = await q.all(q.k.selectFrom("jobs").select(["id", "step", "items", "effects", "db_statements", "db_round_trips", "db_ms", "started_at"])
    .where("started_at", ">=", since).where("db_statements", "is not", null).where("state", "in", ["done", "failed"]).orderBy("id"));
  return rows.map((r) => ({ step: r.step, items: Number(r.items ?? 0), effects: Number(r.effects ?? 0), statements: Number(r.db_statements), round_trips: Number(r.db_round_trips ?? 0), ms: Number(r.db_ms ?? 0), started_at: r.started_at! }));
}

/** Deletes records older than the keep window. */
export async function pruneStats(db: Db, before: string): Promise<number> {
  const q = queryDb(db);
  return (await q.run(q.k.deleteFrom("db_stats").where("minute", "<", before))).changes;
}
