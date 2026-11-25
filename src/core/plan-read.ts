// Readers of the Plan cache (item_plans, written by the planner): what the dashboard shows of an item's state, next step, queue
// membership and place. They read the stored rows only; nothing here loads facts or decides.
import type { PlanView, QueueView } from "./plan-cache.ts";
import { QUEUE_STATES, type Action, type ActionKind, type QueueState } from "./plan.ts";
import { filtered, hiddenTestExpr, type HiddenRepos } from "../hidden-sql.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

/** A PR in a queue state, as the merge queue lists it: the Plan's state, reasons and note, and the cached queue fields. */
export type CachedEntry = QueueView & {
  repo: string; number: number; title: string; state: QueueState; outsideRule: string[]; note: string | null;
  /** GitHub state as mirrored; a PR the pipeline merged counts as merged in `state` before the mirror says so. */
  gh: "OPEN" | "MERGED" | "CLOSED";
};

export type CachedQueueOptions = {
  repo?: string;
  /** Which PRs by GitHub state: open ones only, merged ones only, or both (default). */
  merged?: "exclude" | "only" | "all";
  /** Keyset page: entries after this PR in (repo, number) order, at most `limit` of them. */
  after?: { repo: string; number: number };
  limit?: number;
  /** Repos left out: a list from the dashboard's `hiddenRepos` allows only the repos it names as visible. */
  hidden?: HiddenRepos;
  /** Only these PRs, as "repo#number". */
  refs?: Iterable<string>;
};

/** The queue entries of the cached Plans, in (repo, number) order; the same list buildQueue builds from facts. */
export async function cachedQueue(db: Db, opts: CachedQueueOptions = {}): Promise<CachedEntry[]> {
  const which = opts.merged ?? "all";
  const gh = kx.jsonText(db, "p.view", "$.gh");
  const rows = await db.all(db.k.selectFrom("main.item_plans as p").leftJoin("main.items as i", (j) => j.onRef("i.repo", "=", "p.repo").onRef("i.number", "=", "p.number"))
    .select(["p.repo", "p.number", "i.title", "p.state", "p.reasons", "p.note", "p.view"])
    .where("p.kind", "=", "pr").where("p.state", "in", [...QUEUE_STATES]).where(kx.jsonText(db, "p.view", "$.queue"), "is not", null)
    .$if(!!opts.repo, (q) => q.where("p.repo", "=", opts.repo!))
    .$if(!!(opts.hidden && filtered(opts.hidden)), (q) => q.where((eb) => eb.not(hiddenTestExpr(db, "p.repo", opts.hidden!))))
    .$if(!!opts.refs, (q) => q.where(kx.refIn(db, "p", opts.refs!)))
    .where((eb) => (which === "exclude" ? eb(gh, "=", "OPEN") : which === "only" ? eb(gh, "=", "MERGED") : eb(gh, "<>", "CLOSED")))
    .$if(!!opts.after, (q) => q.where((eb) => eb.or([eb("p.repo", ">", opts.after!.repo), eb.and([eb("p.repo", "=", opts.after!.repo), eb("p.number", ">", opts.after!.number)])])))
    .orderBy("p.repo").orderBy("p.number")
    .$if(!!opts.limit, (q) => q.limit(Math.floor(opts.limit!))));
  return rows.map((r) => {
    const v = JSON.parse(r.view) as PlanView;
    return { ...v.queue!, repo: r.repo, number: r.number, title: r.title ?? "", state: r.state as QueueState, outsideRule: JSON.parse(r.reasons) as string[], note: r.note, gh: v.gh! };
  });
}

export function countStates(entries: { state: QueueState }[]): Record<QueueState, number> {
  const c = Object.fromEntries(QUEUE_STATES.map((s) => [s, 0])) as Record<QueueState, number>;
  for (const e of entries) c[e.state]++;
  return c;
}

/** How many merged PRs (GitHub says merged) have a Plan in a queue state, in the repo or all repos, without the hidden ones. */
export async function countMergedPlans(db: Db, repo?: string, hidden: HiddenRepos = []): Promise<number> {
  return (await db.get(db.k.selectFrom("main.item_plans as p").select((eb) => eb.fn.countAll<number>().as("n"))
    .where("p.kind", "=", "pr").where("p.state", "in", [...QUEUE_STATES]).where(kx.jsonText(db, "p.view", "$.gh"), "=", "MERGED")
    .$if(!!repo, (q) => q.where("p.repo", "=", repo!))
    .where((eb) => eb.not(hiddenTestExpr(db, "p.repo", hidden)))))!.n;
}

export type DueOptions = { repo?: string; /** The action's `bucket` param, else its `source` param. */ bucket?: string };

/** The items whose cached Plan holds an action of `kind` (a PR's triage and review-to-merge actions are cached together), in (repo, number) order. */
export async function dueActions(db: Db, kind: ActionKind, opts: DueOptions = {}): Promise<{ repo: string; number: number; action: Action }[]> {
  const rows = await db.all(db.k.selectFrom(["main.item_plans as p", kx.jsonEach(db, "p.actions", "a")]).select(["p.repo", "p.number", "a.value as action"])
    .where(kx.jsonText(db, "a.value", "$.kind"), "=", kind)
    .$if(!!opts.repo, (q) => q.where("p.repo", "=", opts.repo!))
    .orderBy("p.repo").orderBy("p.number"));
  const out = rows.map((r) => ({ repo: r.repo, number: r.number, action: JSON.parse(r.action) as Action }));
  if (opts.bucket === undefined) return out;
  return out.filter(({ action: a }) => (typeof a.params?.bucket === "string" ? a.params.bucket : typeof a.params?.source === "string" ? a.params.source : null) === opts.bucket);
}

/** `repo#number` of the items whose Plan holds an action of `kind`. */
export const dueRefs = async (db: Db, kind: ActionKind, opts: DueOptions = {}): Promise<Set<string>> => new Set((await dueActions(db, kind, opts)).map((d) => `${d.repo}#${d.number}`));

/**
 * The items whose fresh Plan can hold an action of `kind`, as "repo#number", for a step that decides them again on fresh facts
 * instead of loading every item. A stored Plan stands for an item until a change to it is logged: the runner's planner deletes
 * the change-log rows a pass read once that pass's Plans are stored (src/core/plan-engine.ts), so a row left in the log is a
 * change no stored Plan covers yet. The candidates are the items whose stored Plan holds the action, the items the log names,
 * and the items without a stored Plan (`pr`: open PRs and merged ones with a take or take-fix review; `item`: open items of the
 * tracked repos). Null when no Plan is stored.
 * Missing: items that turned due since the planner's last pass for a reason the log does not name (the clock, a global input,
 * a bulk write); the next pass decides them. The planner writes the stored Plans before it queues jobs, so a job finds at least
 * what the pass that queued it saw.
 */
export async function dueCandidates(db: Db, kind: ActionKind, side: "item" | "pr", repo?: string): Promise<string[] | null> {
  if (!await db.get(db.k.selectFrom("main.item_plans").select((eb) => eb.lit(1).as("one")).limit(1))) return null;
  const ref = (eb: kx.AnyEb, t: string) => eb(eb(eb.ref(`${t}.repo`), "||", eb.val("#")), "||", kx.exprOf(eb, `${t}.number`)).as("ref");
  // The log before the Plans: a pass stores its Plans before it deletes the rows they cover, so a row read gone was covered by
  // the Plans read after it.
  const logged = await db.all(db.k.selectFrom("main.item_changes as c").select((eb) => ref(eb, "c")).distinct().$if(!!repo, (q) => q.where("c.repo", "=", repo!)));
  const out = await dueRefs(db, kind, repo ? { repo } : {});
  for (const r of logged) out.add(r.ref);
  for (const r of await db.all(db.k.selectFrom("main.items as i").innerJoin("main.tracked_repos as t", "t.name", "i.repo").select((eb) => ref(eb, "i"))
    .$if(side === "item", (q) => q.where("i.state", "=", "OPEN"))
    .$if(side === "pr", (q) => q.where("i.kind", "=", "pr").where((eb) => eb.or([eb("i.state", "=", "OPEN"), eb.and([eb("i.state", "=", "MERGED"),
      eb.exists(eb.selectFrom("main.opus_reviews as o").select(eb.lit(1).as("one")).whereRef("o.repo", "=", "i.repo").whereRef("o.number", "=", "i.number").where("o.verdict", "in", ["take", "take-fix"]))])])))
    .$if(!!repo, (q) => q.where("i.repo", "=", repo!))
    .where((eb) => eb.not(eb.exists(eb.selectFrom("main.item_plans as p").select(eb.lit(1).as("one")).whereRef("p.repo", "=", "i.repo").whereRef("p.number", "=", "i.number")))))) out.add(r.ref);
  return [...out];
}

/** The cached view of every open item with a Plan: `repo#number` to its PlanView. */
export async function openViews(db: Db): Promise<Map<string, PlanView>> {
  const rows = await db.all(db.k.selectFrom("main.item_plans as p").innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "p.repo").onRef("i.number", "=", "p.number"))
    .select(["p.repo", "p.number", "p.view"]).where("i.state", "=", "OPEN"));
  return new Map(rows.map((r) => [`${r.repo}#${r.number}`, JSON.parse(r.view) as PlanView]));
}
