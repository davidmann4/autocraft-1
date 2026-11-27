// Each user's "Private Task Runner" switch (runners user settings, `runner_private`). The Live board's worker view shows the
// calls of a private user's runners under one neutral row, with no login, label, slots or models; the user still sees their
// own runners as theirs. No row means shared.
import type { Db } from "../db/index.ts";
import { loadPrivateLogins, loadUserSettings, saveUserSettings } from "../data/runners/index.ts";

export async function runnerPrivate(db: Db, login: string): Promise<boolean> {
  return (await loadUserSettings(db, [login])).get(login.toLowerCase())!.runnerPrivate;
}

/** The lowercased logins among `logins` that keep their runners private. */
export async function privateLogins(db: Db, logins: readonly string[]): Promise<Set<string>> {
  return await loadPrivateLogins(db, [...logins]);
}

/** A value from a request body, checked: a boolean; throws with the reason otherwise. */
export function parseRunnerPrivate(raw: unknown): boolean {
  if (typeof raw !== "boolean") throw new Error("runnerPrivate must be true or false");
  return raw;
}

/** Stores the user's switch (off removes the row); a change is audited. */
export async function setRunnerPrivate(db: Db, login: string, on: boolean): Promise<boolean> {
  return (await saveUserSettings(db, login, { runnerPrivate: on }, login)).runnerPrivate;
}
