// Candidate pairs: for each open item that is new or whose text changed (its
// stored embed_hash differs from the one at its last scan), its nearest
// neighbours in the same repo from the vector index.
import { loadItems } from "../data/mirror/index.ts";
import { loadOwnIntegration } from "../data/merge/index.ts";
import { loadQuiet } from "../data/security/index.ts";
import { loadScanContext, saveScans, type Pair } from "../data/triage/index.ts";
import type { VectorIndex } from "../embed/vectors.ts";
import type { Db } from "../db/index.ts";

/**
 * Cosine similarity of the embedding model (bge-small) from which a neighbour becomes a candidate pair. The same bug in other
 * words can score in the 0.7s, and the pair check that follows is cheap; below 0.78 the pair check finds few duplicates for its cost.
 * Changing it rescans every item once (src/db.ts).
 */
export const SIM_THRESHOLD = 0.78;
/** Most neighbours kept per scanned item. */
export const MAX_NEIGHBOURS = 3;
/** Neighbours looked up per item before the filters; the filters drop some. */
const LOOKUP = 20;
export const CLOSED_WINDOW_DAYS = 365;
const DAY = 86_400_000;

export type ScanItem = {
  repo: string; number: number; kind: string; state: string; embed_hash: string;
  closed_at: string | null; merged_at: string | null; closing_issues: string | null;
};

const issuesOf = (i: ScanItem): number[] => {
  try { const v = JSON.parse(i.closing_issues ?? "[]") as unknown; return Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : []; } catch { return []; }
};

/** One is a PR that closes the other. */
export function linked(x: ScanItem, y: ScanItem): boolean {
  return (x.kind === "pr" && issuesOf(x).includes(y.number)) || (y.kind === "pr" && issuesOf(y).includes(x.number));
}

/** Whether `other` may be compared with `item`: not itself, not linked to it, the same kind, and open or closed within the last year. */
export function comparable(item: ScanItem, other: ScanItem, nowMs: number): boolean {
  if (item.repo !== other.repo || item.number === other.number || linked(item, other) || item.kind !== other.kind) return false;
  if (other.state === "OPEN") return true;
  const at = Date.parse(other.merged_at ?? other.closed_at ?? "");
  return Number.isFinite(at) && nowMs - at <= CLOSED_WINDOW_DAYS * DAY;
}

export type { Pair };

/** Items per scan chunk: each chunk is a few waves and two writes, whatever its size. */
export const SCAN_CHUNK = 500;

const rowOf = (r: { repo: string; number: number; kind: string; state: string; embed_hash: string | null; closed_at: string | null; merged_at: string | null; closing_issues: string | null }): ScanItem | null =>
  r.embed_hash ? { repo: r.repo, number: r.number, kind: r.kind, state: r.state, embed_hash: r.embed_hash, closed_at: r.closed_at, merged_at: r.merged_at, closing_issues: r.closing_issues } : null;

/**
 * Stores the new pairs of the items and marks them scanned, for one chunk of items at once: the items, the neighbours the vector
 * index finds for each, and what is already stored come in two waves, and the pairs and scans go in one write. Pairs already checked
 * at these hashes, and pairs an operator ruled on, are not added again. A planned item whose text changed after planning has no
 * hash until it is embedded again; it is scanned then. Returns the number of pairs added.
 */
export async function scanChunk(db: Db, index: VectorIndex, refs: { repo: string; number: number }[], now: Date, threshold = SIM_THRESHOLD, cap = MAX_NEIGHBOURS): Promise<number> {
  const rows = await loadItems(db, refs, "text");
  const items = refs.flatMap((r) => { const i = rowOf(rows.get(`${r.repo}#${r.number}`) ?? { ...r, kind: "", state: "", embed_hash: null, closed_at: null, merged_at: null, closing_issues: null }); return i ? [i] : []; });
  if (!items.length) return 0;
  // The nearest items of each, from the in-memory index; a neighbour counts from the threshold on.
  const hits = new Map<ScanItem, { repo: string; number: number; score: number }[]>();
  for (const item of items) {
    const v = await index.vectorOf(db, item.repo, item.number);
    hits.set(item, v ? (await index.nearest(db, v, LOOKUP, `${item.repo}#${item.number}`, item.repo)).filter((h) => h.score >= threshold) : []);
  }
  const near = [...new Set([...hits.values()].flatMap((hs) => hs.map((h) => `${h.repo}#${h.number}`)))].map((k) => { const i = k.lastIndexOf("#"); return { repo: k.slice(0, i), number: Number(k.slice(i + 1)) }; });
  const all = [...items.map((i) => ({ repo: i.repo, number: i.number })), ...near];
  const [others, ctx, quiet, own] = await db.together(() => Promise.all([
    loadItems(db, near, "text"), loadScanContext(db, all), loadQuiet(db, all.map((r) => `${r.repo}#${r.number}`)), loadOwnIntegration(db, [...new Set(items.map((i) => i.repo))]),
  ]));
  const ruled = new Set(ctx.operatorPairs.map((p) => `${p.repo}\n${p.a}\n${p.b}`));
  const pairs: Pair[] = [];
  for (const item of items) {
    // A quiet pull request is never paired: a duplicate close or group question would name it on GitHub.
    if (quiet.has(`${item.repo}#${item.number}`)) continue;
    const found: { o: ScanItem; score: number }[] = [];
    for (const h of hits.get(item)!) {
      if (found.length >= cap) break;
      const key = `${h.repo}#${h.number}`;
      const row = others.get(key);
      const o = row && !own.has(key) && !quiet.has(key) ? rowOf(row) : null;
      if (o && comparable(item, o, now.getTime())) found.push({ o, score: h.score });
    }
    for (const { o, score } of found) {
      const [x, y] = item.number < o.number ? [item, o] : [o, item];
      if (ruled.has(`${item.repo}\n${x.number}\n${y.number}`)) continue;
      pairs.push({ repo: item.repo, a: x.number, b: y.number, a_hash: x.embed_hash, b_hash: y.embed_hash, similarity: Math.round(score * 10000) / 10000 });
    }
  }
  const at = now.toISOString();
  return await saveScans(db, pairs, items.map((i) => ({ repo: i.repo, number: i.number, hash: i.embed_hash, at })), at);
}
