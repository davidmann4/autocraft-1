// The one write that stops a workflow at a blocker: the merge leg that works for it ends with it, so nothing merges past the question.
import { listWorkflows, loadLegs, moveLegs, recordEvents, sameWorkflow, saveWorkflows, type Preapproval, type WorkflowPatch } from "../data/workflow/index.ts";
import type { Stop } from "../core/codes.ts";
import type { Db } from "../db/index.ts";
import { pastCancel, say } from "../preapproval/index.ts";
import type { ItemWorkflow } from "./types.ts";

const ACTOR = "pipeline";

/**
 * `w`: the row as the caller read it; `patch`: the whole change of the row, its state and blocker among it; `line`: what its `blocked` event
 * says. `pr`: the PR the workflow works on, null for an issue without one, whose active merge leg ends for `stop`; `leg`: that leg as the
 * caller read it, null for none.
 */
export type BlockWrite = {
  w: ItemWorkflow; patch: WorkflowPatch; at: string; line: string | null;
  pr: { repo: string; number: number } | null; leg: Pick<Preapproval, "id"> | null; stop: Stop;
};

/**
 * Stops the workflow in one transaction. `written`: the row, its event and the leg's end are stored. Nothing is written otherwise. `changed`: a
 * person changed the workflow meanwhile and decides about the leg (a start after a hold has a new one). `merging`: the leg cannot be stopped
 * now (an integration batch holds the PR, whose running CI a cancel would undo, a merge of the repo is running, or the leg ended a moment
 * ago), and the next pass looks again.
 */
export async function blockWorkflow(db: Db, b: BlockWrite): Promise<"written" | "changed" | "merging"> {
  const { w, pr, stop } = b;
  return await db.write(async () => {
    const [rows, legs] = await db.together(() => Promise.all([listWorkflows(db, { ids: [w.id] }), pr ? loadLegs(db, [pr], { activeOnly: true }) : new Map<string, Preapproval[]>()]));
    const now = rows[0];
    if (!now || !sameWorkflow(now, w)) return "changed";
    const leg = pr ? legs.get(`${pr.repo}#${pr.number}`)?.at(-1) ?? null : null;
    if (b.leg !== null && b.leg.id !== leg?.id) return "merging";
    if (leg) {
      if (await pastCancel(db, leg) !== null) return "merging";
      await moveLegs(db, [{ id: leg.id, from: leg.state, to: "cancelled", reason: stop.text, code: stop.code, ...(stop.params ? { params: stop.params } : {}), by: ACTOR, via: "workflow" }]);
      await say(db, leg.repo, leg.number, `${ACTOR} cancelled the pre-approved merge.`);
    }
    await saveWorkflows(db, [{ id: w.id, patch: b.patch, at: b.at }]);
    await recordEvents(db, [{ workflowId: w.id, repo: w.repo, number: w.number, login: ACTOR, via: "cli", kind: "blocked", line: b.line, at: b.at }]);
    return "written";
  });
}
