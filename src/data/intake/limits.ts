// The three limits, from the settings snapshot of the unit of work (a read of the settings table when there is none).
import type { Db } from "../../db/index.ts";
import { readConfig, type Config } from "../control/index.ts";
import type { OutsideLimits } from "./types.ts";

export const LIMIT_KEYS = ["outside_prs_per_day", "outside_issues_per_day", "outside_surge_per_hour"] as const;
export const KEY_OF = { prsPerDay: LIMIT_KEYS[0], issuesPerDay: LIMIT_KEYS[1], surgePerHour: LIMIT_KEYS[2] } as const;

const of = (c: Config): OutsideLimits => ({ prsPerDay: c.outsidePrsPerDay, issuesPerDay: c.outsideIssuesPerDay, surgePerHour: c.outsideSurgePerHour });

/** Inside `withConfig` no statement; outside it one read that joins the caller's `together` wave. */
export async function limitsOf(db: Db): Promise<OutsideLimits> {
  return of(await readConfig(db, LIMIT_KEYS));
}

export const RULE_KEYS = ["whitelist_min_merged", "whitelist_min_merge_rate"] as const;

/** The whitelist rule, read as `limitsOf` reads the limits. */
export async function ruleOf(db: Db): Promise<{ minMerged: number; minRate: number }> {
  const c = await readConfig(db, RULE_KEYS);
  return { minMerged: c.whitelistMinMerged, minRate: c.whitelistMinMergeRate };
}
