// reads: (none; composes loaders)
// The item trace: one typed row array per source of the item's history, and the header facts, in one wave of loaders (the batch of
// each write event's integration branch is a second, small wave). Building events from the rows stays with the handler.
import type { Db } from "../../db/index.ts";
import { listAudit, listPushOutcomes, loadAuditCounts, countPushOutcomes } from "../control/index.ts";
import { loadEvents, loadWorkflowHistory } from "../workflow/index.ts";
import { loadItemTaskEvents, loadTaskHistoryStats } from "../build/index.ts";
import { loadModelChecksAfter, loadPatchChecks, loadPatchSignature, loadPatchTimeline } from "../changes/index.ts";
import { loadTurnDigests, loadTurnEvents } from "../conversations/index.ts";
import { loadItemRuns } from "../inference/index.ts";
import { loadItemJobTrail } from "../jobs/index.ts";
import { loadBatchByBranch, listMerges, loadVerifications } from "../merge/index.ts";
import { loadActivityStats, loadCommentStats, loadItemDetail } from "../mirror/index.ts";
import { loadPlanHistory, loadPlanVersions, loadPlans, loadStageLog, loadStageVersions } from "../planner/index.ts";
import { loadReviewRecord, loadReviewSignature } from "../review/index.ts";
import { loadMentionsOfItems } from "../discord/index.ts";
import type { MentionRow } from "../discord/types.ts";
import type { ItemWorkflow } from "../../workflow/types.ts";
import type { ItemRun } from "../inference/types.ts";
import type { ItemDetail, ItemDetailPart } from "../mirror/types.ts";
import type { ItemJobRow } from "../jobs/types.ts";
import type { MergeRow, VerificationView } from "../merge/types.ts";
import type { PatchCheckRow, ModelCheckRow, PatchTimelineRow } from "../changes/types.ts";
import type { PlanHistoryRow, StageEvent, StoredPlan } from "../planner/types.ts";
import type { ReviewRecord } from "../review/types.ts";
import type { PushOutcomeRow, AuditRow } from "../control/types.ts";
import type { TurnEvent } from "../conversations/types.ts";
import type { TaskEvent } from "../build/types.ts";
import type { StoredEvent } from "../workflow/types.ts";
import type { Scope } from "./types.ts";

export type TraceScope = Pick<Scope, "staff" | "operator" | "hidden">;

export type ItemTraceRows = {
  detail: ItemDetail; stages: StageEvent[]; planHistory: PlanHistoryRow[]; jobTrail: ItemJobRow[]; runs: ItemRun[]; modelChecks: ModelCheckRow[]; patchChecks: PatchCheckRow[];
  tasks: TaskEvent[]; pushOutcomes: PushOutcomeRow[]; patches: PatchTimelineRow[]; review: ReviewRecord | null; verifications: VerificationView[]; merges: MergeRow[];
  workflowEvents: StoredEvent[]; turns: TurnEvent[]; writes: AuditRow[]; batches: Map<string, number | undefined>;
  /** The item's workflows, oldest first; its Discord mention rows, still sealed. */
  workflows: ItemWorkflow[]; mentions: MentionRow[];
  header: { plan: StoredPlan | null; hold: { by: string; at: string } | null };
};

/** The audit actions of the item's write events; null: every action. */
export type WriteActions = string[] | null;

/** Every source is read whatever the viewer filters on: a filtered event still takes the head its neighbours carry. */
export async function loadItemTrace(db: Db, scope: TraceScope, ref: { repo: string; number: number }, writeActions: WriteActions, parts: ItemDetailPart[] = ["item", "comments", "activity", "commits"]): Promise<ItemTraceRows> {
  const key = `${ref.repo}#${ref.number}`;
  const refs = [ref];
  const [detail, stages, planHistory, plans, jobTrail, runs, modelChecks, patchChecks, tasks, pushOutcomes, patches, review, verifications, merges, workflowEvents, turns, writes, history, mentions] = await db.together(() => Promise.all([
    loadItemDetail(db, key, parts), loadStageLog(db, [key]), loadPlanHistory(db, [key]), loadPlans(db, refs), loadItemJobTrail(db, refs),
    loadItemRuns(db, [key], { hidden: scope.hidden, staff: scope.staff }), loadModelChecksAfter(db, 0, { repo: ref.repo, number: ref.number }), loadPatchChecks(db, refs),
    loadItemTaskEvents(db, ref, { hiddenRepos: scope.hidden, staff: scope.staff }), listPushOutcomes(db, { refs: [key] }), loadPatchTimeline(db, refs, { internals: scope.staff }),
    loadReviewRecord(db, refs), loadVerifications(db, refs), listMerges(db, { refs }), loadEvents(db, refs, { archived: true }), loadTurnEvents(db, { refs: [key] }),
    listAudit(db, { targets: [key], ...(writeActions ? { actions: writeActions } : {}), order: "asc" }), loadWorkflowHistory(db, refs), loadMentionsOfItems(db, [key]),
  ]));
  // A write event links the batch of its integration branch.
  const branches = [...new Set(writes.flatMap((w) => (typeof w.details?.batch === "string" ? [w.details.batch] : [])))];
  const batchIds = await Promise.all(branches.map((b) => loadBatchByBranch(db, ref.repo, b)));
  const last = history.get(key)?.at(-1);
  return {
    detail, stages: stages.get(key) ?? [], planHistory: planHistory.get(key) ?? [], jobTrail: jobTrail.get(key) ?? [], runs: runs.get(key) ?? [], modelChecks, patchChecks: patchChecks.get(key) ?? [],
    tasks, pushOutcomes, patches: patches.get(key) ?? [], review: review.get(key) ?? null, verifications: [...verifications.values()], merges, workflowEvents: workflowEvents.get(key) ?? [],
    turns, writes, batches: new Map(branches.map((b, i) => [b, batchIds[i]])), workflows: history.get(key) ?? [], mentions: mentions.get(key) ?? [],
    header: { plan: plans.get(key) ?? null, hold: last?.state === "stopped" && last.stoppedBy ? { by: last.stoppedBy, at: last.stoppedAt ?? "" } : null },
  };
}

/** What the trace's sources hold, as plain values to hash: counts, newest keys and the states that change in place. */
export async function loadItemTraceStamp(db: Db, scope: TraceScope, ref: { repo: string; number: number }): Promise<unknown[]> {
  const key = `${ref.repo}#${ref.number}`;
  const refs = [ref];
  const [detail, versions, stages, comments, activity, jobs, runs, tasks, pushes, patches, review, verifications, merges, turns, workflowEvents, audit, mentions] = await db.together(() => Promise.all([
    loadItemDetail(db, key, ["item"]), loadPlanVersions(db, [key]), loadStageVersions(db, [key]), loadCommentStats(db, refs), loadActivityStats(db, refs), loadItemJobTrail(db, refs),
    loadItemRuns(db, [key], { hidden: scope.hidden, staff: scope.staff }), loadTaskHistoryStats(db, refs), countPushOutcomes(db, [key]), loadPatchSignature(db, refs),
    loadReviewSignature(db, refs), loadVerifications(db, refs, { tasks: false }), listMerges(db, { refs }), loadTurnDigests(db, [key]), loadEvents(db, refs, { archived: true }), loadAuditCounts(db, key),
    loadMentionsOfItems(db, [key]),
  ]));
  const it = detail.item;
  const jobRows = jobs.get(key) ?? [], runRows = runs.get(key) ?? [];
  return [
    it && [it.updated_at, it.head_oid, it.state, it.assignees, it.closed_at, it.merged_at], versions.get(key) ?? null, stages.get(key) ?? null, comments.get(key) ?? null, activity.get(key) ?? null,
    [jobRows.length, jobRows.map((j) => `${j.job_id}:${j.state}:${j.outcome ?? ""}`).join(",")],
    [runRows.length, runRows[runRows.length - 1]?.id ?? null, runRows.filter((r) => r.endedAt !== null).length, runRows.filter((r) => r.costUsd !== null).length],
    tasks.get(key) ?? null, pushes.get(key) ?? null, patches.get(key) ?? null, review.get(key) ?? null,
    [...verifications.values()].map((v) => [v.headSha, v.state, v.finishedAt ?? v.createdAt]), [merges.length, merges[merges.length - 1]?.at ?? null],
    turns.get(key) ?? null, (workflowEvents.get(key) ?? []).map((e) => e.id), audit, (mentions.get(key) ?? []).map((m) => m.msgHash).sort(),
  ];
}
