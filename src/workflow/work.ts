// What a workflow works on: the implementation attempt and the pull request of an issue's, the person an implementation runs for, and the
// findings of a review that no person dropped. Pure: the advance pass, the command core and the planner give it what they loaded, so they agree.
import type { Standing } from "../data/access/types.ts";
import type { IssueAttempt } from "../data/implement/types.ts";
import { ENDED_STATES } from "../implement/types.ts";
import type { ItemWorkflow, PlanPart } from "./types.ts";

/** The workflow's start and the PR it is linked to; a row without a link has none. */
type Linked = Pick<ItemWorkflow, "startedAt"> & Partial<Pick<ItemWorkflow, "prNumber">>;

/**
 * The PR an implement workflow works on, as `workOf` may name it: the one it is linked to, else the one it would be linked to (data/workflow
 * linkingAttempt): the PR of the issue's current attempt, or of one that ended in the workflow.
 */
export function candidatePr(a: IssueAttempt | null | undefined, w: Linked): number | null {
  if (!a) return null;
  if (w.prNumber != null) return w.prNumber;
  const { state, prNumber, updatedAt } = a.attempt;
  if (prNumber !== null && (!ENDED_STATES.has(state) || updatedAt >= w.startedAt)) return prNumber;
  // The latest attempt of this workflow that opened a PR.
  return a.prAttempts.find((p) => p.createdAt >= w.startedAt)?.prNumber ?? null;
}

/** The PR that an implement workflow started now would go on with: that of an attempt that has not ended. */
export const takenOver = (a: IssueAttempt | null | undefined): number | null => (a && !ENDED_STATES.has(a.attempt.state) ? a.attempt.prNumber : null);

/** The PR was merged or closed before the workflow started. */
export const overBefore = (pr: { state: string; closed_at: string | null } | null | undefined, startedAt: string): boolean =>
  !!pr && pr.state !== "OPEN" && pr.closed_at !== null && pr.closed_at < startedAt;

/**
 * What an implement workflow works on: the issue's current attempt, and its PR (`pr`: the item of `candidatePr`). An attempt that ended before
 * the workflow started is none of it, nor one whose PR was merged or closed before that (its end is recorded a moment later).
 */
export function workOf(
  a: IssueAttempt | null | undefined, w: Linked, pr: { state: string; closed_at: string | null } | null | undefined,
): { attempt: IssueAttempt | null; pr: number | null } {
  if (!a || overBefore(pr, w.startedAt)) return { attempt: null, pr: null };
  return { attempt: ENDED_STATES.has(a.attempt.state) ? null : a, pr: candidatePr(a, w) };
}

/**
 * The person whose command an implementation runs on: the newest of the workflow's `actors` (data/workflow workflowActors) who may act on the
 * repo now. When nobody may, the newest one GitHub has not answered on, else the newest; null without actors.
 */
export function settlerOf(actors: readonly string[], of: (login: string) => Standing): { by: string; standing: Standing } | null {
  const all = actors.map((by) => ({ by, standing: of(by) }));
  return all.find((a) => a.standing === "yes") ?? all.find((a) => a.standing === "unknown") ?? all[0] ?? null;
}

const TITLE_CHARS = 80;

/** A review finding's title, as the plan's part carries it: the review's own, else the start of its change. */
export const partTitle = (f: { file: string; change: string; title?: string }): string => f.title ?? (f.change.replace(/\s+/g, " ").trim().slice(0, TITLE_CHARS) || f.file);

/** The lower-case titles of the parts a person dropped. */
export const droppedTitles = (plan: readonly PlanPart[]): string[] => plan.filter((p) => p.state === "dropped").map((p) => p.title.toLowerCase());

/** The lower-case titles of the parts a person dropped, but the pre-merge review's findings, whose drop holds only at some heads (`overruledAt`). */
export const droppedReviewTitles = (plan: readonly PlanPart[]): string[] => plan.filter((p) => p.state === "dropped" && !p.premerge).map((p) => p.title.toLowerCase());

/**
 * The lower-case titles of the pre-merge findings a person dropped from the plan of a workflow approved for merge that overrule the review at a head:
 * dropped at a head of `chain` (the head and the heads our own pushes lead to it from, src/data/changes pushChainOf). Pure.
 */
export const overruledAt = (plan: readonly PlanPart[], approved: boolean, chain: readonly string[]): string[] =>
  approved ? plan.filter((p) => p.state === "dropped" && p.premerge && p.droppedAt !== undefined && chain.includes(p.droppedAt)).map((p) => p.title.toLowerCase()) : [];

/** The findings a person has not dropped from the workflow's plan (`dropped`: titles, lower case): the ones the pipeline fixes. */
export const keptFixes = <F extends { file: string; change: string; title?: string }>(fixes: readonly F[], dropped: readonly string[] | undefined): F[] =>
  fixes.filter((f) => !dropped?.includes(partTitle(f).toLowerCase()));

/** The verdict with the findings a person dropped left out: a take-fix with none left is a take. */
export const verdictKept = <V extends string>(verdict: V, fixes: readonly { file: string; change: string; title?: string }[], dropped: readonly string[] | undefined): V | "take" =>
  verdict === "take-fix" && fixes.length > 0 && keptFixes(fixes, dropped).length === 0 ? "take" : verdict;
