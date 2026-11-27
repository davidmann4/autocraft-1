// Whether a repo's approvals let work of the repo as a whole start (its comments, labels, main fixes, status comments): what its steps read
// before they run. The writes they make are let through one by one (guard.ts).
import { loadActBlocked, loadStepApprovals } from "../data/control/index.ts";
import type { Db } from "../db/index.ts";

type Step = NonNullable<Parameters<typeof loadStepApprovals>[2]>[number];

/** Those of `repos` approved for the step. */
export async function approvedRepos(db: Db, repos: readonly string[] | "all", step: Step): Promise<Set<string>> {
  return new Set((await loadStepApprovals(db, repos === "all" ? repos : [...repos], [step])).keys());
}

/** Whether the repo is approved for the step. */
export const repoApproved = async (db: Db, repo: string, step: Step): Promise<boolean> => (await approvedRepos(db, [repo], step)).has(repo);

/** Why Act cannot run for the repo now; null when it can. */
export const actBlocked = async (db: Db, repo: string): Promise<string | null> => (await loadActBlocked(db, [repo])).get(repo) ?? null;
