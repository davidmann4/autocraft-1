// Whether a person settled that an item belongs in the app. Pure.
import type { ItemWorkflow } from "../workflow/types.ts";

/** They approved its merge, or started it at an entry that works towards one; null when nobody did (a review entry that is not approved asks the review for that as well). */
export function settledBy(w: Pick<ItemWorkflow, "entry" | "startedBy" | "approvedBy"> | undefined): { answer: string; by: string } | null {
  if (!w) return null;
  if (w.approvedBy !== null) return { answer: "merge approved", by: w.approvedBy };
  return w.entry === "review" ? null : { answer: `started at ${w.entry === "fixup" ? "fix-up" : w.entry}`, by: w.startedBy };
}
