// Queue places for the mock build.
import type { QueueSlot } from "../types";

const STAGES: Record<string, Pick<QueueSlot, "stage" | "tab">> = {
  Review: { stage: "Review", tab: "review" },
  "Opus review": { stage: "Opus review", tab: "review" },
  Fix: { stage: "Fix", tab: "fix" },
  "Fix-up": { stage: "Fix-up", tab: "fix" },
  Verify: { stage: "Verify", tab: "verify" },
  "Merge queue": { stage: "Merge", tab: "merge" },
};

/** A stable place for an item the mock has no queue for: most items are queued somewhere. */
export function mockSlot(number: number): QueueSlot | null {
  const kinds = ["Review", "Fix", "Verify", "Fix-up", "Merge queue"];
  const k = number % 7;
  const s = k < kinds.length ? STAGES[kinds[k]!] : undefined;
  return s ? { ...s, place: (number % 9) + 1 } : null;
}
