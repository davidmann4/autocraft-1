import { UNSETTLED_PUSHES_MAX, pushesUnsettled } from "../data/control/index.ts";
import type { Db } from "../db/index.ts";

/** True, with a log line, when the repo has UNSETTLED_PUSHES_MAX pushes still waiting for their required checks: the step ends idle. */
export async function pushesAreUnsettled(db: Db, repo: string, log: (line: string) => void, now = new Date()): Promise<boolean> {
  const waiting = (await pushesUnsettled(db, [repo], now.getTime())).get(repo) ?? 0;
  if (waiting < UNSETTLED_PUSHES_MAX) return false;
  log(`  ${repo}: waiting: ${waiting} earlier pushes have no CI result yet`);
  return true;
}
