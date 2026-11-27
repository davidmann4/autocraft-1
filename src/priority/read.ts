import type { PriorityInfo } from "../../web/src/api/types.ts";
import { loadPriorities } from "../data/triage/index.ts";
import type { Db } from "../db/index.ts";

/** The badge data for one item, or null before it was rated. */
export async function priorityOf(db: Db, repo: string, number: number): Promise<PriorityInfo | null> {
  const r = (await loadPriorities(db, [{ repo, number }])).get(`${repo}#${number}`);
  return r ? { level: r.impact, model: r.model, reason: r.reason } : null;
}
