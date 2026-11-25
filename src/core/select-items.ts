// The work of the item steps (classify, referee, prioritize, embed, dupes, decide, label, act, fix issue and their collect), taken from
// the item Plans: facts are loaded once, decideItem decides, and the items whose plan holds the action come back in the order the
// step works in. The steps keep their own work; none of them selects items on its own any more.
// A step outside the planner's pass loads facts only for the items that can be due (plan-read.ts dueCandidates) and decides them
// again, so an item that is no longer due drops out.
import type { Item } from "../classify/parse.ts";
import { latestRun } from "../classify/settled.ts";
import { embedderId, modelName } from "../embed/model.ts";
import { decideItem } from "./decide-item.ts";
import { inFlightNow } from "./select.ts";
import { loadItemFacts, type ItemLoadOptions } from "./issue-facts.ts";
import { dueCandidates } from "./plan-read.ts";
import type { ItemPlanned, PlanSet } from "./plan-set.ts";
import type { Action, ActionKind, ItemFacts, ItemPlan } from "./plan.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

export type PlannedItem = { facts: ItemFacts; plan: ItemPlan; action: Action };

export type PlannedOptions = ItemLoadOptions & {
  /** Only actions of this bucket (the action's `bucket` param, else its `source` param). */
  bucket?: string;
  /** Plans decided already (the planner's pass, or itemPlans): no facts are loaded. */
  plans?: ItemPlans;
};

/** Item Plans decided already: a PlanSet, or the items itemPlans loaded for one kind. */
export type ItemPlans = Pick<PlanSet, "items">;

const bucketOf = (a: Action): string | null => {
  const p = a.params ?? {};
  return typeof p.bucket === "string" ? p.bucket : typeof p.source === "string" ? p.source : null;
};

type Cmp = (a: PlannedItem, b: PlannedItem) => number;
type Keys = { created: string; updated: string };

const byRef: Cmp = (a, b) => (a.facts.repo < b.facts.repo ? -1 : a.facts.repo > b.facts.repo ? 1 : a.facts.number - b.facts.number);
const then = (...c: Cmp[]): Cmp => (a, b) => { for (const f of c) { const r = f(a, b); if (r) return r; } return 0; };
const str = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
/** Highest score first, items without one last. */
const score: Cmp = (a, b) => (a.facts.score === null ? 1 : 0) - (b.facts.score === null ? 1 : 0) || (b.facts.score ?? 0) - (a.facts.score ?? 0);
const prFirst: Cmp = (a, b) => (b.facts.kind === "pr" ? 1 : 0) - (a.facts.kind === "pr" ? 1 : 0);

/** The sort keys of the items, keyed by `repo#number`: one query. */
async function sortKeysOf(db: Db, items: { repo: string; number: number }[]): Promise<Map<string, Keys>> {
  const rows = await db.all(db.k.selectFrom("items as i")
    .innerJoin(kx.refPairs(db, items.map((x) => [x.repo, x.number] as const), "j"), (j) => j.onRef("j.repo", "=", "i.repo").onRef("j.number", "=", "i.number"))
    .select((eb) => [eb(eb("i.repo", "||", eb.val("#")), "||", kx.exprOf(eb, "i.number")).as("ref"), eb.fn.coalesce("i.created_at", eb.val("")).as("created"), eb.fn.coalesce("i.updated_at", eb.val("")).as("updated")]));
  return new Map(rows.map((r) => [r.ref, { created: r.created, updated: r.updated }]));
}

/**
 * The sort keys of a PlanSet's items, read on first use for every item with an action (one query for every kind). Kept per
 * facts object: the planner's incremental pass keeps the facts of items no logged change touched, and any write to an item's
 * row logs it (src/core/plan-inputs.ts), so a kept facts object's keys are current and only reloaded items are read again.
 */
const factKeys = new WeakMap<object, Keys>();
const planKeys = new WeakMap<ItemPlans, Map<string, Keys>>();
async function planSortKeys(db: Db, plans: ItemPlans, items: { repo: string; number: number }[]): Promise<Map<string, Keys>> {
  let m = planKeys.get(plans);
  if (!m) {
    m = new Map();
    const missing = new Map<string, ItemFacts>();
    for (const { facts: f, plan } of plans.items) {
      if (!plan.actions.length) continue;
      const k = `${f.repo}#${f.number}`, hit = factKeys.get(f);
      if (hit) m.set(k, hit);
      else missing.set(k, f);
    }
    if (missing.size) {
      const read = await sortKeysOf(db, [...missing.values()]);
      for (const [k, f] of missing) { const v = read.get(k); if (v) { factKeys.set(f, v); m.set(k, v); } }
    }
    planKeys.set(plans, m);
  }
  const extra = new Map<string, { repo: string; number: number }>();
  for (const x of items) if (!m.has(`${x.repo}#${x.number}`)) extra.set(`${x.repo}#${x.number}`, x);
  if (extra.size) for (const [k, v] of await sortKeysOf(db, [...extra.values()])) m.set(k, v);
  return m;
}

/**
 * The items that can be due for `kind` now (plan-read.ts dueCandidates), or null when the stored Plans do not stand for the facts
 * asked: none is stored yet, or the caller asks for another decision time, run or embedding model.
 */
async function candidateRefs(db: Db, kind: ActionKind, opts: ItemLoadOptions): Promise<string[] | null> {
  if (opts.now !== undefined) return null;
  // A run of null reads no verdicts, which only takes actions away; another run's verdicts change what is due.
  if (typeof opts.run === "string" && opts.run !== await latestRun(db)) return null;
  if (opts.model !== undefined && opts.model !== embedderId(modelName())) return null;
  return await dueCandidates(db, kind, "item", opts.repo);
}

/** Facts and fresh Plans of the items that can be due for `kind` (all of `opts.refs` when given), to pass as `plans` to plannedItems. */
export async function itemPlans(db: Db, kind: ActionKind, opts: ItemLoadOptions = {}): Promise<ItemPlans> {
  const refs = opts.refs ? [...opts.refs] : await candidateRefs(db, kind, opts);
  if (refs && !refs.length) return { items: [] };
  return { items: (await loadItemFacts(db, refs ? { ...opts, refs } : opts)).map((facts): ItemPlanned => ({ facts, plan: decideItem(facts) })) };
}

/** Items the Plans say are due for `kind`, one entry per due action. */
export async function plannedItems(db: Db, kind: ActionKind, opts: PlannedOptions = {}): Promise<PlannedItem[]> {
  const out: PlannedItem[] = [];
  let source: Iterable<{ facts: ItemFacts; plan: ItemPlan }>;
  if (opts.plans) {
    const refs = opts.refs ? new Set(opts.refs) : null;
    source = opts.plans.items.filter((p) => (!opts.repo || p.facts.repo === opts.repo) && (!refs || refs.has(`${p.facts.repo}#${p.facts.number}`)));
  } else source = (await itemPlans(db, kind, opts)).items;
  for (const { facts, plan } of source) {
    for (const action of plan.actions) if (action.kind === kind && (opts.bucket === undefined || bucketOf(action) === opts.bucket)) out.push({ facts, plan, action });
  }
  if (out.length < 2) return out;
  const stored = opts.plans ? await planSortKeys(db, opts.plans, out.map((p) => p.facts)) : await sortKeysOf(db, out.map((p) => p.facts));
  const keys = new Map<PlannedItem, Keys>(out.map((p) => [p, stored.get(`${p.facts.repo}#${p.facts.number}`)!]));
  const created: Cmp = (a, b) => str(keys.get(a)!.created, keys.get(b)!.created);
  const updatedDesc: Cmp = (a, b) => str(keys.get(b)!.updated, keys.get(a)!.updated);
  let cmp: Cmp;
  switch (kind) {
    // Items without a Jev verdict first, then changed ones; newest first within each. Haiku: the newest Jev verdicts first.
    case "classify":
      cmp = then((a, b) => (a.facts.classification.jev ? 1 : 0) - (b.facts.classification.jev ? 1 : 0),
        (a, b) => (a.action.params?.source === "haiku" ? str(b.facts.classification.jev?.at ?? "", a.facts.classification.jev?.at ?? "") : updatedDesc(a, b)), byRef);
      break;
    case "referee": case "decide": cmp = then(score, prFirst, created, byRef); break;
    // Items without a priority row first, then changed ones; pull requests first, newest first.
    case "prioritize": cmp = then((a, b) => (a.facts.priorityHash === null ? 0 : 1) - (b.facts.priorityHash === null ? 0 : 1), prFirst, updatedDesc, byRef); break;
    case "implement": cmp = then(score, byRef); break;
    default: cmp = byRef;
  }
  // Work of ours that is still moving goes ahead of everything else.
  const flight: Cmp = (a, b) => (inFlightNow(b.facts, b.plan.state) ? 1 : 0) - (inFlightNow(a.facts, a.plan.state) ? 1 : 0);
  return out.sort(then(flight, cmp));
}

const itemCols = (eb: kx.AnyEb) => [eb.ref("i.repo").as("repo"), eb.ref("i.number").as("number"), eb.ref("i.kind").as("kind"), eb.fn.coalesce("i.title", eb.val("")).as("title"),
  eb.fn.coalesce("i.body", eb.val("")).as("body"), eb(eb.ref("i.additions"), "+", eb.ref("i.deletions")).as("lines_changed"), eb.ref("i.changed_files").as("files_changed"),
  eb.ref("i.author_association").as("author_association")];

/** The item as the model steps read it. */
export async function itemOf(db: Db, repo: string, number: number): Promise<Item> {
  const r = await db.get(db.k.selectFrom("items as i").select((eb) => itemCols(eb)).$narrowType<Item>().where("i.repo", "=", repo).where("i.number", "=", number));
  if (!r) throw new Error(`${repo}#${number} is not in the database`);
  return r;
}

/** The items as the model steps read them, with their stored classifier input hash, in the order given: one query. */
export async function itemsOf(db: Db, refs: readonly { repo: string; number: number }[]): Promise<(Item & { classHash: string | null })[]> {
  if (!refs.length) return [];
  const rows = await db.all(db.k.selectFrom("items as i")
    .innerJoin(kx.refPairs(db, refs.map((x) => [x.repo, x.number] as const), "j"), (j) => j.onRef("j.repo", "=", "i.repo").onRef("j.number", "=", "i.number"))
    .select((eb) => [...itemCols(eb), eb.ref("i.class_hash").as("classHash")]).$narrowType<Item & { classHash: string | null }>());
  const byRef = new Map(rows.map((r) => [`${r.repo}#${r.number}`, r]));
  return refs.map((x) => {
    const r = byRef.get(`${x.repo}#${x.number}`);
    if (!r) throw new Error(`${x.repo}#${x.number} is not in the database`);
    return r;
  });
}
