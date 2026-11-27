import type { HiddenRepos } from "../control/types.ts";
import type { Override } from "../access/types.ts";
import type { AuthorHistory, RefKey } from "../mirror/types.ts";

export type { HiddenRepos, RefKey };

export type HoldReason = "limit" | "surge";
export type Hold = { repo: string; number: number; author: string; kind: "pr" | "issue"; reason: HoldReason };
export type HoldInfo = { reason: HoldReason; author: string; kind: "pr" | "issue"; limit: number };
/** 0 means the protection is off. */
export type OutsideLimits = { prsPerDay: number; issuesPerDay: number; surgePerHour: number };
export type OutsideState = OutsideLimits & { heldByLimit: number; heldBySurge: number; authors: number; tripped: { reason: string; since: string } | null };
export type HoldStatus = { author: string; reason: HoldReason; releasedBy: null } | { author: null; reason: null; releasedBy: string } | null;
export type HeldAuthorRow = { author: string; count: number; prs: number; oldest: string | null; surge: boolean };
export type HoldCounts = { limit: number; surge: number; authors: number };
export type OutsideAuthorRow = { author: string | null; author_association: string | null; author_type: string | null };
/** The settings key of the surge breaker's `stage_trips` row (control owns the trip rows). */
export const OUTSIDE_SURGE = "outside-surge";

/** An in-scope item of an outside author, with its admission and release flags. */
export type Candidate = Omit<Hold, "reason"> & { author_id: number | null; state: string; created_at: string; released: boolean; admitted: boolean };
/** The breaker row as the pure rule reads it. */
export type SurgeTrip = { active: boolean; trippedAt: string; clearedAt: string | null };
export type HoldInput = { rows: Candidate[]; limits: OutsideLimits; nowMs: number; trip: SurgeTrip | null; whitelisted: ReadonlySet<string> };
export type HoldResult = {
  holds: Hold[]; admissions: { repo: string; number: number }[]; wakeAt: number | null;
  /** Set when this pass trips the surge breaker; the holds are then computed as if tripped at `nowMs`. */
  tripSurge: { reason: string; evidence: string[] } | null;
};
/** An author account as the whitelist policy names it. */
export type AuthorRef = { login: string; id: number | null };
/** What the pure whitelist policy (`src/whitelist.ts`) reads: the loaded overrides, PR history, id bindings and the rule. */
export type WhitelistInput = { authors: AuthorRef[]; overrides: Map<string, Override>; history: AuthorHistory[]; bound: Map<string, number>; rule: { minMerged: number; minRate: number } };
/** Verdicts keyed by `${login}\0${id ?? ""}` (`tierKey` of `src/whitelist.ts`): true when the author account is whitelisted. */
export type WhitelistPolicy = (input: WhitelistInput) => Map<string, boolean>;
export class OutsideError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
