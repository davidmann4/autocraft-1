// What the dashboard shows of our build of a PR head. Null while the repo's switch is off or no build exists, so the section stays hidden.
import type { ItemPrBuild } from "../../web/src/api/types.ts";
import { featureOn } from "../build/features.ts";
import { loadPrBuildViews } from "../data/merge/index.ts";
import type { Db } from "../db/index.ts";

type Row = { repo: string; number: number; head: string | null };

/**
 * The build of each PR's current head, else its newest one, keyed `repo#number`; a PR whose repo switch is off or that has no build is
 * absent. `internals` false: states only, no failure text. One statement for all rows, plus one task-state read for queued builds.
 */
export async function prBuildViews(db: Db, rows: Row[], internals: boolean): Promise<Map<string, ItemPrBuild>> {
  const out = new Map<string, ItemPrBuild>();
  const on = new Map<string, boolean>();
  for (const r of rows) if (!on.has(r.repo)) on.set(r.repo, await featureOn(db, "pr-builds", r.repo));
  const shown = rows.filter((r) => on.get(r.repo));
  const views = await loadPrBuildViews(db, shown.map((r) => ({ ref: `${r.repo}#${r.number}`, head: r.head })));
  for (const r of shown) {
    const ref = `${r.repo}#${r.number}`;
    const b = views.get(ref);
    if (!b) continue;
    let state = b.state as ItemPrBuild["state"];
    if (state === "queued" as string) state = b.taskState === "claimed" || b.taskState === "running" ? "running" : "queued";
    out.set(ref, {
      headSha: b.headSha, current: b.headSha === r.head, state, summary: internals ? b.summary : null,
      disagree: b.disagree, ci: b.ciOverall, createdAt: b.createdAt, finishedAt: b.finishedAt,
    });
  }
  return out;
}

/** The build of the PR's current head, else the newest one. */
export async function prBuildView(db: Db, repo: string, number: number, head: string | null, internals: boolean): Promise<ItemPrBuild | null> {
  return (await prBuildViews(db, [{ repo, number, head }], internals)).get(`${repo}#${number}`) ?? null;
}
