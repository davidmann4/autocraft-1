// The issue review steps. `issue-review`: for each issue of the repo whose review a maintainer asked for, one Opus call with a
// read-only checkout of the default branch head, the review stored on its issue_reviews row to be posted. The call names the issue, so
// it is the started work of the issue's workflow (src/remote/started.ts): its starter's and approver's Task Runners take it first, and
// another runner after the hold. `issue-review-post` calls no model, so it needs no Task Runner: it posts the stored review as one
// comment on the issue, and a review's question to the reporter once a maintainer said yes to it. Only it posts, so two jobs never post
// the same row. What a person answers to the review is the workflow's (src/workflow/advance.ts makes the recommendation from the stored row).
import { isHalt } from "../agents/call.ts";
import { runModelStep } from "../agents/step.ts";
import { ISSUE_REVIEW } from "../agents/steps.ts";
import { pool } from "../classify/run.ts";
import { ISSUE_REVIEW_TRIES } from "../core/backoff.ts";
import type { By } from "../core/gates.ts";
import { guardItem } from "../core/guard.ts";
import { plannedItems } from "../core/select-items.ts";
import { loadLatestIssueReview, saveIssueReview, type IssueReviewRow } from "../data/issuereview/index.ts";
import { loadItems, loadRepos } from "../data/mirror/index.ts";
import { loadDuplicatesOf } from "../data/triage/index.ts";
import type { Db } from "../db/index.ts";
import { exec as defaultExec, type Exec } from "../fixup/git.ts";
import { isUnsent, rateLimited } from "../github/unsent.ts";
import { ghComment, WritePacedError, type Writer } from "../github/write.ts";
import { unsentAsk } from "../core/rules.ts";
import { ownerOf } from "../owners.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { discussionOf } from "../review/discussion.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { checkoutForCommit } from "../sandbox/index.ts";
import { issueReviewBody, questionBody } from "./comment.ts";
import { ISSUE_BODY_CHARS, issueReviewOf, type IssueReview, type IssueReviewInput } from "./prompt.ts";

const PROMPT = CLAUDE_PROMPTS["review.issue"];
/** The audit login of the step's writes. */
const ACTOR = "issue-review";
/** Issues of one job reviewed at once. */
const AT_ONCE = 4;

/** `post`: the posting step (issue-review-post), which calls no model. */
export type IssueReviewParams = { repo: string; number?: number; by: By; jobId?: number; post?: boolean; onHandled?: (n: number) => void };
export type IssueReviewDeps = {
  /** A read-only checkout of the repo's default branch head: its directory, commit and branch; null when none could be made. */
  checkout: (db: Db, repo: string) => Promise<{ dir: string; sha: string; branch: string } | null>;
  /** The review call; absent: the real model call. */
  ask?: (input: IssueReviewInput) => Promise<{ value: IssueReview; model: string } | null>;
  exec?: Exec;
  /** Replaces the installation-token minter of the writes (tests). */
  mint?: Writer["mint"];
};
export type IssueReviewSummary = { runId: string; reviewed: number; posted: number; asked: number; failed: number; waiting: number };

export function defaultIssueReviewDeps(): IssueReviewDeps {
  return {
    checkout: async (db, repo) => {
      const branch = (await loadRepos(db, { names: [repo], all: true })).get(repo)?.default_branch ?? "main";
      const { mainHeadOf } = await import("../github/fork.ts");
      const sha = await mainHeadOf(repo, branch);
      const dir = sha ? await checkoutForCommit(repo, branch, sha, console.log) : null;
      return dir && sha ? { dir, sha, branch } : null;
    },
  };
}

/** The issue as the prompt shows it: its text, the discussion, and the duplicates and pull requests AutoCraft knows. */
async function inputOf(db: Db, repo: string, number: number, openPr: { number: number; closes: boolean } | null): Promise<IssueReviewInput | null> {
  const ref = `${repo}#${number}`;
  const [items, dupes, discussion] = await Promise.all([loadItems(db, [{ repo, number }], "text"), loadDuplicatesOf(db, [{ repo, number }]), discussionOf(db, repo, number)]);
  const it = items.get(ref);
  if (!it) return null;
  const others = [...(dupes.get(ref) ?? []).map((d) => ({ n: d.other, relation: "duplicate" as const })), ...(openPr ? [{ n: openPr.number, relation: openPr.closes ? "closes" as const : "mentions" as const }] : [])];
  const known = others.length ? await loadItems(db, others.map((o) => ({ repo, number: o.n })), "text") : new Map();
  const labels = (() => { try { const v = JSON.parse(it.labels ?? "[]") as unknown; return Array.isArray(v) ? v.map(String) : []; } catch { return []; } })();
  return {
    repo, number, ref, title: it.title ?? "", body: (it.body ?? "").slice(0, ISSUE_BODY_CHARS), author: it.author ?? null, author_association: it.author_association ?? null, labels,
    comments: discussion.entries,
    related: others.flatMap((o) => {
      const x = known.get(`${repo}#${o.n}`);
      return x ? [{ ref: `#${o.n}`, kind: x.kind === "pr" ? "pull request" as const : "issue" as const, state: x.state, title: x.title ?? "", relation: o.relation }] : [];
    }),
  };
}

/** Reviews every due issue of the repo (or the one named), or with `post` posts their stored reviews and questions to reporters. */
export async function runIssueReviews(db: Db, p: IssueReviewParams, log: (l: string) => void = console.log, deps?: IssueReviewDeps): Promise<IssueReviewSummary> {
  const d = deps ?? defaultIssueReviewDeps();
  const runId = `issue-review-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
  const s: IssueReviewSummary = { runId, reviewed: 0, posted: 0, asked: 0, failed: 0, waiting: 0 };
  const kind = p.post ? "issue-review-post" : "issue-review";
  const due = (await plannedItems(db, kind, { repo: p.repo, by: p.by })).filter((x) => p.number === undefined || x.facts.number === p.number);
  if (!due.length) { log(`${kind} ${p.repo}: nothing due`); return s; }
  let checkout: Promise<Awaited<ReturnType<IssueReviewDeps["checkout"]>>> | undefined;
  let handled = 0;
  await pool(due.map((x) => async () => {
    const { repo, number } = x.facts, ref = `${repo}#${number}`;
    const g = await guardItem(db, { repo, number }, { kind }, p.by);
    if ("refused" in g) { s.waiting++; log(`  ${g.refused}`); return; }
    const row = await loadLatestIssueReview(db, repo, number);
    if (!row) { s.waiting++; return; }
    if (p.post) {
      if (row.state !== "ask" && row.state !== "posting") { s.waiting++; return; }
      await postOf(db, row, d, { log, summary: s, g });
      p.onHandled?.(++handled);
      return;
    }
    if (row.state !== "queued" && row.state !== "reporter") { s.waiting++; return; }
    const input = await inputOf(db, repo, number, x.facts.openPr);
    if (!input) { s.waiting++; return; }
    const co = d.ask ? null : await (checkout ??= d.checkout(db, repo));
    let got: { value: IssueReview; model: string } | null;
    try {
      if (d.ask) got = await d.ask(input);
      else {
        const r = await runModelStep(db, ISSUE_REVIEW, { ...input, ...(co && { repo_dir: REPO_PATH }) }, {
          model: PROMPT.models[0]!, ...(co && { checkout: co.dir }),
          usage: { run: runId, agent: `issue-review-${repo}-${number}`, stage: "review", items: (ok) => (ok ? 1 : 0) },
        });
        got = r.ok ? { value: r.value, model: r.model || PROMPT.models[0]! } : null;
      }
    } catch (e) {
      if (!isHalt(e)) throw e;
      s.waiting++;
      log(`  ${ref}: no Task Runner took the review; it waits`);
      return;
    }
    p.onHandled?.(++handled);
    await record(db, row, got, co, { log, summary: s, jobId: p.jobId ?? null });
  }), Math.min(AT_ONCE, due.length));
  log(p.post ? `${kind} ${p.repo}: ${s.posted} reviews posted, ${s.asked} questions posted, ${s.failed} failed, ${s.waiting} waiting` : `${kind} ${p.repo}: ${s.reviewed} reviewed, ${s.failed} failed, ${s.waiting} waiting`);
  return s;
}

type Outcome = { log: (l: string) => void; summary: IssueReviewSummary };

/** Stores the call's outcome on the row; a valid review is stored to be posted by the posting step. */
async function record(db: Db, row: IssueReviewRow, got: { value: IssueReview; model: string } | null, co: { sha: string } | null, o: Outcome & { jobId: number | null }): Promise<void> {
  const ref = `${row.repo}#${row.number}`, at = new Date().toISOString(), expect = ["queued", "reporter"] as const;
  if (!got) {
    const tries = row.tries + 1, failed = tries >= ISSUE_REVIEW_TRIES;
    await saveIssueReview(db, row.id, { tries, triedAt: at, error: "no valid review", ...(failed && { state: "failed" as const }), jobId: o.jobId }, expect);
    o.summary.failed++;
    o.log(`  ${ref}: no valid review (call ${tries} of ${ISSUE_REVIEW_TRIES})${failed ? "; the maintainer is asked whether to try again" : ""}`);
    return;
  }
  const stored = { state: "posting" as const, review: got.value, model: got.model, commitSha: co?.sha ?? null, reviewedAt: at, tries: 0, error: null, postTries: [], jobId: o.jobId };
  if (!await saveIssueReview(db, row.id, stored, expect)) return;
  o.summary.reviewed++;
  o.log(`  ${ref}: reviewed, recommends ${got.value.recommendation}`);
}

/**
 * Posts the row's review comment (state posting) or its question to the reporter (state ask). A post that sent nothing (no app token,
 * write pacing, GitHub's rate limit) is tried again after the unsent writes' backoff (src/core/rules.ts unsentAsk); after those tries, or
 * a post GitHub refused, the row is done with GitHub's answer as its error, and the maintainer's recommendation says the post failed
 * (src/workflow/issue-review.ts): the review's own recommendation stands beside a comment that was not posted; a yes to a question that
 * was not posted posts it again.
 */
async function postOf(db: Db, row: IssueReviewRow, d: IssueReviewDeps, o: Outcome & { g: Parameters<typeof ghComment>[1] }): Promise<void> {
  const ref = `${row.repo}#${row.number}`, ask = row.state === "ask";
  const review = issueReviewOf(row.review);
  let body: string;
  if (ask) body = questionBody(row.question ?? "", (await loadItems(db, [{ repo: row.repo, number: row.number }], "card")).get(ref)?.author ?? null, ownerOf(row.repo));
  else if (review) body = issueReviewBody(review, { owner: ownerOf(row.repo), head: row.commitSha, branch: row.commitSha ? (await loadRepos(db, { names: [row.repo], all: true })).get(row.repo)?.default_branch ?? null : null });
  else {
    // Nothing to post: the row ends, and the maintainer is asked whether to review again.
    await saveIssueReview(db, row.id, { state: "done", postTries: [], error: "no review to post" }, [row.state]);
    o.summary.failed++;
    return;
  }
  const w: Writer = { db, login: ACTOR, ...(d.mint && { mint: d.mint }) };
  let url: string | null = null, error: string | null = null, again = false;
  try {
    const r = await ghComment(w, o.g, d.exec ?? defaultExec, ask ? "issue-question" : "issue-review-comment", { repo: row.repo, number: row.number, pr: false },
      { by: "model", kind: ask ? "question" : "review", model: row.model }, body, { review: row.id, ...(review && !ask && { recommendation: review.recommendation }) });
    if (r.code === 0) url = /https:\/\/\S+#issuecomment-\d+/.exec(r.stdout)?.[0] ?? "";
    else { error = r.stderr.replace(/\s+/g, " ").slice(0, 200); again = r.sent === false || rateLimited(error); }
  } catch (e) {
    error = String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 200);
    again = isUnsent(e) || e instanceof WritePacedError;
  }
  const what = ask ? "question to the reporter" : "review comment";
  const at = new Date().toISOString(), tries = [...row.postTries, at];
  if (url !== null) {
    await saveIssueReview(db, row.id, ask ? { state: "reporter", askedAt: at, postTries: [], error: null } : { state: "done", commentUrl: url || null, postTries: [], error: null }, [row.state]);
    if (ask) o.summary.asked++;
    else o.summary.posted++;
    o.log(`  ${ref}: ${what} posted`);
  } else if (again && unsentAsk(tries, Date.parse(at)) !== "final") {
    await saveIssueReview(db, row.id, { postTries: tries, error: `${what} not sent: ${error}` }, [row.state]);
    o.summary.waiting++;
    o.log(`  ${ref}: ${what} not sent, tried again later: ${error}`);
  } else {
    await saveIssueReview(db, row.id, { state: "done", postTries: [], error: error || "GitHub gave no reason" }, [row.state]);
    o.summary.failed++;
    o.log(`  ${ref}: ${what} not posted: ${error}`);
  }
}
