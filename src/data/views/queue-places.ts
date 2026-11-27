// reads: planner.item_plans, triage.item_rank
// The places of open items in the pipeline's queued stages: what the Work queue and the item page order by.
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { openItem } from "../mirror/fragments.ts";
import { openItemKeys } from "../mirror/index.ts";
import { inPlanScope } from "../planner/fragments.ts";
import { loadWorkScores } from "../workflow/index.ts";

/** A ranked open item in the pipeline's scope whose stored plan's next step is asked for; `score` is its rank, raised to its work score once started. */
export type QueuedStep = { repo: string; number: number; state: string; next: string; score: number };

/** The ranked open items whose next step is one of `next`, with their work score. One wave. */
export async function loadQueuedSteps(db: Db, next: readonly string[]): Promise<QueuedStep[]> {
  const q = queryDb(db);
  const step = kx.jsonText(db, "p.view", "$.next");
  const [rows, work] = await db.together(() => Promise.all([
    q.all(q.k.selectFrom("main.item_plans as p").innerJoin("main.item_rank as r", (j) => j.onRef("r.repo", "=", "p.repo").onRef("r.number", "=", "p.number"))
      .select(["p.repo", "p.number", "p.state", step.as("next"), "r.score"])
      .where(kx.inList(db, step, next)).where((eb) => inPlanScope(eb, "p")).where((eb) => openItem(eb, "p.repo", "p.number"))
      .orderBy("p.repo").orderBy("p.number"), { label: "views.loadQueuedSteps" }),
    loadWorkScores(db, openItemKeys()),
  ]));
  return rows.map((r) => {
    const key = `${r.repo}#${r.number}`;
    return { repo: r.repo, number: Number(r.number), state: r.state, next: r.next!, score: work.get(key) ?? Number(r.score) };
  });
}
