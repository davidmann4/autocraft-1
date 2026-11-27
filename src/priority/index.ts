// autocraft-server prioritize [--limit N]: priority level (P0-P4) of open items and their reach (src/priority/score.ts).
//
// Jev classifies the impact of each item whose text has no priority row at its
// current hash; Haiku decides where Jev is under 90 % sure, and for every item
// while Jev is unavailable (src/agents/jev.ts). The reach is
// recomputed from the mirror's reach signals on every pass, without a model.
import { takersFirst } from "../agents/call.ts";
import { keptIsCurrent, runTiered } from "../agents/step.ts";
import { PRIORITY, type JevImpact } from "../agents/steps.ts";
import { type Item, refOf } from "../classify/parse.ts";
import { fillEmbedHashes } from "../itemhash.ts";
import { savePriorities, rescoreReach, type PriorityRow } from "../data/triage/index.ts";
import { settleImpact, type Impact } from "./score.ts";
import { loadUnsure } from "../data/inference/index.ts";
import { CLI_BY, type By } from "../core/gates.ts";
import { itemsOf, plannedItems, type PlannedItem } from "../core/select-items.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";

const JEV_CHUNK = 40;
const now = () => new Date().toISOString();

export type Due = Item & { hash: string };

/** The items the Plans send to rating: no priority row, or one made at other text. */
async function dueItems(db: Db, by: By): Promise<Due[]> {
  const planned = await plannedItems(db, "prioritize", { by });
  // itemsOf also reads class_hash, which the model steps do not take.
  return (await itemsOf(db, planned.map((p) => p.facts))).map(({ classHash: _, ...item }, i) => ({ ...item, hash: planned[i]!.facts.embedHash }));
}

/** The last answer of `waitsForHaiku` per item: it holds while the item's text and the kept Jev answer stay the same. */
const waitMemo = new Map<string, { text: string; kept: string; waits: boolean }>();

/**
 * The items (refs) due for rating whose Jev answer at their current text is kept because Haiku, which decides them, had no Task Runner: a pass
 * without one rates none of them, whether Jev may be called or not.
 */
export async function waitsForHaiku(db: Db, due: readonly PlannedItem[]): Promise<Set<string>> {
  const byRef = new Map(due.map((p) => [`${p.facts.repo}#${p.facts.number}`, p.facts]));
  const kept = await loadUnsure(db, PRIORITY.jev.id, [...byRef.keys()]);
  const known = (ref: string): boolean => { const m = waitMemo.get(ref); return !!m && m.text === byRef.get(ref)!.embedHash && m.kept === kept.get(ref)!.hash; };
  const unread = [...kept.keys()].filter((ref) => !known(ref)).map((ref) => byRef.get(ref)!);
  for (const { classHash: _, ...item } of await itemsOf(db, unread)) {
    const ref = refOf(item), hash = kept.get(ref)!.hash;
    waitMemo.set(ref, { text: byRef.get(ref)!.embedHash, kept: hash, waits: await keptIsCurrent(db, PRIORITY, item, hash, undefined) });
  }
  for (const ref of waitMemo.keys()) if (!kept.has(ref)) waitMemo.delete(ref);
  return new Set([...kept.keys()].filter((ref) => waitMemo.get(ref)!.waits));
}

type Verdict = { jev: { impact: Impact; p: number } | null; haiku: { impact: Impact; reason: string } | null };

/** Stores the settled verdicts of `items` (those without a valid answer are skipped). Returns the refs saved. */
async function save(db: Db, items: readonly Due[], verdicts: ReadonlyMap<string, Verdict>): Promise<Set<string>> {
  const rows = items.flatMap((item): PriorityRow[] => {
    const v = verdicts.get(refOf(item))!;
    const s = settleImpact(v.jev, v.haiku?.impact ?? null);
    if (!s) return [];
    const reason = s.model === "haiku" ? v.haiku!.reason : v.jev ? `${v.jev.impact} ${v.jev.p.toFixed(2)}` : "";
    return [{ repo: item.repo, number: item.number, textHash: item.hash, impact: s.impact, jevImpact: v.jev?.impact ?? null, jevP: v.jev?.p ?? null,
      haikuImpact: v.haiku?.impact ?? null, score: 0, model: s.model, reason, at: now() }];
  });
  return new Set(await savePriorities(db, rows));
}

export type PrioritizeOptions = { limit: number; onSent?: (n: number) => void; cancelled?: () => Promise<boolean>; log?: (line: string) => void; /** Who asked; a command-line run is an operator's. */ by?: By };
export type PrioritizeResult = { due: number; sent: number; jev: number; haiku: number; saved: number; rescored: number; haikuAlone: number };

/** Rates one chunk: Jev (skipped for the items in `given`, answered in another request), Haiku where it is unsure, then saves. */
async function rateChunk(db: Db, all: Due[], res: PrioritizeResult, log: (line: string) => void, given?: ReadonlyMap<string, JevImpact>): Promise<void> {
  const t = await runTiered(db, PRIORITY, all, given ? { given } : {});
  // An item whose Haiku batch no Task Runner could take is left for a later pass, unsaved.
  const chunk = all.filter((x) => !t.skipped.has(refOf(x)));
  res.sent += chunk.length;
  const verdicts = new Map<string, Verdict>();
  for (const item of chunk) {
    const ref = refOf(item), v = t.jev.get(ref) ?? null;
    verdicts.set(ref, { jev: v, haiku: t.haiku.get(ref) ?? null });
    if (v && !t.kept.has(ref)) res.jev++;
    if (t.haiku.has(ref)) res.haiku++;
  }
  res.haikuAlone += t.alone.size;
  const saved = await save(db, chunk, verdicts);
  for (const item of chunk) if (saved.has(refOf(item))) res.saved++;
  else log(`prioritize: no valid answer for ${refOf(item)}`);
}

export async function runPrioritize(db: Db, opts: PrioritizeOptions): Promise<PrioritizeResult> {
  const log = opts.log ?? (() => {});
  await fillEmbedHashes(db);
  const all = await dueItems(db, opts.by ?? CLI_BY);
  const due = all.length;
  const todo = (await takersFirst(db, all, (x) => [x.repo], (x) => [x], "priority.haiku")).slice(0, opts.limit);
  log(`prioritize: ${due} items due, taking ${todo.length}`);
  const res: PrioritizeResult = { due, sent: 0, jev: 0, haiku: 0, saved: 0, rescored: 0, haikuAlone: 0 };
  for (let i = 0; i < todo.length && !await opts.cancelled?.(); i += JEV_CHUNK) {
    await rateChunk(db, todo.slice(i, i + JEV_CHUNK), res, log);
    opts.onSent?.(res.sent);
  }
  res.rescored = await rescoreReach(db);
  if (res.haikuAlone) log(`Jev unavailable: Haiku rated ${res.haikuAlone} items`);
  return res;
}

/**
 * Settles and stores the priority of items whose Jev impact answer came in another request (the classify job asks it with the
 * type, src/runner/classify.ts), as runPrioritize does: Haiku decides where Jev is unsure. `hash`: the item's text hash when the
 * question was asked. The saved rows make the items no longer due for the prioritize step.
 */
export async function prioritizeAnswered(db: Db, items: readonly Due[], given: ReadonlyMap<string, JevImpact>, opts: { cancelled?: () => Promise<boolean>; log?: (line: string) => void } = {}): Promise<PrioritizeResult> {
  const todo = items.filter((x) => given.has(refOf(x)));
  const res: PrioritizeResult = { due: todo.length, sent: 0, jev: 0, haiku: 0, saved: 0, rescored: 0, haikuAlone: 0 };
  for (let i = 0; i < todo.length && !await opts.cancelled?.(); i += JEV_CHUNK) await rateChunk(db, todo.slice(i, i + JEV_CHUNK), res, opts.log ?? (() => {}), given);
  // New rows get their reach now, as a prioritize pass gives its own.
  if (res.saved) res.rescored = await rescoreReach(db);
  return res;
}

export const commands = {
  prioritize: {
    summary: "prioritize [--limit N]: Jev (Haiku where unsure) rates the level (P0-P4) of open items without a priority, then recomputes all reach",
    async run(args: string[]): Promise<void> {
      const i = args.indexOf("--limit");
      const limit = i >= 0 ? Number(args[i + 1]) : 500;
      if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit is a whole number of at least 1");
      const r = await runPrioritize(await openDb(), { limit, log: console.log });
      console.log(`${r.saved} of ${r.sent} rated (${r.jev} by Jev, ${r.haiku} by Haiku); ${r.rescored} reach values changed${r.haikuAlone ? `; Jev unavailable: Haiku rated ${r.haikuAlone} items` : ""}`);
    },
  },
};
