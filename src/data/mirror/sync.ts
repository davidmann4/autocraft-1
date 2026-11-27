// Sync bookkeeping: `sync_state`, runs, requests and repo failures (M02 mirror-b).
// reads: control.tracked_repos
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { COLUMNS } from "../../db/types.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import { trackedRepo } from "../control/fragments.ts";
import type { RefKey, RepoErrorRow, RepoFailure, SyncRequestRow, SyncRunRow, SyncState } from "./types.ts";

const refKey = (repo: string, number: number): RefKey => `${repo}#${number}`;
const TWO_DAYS_MS = 2 * 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

/** The row before anything was recorded: every field null. */
const EMPTY_STATE: SyncState = {
  id: 1, org_high_water: null, full_sync_cursor: null, search_catchup_at: null, repos_refreshed_at: null, main_ci_polled_at: null, releases_polled_at: null,
  releases_offset: null, rate_remaining: null, rate_reset_at: null, points_last_run: null, full_points_last_run: null, author_ids_backfilled_at: null,
  author_ids_error: null, app_install_sweep_at: null, webhook_at: null, webhook_started_at: null, polled_at: null, poll_missed_at: null, poll_missed: null,
  deliveries_checked_at: null,
};

/** The one `sync_state` row; every field null before the first write. */
export async function loadSyncState(db: Db): Promise<SyncState> {
  const q = queryDb(db);
  return (await q.get(q.k.selectFrom("main.sync_state").select(kx.cols("sync_state")).where("id", "=", 1))) ?? { ...EMPTY_STATE };
}

/** Upserts the named columns only; an undefined field is left alone, null clears it. */
export async function saveSyncState(db: Db, patch: Partial<SyncState>): Promise<void> {
  const set = patch as Record<string, unknown>;
  const names = Object.keys(set).filter((c) => c !== "id" && set[c] !== undefined);
  if (!names.length) return;
  const known = COLUMNS.sync_state as readonly string[];
  for (const n of names) if (!known.includes(n)) throw new Error(`sync_state has no column ${n}`);
  const q = queryDb(db);
  const values = { id: 1, ...Object.fromEntries(names.map((c) => [c, set[c]])) };
  await db.write(async () => {
    await q.run((q.k as any).insertInto("main.sync_state").values(values).onConflict((oc: any) => oc.column("id").doUpdateSet(kx.excluded(names))));
  });
}

/** Compare-and-set, forward only; false when the stored value is not older. */
export async function advanceOrgHighWater(db: Db, t: string): Promise<boolean> {
  const q = queryDb(db);
  return await db.write(async () => {
    const r = await q.run(q.k.insertInto("main.sync_state").values({ id: 1, org_high_water: t })
      .onConflict((oc) => oc.column("id").doUpdateSet(kx.excluded(["org_high_water"]))
        .where((eb) => eb.or([eb("main.sync_state.org_high_water", "is", null), eb("main.sync_state.org_high_water", "<", eb.ref("excluded.org_high_water"))]))));
    return r.changes > 0;
  });
}

/** Inserts a run, prunes runs older than two days and returns the id; one `db.write`. */
export async function startSyncRun(db: Db, startedAt: string): Promise<number> {
  const q = queryDb(db);
  return await db.write(async () => {
    const row = await q.get(q.k.insertInto("sync_runs").values({ started_at: startedAt }).returning(kx.rowid("sync_runs").as("rowid")));
    await q.run(q.k.deleteFrom("sync_runs").where("started_at", "<", iso(Date.parse(startedAt) - TWO_DAYS_MS)));
    return Number(row!.rowid);
  });
}

/** Closes a run; only the given fields are written. */
export async function finishSyncRun(db: Db, id: number, r: { endedAt: string; mode?: string; items?: number; error?: string | null }): Promise<void> {
  const q = queryDb(db);
  const set = { ended_at: r.endedAt, ...(r.mode !== undefined ? { mode: r.mode } : {}), ...(r.items !== undefined ? { items: r.items } : {}), ...(r.error !== undefined ? { error: r.error } : {}) };
  await db.write(async () => {
    await q.run(q.k.updateTable("sync_runs").set(set).where(kx.rowid("sync_runs"), "=", id));
  });
}

/** Recent runs, newest first. */
export async function loadSyncRuns(db: Db, limit: number): Promise<SyncRunRow[]> {
  const q = queryDb(db);
  return await q.all(q.k.selectFrom("sync_runs").select(["started_at", "ended_at", "mode", "items", "error"]).orderBy("started_at", "desc").limit(Math.floor(limit)));
}

/** End time of the last run without an error. */
export async function loadLastSyncEnd(db: Db): Promise<string | null> {
  const q = queryDb(db);
  return (await q.get(q.k.selectFrom("sync_runs").select((eb) => eb.fn.max<string | null>("ended_at").as("t")).where("error", "is", null)))?.t ?? null;
}

/**
 * Queues re-reads. By default a ref that already has a request keeps it; with `replace` the later row of the call wins and
 * replaces the stored event and time (a webhook delivery). One row per ref in a statement.
 */
export async function queueSyncRequests(db: Db, rows: { repo: string; number: number; event: string; requestedAt: string }[], o: { replace?: boolean } = {}): Promise<void> {
  if (!rows.length) return;
  const one = new Map<string, { repo: string; number: number; event: string; requested_at: string }>();
  for (const r of rows) {
    const k = refKey(r.repo, r.number);
    if (o.replace || !one.has(k)) one.set(k, { repo: r.repo, number: r.number, event: r.event, requested_at: r.requestedAt });
  }
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.batches([...one.values()])) {
      await q.run(q.k.insertInto("main.sync_requests").values(part)
        .onConflict((oc) => o.replace ? oc.columns(["repo", "number"]).doUpdateSet(kx.excluded(["event", "requested_at"])) : oc.columns(["repo", "number"]).doNothing()));
    }
  });
}

/** Oldest first. */
export async function loadSyncRequests(db: Db, limit: number): Promise<SyncRequestRow[]> {
  const q = queryDb(db);
  return await q.all(q.k.selectFrom("main.sync_requests").select(["repo", "number", "event", "requested_at"]).orderBy("requested_at").orderBy("repo").orderBy("number").limit(Math.floor(limit)));
}

/** Deletes rows still at that request time; a request that arrived after the read stays. */
export async function removeSyncRequests(db: Db, rows: { repo: string; number: number; requestedAt: string }[]): Promise<void> {
  if (!rows.length) return;
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.chunks(rows)) {
      await q.run(q.k.deleteFrom("main.sync_requests").where(kx.tupleIn(db, ["repo", "number", "requested_at"], part.map((r) => [r.repo, r.number, r.requestedAt]), ["text", "bigint", "text"])));
    }
  });
}

/** Whether any request is queued. */
export async function hasSyncRequests(db: Db): Promise<boolean> {
  const q = queryDb(db);
  return (await q.get(q.k.selectFrom("main.sync_requests").select((eb) => eb.lit(1).as("one")).limit(1))) !== undefined;
}

/**
 * The refs with no read, or a read that started at or before `after` (`stale`), and those of them that had no request, which are queued
 * one (`asked`). The read times and the existing requests come in one wave; the insert is one statement. The caller stamps `tried_at`
 * of the command it asked for.
 */
export async function requestReadsAfter(db: Db, wants: { ref: RefKey; after: string }[], now: string): Promise<{ stale: RefKey[]; asked: RefKey[] }> {
  if (!wants.length) return { stale: [], asked: [] };
  const after = new Map(wants.map((w) => [w.ref, w.after]));
  const refs = [...after.keys()];
  const q = queryDb(db);
  const [reads, asked] = await db.together(() => Promise.all([
    q.all(q.k.selectFrom("main.item_reads as r").innerJoin(kx.refPairs(db, refs, "kk"), (j) => j.onRef("kk.repo", "=", "r.repo").onRef("kk.number", "=", "r.number")).select(["r.repo", "r.number", "r.synced_at"])),
    q.all(q.k.selectFrom("main.sync_requests as s").innerJoin(kx.refPairs(db, refs, "kk"), (j) => j.onRef("kk.repo", "=", "s.repo").onRef("kk.number", "=", "s.number")).select(["s.repo", "s.number"])),
  ]));
  const readAt = new Map(reads.map((r) => [refKey(r.repo, Number(r.number)), r.synced_at]));
  const has = new Set(asked.map((r) => refKey(r.repo, Number(r.number))));
  const stale = refs.filter((ref) => {
    const read = readAt.get(ref);
    return !read || Date.parse(read) <= Date.parse(after.get(ref)!);
  });
  const ask = stale.filter((ref) => !has.has(ref));
  if (ask.length) {
    const at = now.replace(/\.\d+Z$/, "Z");
    const rows = ask.map((ref) => ({ repo: ref.slice(0, ref.lastIndexOf("#")), number: Number(ref.slice(ref.lastIndexOf("#") + 1)), event: "issue_comment", requested_at: at }));
    await db.write(async () => {
      for (const part of kx.batches(rows)) await q.run(q.k.insertInto("main.sync_requests").values(part).onConflict((oc) => oc.columns(["repo", "number"]).doNothing()));
    });
  }
  return { stale, asked: ask };
}

/** Upsert keeping `since` while the kind is unchanged; one row per repo in a statement (the later row of the call wins). */
export async function recordRepoFailures(db: Db, rows: RepoFailure[]): Promise<void> {
  if (!rows.length) return;
  const last = new Map(rows.map((r) => [r.repo, r]));
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.batches([...last.values()])) {
      await q.run(q.k.insertInto("main.sync_repo_errors").values(part.map((r) => ({ repo: r.repo, kind: r.kind, message: r.message, moved_to: r.movedTo, since: r.at, at: r.at })))
        .onConflict((oc) => oc.column("repo").doUpdateSet((eb) => ({
          kind: eb.ref("excluded.kind"), message: eb.ref("excluded.message"), moved_to: eb.ref("excluded.moved_to"), at: eb.ref("excluded.at"),
          since: eb.case().when("main.sync_repo_errors.kind", "=", eb.ref("excluded.kind")).then(eb.ref("main.sync_repo_errors.since")).else(eb.ref("excluded.since")).end(),
        }))));
    }
  });
}

/** Deletes the failure rows of `repos`, only of the given kinds and only those recorded before `before`. */
export async function clearRepoFailures(db: Db, repos: string[], o: { kinds?: string[]; before?: string } = {}): Promise<void> {
  if (!repos.length || (o.kinds && !o.kinds.length)) return;
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.chunks(repos)) {
      await q.run(q.k.deleteFrom("main.sync_repo_errors").where(kx.inList(db, "repo", part))
        .$if(!!o.kinds, (b) => b.where(kx.inList(db, "kind", o.kinds!)))
        .$if(!!o.before, (b) => b.where("at", "<", o.before!)));
    }
  });
}

/** Errors of tracked repos, oldest streak first. */
export async function loadRepoErrors(db: Db): Promise<RepoErrorRow[]> {
  const q = queryDb(db);
  return await q.all(q.k.selectFrom("main.sync_repo_errors as e").select(["e.repo", "e.kind", "e.message", "e.moved_to", "e.since", "e.at"])
    .where((eb) => trackedRepo(eb, "e.repo")).orderBy("e.since").orderBy("e.repo"));
}

/** Sync time of each item's last read. */
export async function loadItemReads(db: Db, keys: KeySource): Promise<Map<RefKey, string>> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.item_reads as r").innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "r.repo").onRef("kk.number", "=", "r.number")).select(["r.repo", "r.number", "r.synced_at"]));
  return new Map(rows.map((r) => [refKey(r.repo, Number(r.number)), r.synced_at]));
}

/** A webhook delivery the delivery check asked GitHub to send again. */
export type Redelivery = { guid: string; asked: number; asked_at: string | null };

/** The recorded redeliveries of these GUIDs. */
export async function loadRedeliveries(db: Db, guids: string[]): Promise<Map<string, Redelivery>> {
  const q = queryDb(db);
  const out = new Map<string, Redelivery>();
  for (const part of kx.batches([...new Set(guids)])) {
    for (const r of await q.all(q.k.selectFrom("main.webhook_redeliveries").select(["guid", "asked", "asked_at"]).where("guid", "in", part))) {
      out.set(r.guid, { guid: r.guid, asked: Number(r.asked), asked_at: r.asked_at });
    }
  }
  return out;
}

/** Records one more request for `guid` (`accepted`: GitHub took it, at `at`) and prunes rows not touched since `pruneBefore`; one `db.write`. */
export async function noteRedelivery(db: Db, guid: string, accepted: boolean, at: string, pruneBefore: string): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    await q.run(q.k.insertInto("main.webhook_redeliveries").values({ guid, asked: 1, asked_at: accepted ? at : null, updated_at: at })
      .onConflict((oc) => oc.column("guid").doUpdateSet((eb) => ({
        asked: eb("main.webhook_redeliveries.asked", "+", 1),
        updated_at: eb.ref("excluded.updated_at"),
        ...(accepted ? { asked_at: eb.ref("excluded.asked_at") } : {}),
      }))));
    await q.run(q.k.deleteFrom("main.webhook_redeliveries").where("updated_at", "<", pruneBefore));
  });
}
