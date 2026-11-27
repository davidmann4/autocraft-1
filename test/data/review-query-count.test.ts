// Query-count tests: the review loaders and writers issue the same number of statements for a few PRs and for many.
import { test } from "node:test";
import {
  claimFollowups, listPostmergeReviewed, listReviewEvents, loadDiscussionEntries, loadFixesAsked, loadFollowupFixPrs, loadFollowups, loadLatestReviews, loadPendingDefects, loadPosts, loadPostmerge,
  loadPremerge, loadRecentFiled, loadReviewFacts, loadReviewHistory, loadReviewRecord, loadReviewRows, loadReviewSignature, loadReviewTexts, loadReviewsAt, loadReviewedRefs, markStale,
  recordReviewFailures, saveFollowups, savePostmerge, savePremerge, saveReviewPosts, saveReviews,
} from "../../src/data/review/index.ts";
import type { Dialect } from "../../src/db/index.ts";
import { TEST_PG_URL } from "../test-db.ts";
import { expectFlat } from "../helpers/query-count.ts";
import { openApp } from "./planner-helpers.ts";
import { reviewInput, seedComments, seedReviews, T0 } from "./review-helpers.ts";

const NOW = Date.parse(T0);
const dialects = ["sqlite", ...(TEST_PG_URL ? ["postgres"] : [])] as Dialect[];

/** `run(db, refs)` is metered at sizes `small` and `large`; `seed` prepares the PRs outside the meter. */
function flat(name: string, seed: (db: Awaited<ReturnType<typeof openApp>>["db"], refs: { repo: string; number: number }[]) => Promise<void>,
  run: (db: Awaited<ReturnType<typeof openApp>>["db"], refs: { repo: string; number: number }[]) => Promise<unknown>): void {
  for (const dialect of dialects) {
    test(`${name} (${dialect})`, async () => {
      await expectFlat(async (size) => {
        const { t, db } = await openApp(dialect);
        const refs = Array.from({ length: size }, (_, i) => ({ repo: i % 2 ? "o/b" : "o/a", number: Math.floor(i / 2) + 1 }));
        await seed(db, refs);
        return { db, run: () => run(db, refs), close: () => t.close() };
      }, 2, 12);
    });
  }
}

const seedAll = async (db: Parameters<typeof seedReviews>[0], refs: { repo: string; number: number }[]) => {
  await saveReviews(db, refs.map((r) => reviewInput(r.repo, r.number, `h${r.number}`)));
  await seedComments(db, refs.map((r) => ({ repo: r.repo, number: r.number, id: `c-${r.repo}-${r.number}`, author: "maint", at: "2026-01-02T00:00:00Z" })));
  await savePremerge(db, refs.map((r) => ({ repo: r.repo, number: r.number, head: `h${r.number}`, at: T0, findings: [] })));
  await savePostmerge(db, refs.map((r) => ({ repo: r.repo, number: r.number, merge_sha: "s", at: T0, model: "m", run_id: "r", findings: [{ title: "t", severity: "defect", duplicate_of: null }], error: null })));
  await saveReviewPosts(db, refs.map((r) => ({ kind: "posted" as const, repo: r.repo, number: r.number, review_id: `R${r.number}`, head: `h${r.number}`, posted_at: T0, edited_at: null, opus_at: T0, posted_as: null })));
};

flat("the planner's review facts are one wave whatever the PR count", seedAll, async (db, refs) => { await loadReviewFacts(db, refs, { now: NOW, own: [] }); });

flat("set loaders by refs and heads", seedAll, async (db, refs) => {
  const heads = refs.map((r) => ({ ...r, head: `h${r.number}` }));
  await loadLatestReviews(db, refs); await loadReviewRows(db, refs); await loadReviewHistory(db, refs); await loadPosts(db, refs); await loadPostmerge(db, refs); await loadFollowups(db, refs);
  await loadFollowupFixPrs(db, refs); await loadDiscussionEntries(db, refs, { own: [] });
  await loadReviewsAt(db, heads); await loadReviewTexts(db, heads); await loadFixesAsked(db, heads); await loadPremerge(db, heads);
  await loadPendingDefects(db, refs, { now: NOW });
});

flat("read models for pages and the follow-up reads", seedAll, async (db, refs) => {
  await loadReviewRecord(db, refs); await loadReviewSignature(db, refs);
  await listReviewEvents(db, { limit: 50, repos: [...new Set(refs.map((r) => r.repo))] });
  await loadRecentFiled(db, "o/a", { now: NOW }); await listPostmergeReviewed(db, { since: T0 }); await loadReviewedRefs(db, "o/a", "h1");
});

flat("saving reviews, marks, pre-merge, post-merge, follow-ups and posts is a fixed number of statements", async (db, refs) => { await saveReviews(db, refs.map((r) => reviewInput(r.repo, r.number, `h${r.number}`))); }, async (db, refs) => {
  await saveReviews(db, refs.map((r) => reviewInput(r.repo, r.number, `h${r.number}`, { at: "2026-01-01T11:00:00.000Z" })));
  await markStale(db, refs, null);
  await recordReviewFailures(db, refs.map((r) => ({ ...r, head: "x", at: T0 })));
  await savePremerge(db, refs.map((r) => ({ repo: r.repo, number: r.number, head: "h", at: T0, findings: [] })));
  await savePostmerge(db, refs.map((r) => ({ repo: r.repo, number: r.number, merge_sha: "s", at: T0, model: "m", run_id: "r", findings: [{ title: "t", severity: "minor", duplicate_of: null }], error: null })));
  const claims = refs.map((r) => ({ ...r, review_at: T0, finding: 0, title: "t", attempts: 1 }));
  await claimFollowups(db, claims, { at: T0 });
  const rows = [...(await loadFollowups(db, refs)).values()].flat();
  await saveFollowups(db, rows.map((r) => ({ ...r, state: "filed" })));
  await saveReviewPosts(db, refs.map((r) => ({ kind: "posted" as const, repo: r.repo, number: r.number, review_id: "R", head: "h", posted_at: T0, edited_at: null, opus_at: null, posted_as: null })));
  await saveReviewPosts(db, refs.map((r) => ({ kind: "edited" as const, repo: r.repo, number: r.number, head: "h2", edited_at: T0, opus_at: null, posted_as: null })));
});
