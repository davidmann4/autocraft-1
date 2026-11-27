// reads: merge.merges, workflow.preapprovals, workflow.item_workflows, workflow.workflow_events, changes.fixups, changes.ci_fixes, changes.conflict_merges, control.push_outcomes, workflow.autorepins
import { landedWhy } from "../../core/evidence.ts";
import type { LandedWhy } from "../../core/plan.ts";
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import { loadMergedInfo } from "../merge/index.ts";
import type { RefKey } from "../mirror/types.ts";
import { loadLandedApprovals } from "../workflow/index.ts";
import { loadOwnPushes } from "./own-pushes.ts";

/** Per PR of `keys` the pipeline merged: why what landed is reviewed, null when it merged as a person approved it (core/evidence.ts landedWhy). One wave. */
export async function loadLandedWhy(db: Db, keys: KeySource): Promise<Map<RefKey, LandedWhy | null>> {
  const [merged, approvals, pushes] = await db.together(() => Promise.all([loadMergedInfo(db, keys), loadLandedApprovals(db, keys), loadOwnPushes(db, keys)]));
  return new Map([...merged].map(([ref, m]) => [ref, landedWhy({ head: m.lastHead, approval: approvals.get(ref)?.get(m.lastHead) ?? null, pushes: pushes.get(ref) ?? [] })]));
}
