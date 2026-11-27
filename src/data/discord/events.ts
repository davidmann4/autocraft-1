// Usage counters (`discord_events`).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { EVENT_KINDS, type EventCounts, type EventKind } from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Inserts events. */
export async function addEvents(db: Db, rows: { kind: EventKind; atIso: string }[]): Promise<void> {
  const q = queryDb(db);
  for (const part of kx.batches(rows)) await q.run(q.k.insertInto("main.discord_events").values(part.map((r) => ({ kind: r.kind, at: r.atIso }))));
}

/** Deletes events before a time; called at bot start and by the hourly status tick. */
export async function pruneEvents(db: Db, beforeIso: string): Promise<number> {
  const q = queryDb(db);
  return Number((await q.run(q.k.deleteFrom("main.discord_events").where("at", "<", beforeIso))).changes);
}

/** Counts per kind over the last 24 hours and 7 days in one grouped statement. */
export async function countEvents(db: Db, nowMs: number): Promise<EventCounts> {
  const q = queryDb(db);
  const week = new Date(nowMs - 7 * DAY_MS).toISOString(), day = new Date(nowMs - DAY_MS).toISOString();
  const rows = await q.all(q.k.selectFrom("main.discord_events").select((eb) => [
    "kind", eb.fn.countAll<number>().as("week"), eb.fn.sum<number>(eb.case().when("at", ">=", day).then(1).else(0).end()).as("day"),
  ]).where("at", ">=", week).groupBy("kind"), { label: "discord.countEvents" });
  const out = Object.fromEntries(EVENT_KINDS.map((k) => [k, { day: 0, week: 0 }])) as EventCounts;
  for (const r of rows) if (r.kind in out) out[r.kind as EventKind] = { day: Number(r.day ?? 0), week: Number(r.week) };
  return out;
}
