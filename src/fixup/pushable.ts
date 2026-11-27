// Whether the pipeline may push to a PR's head branch. GitHub reports
// maintainerCanModify false for a branch in the base repository itself, but the
// pipeline's account can push there, so that case counts as pushable, unless the
// branch is a long-lived one (the default branch, another PR's base, a release branch).
import { loadLongLivedBranches } from "../data/mirror/index.ts";
import { slugOf } from "../owners.ts";
import type { Db } from "../db/index.ts";

/** Branch names that are long-lived whatever the repository says. */
const LONG_LIVED = /^(release|main|master|develop|stable|hotfix|integration|next|staging|production|beta|trunk|gh-pages)([/._-].*)?$|^v?\d+(\.\d+)*(\.x)?$/i;

/** True when the head branch lives in the base repository (`headRepo` is `owner/name`). */
export function sameRepo(headRepo: string | null | undefined, repo: string): boolean {
  return !!headRepo && headRepo.toLowerCase() === `${slugOf(repo)}`.toLowerCase();
}

export type LongLived = (branch: string) => boolean;

const longLived = (names: ReadonlySet<string> | undefined): LongLived => (branch) => !!names?.has(branch) || LONG_LIVED.test(branch);

/** Decides whether a branch of `repo` is long-lived: its default branch, the base of any PR, a release-like name, or a head shared by several open PRs. */
export async function longLivedOf(db: Db, repo: string): Promise<LongLived> {
  return longLived((await loadLongLivedBranches(db, [repo])).get(repo));
}

/** longLivedOf() for `repos` (every repo without them), from one reading of the default branches and PR branches. */
export async function longLivedAll(db: Db, repos?: string[]): Promise<(repo: string) => LongLived> {
  const names = await loadLongLivedBranches(db, repos);
  return (repo) => longLived(names.get(repo));
}

/**
 * A PR is pushable when its head is in the base repository (on a branch that isn't long-lived) or maintainers may
 * modify it. `branch` is the head branch name; a same-repo head without one is not pushable, nor is one whose author cannot write to the repository.
 */
export function pushable(headRepo: string | null | undefined, repo: string, canModify: boolean | number | null | undefined, branch: string | null | undefined, longLived: LongLived = (b) => LONG_LIVED.test(b), protectedBranch = false, authorCanWrite = false): boolean {
  if (sameRepo(headRepo, repo)) return authorCanWrite && !!branch && !protectedBranch && !longLived(branch);
  return !!canModify;
}
