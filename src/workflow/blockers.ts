// The six blockers of the maintainer workflow: when AutoCraft stops an item and comes back to a person even though the merge is
// approved. Pure: advance.ts reads the facts and records what this returns; the merge approval stays on the workflow row.
//
// Every detector looks only at what happened after `since`, up to when the person who last started or answered the item has seen it (an
// answer: when its question was asked): what they had seen then, they chose to go on with, so a yes after a blocker resumes instead of stopping again on the same evidence.
import { stopCodeOf, type StopCode } from "../core/codes.ts";
import type { HeldPush } from "../core/decide.ts";
import type { Blocker, Entry } from "./types.ts";

export type BlockerFacts = {
  entry: Entry;
  approved: boolean;
  /** A push that is not ours moved the PR's head off the head the workflow last accepted (`base_head`). A PR's own workflow sends it to the review round instead (advance.ts), so it comes here as a blocker only for an issue's implementation PR. */
  authorPush: { from: string | null; to: string } | null;
  /** The review at the current head, when it was made after `since`. `majors`: numbers of the parts it marks major. */
  review: { verdict: string; sure: boolean; majors: number[]; outsideLines: number } | null;
  /** Steps whose tries failed since `since`, with how many failed. */
  failures: readonly { step: string; count: number }[];
  /** Our pushes since `since`: the files of the latest fix-up. */
  fix: { files: readonly string[] } | null;
  /** The files the planned parts name; empty when none names one. */
  plannedFiles: readonly string[];
  /** Files an issue's implementation changed that no part of its plan names, not yet shown to a person. */
  implementationBeyond?: readonly string[];
  /** The merge leg (the pre-approved merge) stopped or was cancelled since `since`, with its reason, and its code where the row has one. */
  leg: EndedLeg | null;
  /** A limit of the merge approval that holds our next step back: the pushes of ours since `since` (and the push held). */
  limit?: Limit | null;
  thresholds: { outsideMin: number };
};

export type EndedLeg = { reason: string; code?: StopCode | null; head?: string | null };

/** `pushes`: PUSHES_PER_APPROVAL pushes of ours were made, and `step` would push next. */
export type Limit = { kind: "pushes"; count: number; step: HeldPush };

/** Why the leg ended, its text's where the row has no code. */
export const codeOf = (leg: EndedLeg): StopCode => leg.code ?? stopCodeOf(leg.reason);

export type Found = { blocker: Blocker; params: Record<string, unknown> };

/** A step failing this many times stops the item (blocker 3). */
export const FAILED_TWICE = 2;

const PREMERGE_STOP = /pre-merge review found/;

/** The stopped merge leg's reason is the pre-merge review's finding: its defects. An unsure review stops no workflow's merge leg. */
export const premergeStop = (leg: EndedLeg): boolean => (leg.code ? leg.code === "premerge-defect" : PREMERGE_STOP.test(leg.reason));

/** Stops a check of the leg's head made: what they found is about that head's code, not about a later head. */
const HEAD_CHECKS: readonly StopCode[] = ["premerge-defect", "premerge-failed", "ci-failed", "verification-failed"];

/** The leg ended on a check of a head other than `head`. */
export const checkedOtherHead = (leg: EndedLeg, head: string): boolean => !!leg.head && leg.head !== head && HEAD_CHECKS.includes(codeOf(leg));

/**
 * The blocker a stopped merge leg (src/preapproval) stands for. One failed try is `other`, shown with its reason: a step
 * failing twice is counted from the tries themselves (`failures`).
 */
export function legBlocker(code: StopCode): Blocker {
  switch (code) {
    case "author-push": case "head-back": return "author-commits";
    case "review-hold": case "review-close": case "verification-failed": case "premerge-defect": return "major-finding";
    default: return "other";
  }
}

/**
 * The first blocker that applies, in the order a person needs them: someone else's commits first (everything after rests on code
 * nobody reviewed), then a step that keeps failing, then what the fixes did, then what the review found, then what stopped the
 * merge leg. Blockers bring back an approved item; an item not approved comes back with its recommendation anyway, so only a
 * failing step stops it early.
 */
export function detectBlocker(f: BlockerFacts): Found | null {
  const failed = f.failures.find((x) => x.count >= FAILED_TWICE);
  if (!f.approved) return failed ? { blocker: "failed-twice", params: { step: failed.step, count: failed.count } } : null;
  if (f.authorPush) return { blocker: "author-commits", params: { from: f.authorPush.from, to: f.authorPush.to } };
  if (failed) return { blocker: "failed-twice", params: { step: failed.step, count: failed.count } };
  if (f.fix && f.plannedFiles.length) {
    const planned = new Set(f.plannedFiles);
    const beyond = f.fix.files.filter((x) => !planned.has(x));
    if (beyond.length) return { blocker: "beyond-agreed", params: { files: beyond.slice(0, 10) } };
  }
  if (f.implementationBeyond?.length) return { blocker: "beyond-agreed", params: { files: f.implementationBeyond.slice(0, 10) } };
  // Our steps stop at the merge approval's limits before they push or merge the base branch again: the approver says whether they go on.
  const l = f.limit;
  if (l?.kind === "pushes") return { blocker: "other", params: { limit: l.kind, count: l.count, step: l.step, reason: `AutoCraft pushed ${l.count} changes since the approval, and the next one waits for an answer` } };
  const r = f.review;
  if (r && r.outsideLines >= f.thresholds.outsideMin) return { blocker: "outside-purpose", params: { lines: r.outsideLines, limit: f.thresholds.outsideMin } };
  // An unsure review is no blocker: the approval says the change is wanted, so its fixes run and the merge still waits for the
  // pre-merge review and green CI.
  if (r && (r.verdict === "hold" || r.verdict === "close" || r.majors.length)) {
    return { blocker: "major-finding", params: { verdict: r.verdict, sure: r.sure, parts: r.majors } };
  }
  if (f.leg) return { blocker: legBlocker(codeOf(f.leg)), params: { reason: f.leg.reason } };
  return null;
}
