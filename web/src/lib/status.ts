import type { ImplementationStateName } from "../api/types";
import type { Tone } from "../ui/atoms/Badge";

/** An implementation attempt's state as the item page and the Queue show it. */
export const IMPLEMENTATION_STATE: Record<ImplementationStateName, { label: string; tone: Tone }> = {
  planning: { label: "Planning", tone: "accent" },
  asked: { label: "Question asked", tone: "warn" },
  planned: { label: "Planned", tone: "accent" },
  implementing: { label: "Writing the change", tone: "accent" },
  checking: { label: "AutoCraft's checks", tone: "accent" },
  fixing: { label: "Follow-up on findings", tone: "accent" },
  opening: { label: "Opening the PR", tone: "accent" },
  "pr-opened": { label: "PR opened", tone: "ok" },
  revising: { label: "Revising the PR", tone: "accent" },
  stuck: { label: "Stuck", tone: "bad" },
  merged: { label: "Merged", tone: "merged" },
  closed: { label: "Closed", tone: "neutral" },
  failed: { label: "Failed", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};
