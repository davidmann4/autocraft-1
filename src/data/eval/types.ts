// Rows of the self-evaluation (eval): what the detectors read and the stored causes.

export type EvalCauseState = "new" | "investigated" | "filing" | "filed" | "declined";
export type EvalVerdict = "defect" | "not-defect" | "failed";

/** One piece of evidence: a stable id (`job:9`, `call:45`, `wf:12`, `audit:777`, `check:runner`, `item:app#3`), its time and one line. */
export type EvalEvidence = { id: string; at: string; note: string; ref?: { repo: string; number: number } };

export type EvalCause = {
  key: string;
  detector: string;
  summary: string;
  state: EvalCauseState;
  firstSeen: string;
  lastSeen: string;
  evidence: EvalEvidence[];
  seen: number;
  investigatedAt: string | null;
  investigatedSeen: number;
  verdict: EvalVerdict | null;
  /** Investigations in a row without a valid reply. */
  failures: number;
  finding: unknown;
  model: string | null;
  runId: string | null;
  issueNumber: number | null;
  filedAt: string | null;
  reportedSeen: number;
  commentedAt: string | null;
  attempts: number;
  note: string | null;
};

/** What the detectors read, from one load. Times are ISO strings except where the column holds epoch ms. */
export type EvalFacts = {
  workflows: { id: number; repo: string; number: number; state: string; step: string | null; blocker: string | null; rec: string | null; updatedAt: string }[];
  queuedCalls: { id: number; jobId: number | null; step: string; promptId: string; repo: string | null; queuedSince: number; noTakerSince: number | null; refs: { repo: string; number: number }[] }[];
  runners: { readiness: string; reportedAt: number; slots: number | null; busy: number | null }[];
  liveJobs: { id: number; step: string; repo: string | null; state: "queued" | "running"; requestedAt: string; startedAt: string | null }[];
  endedJobs: { id: number; step: string; repo: string | null; state: string; error: string | null; items: number; acted: number; endedAt: string }[];
  audit: { rowid: number; at: string; action: string; target: string | null; error: string | null; step: string | null }[];
  answers: { id: number; repo: string; number: number; kind: string; at: string; live: boolean; touchedAfter: boolean }[];
  merged: { repo: string; number: number; mergedAt: string; calls: number; costUsd: number; byPrompt: Record<string, number> }[];
};

/** Who a known login is to AutoCraft, strongest first: the access list's role, a Task Runner's owner, a user with settings, a repository owner, an item author. */
export type EvalLoginRole = "operator" | "maintainer" | "runner" | "user" | "owner" | "author";

/** Names AutoCraft knows that public text must not carry: logins with their role, Task Runner machines' host names and the labels people gave them. */
export type EvalNames = { logins: { login: string; role: EvalLoginRole }[]; hosts: string[]; labels: string[] };
