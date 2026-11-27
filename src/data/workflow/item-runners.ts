// Task Runners taken onto one item's live workflow (`take` / `release`, src/workflow/apply.ts). The claim reads the grants through
// startedWorkAllows (src/data/runners/cross.ts) and the Task Runner snapshot through loadStartedWork (rows.ts); a grant whose
// workflow ended counts nowhere, so nothing clears it. The writer's caller drops the runner snapshot cache (src/data/runners).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import { LIVE_STATES } from "./fragments.ts";

const T = "main.item_runners";

/** A live grant: `login` (lower case) took the workflow's work onto their Task Runner at `at`. */
export type ItemRunner = { workflowId: number; repo: string; number: number; login: string; at: string };

/** Records the grant; false when the login already holds a live one on the workflow. */
export async function takeItemRunner(db: Db, g: ItemRunner): Promise<boolean> {
  const q = queryDb(db);
  const r = await q.run(q.k.insertInto(T).values({ repo: g.repo, number: g.number, workflow_id: g.workflowId, login: g.login.toLowerCase(), at: g.at })
    .onConflict((oc) => oc.columns(["workflow_id", "login"]).where("released_at", "is", null).doNothing()));
  return Number(r.changes) > 0;
}

/** Ends the login's live grant on the workflow; false when it held none. */
export async function releaseItemRunner(db: Db, g: { workflowId: number; login: string; at: string }): Promise<boolean> {
  const q = queryDb(db);
  const r = await q.run(q.k.updateTable(T).set({ released_at: g.at }).where("workflow_id", "=", g.workflowId).where("login", "=", g.login.toLowerCase()).where("released_at", "is", null));
  return Number(r.changes) > 0;
}

/** The live grants on these workflows while they are live, oldest first, by workflow id. */
export async function loadItemRunners(db: Db, workflowIds: readonly number[]): Promise<Map<number, ItemRunner[]>> {
  const out = new Map<number, ItemRunner[]>();
  if (!workflowIds.length) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom(`${T} as g`).innerJoin("main.item_workflows as w", "w.id", "g.workflow_id")
    .select(["g.workflow_id", "g.repo", "g.number", "g.login", "g.at"]).where("g.workflow_id", "in", [...workflowIds]).where("g.released_at", "is", null)
    .where("w.state", "in", LIVE_STATES).orderBy("g.id"));
  for (const r of rows) {
    const id = Number(r.workflow_id);
    (out.get(id) ?? out.set(id, []).get(id)!).push({ workflowId: id, repo: r.repo, number: Number(r.number), login: r.login, at: r.at });
  }
  return out;
}
