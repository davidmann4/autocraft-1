// Executors take their work from Plans: the PRs whose Plan holds an action of their kind.
import { approvedForMerge, decidePr, workflowOf } from "./decide.ts";
import { RULE_STARTER } from "../workflow/types.ts";
import { loadPass, loadPrFact, loadPrFacts } from "./facts.ts";
import { loadPassBase } from "./pass-load.ts";
import { loadDueRefs } from "../data/planner/index.ts";
import type { PlanSet } from "./plan-set.ts";
import { mayRun } from "./authority.ts";
import { CLI_BY, type By } from "./gates.ts";
import { WAITS_ON_PERSON, inFlightNow } from "./assignment.ts";
import type { Action, ActionKind, ItemFacts, Plan, PrFacts } from "./plan.ts";
import { byScore } from "./work-score.ts";
import type { Db } from "../db/index.ts";

export type Planned = { facts: PrFacts; plan: Plan; action: Action };

export type PlannedOptions = {
  repo?: string;
  /** Only actions with this bucket parameter (verify: plan | unavailable; fix-up: fix | ask, ...). */
  bucket?: string;
  /** Who the work is selected for (default: the pipeline, whose work also needs the global switch on). */
  by?: By;
  /** Also the actions that may not run now (mayRun): the Next lists name why, and their stored patches are kept. */
  refused?: boolean;
  /** Only these PRs, as "repo#number". */
  refs?: Iterable<string>;
  /** The classification run for labels (default: the latest). */
  run?: string | null;
  /** Decision time in ms (default: the clock). */
  now?: number;
  /** Plans decided already (the planner's pass): no facts are loaded; `now` and `run` are the set's. */
  plans?: PlanSet;
  /** Called with every PR decided, due or not (the autopilot reads wake times from them). */
  onPlan?: (facts: PrFacts, plan: Plan) => void;
  /** Only PRs of their own lane (true, ownLane) or only the others (false): the work of a step's approved-lane or regular job. */
  approved?: boolean;
};

export { WAITS_ON_PERSON, inFlightNow };

/** The PR decided on facts read now; null when the pass no longer holds it. */
export async function planNow(db: Db, repo: string, number: number, now?: number): Promise<{ facts: PrFacts; plan: Plan } | null> {
  const facts = await loadPrFact(db, repo, number, now !== undefined ? { now } : {});
  return facts && { facts, plan: decidePr(facts, loadPass(now)) };
}

/** Why a plan has no action of `kind` at the head any more, or the action may not run; null when it may. The global switch is not asked: a running job finishes the work it started. */
export function notDue(p: { facts: PrFacts; plan: Plan } | null, kind: ActionKind, head: string): string | null {
  if (!p) return "no longer an open PR";
  const due = p.plan.actions.filter((a) => a.kind === kind && a.head === head).map((action) => mayRun({ facts: p.facts, action }, CLI_BY));
  if (due.some((m) => m.ok)) return null;
  for (const m of due) if (!m.ok) return m.why.text;
  return [...p.plan.reasons, ...(p.plan.wait ? [p.plan.wait] : [])].join(", ") || `now ${p.plan.state}`;
}

/**
 * A PR whose work runs in a job of its own in each lane step (the approved lane, src/runner/concurrency.ts): a person started or
 * approved its live workflow. A row the automatic merge rule started joins only once a person approves it; until then its work
 * runs in the repo's regular job, with the PRs nobody started.
 */
export const ownLane = (f: Pick<PrFacts, "workflow">): boolean => approvedForMerge(f) || (workflowOf(f)?.startedBy ?? RULE_STARTER) !== RULE_STARTER;

/** Why a PR no longer belongs to the lane of a job that works only PRs of their own lane (`approved`, ownLane) or only the others; null when it does. */
export function laneMismatch(f: PrFacts, approved: boolean): string | null {
  if (ownLane(f) === approved) return null;
  return approved ? "no longer started or approved by a person" : "started or approved by a person since the job started: its own job works it";
}

/** The due work that may run for `by` (mayRun), and why the rest may not: the first reason, with how many it and others hold back (null: none). */
export function runnable<T extends { facts: PrFacts | ItemFacts; action: Action }>(due: readonly T[], by: By): { may: T[]; held: string | null } {
  const may: T[] = [];
  let why: string | null = null;
  for (const p of due) {
    const m = mayRun(p, by);
    if (m.ok) may.push(p);
    else why ??= m.why.text;
  }
  return { may, held: why === null ? null : `${due.length - may.length} held back: ${why}` };
}

/**
 * The PRs with an action of `kind` due that may run (mayRun), in selection order: rank score descending (unranked last), then repo and number.
 * Our own broken pushes come first, then work in flight, then rank score. Facts are loaded once for all of them.
 */
export async function planned(db: Db, kind: ActionKind, opts: PlannedOptions = {}): Promise<Planned[]> {
  const { bucket, onPlan, plans, by = "pipeline", refused, approved, ...load } = opts;
  const out: Planned[] = [];
  let source: Iterable<{ facts: PrFacts; plan: Plan }>;
  if (plans) {
    const refs = load.refs ? new Set(load.refs) : null;
    source = plans.prs.filter((p) => (!load.repo || p.facts.repo === load.repo) && (!refs || refs.has(`${p.facts.repo}#${p.facts.number}`)));
  } else {
    const pass = loadPass(load.now);
    // Without refs, a step decides only the PRs that can be due (planner.loadDueRefs), unless it asks for another time or
    // run than the stored Plans', or for every PR's Plan (onPlan).
    const [current, due] = load.refs || onPlan || load.now !== undefined ? [null, null] : await db.together(() => Promise.all([loadPassBase(db), loadDueRefs(db, kind, "pr", load.repo)]));
    const stored = current && typeof load.run === "string" && load.run !== current.run ? null : due;
    const base = current && load.run !== undefined ? { ...current, run: load.run } : current;
    source = stored && !stored.length ? [] : (await loadPrFacts(db, { ...load, ...(stored ? { refs: stored } : {}), ...(base ? { base } : {}) })).map((facts) => ({ facts, plan: decidePr(facts, pass) }));
  }
  for (const { facts, plan } of source) {
    onPlan?.(facts, plan);
    if (approved !== undefined && ownLane(facts) !== approved) continue;
    for (const action of plan.actions) {
      if (action.kind === kind && (bucket === undefined || action.params?.bucket === bucket) && (refused || mayRun({ facts, action }, by).ok)) out.push({ facts, plan, action });
    }
  }
  return out.sort((a, b) => (b.facts.brokeByUs ? 1 : 0) - (a.facts.brokeByUs ? 1 : 0) || (inFlightNow(b.facts, b.plan.state) ? 1 : 0) - (inFlightNow(a.facts, a.plan.state) ? 1 : 0) || byScore(a.facts.score, b.facts.score)
    || (a.facts.repo < b.facts.repo ? -1 : a.facts.repo > b.facts.repo ? 1 : 0) || a.facts.number - b.facts.number);
}
