// Per-repo approval to write labels to GitHub. Set only from the dashboard by an
// operator (src/dash/api/admin.ts); the CLI reads it and has no way to set it.
import { repoStepApproval, setStepApproval } from "../data/control/index.ts";
import type { Db } from "../db/index.ts";

export type Approval = { by: string; at: string };

export async function approvalOf(db: Db, repo: string): Promise<Approval | null> {
  return await repoStepApproval(db, repo, "labels");
}

// Returns false when nothing changed.
export async function setApproval(db: Db, by: string, repo: string, approved: boolean): Promise<boolean> {
  return (await setStepApproval(db, [{ repo, step: "labels", on: approved }], by)) > 0;
}
