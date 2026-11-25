// Settings reads. While a planner pass runs, they come from one reading of the table taken at its start (withSettingsSnapshot),
// so a pass reads the table once instead of once per key; outside a pass every read goes to the database.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Db } from "./db/index.ts";
import * as kx from "./db/kx.ts";
import { onSettingsWrite } from "./db/handle.ts";

type Store = { db: Db; map: Map<string, string | null>; live: ReadonlySet<string>; watch: boolean; dirty: boolean; reread?: Promise<void>; at: number };

/** The snapshot of the pass running in the current async context, for the handle it was read on. */
const pass = new AsyncLocalStorage<Store>();

// A watching snapshot (a job's) reads the table again after any write to it on its handle, whoever issues the write,
// so a step reads back what it wrote. A planner pass writes its cursors through writeSetting, which keeps its map current.
onSettingsWrite((db) => {
  const s = pass.getStore();
  if (s?.watch && s.db === db) s.dirty = true;
});

/** A watching snapshot older than this is read again, so settings other processes change reach a long job. */
const MAX_AGE_MS = 5000;

/** Runs `fn` with the reads of a job's snapshot taken from the table, for the checks that guard a GitHub write (a planner pass keeps its reading). */
export const freshSettings = <T>(fn: () => Promise<T>): Promise<T> => pass.getStore()?.watch ? pass.exit(fn) : fn();

const snapshotOf = async (db: Db, ...keys: string[]): Promise<Map<string, string | null> | undefined> => {
  const s = pass.getStore();
  if (s?.db !== db || keys.some((k) => s.live.has(k))) return undefined;
  if (s.watch && Date.now() - s.at > MAX_AGE_MS) s.dirty = true;
  while (s.dirty || s.reread) {
    if (!s.reread) {
      s.dirty = false;
      s.reread = readSettingsSnapshot(db).then((m) => { s.map = m; s.at = Date.now(); }).finally(() => { s.reread = undefined; });
    }
    await s.reread;
  }
  return s.map;
};

export interface SnapshotOptions {
  /** Keys every read takes from the table: settings a running step polls (the pipeline switch, limits). */
  live?: readonly string[];
  /** Read the table again after a write to it on this handle, from any code path. */
  watchWrites?: boolean;
}

/**
 * Runs `fn` with the settings reads on `db` served from one reading of the table. The snapshot belongs to the async context
 * of `fn`: work that runs meanwhile outside it (other requests, timers) reads the table. Inside, writeSetting/deleteSetting
 * keep it current. Other contexts and connections (the runner thread, the dashboard) keep writing: the pass sees settings as
 * they were at its start (except the `live` keys), and applyProposals re-checks limits and blocks with fresh reads.
 */
export async function withSettingsSnapshot<T>(db: Db, fn: () => Promise<T>, read?: Promise<SettingsSnapshot>, opts: SnapshotOptions = {}): Promise<T> {
  if (pass.getStore()?.db === db) return await fn();
  return await pass.run({ db, map: await (read ?? readSettingsSnapshot(db)), live: new Set(opts.live), watch: !!opts.watchWrites, dirty: false, at: Date.now() }, fn);
}

export type SettingsSnapshot = Map<string, string | null>;

/** One reading of the table for withSettingsSnapshot, so a caller can start it alongside its other reads. */
export async function readSettingsSnapshot(db: Db): Promise<SettingsSnapshot> {
  const rows = await db.all(db.k.selectFrom("main.settings").select(["key", "value"]));
  return new Map(rows.map((r) => [r.key, r.value]));
}

/** Reads the table again for the snapshot of a pass on `db` (none: nothing), so a pass sees the settings of a read transaction it opens later. */
export async function rereadSettingsSnapshot(db: Db): Promise<void> {
  const s = pass.getStore();
  if (s?.db !== db) return;
  s.map = await readSettingsSnapshot(db);
}

/** The stored value, undefined when the key has no row. */
export async function setting(db: Db, key: string): Promise<string | undefined> {
  const snap = await snapshotOf(db, key);
  if (snap) return snap.get(key) ?? undefined;
  return (await db.get(db.k.selectFrom("main.settings").select("value").where("key", "=", key)))?.value ?? undefined;
}

/** The stored values of `keys` in one read; keys without a row are left out. */
export async function settings(db: Db, keys: string[]): Promise<Map<string, string>> {
  const snap = await snapshotOf(db, ...keys);
  if (snap) return new Map(keys.flatMap((k) => { const v = snap.get(k); return v == null ? [] : [[k, v] as const]; }));
  const rows = await db.all(db.k.selectFrom("main.settings").select(["key", "value"]).where(kx.inList(db, "key", keys)));
  return new Map(rows.flatMap((r) => r.value == null ? [] : [[r.key, r.value] as const]));
}

/** The rows of `keys` in one read, NULL values kept; keys without a row are left out. */
export async function settingRows(db: Db, keys: string[]): Promise<Map<string, string | null>> {
  const snap = await snapshotOf(db, ...keys);
  if (snap) return new Map(keys.flatMap((k) => snap.has(k) ? [[k, snap.get(k)!] as const] : []));
  return new Map((await db.all(db.k.selectFrom("main.settings").select(["key", "value"]).where(kx.inList(db, "key", keys)))).map((r) => [r.key, r.value] as const));
}

/** True when the key has a row. */
export async function hasSetting(db: Db, key: string): Promise<boolean> {
  const snap = await snapshotOf(db, key);
  if (snap) return snap.has(key);
  return !!await db.get(db.k.selectFrom("main.settings").select("key").where("key", "=", key));
}

export async function writeSetting(db: Db, key: string, value: string): Promise<void> {
  await db.run(db.k.insertInto("main.settings").values({ key, value }).onConflict((oc) => oc.column("key").doUpdateSet(kx.excluded(["value"]))));
  const s = pass.getStore();
  if (s?.db === db) s.map.set(key, value);
}

export async function deleteSetting(db: Db, key: string): Promise<void> {
  await db.run(db.k.deleteFrom("main.settings").where("key", "=", key));
  const s = pass.getStore();
  if (s?.db === db) s.map.delete(key);
}
