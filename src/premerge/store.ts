// Pre-merge review results (table premerge_reviews): one row per PR head, read by the merge queue.
import { PREMERGE_MAX_TRIES } from "../core/rules.ts";

/** A failed head counts as failed after this many tries. */
export { PREMERGE_MAX_TRIES };

export type { PremergeFinding } from "./types.ts";
import type { PremergeFinding } from "./types.ts";
import type { Claim } from "../review/opus-parse.ts";
import { loadPremerge, savePremerge as saveRows, type PremergeRow, type PremergeSave } from "../data/review/index.ts";
import type { Db } from "../db/index.ts";

export type { PremergeRow, PremergeSave };

/** `savePremerge` of the review module for one row. */
export async function savePremerge(db: Db, s: PremergeSave): Promise<void> {
  await saveRows(db, [s]);
}

/** The pre-merge review of a head, when it read the diff against the base branch the head's Opus review read (a row or review that recorded none counts as matching). */
export async function premergeAt(db: Db, repo: string, number: number, head: string): Promise<PremergeRow | null> {
  return (await loadPremerge(db, [{ repo, number, head }])).get(`${repo}#${number}@${head}`) ?? null;
}

/** Claims of a stored row; empty when none or unreadable. */
export function claimsOf(row: PremergeRow | null): Claim[] {
  try { const v = row?.claims ? (JSON.parse(row.claims) as unknown) : []; return Array.isArray(v) ? (v as Claim[]) : []; } catch { return []; }
}

/** Findings of a stored row; empty when none or unreadable. */
export function findingsOf(row: PremergeRow | null): PremergeFinding[] {
  try { return row?.findings ? (JSON.parse(row.findings) as PremergeFinding[]) : []; } catch { return []; }
}
