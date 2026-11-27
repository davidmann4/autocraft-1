// Row shapes and conversions shared by the loaders and writers of the implement module.
import { ENDED_STATES, type Implementation, type ImplementationPatch, type ImplementationRound, type ImplementationState, type PlanReply, type RoundKind, type SessionReport } from "./types.ts";

/** The `implementations` columns the module reads (`decision_id` is not one of them). */
export const IMPL_COLS = [
  "id", "repo", "number", "queued_by", "state", "attempt", "text_hash", "base_sha", "workspace_id", "plan_json", "plan_md", "plan_call_id", "session_call_id",
  "report_json", "diff_hash", "diff_stat", "branch", "pr_number", "pr_url", "reason", "created_at", "updated_at",
] as const;

export const ENDED: ImplementationState[] = [...ENDED_STATES];

export type ImplRow = {
  id: number | string; repo: string; number: number | string; queued_by: string; state: string; attempt: number | string; text_hash: string; base_sha: string | null;
  workspace_id: number | string | null; plan_json: string | null; plan_md: string | null; plan_call_id: number | string | null; session_call_id: number | string | null;
  report_json: string | null; diff_hash: string | null; diff_stat: string | null; branch: string | null; pr_number: number | string | null; pr_url: string | null;
  reason: string | null; created_at: string; updated_at: string;
};

export const num = (v: number | string | null): number | null => (v === null ? null : Number(v));

export function parse<T>(s: string | null | undefined): T | null {
  if (s === null || s === undefined) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

export const ofRow = (r: ImplRow): Implementation => ({
  id: Number(r.id), repo: r.repo, number: Number(r.number), queuedBy: r.queued_by, state: r.state as ImplementationState, attempt: Number(r.attempt),
  textHash: r.text_hash, baseSha: r.base_sha, workspaceId: num(r.workspace_id), plan: parse<PlanReply>(r.plan_json), planMd: r.plan_md,
  planCallId: num(r.plan_call_id), sessionCallId: num(r.session_call_id), report: parse<SessionReport>(r.report_json), diffHash: r.diff_hash, diffStat: r.diff_stat,
  branch: r.branch, prNumber: num(r.pr_number), prUrl: r.pr_url, reason: r.reason, createdAt: r.created_at, updatedAt: r.updated_at,
});

export type RoundRow = { id: number | string; implementation_id: number | string; kind: string; call_id: number | string | null; result: string | null; at: string };

export const roundOf = (r: RoundRow): ImplementationRound => ({
  id: Number(r.id), implementationId: Number(r.implementation_id), kind: r.kind as RoundKind, callId: num(r.call_id), result: parse<unknown>(r.result), at: r.at,
});

export const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));

/** The columns of a patch as stored. A key left out is not written; null clears the column. */
export function columnsOf(p: ImplementationPatch): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  if (p.queuedBy !== undefined) out.queued_by = p.queuedBy;
  if (p.textHash !== undefined) out.text_hash = p.textHash;
  if (p.baseSha !== undefined) out.base_sha = p.baseSha;
  if (p.workspaceId !== undefined) out.workspace_id = p.workspaceId;
  if (p.plan !== undefined) out.plan_json = json(p.plan);
  if (p.planMd !== undefined) out.plan_md = p.planMd;
  if (p.planCallId !== undefined) out.plan_call_id = p.planCallId;
  if (p.sessionCallId !== undefined) out.session_call_id = p.sessionCallId;
  if (p.report !== undefined) out.report_json = json(p.report);
  if (p.diffHash !== undefined) out.diff_hash = p.diffHash;
  if (p.diffStat !== undefined) out.diff_stat = p.diffStat;
  if (p.branch !== undefined) out.branch = p.branch;
  if (p.prNumber !== undefined) out.pr_number = p.prNumber;
  if (p.prUrl !== undefined) out.pr_url = p.prUrl;
  if (p.reason !== undefined) out.reason = p.reason;
  return out;
}

/** Column types of a patch in a `valuesTable`. */
export const COLUMN_TYPE: Record<string, "text" | "bigint"> = {
  queued_by: "text", text_hash: "text", base_sha: "text", workspace_id: "bigint", plan_json: "text", plan_md: "text", plan_call_id: "bigint", session_call_id: "bigint",
  report_json: "text", diff_hash: "text", diff_stat: "text", branch: "text", pr_number: "bigint", pr_url: "text", reason: "text", state: "text",
};
