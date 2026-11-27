// What counts against the Act step's daily limit: the Act jobs' items and the GitHub writes that conversation cards made.
import { loadActLimit, loadActUsage } from "../data/control/index.ts";
import type { Db } from "../db/index.ts";

/** Items of Act jobs plus finished, successful conversation-card GitHub writes since the later of the UTC day start and the operator's last reset of the Act count. */
export async function actUsedToday(db: Db, ms: number = Date.now()): Promise<number> {
  return await loadActUsage(db, `${new Date(ms).toISOString().slice(0, 10)}T00:00:00.000Z`);
}

/** The Act step's daily limit, or null when it has none. */
export async function actLimit(db: Db): Promise<number | null> {
  return await loadActLimit(db);
}
