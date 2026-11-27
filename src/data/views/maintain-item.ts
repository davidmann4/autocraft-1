// reads: (none; composes loaders)
// The new item page's data: the item's workflow history and events, its latest merge leg, the signals around it (duplicates,
// security findings of a fix PR, an outside-author hold) and the active breakers.
import type { ItemShown } from "../../../web/src/api/types.ts";
import type { Db } from "../../db/index.ts";
import { loadTrips } from "../control/index.ts";
import { loadHoldStatus } from "../intake/index.ts";
import { loadItems, loadShown } from "../mirror/index.ts";
import { loadFixPrFindings } from "../security/index.ts";
import { loadDuplicatesOf } from "../triage/index.ts";
import { loadEvents, loadLegs, loadWorkflowHistory } from "../workflow/index.ts";
import type { ItemWorkflow, Preapproval, SaidEvent } from "../workflow/types.ts";
import type { HoldStatus, Scope, TripRow } from "./types.ts";

export type MaintainItemFacts = {
  kind: "issue" | "pr"; history: ItemWorkflow[]; events: SaidEvent[]; leg: Preapproval | null; quiet: boolean;
  findings: { number: number; title: string; severity: string; state: string }[];
  duplicates: { other: number; canonical: boolean; shown: ItemShown | null }[];
  hold: HoldStatus; trips: TripRow[];
};

/** Null when the mirror has no such item. Staff only read the findings (a viewer's list stays empty). */
export async function loadMaintainItem(db: Db, scope: Pick<Scope, "staff" | "quiet">, ref: { repo: string; number: number }): Promise<MaintainItemFacts | null> {
  const key = `${ref.repo}#${ref.number}`;
  const refs = [ref];
  const [items, history, events, legs, findings, dupes, hold, trips] = await db.together(() => Promise.all([
    loadItems(db, refs, "ref"), loadWorkflowHistory(db, refs), loadEvents(db, refs), loadLegs(db, refs, { latestOnly: true }),
    scope.staff ? loadFixPrFindings(db, [key]) : Promise.resolve(new Map<string, { number: number; title: string; severity: string; state: string }[]>()),
    loadDuplicatesOf(db, refs), loadHoldStatus(db, refs), loadTrips(db, { active: true }),
  ]));
  const item = items.get(key);
  if (!item) return null;
  const others = (dupes.get(key) ?? []).map((d) => ({ repo: ref.repo, number: d.other }));
  const shown = others.length ? await loadShown(db, others) : new Map<string, ItemShown>();
  return {
    kind: item.kind === "issue" ? "issue" : "pr", history: history.get(key) ?? [], events: events.get(key) ?? [], leg: legs.get(key)?.[0] ?? null,
    quiet: scope.quiet.has(key), findings: findings.get(key) ?? [],
    duplicates: (dupes.get(key) ?? []).map((d) => ({ ...d, shown: shown.get(`${ref.repo}#${d.other}`) ?? null })),
    hold: hold.get(key) ?? null,
    trips: [...trips.values()].sort((a, b) => (a.trippedAt < b.trippedAt ? -1 : a.trippedAt > b.trippedAt ? 1 : a.stage < b.stage ? -1 : 1)),
  };
}
