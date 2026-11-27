// Who makes the next fix of an approved PR: one of our steps, the contributor, or nobody but a person. Pure; the merge leg waits for the first two.
import { cifixBucket, decidePr, fixupOf, mergeOwned, reviseOf } from "../core/decide.ts";
import { clipText } from "../prose.ts";
import { ownImplementation } from "../core/implementation.ts";
import type { PrFacts } from "../core/plan.ts";

export type FixPath = "fix" | "contributor" | null;

/** Our implementation PR whose revision by its session is planned or running: the review's fixes and red CI are its to repair. */
export const revisesNow = (f: PrFacts): boolean => !!reviseOf(f) || ownImplementation(f)?.state === "revising";

/**
 * Who repairs red CI at the leg's head: the CI fix step (or the implementation session), while it works the PR or the planner lists it, or the
 * contributor, who was asked or is asked next. Null when nobody but a person can go on: a step the planner does not list (not approved, held,
 * merge blocked) never moves the PR on, nobody is asked about CI our own push broke, and a PR of our own, or one nothing is said on, has nobody
 * to ask. A PR a person approved for merge is never handed to its contributor (core/decide.ts mergeOwned): once the CI fix gives up, the
 * contributor is left out and the leg stops for that person; only a patch the CI fix posted as a comment waits for them.
 */
export function redCiPath(f: PrFacts | null): FixPath {
  if (!f) return null;
  if (revisesNow(f)) return "fix";
  const b = cifixBucket(f), states = f.cifix?.states ?? [];
  const next = decidePr(f).actions.find((a) => a.kind === "cifix")?.params?.bucket;
  switch (b) {
    case "formatting": case "linting": case "rerun-wait": case "ci-running": case "read-wait": return "fix";
    case "work": case "collect": case "rerun": return next === b ? "fix" : null;
    case "done":
      if (f.cifix?.askedPatch || (states.includes("asked") && !mergeOwned(f))) return f.authorIsPipeline ? null : "contributor";
      return states.includes("pushing") && !states.includes("comment-failed") && f.cifix?.unsent !== "final" ? "fix" : null;
    case "comment-wait": case "failed": case "capped": return !f.quiet && !f.brokeByUs && !f.authorIsPipeline && (b === "comment-wait" || next === "ask") ? "contributor" : null;
    default: return null;
  }
}

/**
 * Nobody makes the fixes that the take-fix review at the head asks for: they name files no fix-up may touch, or the fix-up cannot run and
 * nobody is asked for them. A push that only waits for its approval, and what our implementation's session is asked, are somebody's.
 */
export function nobodyFixes(f: PrFacts): boolean {
  const r = f.review, fx = fixupOf(f);
  if (fx) return fx.bucket !== "unapproved" && fixPath(f) === null;
  return f.fixup?.fixes === 0 && r?.verdict === "take-fix" && r.head === f.head && !r.stale && f.mergeable !== "CONFLICTING" && !f.changesRequested && !ownImplementation(f);
}

/** As `nobodyFixes`, once the merge is approved, and a fix-up that a person asks for cannot make them either. */
export const nobodyFixesFor = (f: PrFacts): boolean =>
  (f.fixup?.fixes === 0 || !f.pushable) && nobodyFixes(f.workflow ? { ...f, workflow: { ...f.workflow, approved: true } } : f);

/** Who makes the fixes of the take-fix review at the leg's head, as `redCiPath`. */
export function fixPath(f: PrFacts): FixPath {
  const fx = fixupOf(f);
  switch (fx?.bucket) {
    case "fix": return "fix";
    // Pushed, or stored for its lint run; a push the branch refused, or tries used up with nobody asked, moves the PR no more.
    case "hold": return f.fixup?.recorded.some((s) => s === "pushed" || s === "linting") ? "fix" : null;
    case "ask": case "ask-retry": case "asked": return f.authorIsPipeline ? null : "contributor";
    default: return null;
  }
}

/** Characters of the CI fix's last reason a stop names. */
const LAST_TRY_CHARS = 200;

/** The stop of a leg whose red CI the CI fix did not repair: which required checks fail, and what the CI fix tried at the head. */
export function redCiStopReason(f: PrFacts | null, head: string): string {
  const c = f?.cifix;
  const shown = c?.failing.slice(0, 3) ?? [];
  const checks = shown.length ? ` (${shown.join(", ")}${(c?.failing.length ?? 0) > shown.length ? ", …" : ""})` : "";
  const last = c?.lastTry ? clipText(c.lastTry, LAST_TRY_CHARS) : null;
  const tried = !c ? "" : c.tries ? `: ${c.tries} ${c.tries === 1 ? "try" : "tries"} at this commit${last ? `, the last: ${last}` : ""}` : last ? `: ${last}` : "";
  return `CI failed at ${head}${checks} and the CI fix did not repair it${tried}`;
}
