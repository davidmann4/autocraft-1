// The level a queued call sorts by in the claim order (agents/call.ts sortQueue): the item's workflow weight, or its priority band.
import { loadRankScores } from "../data/triage/index.ts";
import { loadWorkWeights } from "../data/workflow/index.ts";
import type { Db } from "../db/index.ts";
import { LEVELS } from "../priority/score.ts";
import { bandOf, DEFAULT_BAND } from "../rank/level.ts";

/** Started items go before items nobody started, heavier ones first; the priority band orders the rest. */
export const claimLevel = (weight: number | null, band: number): number => (weight === null ? band : LEVELS.length - 1 + weight);

/** The claim level of each item (an unrated item counts as P2), keyed "repo#number". */
export async function claimLevels(db: Db, refs: readonly { repo: string; number: number }[]): Promise<Map<string, number>> {
  const keys = refs.map((r) => ({ repo: r.repo, number: r.number }));
  const [ranks, weights] = await db.together(() => Promise.all([loadRankScores(db, keys), loadWorkWeights(db, keys)]));
  return new Map(keys.map((r) => {
    const key = `${r.repo}#${r.number}`;
    return [key, claimLevel(weights.get(key) ?? null, bandOf(ranks.get(key)))];
  }));
}

/** The claim level of a call about `item`, the default band without one. */
export async function callLevel(db: Db, item: { repo: string; number: number } | undefined): Promise<number> {
  return item ? (await claimLevels(db, [item])).get(`${item.repo}#${item.number}`)! : DEFAULT_BAND;
}
