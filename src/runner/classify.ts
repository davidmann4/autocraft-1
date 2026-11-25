// The classify steps: Jev on every item that needs a verdict, then Haiku on the
// items Jev is under 90 % sure of. When Jev is unavailable (src/agents/jev.ts),
// Haiku classifies the due items itself and its verdict settles them. Uses the
// classifiers in src/classify/run.ts.
//
// "Changed" means the classifier's input changed: input_hash is a hash of the
// classification scheme (labels and rules) and the item as the classifier sees
// it (title, body, size). A new scheme or an edited title or body makes the item
// due again; a new comment or label does not. Verdicts from before input_hash
// existed count as changed when the item was updated after the verdict.
import { refOf, type Item } from "../classify/parse.ts";
import { takersFirst } from "../agents/call.ts";
import { freeSlots } from "../agents/accounts.ts";
import { jevAvailable } from "../agents/jev.ts";
import { haikuBatches, jevAgents, runHaiku, runJev, type JevExtraAnswers } from "../classify/run.ts";
import { prioritizeAnswered } from "../priority/index.ts";
import { priorityDue } from "../core/decide-item.ts";
import type { ClassifyExtras } from "../prompts/index.ts";
import { AREAS, PRIORITY } from "../agents/steps.ts";
import { fillClassHashes } from "../itemhash.ts";
import { itemPlans, itemsOf, plannedItems, type ItemPlans, type PlannedItem } from "../core/select-items.ts";
import { startedRefs } from "../pilot.ts";
import type { StepContext } from "./steps.ts";
import { latestRun } from "../classify/settled.ts";
import { areaListsDue, assignAreas, type AskedList, type AssignResult } from "../areas/assign.ts";
import type { Db } from "../db/index.ts";
import { batches, excluded } from "../db/kx.ts";

export { inputHash } from "../itemhash.ts";

// Jev's top probability from which its label stands without a second opinion.
export const SURE = 0.9;
// Area questions per classify job, not counted against its limit: bulk assignment is the areas-rescan step.
const AREAS_PER_CLASSIFY_JOB = 100;
const JEV_CHUNK = 40, HAIKU_PER_CALL = 25;


/**
 * runJev and runHaiku write one token_usage row per agent name (`jev-<ref>`, and
 * `priority-jev-<ref>` and `areas-jev-<ref>` for the questions a classify request
 * carries for those steps; `haiku-NN`) with INSERT OR REPLACE. Rows from earlier passes with those
 * names are renamed first so their cost stays on record.
 */
async function keepUsage(db: Db, run: string, agents: string[]): Promise<void> {
  for (const slice of batches(agents)) {
    await db.run(db.k.updateTable("main.token_usage")
      .set((eb) => ({ agent: eb(eb("agent", "||", eb.val("@")), "||", eb.fn.coalesce("started_at", eb.val(""))) }))
      .where("run_id", "=", run).where("agent", "in", slice));
  }
}

/**
 * The job's counts: items sent to a model, and items answered, saved as its handled count. Each pass reports its own running
 * total of answers under its name.
 */
type Tally = { sent: (n: number) => void; answered: (pass: string, total: number) => void; asked: () => number };
const tally = (ctx: StepContext): Tally => {
  let asked = 0;
  const byPass = new Map<string, number>();
  const total = () => [...byPass.values()].reduce((a, b) => a + b, 0);
  return { sent: (n) => void (asked += n), answered: (pass, n) => { byPass.set(pass, n); ctx.handled(total()); }, asked: () => asked };
};

/** True while the job may start another chunk: the first chunk of the job always runs, so every job moves the backlog; after it, until the time slice is used. */
const sliceGuard = (ctx: StepContext): (() => Promise<boolean>) => {
  let first = true;
  return async () => {
    const ok = first || !await ctx.timeUp();
    first = false;
    return ok;
  };
};

/** What the Jev pass got: the items it classified, and the valid impact and area answers their requests carried. */
export type JevPassResult = { done: Set<string> } & JevExtraAnswers;

export async function jevPass(ctx: StepContext, run: string, todo: Item[], hashes: Map<string, string>, t: Tally, more: () => Promise<boolean>, extras?: ReadonlyMap<string, ClassifyExtras>): Promise<JevPassResult> {
  const { db } = ctx;
  const out: JevPassResult = { done: new Set(), impact: new Map(), area: new Map() };
  for (let i = 0; i < todo.length && !await ctx.cancelled() && await jevAvailable(db) && await more(); i += JEV_CHUNK) {
    const chunk = todo.slice(i, i + JEV_CHUNK);
    await keepUsage(db, run, chunk.flatMap((x) => jevAgents(refOf(x), extras?.get(refOf(x)))));
    t.sent(chunk.length);
    const r = await runJev(db, run, chunk, undefined, hashes, extras);
    for (const ref of r.saved) out.done.add(ref);
    for (const [ref, a] of r.impact) out.impact.set(ref, a);
    for (const [ref, a] of r.area) out.area.set(ref, a);
    t.answered("jev", out.done.size);
    await ctx.progress(`Jev: ${Math.min(i + JEV_CHUNK, todo.length)} of ${todo.length} items`);
    if (r.statuses.size) ctx.log(`Jev responses that were not OK in this chunk: ${[...r.statuses].map(([status, n]) => `${n} with status ${status}`).join(", ")}`);
  }
  return out;
}

/**
 * The questions of priority.jev and areas.jev that are due for the items of `todo`, to ask in their classify requests (one Jev
 * request per item), with the priority text hash of each item asked for its impact. Priority is due from the item's Plan facts
 * (the Plan holds back the prioritize step while this request is due); an area question rides along on an issue only.
 */
async function classifyExtras(db: Db, plans: ClassifyPlans, todo: readonly Item[]): Promise<{ extras: Map<string, ClassifyExtras>; priority: Map<string, string>; lists: Map<string, AskedList> }> {
  const facts = new Map(plans.items.map((p) => [`${p.facts.repo}#${p.facts.number}`, p.facts]));
  const lists = await areaListsDue(db, todo);
  const extras = new Map<string, ClassifyExtras>(), priority = new Map<string, string>();
  for (const x of todo) {
    const ref = refOf(x), f = facts.get(ref), list = lists.get(ref);
    const impact = !!f && priorityDue(f);
    if (impact) priority.set(ref, f.embedHash);
    if (impact || list) extras.set(ref, { ...(impact && { impact }), ...(list && { areas: list.areas }) });
  }
  return { extras, priority, lists };
}

/**
 * The classify Plans of one job: loaded once, at its start, with the items a maintainer started work on (src/pilot.ts startedExprFor),
 * which go first in both passes.
 */
export type ClassifyPlans = ItemPlans & { started: Set<string> };

export async function classifyPlans(db: Db, run: string): Promise<ClassifyPlans> {
  const plans = await itemPlans(db, "classify", { run });
  return { ...plans, started: await startedRefs(db, plans.items.filter((p) => p.plan.actions.some((a) => a.kind === "classify")).map((p) => p.facts)) };
}

/** The classify actions of `bucket` in the step's order, with started items first (stable). */
async function bucketItems(db: Db, plans: ClassifyPlans, bucket: "jev" | "haiku"): Promise<PlannedItem[]> {
  const started = (p: PlannedItem) => (plans.started.has(`${p.facts.repo}#${p.facts.number}`) ? 0 : 1);
  return (await plannedItems(db, "classify", { plans, bucket })).map((p, i) => ({ p, i })).sort((a, b) => started(a.p) - started(b.p) || a.i - b.i).map((x) => x.p);
}

/**
 * The items the Plans send to Haiku for a second opinion in `run`: Jev is unsure of the type or of a flag and Haiku has no verdict as new as Jev's.
 * `jevDone`: the items Jev classified in this job since `plans` were loaded; they are decided again on their new verdicts.
 */
async function haikuItems(db: Db, run: string, limit: number, plans: ClassifyPlans, jevDone: ReadonlySet<string>): Promise<Item[]> {
  const fresh = jevDone.size ? (await itemPlans(db, "classify", { run, refs: jevDone })).items : [];
  const now: ClassifyPlans = { started: plans.started, items: [...plans.items.filter((p) => !jevDone.has(`${p.facts.repo}#${p.facts.number}`)), ...fresh] };
  const todo = (await takersFirst(db, await bucketItems(db, now, "haiku"), (p) => [p.facts.repo], (p) => [p.facts])).slice(0, limit);
  return await itemsOf(db, todo.map((p) => p.facts));
}

async function haikuPass(ctx: StepContext, run: string, todo: Item[], t: Tally, name: string, more: () => Promise<boolean>): Promise<number> {
  const { db } = ctx;
  const t0 = new Date().toISOString();
  const answered = async () => (await db.get(db.k.selectFrom("classifications").select((eb) => eb.fn.countAll<number>().as("n"))
    .where("classifier", "=", "haiku").where("run_id", "=", run).where("at", ">=", t0)))!.n;
  // A chunk holds one batch for every call the accounts can take at once (at least 4), so the calls fill the free slots.
  for (let i = 0, size = 0; i < todo.length && !await ctx.cancelled() && await more(); i += size) {
    size = HAIKU_PER_CALL * Math.max(4, await freeSlots(db));
    const chunk = todo.slice(i, i + size);
    await keepUsage(db, run, Array.from({ length: (await haikuBatches(db, chunk, HAIKU_PER_CALL)).length }, (_, n) => `haiku-${String(n).padStart(2, "0")}`));
    // The first call of the pass runs alone and writes the prompt cache; the rest read it. Items no Task Runner may take are not sent.
    t.sent(await runHaiku(db, run, chunk, HAIKU_PER_CALL, undefined, { cold: i === 0 }));
    t.answered(name, await answered());
    await ctx.progress(`Haiku: ${Math.min(i + size, todo.length)} of ${todo.length} items`);
  }
  return await answered();
}

/**
 * Haiku classifies the items alone. Its verdict carries the item's input hash, which keeps the item from being due for Jev
 * until it changes, and replaces a Jev verdict of the item's earlier text. Returns the number of items Haiku answered.
 */
async function haikuOnlyPass(ctx: StepContext, run: string, items: Item[], hashes: Map<string, string>, t: Tally, more: () => Promise<boolean>): Promise<number> {
  const { db } = ctx;
  const t0 = new Date().toISOString();
  await haikuPass(ctx, run, items, t, "haiku-alone", more);
  const setHash = (hash: string, repo: string, number: number) => db.run(db.k.updateTable("main.classifications").set({ input_hash: hash })
    .where("repo", "=", repo).where("number", "=", number).where("classifier", "=", "haiku").where("run_id", "=", run).where("at", ">=", t0));
  // A Jev row of the item's earlier text goes; one without a hash (older rows) is kept, it is current until the item changes.
  const dropStale = (repo: string, number: number, hash: string) => db.run(db.k.deleteFrom("main.classifications")
    .where("repo", "=", repo).where("number", "=", number).where("classifier", "=", "jev").where("run_id", "=", run)
    .where("input_hash", "is not", null).where("input_hash", "<>", hash));
  let n = 0;
  for (const x of items) {
    if (!(await setHash(hashes.get(refOf(x))!, x.repo, x.number)).changes) continue;
    await dropStale(x.repo, x.number, hashes.get(refOf(x))!);
    n++;
  }
  return n;
}

/**
 * Open items the Plans send to Jev in `run`, with each due item's input hash. "all" takes only items without a verdict.
 * The hashes are stored on the item row (src/itemhash.ts), so no body is read for items that are up to date.
 */
export async function jevItems(db: Db, run: string, mode: "new" | "all", plans: ClassifyPlans): Promise<{ open: number; due: Item[]; hashes: Map<string, string> }> {
  const open = (await db.get(db.k.selectFrom("items as i").innerJoin("tracked_repos as t", "t.name", "i.repo")
    .select((eb) => eb.fn.countAll<number>().as("n")).where("i.state", "=", "OPEN")))!.n;
  const due: Item[] = [], hashes = new Map<string, string>();
  for (const { classHash, ...x } of await itemsOf(db, (await bucketItems(db, plans, "jev")).filter((p) => mode === "new" || !p.facts.classification.jev).map((p) => p.facts))) {
    due.push(x);
    hashes.set(refOf(x), classHash!);
  }
  return { open, due, hashes };
}

async function pass(ctx: StepContext, run: string, mode: "new" | "all"): Promise<{ areas: AssignResult; jev: number; due: number; haiku: number; haikuDue: number; haikuAlone: number; aloneDue: number; left: number; asked: number }> {
  const limit = Number(ctx.params.limit);
  ctx.usageRun(run);
  await ctx.progress("Finding items to classify");
  await fillClassHashes(ctx.db);
  const plans = await classifyPlans(ctx.db, run);
  const { open, due, hashes } = await jevItems(ctx.db, run, mode, plans);
  const todo = (await takersFirst(ctx.db, due, (x) => [x.repo], (x) => [x])).slice(0, limit);
  ctx.log(`run ${run}: ${open} open items, ${due.length} due for Jev, taking ${todo.length}`);
  const t = tally(ctx), more = sliceGuard(ctx);
  const ask = await classifyExtras(ctx.db, plans, todo);
  const jevRes = await jevPass(ctx, run, todo, hashes, t, more, ask.extras), jevDone = jevRes.done;
  // Items Jev did not answer because it is unavailable go to Haiku, which settles them.
  const alone = await ctx.cancelled() || await jevAvailable(ctx.db) ? [] : todo.filter((x) => !jevDone.has(refOf(x)));
  const haikuAlone = alone.length ? await haikuOnlyPass(ctx, run, alone, hashes, t, more) : 0;
  if (alone.length) ctx.log(`Jev unavailable: Haiku classified ${haikuAlone} of ${alone.length} items`);
  const aloneRefs = new Set(alone.map(refOf));
  const unsure = await ctx.cancelled() ? [] : (await haikuItems(ctx.db, run, limit, plans, jevDone)).filter((x) => !aloneRefs.has(refOf(x)));
  ctx.log(`Haiku: ${unsure.length} items where Jev is unsure of the type (under ${SURE * 100} %) or of a flag`);
  const haiku = await haikuPass(ctx, run, unsure, t, "haiku", more);
  const jev = jevDone.size, left = due.length - jev - haikuAlone;
  // Past the slice (with items left) only the answers Jev is sure of are stored from the classify requests: an unsure one would
  // need Haiku, so it is left to the prioritize step or the area pass.
  const late = left > 0 && await ctx.timeUp();
  const impact = late ? new Map([...jevRes.impact].filter(([, v]) => PRIORITY.sure(v))) : jevRes.impact;
  const prio = await ctx.cancelled() || !impact.size ? null : await prioritizeAnswered(ctx.db, todo.filter((x) => impact.has(refOf(x))).map((x) => ({ ...x, hash: ask.priority.get(refOf(x))! })), impact, { cancelled: ctx.cancelled, log: ctx.log });
  if (prio) ctx.log(`Priority from the classify requests: ${prio.saved} of ${prio.due} items saved (${prio.haiku} by Haiku where Jev was unsure)`);
  // Items of repos with an area list that were not asked against its current version; Jev's answers share the job's limit with the type pass.
  // Past the slice the areas wait for a job with time left, since the planner queues classify-new only while Jev has items due;
  // the job that clears the last of them asks them whatever its time.
  const given = new Map([...jevRes.area].filter(([, a]) => !late || AREAS.sure(a)).map(([ref, answer]) => [ref, { answer, version: ask.lists.get(ref)!.version }]));
  const areaLimit = late ? 0 : Math.min(limit, AREAS_PER_CLASSIFY_JOB);
  const areas = await ctx.cancelled() || (!areaLimit && !given.size) ? { due: 0, jev: 0, haiku: 0, none: 0, left: 0 } : await assignAreas(ctx.db, { limit: areaLimit, given, usageRun: run, cancelled: ctx.cancelled, progress: ctx.progress, log: ctx.log });
  return { areas, jev, due: due.length, haiku, haikuDue: unsure.length, haikuAlone, aloneDue: alone.length, left, asked: t.asked() };
}

/**
 * A job that sent items and got no answer at all (calls timing out, failing or answering badly) fails, so the failure backoff
 * spaces the retries and the health checks show it; with items left, a done job would be queued again at once.
 */
function failIfUnanswered(r: { jev: number; haiku: number; haikuAlone: number; aloneDue: number; left: number; asked: number }): void {
  if (!r.asked || r.left <= 0 || r.jev + r.haiku + r.haikuAlone > 0) return;
  throw new Error(r.aloneDue ? `Haiku answered none of ${r.asked} items while Jev was unavailable (${r.left} left)` : `Jev answered none of ${r.asked} items (${r.left} left)`);
}

const areaNote = (r: { areas: AssignResult }): string => (r.areas.due ? ` Areas: ${r.areas.jev} by Jev, ${r.areas.haiku} by Haiku of ${r.areas.due} items asked.` : "");

const aloneNote = (r: { haikuAlone: number; aloneDue: number }): string => (r.aloneDue ? `Jev unavailable: Haiku classified ${r.haikuAlone} items. ` : "");

export async function classifyNew(ctx: StepContext): Promise<string> {
  const run = await latestRun(ctx.db);
  if (!run) throw new Error("There is no classification run yet; start a classification pass first.");
  const r = await pass(ctx, run, "new");
  failIfUnanswered(r);
  if (!r.due && !r.haikuDue && !r.areas.due) return `Nothing to classify in run ${run}.`;
  return `Run ${run}: ${aloneNote(r)}Jev classified ${r.jev} of ${r.due} new or changed items${r.left ? ` (${r.left} left for the next job)` : ""}; Haiku gave a second opinion on ${r.haiku} of ${r.haikuDue}.${areaNote(r)}`;
}

export async function classifyAll(ctx: StepContext): Promise<string> {
  const run = String(ctx.params.run);
  const r = await pass(ctx, run, "all");
  failIfUnanswered(r);
  const complete = r.left === 0 && !await ctx.cancelled();
  if (complete) await ctx.db.run(ctx.db.k.insertInto("settings").values({ key: "classify_run", value: run })
    .onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
  return `Run ${run}: ${aloneNote(r)}Jev classified ${r.jev} of ${r.due} items without a verdict${r.left ? ` (${r.left} left; start it again to continue)` : ""}; Haiku gave a second opinion on ${r.haiku} of ${r.haikuDue}.${areaNote(r)}${complete ? " The run is now the current one." : ""}`;
}
