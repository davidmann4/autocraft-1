// reads: (none; composes loaders)
// The Repos page and the Work queue's approval meta.
import type { Db } from "../../db/index.ts";
import * as control from "../control/index.ts";
import * as mirror from "../mirror/index.ts";
import * as workflow from "../workflow/index.ts";
import { openRecommendation } from "../../workflow/types.ts";
import type { QueueMeta, RepoFacts, Scope } from "./types.ts";

const WEEK_MS = 7 * 24 * 3600 * 1000;
const FAR = "9999-12-31";

/** The tracked repos of `scope.allRepos` with their open and merged-this-week counts, live workflows per repo and the active breakers. */
export async function loadMaintainRepos(db: Db, scope: Pick<Scope, "allRepos">, o: { nowMs: number }): Promise<RepoFacts> {
  const names = scope.allRepos;
  const since = new Date(o.nowMs - WEEK_MS).toISOString();
  const [tracked, open, mergedWeek, live, trips] = await db.together(() => Promise.all([
    control.loadTrackedRepos(db, names),
    mirror.countItems(db, { repos: names, states: ["OPEN"] }, "repo"),
    mirror.countItems(db, { repos: names, mergedBetween: [since, FAR] }, "repo"),
    workflow.listWorkflows(db, { live: true, repos: names }),
    control.loadTrips(db, { active: true }),
  ]));
  const per = new Map<string, { started: number; waiting: number }>();
  for (const w of live) {
    const c = per.get(w.repo) ?? per.set(w.repo, { started: 0, waiting: 0 }).get(w.repo)!;
    c.started++;
    if (openRecommendation(w)) c.waiting++;
  }
  return { repos: [...tracked.values()].sort((a, b) => (a.name < b.name ? -1 : 1)), open, mergedWeek, live: per, trips: [...trips.values()].sort((a, b) => a.trippedAt.localeCompare(b.trippedAt)) };
}

/** Who approved each started item for merge, by `repo#number`. */
export async function loadQueueMeta(db: Db, scope: Pick<Scope, "repos">): Promise<QueueMeta> {
  const [live, held] = await db.together(() => Promise.all([workflow.listWorkflows(db, { live: true, approved: true, repos: scope.repos }), workflow.loadHeldWorkflows(db, { repos: [...scope.repos] })]));
  return {
    held, approvedBy: new Map(live.map((w) => [`${w.repo}#${w.number}`, w.approvedBy!])),
  };
}
