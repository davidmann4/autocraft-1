// Work leases: one job at a time works a PR, issue or finding. Rows are bookkeeping (not a planner input topic).
// A lease whose job is not running counts as free, so a crash leaves nothing behind.
import { currentJob } from "../agents/call.ts";
import type { Db } from "../db/index.ts";
import { releaseLeases, takeLeases } from "../data/jobs/index.ts";

let skipped = 0;
/** Items this process skipped because another job held their lease. */
export const leaseSkips = (): number => skipped;
const skippedKeys = new Set<string>();
let ran = 0;
/**
 * The lease keys this process skipped, at most 500, and with any skip a UNITS_RAN key that counts the pool units that ran: the
 * planner parks a job for its takers only when every unit was a skip for want of a taker (src/runner/autopilot.ts).
 */
export const leaseSkipKeys = (): string[] => [...skippedKeys, ...(ran ? [`${UNITS_RAN}${ran}`] : [])];

/** The prefix of the skip key of a call withdrawn for lack of a taker, or of a pool unit left unstarted for that reason: no lease; the planner's taker signature wakes the step. */
export const NO_TAKER_SKIP = "no-taker:";
/** The prefix of the key that counts the pool units this process ran to an end other than a skip for want of a taker: no lease. */
export const UNITS_RAN = "units-ran:";

/** Counts a pool unit that ran and ended other than by a skip for want of a taker (it may have written nothing, e.g. builds still running). */
export function unitRan(): void {
  ran++;
}

/** Counts an item left for a later job (like a held lease) so the planner retries it, and logs why. `label`: the item as the log names it (default the key). */
export function skipItem(key: string, log: (line: string) => void, why: string, label: string = key): void {
  skipped++;
  if (skippedKeys.size < 500) skippedKeys.add(key);
  log(`  ${label}: skipped: ${why}`);
}

/** Takes the lease for the job. False when another running job holds it. */
export async function take(db: Db, key: string, jobId: number, step: string): Promise<boolean> {
  return (await takeLeases(db, [key], { id: jobId, step })).has(key);
}

export async function release(db: Db, key: string, jobId: number): Promise<void> {
  await releaseLeases(db, { keys: [key], jobId });
}

/**
 * Leases the item for the job this process runs and returns what ends the lease, or null (one line logged) when
 * another running job holds it: the caller skips the item without counting it. Outside a job (command line) there is
 * no holder to record, so the item is free. Call it once per item at the outermost site. Takes of one key do not nest: the same job may take a key it holds, but the inner release frees the outer lease too.
 */
export async function leaseItem(db: Db, key: string, log: (line: string) => void): Promise<(() => Promise<void>) | null> {
  const job = currentJob();
  if (!job) return async () => {};
  if (!await take(db, key, job.id, job.step)) {
    skipItem(key, log, "another job is working it");
    return null;
  }
  return async () => await release(db, key, job.id);
}
