import type { RefKey } from "../mirror/types.ts";
import type { WaitCode } from "../../core/codes.ts";
import type { Action, ActionKind, WaitKind } from "../../core/plan.ts";
import type { CifixBucket, FixupBucket, PlanHistoryRow, PlanRow, PlanView, QueueView, StoredAction } from "../../core/plan-cache.ts";
import type { KeySource } from "../keys.ts";

export type { Action, ActionKind, CifixBucket, FixupBucket, PlanHistoryRow, PlanRow, PlanView, QueueView, StoredAction, WaitCode, WaitKind };

export type { RefKey };
export type ItemKeys = KeySource;
export type { HiddenRepos } from "../control/types.ts";
import type { HiddenRepos } from "../control/types.ts";

export const BULK_ROWS = 500;
export const SHADOW_ROWS = 2000;

export type ChangeCursor = { gen: number; seen: Set<number> };
export type Changes = { refs: RefKey[]; full: boolean; cause?: "marker" | "cap"; cursor: ChangeCursor };

export type StoredPlan = {
  repo: string; number: number; kind: "pr" | "issue"; head: string | null; state: string; itemState: string | null;
  actions: StoredAction[]; wait: string | null; reasons: string[]; note: string | null; view: PlanView; plannedAt: string;
};
/** Opaque to callers: the revision and the per-connection memo of stored signatures. */
export type StoredPlans = { rev: number | null; rows: Map<RefKey, unknown> | null };
export type PlanFilter = {
  repos?: string[]; kind?: "pr" | "issue"; states?: string[];
  /** State in the queue states and a queue view present. */
  queued?: boolean;
  gh?: ("OPEN" | "MERGED")[];
  scope?: boolean;
  /** The view says the automatic merge rule takes the PR up by itself. */
  auto?: boolean;
  fixup?: FixupBucket;
  hasWait?: boolean;
  action?: { kind: ActionKind; bucket?: string };
  /** The item is open in the mirror. */
  open?: boolean;
  /** The plan head equals the mirror's head. */
  headIsCurrent?: boolean;
  hidden?: HiddenRepos;
  /** Keyset page in (repo, number) order. */
  after?: { repo: string; number: number };
  limit?: number;
};
export type PlanHistoryEntry = PlanHistoryRow & { repo: string; number: number };
export type PlanVersion = { plannedAt: string; state: string; head: string | null; historyCount: number; /** The newest history row's id. */ historyNewest: number | null };

export type PassCount = { kind: string; passes: number; refs: number; at: string; ms: number; maxMs: number; dbStatements: number; dbRoundTrips: number; dbMs: number; hour: string };
export type ShadowDiff = { at: string; ref: RefKey; side: "pr" | "item"; fields: string; detail: string };
/** The counts of one kind, summed over every stored hour; `hours` is the hourly series the `query-growth` check compares. */
export type PassStat = Omit<PassCount, "hour">;
export type PassReport = { logged: number; passes: PassStat[]; hours: PassCount[]; fullCauses: { source: string; n: number }[]; shadowDiffs: number };

export type Stage = "classified" | "labeled" | "reviewed" | "take" | "hold" | "batched" | "merged" | "closed" | "fixed-by-us" | "verify-ci-enough" | (string & {});
export type StageEventRow = { repo: string; number: number; stage: Stage; at: string; actor: string | null; note: string | null };
export type StageFacts = { stage: Stage; at: string; reviewed: boolean; labeledNote: string | null };
export type StageEvent = { rowid: number; stage: Stage; at: string; actor: string | null; note: string | null };

export type LivenessVerdict = "stuck" | "long";
/** `actions`: how many of the planned actions may run. */
export type LivenessPlanRow = { kind: "pr" | "issue"; state: string; itemState: string | null; phase: string; wait: string | null; waitKind: WaitKind | null; waitCode: WaitCode | null; actions: number; since: string; repo: string; number: number };
/** `asked`: items a person has been asked about; `started`: items with a live workflow. Both include the implementation PR of an issue's implement workflow. */
export type LivenessInput = { plans: LivenessPlanRow[]; asked: Set<RefKey>; started: Set<RefKey>; longDays: number };
export type LivenessItem = { repo: string; number: number; kind: "pr" | "issue"; verdict: LivenessVerdict; cause: string; state: string; wait: string | null; phase: string; since: string };
export type Liveness = { checkedAt: string; stuck: number; long: number; open: number; causes: Record<string, number>; items: LivenessItem[] };
