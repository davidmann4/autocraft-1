// Each user's plan-usage reserve for the user-local helper (runners user settings). Only the user sets their own; the claim
// reply and the status reply carry it, and the helper claims only while every window keeps more than it free.
import type { Reserve } from "./protocol.ts";
import type { Db } from "../db/index.ts";
import { DEFAULT_RESERVE, loadUserSettings, MAX_RESERVE, saveUserSettings } from "../data/runners/index.ts";

export { DEFAULT_RESERVE, MAX_RESERVE };

/** The user's reserve, with the default for a window they never set. */
export async function userReserve(db: Db, login: string): Promise<Reserve> {
  return (await loadUserSettings(db, [login])).get(login.toLowerCase())!.reserve;
}

/** A reserve from a request body, checked; throws with the reason for a bad one. */
export function parseReserve(raw: unknown): Reserve {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("reserve must be an object with fiveHour and weekly");
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (k !== "fiveHour" && k !== "weekly") throw new Error(`reserve has no field ${k}`);
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_RESERVE;
  if (!ok(r.fiveHour) || !ok(r.weekly)) throw new Error(`reserve.fiveHour and reserve.weekly must be whole numbers from 0 to ${MAX_RESERVE}`);
  return { fiveHour: r.fiveHour, weekly: r.weekly };
}

/** Stores the user's reserve; a change is audited. */
export async function setUserReserve(db: Db, login: string, reserve: Reserve): Promise<Reserve> {
  return (await saveUserSettings(db, login, { reserve }, login)).reserve;
}
