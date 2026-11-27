// The base branch a review read its diff against, and what may merge into which base.
import { dropCachedDiff } from "../review/diff.ts";
import { applyLocal, loadRepos } from "../data/mirror/index.ts";
import { loadReviewsAt } from "../data/review/index.ts";
import type { Db } from "../db/index.ts";

/** The base branch the review of this head read its diff against; null when none was recorded. */
export async function reviewedBaseOf(db: Db, repo: string, number: number, head: string): Promise<string | null> {
  return (await loadReviewsAt(db, [{ repo, number, head }])).get(`${repo}#${number}@${head}`)?.base_ref ?? null;
}

export async function defaultBranchOf(db: Db, repo: string): Promise<string | null> {
  return (await loadRepos(db, { names: [repo] })).get(repo)?.default_branch ?? null;
}

/** The reviewed base and the default branch, in one wave. */
async function basesOf(db: Db, repo: string, number: number, head: string): Promise<{ reviewed: string | null; main: string | null }> {
  const [reviewed, main] = await db.together(() => Promise.all([reviewedBaseOf(db, repo, number, head), defaultBranchOf(db, repo)]));
  return { reviewed, main };
}

/**
 * Why a PR may not merge into its current base, or null: it merges into the default branch only, and only when that is the branch the
 * review read the diff against. A review that recorded none (stored earlier), or a PR that merges without one, counts as read against it.
 */
export async function baseRefusal(db: Db, repo: string, head: string, number: number, liveBase: string): Promise<string | null> {
  const b = await basesOf(db, repo, number, head);
  if (b.main && liveBase !== b.main) return `the base branch is ${liveBase}, not the default branch ${b.main}`;
  const reviewed = b.reviewed ?? b.main;
  if (!reviewed) return null;
  return liveBase === reviewed ? null : `the base branch is ${liveBase}, but the review read the diff against ${reviewed}`;
}

/** Whether another branch may be merged into a PR: the default branch or the base its review read. */
export async function mergeInAllowed(db: Db, repo: string, number: number, head: string, branch: string): Promise<boolean> {
  const b = await basesOf(db, repo, number, head);
  return branch === b.main || branch === b.reviewed;
}

/**
 * A live read found the PR on another base than the mirror holds: the mirror takes the live base and the cached diff of the
 * old base is dropped. The planner then counts the review as stale (src/review/discussion.ts staleReviews), and the re-review
 * waits like one after a push: the PR author's retarget is no request for a review. `keepDiff`: the cached diff was just read
 * against the live base (a review's own read), so it stays.
 */
export async function recordLiveBase(db: Db, repo: string, number: number, head: string, liveBase: string, o: { by?: string; keepDiff?: boolean } = {}): Promise<void> {
  if (!o.keepDiff) await dropCachedDiff(db, repo, number, head);
  await applyLocal(db, [{ kind: "base", repo, number, baseRef: liveBase, head, keepDiff: o.keepDiff, ...(o.by ? { by: o.by } : {}) }]);
}
