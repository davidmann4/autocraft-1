// Which implementation works a PR: the one definition the planner, the gates and the merge legs ask.
import { ENDED_STATES, type ImplementationState } from "../implement/types.ts";
import type { PrFacts } from "./plan.ts";

/** The implementation whose PR this is, while it is not merged, closed, failed or cancelled. */
export const liveAttempt = (f: PrFacts): NonNullable<PrFacts["implementation"]> | null =>
  f.implementation && !ENDED_STATES.has(f.implementation.state as ImplementationState) ? f.implementation : null;

/**
 * The implementation that owns the PR's fixes: its session takes the review's fixes and red CI (implement{revise}), and the fix-up and the CI
 * fix leave the PR alone (a conflict still goes to the conflict step). It owns them while the issue's implement workflow is live; a PR whose
 * issue's work ended, or that was started on its own, gets the normal steps.
 */
export const ownImplementation = (f: PrFacts): NonNullable<PrFacts["implementation"]> | null =>
  f.implementation && f.implementation.queuedBy !== null && !f.workflow?.own ? liveAttempt(f) : null;
