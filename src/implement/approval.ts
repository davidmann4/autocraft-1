// Per-repo approval for the pipeline to open fix PRs for issues there (push to the pipeline fork, open a PR).
// Set from the dashboard by an operator or a maintainer with write access to the repo (src/dash/api/admin.ts). The rows are
// control's repo step approvals (step `fixissue`).
import type { Db } from "../db/index.ts";
import { repoStepApproval, setStepApproval } from "../data/control/index.ts";
import type { StepApproval } from "../data/control/index.ts";

export type FixIssueApproval = StepApproval;

export const fixIssueApprovalOf = (db: Db, repo: string): Promise<FixIssueApproval | null> => repoStepApproval(db, repo, "fixissue");

/** Returns false when nothing changed; throws for an untracked repo. The change is audited as `fixissue-approve` or `fixissue-revoke`. */
export async function setFixIssueApproval(db: Db, by: string, repo: string, approved: boolean): Promise<boolean> {
  return await setStepApproval(db, [{ repo, step: "fixissue", on: approved }], by) > 0;
}
