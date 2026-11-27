// reads: planner.item_plans, mirror.items, triage.item_rank, workflow.preapprovals, merge.merge_batches, merge.merge_batch_prs
// The merge queue: the PRs whose stored plan is in a queue state, with their title; counts and the views of open plans.
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import type { PlanView, QueueView } from "../../core/plan-cache.ts";
import type { QueueState } from "../../core/plan.ts";
import { hiddenRepos } from "../control/fragments.ts";
import type { HiddenRepos } from "../control/types.ts";
import { inPlanScope, planGh, queuedPlan } from "../planner/fragments.ts";

/** A PR in a queue state as the merge queue lists it: the plan's state, reasons and note and the cached queue fields. `gh` is GitHub's state as mirrored. */
export type CachedEntry = QueueView & {
  repo: string; number: number; title: string; state: QueueState; outsideRule: string[]; note: string | null; gh: "OPEN" | "MERGED" | "CLOSED";
};

export type MergeQueueOptions = {
  repo?: string;
  /** Which PRs by GitHub state: open ones only, merged ones only, or both (default). Closed ones are never listed. */
  merged?: "exclude" | "only" | "all";
  /** Keyset page: entries after this PR in (repo, number) order, at most `limit` of them. */
  after?: { repo: string; number: number };
  limit?: number;
  hidden?: HiddenRepos;
  /** Only these PRs, as "repo#number". */
  refs?: Iterable<string>;
};

/** The states of a merge approval whose PR is not in a queue state yet. */
export const LEG_STATES = ["fixup", "review", "ci"] as const;

const filtered = (h: HiddenRepos | undefined): h is HiddenRepos => !!h && (!!h.visible || h.length > 0);

/** The queue entries in (repo, number) order. 1 statement. */
export async function loadMergeQueue(db: Db, o: MergeQueueOptions = {}): Promise<CachedEntry[]> {
  const which = o.merged ?? "all";
  const q = queryDb(db);
  const gh = planGh(db, "p");
  const rows = await q.all(q.k.selectFrom("main.item_plans as p").leftJoin("main.items as i", (j) => j.onRef("i.repo", "=", "p.repo").onRef("i.number", "=", "p.number"))
    .select(["p.repo", "p.number", "i.title", "p.state", "p.reasons", "p.note", "p.view"])
    .where((eb) => queuedPlan(db, eb, "p"))
    .$if(!!o.repo, (b) => b.where("p.repo", "=", o.repo!))
    .$if(filtered(o.hidden), (b) => b.where(hiddenRepos(db, "p.repo", o.hidden!)))
    .$if(!!o.refs, (b) => b.where(kx.refIn(db, "p", o.refs!)))
    .where((eb) => (which === "exclude" ? eb(gh, "=", "OPEN") : which === "only" ? eb(gh, "=", "MERGED") : eb(gh, "<>", "CLOSED")))
    .$if(!!o.after, (b) => b.where((eb) => eb.or([eb("p.repo", ">", o.after!.repo), eb.and([eb("p.repo", "=", o.after!.repo), eb("p.number", ">", o.after!.number)])])))
    .orderBy("p.repo").orderBy("p.number")
    .$if(!!o.limit, (b) => b.limit(Math.floor(o.limit!))), { label: "views.loadMergeQueue" });
  return rows.map((r) => {
    const v = JSON.parse(r.view) as PlanView;
    return { ...v.queue!, repo: r.repo, number: Number(r.number), title: r.title ?? "", state: r.state as QueueState, outsideRule: JSON.parse(r.reasons) as string[], note: r.note, gh: v.gh! };
  });
}

/** The rank and the closing issues (stored JSON) of each open PR in a queue state. 1 statement. */
export async function loadQueueRanks(db: Db): Promise<{ repo: string; number: number; score: number | null; closing_issues: string | null }[]> {
  const q = queryDb(db);
  return await q.all(q.k.selectFrom("main.item_plans as p").innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "p.repo").onRef("i.number", "=", "p.number"))
    .leftJoin("main.item_rank as r", (j) => j.onRef("r.repo", "=", "p.repo").onRef("r.number", "=", "p.number"))
    .select(["p.repo", "p.number", "r.score", "i.closing_issues"]).where((eb) => queuedPlan(db, eb, "p")).where(planGh(db, "p"), "=", "OPEN"), { label: "views.loadQueueRanks" });
}

/** The open items whose stored plan is in the pipeline's scope, of those a merge queue can show (a queue state, an active merge approval, a member of an open batch), as `repo#number`. 1 statement. */
export async function loadPipelineScope(db: Db): Promise<Set<string>> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.item_plans as p").innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "p.repo").onRef("i.number", "=", "p.number"))
    .select(["p.repo", "p.number"]).where("i.state", "=", "OPEN").where((eb) => inPlanScope(eb, "p"))
    .where((eb) => eb.or([
      queuedPlan(db, eb, "p"),
      eb(eb.refTuple("p.repo", "p.number"), "in", q.k.selectFrom("main.preapprovals as l").select(["l.repo", "l.number"]).where("l.state", "in", [...LEG_STATES]).$asTuple("repo", "number")),
      eb(eb.refTuple("p.repo", "p.number"), "in", q.k.selectFrom("main.merge_batch_prs as bp").innerJoin("main.merge_batches as b", "b.id", "bp.batch_id")
        .select(["b.repo", "bp.number"]).where("b.state", "in", ["checking", "open"]).$asTuple("repo", "number")),
    ])), { label: "views.loadPipelineScope" });
  return new Set(rows.map((r) => `${r.repo}#${r.number}`));
}
