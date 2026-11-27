// The rows of an item's History: what people told AutoCraft beside the trace, oldest first.
import type { MaintainEvent, TraceEvent } from "../api/types.ts";

export type HistoryRow = { t: "said"; at: string; e: MaintainEvent } | { t: "trace"; at: string; e: TraceEvent };

/** The trace carries the workflow events too: one that `said` shows is left out of it; the archived ones, which `said` does not carry, stay. */
export function historyRows(said: MaintainEvent[], events: TraceEvent[]): HistoryRow[] {
  const shown = new Set(said.map((e) => `workflow:${e.id}`));
  const out: HistoryRow[] = [...said.map((e) => ({ t: "said" as const, at: e.at, e })), ...events.filter((e) => !shown.has(e.id)).map((e) => ({ t: "trace" as const, at: e.at, e }))];
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}
