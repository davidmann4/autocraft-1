// The Carry step: stores the carried review (carry.ts) for each PR whose Plan holds a `carry` action. Calls no model.
import { CLI_BY, type By } from "../core/gates.ts";
import { planned } from "../core/select.ts";
import { staleReviews } from "./discussion.ts";
import { carriedReviews, CARRIED } from "./carry.ts";
import { currentJobId } from "../agents/call.ts";
import { loadRepos } from "../data/mirror/index.ts";
import { saveReviews, type SaveReviewInput } from "../data/review/index.ts";
import { jobItem } from "../runner/job-items.ts";
import type { Db } from "../db/index.ts";

export async function runCarry(db: Db, repo: string, log: (line: string) => void = console.log, by: By = CLI_BY): Promise<number> {
  const stale = await staleReviews(db, repo);
  const runId = `carry-${repo}-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
  const rows = await planned(db, "carry", { repo, by });
  const carried = await carriedReviews(db, rows.map(({ facts: f, action }) => ({ repo, number: f.number, head_oid: action.head! })), stale);
  const [repos] = await Promise.all([loadRepos(db, { names: [repo] })]);
  const saves: SaveReviewInput[] = [];
  for (const { facts: f, action } of rows) {
    const k = carried.get(`${repo}#${f.number}`);
    if (!k) continue;
    saves.push({ runId, repo, number: f.number, head: action.head!, mode: CARRIED, base: k.from, baseRef: k.baseRef, defaultBranch: repos.get(repo)?.default_branch ?? null, model: CARRIED,
      review: { verdict: k.review.verdict, sure: k.review.sure, reason: k.review.reason, fixes: k.review.fixes as never, risks: k.review.risks, workflow: (k.review.workflow ?? null) as never, summary: k.review.summary, why: k.review.why, public: k.review.public, conflicts: k.review.conflicts, claims: k.review.claims },
      snap: { seen: k.seen, hash: k.hash }, blockedBy: [], jobId: currentJobId() });
  }
  await saveReviews(db, saves);
  for (const sv of saves) await jobItem(db, repo, sv.number, `carried review: ${sv.review.reason}`, log);
  return saves.length;
}
