// Queue position: the place of an open item among the items whose next step is the same queued stage.
// Items are those in the pipeline's scope, ordered by the work rank with started items first (their workflow weight); the Merge
// stage follows the Merge tab's order. Items whose next step is not a queued stage (a person's answer, a running job, held, done) have none.
// The place is current, not an estimate.
import type { QueueSlot } from "../../web/src/api/types.ts";
import type { Db } from "../db/index.ts";
import { loadQueuedSteps } from "../data/views/queue-places.ts";

/** Next step text → queued stage and the Queue tab that lists it. Steps not listed here are not queued. */
const QUEUED: Record<string, Pick<QueueSlot, "stage" | "tab">> = {
  Review: { stage: "Review", tab: "review" },
  Fix: { stage: "Fix", tab: "fix" },
  "Fix-up": { stage: "Fix-up", tab: "fix" },
  Verify: { stage: "Verify", tab: "verify" },
  "Merge queue": { stage: "Merge", tab: "merge" },
};

const BATCHED = new Set(["batch-checking", "in-batch"]);

type Entry = { repo: string; number: number; score: number } & Pick<QueueSlot, "stage" | "tab">;
export type Stages = Map<string, Entry[]>;

/** The Merge tab's order, the same as every other stage's: started items first, then the work rank, then repo and number. Batched PRs are listed under their batch, not here. */
export function mergeOrder<T extends { repo: string; number: number; state?: string }>(entries: T[], score: (e: T) => number): T[] {
  return entries.filter((e) => !BATCHED.has(e.state ?? "")).sort((a, b) => score(b) - score(a) || a.repo.localeCompare(b.repo) || a.number - b.number);
}

/** Orders items by stage: best first by score. */
export function orderStages(items: { repo: string; number: number; score: number; next: string }[]): Stages {
  const by: Stages = new Map();
  for (const i of items) {
    const q = QUEUED[i.next];
    if (!q) continue;
    const list = by.get(q.stage) ?? [];
    list.push({ repo: i.repo, number: i.number, score: i.score, ...q });
    by.set(q.stage, list);
  }
  for (const list of by.values()) list.sort((a, b) => b.score - a.score || a.repo.localeCompare(b.repo) || a.number - b.number);
  return by;
}

/** Orders the pipeline's open ranked items by stage, from the Plan cache: the next-step text of each item in scope, and the batch states of the PRs. One wave. */
export async function computeStages(db: Db): Promise<Stages> {
  // Batched PRs are listed under their batch on the Merge tab.
  return orderStages((await loadQueuedSteps(db, Object.keys(QUEUED))).filter((s) => s.next !== "Merge queue" || !BATCHED.has(s.state)));
}

/** Slots of `repo#number` for the items in `visible` repos; places count only visible items. Pure over the ordered stages. */
export function slotsOf(byStage: Stages, visible: Iterable<string>): Map<string, QueueSlot> {
  const seen = new Set(visible);
  const out = new Map<string, QueueSlot>();
  for (const list of byStage.values()) {
    let place = 0;
    for (const e of list) {
      if (!seen.has(e.repo)) continue;
      const key = `${e.repo}#${e.number}`;
      out.set(key, { stage: e.stage, tab: e.tab, place: ++place });
    }
  }
  return out;
}

/** One pass for all items: call it once per request, not per item. */
export const queueSlots = async (db: Db, visible: Iterable<string>): Promise<Map<string, QueueSlot>> => slotsOf(await computeStages(db), visible);
