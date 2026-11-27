// The review round of the author's new commits on a PR approved for merge (src/workflow/advance.ts runs it): whether a PR waits for it, and
// the head the approver accepted, for the review step and the review gate to act on.
import { authorRound, type OwnPush } from "./evidence.ts";
import type { Db } from "../db/index.ts";
import { loadOwnPushes } from "../data/views/own-pushes.ts";
import { loadPrWorkflows, type WorkflowFact } from "../data/workflow/index.ts";
import { RULE_STARTER } from "../workflow/types.ts";

/** A running workflow of the PR itself, approved for merge, whose author pushed past the head it accepted: its review is due at once. */
export const roundWaits = (w: (Pick<WorkflowFact, "approved" | "baseHead" | "own" | "state">) | null | undefined, pushes: readonly OwnPush[], head: string): boolean =>
  !!w && w.own && w.state === "running" && authorRound(w, pushes, head) !== null;

/**
 * When a person started the live workflow of the PR itself with a model review in its plan (entry review or fix-up, approved for merge or not) and
 * it is not waiting for a person (running or waiting): their request for a review of the current head. Null otherwise.
 */
export const personReviewSince = (w: (Pick<WorkflowFact, "entry" | "startedBy" | "startedAt" | "state">) | null | undefined): string | null =>
  w && w.startedBy !== RULE_STARTER && (w.entry === "review" || w.entry === "fixup") && (w.state === "running" || w.state === "waiting") ? w.startedAt : null;

/**
 * Review rounds of the author's commits on the PR made today (UTC) after `since`, the review at `head` left out: reviews by a model at heads our own
 * pushes did not make. A carried review, or one with no model call, is none. Where nobody answered since the start (`since` is `startedAt`), the
 * first such review is the one the start asked for, not a round.
 */
export function roundsToday(reviews: readonly { head: string; at: string; model: string | null; mode: string | null }[], pushes: readonly OwnPush[], o: { head: string; since: string; startedAt: string; now: number }): number {
  const ours = new Set(pushes.map((p) => p.to));
  const read = reviews.filter((r) => r.model !== null && r.mode !== "carried" && r.at > o.since && !ours.has(r.head)).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const day = new Date(o.now).toISOString().slice(0, 10);
  return read.slice(o.since === o.startedAt ? 1 : 0).filter((r) => r.at > day && r.head !== o.head).length;
}

/** The head the approver accepted when someone else's commits lead from it to the PR's `head_oid` (the PR's own live workflow, approved); null otherwise. */
export async function roundHeadOf(db: Db, c: { repo: string; number: number; head_oid: string }): Promise<string | null> {
  const ref = `${c.repo}#${c.number}`;
  const [workflows, pushes] = await db.together(() => Promise.all([loadPrWorkflows(db, [{ repo: c.repo, number: c.number }]), loadOwnPushes(db, [{ repo: c.repo, number: c.number }])]));
  const wf = workflows.get(ref);
  if (wf?.kind !== "pr" || wf.number !== c.number) return null;
  return authorRound({ approved: wf.approvedBy !== null, baseHead: wf.baseHead }, pushes.get(ref) ?? [], c.head_oid);
}

/** True when the PR's live workflow (its own, or an implementation PR's issue's) is approved for merge. */
export async function mergeApprovedOf(db: Db, c: { repo: string; number: number }): Promise<boolean> {
  return (await mergeApprovedIn(db, [c])).size > 0;
}

/** mergeApprovedOf() for a set of PRs: the `repo#number` of those approved for merge. */
export async function mergeApprovedIn(db: Db, refs: { repo: string; number: number }[]): Promise<Set<string>> {
  const wfs = await loadPrWorkflows(db, refs);
  return new Set([...wfs].filter(([, wf]) => wf.approvedBy !== null).map(([ref]) => ref));
}

/** When each PR's merge approval was given (`repo#number` → time; the start's time when the start approved it), for the PRs approved for merge. */
export async function mergeApprovalsIn(db: Db, refs: { repo: string; number: number }[]): Promise<Map<string, string>> {
  const wfs = await loadPrWorkflows(db, refs);
  return new Map([...wfs].filter(([, wf]) => wf.approvedBy !== null).map(([ref, wf]) => [ref, wf.approvedAt ?? wf.startedAt]));
}

/** Why a round's review was not made (the review's reason; src/workflow/advance.ts stops for the approver with it): the new commits could not be told apart from a PR too large to review whole. */
export const ROUND_UNSEPARATED = "the author's new commits could not be separated from the rest of this large pull request";
/** As `ROUND_UNSEPARATED`: what the new commits changed is itself over the review's size cap. */
export const ROUND_DELTA_LARGE = "the author's new commits are too large to review automatically";
