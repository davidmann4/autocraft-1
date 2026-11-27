// The post-merge review of a merged PR as the item page shows it.
import type { ItemPostmerge, PostmergeEarlier, PostmergeFiling, PostmergeFinding } from "../../../web/src/api/types.ts";
import { heldReason } from "../../postmerge/select.ts";
import type { Finding } from "../../postmerge/parse.ts";
import { loadReviewRecord } from "../../data/review/index.ts";
import type { Followup } from "../../data/review/types.ts";
import { loadLandedWhy } from "../../data/views/landed.ts";
import { loadShown } from "../../data/mirror/index.ts";
import type { ItemShown } from "../../../web/src/api/types.ts";
import type { Db } from "../../db/index.ts";

/** AutoCraft merged the PR as a person approved it: no post-merge review is to come. */
export const mergedAsApproved = async (db: Db, repo: string, n: number): Promise<boolean> => (await loadLandedWhy(db, [{ repo, number: n }])).get(`${repo}#${n}`) === null;

/** `staff`: operators and maintainers, who also read which stage missed a finding and why. */
export async function postmergeOf(db: Db, repo: string, n: number, staff: boolean): Promise<ItemPostmerge | null> {
  const record = (await loadReviewRecord(db, [{ repo, number: n }])).get(`${repo}#${n}`);
  const r = record?.postmerge;
  if (!r) return null;
  const all = [...record.followups].sort((a, b) => (a.review_at < b.review_at ? -1 : a.review_at > b.review_at ? 1 : a.finding - b.finding));
  const follow = all.filter((f) => f.review_at === r.at);
  const earlierRows = all.filter((f) => f.review_at !== r.at && (f.state === "filed" || f.state === "filing"));
  // The filed issues' state and title, in one read.
  const filed = new Set([...follow, ...earlierRows].flatMap((f) => (f.state === "filed" && f.issue_number !== null ? [f.issue_number] : [])));
  const shown = filed.size ? await loadShown(db, [...filed].map((number) => ({ repo, number }))) : new Map<string, ItemShown>();
  const filedIssue = (row: Followup) => {
    const it = shown.get(`${repo}#${row.issue_number}`);
    return { number: row.issue_number!, url: row.url, state: it?.state ?? null, title: it?.title ?? row.title };
  };
  const held = await heldReason(db, repo, n, r.at);
  const findings = (r.findings as unknown as Finding[]).map((f, i): PostmergeFinding => {
    const row = follow.find((x) => x.finding === i);
    let filing: PostmergeFiling;
    if (row?.state === "filed" && row.issue_number !== null) filing = { state: "filed", issue: filedIssue(row) };
    else if (row?.state === "filing") filing = { state: "unknown" };
    else if (f.severity === "minor") filing = { state: "minor" };
    else if (row?.state === "skipped-duplicate" || f.duplicate_of !== null) filing = { state: "duplicate", duplicateOf: row?.duplicate_of ?? f.duplicate_of! };
    else if (row?.state === "skipped-stale") filing = { state: "stale" };
    else if (row?.state === "skipped-text") filing = { state: "refused" };
    else if (row?.state === "failed") filing = { state: "failed", attempts: row.attempts };
    else if (held) filing = { state: "held", reason: held };
    else filing = row?.state === "skipped-limit" ? { state: "limit" } : { state: "pending" };
    return {
      severity: f.severity, title: f.title, body: f.body, file: f.file, line: f.line, filing,
      ...(staff ? { missedBy: f.missed_by || null, missedWhy: f.missed_why || null } : {}),
    };
  });
  // Follow-ups of earlier reviews of the PR (`--again` replaces the review): a filed issue never shows as not filed.
  const earlier = earlierRows.map((f): PostmergeEarlier =>
    f.state === "filed" && f.issue_number !== null ? { state: "filed", title: f.title, issue: filedIssue(f) } : { state: "unknown", title: f.title });
  return { at: r.at, model: r.model, mergeSha: r.merge_sha, error: r.error ? r.error.replace(/^(retry|held):\s*/, "") : null, findings, earlier };
}
