// Per-repo approval for the pipeline to post comments and close items there (the repo's `comment` step approval).
// Set only from the dashboard by an operator (src/dash/api/admin.ts).
import { repoStepApproval, setStepApproval } from "../data/control/index.ts";
import type { Db } from "../db/index.ts";

export type CommentApproval = { by: string; at: string };

export async function commentApprovalOf(db: Db, repo: string): Promise<CommentApproval | null> {
  return await repoStepApproval(db, repo, "comment");
}

/** Throws for an untracked repo; returns false when nothing changed. */
export async function setCommentApproval(db: Db, by: string, repo: string, approved: boolean): Promise<boolean> {
  return await setStepApproval(db, [{ repo, step: "comment", on: approved }], by) > 0;
}
