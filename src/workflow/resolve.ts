// What parsed text does to one item, given its workflow: a run, an ambiguity (nothing runs; AutoCraft replies with what it
// understood) or a refusal (clear, but not possible on this item). Pure: the command core carries out a run.
//
// The rules the spec fixes: a yes needs an open recommendation; `merge` puts a pull request nobody started into the merge queue
// and approves the merge of a started item; a yes to a recommendation that ends in a merge records the approval; parts named by
// words must match exactly one planned part; a weight alone needs a started item.
import { describe } from "./parse.ts";
import type { CommandPart, Entry, ItemKind, ItemWorkflow, Parsed, PlanPart, WorkflowState } from "./types.ts";

export type ItemState = { kind: ItemKind; workflow: ItemWorkflow | null };

/** How the confirmation line attributes the run: "approved by", "started by", ...; null: "by". */
export type How = "started" | "approved" | "answered" | "stopped" | "set" | null;

export type Run = {
  how: How;
  /** Unstarted: the entry the item starts at. */
  start: Entry | null;
  /** Started: the step that runs again. */
  again: "review" | "fixup" | null;
  /** Plan parts to fix and to drop. */
  fix: number[];
  drop: number[];
  /** Records merge approval now. */
  approve: boolean;
  /** The steps end in a merge (approved now or before); false: they end in a recommendation. */
  merges: boolean;
  weight: number | null;
  end: "backlog" | "close" | "stop" | null;
  /** The autorepin arguments, as written. */
  autorepin: string | null;
  /** It answers the open recommendation, which closes. */
  answers: boolean;
  /** A question of the legacy machinery the recommendation answers, as the person. */
  decision: { decision: string; option: string; label?: string } | null;
};

export type Ambiguity =
  | { why: "unreadable"; rest: string }
  | { why: "nothing-to-answer" }
  | { why: "no-plan" }
  | { why: "no-such-part"; part: number }
  | { why: "part-matches-none"; words: string }
  | { why: "part-matches-several"; words: string; parts: number[] }
  | { why: "weight-unstarted"; weight: number }
  | { why: "conflict"; words: string[] }
  /** `merge` while the open recommendation fixes parts first: merge without them, or the recommendation? */
  | { why: "merge-skips-fixes"; parts: number[] }
  /** An implement question's options: the answer leaves several to go with, or names more than one. */
  | { why: "pick-one"; parts: number[] }
  /** A yes to a recommendation that runs nothing by itself: `text` says what answers it. */
  | { why: "needs-words"; text: string };

export type Refusal =
  | { why: "implement-not-issue" }
  | { why: "not-issue-step"; word: "review" | "fix-up" }
  | { why: "issue-merge-queue" }
  | { why: "autorepin-not-pr" }
  | { why: "nothing-running" }
  | { why: "already-started"; entry: Entry; by: string; at: string }
  | { why: "already-approved"; by: string; at: string }
  /** A ready plan's part: the implementation is built from the whole plan, so a part can't be fixed or dropped on its own. */
  | { why: "implement-part"; parts: number[] };

export type Resolved =
  | { kind: "run"; run: Run }
  | { kind: "ambiguous"; understood: string; ambiguity: Ambiguity }
  | { kind: "refused"; understood: string; refusal: Refusal };

const LIVE: ReadonlySet<WorkflowState> = new Set(["running", "waiting", "blocked", "recommending"]);

/** A workflow that still runs or waits; a stopped, finished, closed or backlogged one counts as not started. */
export const isLive = (wf: ItemWorkflow | null): wf is ItemWorkflow => !!wf && LIVE.has(wf.state);

const run = (r: Partial<Run>): Resolved => ({
  kind: "run",
  run: { how: null, start: null, again: null, fix: [], drop: [], approve: false, merges: false, weight: null, end: null, autorepin: null, answers: false, decision: null, ...r },
});

const ENTRY_OF = { review: "review", "fix-up": "fixup", implement: "implement" } as const;
type EntryWord = keyof typeof ENTRY_OF;
const isEntryWord = (w: string): w is EntryWord => Object.hasOwn(ENTRY_OF, w);

/** Words that say nothing about which part is meant. */
const FILLER = new Set(["the", "a", "an", "of", "in", "on", "for", "to", "and", "part", "finding", "change", "one"]);

/** The planned parts whose title holds every word of `words` (case-insensitive; filler words ignored). */
export function partsMatching(plan: readonly PlanPart[], words: string): PlanPart[] {
  const ws = words.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !FILLER.has(w));
  if (!ws.length) return [];
  return plan.filter((p) => p.state === "planned" && ws.every((w) => p.title.toLowerCase().includes(w)));
}

export function resolve(parsed: Parsed, state: ItemState): Resolved {
  if (parsed.kind === "ambiguous") return { kind: "ambiguous", understood: parsed.understood, ambiguity: { why: "unreadable", rest: parsed.rest } };
  const wf = state.workflow;
  const live = isLive(wf);
  if (parsed.kind === "yes") {
    const understood = "yes";
    if (!live || !wf.rec) return { kind: "ambiguous", understood, ambiguity: { why: "nothing-to-answer" } };
    // A recommendation a yes cannot run (a question only an option's name or a comment answers) needs other words.
    if (runsNothing(wf.rec)) return { kind: "ambiguous", understood, ambiguity: { why: "needs-words", text: wf.rec.text } };
    return accept(wf, wf.rec.parts.fix, wf.rec.parts.drop, parsed.weight ?? null);
  }

  const parts = parsed.parts;
  const understood = describe(parts);
  const ambiguous = (ambiguity: Ambiguity): Resolved => ({ kind: "ambiguous", understood, ambiguity });
  const refused = (refusal: Refusal): Resolved => ({ kind: "refused", understood, refusal });
  const has = (w: CommandPart["word"]) => parts.some((p) => p.word === w);
  const weight = parts.find((p) => p.word === "weight")?.weight ?? null;
  const entries = [...new Set(parts.map((p) => p.word).filter(isEntryWord))];
  const merge = has("merge");
  const end = (["backlog", "close", "stop"] as const).filter((w) => has(w));
  const repin = parts.find((p): p is Extract<CommandPart, { args?: string }> => p.word === "autorepin");
  const named = parts.filter((p): p is Extract<CommandPart, { part: unknown }> => "part" in p);

  // Words that end the work or stand apart run alone; two entry points can't both start.
  if (((end.length || repin) && parts.length > 1) || entries.length > 1) return ambiguous({ why: "conflict", words: parts.map((p) => p.word) });

  if (end.length) {
    const e = end[0]!;
    if (e === "stop" && !live) return refused({ why: "nothing-running" });
    return run({ end: e, how: e === "stop" ? "stopped" : live && wf.rec ? "answered" : null, answers: live && !!wf.rec });
  }
  if (repin) {
    if (state.kind !== "pr") return refused({ why: "autorepin-not-pr" });
    return run({ autorepin: repin.args ?? "", how: "set" });
  }

  const entry = entries[0] ?? null;
  if (entry === "implement" && state.kind !== "issue") return refused({ why: "implement-not-issue" });
  if (entry && entry !== "implement" && state.kind === "issue") return refused({ why: "not-issue-step", word: entry });

  if (!live) {
    if (named.length) return ambiguous({ why: "no-plan" });
    if (entry) return run({ start: ENTRY_OF[entry], approve: merge, merges: merge, weight, how: merge ? "approved" : "started" });
    if (merge) {
      if (state.kind === "issue") return refused({ why: "issue-merge-queue" });
      return run({ start: "merge", approve: true, merges: true, weight, how: "approved" });
    }
    return ambiguous({ why: "weight-unstarted", weight: weight! });
  }

  if (entry === "implement") return refused({ why: "already-started", entry: wf.entry, by: wf.startedBy, at: wf.startedAt });

  // Parts named by number or by words, each matching exactly one part of the plan.
  const fix: number[] = [];
  const drop: number[] = [];
  for (const p of named) {
    let n: number;
    if (typeof p.part === "number") {
      if (!wf.plan.some((q) => q.n === p.part)) return ambiguous({ why: "no-such-part", part: p.part });
      n = p.part;
    } else {
      const hits = partsMatching(wf.plan, p.part);
      if (hits.length === 0) return ambiguous({ why: "part-matches-none", words: p.part });
      if (hits.length > 1) return ambiguous({ why: "part-matches-several", words: p.part, parts: hits.map((h) => h.n) });
      n = hits[0]!.n;
    }
    const into = p.word === "fix" ? fix : drop;
    if (!into.includes(n)) into.push(n);
  }
  // A ready plan's parts are what the implementation builds; after it, the review's parts can be fixed or dropped.
  // An option of a question that is no longer the open one is no part any more.
  const stale = [...fix, ...drop].find((n) => wf.plan.some((q) => q.n === n && q.option !== undefined && q.question !== wf.rec?.question));
  if (stale !== undefined) return ambiguous({ why: "no-such-part", part: stale });
  const built = [...fix, ...drop].filter((n) => wf.plan.some((q) => q.n === n && q.source === "implement" && q.option === undefined));
  if (built.length) return refused({ why: "implement-part", parts: built });
  if (fix.some((n) => drop.includes(n))) return ambiguous({ why: "conflict", words: named.map((p) => `${p.word} ${p.part}`) });

  const rec = wf.rec;
  const approved = !!wf.approvedBy;
  // An implement question: its options are the parts. Naming one picks it; dropping options picks the recommended one when it is
  // left, else the one option left.
  const options = rec?.question ? wf.plan.filter((p) => p.option !== undefined && p.question === rec.question) : [];
  if (rec?.question && options.length && (fix.length || drop.length) && !entry) {
    const left = options.filter((p) => p.state === "planned" && !drop.includes(p.n));
    if (fix.length > 1) return ambiguous({ why: "pick-one", parts: fix });
    const chosen = fix.length ? options.find((p) => p.n === fix[0]) : left.find((p) => p.option === rec.answer?.option) ?? (left.length === 1 ? left[0] : undefined);
    if (!chosen?.option) return ambiguous({ why: "pick-one", parts: left.map((p) => p.n) });
    const approve = merge && !approved;
    return run({ decision: { decision: rec.question, option: chosen.option, label: chosen.title }, drop, approve, merges: merge || approved, weight, answers: true, how: approve ? "approved" : "answered" });
  }
  // Only drops, while a recommendation is open: the recommendation without those parts, as a yes would run it.
  if (rec && drop.length && !fix.length && !entry) {
    // A close drops nothing: dropping parts of it could mean "close anyway" or "don't close".
    if (rec.close) return ambiguous({ why: "conflict", words: ["close", ...named.map((p) => `drop ${p.part}`)] });
    return accept(wf, rec.parts.fix.filter((n) => !drop.includes(n)), [...new Set([...rec.parts.drop, ...drop])], weight, merge);
  }
  if (!entry && !named.length && merge) {
    if (rec) {
      if (rec.parts.fix.length) return ambiguous({ why: "merge-skips-fixes", parts: rec.parts.fix });
      return accept(wf, [], rec.parts.drop, weight, true);
    }
    if (approved) return refused({ why: "already-approved", by: wf.approvedBy!, at: wf.approvedAt ?? "" });
    return run({ approve: true, merges: true, weight, how: "approved" });
  }
  if (!entry && !named.length) return run({ weight, how: "set" });

  const planned = wf.plan.filter((p) => p.state === "planned" && !drop.includes(p.n)).map((p) => p.n);
  const again = entry === "review" ? "review" : entry === "fix-up" || fix.length ? "fixup" : null;
  const fixes = again === "fixup" ? (fix.length ? fix : planned) : [];
  const approve = merge && !approved;
  return run({
    again, fix: fixes, drop, approve, merges: merge || approved, weight, answers: !!rec,
    how: approve ? "approved" : rec ? "answered" : null,
  });
}

/** A recommendation that fixes, runs, answers, closes and merges nothing: a yes to it would do nothing. */
const runsNothing = (r: NonNullable<ItemWorkflow["rec"]>): boolean => !r.parts.fix.length && !r.again && !r.answer && !r.close && !r.merges;

/** Runs the recommendation's plan with these parts; approves the merge when it ends in one (or `merge` was said) and nobody has. */
function accept(wf: ItemWorkflow, fix: number[], drop: number[], weight: number | null, merge = false): Resolved {
  const rec = wf.rec!;
  if (rec.close && !fix.length && !merge) return run({ end: "close", how: "answered", answers: true, weight });
  const merges = rec.merges || merge;
  const approve = merges && !wf.approvedBy;
  if (rec.answer && !fix.length) return run({ decision: rec.answer, drop, approve, merges, weight, answers: true, how: approve ? "approved" : "answered" });
  return run({
    again: fix.length ? "fixup" : rec.again ?? null, fix, drop, approve, merges, weight, answers: true,
    how: approve ? "approved" : "answered",
  });
}
