// Per-repo approval for the pipeline to act on a red default branch: rerun the failed jobs, push a fix PR, and open an
// issue for an infrastructure failure. Set only from the dashboard by an operator (src/dash/api/admin.ts).
import { loadStepApprovals, setStepApproval } from "../data/control/index.ts";
import type { Db } from "../db/index.ts";

export type MainFixApproval = { by: string; at: string };

/** The approvals of many repos in one read; repos without one are left out. */
export async function mainFixApprovals(db: Db, repos: string[]): Promise<Map<string, MainFixApproval | null>> {
  const out = new Map<string, MainFixApproval | null>();
  for (const [repo, a] of await loadStepApprovals(db, repos, ["mainfix"])) out.set(repo, a.mainfix ?? null);
  return out;
}

// Returns false when nothing changed.
export async function setMainFixApproval(db: Db, by: string, repo: string, approved: boolean): Promise<boolean> {
  return await setStepApproval(db, [{ repo, step: "mainfix", on: approved }], by) > 0;
}
