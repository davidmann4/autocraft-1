// Duplicates stage: finds issues and PRs that describe the same bug or request,
// within one repo, among open items and items closed in the last year. Runs
// after Embed. Reads the local database and calls models; writes nothing to GitHub.
//
//   autocraft-server dupes [--limit N] [--dry-run]
import { localEmbedder, modelName } from "../embed/model.ts";
import { VectorIndex } from "../embed/vectors.ts";
import { CLI_BY, type By } from "../core/gates.ts";
import { plannedItems, type PlannedItem } from "../core/select-items.ts";
import { queueRoomPass } from "../agents/call.ts";
import { checkPairs, defaultCheckDeps, type CheckDeps, type PairKey } from "./check.ts";
import { loadUncheckedPairs, resetScansForCutoff } from "../data/triage/index.ts";
import { fillEmbedHashes } from "../itemhash.ts";
import { scanChunk, SCAN_CHUNK, SIM_THRESHOLD } from "./scan.ts";
import { filterSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";

/** Pairs checked per job unless the step's limit says otherwise. */
export const DEFAULT_LIMIT = 2000;
/** Pairs whose verdicts are stored before the next ones are asked: what a stop can lose. */
const CHECK_SLICE = 200;
/** Items whose neighbours are looked up in one run. */
const SCAN_MAX = 5000;

export type DupesParams = {
  /** Most pairs to send to a model in this run. */
  limit?: number;
  dryRun?: boolean;
  onHandled?: (n: number) => void;
  /** Who asked; a command-line run is an operator's. */
  by?: By;
  progress?: (text: string) => Promise<void>;
  /** A cancel or a passed deadline: no new unit or model call starts. */
  cancelled?: () => Promise<boolean>;
  /** The job's time slice is used: no unit after the first starts, so every job moves the backlog. */
  timeUp?: () => Promise<boolean>;
};
export type DupesDeps = { index: VectorIndex; check: CheckDeps };
export type DupesSummary = {
  scanned: number; pairsAdded: number; checked: number; jev: number; haiku: number; verdicts: Record<string, number>;
  unanswered: number; /** Pairs of this run left for a later job because it was stopped or its time was up. */ left: number; dryRun: boolean;
};

export function defaultDeps(db: Db): DupesDeps {
  return { index: new VectorIndex(localEmbedder({ name: modelName(), threads: 1 })), check: defaultCheckDeps(db) };
}

/** Items to scan, from the Plans: those with a stored vector at their current text and no scan at it. */
const scanRefs = (planned: PlannedItem[], max: number): { repo: string; number: number }[] =>
  planned.filter((p) => p.action.params?.scan).slice(0, max).map((p) => ({ repo: p.facts.repo, number: p.facts.number }));

/**
 * Unchecked pairs of the items the Plans send to the pair check, most similar first. Pairs of a repo no Task Runner takes are
 * left out: their Haiku half could not run, so Jev is not asked either and they stay for a later job.
 */
async function pairsToCheck(db: Db, planned: PlannedItem[], limit: number): Promise<PairKey[]> {
  const refs = planned.filter((p) => (p.action.params?.pairs as number) > 0).map((p) => ({ repo: p.facts.repo, number: p.facts.number }));
  if (!refs.length) return [];
  const taker = (await queueRoomPass(db)).taker;
  return (await filterSeq(await loadUncheckedPairs(db, { refs }), async (k) => await taker([k.repo], undefined, [{ repo: k.repo, number: k.a }, { repo: k.repo, number: k.b }]))).slice(0, limit);
}

export async function runDupes(db: Db, params: DupesParams = {}, log: (line: string) => void = console.log, deps?: DupesDeps): Promise<DupesSummary> {
  if (params.limit !== undefined && !(Number.isInteger(params.limit) && params.limit >= 0)) throw new Error("limit must be a whole number ≥ 0");
  const limit = params.limit ?? DEFAULT_LIMIT;
  const d = deps ?? defaultDeps(db);
  const s: DupesSummary = { scanned: 0, pairsAdded: 0, checked: 0, jev: 0, haiku: 0, verdicts: {}, unanswered: 0, left: 0, dryRun: !!params.dryRun };
  const at = () => d.check.now();
  const cancelled = async (): Promise<boolean> => await params.cancelled?.() ?? false;
  const stop = async (): Promise<boolean> => await cancelled() || (await params.timeUp?.() ?? false);
  /** The stop of the unit at `i`: the first one runs past the time slice. */
  const stopAt = (i: number) => (i ? stop : cancelled);
  const model = d.index.embedder.id;
  if (!params.dryRun) await fillEmbedHashes(db); // planning writes nothing; a row whose hash was cleared by an edit outside sync would drop out of the scan and its pairs
  if (!params.dryRun) await resetScansForCutoff(db, SIM_THRESHOLD);
  const by = params.by ?? CLI_BY;
  const planned = await plannedItems(db, "dupes", { model, by });
  const todo = scanRefs(planned, SCAN_MAX);
  if (params.dryRun) {
    s.scanned = todo.length;
    // Nothing was written, so the Plans loaded above still stand for the pair check.
    log(`dupes: ${todo.length} items to scan, ${(await pairsToCheck(db, planned, limit)).length} pairs to check; dry run, nothing written`);
    return s;
  }
  if (todo.length) {
    await d.index.ready(db);
    for (let i = 0; i < todo.length && !await stopAt(i)(); i += SCAN_CHUNK) {
      const chunk = todo.slice(i, i + SCAN_CHUNK);
      s.pairsAdded += await scanChunk(db, d.index, chunk, at());
      s.scanned += chunk.length;
    }
    log(`dupes: scanned ${s.scanned} items, ${s.pairsAdded} new pairs`);
  }
  // A scan adds pairs, which changes what the Plans send to the pair check: loaded again. Without a scan the Plans loaded above stand.
  const keys = await cancelled() ? [] : await pairsToCheck(db, todo.length ? await plannedItems(db, "dupes", { model, by }) : planned, limit);
  if (keys.length) {
    const said = (verdicts: Record<string, number>) => Object.entries(verdicts).map(([k, n]) => `${n} ${k}`).join(", ") || "no verdicts";
    let handled = 0, haikuAlone = 0, done = 0;
    for (; done < keys.length && !await stopAt(done)(); done += CHECK_SLICE) {
      const slice = keys.slice(done, done + CHECK_SLICE);
      let inSlice = 0;
      const c = await checkPairs(db, slice, d.check, { stop: stopAt(done), onHandled: (n) => params.onHandled?.(handled + (inSlice = n)) });
      handled += inSlice;
      haikuAlone += c.haikuAlone;
      s.checked += c.checked; s.jev += c.jev; s.haiku += c.haiku; s.unanswered += c.unanswered;
      for (const [k, n] of Object.entries(c.verdicts)) s.verdicts[k] = (s.verdicts[k] ?? 0) + n;
      log(`dupes: pairs ${done + 1} to ${done + slice.length} of ${keys.length}: ${c.jev} to Jev, ${c.haiku} answered by Haiku, ${said(c.verdicts)}`);
      await params.progress?.(`Duplicates: ${done + slice.length} of ${keys.length} pairs`);
    }
    if (await stop()) s.left = keys.length - s.checked;
    log(`dupes: ${s.checked} of ${keys.length} pairs checked (${s.jev} to Jev, ${s.haiku} answered by Haiku): ${said(s.verdicts)}${s.left ? `; stopped, ${s.left} left for a later job` : ""}`);
    if (haikuAlone) log(`dupes: Jev unavailable: Haiku decided ${haikuAlone} pairs`);
  }
  return s;
}

function parseArgs(args: string[]): DupesParams {
  const p: DupesParams = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--dry-run") p.dryRun = true;
    else if (a === "--limit" && args[i + 1] !== undefined) p.limit = Number(args[++i]);
    else throw new Error(`unknown or incomplete option ${a}; usage: dupes [--limit N] [--dry-run]`);
  }
  return p;
}

export const commands = {
  dupes: {
    summary: "dupes [--limit N] [--dry-run]: find duplicate issues and PRs (Jev, then Haiku); the dupe-compare step compares each group",
    async run(args: string[]): Promise<void> {
      const db = await openDb();
      const r = await runDupes(db, parseArgs(args), (l) => console.error(l));
      console.log(JSON.stringify(r));
    },
  },
};
