// The issue reviews a maintainer asked for (issue_reviews): the request rows the command core writes, the newest row of each
// live workflow the planner and the advance pass read, and the job's writes.
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { resolveKeys, type KeySource } from "../keys.ts";

export type IssueReviewState = "queued" | "posting" | "done" | "failed" | "ask" | "reporter";

export type IssueReviewRow = {
  id: number; workflowId: number; repo: string; number: number; requestedBy: string; requestedAt: string; thenImplement: boolean;
  state: IssueReviewState; tries: number; triedAt: string | null; error: string | null; commitSha: string | null; model: string | null;
  /** The stored review (src/issuereview/prompt.ts IssueReview), as JSON. */
  review: unknown; reviewedAt: string | null; commentUrl: string | null; question: string | null; askedAt: string | null;
  /** Posts of the comment or the question that sent nothing, oldest first. */
  postTries: string[];
};

/** The newest row of an issue whose workflow is live, as the planner reads it; `reporterAnswered`: the issue's author commented after the question was posted. */
export type IssueReviewFact = { id: number; workflowId: number; state: IssueReviewState; requestedBy: string; tries: number; triedAt: string | null; postTries: string[]; reporterAnswered: boolean };

/** `review`, `model`, `commitSha`, `reviewedAt`: the review a question to the reporter comes from, kept on the row that posts it. */
export type NewIssueReview = {
  workflowId: number; repo: string; number: number; by: string; at: string; thenImplement: boolean; state?: "queued" | "ask"; question?: string | null;
  review?: unknown; model?: string | null; commitSha?: string | null; reviewedAt?: string | null;
};
export type IssueReviewPatch = Partial<Pick<IssueReviewRow, "state" | "tries" | "triedAt" | "error" | "commitSha" | "model" | "reviewedAt" | "commentUrl" | "askedAt" | "postTries">> & { review?: unknown; jobId?: number | null };

const LIVE = ["running", "waiting", "blocked", "recommending"];
const COLUMNS = ["r.id", "r.workflow_id", "r.repo", "r.number", "r.requested_by", "r.requested_at", "r.then_implement", "r.state", "r.tries", "r.tried_at", "r.error", "r.commit_sha", "r.model", "r.review", "r.reviewed_at", "r.comment_url", "r.post_tries", "r.question", "r.asked_at"] as const;

const json = (s: string | null): unknown => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const times = (s: string | null): string[] => { const v = json(s); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; };
const rowOf = (r: { id: number | string; workflow_id: number | string; repo: string; number: number | string; requested_by: string; requested_at: string; then_implement: number | string; state: string; tries: number | string; tried_at: string | null; error: string | null; commit_sha: string | null; model: string | null; review: string | null; reviewed_at: string | null; comment_url: string | null; post_tries: string | null; question: string | null; asked_at: string | null }): IssueReviewRow => ({
  id: Number(r.id), workflowId: Number(r.workflow_id), repo: r.repo, number: Number(r.number), requestedBy: r.requested_by, requestedAt: r.requested_at, thenImplement: Number(r.then_implement) === 1,
  state: r.state as IssueReviewState, tries: Number(r.tries), triedAt: r.tried_at, error: r.error, commitSha: r.commit_sha, model: r.model, review: json(r.review), reviewedAt: r.reviewed_at,
  commentUrl: r.comment_url, question: r.question, askedAt: r.asked_at, postTries: times(r.post_tries),
});

/** Adds review rows in the caller's transaction. */
export async function queueIssueReviews(db: Db, rows: readonly NewIssueReview[]): Promise<void> {
  if (!rows.length) return;
  const q = queryDb(db);
  await db.write(async () => {
    await q.run(q.k.insertInto("main.issue_reviews").values(rows.map((r) => ({
      workflow_id: r.workflowId, repo: r.repo, number: r.number, requested_by: r.by, requested_at: r.at, then_implement: r.thenImplement ? 1 : 0, state: r.state ?? "queued", tries: 0, question: r.question ?? null,
      review: r.review === undefined || r.review === null ? null : JSON.stringify(r.review), model: r.model ?? null, commit_sha: r.commitSha ?? null, reviewed_at: r.reviewedAt ?? null,
    }))));
  });
}

/** Changes one row; `expect`: only while it is in one of these states. Returns whether it changed. */
export async function saveIssueReview(db: Db, id: number, p: IssueReviewPatch, expect?: readonly IssueReviewState[]): Promise<boolean> {
  const q = queryDb(db);
  const set = {
    ...(p.state !== undefined && { state: p.state }), ...(p.tries !== undefined && { tries: p.tries }), ...(p.triedAt !== undefined && { tried_at: p.triedAt }),
    ...(p.error !== undefined && { error: p.error }), ...(p.commitSha !== undefined && { commit_sha: p.commitSha }), ...(p.model !== undefined && { model: p.model }),
    ...(p.review !== undefined && { review: p.review === null ? null : JSON.stringify(p.review) }), ...(p.reviewedAt !== undefined && { reviewed_at: p.reviewedAt }),
    ...(p.commentUrl !== undefined && { comment_url: p.commentUrl }), ...(p.askedAt !== undefined && { asked_at: p.askedAt }), ...(p.postTries !== undefined && { post_tries: JSON.stringify(p.postTries) }), ...(p.jobId !== undefined && { job_id: p.jobId }),
  };
  if (!Object.keys(set).length) return false;
  return await db.write(async () => {
    const r = await q.run(q.k.updateTable("main.issue_reviews").set(set).where("id", "=", id).$if(!!expect, (b) => b.where(kx.inList(db, "state", [...expect!]))));
    return Number(r.changes) > 0;
  });
}

/** The newest row of each workflow. */
export async function loadIssueReviews(db: Db, workflowIds: readonly number[]): Promise<Map<number, IssueReviewRow>> {
  const out = new Map<number, IssueReviewRow>();
  if (!workflowIds.length) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.issue_reviews as r").select([...COLUMNS]).where(kx.inList(db, "r.workflow_id", workflowIds.map(Number), "bigint")).orderBy("r.id"));
  for (const r of rows) out.set(Number(r.workflow_id), rowOf(r));
  return out;
}

/** The newest row of the issue, or null. */
export async function loadLatestIssueReview(db: Db, repo: string, number: number): Promise<IssueReviewRow | null> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("main.issue_reviews as r").select([...COLUMNS]).where("r.repo", "=", repo).where("r.number", "=", number).orderBy("r.id", "desc").limit(1));
  return r ? rowOf(r) : null;
}

/** The newest row of each issue of `keys` whose workflow is live. */
export async function loadIssueReviewFacts(db: Db, keys: KeySource): Promise<Map<string, IssueReviewFact>> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.issue_reviews as r")
    .innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "r.repo").onRef("kk.number", "=", "r.number"))
    .innerJoin("main.item_workflows as w", "w.id", "r.workflow_id")
    .select((eb) => ["r.id", "r.workflow_id", "r.repo", "r.number", "r.state", "r.requested_by", "r.tries", "r.tried_at", "r.post_tries",
      eb.exists(eb.selectFrom("main.comments as c").innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "c.repo").onRef("i.number", "=", "c.number"))
        .select(eb.lit(1).as("one")).whereRef("c.repo", "=", "r.repo").whereRef("c.number", "=", "r.number").whereRef("c.author", "=", "i.author").whereRef("c.created_at", ">", "r.asked_at")).as("answered")])
    .where(kx.inList(db, "w.state", LIVE)).orderBy("r.id"));
  const out = new Map<string, IssueReviewFact>();
  for (const r of rows) {
    out.set(`${r.repo}#${r.number}`, {
      id: Number(r.id), workflowId: Number(r.workflow_id), state: r.state as IssueReviewState, requestedBy: r.requested_by, tries: Number(r.tries), triedAt: r.tried_at, postTries: times(r.post_tries),
      reporterAnswered: Boolean(Number(r.answered)),
    });
  }
  return out;
}
