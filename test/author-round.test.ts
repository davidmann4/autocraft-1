// The review round: commits the author pushes to a PR approved for merge are reviewed, not asked about. A push that leaves the PR's
// own diff as reviewed keeps the review without a model call, a review that finds the commits within the approval goes on, and one
// that finds them beyond it asks the approver. The PR's own diffs come from git, never from the diff cache of an earlier process.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { exec, Git } from "../src/fixup/git.ts";
import { diffCacheDir } from "../src/review/diff.ts";
import { prepareOpusInput, runOpusReview, type OpusDeps } from "../src/review/opus.ts";
import { ownDiffsAt } from "../src/review/round-diff.ts";
import { selectOpusCandidates } from "../src/review/opus-candidates.ts";
import { parseOpusReply } from "../src/review/opus-parse.ts";
import { advanceWorkflows } from "../src/workflow/advance.ts";
import { liveWorkflow } from "../src/workflow/store.ts";
import { approvedReview, ticks } from "./workflow-advance-world.ts";
import { tmpdir } from "./world-db.ts";

const git = (dir: string, ...args: string[]): string => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
  { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });

/**
 * The PR's branches, named as the PR's heads: `sha1` (approved) changes `a`; then main changes `m` and adds a file, the author merges main
 * (`merged`), and adds `src/b.rs` (`theirs`). The reviews read each head's own diff against main, as GitHub and the round's git reader do.
 */
function prRepo(root: string): { deps: OpusDeps } {
  const dir = join(root, "app");
  mkdirSync(join(dir, "src"), { recursive: true });
  const lib = (a: string, m: string) => writeFileSync(join(dir, "src/lib.rs"), ["fn a() {", a, ...Array.from({ length: 40 }, (_, i) => `l${i}`), "fn m() {", m, ""].join("\n"));
  const commit = (msg: string) => { git(dir, "add", "-A"); git(dir, "commit", "-qm", msg); };
  git(dir, "init", "-q", "-b", "main");
  lib("a: 1", "m: 1"); commit("base");
  git(dir, "checkout", "-qb", "sha1"); lib("a: 2", "m: 1"); commit("approved");
  git(dir, "checkout", "-q", "main"); lib("a: 1", "m: 2"); writeFileSync(join(dir, "src/main_only.rs"), "x\n"); commit("main moves");
  git(dir, "checkout", "-qb", "merged", "sha1"); git(dir, "merge", "-q", "--no-edit", "main");
  git(dir, "checkout", "-qb", "theirs"); writeFileSync(join(dir, "src/b.rs"), "b: 3\n"); commit("new");
  const repo = new Git(exec, root, "app/.git");
  return { deps: {
    fetchDiff: async (_r, _n, head) => ({ ok: true, text: git(dir, "diff", `main...${head}`) }), fetchDelta: async () => ({ ok: false, tooLarge: false, error: "unused" }),
    ownDiffs: async (_r, _n, _b, from, to) => await ownDiffsAt(repo, from, to, "main"), model: "opus", maxChars: 120_000,
  } };
}
const reviewed = async (w: Awaited<ReturnType<typeof approvedReview>>, head: string, workflow: object | null, summary: string | null = null) =>
  await w.db.run(w.db.k.insertInto("main.opus_reviews").values({
    repo: "app", number: 1, head_oid: head, run_id: "rv", at: new Date().toISOString(), model: "m", mode: "full", verdict: "take", sure: 1, reason: "r",
    workflow: workflow ? JSON.stringify(workflow) : null, ...(summary ? { public_review: JSON.stringify({ summary, points: [] }) } : {}),
  }));

test("the author's commits on an approved PR are reviewed: an unchanged diff carries the review, in scope goes on, out of scope asks", async () => {
  process.env.AUTOCRAFT_DIFF_CACHE = join(tmpdir("author-round"), "cache");
  const { deps } = prRepo(tmpdir("author-round-git"));
  const w = await approvedReview();
  // The review at the approved head, made by another runner process: this one has no diff cached for it.
  await reviewed(w, "sha1", null);
  await ticks(w);

  // (a) The author merges the base branch: the PR's own change is the same lines at another place, so the review carries without a model call.
  await w.synced(1, "merged");
  await advanceWorkflows(w.db);
  const round = (await liveWorkflow(w.db, "app", 1))!;
  assert.deepEqual([round.state, round.blocker, round.step], ["running", null, "review new commits"]);
  // No Task Runner is connected, so only a review that needs no model call can be made.
  await runOpusReview(w.db, { repo: "app" }, () => {}, deps);
  assert.equal(existsSync(join(diffCacheDir(), "app", "1-sha1.diff")), false);
  assert.deepEqual((await w.rows("SELECT mode FROM opus_reviews WHERE head_oid = 'merged'")).map((r) => r.mode), ["carried"]);
  await ticks(w);
  const carried = (await liveWorkflow(w.db, "app", 1))!;
  assert.deepEqual([carried.state, carried.blocker, carried.baseHead, carried.approvedBy], ["running", null, "merged", round.approvedBy]);

  // (b) A commit that changes the code: Opus reads what the PR's own diff gained (not main's changes the merge brought), told the heads and
  // the files the new commits touch; a review in scope goes on to the merge.
  await w.synced(1, "theirs");
  await advanceWorkflows(w.db);
  // The review is due at once, whatever the interval since the carried one, and reads what the PR's own diff gained.
  const [cand] = await selectOpusCandidates(w.db, "app");
  assert.equal(cand?.head_oid, "theirs");
  const p = await prepareOpusInput(w.db, "app", cand!, deps, () => {});
  assert.ok(p.kind === "ready");
  assert.deepEqual([p.input.mode, p.input.author_commits], ["delta", { approved_head: "merged", new_head: "theirs", separated: true, files: ["src/b.rs"] }]);
  assert.match(p.input.diff, /\+b: 3/);
  assert.doesNotMatch(p.input.diff, /a: 2|m: 2|main_only/);
  const reply = JSON.stringify({ ref: "app#1", verdict: "take", sure: true, reason: "fine", fixes: [], risks: [], summary: "s.", why: "w.", public: { summary: "p", points: [] }, author_commits: { in_scope: true, note: "a fix" }, claims: [] });
  assert.deepEqual(parseOpusReply(reply, "app#1")?.workflow?.author_commits, { in_scope: true, note: "a fix" });
  await reviewed(w, "theirs", { outside_purpose: null, recommendation: null, author_commits: { in_scope: true, note: "a fix" } });
  await ticks(w);
  const goes = (await liveWorkflow(w.db, "app", 1))!;
  assert.deepEqual([goes.state, goes.blocker, goes.rec, goes.baseHead], ["running", null, null, "theirs"]);
  const leg = (await w.rows("SELECT state, head FROM preapprovals WHERE number = 1 ORDER BY id DESC"))[0]!;
  assert.equal(leg.head, "theirs");
  assert.notEqual(leg.state, "cancelled");

  // (c) A commit the review finds beyond the approval: the workflow asks the approver with the review's public finding.
  await w.synced(1, "extra");
  await advanceWorkflows(w.db);
  await reviewed(w, "extra", { outside_purpose: null, recommendation: null, author_commits: { in_scope: false, note: "adds an exporter" } }, "The new commits add a file exporter.");
  await ticks(w);
  const asks = (await liveWorkflow(w.db, "app", 1))!;
  assert.deepEqual([asks.state, asks.blocker], ["blocked", "author-commits"]);
  assert.match(asks.rec!.text, /adds? a file exporter/);

  // (d) A stop at the author's commits made before the round existed: the next pass withdraws its question and the round takes over.
  await w.synced(1, "later");
  await w.db.run(w.db.k.updateTable("main.item_workflows").set({
    state: "blocked", blocker: "author-commits", blocker_params: JSON.stringify({ from: "theirs", to: "later" }), rec_head: "later",
    rec: JSON.stringify({ text: "Review the new commits, then merge.", parts: { fix: [], drop: [] }, merges: true, newCommits: true }),
  }).where("id", "=", asks.id));
  await advanceWorkflows(w.db);
  const legacy = (await liveWorkflow(w.db, "app", 1))!;
  assert.deepEqual([legacy.state, legacy.blocker, legacy.rec, legacy.step], ["running", null, null, "review new commits"]);
});
