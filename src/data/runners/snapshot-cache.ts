// The 2 s cache of the runner snapshot, per handle. Writers of runner state drop it in their own process; other processes' changes show
// within the window, as the queue cache's do.
import type { Db } from "../../db/index.ts";
import { onQueueDrop } from "./calls-shared.ts";
import type { RunnerSnapshot } from "./types.ts";

export const SNAPSHOT_CACHE_MS = 2_000;

type Entry = { at: number; snapshot: Promise<RunnerSnapshot> };
const caches = new WeakMap<Db, Entry>();

/** The cached snapshot taken within the window before `now`, if any. */
export function cachedSnapshot(db: Db, now: number): Promise<RunnerSnapshot> | null {
  const c = caches.get(db);
  return c && now >= c.at && now - c.at < SNAPSHOT_CACHE_MS ? c.snapshot : null;
}

/** Keeps the snapshot being read; a failed read leaves no entry. */
export function keepSnapshot(db: Db, now: number, snapshot: Promise<RunnerSnapshot>): Promise<RunnerSnapshot> {
  const entry = { at: now, snapshot };
  caches.set(db, entry);
  void snapshot.catch(() => { if (caches.get(db) === entry) caches.delete(db); });
  return snapshot;
}

/** Forgets the cached snapshot: a runner status, cool-off, pick, lease or setting changed in this process. */
export const dropSnapshotCache = (db: Db): void => { caches.delete(db); };

// The snapshot embeds the queue: every drop of the queue cache drops it too.
onQueueDrop(dropSnapshotCache);
