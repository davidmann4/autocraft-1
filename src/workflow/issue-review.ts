// The recommendation an issue's review comes back with (src/issuereview): one plain sentence and what a yes runs on the issue.
import { t } from "../i18n/index.ts";
import { issueReviewOf } from "../issuereview/prompt.ts";
import { clipText } from "../prose.ts";
import type { Recommendation } from "./types.ts";

/** Characters of the review's reason or question the recommendation quotes. */
const QUOTED = 300;

type Row = { id: number; state: string; tries: number; review: unknown; question: string | null; askedAt: string | null; commentUrl: string | null; error: string | null };

/**
 * What of the row's posts ended without posting (src/issuereview/run.ts postOf): its question to the reporter, which the row was made
 * to post and never got to the reporter, or its review comment; null when nothing failed. `error` holds GitHub's answer then.
 */
export function unposted(row: Row): "question" | "comment" | null {
  if (row.state !== "done" || row.commentUrl !== null || row.error === null) return null;
  return row.question !== null && row.askedAt === null ? "question" : issueReviewOf(row.review) ? "comment" : null;
}

/**
 * The recommendation of a stored review row (state done or failed); `review`: the row's stored review JSON. A question to the reporter
 * that could not be posted comes back as such: a yes posts it again, without a model call. A review comment that could not be posted is
 * said before the review's own recommendation, which stands.
 */
export function issueRecommendation(row: Row): Recommendation {
  const base = { parts: { fix: [], drop: [] }, merges: false };
  const failed = unposted(row);
  const error = clipText(row.error ?? "", QUOTED);
  if (failed === "question") {
    return { ...base, text: t("The question to the reporter could not be posted: {error}", { error }), issue: { review: row.id, action: "ask", question: row.question ?? "" } };
  }
  const r = row.state === "done" ? issueReviewOf(row.review) : null;
  if (!r) return { ...base, text: t("The issue review gave no valid review after {n} tries.", { n: Math.max(row.tries, 1) }), again: "review" };
  const rec = recommendationOf(row.id, r);
  return failed === "comment" ? { ...rec, text: t("The review comment could not be posted: {error} {recommendation}", { error, recommendation: rec.text }) } : rec;
}

function recommendationOf(id: number, r: NonNullable<ReturnType<typeof issueReviewOf>>): Recommendation {
  const base = { parts: { fix: [], drop: [] }, merges: false };
  const reason = clipText(r.reason, QUOTED);
  switch (r.recommendation) {
    case "implement": return { ...base, text: t("The review recommends implementing it: {reason}", { reason }), issue: { review: id, action: "implement" } };
    case "backlog": return { ...base, text: t("The review recommends the backlog: {reason}", { reason }), issue: { review: id, action: "backlog" } };
    case "needs-info": {
      const question = r.question ?? "";
      return { ...base, text: t("The review needs an answer from the reporter: “{question}”", { question: clipText(question, QUOTED) }), issue: { review: id, action: "ask", question } };
    }
    case "close": {
      const dup = r.close_as === "duplicate" && r.duplicate_of !== undefined ? r.duplicate_of : null;
      const text = dup !== null ? t("The review recommends closing it as a duplicate of #{n}: {reason}", { n: dup, reason })
        : r.close_as === "completed" ? t("The review recommends closing it as completed: {reason}", { reason })
        : t("The review recommends closing it as not planned: {reason}", { reason });
      return { ...base, text, close: true, closeAs: dup !== null ? { as: "duplicate", of: { repo: null, number: dup } } : { as: r.close_as === "completed" ? "completed" : "not-planned" } };
    }
  }
}

/** Whether the row's review recommends implementing the issue. */
export const recommendsImplement = (row: { state: string; review: unknown }): boolean => row.state === "done" && issueReviewOf(row.review)?.recommendation === "implement";
