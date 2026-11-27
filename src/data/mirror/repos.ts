// Repo rows and their sync marks (M02 mirror-b).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { loadSyncState } from "./sync.ts";
import type { RepoMeta, RepoRow, SyncPlan } from "./types.ts";

/** Statement text of a row-per-repo update: the repo rows come in as one JSON parameter. */
const mark = (db: Db, rows: readonly Record<string, string | null>[], cols: Record<string, "text">) => kx.valuesTable(db, rows, cols, "v");

/** Repo rows by name. A scoped handle shows tracked repos only; `all` reads every repo. */
export async function loadRepos(db: Db, o: { names?: string[]; all?: boolean } = {}): Promise<Map<string, RepoRow>> {
  if (o.names && !o.names.length) return new Map();
  const q = queryDb(db);
  const base = q.k.selectFrom((o.all ? "main.repos" : "repos") as "repos").select(kx.cols("repos"));
  const rows = await q.all((o.names ? base.where(kx.inList(db, "name", o.names)) : base).orderBy("name"));
  return new Map(rows.map((r) => [r.name, r]));
}

/** Repo names (visible-repo lists, the public set). */
export async function loadRepoNames(db: Db, o: { names?: string[]; all?: boolean } = {}): Promise<string[]> {
  if (o.names && !o.names.length) return [];
  const q = queryDb(db);
  const base = q.k.selectFrom((o.all ? "main.repos" : "repos") as "repos").select("name");
  return (await q.all((o.names ? base.where(kx.inList(db, "name", o.names)) : base).orderBy("name"))).map((r) => r.name);
}

/**
 * Upserts the repo list and returns the names written; the owner guard stays in the statement, so refused names are the input minus
 * the result. Also deletes the `not-found` error rows of the written names. One row per name in a statement (the later row wins).
 */
export async function saveRepoList(db: Db, rows: RepoMeta[]): Promise<string[]> {
  if (!rows.length) return [];
  const last = new Map(rows.map((r) => [r.name, r]));
  const q = queryDb(db);
  return await db.write(async () => {
    const written: string[] = [];
    for (const part of kx.batches([...last.values()])) {
      const res = await q.all(q.k.insertInto("main.repos")
        .values(part.map((r) => ({ name: r.name, owner: r.owner, visibility: r.visibility ?? null, default_branch: r.default_branch ?? null, open_prs: r.open_prs ?? null, open_issues: r.open_issues ?? null })))
        .onConflict((oc) => oc.column("name").doUpdateSet(kx.excluded(["visibility", "default_branch", "open_prs", "open_issues"])).whereRef("main.repos.owner", "=", "excluded.owner"))
        .returning("name"));
      written.push(...res.map((r) => r.name));
    }
    for (const part of kx.chunks(written)) await q.run(q.k.deleteFrom("main.sync_repo_errors").where(kx.inList(db, "repo", part)).where("kind", "=", "not-found"));
    return written;
  });
}

/** Inserts the repo when absent. */
export async function ensureRepo(db: Db, r: { name: string; owner: string }): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    await q.run(q.k.insertInto("main.repos").values({ name: r.name, owner: r.owner }).onConflict((oc) => oc.doNothing()));
  });
}

/** Sets `high_water`, `synced_at` and `reconciled_at` to null. */
export async function resetRepoSync(db: Db, names: string[]): Promise<void> {
  if (!names.length) return;
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.chunks(names)) await q.run(q.k.updateTable("main.repos").set({ high_water: null, synced_at: null, reconciled_at: null }).where(kx.inList(db, "name", part)));
  });
}

/** Sets `synced_at`; a given high water replaces the stored one only when that is empty or older. One update per 10,000 repos. */
export async function markReposRead(db: Db, rows: { name: string; syncedAt: string; highWater?: string | null }[]): Promise<void> {
  if (!rows.length) return;
  const last = new Map(rows.map((r) => [r.name, r]));
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.chunks([...last.values()])) {
      const v = mark(db, part.map((r) => ({ name: r.name, synced_at: r.syncedAt, hw: r.highWater ?? null })), { name: "text", synced_at: "text", hw: "text" });
      await q.run(q.k.updateTable("main.repos").from(v).set((eb) => ({
        synced_at: eb.ref("v.synced_at"),
        high_water: eb.case().when(eb("v.hw", "is", null)).then(eb.ref("main.repos.high_water"))
          .when(eb.or([eb("main.repos.high_water", "is", null), eb("main.repos.high_water", "<", eb.ref("v.hw"))])).then(eb.ref("v.hw"))
          .else(eb.ref("main.repos.high_water")).end(),
      })).whereRef("main.repos.name", "=", "v.name"));
    }
  });
}

/** Moves the high water forward only (the later time per repo of the call wins). */
export async function advanceRepoHighWater(db: Db, rows: { name: string; t: string }[]): Promise<void> {
  if (!rows.length) return;
  const newest = new Map<string, string>();
  for (const r of rows) if (r.t > (newest.get(r.name) ?? "")) newest.set(r.name, r.t);
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.chunks([...newest])) {
      const v = mark(db, part.map(([name, t]) => ({ name, t })), { name: "text", t: "text" });
      await q.run(q.k.updateTable("main.repos").from(v).set((eb) => ({ high_water: eb.ref("v.t") })).whereRef("main.repos.name", "=", "v.name")
        .where((eb) => eb.or([eb("main.repos.high_water", "is", null), eb("main.repos.high_water", "<", eb.ref("v.t"))])));
    }
  });
}

/** Sets `synced_at` for repos with a high water and no `sync_repo_errors` row. */
export async function markReposSyncedByError(db: Db, names: string[], at: string): Promise<void> {
  if (!names.length) return;
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.chunks(names)) {
      await q.run(q.k.updateTable("main.repos").set({ synced_at: at }).where(kx.inList(db, "name", part)).where("high_water", "is not", null)
        .where((eb) => eb.not(eb.exists(eb.selectFrom("main.sync_repo_errors as e").select(eb.lit(1).as("one")).whereRef("e.repo", "=", "main.repos.name")))));
    }
  });
}

/** Batched update of the reconcile time. */
export async function markReposReconciled(db: Db, rows: { name: string; at: string }[]): Promise<void> {
  if (!rows.length) return;
  const last = new Map(rows.map((r) => [r.name, r.at]));
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.chunks([...last])) {
      const v = mark(db, part.map(([name, at]) => ({ name, at })), { name: "text", at: "text" });
      await q.run(q.k.updateTable("main.repos").from(v).set((eb) => ({ reconciled_at: eb.ref("v.at") })).whereRef("main.repos.name", "=", "v.name"));
    }
  });
}

/** Repos, synced and broken sets and the sync state in one `together` wave. */
export async function loadSyncPlan(db: Db): Promise<SyncPlan> {
  const q = queryDb(db);
  const [rows, errors, state] = await db.together(() => Promise.all([
    q.all(q.k.selectFrom("main.repos").select(kx.cols("repos")).orderBy("name")),
    q.all(q.k.selectFrom("main.sync_repo_errors").select(["repo", "kind"])),
    loadSyncState(db),
  ]));
  return { repos: new Map(rows.map((r) => [r.name, r])), synced: new Set(rows.filter((r) => r.synced_at !== null).map((r) => r.name)), broken: new Set(errors.filter((r) => r.kind === "not-found" || r.kind === "forbidden").map((r) => r.repo)), failing: new Set(errors.map((r) => r.repo)), state };
}

/** Deletes the repo's comments and items and resets its sync marks; checks, files, commits and activity rows stay. */
export async function purgeRepoMirror(db: Db, name: string): Promise<{ comments: number; items: number }> {
  const q = queryDb(db);
  return await db.write(async () => {
    const comments = Number((await q.run(q.k.deleteFrom("main.comments").where("repo", "=", name))).changes);
    const items = Number((await q.run(q.k.deleteFrom("main.items").where("repo", "=", name))).changes);
    await q.run(q.k.updateTable("main.repos").set({ high_water: null, synced_at: null, reconciled_at: null }).where("name", "=", name));
    return { comments, items };
  });
}

/** Item count per repo over every repo (a repo without items has no entry). */
export async function countItemsByRepo(db: Db, repos?: string[]): Promise<Map<string, number>> {
  if (repos && !repos.length) return new Map();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.items").select(["repo", (eb) => eb.fn.countAll<number>().as("n")]).$if(!!repos, (b) => b.where(kx.inList(db, "repo", repos!))).groupBy("repo"));
  return new Map(rows.map((r) => [r.repo, Number(r.n)]));
}
