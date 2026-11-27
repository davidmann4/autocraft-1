// Which autorepins (src/repin/index.ts) have something to do now. Read from the database alone and without the modules the
// work needs, so the runner can ask on every tick. The due rule lives with the rows (src/data/workflow/repins.ts).
import { hasRepinDue, loadRepinsDue } from "../data/workflow/index.ts";
import type { Db } from "../db/index.ts";

/** An attempt that did not finish is tried again after this long. */
export const RETRY_MS = 60_000;
/** A lockfile task that has not ended this long after it was queued (no build worker took it, say) ends the autorepin. */
export const LOCK_MAX_MS = 3 * 3600_000;
/** With `via <branch>`: how often a merge not yet on that branch is looked for again, and how long after the merge it may take to get there. */
export const BRANCH_POLL_MS = 15 * 60_000;
export const BRANCH_MAX_MS = 7 * 24 * 3600_000;

export type RepinRow = {
  repo: string; number: number; ref_repo: string; ref_number: number; ref_branch: string | null; login: string; github_id: number; requested_at: string;
  state: "waiting" | "locking" | "pushed" | "failed" | "cancelled";
  sha: string | null; head: string | null; task_id: number | null; tries: number; to_head: string | null; result: string | null; notice: string | null;
};

/** The autorepins with a step to take, oldest first. */
export async function repinsDue(db: Db, now: Date = new Date()): Promise<RepinRow[]> {
  return (await loadRepinsDue(db, now)) as RepinRow[];
}

export async function anyRepinDue(db: Db, now: Date = new Date()): Promise<boolean> {
  return await hasRepinDue(db, now);
}
