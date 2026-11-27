// The process cache of the GitHub identity used by GitHub reads (M03 access-a). Postgres: invalidated by the `settings`
// notification topic plus a 10 s safety re-read. SQLite: the settings counter read stays inside this file.
import type { Db, Subscription } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import { freshConfig } from "../control/settings.ts";

const SAFETY_MS = 10_000;

type Held = { app: boolean; /** SQLite: the `settings` counter it was read at; null: unknown, read again. */ seq: number | null; /** Postgres: when it was read; 0: invalidated. */ at: number };
let held: Held | null = null;
/** Bumped by every switch this process notes, so a read that began before the switch drops its result. */
let generation = 0;
/** The handle `watchIdentity` was started with: the one a call with no handle reads through. */
let watched: Db | null = null;
let inflight: Promise<void> | null = null;
/** Bumped by every notification, so a read that began before it is not kept as fresh. */
let invalidations = 0;

async function retried<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return await fn();
    } catch (e) { last = e; }
  }
  throw new Error(`cannot read the GitHub identity setting: ${String((last as Error)?.message ?? last).slice(0, 120)}`);
}

const readSetting = (db: Db): Promise<boolean> => retried(async () => (await freshConfig(db, ["github_identity"])).githubIdentity === "app");

async function refresh(db: Db): Promise<void> {
  const gen = generation;
  if (db.dialect === "postgres") {
    if (held && held.at > 0 && Date.now() - held.at < SAFETY_MS) return;
    const startedAt = Date.now(), inv = invalidations;
    const app = await readSetting(db);
    // A switch noted while this read was under way is newer than its reading.
    if (gen !== generation) return;
    held = { app, seq: null, at: inv === invalidations ? startedAt : 0 };
    return;
  }
  // The counter is read before the value, so a write between the two only makes the next call read again.
  const q = queryDb(db);
  const seq = (await retried(async () => await q.get(q.k.selectFrom("main.change_seq").select("seq").where("topic", "=", "settings"))))?.seq ?? null;
  if (seq !== null && held?.seq === seq) return;
  const app = await readSetting(db);
  if (gen !== generation) return;
  if (seq !== null && held?.seq != null && held.seq > seq) return;
  held = { app, seq, at: 0 };
}

/**
 * Whether GitHub reads go through the App identity. With `db`, that database's setting, read now. Without, the process
 * cache: 0 statements on Postgres between notifications; on SQLite one counter read, and the setting only when it moved.
 * Throws when the setting cannot be read; it never reads as the box account then.
 */
export async function readsUseApp(db?: Db): Promise<boolean> {
  if (db) return await readSetting(db);
  if (!watched) return held?.app ?? false;
  const stale = watched.dialect === "postgres" ? !held || held.at === 0 || Date.now() - held.at >= SAFETY_MS : true;
  if (stale) {
    const p = (inflight ??= refresh(watched).finally(() => { inflight = null; }));
    await p;
  }
  return held?.app ?? false;
}

/** The writer's own process learns of an identity switch after the commit. */
export function noteIdentity(app: boolean): void {
  generation++;
  held = { app, seq: null, at: Date.now() };
}

/** Subscribes the process cache to the `settings` topic through `db`, which its reads then go through; a change drops the cache. The caller keeps one watch at a time and ends it with `off`. */
export function watchIdentity(db: Db): Subscription {
  watched = db;
  const sub = db.listen("settings", () => { invalidations++; if (held) held.at = 0; }, { background: true });
  return {
    listening: () => sub?.listening() ?? false,
    off: () => { sub?.off(); if (watched === db) watched = null; },
  };
}
