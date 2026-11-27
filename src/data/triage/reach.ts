// Reach of an open item: the tie-breaker inside a priority level, from the mirror's reach signals. Pure.
//
//   commenters  0.25  distinct comment authors, capped at 8
//   comments    0.20  comment count, capped at 20
//   linked      0.15  PRs that close the issue, or issues the PR closes, capped at 3
//   duplicates  0.15  confirmed duplicates pointing at the item as the canonical one, capped at 5
//   security    0.15  a classifier raised the security flag
//   age         0.10  days open, capped at 365
export type Reach = {
  comments: number;
  commenters: number;
  linked: number;
  duplicates: number;
  security: boolean;
  ageDays: number;
};

const frac = (n: number, cap: number): number => Math.min(Math.max(n, 0), cap) / cap;

export function reachOf(r: Reach): number {
  return 0.25 * frac(r.commenters, 8) + 0.20 * frac(r.comments, 20) + 0.15 * frac(r.linked, 3) + 0.15 * frac(r.duplicates, 5)
    + 0.15 * (r.security ? 1 : 0) + 0.10 * frac(r.ageDays, 365);
}

/** Reach as a whole number from 0 to 99. */
export const reachScore = (r: Reach): number => Math.min(99, Math.round(reachOf(r) * 99));
