// Each user's "Max calls at once" for their user-local helpers (runners user settings, `max_calls`): the most calls all their
// helpers hold leases on together (claimCall). No row means no limit.
import type { Db } from "../db/index.ts";
import { loadUserSettings, MAX_CALLS_MAX, saveUserSettings } from "../data/runners/index.ts";

export { MAX_CALLS_MAX };
export const MAX_CALLS_KEY = "max_calls";

/** The user's limit, or null for none. */
export async function userMaxCalls(db: Db, login: string): Promise<number | null> {
  return (await loadUserSettings(db, [login])).get(login.toLowerCase())!.maxCalls;
}

/** A limit from a request body, checked: a whole number from 1 to MAX_CALLS_MAX, or null for none; throws with the reason for a bad one. */
export function parseMaxCalls(raw: unknown): number | null {
  if (raw === null) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MAX_CALLS_MAX) throw new Error(`maxCalls must be a whole number from 1 to ${MAX_CALLS_MAX}, or null for no limit`);
  return raw;
}

/** Stores the user's limit (null removes it); a change is audited. */
export async function setUserMaxCalls(db: Db, login: string, max: number | null): Promise<number | null> {
  return (await saveUserSettings(db, login, { maxCalls: max }, login)).maxCalls;
}
