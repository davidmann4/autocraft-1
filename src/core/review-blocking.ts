// What a review asks of a PR a maintainer approved for merge: only its blocking fixes are made and only a blocking hold stops it.
// The approval and green CI merge it past the rest, which are filed as follow-ups (src/premerge/followups.ts). Elsewhere every fix
// and hold counts. A fix or hold without a class (stored before reviews classed them, or a reply that gave none) blocks.
import { notBlocking, type Blocking } from "../premerge/types.ts";
import { keptFixes } from "../workflow/work.ts";

type Fix = { file: string; change: string; title?: string; blocking?: Blocking };

/** The fixes the pipeline makes: the ones no person dropped, and on a PR approved for merge (`approved`) only the blocking ones. */
export const fixesToMake = <F extends Fix>(fixes: readonly F[], dropped: readonly string[] | undefined, approved: boolean): F[] =>
  keptFixes(fixes, dropped).filter((f) => !approved || !notBlocking(f));

/** The fixes of a PR approved for merge that do not block it and no person dropped: filed as follow-ups, not made. */
export const followUpFixes = <F extends Fix>(fixes: readonly F[], dropped: readonly string[] | undefined): F[] => keptFixes(fixes, dropped).filter(notBlocking);

/**
 * A hold on a PR approved for merge whose reason does not block: the PR goes on as on a take, and the reason is filed as a follow-up.
 * A hold that waits for other items (`blockedBy`) always stops it, so it never merges ahead of what it depends on.
 */
export const holdGoesOn = (verdict: string, hold: Blocking | null | undefined, approved: boolean, blockedBy: readonly string[] = []): boolean =>
  approved && verdict === "hold" && !!hold && hold.class === null && !blockedBy.length;

/** The verdict the pipeline acts on: a take-fix with no fix left to make, or a hold that goes on, is a take. */
export const verdictToAct = <V extends string>(verdict: V, fixes: readonly Fix[], dropped: readonly string[] | undefined, approved: boolean, hold?: Blocking | null, blockedBy: readonly string[] = []): V | "take" =>
  holdGoesOn(verdict, hold, approved, blockedBy) || (verdict === "take-fix" && fixes.length > 0 && fixesToMake(fixes, dropped, approved).length === 0) ? "take" : verdict;

/** A review as the follow-up rules read it: its verdict, fixes, hold class and the items a hold waits for. */
export type ReviewForFollowUps<F extends Fix> = { verdict: string; fixes: readonly F[]; hold?: Blocking | null; blockedBy?: readonly string[] };

/**
 * What the review of a PR approved for merge files as follow-ups: its fixes that do not block it and nobody dropped, and the reason of
 * a hold that goes on (null when the hold gave none: there is nothing to file).
 */
export const reviewFollowUps = <F extends Fix>(r: ReviewForFollowUps<F>, dropped: readonly string[] | undefined): { fixes: F[]; hold: string | null } => ({
  fixes: r.verdict === "take-fix" ? followUpFixes(r.fixes, dropped) : [],
  hold: holdGoesOn(r.verdict, r.hold, true, r.blockedBy) && r.hold!.why.trim() ? r.hold!.why : null,
});

/** A review's claim as the follow-up rules read it: its impact and the fix it named. */
type ClaimLike = { impact?: string; fix?: { file: string; change: string } };

/**
 * The code-incomplete claims (the PR does part of what it says) that the review of a PR approved for merge files as follow-ups, while the
 * pipeline goes on with the review as a take or take-fix (`goesOn`: also a hold that does not block, or one a person answered and the leg
 * went past): the ones it did not turn into one of its fixes. A claim turned into a fix is filed or made as that fix, so it is not listed
 * twice. `r` is the review whose text a carried review comes from (src/review/post-source.ts): a carry after our fix-up keeps that
 * review's claims, since no fix-up targets a claim that named no fix.
 */
export const followUpClaims = <C extends ClaimLike>(r: { verdict: string; fixes: readonly Fix[]; claims: readonly C[] }, goesOn: boolean): C[] => {
  if (!goesOn) return [];
  const listed = (c: C) => !!c.fix && r.verdict === "take-fix" && r.fixes.some((f) => f.file === c.fix!.file && f.change === c.fix!.change);
  return r.claims.filter((c) => c.impact === "code-incomplete" && !listed(c));
};

/**
 * The planned parts of a review's plan (src/workflow/recommend.ts planOf numbers them from 1 in the order of `fixes`) that the pipeline
 * makes: on a PR approved for merge only the blocking ones. A part that does not block is filed, so it neither runs a fix-up nor stops the merge as a major finding.
 */
export const partsToMake = <P extends { n: number; state: string }>(plan: readonly P[], fixes: readonly Fix[], approved: boolean): P[] =>
  plan.filter((p) => { const f = fixes[p.n - 1]; return p.state === "planned" && !(approved && f && notBlocking(f)); });
