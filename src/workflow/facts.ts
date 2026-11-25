// What the planner reads of the maintainer workflow: each tracked repo's model and the live workflows of the repos that run
// it. A live row in a repo switched back to legacy is not a fact (a rollback stops them anyway).
import type { Db } from "../db/index.ts";
import type { EndedWorkflow, RepoWorkflow, WorkflowFact } from "../core/plan.ts";
import { LIVE_STATES, liveWorkflows, repoWorkflows } from "./store.ts";

export type WorkflowFacts = {
  /** The repo's model; an untracked repo reads as legacy. */
  model: (repo: string) => RepoWorkflow;
  /** The item's own live workflow, by `repo#number`, in a repo on the maintainer workflow. */
  live: (repo: string, number: number) => WorkflowFact | null;
  /** A PR's workflow: its own, else, for the PR of an implementation, the live implement workflow of its issue. */
  ofPr: (repo: string, number: number, implementedIssue: number | null) => WorkflowFact | null;
  /** How the item's latest workflow ended, when it has no live one; in a repo on the maintainer workflow. */
  ended: (repo: string, number: number) => EndedWorkflow | null;
};

export async function loadWorkflowFacts(db: Db, repo?: string): Promise<WorkflowFacts> {
  const models = new Map((await repoWorkflows(db)).map((r) => [r.repo, r.workflow]));
  const model = (r: string): RepoWorkflow => models.get(r) ?? "legacy";
  const rows = new Map<string, WorkflowFact>();
  const endedRows = new Map<string, EndedWorkflow>();
  const repos = [...models].filter(([r, m]) => m === "new" && (repo === undefined || r === repo)).map(([r]) => r);
  if (repos.length) {
    for (const w of await liveWorkflows(db, repo)) {
      if (model(w.repo) !== "new") continue;
      rows.set(`${w.repo}#${w.number}`, { entry: w.entry, approved: w.approvedBy !== null, startedBy: w.startedBy, startedAt: w.startedAt, own: true });
    }
    // Oldest first, so the latest ended row of each item stays.
    for (const w of await db.all(db.k.selectFrom("main.item_workflows").select(["repo", "number", "state"]).where("repo", "in", repos)
      .where("state", "not in", LIVE_STATES).orderBy("id"))) endedRows.set(`${w.repo}#${w.number}`, w.state as EndedWorkflow);
  }
  const live = (r: string, n: number): WorkflowFact | null => rows.get(`${r}#${n}`) ?? null;
  return {
    model, live,
    ended: (r, n) => (rows.has(`${r}#${n}`) ? null : endedRows.get(`${r}#${n}`) ?? null),
    ofPr: (r, n, issue) => {
      const own = live(r, n);
      if (own || issue === null) return own;
      const w = live(r, issue);
      return w?.entry === "implement" ? { ...w, own: false } : null;
    },
  };
}
