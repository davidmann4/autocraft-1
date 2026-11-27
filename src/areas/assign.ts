// Assigns items to the areas of their repo's list: one Jev `choice` question per item among the areas plus
// "none of these". Jev's top choice at AREA_SURE or more settles it; below that Haiku decides, and Haiku
// decides alone while Jev is unavailable. Repos without a list are skipped. An item asked against the current
// list version is not asked again unless a re-scan asks for the unassigned ones.
import { jobItem } from "../runner/job-items.ts";
import { takersFirst } from "../agents/call.ts";
import { jevAvailable } from "../agents/jev.ts";
import { parseRef, refOf } from "../classify/parse.ts";
import { pool } from "../classify/run.ts";
import { runTiered } from "../agents/step.ts";
import { AREAS } from "../agents/steps.ts";
import { loadSyncState } from "../data/mirror/index.ts";
import { loadAreaDue, loadAreaDueLists, loadAreaLists, saveItemAreas, type AreaDue, type AskedList, type ItemAreaPut } from "../data/triage/index.ts";
import { cachedDiff, ghDiff, splitDiff } from "../review/diff.ts";
import { settles, type AreaAnswer } from "./parse.ts";
import { AREA_PATHS_MAX, type AreaItem } from "./types.ts";
import type { Db } from "../db/index.ts";

const CHUNK = 40;

/** Changed file paths of a pull request, or null when unavailable. */
export type PathSource = (repo: string, number: number, head: string | null) => Promise<string[] | null>;

/** Below this many GitHub points left (the sync's last reading) no diff is fetched; cached diffs are still read. */
export const RATE_FLOOR = 500;
// Heads whose diff could not be fetched in this process: not tried again.
const failedHeads = new Set<string>();

/** From the diff cache or `gh pr diff` (a read). `db` supplies the sync's rate reading, read once per source. */
export const diffPaths = (db: Db): PathSource => {
  let rate: Promise<boolean> | undefined;
  return async (repo, number, head) => {
    if (!head) return null;
    const key = `${repo}#${number}@${head}`;
    if (failedHeads.has(key)) return null;
    const low = await (rate ??= loadSyncState(db).then((s) => (s.rate_remaining ?? Infinity) < RATE_FLOOR));
    const r = await cachedDiff(db, repo, number, head, low ? async () => ({ ok: false, tooLarge: false, error: "rate low" }) : ghDiff);
    if (!r.ok) {
      if (!low) failedHeads.add(key);
      return null;
    }
    return splitDiff(r.text).map((f) => f.path).slice(0, AREA_PATHS_MAX);
  };
};

type Due = AreaItem & Pick<AreaDue, "head" | "version">;

/**
 * Open items of repos with an area list that need an answer. Without `rescan`: never asked, or asked against an older
 * list version and unassigned. With `rescan`: also the ones answered "none of these" for the current version.
 * Operator-assigned items are never due. Items of repos no Task Runner takes come after the rest before the limit (takersFirst).
 * `refs`: only these items. `first`: these items come first and are not counted against the limit.
 */
export async function dueForArea(db: Db, opts: { repo?: string; limit: number; rescan?: boolean; refs?: readonly string[]; first?: ReadonlySet<string> }): Promise<Due[]> {
  if (opts.refs && !opts.refs.length) return [];
  const refs = opts.refs?.map((r) => parseRef(r)!);
  const due: Due[] = await loadAreaDue(db, { repo: opts.repo, refs, rescan: opts.rescan });
  const ordered = await takersFirst(db, due, (x) => [x.repo], (x) => [x], "areas.haiku");
  const first = opts.first;
  if (!first?.size) return ordered.slice(0, opts.limit);
  return [...ordered.filter((x) => first.has(refOf(x))), ...ordered.filter((x) => !first.has(refOf(x))).slice(0, opts.limit)];
}

export type { AskedList };

/**
 * The current list of each of `refs` that is due for an area answer and whose area question can ride along in its classify request
 * (an issue: its area state is the classify state, src/prompts renderClassifyJev), by ref.
 */
export async function areaListsDue(db: Db, refs: readonly { repo: string; number: number; kind: "pr" | "issue" }[]): Promise<Map<string, AskedList>> {
  return await loadAreaDueLists(db, refs.filter((x) => x.kind === "issue").map((x) => ({ repo: x.repo, number: x.number })));
}

export type AssignParams = {
  repo?: string;
  limit: number;
  rescan?: boolean;
  paths?: PathSource;
  usageRun: string;
  onSent?: (n: number) => void;
  cancelled?: () => Promise<boolean>;
  progress?: (line: string) => Promise<void>;
  log?: (line: string) => void;
  /** Jev answers already given by ref (asked in the item's classify request), with the list version they were asked against; these items go first and are not counted against `limit`. */
  given?: ReadonlyMap<string, { answer: AreaAnswer; version: number }>;
};
export type AssignResult = { due: number; jev: number; haiku: number; none: number; left: number };

async function withPaths(items: Due[], source: PathSource): Promise<AreaItem[]> {
  const prs = items.filter((x) => x.kind === "pr");
  const found = new Map<string, string[]>();
  await pool(prs.map((x) => async () => {
    const p = await source(x.repo, x.number, x.head).catch(() => null);
    if (p) found.set(refOf(x), p);
  }), 4);
  return items.map(({ head: _h, version: _v, ...x }) => ({ ...x, ...(found.has(refOf(x)) && { paths: found.get(refOf(x))! }) }));
}

/** Asks the due items of one repo and stores the answers. */
async function assignRepo(db: Db, repo: string, list: AskedList, due: Due[], p: AssignParams, paths: PathSource, r: AssignResult): Promise<void> {
  const version = list.version;
  for (let i = 0; i < due.length && !await p.cancelled?.(); i += CHUNK) {
    // With neither model available there is nothing to ask, so no diff is fetched; answers already given are still stored.
    const given = new Map<string, AreaAnswer>();
    for (const x of due.slice(i, i + CHUNK)) {
      const g = p.given?.get(refOf(x));
      if (g && g.version === version) given.set(refOf(x), g.answer);
    }
    if (!given.size && !await jevAvailable(db) && !p.paths) { p.log?.(`areas: no model available for ${repo}`); break; }
    const chunk = await withPaths(due.slice(i, i + CHUNK), paths);
    const t = await runTiered(db, AREAS, chunk, {
      ctx: { repo, areas: list.areas },
      given,
      cancelled: p.cancelled,
      jevUsage: (x) => ({ run: p.usageRun, agent: `areas-jev-${refOf(x)}`, stage: "areas", model: "jev-latest", items: () => 1, keepEarlier: true }),
      haikuUsage: (_batch, n) => ({ run: p.usageRun, agent: `areas-haiku-${repo}-${String(n).padStart(3, "0")}`, stage: "areas", keepEarlier: true }),
    });
    p.onSent?.(chunk.length - t.skipped.size);
    const answers: { x: AreaItem; area: string | null; source: "jev" | "haiku"; conf: number | null }[] = [];
    for (const x of chunk) {
      const a = t.jev.get(refOf(x));
      if (a && settles(a.top)) answers.push({ x, area: a.area, source: "jev", conf: a.top });
      else if (t.haiku.has(refOf(x))) answers.push({ x, area: t.haiku.get(refOf(x))!, source: "haiku", conf: null });
    }
    // The list was edited while this pass ran: the answers are for a list that is gone, and nothing is stored.
    const rows: ItemAreaPut[] = answers.map(({ x, area, source, conf }) => ({ repo: x.repo, number: x.number, area, source, confidence: conf }));
    if (rows.length && !(await saveItemAreas(db, repo, version, rows)).stale) {
      for (const { x, area, source } of answers) {
        if (source === "jev") r.jev++; else r.haiku++;
        if (area === null) r.none++;
        await jobItem(db, x.repo, x.number, area === null ? "fits none of the areas" : `assigned area ${area}`, p.log);
      }
    }
    await p.progress?.(`Areas ${repo}: ${Math.min(i + CHUNK, due.length)} of ${due.length} items`);
  }
}

/** Assigns areas to the due items. Returns counts; `left` is the due items that got no answer in this pass. */
export async function assignAreas(db: Db, p: AssignParams): Promise<AssignResult> {
  const due = await dueForArea(db, { repo: p.repo, limit: p.limit, rescan: p.rescan, first: p.given && new Set(p.given.keys()) });
  const r: AssignResult = { due: due.length, jev: 0, haiku: 0, none: 0, left: 0 };
  const byRepo = new Map<string, Due[]>();
  for (const x of due) byRepo.set(x.repo, [...(byRepo.get(x.repo) ?? []), x]);
  const lists = await loadAreaLists(db, [...byRepo.keys()]);
  const paths = p.paths ?? diffPaths(db);
  for (const [repo, items] of byRepo) {
    if (await p.cancelled?.()) break;
    const list = lists.get(repo);
    if (list) await assignRepo(db, repo, list, items, p, paths, r);
  }
  r.left = r.due - r.jev - r.haiku;
  p.log?.(`areas: ${r.due} items due, Jev settled ${r.jev}, Haiku ${r.haiku}, ${r.none} with none of the areas, ${r.left} unanswered`);
  return r;
}
