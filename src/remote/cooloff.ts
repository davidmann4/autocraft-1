// Cool-off of the user-local mode, per login: a login whose helpers keep losing leases (no heartbeat, past a time limit) or
// keep failing calls (`ok: false` replies in a row) gets no calls for a while, so a broken helper stops holding and failing
// calls other helpers could run. Revoking a token does not end it; an operator does (`autocraft-server remote cooloff clear`).
// The rules live in the runners module (noteDrops, noteFailure); this file names them for feature code.
import type { Db } from "../db/index.ts";
import * as runners from "../data/runners/index.ts";

export { COOLOFF_MS, DROP_DEDUPE_MS, DROP_LIMIT, DROP_REASON, DROP_WINDOW_MS, FAILURE_COOLOFF_MS, FAILURE_LIMIT, FAILURE_REASON, FAILURE_WINDOW_MS, noteDrops, noteFailure } from "../data/runners/index.ts";

/** An accepted reply ends the login's run of failures. */
export const noteSuccess = async (db: Db, login: string): Promise<void> => await runners.noteSuccess(db, [login]);

/** When the login's helpers may claim again and why they may not now, or null when the login is not cooling off. */
export async function cooloffOf(db: Db, login: string, nowMs: number): Promise<{ until: number; reason: string } | null> {
  const c = (await runners.loadCooloffs(db, [login], nowMs)).get(login.toLowerCase());
  return c ? { until: Date.parse(c.until), reason: c.reason } : null;
}

/** Ends the login's cool-off and forgets its drops and failures; false when it was not cooling off. */
export async function clearCooloff(db: Db, login: string, by: string, nowMs: number = Date.now()): Promise<boolean> {
  return await runners.clearCooloff(db, login, by, nowMs);
}
