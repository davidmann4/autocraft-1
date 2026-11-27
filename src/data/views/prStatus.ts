// Read model of the PR status comment step (src/prstatus/index.ts): the stored comments, the PRs in the pipeline's scope and the
// started items of some repos in one wave, then the batch, answer and quiet facts of the PRs the step looks at.
// reads: workflow.pr_status_comments, workflow.item_workflows, workflow.workflow_events, mirror.items, planner.item_stage, merge.merge_batches, merge.merge_batch_prs, security (quiet)
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { loadAnswers, loadLatestWorkflows, loadStatusComments } from "../workflow/index.ts";
import { inScopeExpr } from "../workflow/fragments.ts";
import { loadQuiet } from "../security/index.ts";
import { ACTIVE_BATCH } from "../merge/types.ts";
import { resolveKeys } from "../keys.ts";
import type { StatusExtras, StatusInputs } from "./types.ts";

/**
 * Per repo of `repos`: the stored comments that are not final, the open PRs in scope past triage (a stage row) that are not integration
 * PRs (of the repos `scoped` only), and each started item's latest workflow with whether the item is open. One `together` wave.
 */
export async function loadStatusInputs(db: Db, repos: readonly string[], scoped: readonly string[] = repos): Promise<Map<string, StatusInputs>> {
  const out = new Map<string, StatusInputs>(repos.map((r) => [r, { stored: [], inScope: new Set(), started: new Map() }]));
  if (!repos.length) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const scopeQ = k.selectFrom("main.items as i").select(["i.repo", "i.number"])
    .where(kx.inList(db, "i.repo", [...scoped])).where("i.kind", "=", "pr").where("i.state", "=", "OPEN")
    .where((eb: any) => eb.exists(eb.selectFrom("main.item_stage as s").select(eb.lit(1).as("one")).whereRef("s.repo", "=", "i.repo").whereRef("s.number", "=", "i.number")))
    .where((eb: any) => eb.not(eb.exists(eb.selectFrom("main.merge_batches as b").select(eb.lit(1).as("one")).whereRef("b.repo", "=", "i.repo").whereRef("b.pr_number", "=", "i.number"))))
    .where((eb: any) => inScopeExpr(db, eb, "i.repo", "i.number"));
  const [stored, scope, started] = await db.together(() => Promise.all([
    loadStatusComments(db, repos),
    scoped.length ? q.all(scopeQ) as Promise<{ repo: string; number: number }[]> : Promise.resolve([]),
    loadLatestWorkflows(db, repos),
  ]));
  for (const r of stored) out.get(r.repo)!.stored.push(r);
  for (const r of scope) out.get(r.repo)!.inScope.add(Number(r.number));
  for (const w of started.values()) out.get(w.wf.repo)!.started.set(w.wf.number, w);
  return out;
}

/**
 * Of the PRs `refs`: each one's open merge batch at its current head (`open:repo#N`) and the batch it merged with
 * (`merged:repo#N`), with the batch's PR number (null before it opens); the latest answer of each workflow in `workflowIds`; and the
 * quiet PRs ("repo#N"). One `together` wave.
 */
export async function loadStatusExtras(db: Db, refs: readonly { repo: string; number: number }[], workflowIds: number[]): Promise<StatusExtras> {
  const q = queryDb(db);
  const k = q.k as any;
  const batchQ = k.selectFrom("main.merge_batch_prs as bp").innerJoin("main.merge_batches as b", "b.id", "bp.batch_id")
    .innerJoin("main.items as i", (j: any) => j.onRef("i.repo", "=", "b.repo").onRef("i.number", "=", "bp.number"))
    .innerJoin(resolveKeys(db, [...refs], "kk"), (j: any) => j.onRef("kk.repo", "=", "b.repo").onRef("kk.number", "=", "bp.number"))
    .select(["b.repo", "bp.number", "b.state", "b.pr_number", "bp.head_oid", "i.head_oid as head"])
    .where("b.state", "in", [...ACTIVE_BATCH, "merged"]).orderBy("b.id");
  const keys = refs.map((r) => `${r.repo}#${r.number}`);
  const [rows, answered, quiet] = await db.together(() => Promise.all([
    refs.length ? q.all(batchQ) as Promise<{ repo: string; number: number; state: string; pr_number: number | null; head_oid: string; head: string | null }[]> : Promise.resolve([]),
    loadAnswers(db, workflowIds),
    loadQuiet(db, keys),
  ]));
  const batches = new Map<string, { pr: number | null }>();
  for (const r of rows) {
    const pr = r.pr_number === null ? null : Number(r.pr_number);
    if (r.state === "merged") batches.set(`merged:${r.repo}#${Number(r.number)}`, { pr });
    else if (r.head_oid === r.head) batches.set(`open:${r.repo}#${Number(r.number)}`, { pr });
  }
  return { batches, answered, quiet };
}
