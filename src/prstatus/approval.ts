// Per-repo switch for the PR status comment (src/prstatus/index.ts), off by default. Set from the dashboard by an operator
// or a maintainer with write access to the repo (src/dash/api/admin.ts). The row is the repo's `prstatus` step approval.
import { setStepApproval } from "../data/control/index.ts";
import type { Db } from "../db/index.ts";

/** Returns false when nothing changed; throws for a repo that is not tracked. */
export async function setStatusApproval(db: Db, by: string, repo: string, approved: boolean): Promise<boolean> {
  return await setStepApproval(db, [{ repo, step: "prstatus", on: approved }], by) > 0;
}
