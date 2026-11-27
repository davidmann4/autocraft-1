// Fixtures of the review module's tests: reviews saved the way the review step saves them.
import type { Db } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import { saveReviews, type SaveReviewInput } from "../../src/data/review/index.ts";

export const T0 = "2026-01-01T10:00:00.000Z";

/** A review input at `head`; `at` is explicit so tests control ties and order. */
export function reviewInput(repo: string, number: number, head: string, o: Partial<SaveReviewInput> & { verdict?: "take" | "take-fix" | "hold" | "close"; sure?: boolean } = {}): SaveReviewInput {
  const { verdict, sure, ...rest } = o;
  return {
    runId: "run-1", repo, number, head, mode: "full", base: null, baseRef: "main", defaultBranch: "main", model: "opus", blockedBy: [], jobId: null, at: T0,
    review: { verdict: verdict ?? "take", sure: sure ?? true, reason: "fine", fixes: [], risks: [], summary: null, why: null, public: null, conflicts: [], claims: [] },
    ...rest,
  };
}

export async function seedReviews(db: Db, repos: string[], perRepo: number): Promise<void> {
  const inputs = repos.flatMap((repo) => Array.from({ length: perRepo }, (_, i) => reviewInput(repo, i + 1, `h${i + 1}`)));
  await saveReviews(db, inputs);
}

export async function seedComments(db: Db, rows: { repo: string; number: number; id: string; author: string; at: string; body?: string; assoc?: string }[]): Promise<void> {
  const q = queryDb(db);
  const prs = [...new Set(rows.map((r) => `${r.repo}#${r.number}`))].map((k) => ({ repo: k.slice(0, k.lastIndexOf("#")), number: Number(k.slice(k.lastIndexOf("#") + 1)), kind: "pr", state: "OPEN", author: "someone" }));
  await q.run(q.k.insertInto("main.items").values(prs).onConflict((oc) => oc.doNothing()));
  await q.run(q.k.insertInto("main.comments").values(rows.map((r) => ({ repo: r.repo, number: r.number, id: r.id, kind: "comment", author: r.author, created_at: r.at, body: r.body ?? "text", counted: 1, author_association: r.assoc ?? "MEMBER" }))));
}
