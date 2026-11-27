// Counters of the public issue flow: one row per event with its time and kind, and nothing else (no text, no Discord ids).
// The Discord page's usage block counts them over 24 hours and 7 days.
import type { Db } from "../db/index.ts";
import * as dc from "../data/discord/index.ts";
import type { EventCounts, EventKind } from "../data/discord/index.ts";

export { EVENT_KINDS, type EventCounts, type EventKind } from "../data/discord/index.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows are kept a day longer than the longest count, so the 7-day count is complete at any time. */
export const EVENT_KEEP_MS = 8 * DAY_MS;

const PRUNE_EVERY_MS = 60 * 60_000;
let prunedAt = 0;

/** Counts one event. Bookkeeping: a failure is logged and never reaches the flow. */
export async function recordEvent(db: Db, kind: EventKind, log: (m: string) => void = () => {}, now: number = Date.now()): Promise<void> {
  try {
    await dc.addEvents(db, [{ kind, atIso: new Date(now).toISOString() }]);
    if (Date.now() - prunedAt >= PRUNE_EVERY_MS) {
      prunedAt = Date.now();
      await dc.pruneEvents(db, new Date(now - EVENT_KEEP_MS).toISOString());
    }
  } catch (e) {
    log(`discord: counting an event failed: ${String((e as Error).message ?? e).slice(0, 200)}`);
  }
}

/** Events of each kind in the last 24 hours and the last 7 days. */
export const eventCounts = async (db: Db, now: number = Date.now()): Promise<EventCounts> => await dc.countEvents(db, now);
