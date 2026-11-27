// What can keep a PR's review from changing: another open item the review named as the reason for its hold.
import type { Db } from "../db/index.ts";
import { loadItems } from "../data/mirror/index.ts";
import { loadLatestReviews } from "../data/review/index.ts";
import { loadWorkflowFacts } from "../data/workflow/index.ts";

const REF = /^([\w.-]+)#(\d+)$/;

/** The end of a review wait on blocking items: "<ref>, <ref>, which blocks its review". */
export const BLOCKS_REVIEW = ", which blocks its review";

/** The items a review wait names as its blockers; empty for any other wait. */
export function blockersOfWait(wait: string | null): string[] {
  if (!wait?.endsWith(BLOCKS_REVIEW)) return [];
  return wait.slice(0, -BLOCKS_REVIEW.length).split(", ").filter((r) => REF.test(r));
}

/** The stored `blocked_by` value (JSON array of refs) as a list. */
export function storedBlockedBy(s: string | null | undefined): string[] {
  try {
    const v = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

/** What the blocker rules read per named ref (keys `repo#number`): the item, whether a person is asked about it, and its latest review. */
export type BlockerReads = { item: Map<string, { kind: string; state: string }>; pending: Set<string>; latest: Map<string, { verdict: string; blocked_by: string[] }> };

const keyOf = (ref: string): string | null => { const m = REF.exec(ref); return m ? `${m[1]}#${Number(m[2])}` : null; };

/** The items, open asks and latest reviews of `refs`, in one wave. */
export async function loadBlockerReads(db: Db, refs: Iterable<string>): Promise<BlockerReads> {
  const keys = new Map<string, { repo: string; number: number }>();
  for (const ref of refs) { const m = REF.exec(ref); if (m) keys.set(`${m[1]}#${Number(m[2])}`, { repo: m[1]!, number: Number(m[2]) }); }
  const out: BlockerReads = { item: new Map(), pending: new Set(), latest: new Map() };
  if (!keys.size) return out;
  const list = [...keys.values()];
  const [items, wf, latest] = await db.together(() => Promise.all([loadItems(db, list, "ref"), loadWorkflowFacts(db, list), loadLatestReviews(db, list)]));
  for (const [k, i] of items) out.item.set(k, i);
  // A person is asked about the item's workflow.
  for (const [k, w] of wf.live) if (w.state === "recommending" || w.state === "blocked") out.pending.add(k);
  for (const [k, r] of latest) out.latest.set(k, { verdict: r.verdict, blocked_by: r.blocked_by });
  return out;
}

/** The refs that still block: a tracked item that is open and, for an issue, has a person asked about it. */
export function openFrom(reads: BlockerReads, refs: readonly string[]): string[] {
  return refs.filter((ref) => {
    const k = keyOf(ref);
    const i = k === null ? undefined : reads.item.get(k);
    return !!i && i.state === "OPEN" && (i.kind === "pr" || reads.pending.has(k!));
  });
}

/** An untracked, closed or merged item, or an issue with nothing left to decide, blocks nothing. */
export async function openBlockers(db: Db, refs: readonly string[]): Promise<string[]> {
  return openFrom(await loadBlockerReads(db, refs), refs);
}

/** A hold's blocker list is ignored after this long: the PR then gets one fresh review. */
export const BLOCKED_EXPIRES_MS = 14 * 24 * 3600_000;

/**
 * The blockers of the review of `self` made at `at` that still hold: open, not past BLOCKED_EXPIRES_MS, and not
 * themselves waiting on `self` (two PRs blocking each other would never be reviewed). `stored` is the review's `blocked_by` list.
 */
export function activeFrom(reads: BlockerReads, self: string, stored: readonly string[], at: string, nowMs: number): string[] {
  if (!stored.length || nowMs - Date.parse(at) > BLOCKED_EXPIRES_MS) return [];
  return openFrom(reads, stored).filter((ref) => {
    const l = reads.latest.get(keyOf(ref)!);
    return !(l?.verdict === "hold" && l.blocked_by.includes(self));
  });
}

/** Whether any of `refs` has a person asked about it: the wait is then on a person. */
export const hasOpenQuestion = (reads: BlockerReads, refs: readonly string[]): boolean => refs.some((r) => { const k = keyOf(r); return k !== null && reads.pending.has(k); });
