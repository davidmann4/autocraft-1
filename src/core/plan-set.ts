// The Plans of every PR and item at one moment: facts loaded once, decided once. The planner builds one per pass; lanes and
// executors read it through planned() / plannedItems() instead of loading facts again.
import { decideItem } from "./decide-item.ts";
import { decidePr } from "./decide.ts";
import { loadPass, prFacts, type FactsOf } from "./facts.ts";
import { itemFacts } from "./issue-facts.ts";
import { inStep, loadPassBase, sharedDupes, type PassBase } from "./pass-load.ts";
import type { ItemFacts, ItemPlan, PassFacts, Plan, PrFacts } from "./plan.ts";
import type { Db } from "../db/index.ts";

export type PrPlan = { facts: PrFacts; plan: Plan };
export type ItemPlanned = { facts: ItemFacts; plan: ItemPlan };

export type PlanSet = {
  /** The classification run both loads used. */
  run: string | null;
  /** Time of the decisions, ms. */
  now: number;
  /** The instance-wide inputs every PR was decided with. */
  pass: PassFacts;
  prs: PrPlan[];
  items: ItemPlanned[];
};

export type PlanSetOptions = {
  run?: string | null; now?: number; model?: string;
  /** Only these items, as "repo#number": their facts equal their entries in a full load at the same moment. */
  refs?: Iterable<string>;
};

/** Loads PR and item facts once and decides them. */
export async function loadPlanSet(db: Db, opts: PlanSetOptions = {}): Promise<PlanSet> {
  const now = opts.now ?? Date.now();
  return decided(await (await loadFacts(db, { now, run: opts.run, ...(opts.refs ? { refs: [...opts.refs] } : {}), ...(opts.model ? { model: opts.model } : {}) }))(), now);
}

/** The Plans of loaded facts. */
export function decided({ run, prs, items }: LoadedFacts, now: number): PlanSet {
  const pass = loadPass(now);
  return { run, now, pass, prs: prs.map((facts): PrPlan => ({ facts, plan: decidePr(facts, pass) })), items: items.map((facts): ItemPlanned => ({ facts, plan: decideItem(facts) })) };
}

export type FactsLoad = { now: number; run?: string | null | undefined; model?: string; refs?: string[]; base?: PassBase };
export type LoadedFacts = { run: string | null; prs: PrFacts[]; items: ItemFacts[] };

/**
 * The rows of the PR and the item facts of a pass, read in one snapshot and shared waves. The result builds the facts from them
 * with no statement: a full pass builds about 47,000, and a transaction that sits idle meanwhile is ended by the server.
 */
export async function loadFacts(db: Db, o: FactsLoad): Promise<() => Promise<LoadedFacts>> {
  return await db.read(async () => {
    const base = o.base ?? await loadPassBase(db, o.run);
    const load = { now: o.now, base, dupes: sharedDupes(db), ...(o.refs ? { refs: o.refs } : {}) };
    const [prs, items] = await inStep<[FactsOf<PrFacts>, FactsOf<ItemFacts>]>(db, (endWave) => prFacts(db, load, endWave), (endWave) => itemFacts(db, { ...load, ...(o.model ? { model: o.model } : {}) }, endWave));
    return async () => ({ run: base.run, prs: await prs(), items: await items() });
  });
}
