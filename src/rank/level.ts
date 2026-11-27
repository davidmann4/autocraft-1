// The urgency band of an item for queue ordering: the priority level after the security raise, from the stored work rank
// (src/rank/score.ts keeps the level in the ten-thousands digit): 4 for P0 down to 0 for P4.
import { LEVELS } from "../priority/score.ts";

/** The band of an unrated item. */
export const DEFAULT_BAND = LEVELS.length - 1 - LEVELS.indexOf("P2");

export const bandOf = (score: number | undefined): number => (score === undefined ? DEFAULT_BAND : Math.floor(score / 10000));
