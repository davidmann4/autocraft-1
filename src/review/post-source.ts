// What a pull request review post says about the review at a head. A carried review has no text of its own: the post uses the
// text, claims and model of the review the carry came from.
import { CARRIED } from "./carry.ts";
import { parsePublic, storedClaims, type PublicReview } from "./opus-parse.ts";
import type { Db } from "../db/index.ts";
import type { Blocking } from "../premerge/types.ts";
import { loadReviewRows, loadReviewTexts, type ReviewRow, type ReviewTexts } from "../data/review/index.ts";

type Row = ReviewRow & Pick<ReviewTexts, "public_review" | "claims">;
const MAX_STEPS = 20;

export type PostSource = {
  /** The verdict at the head (a carried review's is take). */
  verdict: string; sure: boolean;
  /** The verdict of the review the text comes from. */
  sourceVerdict: string;
  /** The parsed public text; null when the stored text does not parse. Empty text (no summary, no points) when the row has none. */
  public: PublicReview | null;
  hasPublic: boolean;
  claims: ReturnType<typeof storedClaims>;
  model: string | null;
  /** The head the text was written at. */
  reviewedAt: string;
  /** The head a carried review sits at (the fix-up's head); null when the review is not carried. */
  fixedIn: string | null;
  /** The heads from the asked head back through the carried reviews to the one the text comes from, both included. */
  chain: string[];
  /** The `at` of the review at the head. */
  at: string;
  /** The fixes and hold class of the review the text comes from: on a PR approved for merge the post tells what blocks it from what is filed. */
  fixes: ReviewRow["fixes"];
  hold: Blocking | null;
  blockedBy: string[];
};

const isCarried = (r: Pick<Row, "model" | "mode">) => r.model === CARRIED || r.mode === CARRIED;

const safeJson = (s: string): unknown => {
  try { return JSON.parse(s); } catch { return null; }
};

/** The review to post at `head`, or null when the head has none. */
export async function postSource(db: Db, repo: string, number: number, head: string): Promise<PostSource | null> {
  return await (await postSourcesOf(db, [`${repo}#${number}`]))(repo, number, head);
}

/**
 * postSource() for the given PRs ("repo#number"), with their reviews read once. The public text and claims are read for each PR's
 * latest head and the reviews it was carried from up front, and for another head when it is asked for.
 */
export async function postSourcesOf(db: Db, refs: readonly string[]): Promise<(repo: string, number: number, head: string) => Promise<PostSource | null>> {
  const rows = new Map<string, ReviewRow>();
  const texts = new Map<string, Pick<ReviewTexts, "public_review" | "claims">>();
  if (refs.length) {
    const keys = refs.map((r) => ({ repo: r.slice(0, r.lastIndexOf("#")), number: Number(r.slice(r.lastIndexOf("#") + 1)) }));
    const all = await loadReviewRows(db, keys);
    const heads: { repo: string; number: number; head: string }[] = [];
    for (const [ref, list] of all) {
      for (const r of list) rows.set(`${ref}@${r.head}`, r);
      let r: ReviewRow | undefined = list[0];
      for (let i = 0; r && i <= MAX_STEPS; i++) {
        heads.push({ repo: r.repo, number: r.number, head: r.head });
        r = isCarried(r) && r.base_head ? rows.get(`${ref}@${r.base_head}`) : undefined;
      }
    }
    for (const [k, t] of await loadReviewTexts(db, heads)) texts.set(k, t);
  }
  const get = async (repo: string, number: number, h: string): Promise<Row | undefined> => {
    const k = `${repo}#${number}@${h}`, r = rows.get(k);
    if (!r) return undefined;
    let t = texts.get(k);
    if (!t) { t = (await loadReviewTexts(db, [{ repo, number, head: h }])).get(k) ?? { public_review: null, claims: null }; texts.set(k, t); }
    return { ...r, public_review: t.public_review, claims: t.claims };
  };
  return async (repo, number, head) => await sourceFrom((h) => get(repo, number, h), head);
}

async function sourceFrom(get: (head: string) => Promise<Row | undefined>, head: string): Promise<PostSource | null> {
  const o = await get(head);
  if (!o) return null;
  let src = o;
  const chain = [o.head];
  for (let i = 0; i < MAX_STEPS && isCarried(src) && src.base_head; i++) {
    const next = await get(src.base_head);
    if (!next) break;
    src = next;
    chain.push(src.head);
  }
  const carried = src !== o && !isCarried(src);
  // A walk that ends on a carried row (chain over the cap, or a missing base row) has no model to name.
  const hasPublic = src.public_review !== null;
  return {
    verdict: o.verdict, sure: o.sure, sourceVerdict: src.verdict,
    public: hasPublic ? parsePublic(safeJson(src.public_review!)) : { summary: "", points: [] },
    hasPublic, claims: storedClaims(safeJson(src.claims ?? "[]")),
    model: isCarried(src) ? null : src.model, reviewedAt: carried ? src.head : o.head, fixedIn: carried ? o.head : null, chain, at: o.at,
    fixes: src.verdict === "take-fix" ? src.fixes : [], hold: src.workflow?.hold ?? null, blockedBy: src.blocked_by,
  };
}
