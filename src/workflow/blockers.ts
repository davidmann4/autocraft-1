// The six blockers of the maintainer workflow: when AutoCraft stops an item and comes back to a person even though the merge is
// approved. Pure: advance.ts reads the facts and records what this returns; the merge approval stays on the workflow row.
//
// Every detector looks only at what happened after `since`, the last time a person started, approved or answered the item: what
// they had seen then, they chose to go on with, so a yes after a blocker resumes instead of stopping again on the same evidence.
import type { Blocker, Entry } from "./types.ts";

export type BlockerFacts = {
  entry: Entry;
  approved: boolean;
  /** A push that is not ours moved the PR's head off the head the workflow last accepted (`base_head`). */
  authorPush: { from: string; to: string } | null;
  /** The review at the current head, when it was made after `since`. `majors`: numbers of the parts it marks major. */
  review: { verdict: string; sure: boolean; majors: number[]; outsideLines: number } | null;
  /** Steps whose tries failed since `since`, with how many failed. */
  failures: readonly { step: string; count: number }[];
  /** Our latest fix push since `since` (a fix-up), with its changed lines and files. */
  fix: { lines: number; files: readonly string[] } | null;
  /** The files the planned parts name; empty when none names one. */
  plannedFiles: readonly string[];
  /** Files an issue's implementation changed that no part of its plan names, not yet shown to a person. */
  implementationBeyond?: readonly string[];
  /** The merge leg (the pre-approved merge) stopped or was cancelled since `since`, with its reason. */
  leg: { reason: string } | null;
  thresholds: { largeFix: number; outsideMin: number };
};

export type Found = { blocker: Blocker; params: Record<string, unknown> };

/** A step failing this many times stops the item (blocker 3). */
export const FAILED_TWICE = 2;

/** A stopped merge leg's reason that is the pre-merge review's finding: its defects. An unsure review stops no workflow's merge leg. */
export const PREMERGE_STOP = /pre-merge review found/;

/**
 * The blocker a stopped merge leg's reason (src/preapproval) stands for. One failed try is `other`, shown with its reason: a step
 * failing twice is counted from the tries themselves (`failures`).
 */
export function legBlocker(reason: string): Blocker {
  if (/another push moved the head|the head went back/.test(reason)) return "author-commits";
  if (/the review says (hold|close)|verification failed/.test(reason) || PREMERGE_STOP.test(reason)) return "major-finding";
  if (/too-large/.test(reason)) return "large-fix";
  return "other";
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
  if (f.fix && f.fix.lines > f.thresholds.largeFix) return { blocker: "large-fix", params: { lines: f.fix.lines, limit: f.thresholds.largeFix } };
  if (f.fix && f.plannedFiles.length) {
    const planned = new Set(f.plannedFiles);
    const beyond = f.fix.files.filter((x) => !planned.has(x));
    if (beyond.length) return { blocker: "beyond-agreed", params: { files: beyond.slice(0, 10) } };
  }
  if (f.implementationBeyond?.length) return { blocker: "beyond-agreed", params: { files: f.implementationBeyond.slice(0, 10) } };
  const r = f.review;
  if (r && r.outsideLines >= f.thresholds.outsideMin) return { blocker: "outside-purpose", params: { lines: r.outsideLines, limit: f.thresholds.outsideMin } };
  // An unsure review is no blocker: the approval says the change is wanted, so its fixes run and the merge still waits for the
  // pre-merge review and green CI.
  if (r && (r.verdict === "hold" || r.verdict === "close" || r.majors.length)) {
    return { blocker: "major-finding", params: { verdict: r.verdict, sure: r.sure, parts: r.majors } };
  }
  if (f.leg) return { blocker: legBlocker(f.leg.reason), params: { reason: f.leg.reason } };
  return null;
}
