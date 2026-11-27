// Types of the read models in src/data/views (types only; the view files come in the consumer phase). Each view issues its loaders
// in one `together` wave; the row shapes below are what the handlers receive.
import type { ItemRef, ItemShown } from "../../../web/src/api/types.ts";
import type { ItemWorkflow, WorkflowEventKind } from "../../workflow/types.ts";
import type { BatchView, MergeRow, PrBuildView, ScreenshotRun, VerificationView } from "../merge/types.ts";
import type { ImplementationView } from "../implement/types.ts";
import type { PatchTimelineRow, PatchEventRow, ModelCheckEventRow, PatchCheckEventRow } from "../changes/types.ts";
import type { StoredPlan, StageEvent, PlanHistoryRow } from "../planner/types.ts";
import type { HelperInfo, ReadyRunner } from "../runners/types.ts";
import type { FindingAttention, FindingRow } from "../security/types.ts";
import type { RunRow, ItemRun } from "../inference/types.ts";
import type { TaskCard, TaskEvent, ArtifactRow } from "../build/types.ts";
import type { MentionRow } from "../discord/types.ts";

import type { TrackedRepo, TripRow, WriteLogRow } from "../control/types.ts";
import type { RepoRow, CommentRow } from "../mirror/types.ts";
import type { HeldAuthorRow, HoldStatus } from "../intake/types.ts";
import type { Preapproval, StoredEvent } from "../workflow/types.ts";
import type { JobItemRow, JobRow } from "../jobs/types.ts";
import type { DupeSignal } from "../triage/types.ts";
import type { HealthFacts } from "./health.ts";

export type { HealthFacts };

export type { TrackedRepo, TripRow, WriteLogRow, RepoRow, CommentRow, HeldAuthorRow, HoldStatus, Preapproval, StoredEvent, JobItemRow, JobRow };
// S1 has no types for these three; they stay open until the view files define them.
export type LegWaitInputs = Record<string, unknown>;
export type LaneFacts = Record<string, unknown>;
/** S1 names the duplicate signal of an item `DupeSignal`. */
export type DuplicateRow = DupeSignal;

import type { RefKey } from "../mirror/types.ts";

export type Ref = RefKey;
export type Role = "operator" | "maintainer" | "viewer";
export type HiddenRepos = string[] & { visible?: string[] };
export type Permission = "read" | "write" | "admin";
export type InferenceMode = string;

/** Built once per request by the handler and passed to every view. */
export type Scope = {
  login: string | null; role: Role; staff: boolean; operator: boolean;
  /** Visible tracked repos, narrowed to the picked project. */
  repos: string[];
  /** Visible tracked repos, ignoring the project. */
  allRepos: string[];
  /** Repos the viewer may not see: tracked or not, plus repos ever tracked. */
  hidden: HiddenRepos;
  /** Quiet security PRs; empty for staff. */
  quiet: Set<Ref>;
  /** Logins AutoCraft posts as. */
  own: Set<string>;
  perms: Map<string, Permission>;
};

export type VisibilityInputs = { tracked: Map<string, TrackedRepo>; everTracked: Set<string>; repos: Map<string, RepoRow> };

/** `updatedAt` is empty when the limit was never written. */
export type StoppedFacts = { trips: TripRow[]; zeroLimits: { step: string; updatedAt: string }[]; heldAuthors: HeldAuthorRow[] };
export type GaveUpFinding = FindingAttention["gaveUp"][number];
export type FailedClose = { repo: string; number: number; by: string; state: string; reason: string | null };
export type AttentionFacts = {
  stops: StoppedFacts; health: HealthFacts; gaveUp: GaveUpFinding[]; ciFixFailed: { repo: string; number: number; title: string }[];
  /** Open items whose latest workflow was closed while the close could not be made (src/act), newest first. */
  closesFailed: FailedClose[];
  /** Jobs that failed in the last hour, per step and repo (null repo: not about a repo). */
  failedJobs: { step: string; repo: string | null; n: number }[];
};
export type HomeFacts = {
  rows: (ItemWorkflow & { title: string | null; author: string | null; lastEvent: WorkflowEventKind | null })[];
  attention: AttentionFacts;
  runner: { mine: HelperInfo[]; ready: ReadyRunner[] } | null;
};

export type RepoFacts = {
  repos: TrackedRepo[]; open: Map<string, number>; mergedWeek: Map<string, number>; live: Map<string, { started: number; waiting: number }>; trips: TripRow[];
};
export type QueueMeta = { approvedBy: Map<Ref, string>; held: (ItemWorkflow & { title: string | null })[] };
export type StatsFacts = {
  closed: { day: string; state: string; stage: string | null; kind: string; n: number }[]; created: number; backlog: number; reviewed: number; spendUsd: number;
};
import type { FunnelFacts } from "./funnel.ts";
export type { FunnelFacts };

export type ItemsFilter = {
  show: "open" | "backlog" | "closed" | "merged"; filters: ("security" | "outside" | "stuck" | "duplicates")[]; areas: string[]; text: string | null; refs: Ref[]; limit: number;
  /** Only these items (`repo#number`); an empty list matches none. */
  mine?: string[];
  /** The order `limit` cuts open items in: latest change, or the weight (`normalWeight` without a workflow), the rank, then the latest change. */
  sort: "priority" | "updated"; normalWeight: number;
};
export type ItemsBase = { rows: ItemBase[]; places: { item: ItemBase; count: number }[]; closedTotal: number | null };
export type ItemBase = {
  repo: string; number: number; kind: "pr" | "issue"; title: string; author: string | null; state: string; updatedAt: string; mergedAt: string | null; closedAt: string | null; planState: string | null; itemState: string | null;
  phase: string | null; score: number | null; weight: number | null; workflowState: string | null; hasRecommendation: boolean; startedBy: string | null;
  approvedBy: string | null; stoppedBy: string | null; lastEvent: WorkflowEventKind | null;
  /** When and how AutoCraft merged it, in the list of those. */
  merged?: { at: string; how: "rule" | "approval" | "batch" };
};
export type ItemRowFacts = {
  plans: Map<Ref, StoredPlan>; holds: Map<Ref, HoldStatus>; stuck: Set<Ref>; duplicateGroups: Map<Ref, DupeSignal>; areas: Map<Ref, unknown>; workflows: Map<Ref, ItemWorkflow>; permissions: Map<string, Permission>;
};
export type SearchHit = { repo: string; number: number; kind: "pr" | "issue"; title: string; snippet: string | null; commentId: string | null };
export type ItemPeekFacts = { shown: ItemShown; body: string | null; comments: CommentRow[] };

export type MaintainItemFacts = {
  kind: "issue" | "pr"; history: ItemWorkflow[]; events: StoredEvent[]; leg: Preapproval | null; legWait: LegWaitInputs | null; quiet: boolean;
  findings: FindingRow[]; duplicates: DuplicateRow[]; hold: HoldStatus | null; trips: TripRow[]; permissions: Permission | null;
};

/** The item page's data: one field per loader of the page's three waves. */
export type ItemPageFacts = {
  item: unknown; comments: CommentRow[]; stages: StageEvent[]; plan: StoredPlan | null; triage: unknown; related: ItemRef[]; discord: MentionRow[];
  tracked: TrackedRepo | null; queue: { position: number; of: number; weight: number | null } | null; hold: HoldStatus | null; legs: Preapproval[]; events: StoredEvent[];
  jobs: { trail: JobItemRow[]; failed: JobRow[]; active: JobRow[]; positions: Map<number, number> }; runs: ItemRun[]; patches: PatchTimelineRow[];
  modelChecks: ModelCheckEventRow[]; patchChecks: PatchCheckEventRow[]; verification: { head: string; view: VerificationView } | null; prBuild: PrBuildView | null;
  screenshot: ScreenshotRun | null; merges: MergeRow[]; reviews: unknown; pushOutcomes: unknown[]; writeLog: WriteLogRow[]; conversations: unknown; implementation: ImplementationView | null;
  implementationRuns: Map<number, RunRow>; warm: Map<number, unknown>; screenshotArtifacts: Map<number, ArtifactRow[]>; questionComments: CommentRow[];
};
export type ImplementationFacts = { view: ImplementationView; runIds: Map<number, number>; runs: Map<number, RunRow>; warm: Map<number, unknown> };
export type GithubWrites = { writes: WriteLogRow[]; comments: CommentRow[] };

/** One typed row array per trace source and the header facts. */
export type TraceRows = {
  comments: CommentRow[]; commits: unknown[]; activity: unknown[]; stages: StageEvent[]; planHistory: PlanHistoryRow[]; jobTrail: JobItemRow[]; runs: ItemRun[];
  checks: (ModelCheckEventRow | PatchCheckEventRow)[]; tasks: TaskEvent[]; pushOutcomes: unknown[]; patches: PatchTimelineRow[]; reviews: unknown[]; verifications: VerificationView[];
  merges: MergeRow[]; workflowEvents: StoredEvent[]; turns: unknown[]; writes: WriteLogRow[];
  header: { plan: StoredPlan | null; assignees: string[]; hold: HoldStatus | null; recommendation: unknown | null };
};
export type TraceKind = string;
export type SourceId = string;
export type ActivityRows = { bySource: { source: SourceId; rows: (PatchEventRow | Record<string, unknown>)[]; floor: string | null }[] };
export type ActivityStampKey = { kinds: Set<TraceKind>; repo: string | null };
export type ActivityQuery = { kinds: Set<TraceKind>; only: boolean; repo: string | null; limit: number; before: { at: string; id: string } | null };

export type LiveOptions = { nowMs: number; quietSteps: string[]; recentMs: number; recentMax: number; queuedMax: number; workerWindowMs: number; workerCallsMax: number };
export type LiveFacts = {
  lanes: LaneFacts; looseRuns: RunRow[]; batches: BatchView[]; standaloneTasks: Map<Ref, unknown[]>; stepDurations: Map<string, number[]>; workerRuns: RunRow[] | null;
  runnerBoard: unknown | null; jobRuns: Map<number, RunRow[]>; tasksOfJobs: Map<number, TaskCard[]>; callDurations: Map<string, { startedAt: string; endedAt: string }[]>;
  taskDurations: Map<string, number[]>; shown: Map<Ref, ItemShown>;
};

export type QueueTab = string;
export type QueueEntry = { plan: StoredPlan; title: string | null; premerge: unknown | null };
export type QueueFacts = {
  merge: QueueEntry[]; holds: Map<Ref, HoldStatus>; positions: Map<Ref, { position: number; of: number; weight: number | null }>; work: WorkRow[]; approvals: Map<Ref, string>;
  closing: Map<Ref, number[]>; batches: BatchView[]; scores: Map<string, Map<Ref, number>>; runnerQueue: unknown; prBuilds: Map<Ref, PrBuildView>;
};
export type BatchPageFacts = { batch: BatchView; parent: string | null; children: { id: number; createdAt: string }[]; checks: unknown; audit: unknown[]; tasks: Map<number, unknown> };
export type WorkRow = { repo: string; number: number; kind: "pr" | "issue"; title: string; next: string | null; label: string | null; score: number | null; state: string };
export type PipelineFacts = { lastJobPerStep: Map<string, unknown>; stageStates: Map<string, unknown>; counts: Map<string, number>; syncRuns: unknown[]; pipelineSwitch: unknown; limits: unknown[] };

export type PublicStatusRow = {
  repo: string; number: number; kind: "pr" | "issue"; title: string; state: string; stage: string | null; planState: string | null; needsPerson: boolean;
  url: string | null; reviewed: boolean; /** The plan's cached view, unparsed. */ view: string | null; hidden: boolean;
};
export type QueueMember = { repo: string; number: number; batched: boolean; /** The work score of a started PR. */ work: number | null; /** The work rank. */ score: number | null };
export type PublicStatsFacts = {
  open: { repo: string; kind: "pr" | "issue"; n: number }[]; merged: { repo: string; number: number; ours: boolean; mergedAt: string; openedAt: string | null }[];
  reviews: { repo: string; n: number }[]; queues: { repo: string; n: number }[];
};
export type HeldFixupFacts = { repo: string; number: number; title: string | null; author: string | null; note: string | null; head: string; reason: string | null; fixes: unknown; latestFixup: { state: string; reason: string | null } | null };

/** src/data/views/prStatus.ts */
export type StatusInputs = {
  stored: import("../workflow/types.ts").StatusRow[];
  inScope: Set<number>;
  started: Map<number, { wf: ItemWorkflow; open: boolean }>;
};
export type StatusExtras = { batches: Map<string, { pr: number | null }>; answered: Map<number, { login: string; at: string }>; quiet: Set<string> };
