// The vocabulary of an implementation of a queued issue (the Implement stage): its states, rounds and the replies of
// its model calls. No imports: the planner and the dashboard bundle use it.

export const IMPLEMENTATION_STATES = [
  "planning", "asked", "planned", "implementing", "checking", "fixing", "opening", "pr-opened", "revising", "stuck",
  "merged", "closed", "failed", "cancelled",
] as const;
export type ImplementationState = (typeof IMPLEMENTATION_STATES)[number];

/** States in which work of ours runs or is due without a person: at most MAX_LIVE_PER_REPO such rows per repo. */
export const LIVE_STATES: ReadonlySet<ImplementationState> = new Set(["planning", "planned", "implementing", "checking", "fixing", "opening", "revising"]);
/** States a row never leaves: a new attempt is a new row. The rest are the issue's current attempt (one at most). */
export const ENDED_STATES: ReadonlySet<ImplementationState> = new Set(["merged", "closed", "failed", "cancelled"]);
/** States whose work the build bucket carries on: the plan is stored, the session or its checks or the PR are due or were cut off by a restart. */
export const BUILD_STATES: ReadonlySet<ImplementationState> = new Set(["planned", "implementing", "checking", "fixing", "opening"]);

/** Live implementations one repo may hold at once; one per issue. */
export const MAX_LIVE_PER_REPO = 2;

/** What a job of the `implement` step does: plan (and, when ready, go on to build in the same job), build from a stored plan, or revise our open PR. */
export const IMPLEMENT_BUCKETS = ["plan", "build", "revise"] as const;
export type ImplementBucket = (typeof IMPLEMENT_BUCKETS)[number];

/**
 * `guidance`: a person's note for the attempt (a Try again answer's text), read into its plan and session input.
 * `workspace`: the attempt's workspace was made again; the turns and checks before it belong to the lost one.
 * `ask-failed`: posting or asking a stored plan's questions failed; the next job tries the write again from the stored plan.
 * `revise`: a revision of our open PR starts (ReviseRound); the turns and checks after it belong to that revision.
 */
export const ROUND_KINDS = ["plan", "session", "follow-up", "checks", "refusal", "question", "guidance", "workspace", "ask-failed", "revise"] as const;
export type RoundKind = (typeof ROUND_KINDS)[number];

/** One `implementations` row. JSON columns are parsed; a column that does not parse reads as null. */
export type Implementation = {
  id: number;
  repo: string; number: number;
  queuedBy: string;
  state: ImplementationState;
  attempt: number;
  textHash: string;
  baseSha: string | null;
  workspaceId: number | null;
  plan: PlanReply | null;
  planMd: string | null;
  planCallId: number | null;
  sessionCallId: number | null;
  report: SessionReport | null;
  diffHash: string | null;
  diffStat: string | null;
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  decisionId: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
};

/** The columns a step may set besides the state (updated_at is always set). */
export type ImplementationPatch = Partial<Pick<Implementation,
  "textHash" | "baseSha" | "workspaceId" | "plan" | "planMd" | "planCallId" | "sessionCallId" | "report" | "diffHash" | "diffStat" | "branch" | "prNumber" | "prUrl" | "decisionId" | "reason">>;

export type ImplementationRound = {
  id: number;
  implementationId: number;
  kind: RoundKind;
  callId: number | null;
  /** The round's JSON result, parsed; null when there is none or it does not parse. */
  result: unknown;
  at: string;
};

// ---- the model calls' replies (implement.plan, implement.session) ------------------------------------------------

export type QuestionAudience = "author" | "maintainer";
/**
 * The result of a `question` round: whom it asked, and where (the issue comment, or the decision). The planner reads the newest
 * question round of an `asked` attempt: only answers after it plan again, so every new question needs a round of its own.
 */
export type QuestionRound = { audience: QuestionAudience; text: string; commentId?: string; decisionId?: string };
/** The result of an `ask-failed` round: what failed, for the plan round whose questions it was writing. */
export type AskFailedRound = { planRound: number; error: string };
export type PlanQuestion = { audience: QuestionAudience; text: string; options: { label: string; hint: string }[]; recommended: string | null };

/**
 * The result of a `revise` round: the PR head it revises and why (the review's fixes, red CI or both), the commit our last
 * push made (the revision's push carries the change since it onto the PR's head), and the follow-up it sends the session.
 */
export type ReviseRound = { prNumber: number; head: string; from: string; review: boolean; ci: boolean; message: string };

/** The plan call's reply: ready to implement, or the questions that come first. */
export type PlanReply = {
  ready: boolean;
  kind: "bugfix" | "feature" | "change";
  summary: string;
  /** Markdown. */
  plan: string;
  acceptance: string[];
  verification: { tests: string[]; app: string | null };
  size: "S" | "M" | "L" | "XL";
  risks: string[];
  questions: PlanQuestion[];
  /** On the maintainer workflow: what the reply adds; absent when it had neither field. */
  workflow?: PlanWorkflow;
};

/** A ready plan's numbered parts (each with the files it changes) and, for a plan that asks, the sentence recommending an option. */
export type PlanWorkflow = { parts: { title: string; files: string[] }[]; recommendation: string | null };

/** The session's JSON report. AutoCraft trusts only its own checks; this says what the session claims. */
export type SessionReport = {
  status: "done" | "blocked";
  summary: string;
  changes: string[];
  tests_run: { command: string; exit: number }[];
  shots: { n: number; what: string }[];
  deviations: string[];
  blocked_reason?: string;
};
