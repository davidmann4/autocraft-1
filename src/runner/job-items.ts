// The items a job handled, for the item page: one job_items row per item (buffered by the jobs module), and the same line in
// the job log prefixed with the item ref, so a log parser can pick an item's lines out of the job log.
import { currentJobId } from "../agents/call.ts";
import type { Db } from "../db/index.ts";
import { loadItemJobTrail, noteJobItem } from "../data/jobs/index.ts";

/** `[owner/repo#n]`, the prefix of a job log line about one item. */
export const itemTag = (repo: string, number: number): string => `[${repo}#${number}]`;

/**
 * Records that the running job handled an item and logs the outcome (one line) under the item's tag. Stage code calls it once
 * per item it handled. Outside a job (a dry run, a direct command) nothing is stored; the line is still logged.
 */
export async function jobItem(db: Db, repo: string, number: number, outcome: string, log: (line: string) => void = console.log): Promise<void> {
  await noteJobItem(db, currentJobId(), repo, number, outcome, log);
}

export type ItemJob = { jobId: number; outcome: string | null; at: string };

/** The jobs that handled an item, oldest first. */
export async function itemJobs(db: Db, repo: string, number: number): Promise<ItemJob[]> {
  return ((await loadItemJobTrail(db, [{ repo, number }])).get(`${repo}#${number}`) ?? []).map((r) => ({ jobId: r.job_id, outcome: r.outcome, at: r.at }));
}
