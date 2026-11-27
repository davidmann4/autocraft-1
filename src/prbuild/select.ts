// The PRs that get our own build (pr-builds feature): open, non-draft PRs of a public repo whose head has no build yet.
// Scope per repo (settings `pr_builds_scope:<repo>`): "outside" (default) builds only outside authors' PRs, "all" every PR.
import { loadHolds, isOutsideAuthor, loadInsiders } from "../data/intake/index.ts";
import { config, readConfig, saveSettings, withConfig } from "../data/control/index.ts";
import { loadPrBuildStates } from "../data/merge/index.ts";
import { listItems, loadRepos, openItemKeys } from "../data/mirror/index.ts";
import { cachedRust, type RustCheck } from "../verify/candidates.ts";
import type { Db } from "../db/index.ts";

export type PrBuildScope = "outside" | "all";
export const DEFAULT_PER_DAY = 10;
export const DAY_MS = 24 * 3600_000;

export async function scopeOf(db: Db, repo: string): Promise<PrBuildScope> {
  return (await readConfig(db, [`pr_builds_scope:${repo}`])).repo(repo).prBuildsScope;
}

export async function setScope(db: Db, repo: string, scope: PrBuildScope, by = "system"): Promise<void> {
  await saveSettings(db, [{ key: "pr_builds_scope", repo, value: scope }], by, { action: "build-feature", target: "pr-builds", details: { feature: "pr-builds", scope, repo } });
}

/** Builds a repo may start in 24 hours; 0 starts none. */
export async function perDayOf(db: Db): Promise<number> {
  return (await readConfig(db, ["pr_builds_per_day"])).prBuildsPerDay;
}

export async function setPerDay(db: Db, n: number, by = "system"): Promise<void> {
  await saveSettings(db, [{ key: "pr_builds_per_day", value: String(n) }], by, { action: "build-feature", target: "pr-builds", details: { feature: "pr-builds", perDay: n } });
}

export type PrBuildCandidate = { repo: string; number: number; head: string; /** Whether the repo is known to be a Rust workspace at the head; null before its crate list was fetched. */ rust: boolean | null };

/** The numbers among `numbers` whose PR the worker would claim a build task for: the PR is in the pipeline's scope. One statement. */
export async function buildScope(db: Db, repo: string, numbers: number[]): Promise<Set<number>> {
  if (numbers.length === 0) return new Set();
  return new Set((await listItems(db, { repos: [repo], numbers, inScope: true }, "ref")).map((i) => i.number));
}

/** The PRs to build now per repo, oldest first, within each repo's daily cap. Writes nothing. */
export async function selectPrBuildsIn(db: Db, repos: readonly string[], o: { rust?: RustCheck; now?: number } = {}): Promise<Map<string, PrBuildCandidate[]>> {
  const out = new Map<string, PrBuildCandidate[]>();
  if (!repos.length) return out;
  return await withConfig(db, async () => {
    const [rows, states] = await db.together(() => Promise.all([loadRepos(db, { names: [...repos] }), loadPrBuildStates(db, repos, (o.now ?? Date.now()) - DAY_MS)]));
    const roomOf = (repo: string): number => config(db).prBuildsPerDay - (states.get(repo)?.usedSince ?? 0);
    const all = (repo: string): boolean => config(db).repo(repo).prBuildsScope === "all";
    const building = repos.filter((r) => rows.get(r)?.visibility === "public" && roomOf(r) > 0);
    if (!building.length) return out;
    const [items, held, insiders] = await db.together(() => Promise.all([
      listItems(db, { repos: building, kind: "pr", states: ["OPEN"], inScope: true }, "text"),
      loadHolds(db, openItemKeys({ repos: building, kind: "pr" })),
      building.every(all) ? Promise.resolve(new Set<string>()) : loadInsiders(db),
    ]));
    const open = items.filter((i) => !i.is_draft && i.head_oid && !states.get(i.repo)?.have.has(`${i.number}@${i.head_oid}`))
      .sort((a, b) => (a.created_at === b.created_at ? 0 : a.created_at === null ? -1 : b.created_at === null ? 1 : a.created_at < b.created_at ? -1 : 1) || a.number - b.number);
    const rust = o.rust ?? cachedRust;
    for (const r of open) {
      const repo = r.repo, list = out.get(repo) ?? out.set(repo, []).get(repo)!;
      if (list.length >= roomOf(repo) || held.has(`${repo}#${r.number}`)) continue;
      if (!all(repo) && !isOutsideAuthor(r, insiders)) continue;
      const isRust = rust(repo, r.head_oid!);
      if (isRust === false) continue;
      list.push({ repo, number: r.number, head: r.head_oid!, rust: isRust });
    }
    return out;
  });
}

export const selectPrBuilds = async (db: Db, repo: string, o: { rust?: RustCheck; now?: number } = {}): Promise<PrBuildCandidate[]> => (await selectPrBuildsIn(db, [repo], o)).get(repo) ?? [];
