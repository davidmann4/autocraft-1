// Whether a repo has upstream CI at all; shared by the merge queue, Verify and the database migration.
import { loadRepoCiSignals } from "../data/mirror/index.ts";
import type { Db } from "../db/index.ts";

/** Checks of the repo's most recent PRs that were read; a repo has no CI when none of them ever reported a check. */
export const NO_CI_SAMPLE = 20;
/** Whether any checks of the repo were read yet; before that, whether it has CI is unknown. */
export const repoChecksKnown = async (db: Db, repo: string): Promise<boolean> => (await loadRepoCiSignals(db, [repo])).get(repo)?.known ?? false;
/** True when the repo has checks fetched for some PRs and none of the latest NO_CI_SAMPLE reported any. */
export async function repoHasNoCi(db: Db, repo: string): Promise<boolean> {
  return (await loadRepoCiSignals(db, [repo])).get(repo)?.noCi ?? false;
}

/** repoHasNoCi() from the latest checks of one repo, newest first. */
export const noCiFrom = (rows: { overall: string | null }[]): boolean => rows.length > 0 && rows.every((r) => !r.overall || r.overall === "none");

/** repoHasNoCi() for every repo, from one reading of each repo's latest NO_CI_SAMPLE checks. */
export async function reposWithNoCi(db: Db): Promise<Set<string>> {
  return new Set([...await loadRepoCiSignals(db)].filter(([, s]) => s.noCi).map(([repo]) => repo));
}
