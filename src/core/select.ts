// Executors take their work from Plans: the PRs whose Plan holds an action of their kind.
import { decidePr } from "./decide.ts";
import { loadPass, loadPrFacts } from "./facts.ts";
import { latestRun } from "../classify/settled.ts";
import { dueCandidates } from "./plan-read.ts";
import type { PlanSet } from "./plan-set.ts";
import { WAITS_ON_PERSON, inFlightNow } from "./assignment.ts";
import type { Action, ActionKind, Plan, PrFacts } from "./plan.ts";
import type { Db } from "../db/index.ts";

export type Planned = { facts: PrFacts; plan: Plan; action: Action };

export type PlannedOptions = {
  repo?: string;
  /** Only actions with this bucket parameter (verify: plan | unavailable; fix-up: fix | ask, ...). */
  bucket?: string;
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
};

export { WAITS_ON_PERSON, inFlightNow };

/**
 * The PRs with an action of `kind` due, in selection order: fast-track or rank score descending (unranked last), then repo and number.
 * Our own broken pushes come first, then work in flight, then fast-track or rank score. Facts are loaded once for all of them.
 */
export async function planned(db: Db, kind: ActionKind, opts: PlannedOptions = {}): Promise<Planned[]> {
  const { bucket, onPlan, plans, ...load } = opts;
  const out: Planned[] = [];
  let source: Iterable<{ facts: PrFacts; plan: Plan }>;
  if (plans) {
    const refs = load.refs ? new Set(load.refs) : null;
    source = plans.prs.filter((p) => (!load.repo || p.facts.repo === load.repo) && (!refs || refs.has(`${p.facts.repo}#${p.facts.number}`)));
  } else {
    const pass = loadPass(load.now);
    // Without refs, a step decides only the PRs that can be due (plan-read.ts dueCandidates), unless it asks for another time or
    // run than the stored Plans', or for every PR's Plan (onPlan).
    const stored = load.refs || onPlan || load.now !== undefined || (typeof load.run === "string" && load.run !== await latestRun(db)) ? null : await dueCandidates(db, kind, "pr", load.repo);
    source = stored && !stored.length ? [] : (await loadPrFacts(db, stored ? { ...load, refs: stored } : load)).map((facts) => ({ facts, plan: decidePr(facts, pass) }));
  }
  for (const { facts, plan } of source) {
    onPlan?.(facts, plan);
    for (const action of plan.actions) {
      if (action.kind === kind && (bucket === undefined || action.params?.bucket === bucket)) out.push({ facts, plan, action });
    }
  }
  return out.sort((a, b) => (b.facts.brokeByUs ? 1 : 0) - (a.facts.brokeByUs ? 1 : 0) || (inFlightNow(b.facts, b.plan.state) ? 1 : 0) - (inFlightNow(a.facts, a.plan.state) ? 1 : 0) || (a.facts.score === null ? 1 : 0) - (b.facts.score === null ? 1 : 0) || (b.facts.score ?? 0) - (a.facts.score ?? 0)
    || (a.facts.repo < b.facts.repo ? -1 : a.facts.repo > b.facts.repo ? 1 : 0) || a.facts.number - b.facts.number);
}
