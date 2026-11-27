// Each user's "Interactive slots" for their user-local helpers (runners user settings, `interactive_slots`): the calls all
// their helpers may hold on the interactive lane together (claimCall with `interactiveLane`). Only interactive calls
// (INTERACTIVE_PROMPTS) use these slots, and interactive calls use no other slot. No row means the role's default.
import type { Db } from "../db/index.ts";
import { INTERACTIVE_SLOTS_MAX, loadUserSettings, saveUserSettings } from "../data/runners/index.ts";

export { INTERACTIVE_SLOTS_MAX };
export const INTERACTIVE_SLOTS_KEY = "interactive_slots";
/** Prompt id prefixes of calls a person waits for; each is withdrawn after a few seconds without a taker, so it takes only a free interactive slot. */
export const INTERACTIVE_PROMPTS: readonly string[] = ["discord.", "interactive."];
/** The first helper version that runs the interactive lane; older ones are offered interactive calls in their ordinary claims. */
export const INTERACTIVE_HELPER = "1.4.0";
export const interactive = (r: { prompt_id: string }): boolean => INTERACTIVE_PROMPTS.some((p) => r.prompt_id.startsWith(p));

/** The slots of a stored value (undefined: no row): the role's default, 1 for an operator and 0 for others. */
export function interactiveSlotsOf(value: string | undefined, role: string): number {
  const n = value !== undefined ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= INTERACTIVE_SLOTS_MAX ? n : role === "operator" ? 1 : 0;
}

/** The slots of a loaded setting (null: never set). */
export const slotsOf = (stored: number | null, role: string): number => stored ?? (role === "operator" ? 1 : 0);

export async function userInteractiveSlots(db: Db, login: string, role: string): Promise<number> {
  return slotsOf((await loadUserSettings(db, [login])).get(login.toLowerCase())!.interactiveSlots, role);
}

/** A count from a request body, checked: a whole number from 0 to INTERACTIVE_SLOTS_MAX; throws with the reason for a bad one. */
export function parseInteractiveSlots(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > INTERACTIVE_SLOTS_MAX) throw new Error(`interactiveSlots must be a whole number from 0 to ${INTERACTIVE_SLOTS_MAX}`);
  return raw;
}

/** Stores the user's slots; a change is audited. */
export async function setUserInteractiveSlots(db: Db, login: string, role: string, slots: number): Promise<number> {
  return slotsOf((await saveUserSettings(db, login, { interactiveSlots: slots }, login)).interactiveSlots, role);
}
