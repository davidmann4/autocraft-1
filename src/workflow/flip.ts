// Moves a tracked repo between the decision pipeline (`legacy`) and the maintainer workflow (`new`).
//
// To `new`, the repo starts over: no workflow rows are made from legacy state. The open Merge?, Hold and scope questions of
// items with no live workflow are withdrawn (renamed `~replaced-flip-` and answered withdrawn by the pipeline, as
// src/merge/withdraw.ts sets a question aside; a scope question's asked stage is cleared too), so nothing waits on a question
// the new model does not ask. Duplicate, close, split, backlog, implement and stuck questions stay. Pre-approvals, fast track
// and operator fix-ups are left as they are. Old reviews, decisions and conversations stay as the item's history. A flip
// writes nothing to GitHub. A repo on the maintainer workflow is one we maintain, so it has the PR status comment, merging and
// pushing approved (the Repos page switches): a flip to `new` turns the ones that are off on as the flipper, and so does a flip
// of a repo already on `new`. The automatic merges and pushes the workflow keeps need them.
//
// To `legacy` (rollback), the repo's live workflows stop and their pre-approvals lose the link; the switches stay as they are. The old planner carries on
// from the legacy rows and asks the withdrawn questions again as new rows.
//
// Idempotent, like src/db/fix-retire.ts: a repo already on the target model, with nothing left to stop, changes nothing.
// One audit row per flip that changed something. Refused to `new` while the GitHub identity is `box`, since merges and
// closes in the workflow are made as the person, and while WORKFLOW_ENGINE_READY is false.
import { audit } from "../dash/audit.ts";
import type { Db } from "../db/index.ts";
import { clearAskedStage } from "../decisions.ts";
import { githubIdentity } from "../github/identity.ts";
import { pushApprovalOf, setPushApproval } from "../fixup/approval.ts";
import { mergeApprovalOf, setMergeApproval } from "../merge/approval.ts";
import { renameDecision, WITHDRAWN } from "../merge/withdraw.ts";
import { setStatusApproval, statusApprovalOf } from "../prstatus/approval.ts";
import { addEvent, liveWorkflows, repoWorkflow, type RepoWorkflow } from "./store.ts";

export const FLIP_WITHDRAWN_NOTE = "withdrawn when the repo moved to the maintainer workflow";
/** The id suffix of a question a flip withdrew; `~replaced-` keeps it out of every reader of current questions. */
const FLIP_SUFFIX = "~replaced-flip-";
/** Question kinds a flip to `new` withdraws. */
const WITHDRAWN_KINDS = ["merge", "hold", "scope"];
/**
 * Whether the planner works item_workflows. Until it does, a flip to `new` would only withdraw questions the legacy planner
 * asks again, so a real flip is refused; a dry run still reports what it would do.
 */
export const WORKFLOW_ENGINE_READY = true;
const ENGINE_NOT_READY = "the planner does not work maintainer workflows yet: a flip now would only withdraw questions the legacy planner asks again";

export class FlipRefused extends Error {}

export type FlipDecision = { id: string; kind: string; number: number };

/** The Repos page switches every repo on the maintainer workflow has on, with how each is read and set. */
const SWITCHES = {
  status: { on: statusApprovalOf, set: setStatusApproval, line: "turn the PR status comment on" },
  merge: { on: mergeApprovalOf, set: setMergeApproval, line: "approve merging" },
  push: { on: pushApprovalOf, set: setPushApproval, line: "approve pushing fix-ups" },
} satisfies Record<string, { on: (db: Db, repo: string) => Promise<unknown>; set: (db: Db, by: string, repo: string, approved: boolean) => Promise<boolean>; line: string }>;
export type RepoSwitch = keyof typeof SWITCHES;
export type FlipReport = {
  repo: string;
  from: RepoWorkflow;
  to: RepoWorkflow;
  applied: boolean;
  /** Why the flip cannot run; a dry run reports it, a real flip throws it. */
  refused: string | null;
  withdrawn: FlipDecision[];
  /** Live workflows stopped by a rollback. */
  stopped: { id: number; number: number }[];
  /** Rollback: questions an earlier flip withdrew on items still open, which the legacy planner asks again. */
  reasked: number;
  /** To `new`: the switches that were off and the flip turns on (a dry run: would turn on). */
  switchesOn: RepoSwitch[];
};

/** The open questions a flip of `repo` to `new` withdraws, read in the caller's transaction. */
async function toWithdraw(db: Db, repo: string): Promise<FlipDecision[]> {
  const live = new Set((await liveWorkflows(db, repo)).map((w) => w.number));
  const open = await db.all(db.k.selectFrom("main.decisions").select(["id", "kind", "number"]).$narrowType<{ number: number }>()
    .where("repo", "=", repo).where("number", "is not", null).where("answer", "is", null).where("kind", "in", WITHDRAWN_KINDS).orderBy("asked_at").orderBy("id"));
  return open.filter((d) => !live.has(d.number));
}

/**
 * Flips `repo` to `to`. A dry run (`apply` false) reads and reports only. `by` is recorded on the audit row, the stopped
 * events, and as the stopper of a rollback.
 */
export async function flipRepo(db: Db, repo: string, o: { to: RepoWorkflow; by: string; apply: boolean; at?: string; /** Tests only: WORKFLOW_ENGINE_READY. */ engineReady?: boolean }): Promise<FlipReport> {
  const at = o.at ?? new Date().toISOString();
  const work = async (): Promise<FlipReport> => {
    if (!await db.get(db.k.selectFrom("main.tracked_repos").select("name").where("name", "=", repo))) throw new FlipRefused(`${repo} is not tracked`);
    const from = await repoWorkflow(db, repo);
    const report: FlipReport = { repo, from, to: o.to, applied: false, refused: null, withdrawn: [], stopped: [], reasked: 0, switchesOn: [] };
    if (o.to === "new") {
      for (const k of Object.keys(SWITCHES) as RepoSwitch[]) if (await SWITCHES[k].on(db, repo) === null) report.switchesOn.push(k);
      // A repo already on `new` whose switches were turned off since gets them back, and nothing else.
      if (from === "new") {
        if (!report.switchesOn.length) return report;
      } else {
        if (await githubIdentity(db) === "box") report.refused = "the GitHub identity is box: switch it to the app first, so merges and closes are made as the person";
        else if (!(o.engineReady ?? WORKFLOW_ENGINE_READY)) report.refused = ENGINE_NOT_READY;
        report.withdrawn = await toWithdraw(db, repo);
      }
    } else {
      report.stopped = (await liveWorkflows(db, repo)).map((w) => ({ id: w.id, number: w.number }));
      if (from === "legacy" && !report.stopped.length) return report;
      report.reasked = Number((await db.get(db.k.selectFrom("main.decisions as d").select((eb) => eb.fn.countAll<number>().as("n"))
        .innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "d.repo").onRef("i.number", "=", "d.number"))
        .where("d.repo", "=", repo).where("i.state", "=", "OPEN").where("d.answer", "=", WITHDRAWN).where("d.answer_note", "=", FLIP_WITHDRAWN_NOTE)))?.n ?? 0);
    }
    if (!o.apply) return report;
    if (report.refused) throw new FlipRefused(report.refused);
    const clear = clearAskedStage(db);
    for (const d of report.withdrawn) {
      const to = `${d.id}${FLIP_SUFFIX}${at}`;
      await renameDecision(db, d.id, to);
      await db.run(db.k.updateTable("main.decisions")
        .set({ answer: WITHDRAWN, answered_by: "pipeline", answered_at: at, applied_at: at, answer_note: FLIP_WITHDRAWN_NOTE, adopted_opinion: null })
        .where("id", "=", to).where("answer", "is", null));
      if (d.kind === "scope") await clear(repo, d.number, d.id);
    }
    for (const w of report.stopped) {
      await db.run(db.k.updateTable("main.item_workflows").set({ state: "stopped", stopped_by: o.by, stopped_at: at, updated_at: at }).where("id", "=", w.id));
      await db.run(db.k.updateTable("main.preapprovals").set({ workflow_id: null }).where("workflow_id", "=", w.id));
      await addEvent(db, { workflowId: w.id, repo, number: w.number, login: o.by, via: "cli", kind: "stopped", at });
    }
    if (from !== o.to) await db.run(db.k.updateTable("main.tracked_repos").set({ workflow: o.to }).where("name", "=", repo));
    for (const k of report.switchesOn) await SWITCHES[k].set(db, o.by, repo, true);
    await audit(db, o.by, "workflow-flip", repo, { from, to: o.to, withdrawn: report.withdrawn.map((d) => d.id), stopped: report.stopped.map((w) => w.number), switchesOn: report.switchesOn });
    report.applied = true;
    return report;
  };
  return o.apply ? await db.write(work) : await db.read(work);
}

/** The report as lines for the CLI. */
export function flipLines(r: FlipReport): string[] {
  const out: string[] = [];
  if (r.refused) out.push(`refused: ${r.refused}`);
  if (r.from === r.to && !r.withdrawn.length && !r.stopped.length && !r.switchesOn.length) return [...out, `${r.repo} already runs ${r.to}; nothing to change`];
  out.push(`${r.repo}: ${r.from} -> ${r.to}${r.applied ? "" : " (dry run)"}`);
  for (const k of r.switchesOn) out.push(`  ${SWITCHES[k].line}`);
  for (const d of r.withdrawn) out.push(`  withdraw ${d.kind} question ${d.id}`);
  for (const w of r.stopped) out.push(`  stop workflow ${w.id} on #${w.number}`);
  if (r.to === "legacy" && r.reasked) {
    out.push(`  ${r.reasked} question${r.reasked === 1 ? "" : "s"} the flip to new withdrew will be asked again: new decision rows and prepare calls;`
      + " their earlier discussion stays on the renamed rows");
  }
  return out;
}
