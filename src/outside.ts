// Protection of model spend from authors outside the team (docs/pipeline.md, "Outside authors"). The rules and every query live in
// src/data/intake; this file keeps the names feature code calls and passes the module the one policy it takes as an argument:
// which author accounts the Contributors rule whitelists (src/whitelist.ts).
import { whitelistVerdict } from "./whitelist.ts";
import type { Db } from "./db/index.ts";
import * as intake from "./data/intake/index.ts";
import type { HiddenRepos, Hold, OutsideLimits, OutsideState } from "./data/intake/index.ts";

export { OutsideError } from "./data/intake/index.ts";
export const OUTSIDE_SURGE = "outside-surge";
export type { Hold, OutsideLimits, OutsideState } from "./data/intake/index.ts";
export type OutsideRefresh = { holds: Hold[]; tripped: boolean; wakeAt: number | null };

export async function refreshOutsideHolds(db: Db, now: number = Date.now(), own?: ReadonlySet<string>): Promise<OutsideRefresh> {
  return await intake.recomputeHolds(db, { now, whitelist: whitelistVerdict, ...(own ? { own } : {}) });
}

/** Stores the three numbers (0 turns a protection off) and audits the change. */
export async function setOutsideLimits(db: Db, by: string, input: unknown): Promise<OutsideLimits> {
  return await intake.saveOutsideLimits(db, by, input);
}

export const holdWait = intake.holdWait;

/** An operator exempts one held item from both holds. */
export async function releaseOutside(db: Db, by: string, repo: string, number: number): Promise<void> {
  await intake.releaseHeld(db, by, [{ repo, number }]);
}

/** An operator exempts every item now held for one author. Returns how many. */
export const releaseAuthor = intake.releaseAuthor;

export async function outsideState(db: Db, hidden: HiddenRepos = []): Promise<OutsideState> {
  return await intake.loadOutsideState(db, hidden);
}

/** Whether a PR or issue row is by an outside author. `inside` may be passed when many rows are judged. */
export async function isOutsideAuthor(db: Db, r: { author: string | null; author_association: string | null; author_type: string | null }, inside?: Set<string>): Promise<boolean> {
  return intake.isOutsideAuthor(r, inside ?? await intake.loadInsiders(db));
}
