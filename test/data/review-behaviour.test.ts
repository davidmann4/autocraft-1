// Review writers whose logic changed shape (one upsert with a CASE, compare-and-set claim, one-statement guards) and the loaders
// whose predicates were rewritten (latest-per-PR window with tied times, pre-merge base match, discussion second cut).
import assert from "node:assert/strict";
import {
  claimFollowups, followupKey, loadFollowups, loadLatestReviews, loadReviewHistory, loadPostmerge, loadPosts, loadPremerge, loadReviewFacts, loadReviewRows, loadReviewsAt, markStale,
  recordReviewFailures, saveFollowups, savePostmerge, savePremerge, saveReviewPosts, saveReviews, type Finding,
} from "../../src/data/review/index.ts";
import { both } from "./planner-helpers.ts";
import { reviewInput, seedComments, T0 } from "./review-helpers.ts";

const ref = (repo: string, number: number) => ({ repo, number });
const marksOf = async (db: Parameters<typeof loadReviewFacts>[0], repo: string, number: number) =>
  (await loadReviewFacts(db, [ref(repo, number)], { now: Date.parse(T0), own: [] })).marks.get(`${repo}#${number}`);

both("the latest review of a PR is the later row when two share a time, and loaders follow it", async ({ db }) => {
  await saveReviews(db, [reviewInput("o/a", 1, "h1", { review: { ...reviewInput("o/a", 1, "h1").review, verdict: "hold" } })]);
  await saveReviews(db, [reviewInput("o/a", 1, "h2")]);
  assert.equal((await loadLatestReviews(db, [ref("o/a", 1)])).get("o/a#1")!.head, "h2");
  assert.deepEqual((await loadReviewRows(db, [ref("o/a", 1)])).get("o/a#1")!.map((r) => r.head), ["h2", "h1"]);
  const at = await loadReviewsAt(db, [{ repo: "o/a", number: 1, head: "h1" }, { repo: "o/a", number: 1, head: "nope" }]);
  assert.deepEqual([...at.keys()], ["o/a#1@h1"]);
  assert.equal(at.get("o/a#1@h1")!.verdict, "hold");
});

both("a second save at a head copies the replaced row to history once and counts against the daily cap unless a mark is newer", async ({ db }) => {
  const at = (day: string, hour = "10") => `${day}T${hour}:00:00.000Z`;
  await saveReviews(db, [reviewInput("o/a", 1, "h", { at: at("2026-01-01") })]);
  assert.equal((await marksOf(db, "o/a", 1))?.rerunCount ?? 0, 0, "a first review is not a re-review");
  await saveReviews(db, [reviewInput("o/a", 1, "h", { at: at("2026-01-01", "11") })]);
  assert.equal((await marksOf(db, "o/a", 1))!.rerunCount, 1);
  await saveReviews(db, [reviewInput("o/a", 1, "h", { at: at("2026-01-01", "12") })]);
  assert.equal((await marksOf(db, "o/a", 1))!.rerunCount, 2, "same day adds");
  assert.equal((await loadReviewHistory(db, [ref("o/a", 1)])).get("o/a#1")!.length, 3, "one history row per save, the copy of a replaced row adds none");
  await markStale(db, [ref("o/a", 1)], null);
  await saveReviews(db, [reviewInput("o/a", 1, "h", { at: at("2099-01-01") })]);
  assert.equal((await marksOf(db, "o/a", 1))!.rerunCount, 2, "an operator's request is not counted");
  await saveReviews(db, [reviewInput("o/a", 1, "h", { at: at("2099-01-02") })]);
  const m = (await marksOf(db, "o/a", 1))!;
  assert.deepEqual([m.rerunDay, m.rerunCount], ["2099-01-02", 1], "a new day starts again");
});

both("review failures count per head, start again at another head, and a saved review at the head clears them", async ({ db }) => {
  const f = (head: string, n: number) => ({ repo: "o/a", number: 1, head, at: `2026-01-01T0${n}:00:00.000Z` });
  await recordReviewFailures(db, [f("A", 1)]);
  await recordReviewFailures(db, [f("A", 2)]);
  assert.deepEqual([(await marksOf(db, "o/a", 1))!.failHead, (await marksOf(db, "o/a", 1))!.failCount], ["A", 2]);
  await recordReviewFailures(db, [f("B", 3)]);
  assert.deepEqual([(await marksOf(db, "o/a", 1))!.failHead, (await marksOf(db, "o/a", 1))!.failCount], ["B", 1]);
  await recordReviewFailures(db, [f("B", 4), f("B", 5)]);
  assert.equal((await marksOf(db, "o/a", 1))!.failCount, 3, "one call adds each");
  await saveReviews(db, [reviewInput("o/a", 1, "A")]);
  assert.equal((await marksOf(db, "o/a", 1))!.failCount, 3, "a review at another head leaves the marks");
  await saveReviews(db, [reviewInput("o/a", 1, "B")]);
  const m = (await marksOf(db, "o/a", 1))!;
  assert.deepEqual([m.failHead, m.failCount, m.failAt], [null, 0, null]);
});

both("a pre-merge row counts only when it read the diff against the base its head's review read; failed tries add up to the maximum", async ({ db }) => {
  await saveReviews(db, [reviewInput("o/a", 1, "same", { baseRef: "main" }), reviewInput("o/a", 2, "differs", { baseRef: "main" })]);
  const stored = (number: number, head: string, baseRef: string | null) => ({ repo: "o/a", number, head, at: T0, findings: [], baseRef });
  await savePremerge(db, [stored(1, "same", "main"), stored(2, "differs", "dev"), stored(3, "no-review", "dev"), stored(4, "no-base", null)]);
  const got = await loadPremerge(db, [1, 2, 3, 4].map((n, i) => ({ repo: "o/a", number: n, head: ["same", "differs", "no-review", "no-base"][i]! })));
  assert.deepEqual([...got.keys()].sort(), ["o/a#1@same", "o/a#3@no-review", "o/a#4@no-base"]);
  const head = [{ repo: "o/a", number: 5, head: "x" }];
  await savePremerge(db, [{ repo: "o/a", number: 5, head: "x", at: T0, error: "boom" }]);
  await savePremerge(db, [{ repo: "o/a", number: 5, head: "x", at: T0, error: "boom" }]);
  assert.equal((await loadPremerge(db, head)).get("o/a#5@x")!.tries, 2);
  await savePremerge(db, [{ repo: "o/a", number: 5, head: "x", at: T0, error: "gone", final: true }]);
  assert.ok((await loadPremerge(db, head)).get("o/a#5@x")!.tries >= 3);
  await savePremerge(db, [{ repo: "o/a", number: 5, head: "x", at: T0, findings: [], baseRef: null }]);
  assert.equal((await loadPremerge(db, head)).get("o/a#5@x")!.error, null);
});

const finding = (o: Partial<Finding> = {}): Finding => ({ title: "t", severity: "defect", duplicate_of: null, ...o });
const pm = (number: number, o: { findings?: Finding[] | null; error?: string | null; at?: string } = {}) =>
  ({ repo: "o/a", number, merge_sha: "sha", at: o.at ?? T0, model: "m", run_id: "r", findings: o.findings === undefined ? [] : o.findings, error: o.error ?? null });

both("a post-merge retry error becomes held at the third try, a failed try keeps a clean review, and skipped findings get follow-up rows", async ({ db }) => {
  for (let i = 0; i < 3; i++) await savePostmerge(db, [pm(1, { findings: null, error: "retry: no reply", at: `2026-01-01T0${i}:00:00.000Z` })]);
  const held = (await loadPostmerge(db, [ref("o/a", 1)])).get("o/a#1")!;
  assert.match(held.error!, /^held: gave up after 3 tries/);
  await savePostmerge(db, [pm(2, { findings: [] })]);
  const out = await savePostmerge(db, [pm(2, { findings: null, error: "retry: later", at: "2026-01-02T00:00:00.000Z" })]);
  assert.equal(out.defects.has("o/a#2"), false);
  assert.equal((await loadPostmerge(db, [ref("o/a", 2)])).get("o/a#2")!.error, null);
  const saved = await savePostmerge(db, [pm(3, { findings: [finding(), finding({ severity: "minor" }), finding({ duplicate_of: 9 })] })]);
  assert.equal(saved.defects.get("o/a#3"), 2);
  const rows = (await loadFollowups(db, [ref("o/a", 3)])).get("o/a#3")!;
  assert.deepEqual(rows.map((r) => [r.finding, r.state]), [[1, "skipped-minor"], [2, "skipped-duplicate"]]);
  assert.equal(rows[1]!.duplicate_of, 9);
});

both("a follow-up claim goes to one caller, a failed row can be claimed again, a filed row never", async ({ db }) => {
  const claim = (finding: number, attempts = 1) => ({ repo: "o/a", number: 1, review_at: T0, finding, title: "t", attempts });
  const first = await claimFollowups(db, [claim(0), claim(1)], { at: T0 });
  assert.equal(first.size, 2);
  assert.equal((await claimFollowups(db, [claim(0), claim(2)], { at: T0 })).size, 1, "only the new one");
  const rows = (await loadFollowups(db, [ref("o/a", 1)])).get("o/a#1")!;
  const of = (n: number) => rows.find((r) => r.finding === n)!;
  await saveFollowups(db, [{ ...of(0), state: "failed", note: "x" }, { ...of(1), state: "filed", issue_number: 7, url: "u" }]);
  const again = await claimFollowups(db, [claim(0, 2), claim(1, 2)], { at: T0 });
  assert.deepEqual([...again], [followupKey(claim(0))]);
  assert.equal((await loadFollowups(db, [ref("o/a", 1)])).get("o/a#1")!.find((r) => r.finding === 0)!.attempts, 2);
});

both("review posts: a fresh post stores every column, an edit changes head, edit time, opus time and identity only", async ({ db }) => {
  const post = { kind: "posted" as const, repo: "o/a", number: 1, review_id: "R1", head: "h1", posted_at: T0, edited_at: null, opus_at: T0, posted_as: "app" };
  await saveReviewPosts(db, [post, { ...post, number: 2, review_id: "R2" }]);
  await saveReviewPosts(db, [{ kind: "edited", repo: "o/a", number: 1, head: "h2", edited_at: "2026-01-02T00:00:00.000Z", opus_at: "2026-01-02T00:00:00.000Z", posted_as: "legacy" }]);
  const got = await loadPosts(db, [ref("o/a", 1), ref("o/a", 2)]);
  assert.deepEqual([got.get("o/a#1")!.review_id, got.get("o/a#1")!.head, got.get("o/a#1")!.posted_as, got.get("o/a#1")!.posted_at], ["R1", "h2", "legacy", T0]);
  assert.equal(got.get("o/a#2")!.head, "h1");
});

both("discussion: counted entries by others, the maintainer's newest, bodies only where a maintainer wrote after the review (cut to the second), unsure and carried heads", async ({ db }) => {
  const seen = "2026-01-01T10:00:00Z";
  await saveReviews(db, [
    reviewInput("o/a", 1, "h", { snap: { seen, hash: null } }), reviewInput("o/a", 2, "h", { snap: { seen, hash: null } }), reviewInput("o/a", 3, "h", { snap: { seen, hash: null } }),
    reviewInput("o/a", 4, "h", { review: { ...reviewInput("o/a", 4, "h").review, sure: false } }),
    reviewInput("o/a", 5, "h", { mode: "carried", model: "carried", base: "h0" }),
  ]);
  await seedComments(db, [
    { repo: "o/a", number: 1, id: "c1", author: "maint", at: "2026-01-01T10:00:00.5Z" },
    { repo: "o/a", number: 2, id: "c2", author: "maint", at: "2026-01-01T10:00:01Z" },
    { repo: "o/a", number: 2, id: "c2b", author: "Bot", at: "2026-01-01T12:00:00Z" },
    { repo: "o/a", number: 3, id: "c3", author: "outsider", at: "2026-01-02T00:00:00Z", assoc: "NONE" },
  ]);
  const facts = await loadReviewFacts(db, [1, 2, 3, 4, 5].map((n) => ref("o/a", n)), { now: Date.parse(T0), own: ["bot"] });
  assert.equal(facts.discussion.get("o/a#1")!.counted, null, "the second cut: not newer than the review's read");
  assert.deepEqual(facts.discussion.get("o/a#2")!.counted!.map((c) => c.id), ["c2"], "our own login is left out");
  assert.equal(facts.discussion.get("o/a#2")!.newest, "2026-01-01T10:00:01Z");
  assert.equal(facts.discussion.get("o/a#3")!.maint, "", "no maintainer entry");
  assert.equal(facts.discussion.get("o/a#3")!.counted, null);
  assert.ok(facts.unsureHeads.has("o/a#4@h") && !facts.unsureHeads.has("o/a#1@h"));
  assert.deepEqual([...facts.carriedChains.keys()], ["o/a#5"]);
  assert.equal(facts.latest.get("o/a#2")!.seen_at, seen);
});
