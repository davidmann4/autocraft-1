// The related items and earlier reviews of a PR that the post-merge, review and pre-merge prompts show.
import type { PostmergeReviewRow, RelatedItem } from "./parse.ts";
import type { Db } from "../db/index.ts";
import { listMentioning } from "../data/mirror/index.ts";
import { loadReviewHistory } from "../data/review/index.ts";

/** Our earlier Opus reviews of the PR, oldest first. */
export async function reviewHistory(db: Db, repo: string, number: number): Promise<PostmergeReviewRow[]> {
  const rows = (await loadReviewHistory(db, [{ repo, number }])).get(`${repo}#${number}`) ?? [];
  return rows.map((r) => ({ head: r.head, verdict: r.verdict, sure: r.sure, reason: r.reason ?? "", risks: r.risks, fixes: r.fixes as PostmergeReviewRow["fixes"], at: r.at }));
}

const REVIEW_REASON_CHARS = 600, REVIEW_NOTE_CHARS = 300, REVIEW_NOTES = 8, REVIEW_FIXES = 10;

/**
 * The one earlier review the pre-merge review gets: the latest at `head`, else the latest of the PR, as a list of at most one row.
 * Its text is cut (reason, at most 8 risks and 10 fixes, each cut), so the prompt does not grow with the PR's review count.
 */
export async function latestReview(db: Db, repo: string, number: number, head: string): Promise<PostmergeReviewRow[]> {
  const all = await reviewHistory(db, repo, number);
  const r = [...all].reverse().find((x) => x.head === head) ?? all[all.length - 1];
  if (!r) return [];
  const cut = (s: unknown, n: number) => (typeof s === "string" ? s.slice(0, n) : "");
  return [{ ...r, reason: cut(r.reason, REVIEW_REASON_CHARS), risks: r.risks.slice(0, REVIEW_NOTES).map((x) => cut(x, REVIEW_NOTE_CHARS)),
    fixes: r.fixes.slice(0, REVIEW_FIXES).map((f) => ({ file: cut(f?.file, 200), change: cut(f?.change, REVIEW_NOTE_CHARS) })) }];
}

/** Items closed within this long still count as related: a defect reported and closed recently is not reported again. */
export const RELATED_CLOSED_DAYS = 30;

/** Items of the repo, open or closed in the last 30 days, that mention the PR by number or one of its files by path: number, kind, state and title, for deduplication. */
export async function relatedOpen(db: Db, repo: string, number: number, files: string[], at = Date.now()): Promise<RelatedItem[]> {
  const needles = [`#${number}`, ...files.slice(0, 30)];
  const since = new Date(at - RELATED_CLOSED_DAYS * 86400_000).toISOString();
  const rows = await listMentioning(db, repo, needles, { since });
  const byNumber = new RegExp(String.raw`(?<![\w/])#${number}(?!\d)`);
  return rows
    .filter((r) => { if (r.number === number) return false; const text = `${r.title ?? ""}\n${r.body ?? ""}`; return byNumber.test(text) || files.some((f) => text.includes(f)); })
    .slice(0, 40).map((r) => ({ number: r.number, kind: r.kind as RelatedItem["kind"], state: r.state === "OPEN" ? "open" as const : "closed" as const, title: (r.title ?? "").slice(0, 160) }));
}
