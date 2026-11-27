// One-item reads of the maintainer workflow's rows (item_workflows, workflow_events) over the workflow module. Code that works on
// many items calls the module's set loaders (src/data/workflow) directly; callers change a row only through the command core.
import { listWorkflows, loadEvents, loadWorkflowHistory, recordEvents, saveWorkflows, startWorkflows, workflowOf, type SaidEvent, type WorkflowEvent, type WorkflowPatch } from "../data/workflow/index.ts";
import type { Db } from "../db/index.ts";
import { WEIGHT_NORMAL, type ItemWorkflow, type WorkflowState } from "./types.ts";

export { workflowOf };
export type { SaidEvent, WorkflowEvent };
export type { WorkflowPatch };

/** States of a live row; the unique index item_workflows_live allows one per item. */
export const LIVE_STATES = ["running", "waiting", "blocked", "recommending"] as const satisfies readonly WorkflowState[];
export const isLive = (s: WorkflowState): boolean => (LIVE_STATES as readonly string[]).includes(s);

/** The item's live workflow, if it has one. */
export async function liveWorkflow(db: Db, repo: string, number: number): Promise<ItemWorkflow | null> {
  return (await listWorkflows(db, { live: true, refs: [{ repo, number }] }))[0] ?? null;
}

/** Live workflows, of one repo when given, oldest first. */
export async function liveWorkflows(db: Db, repo?: string): Promise<ItemWorkflow[]> {
  return await listWorkflows(db, { live: true, ...(repo !== undefined ? { repos: [repo] } : {}) });
}

/** Every workflow the item has had, oldest first. */
export async function workflowHistory(db: Db, repo: string, number: number): Promise<ItemWorkflow[]> {
  return (await loadWorkflowHistory(db, [{ repo, number }])).get(`${repo}#${number}`) ?? [];
}

/** The item's events, oldest first. */
export async function eventsOf(db: Db, repo: string, number: number): Promise<SaidEvent[]> {
  return (await loadEvents(db, [{ repo, number }])).get(`${repo}#${number}`) ?? [];
}

export async function addEvent(db: Db, e: WorkflowEvent): Promise<void> {
  await recordEvents(db, [e]);
}

export type NewWorkflow = Pick<ItemWorkflow, "repo" | "number" | "kind" | "entry" | "state" | "startedBy" | "startedAt" | "startedVia">
  & Partial<Omit<ItemWorkflow, "id" | "updatedAt" | "repo" | "number" | "kind" | "entry" | "state" | "startedBy" | "startedAt" | "startedVia">>;

/** Inserts one workflow in any state and returns its id; refused when the item already has a live one. */
export async function insertWorkflow(db: Db, w: NewWorkflow, at = new Date().toISOString()): Promise<number> {
  const key = `${w.repo}#${w.number}`;
  return await db.write(async () => {
    const id = (await startWorkflows(db, [{
      repo: w.repo, number: w.number, kind: w.kind, entry: w.entry, weight: w.weight ?? WEIGHT_NORMAL, startedBy: w.startedBy, startedVia: w.startedVia,
      baseHead: w.baseHead ?? null, approvedBy: w.approvedBy ?? null, approvedVia: w.approvedVia ?? null, plan: w.plan ?? [], step: w.step ?? null, at: w.startedAt,
    }])).get(key);
    if (id === undefined) throw new Error(`${key} already has a live workflow`);
    const patch: WorkflowPatch = {
      ...(w.state !== "running" ? { state: w.state } : {}),
      ...(w.approvedAt !== undefined ? { approvedAt: w.approvedAt } : {}),
      ...(w.acceptedHead !== undefined ? { acceptedHead: w.acceptedHead } : {}),
      ...(w.stoppedBy != null ? { stoppedBy: w.stoppedBy, stoppedAt: w.stoppedAt ?? null } : {}),
      ...(w.blocker != null ? { blocker: w.blocker, blockerParams: w.blockerParams ?? null } : {}),
      ...(w.rec != null ? { rec: w.rec, recAt: w.recAt ?? null, recHead: w.recHead ?? null } : {}),
    };
    await saveWorkflows(db, [{ id, patch, at }]);
    return id;
  });
}

/** Writes the given fields of a workflow; returns false when no row has the id. */
export async function updateWorkflow(db: Db, id: number, p: WorkflowPatch, at = new Date().toISOString()): Promise<boolean> {
  return await saveWorkflows(db, [{ id, patch: p, at }]) === 1;
}
