// Types and counting of the cached queue entries (the Plan cache is read through data/planner and data/views/queue.ts).
import type { QueueView } from "./plan-cache.ts";
import { QUEUE_STATES, type QueueState } from "./plan.ts";
import type { HiddenRepos } from "../data/control/types.ts";

/** A PR in a queue state, as the merge queue lists it: the Plan's state, reasons and note, and the cached queue fields. */
export type CachedEntry = QueueView & {
  repo: string; number: number; title: string; state: QueueState; outsideRule: string[]; note: string | null;
  /** GitHub state as mirrored; a PR the pipeline merged counts as merged in `state` before the mirror says so. */
  gh: "OPEN" | "MERGED" | "CLOSED";
};

export type CachedQueueOptions = {
  repo?: string;
  /** Which PRs by GitHub state: open ones only, merged ones only, or both (default). */
  merged?: "exclude" | "only" | "all";
  /** Keyset page: entries after this PR in (repo, number) order, at most `limit` of them. */
  after?: { repo: string; number: number };
  limit?: number;
  /** Repos left out: a list from the dashboard's `hiddenRepos` allows only the repos it names as visible. */
  hidden?: HiddenRepos;
  /** Only these PRs, as "repo#number". */
  refs?: Iterable<string>;
};

export function countStates(entries: { state: QueueState }[]): Record<QueueState, number> {
  const c = Object.fromEntries(QUEUE_STATES.map((s) => [s, 0])) as Record<QueueState, number>;
  for (const e of entries) c[e.state]++;
  return c;
}
