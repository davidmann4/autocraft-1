// Which item of a duplicate group stays. In order:
//   1. an item that is closed or merged (the open ones duplicate something already done or decided);
//   2. an issue that a merged PR fixes;
//   3. the one with clearly more activity: ACTIVITY_MARGIN more comments;
//   4. the older one;
//   5. the lower number.
import type { Db } from "../db/index.ts";
import { loadCanonicalInfo } from "../data/triage/index.ts";

export const ACTIVITY_MARGIN = 5;

export type CanonInfo = { number: number; state: string; created_at: string | null; comments: number; fixedByMerged: boolean };

const closed = (i: CanonInfo) => i.state !== "OPEN";

/** Negative when `x` is the better one to keep. */
export function compareCanonical(x: CanonInfo, y: CanonInfo): number {
  if (closed(x) !== closed(y)) return closed(x) ? -1 : 1;
  if (x.fixedByMerged !== y.fixedByMerged) return x.fixedByMerged ? -1 : 1;
  if (Math.abs(x.comments - y.comments) >= ACTIVITY_MARGIN) return y.comments - x.comments;
  if (x.created_at !== y.created_at) return x.created_at === null ? 1 : y.created_at === null ? -1 : x.created_at < y.created_at ? -1 : 1;
  return x.number - y.number;
}

/** CanonInfo of the items, keyed by `repo#number`, in one wave; an item not in the database has no entry. */
export async function canonInfoAll(db: Db, items: { repo: string; number: number }[]): Promise<Map<string, CanonInfo>> {
  const found = await loadCanonicalInfo(db, items);
  return new Map([...found].map(([key, i]) => [key, { number: Number(key.slice(key.lastIndexOf("#") + 1)), state: i.state, created_at: i.created_at, comments: i.comments_count ?? 0, fixedByMerged: i.fixedBy !== null }]));
}

export async function canonInfo(db: Db, repo: string, numbers: number[], known?: Map<string, CanonInfo>): Promise<CanonInfo[]> {
  if (known === undefined) known = await canonInfoAll(db, numbers.map((number) => ({ repo, number })));
  return numbers.map((n) => {
    const r = known.get(`${repo}#${n}`);
    if (!r) throw new Error(`${repo}#${n} is not in the database`);
    return r;
  });
}

/** The item to keep, and a short reason. */
export async function pickCanonical(db: Db, repo: string, numbers: number[], known?: Map<string, CanonInfo>): Promise<{ number: number; why: string }> {
  const sorted = (await canonInfo(db, repo, numbers, known)).sort(compareCanonical);
  const [best, next] = sorted as [CanonInfo, CanonInfo | undefined];
  const why = !next ? "the only one"
    : closed(best) !== closed(next) ? `it is already ${best.state === "MERGED" ? "merged" : "closed"}`
    : best.fixedByMerged !== next.fixedByMerged ? "a merged PR fixes it"
    : Math.abs(best.comments - next.comments) >= ACTIVITY_MARGIN ? "it has much more discussion"
    : "it is the older one";
  return { number: best.number, why };
}
