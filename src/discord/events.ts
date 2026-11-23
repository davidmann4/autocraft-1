// Counters of the public issue flow: one row per event with its time and kind, and nothing else (no text, no Discord ids).
// The Discord page's usage block counts them over 24 hours and 7 days.
import type { Db } from "../db/index.ts";

export const EVENT_KINDS = ["started", "junk", "filed", "link", "limits"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows are kept a day longer than the longest count, so the 7-day count is complete at any time. */
export const EVENT_KEEP_MS = 8 * DAY_MS;

/** Counts one event. Bookkeeping: a failure is logged and never reaches the flow. */
export async function recordEvent(db: Db, kind: EventKind, log: (m: string) => void = () => {}, now: number = Date.now()): Promise<void> {
  try {
    await db.run(db.k.insertInto("discord_events").values({ at: new Date(now).toISOString(), kind }));
    await db.run(db.k.deleteFrom("discord_events").where("at", "<", new Date(now - EVENT_KEEP_MS).toISOString()));
  } catch (e) {
    log(`discord: counting an event failed: ${String((e as Error).message ?? e).slice(0, 200)}`);
  }
}

export type EventCounts = Record<EventKind, { day: number; week: number }>;

/** Events of each kind in the last 24 hours and the last 7 days. */
export async function eventCounts(db: Db, now: number = Date.now()): Promise<EventCounts> {
  const week = new Date(now - 7 * DAY_MS).toISOString(), day = new Date(now - DAY_MS).toISOString();
  const rows = await db.all(db.k.selectFrom("discord_events").select(["kind", "at"]).where("at", ">=", week));
  const out = Object.fromEntries(EVENT_KINDS.map((k) => [k, { day: 0, week: 0 }])) as EventCounts;
  for (const r of rows) {
    const c = out[r.kind as EventKind];
    if (!c) continue;
    c.week++;
    if (r.at >= day) c.day++;
  }
  return out;
}
