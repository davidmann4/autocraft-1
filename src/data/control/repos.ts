// Tracked repos (M05 control-a).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { addAudit } from "./audit.ts";
import type { TrackedRepo } from "./types.ts";

/** A refused change of a repo's Pipeline switch; `status` is the HTTP status the dashboard answers with. */
export class PipelineFlagError extends Error {
  status = 400;
}

const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** All rows, or the named ones. Names, owners and pipeline flags are fields (the owner join is `mirror.loadRepos` in a `together`). */
export async function loadTrackedRepos(db: Db, names?: string[]): Promise<Map<string, TrackedRepo>> {
  const q = queryDb(db);
  let s = q.k.selectFrom("main.tracked_repos").select(["name", "pipeline", "added_by", "added_at"]).orderBy("name");
  if (names) s = s.where(kx.inList(db, "name", names));
  return new Map((await q.all(s)).map((r) => [r.name, { name: r.name, pipeline: r.pipeline === 1, addedBy: r.added_by, addedAt: r.added_at }]));
}

/** Names the dashboard hides from non-operators. */
export async function loadEverTracked(db: Db): Promise<Set<string>> {
  const q = queryDb(db);
  return new Set((await q.all(q.k.selectFrom("main.ever_tracked_repos").select("name"))).map((r) => r.name));
}

/** Insert on conflict do nothing plus the `repo-track` audit row when inserted. */
export async function addTrackedRepo(db: Db, o: { name: string; by: string; at?: string }): Promise<boolean> {
  const q = queryDb(db);
  return await db.write(async () => {
    const at = o.at ?? new Date().toISOString();
    const r = await q.run(q.k.insertInto("main.tracked_repos").values({ name: o.name, added_by: o.by, added_at: at, workflow: "new" }).onConflict((oc) => oc.doNothing()));
    if (r.changes > 0) await addAudit(db, [{ login: o.by, action: "repo-track", target: o.name, at }]);
    return r.changes > 0;
  });
}

/** Delete plus the `repo-untrack` audit row; approval rows stay. */
export async function removeTrackedRepo(db: Db, name: string, by: string): Promise<boolean> {
  const q = queryDb(db);
  return await db.write(async () => {
    const r = await q.run(q.k.deleteFrom("main.tracked_repos").where("name", "=", name));
    if (r.changes > 0) await addAudit(db, [{ login: by, action: "repo-untrack", target: name }]);
    return r.changes > 0;
  });
}

/** Compare-and-set (`WHERE pipeline <> :on`), one `repo-pipeline` audit row per changed repo; throws `PipelineFlagError("<repo> is not tracked")` for an untracked name. */
export async function setPipelineFlags(db: Db, rows: { repo: string; on: boolean }[], by: string): Promise<{ changed: string[] }> {
  const want = new Map(rows.map((r) => [r.repo, r.on]));
  if (!want.size) return { changed: [] };
  const q = queryDb(db);
  return await db.write(async () => {
    const names = [...want.keys()];
    const known = new Set((await q.all(q.k.selectFrom("main.tracked_repos").select("name").where(kx.inList(db, "name", names)))).map((r) => r.name));
    for (const n of names) if (!NAME.test(n) || !known.has(n)) throw new PipelineFlagError(`${n} is not tracked`);
    const changed = new Set<string>();
    for (const on of [true, false]) {
      const group = names.filter((n) => want.get(n) === on);
      if (!group.length) continue;
      const v = on ? 1 : 0;
      for (const r of await q.all(q.k.updateTable("main.tracked_repos").set({ pipeline: v }).where(kx.inList(db, "name", group)).where("pipeline", "<>", v).returning("name"))) changed.add(r.name);
    }
    const out = names.filter((n) => changed.has(n));
    if (out.length) await addAudit(db, out.map((n) => ({ login: by, action: "repo-pipeline", target: n, details: { on: want.get(n) } })));
    return { changed: out };
  });
}

/** Validates a repo name; the name itself, or null. */
export function parseRepoName(s: string): string | null {
  return NAME.test(s) ? s : null;
}

/** Splits `owner/repo`; null when either part is empty or the repo part is not a repo name. */
export function splitSlug(slug: string): { owner: string; repo: string } | null {
  const i = slug.indexOf("/");
  if (i <= 0) return null;
  const repo = parseRepoName(slug.slice(i + 1));
  return repo ? { owner: slug.slice(0, i), repo } : null;
}
