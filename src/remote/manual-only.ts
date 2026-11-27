// Each user's "Manual only" switch for their Task Runners (runners user settings, `manual_only`): the runners take only the
// calls the user picked ("Run on my Task Runner", picks.ts), calls for work they started or approved, and follow-ups of the
// user's own sessions (the claim in calls.ts). The planner's room (room.ts), the authors' give-way rule and the
// `remote-starved` health check leave such runners out. No row means off.
import type { Db } from "../db/index.ts";
import { loadUserSettings, saveUserSettings } from "../data/runners/index.ts";

export const MANUAL_ONLY_KEY = "manual_only";

export async function manualOnly(db: Db, login: string): Promise<boolean> {
  return (await loadUserSettings(db, [login])).get(login.toLowerCase())!.manualOnly;
}

/** A value from a request body, checked: a boolean; throws with the reason otherwise. */
export function parseManualOnly(raw: unknown): boolean {
  if (typeof raw !== "boolean") throw new Error("manualOnly must be true or false");
  return raw;
}

/** Stores the user's switch (off removes the row); a change is audited. */
export async function setManualOnly(db: Db, login: string, on: boolean): Promise<boolean> {
  return (await saveUserSettings(db, login, { manualOnly: on }, login)).manualOnly;
}
