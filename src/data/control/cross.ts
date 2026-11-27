// reads: mirror.items, mirror.pr_checks, workflow.item_workflows, workflow.workflow_actions, jobs.job_items
// resolvePushes closes outcomes of items that are closed or moved head (one UPDATE joined to items); pushesUnsettled reads the open
// pushes joined to open items at the pushed head and their stored checks (one statement); loadActBlocked embeds the workflow module's
// `repoScopeCols`; loadActUsage adds Act job items.
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";

/** Open-PR pushes (outcome not set, at or after `since`) whose head is still the pushed commit, with the stored checks of that head. */
export async function loadOpenHeadPushes(db: Db, repos: readonly string[], since: string): Promise<{ repo: string; oid: string; checks: string | null }[]> {
  if (!repos.length) return [];
  const q = queryDb(db);
  return await q.all(q.k.selectFrom("main.push_outcomes as p")
    .innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "p.repo").onRef("i.number", "=", "p.number").on("i.state", "=", "OPEN").onRef("i.head_oid", "=", "p.to_oid"))
    .leftJoin("main.pr_checks as c", (j) => j.onRef("c.repo", "=", "p.repo").onRef("c.number", "=", "p.number").onRef("c.head_oid", "=", "p.to_oid"))
    .select(["p.repo as repo", "p.to_oid as oid", "c.checks as checks"])
    .where(kx.inList(db, "p.repo", [...repos])).where("p.outcome", "is", null).where("p.number", "is not", null).where("p.at", ">=", since));
}

/** Sets outcome `unknown` on unsettled pushes whose PR is closed or merged, or whose head moved past the pushed commit; returns the rows changed. */
export async function closeMovedPushOutcomes(db: Db, at: string): Promise<number> {
  const q = queryDb(db);
  return (await q.run(q.k.updateTable("main.push_outcomes").set({ outcome: "unknown", resolved_at: at }).where("outcome", "is", null).where("number", "is not", null)
    .where((eb) => eb.exists(eb.selectFrom("main.items as i").select(eb.lit(1).as("one"))
      .whereRef("i.repo", "=", "main.push_outcomes.repo").whereRef("i.number", "=", "main.push_outcomes.number")
      .where((ie) => ie.or([ie("i.state", "<>", "OPEN"), ie.and([
        ie("i.head_oid", "is not", null),
        ie("i.head_oid", "<>", ie.ref("main.push_outcomes.to_oid")),
        ie("i.head_oid", "is distinct from", ie.ref("main.push_outcomes.from_oid")),
      ])])))))).changes;
}
