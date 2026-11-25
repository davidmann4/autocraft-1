// The one recommendation an item comes back with, and the numbered plan it refers to. Pure: advance.ts gives it the latest
// review and the blocker, and records the result on the workflow row.
//
// The review writes the sentence and says what a yes runs (src/review/opus-parse.ts ReviewRecommendation), so the text and the run
// always agree. A blocker the review cannot speak for (author commits, a failing step, a large fix, files beyond the plan, a merge
// leg that stopped) gets a sentence built here from its facts.
import { t } from "../i18n/index.ts";
import type { ReviewFix, ReviewRecommendation } from "../review/opus-parse.ts";
import type { Found } from "./blockers.ts";
import { listText } from "./status.ts";
import type { PlanPart, Recommendation } from "./types.ts";

const TITLE_CHARS = 80;

/** A part's title: the review's own, else the start of its change. */
const titleOf = (f: ReviewFix): string => f.title ?? (f.change.replace(/\s+/g, " ").trim().slice(0, TITLE_CHARS) || f.file);

/**
 * The plan of a review's fixes, numbered from 1 in the review's order. A part a person dropped from the plan before (same title)
 * stays dropped; a part with no fix (the review asks for nothing) is no part.
 */
export function planOf(fixes: readonly ReviewFix[], before: readonly PlanPart[]): PlanPart[] {
  const dropped = new Set(before.filter((p) => p.state === "dropped").map((p) => p.title.toLowerCase()));
  return fixes.map((f, i) => {
    const title = titleOf(f);
    return { n: i + 1, title, source: "review" as const, file: f.file, ...(f.major ? { major: true } : {}), state: dropped.has(title.toLowerCase()) ? "dropped" as const : "planned" as const };
  });
}

export type ReviewView = { verdict: string; sure: boolean; rec: ReviewRecommendation | null };

const planned = (plan: readonly PlanPart[]): number[] => plan.filter((p) => p.state === "planned").map((p) => p.n);
const droppedOf = (plan: readonly PlanPart[]): number[] => plan.filter((p) => p.state === "dropped").map((p) => p.n);

/** "Fix 1 and 2, then merge." / "Fix 1, then come back." */
const fixText = (fix: readonly number[], merges: boolean): string => (merges
  ? t("Fix {parts}, then merge.", { parts: listText(fix) })
  : t("Fix {parts}, then come back with the result.", { parts: listText(fix) }));

/** The sentence for what a yes runs, when the review's own sentence does not say it. */
function textFor(r: { fix: readonly number[]; merges: boolean; close?: boolean; again?: "review" | "fixup" }): string {
  if (r.close) return t("Close it, as the review recommends.");
  if (r.fix.length) return fixText(r.fix, r.merges);
  if (r.again === "review") return r.merges ? t("Review it again, then merge.") : t("Review it again, then come back with the result.");
  return r.merges ? t("Merge it.") : t("Review it again, then come back with the result.");
}

/**
 * What the item comes back with when its steps are done and the merge is not approved: the review's recommendation when it gave
 * one (without the parts a person dropped; its sentence written again when the parts changed), else one built from its verdict: fix
 * the planned parts then merge, merge, close, or review again. A yes always runs something.
 */
export function afterSteps(review: ReviewView | null, plan: readonly PlanPart[]): Recommendation {
  const drop = droppedOf(plan);
  const rec = review?.rec;
  if (rec) {
    if (rec.close) return { text: rec.text || textFor({ fix: [], merges: false, close: true }), parts: { fix: [], drop }, merges: false, close: true };
    const fix = rec.fix.filter((n) => !drop.includes(n));
    // A person dropped every part the review wanted fixed: the rule below decides what is left.
    if (!rec.fix.length || fix.length) {
      const out: Recommendation = { text: "", parts: { fix, drop }, merges: rec.merge, ...(fix.length || rec.merge ? {} : { again: "review" as const }) };
      return { ...out, text: rec.text && fix.length === rec.fix.length ? rec.text : textFor({ fix, merges: rec.merge, ...(out.again ? { again: out.again } : {}) }) };
    }
  }
  const fix = planned(plan);
  if (review?.verdict === "close") return { text: textFor({ fix: [], merges: false, close: true }), parts: { fix: [], drop }, merges: false, close: true };
  if (review && (review.verdict === "hold" || !review.sure) && !fix.length) {
    return { text: textFor({ fix: [], merges: false, again: "review" }), parts: { fix: [], drop }, merges: false, again: "review" };
  }
  return { text: textFor({ fix, merges: true }), parts: { fix, drop }, merges: true };
}

/**
 * What an item stopped at a blocker comes back with. A yes resumes the plan with the merge still approved:
 * - a failing step runs again (the fix-up of the planned parts, a new review for a failing CI fix, a stuck implementation's Try again);
 * - findings of the pre-merge review (`params.premerge`: their plan parts) are fixed first, never merged as they are;
 * - a major finding or a change outside the purpose takes the review's own recommendation when it gave one;
 * - for the rest, what the blocker was about is accepted as it is.
 */
export function atBlocker(found: Found, review: ReviewView | null, plan: readonly PlanPart[]): Recommendation {
  const drop = droppedOf(plan);
  const go = (text: string, extra: Partial<Recommendation> = {}): Recommendation => ({ text, parts: { fix: [], drop }, merges: true, ...extra });
  const p = found.params;
  const premerge = (p.premerge as number[] | undefined) ?? null;
  if (premerge) {
    if (premerge.length) return { text: t("Fix the pre-merge review's findings {parts}, then merge.", { parts: listText(premerge) }), parts: { fix: premerge, drop }, merges: true };
    return go(t("Review it again, then merge."), { again: "review" });
  }
  switch (found.blocker) {
    case "author-commits": return go(t("Review the new commits, then merge."));
    case "failed-twice": {
      const answer = p.answer as Recommendation["answer"] | undefined;
      if (answer) return go(t("Start the implementation again, then merge."), { answer });
      if (p.step === "fix-up") {
        const fix = planned(plan);
        return fix.length ? { text: t("Try the fix-up of {parts} again, then merge.", { parts: listText(fix) }), parts: { fix, drop }, merges: true } : go(t("Try the fix-up again, then merge."), { again: "fixup" });
      }
      return go(t("Review it again with the failing checks, then merge."), { again: "review" });
    }
    case "large-fix": return go(t("Keep the fix of {lines} lines, then merge.", { lines: Number(p.lines ?? 0) }));
    case "beyond-agreed": return go(t("Keep the changes to {files}, then merge.", { files: listText((p.files as string[] | undefined) ?? []) }));
    case "outside-purpose":
    case "major-finding": {
      if (review?.rec) return afterSteps(review, plan);
      const fix = planned(plan).filter((n) => plan.find((x) => x.n === n)?.major);
      if (fix.length) return { text: fixText(fix, true), parts: { fix, drop }, merges: true };
      return found.blocker === "outside-purpose" ? go(t("Keep the {lines} lines outside the purpose, then merge.", { lines: Number(p.lines ?? 0) })) : go(t("Merge it as it is."));
    }
    case "other": return go(p.reason ? t("Go on with the merge after this stop: {reason}.", { reason: String(p.reason) }) : t("Go on with the merge."));
  }
}
