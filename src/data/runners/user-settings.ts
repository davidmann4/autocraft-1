// Per-person Task Runner settings: the keys `repos`, `skip_tasks`, `task_items`, `manual_only`, `max_calls`, `reserve_five_hour`,
// `reserve_weekly`, `interactive_slots`, `runner_private` of `user_settings` (package runners-b).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { addAudit, type NewAudit } from "../control/index.ts";
import { dropSnapshotCache } from "./snapshot-cache.ts";
import type { LowerLogin, Reserve, UserSettings } from "./types.ts";

export const DEFAULT_RESERVE: Reserve = { fiveHour: 20, weekly: 20 };
export const MAX_RESERVE = 90;
export const MAX_CALLS_MAX = 64;
export const INTERACTIVE_SLOTS_MAX = 4;

const KEY = {
  repos: "repos", skipTasks: "skip_tasks", taskItems: "task_items", manualOnly: "manual_only", maxCalls: "max_calls",
  fiveHour: "reserve_five_hour", weekly: "reserve_weekly", interactiveSlots: "interactive_slots", runnerPrivate: "runner_private",
} as const;
/** The `user_settings` keys this module owns. */
export const USER_SETTING_KEYS: readonly string[] = Object.values(KEY);

const intIn = (v: string | undefined, lo: number, hi: number): number | null => {
  const n = v !== undefined ? Number(v) : NaN;
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};

const stringList = (v: string | undefined): string[] => {
  if (v === undefined) return [];
  try {
    const x = JSON.parse(v) as unknown;
    return Array.isArray(x) ? x.filter((i): i is string => typeof i === "string") : [];
  } catch {
    return [];
  }
};

/** The settings of one login from its stored rows: raw values with the defaults of a person who set nothing. Pure. */
export function settingsFrom(rows: readonly { key: string; value: string }[]): UserSettings {
  const v = new Map(rows.map((r) => [r.key, r.value] as const));
  const items = v.get(KEY.taskItems);
  return {
    reserve: { fiveHour: intIn(v.get(KEY.fiveHour), 0, MAX_RESERVE) ?? DEFAULT_RESERVE.fiveHour, weekly: intIn(v.get(KEY.weekly), 0, MAX_RESERVE) ?? DEFAULT_RESERVE.weekly },
    repos: stringList(v.get(KEY.repos)).sort(),
    maxCalls: intIn(v.get(KEY.maxCalls), 1, MAX_CALLS_MAX),
    interactiveSlots: intIn(v.get(KEY.interactiveSlots), 0, INTERACTIVE_SLOTS_MAX),
    manualOnly: v.get(KEY.manualOnly) === "1",
    skipTasks: stringList(v.get(KEY.skipTasks)),
    // "fast" is the value stored before fast track went; it meant the same narrowing, now to started work.
    taskItems: items === "mine" ? "mine" : items === "started" || items === "fast" ? "started" : "all",
    runnerPrivate: v.get(KEY.runnerPrivate) === "1",
  };
}

/** Groups `user_settings` rows by lower-case login into settings; `want` logins with no row get the defaults. */
export function settingsByLogin(rows: readonly { login: string; key: string; value: string }[], want: readonly string[] = []): Map<LowerLogin, UserSettings> {
  const by = new Map<LowerLogin, { key: string; value: string }[]>(want.map((l) => [l.toLowerCase(), []]));
  for (const r of rows) {
    const k = r.login.toLowerCase();
    const list = by.get(k);
    if (list) list.push(r);
    else by.set(k, [r]);
  }
  return new Map([...by].map(([login, list]) => [login, settingsFrom(list)]));
}

/**
 * Settings of the logins as raw values; defaults and task-id filtering are pure code. `"all"` reads every person's rows. Every
 * requested login is in the result, with the defaults when it set nothing.
 */
export async function loadUserSettings(db: Db, logins: string[] | "all"): Promise<Map<LowerLogin, UserSettings>> {
  if (logins !== "all" && !logins.length) return new Map();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.user_settings").select(["login", "key", "value"]).where(kx.inList(db, "key", USER_SETTING_KEYS))
    .$if(logins !== "all", (s) => s.where(kx.inList(db, "login", logins as string[], "citext"))));
  return settingsByLogin(rows, logins === "all" ? [] : logins);
}

/** The logins whose runners are private, for the live board. */
export async function loadPrivateLogins(db: Db, logins: string[]): Promise<Set<LowerLogin>> {
  const want = [...new Set(logins.map((l) => l.toLowerCase()))];
  if (!want.length) return new Set();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.user_settings").select("login").where("key", "=", KEY.runnerPrivate).where("value", "=", "1")
    .where((eb) => kx.inList(db, eb.fn<string>("lower", ["login"]), want)));
  return new Set(rows.map((r) => r.login.toLowerCase()));
}

type Stored = { key: string; value: string | null };

/** The rows a settings value is stored as: `value` null means no row (the value is the default). */
function storedOf(s: UserSettings): Stored[] {
  const dflt = settingsFrom([]);
  return [
    { key: KEY.repos, value: s.repos.length ? JSON.stringify(s.repos) : null },
    { key: KEY.skipTasks, value: s.skipTasks.length ? JSON.stringify(s.skipTasks) : null },
    { key: KEY.taskItems, value: s.taskItems === "all" ? null : s.taskItems },
    { key: KEY.manualOnly, value: s.manualOnly ? "1" : null },
    { key: KEY.maxCalls, value: s.maxCalls === null ? null : String(s.maxCalls) },
    { key: KEY.fiveHour, value: s.reserve.fiveHour === dflt.reserve.fiveHour ? null : String(s.reserve.fiveHour) },
    { key: KEY.weekly, value: s.reserve.weekly === dflt.reserve.weekly ? null : String(s.reserve.weekly) },
    // The default of an unset value depends on the person's role, so an explicit value is always kept.
    { key: KEY.interactiveSlots, value: s.interactiveSlots === null ? null : String(s.interactiveSlots) },
    { key: KEY.runnerPrivate, value: s.runnerPrivate ? "1" : null },
  ];
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Reads the old values, upserts changed keys, deletes keys set to their default and audits one row per changed setting. */
export async function saveUserSettings(db: Db, login: string, patch: Partial<UserSettings>, by: string): Promise<UserSettings> {
  const q = queryDb(db);
  return await db.write(async () => {
    const was = (await loadUserSettings(db, [login])).get(login.toLowerCase())!;
    const next: UserSettings = { ...was, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    const before = new Map(storedOf(was).map((r) => [r.key, r.value]));
    const changed = storedOf(next).filter((r) => before.get(r.key) !== r.value);
    const put = changed.filter((r): r is { key: string; value: string } => r.value !== null);
    const drop = changed.filter((r) => r.value === null).map((r) => r.key);
    const at = new Date().toISOString();
    if (put.length) {
      await q.run(q.k.insertInto("main.user_settings").values(put.map((r) => ({ login, key: r.key, value: r.value, updated_at: at })))
        .onConflict((oc) => oc.columns(["login", "key"]).doUpdateSet(kx.excluded(["value", "updated_at"]))));
    }
    if (drop.length) await q.run(q.k.deleteFrom("main.user_settings").where("login", "=", login).where(kx.inList(db, "key", drop)));
    const audit = (action: string, details: unknown): NewAudit => ({ login: by, action, target: login, details });
    const rows: NewAudit[] = [];
    if (!same(was.repos, next.repos)) rows.push(audit("my-repos", { repos: next.repos, was: was.repos }));
    if (!same(was.skipTasks, next.skipTasks)) rows.push(audit("my-tasks", { skipTasks: next.skipTasks, was: was.skipTasks }));
    if (was.taskItems !== next.taskItems) rows.push(audit("task-items", { items: next.taskItems, was: was.taskItems }));
    if (was.manualOnly !== next.manualOnly) rows.push(audit("manual-only", { manualOnly: next.manualOnly }));
    if (was.maxCalls !== next.maxCalls) rows.push(audit("max-calls", { maxCalls: next.maxCalls, was: was.maxCalls }));
    if (!same(was.reserve, next.reserve)) rows.push(audit("usage-reserve", { reserve: next.reserve, was: was.reserve }));
    if (was.interactiveSlots !== next.interactiveSlots) rows.push(audit("interactive-slots", { interactiveSlots: next.interactiveSlots, was: was.interactiveSlots }));
    if (was.runnerPrivate !== next.runnerPrivate) rows.push(audit("runner-private", { runnerPrivate: next.runnerPrivate }));
    if (rows.length) await addAudit(db, rows);
    // The snapshot embeds the settings: the person's next claim and the room follow the change.
    if (changed.length) db.afterCommit(() => dropSnapshotCache(db));
    return next;
  });
}
