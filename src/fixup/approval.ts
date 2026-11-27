// Per-repo approval for the pipeline to push fix-up commits to contributors'
// branches there. Set only from the dashboard by an operator
// (src/dash/api/admin.ts); pushing is opt-in per repo like merging.
import { setStepApproval } from "../data/control/index.ts";
import type { Db } from "../db/index.ts";

// Returns false when nothing changed.
export async function setPushApproval(db: Db, by: string, repo: string, approved: boolean): Promise<boolean> {
  return await setStepApproval(db, [{ repo, step: "push", on: approved }], by) > 0;
}
