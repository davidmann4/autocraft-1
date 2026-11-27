import type { QueuePendingRow } from "../../api/types";

/** What a PR approved for merge waits for while it is no queue row yet. */
export const PENDING_STEP: Record<Exclude<QueuePendingRow["step"], "next" | "implement">, string> = {
  fixup: "Fix-up first",
  review: "Waiting for review",
  ci: "Reviewed: take",
  build: "Waiting for its PR",
  pr: "PR open",
};
