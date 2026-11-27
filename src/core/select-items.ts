// The work of the item steps (classify, referee, prioritize, embed, dupes, decide, label, act, fix issue and their collect), taken from
// the item Plans: facts are loaded once, decideItem decides, and the items whose plan holds the action come back in the order the
// step works in. The steps keep their own work; none of them selects items on its own any more.
// A step outside the planner's pass loads facts only for the items that can be due (planner.loadDueRefs) and decides them
// again, so an item that is no longer due drops out.
import type { Item } from "../classify/parse.ts";
import { embedderId, modelName } from "../embed/model.ts";
import { mayRun } from "./authority.ts";
import { decideItem } from "./decide-item.ts";
import type { By } from "./gates.ts";
import { inFlightNow } from "./select.ts";
import { loadItemFacts, type ItemLoadOptions } from "./issue-facts.ts";
import { loadPassBase, type PassBase } from "./pass-load.ts";
import { loadDueRefs } from "../data/planner/index.ts";
import { loadItems } from "../data/mirror/index.ts";
import type { ItemPlanned, PlanSet } from "./plan-set.ts";
import type { Action, ActionKind, ItemFacts, ItemPlan } from "./plan.ts";
import { byScore } from "./work-score.ts";
import type { Db } from "../db/index.ts";

export type PlannedItem = { facts: ItemFacts; plan: ItemPlan; action: Action };

export type PlannedOptions = ItemLoadOptions & {
  /** Only actions of this bucket (the action's `bucket` param, else its `source` param). */
  bucket?: string;
  /** Plans decided already (the planner's pass, or itemPlans): no facts are loaded. */
  plans?: ItemPlans;
  /** Who the work is selected for (default: the pipeline, whose work also needs the global switch on). */
  by?: By;
  /** Also the actions that may not run now (mayRun): the Next lists name why. */
  refused?: boolean;
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
const score: Cmp = (a, b) => byScore(a.facts.score, b.facts.score);
const prFirst: Cmp = (a, b) => (b.facts.kind === "pr" ? 1 : 0) - (a.facts.kind === "pr" ? 1 : 0);

/** The sort keys of the items, keyed by `repo#number`: one query. */
async function sortKeysOf(db: Db, items: { repo: string; number: number }[]): Promise<Map<string, Keys>> {
  const rows = await loadItems(db, items.map((x) => ({ repo: x.repo, number: x.number })), "card");
  return new Map([...rows].map(([ref, r]) => [ref, { created: r.created_at ?? "", updated: r.updated_at ?? "" }]));
}

/**
 * The sort keys of a PlanSet's items, read on first use for every item with an action (one query for every kind). Kept per
 * facts object: the planner's incremental pass keeps the facts of items no logged change touched, and any write to an item's
 * row logs it (src/db/plan-inputs.ts), so a kept facts object's keys are current and only reloaded items are read again.
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
 * The items that can be due for `kind` now (planner.loadDueRefs), or null when the stored Plans do not stand for the facts
 * asked: none is stored yet, or the caller asks for another decision time, run or embedding model. `base`: what the facts read first.
 */
async function candidateRefs(db: Db, kind: ActionKind, opts: ItemLoadOptions): Promise<{ refs: string[] | null; base?: PassBase }> {
  if (opts.now !== undefined) return { refs: null };
  const [base, refs] = await db.together(() => Promise.all([loadPassBase(db), loadDueRefs(db, kind, "item", opts.repo)]));
  // A run of null reads no verdicts, which only takes actions away; another run's verdicts change what is due.
  const other = (typeof opts.run === "string" && opts.run !== base.run) || (opts.model !== undefined && opts.model !== embedderId(modelName()));
  return { refs: other ? null : refs, base: opts.run !== undefined ? { ...base, run: opts.run } : base };
}

/** Facts and fresh Plans of the items that can be due for `kind` (all of `opts.refs` when given), to pass as `plans` to plannedItems. */
export async function itemPlans(db: Db, kind: ActionKind, opts: ItemLoadOptions = {}): Promise<ItemPlans> {
  const { refs, base } = opts.refs ? { refs: [...opts.refs], base: undefined } : await candidateRefs(db, kind, opts);
  if (refs && !refs.length) return { items: [] };
  return { items: (await loadItemFacts(db, { ...opts, ...(refs ? { refs } : {}), ...(base ? { base } : {}) })).map((facts): ItemPlanned => ({ facts, plan: decideItem(facts) })) };
}

/** Items the Plans say are due for `kind` and may run (mayRun), one entry per due action. */
export async function plannedItems(db: Db, kind: ActionKind, opts: PlannedOptions = {}): Promise<PlannedItem[]> {
  const out: PlannedItem[] = [];
  const { by = "pipeline", refused, bucket, plans, ...load } = opts;
  let source: Iterable<{ facts: ItemFacts; plan: ItemPlan }>;
  if (plans) {
    const refs = opts.refs ? new Set(opts.refs) : null;
    source = plans.items.filter((p) => (!opts.repo || p.facts.repo === opts.repo) && (!refs || refs.has(`${p.facts.repo}#${p.facts.number}`)));
  } else source = (await itemPlans(db, kind, load)).items;
  for (const { facts, plan } of source) {
    for (const action of plan.actions) if (action.kind === kind && (bucket === undefined || bucketOf(action) === bucket) && (refused || mayRun({ facts, action }, by).ok)) out.push({ facts, plan, action });
  }
  if (out.length < 2) return out;
  const stored = plans ? await planSortKeys(db, plans, out.map((p) => p.facts)) : await sortKeysOf(db, out.map((p) => p.facts));
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
    case "referee": cmp = then(score, prFirst, created, byRef); break;
    // Items without a priority row first, then changed ones; pull requests first, newest first.
    case "prioritize": cmp = then((a, b) => (a.facts.priorityHash === null ? 0 : 1) - (b.facts.priorityHash === null ? 0 : 1), prFirst, updatedDesc, byRef); break;
    case "implement": cmp = then(score, byRef); break;
    default: cmp = byRef;
  }
  // Work of ours that is still moving goes ahead of everything else.
  const flight: Cmp = (a, b) => (inFlightNow(b.facts, b.plan.state) ? 1 : 0) - (inFlightNow(a.facts, a.plan.state) ? 1 : 0);
  return out.sort(then(flight, cmp));
}

const itemOfRow = (r: { repo: string; number: number; kind: string; title: string | null; body: string | null; additions: number | null; deletions: number | null; changed_files: number | null; author_association: string | null }): Item => ({
  repo: r.repo, number: Number(r.number), kind: r.kind === "pr" ? "pr" : "issue", title: r.title ?? "", body: r.body ?? "",
  lines_changed: r.additions === null || r.deletions === null ? null : Number(r.additions) + Number(r.deletions), files_changed: r.changed_files === null ? null : Number(r.changed_files), author_association: r.author_association,
});

/** The item as the model steps read it. */
export async function itemOf(db: Db, repo: string, number: number): Promise<Item> {
  const r = (await loadItems(db, [{ repo, number }], "text")).get(`${repo}#${number}`);
  if (!r) throw new Error(`${repo}#${number} is not in the database`);
  return itemOfRow(r);
}

/** The items as the model steps read them, with their stored classifier input hash, in the order given: one query. */
export async function itemsOf(db: Db, refs: readonly { repo: string; number: number }[]): Promise<(Item & { classHash: string | null })[]> {
  if (!refs.length) return [];
  const rows = await loadItems(db, refs.map((x) => ({ repo: x.repo, number: x.number })), "text");
  return refs.map((x) => {
    const r = rows.get(`${x.repo}#${x.number}`);
    if (!r) throw new Error(`${x.repo}#${x.number} is not in the database`);
    return { ...itemOfRow(r), classHash: r.class_hash };
  });
}
