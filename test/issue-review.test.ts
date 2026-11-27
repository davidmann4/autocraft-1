// `review` on an issue: the maintainer's start runs one model review of the issue on their own Task Runner, posts it, and comes back
// with its recommendation, which a yes carries out; `review and implement` goes on to implement without a question.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Exec } from "../src/fixup/git.ts";
import type { IssueReview } from "../src/issuereview/prompt.ts";
import { runIssueReviews } from "../src/issuereview/run.ts";
import { dropSnapshotCache } from "../src/data/runners/index.ts";
import { readStartedCalls } from "../src/remote/started.ts";
import { LANES, planCtx } from "../src/runner/autopilot.ts";
import { liveWorkflow, workflowHistory } from "../src/workflow/store.ts";
import type { World } from "./world-db.ts";
import { MAINT, run, send, settle, unstarted } from "./workflow-start-world.ts";

const reviewOf = (recommendation: IssueReview["recommendation"], extra: Partial<IssueReview> = {}): IssueReview => ({
  asks: "Return None for an empty slice.", holds: "yes", claims: [{ claim: "first() indexes element 0", status: "holds", where: "src/lib.rs:12" }], related: [],
  size: "S", files: ["src/lib.rs"], approach: "Check the length first.", risks: [], recommendation, reason: "It still panics on an empty slice.", ...extra,
});

/**
 * Runs the issue review job with the review the model gives (null: no valid review), then the posting job; returns the posted comments
 * and the number of model calls. `unsent`: the post finds no app token, so it sends nothing; `refused`: GitHub refuses the post.
 */
async function reviewJob(w: World, review: IssueReview | null, o: { unsent?: boolean; refused?: boolean } = {}) {
  const posted: string[] = [];
  let calls = 0;
  const exec: Exec = async (_cmd, args, x) => {
    const input = String((x as { input?: string } | undefined)?.input ?? "");
    if (o.refused) return { code: 1, stdout: "", stderr: "HTTP 403: issue is locked" };
    if (input) posted.push(input);
    return { code: 0, stdout: args.includes("comment") ? "https://github.com/storytold/app/issues/7#issuecomment-1\n" : "", stderr: "" };
  };
  const deps = {
    checkout: async () => null, exec, mint: async () => { if (o.unsent) throw new Error("no token"); return "installation-token"; },
    ask: async () => { calls++; return review && { value: review, model: "claude-opus-5-5" }; },
  };
  await runIssueReviews(w.db, { repo: "app", by: "pipeline" }, () => {}, deps);
  await settle(w);
  await runIssueReviews(w.db, { repo: "app", by: "pipeline", post: true }, () => {}, deps);
  await settle(w);
  return { posted, calls };
}
test("review on an issue runs its review as the starter's work, posts it (again after a post that sent nothing), and a yes to its close recommendation closes the issue as the review said", async () => {
  const w = await (await unstarted(false)).issue(7);
  await run(w, "review", 7);
  assert.equal((await liveWorkflow(w.db, "app", 7))?.entry, "review");
  const jobs = await LANES.find((l) => l.name === "issue-review")!.detect(w.db, await planCtx(w.db));
  assert.deepEqual(jobs.map((j) => j.params.repo), ["app"], "the issue review step is planned for the issue");

  dropSnapshotCache(w.db);
  assert.ok((await readStartedCalls(w.db, Date.now())).owners([{ repo: "app", number: 7 }]).has(MAINT.toLowerCase()), "the review's calls are the started work of the maintainer");

  // A post that sends nothing is tried again after the backoff; the question waits for it.
  assert.deepEqual((await reviewJob(w, reviewOf("close", { close_as: "not-planned" }), { unsent: true })).posted, []);
  assert.notEqual((await liveWorkflow(w.db, "app", 7))?.state, "recommending", "the question waits for the comment");
  assert.deepEqual((await reviewJob(w, reviewOf("implement"))).posted, [], "nothing is posted before the backoff ends, and the stored review is kept");
  await w.db.run(w.db.k.updateTable("main.issue_reviews").set({ post_tries: JSON.stringify(["2026-01-01T00:00:00Z"]) }).where("number", "=", 7));
  const { posted } = await reviewJob(w, reviewOf("implement"));
  const comment = posted.find((p) => p.includes("Recommendation:")) ?? "";
  assert.match(comment, /AI-generated review \(Claude Opus 5\.5\)/, comment);
  assert.match(comment, /src\/lib\.rs:12/);
  assert.match(comment.trimEnd().split("\n").at(-1)!, /^Recommendation: close it as not planned\./);
  assert.ok(!comment.includes("AutoCraft"), comment);

  const wf = (await liveWorkflow(w.db, "app", 7))!;
  assert.equal(wf.state, "recommending");
  assert.ok(wf.rec?.close, JSON.stringify(wf.rec));
  const o = await send(w, "yes", 7);
  assert.equal(o.outcome, "run", o.line);
  assert.equal((await workflowHistory(w.db, "app", 7)).at(-1)?.state, "closed");
  assert.deepEqual(await w.rows("SELECT kind, close_as FROM workflow_actions WHERE number = 7"), [{ kind: "comment-close", close_as: "not-planned" }]);
});

test("review and implement on an issue goes on to implement when the review recommends it, and asks when it recommends something else", async () => {
  const w = await (await (await unstarted(false)).issue(7)).issue(9);
  await run(w, "review and implement", 7);
  await reviewJob(w, reviewOf("implement"));
  const wf = (await liveWorkflow(w.db, "app", 7))!;
  assert.deepEqual([wf.entry, wf.state, wf.rec], ["implement", "running", null], "implement starts without a question");

  await run(w, "review and implement", 9);
  await reviewJob(w, reviewOf("backlog"));
  const other = (await liveWorkflow(w.db, "app", 9))!;
  assert.deepEqual([other.entry, other.state, other.rec?.issue?.action], ["review", "recommending", "backlog"]);
});

test("review again on an issue's review runs it again, and a yes after three calls without a valid review tries again", async () => {
  const w = await (await unstarted(false)).issue(7);
  await run(w, "review", 7);
  await run(w, "review", 7);
  assert.equal((await reviewJob(w, null)).calls, 1, "the review runs again on the newest request");

  // The backoff between calls has ended each time.
  const due = () => w.db.run(w.db.k.updateTable("main.issue_reviews").set({ tried_at: "2026-01-01T00:00:00Z" }).where("number", "=", 7));
  await due(); await reviewJob(w, null);
  await due(); await reviewJob(w, null);
  const wf = (await liveWorkflow(w.db, "app", 7))!;
  assert.deepEqual([wf.state, wf.rec?.again], ["recommending", "review"], wf.rec?.text ?? "");
  await run(w, "yes", 7);
  assert.equal((await reviewJob(w, reviewOf("backlog"))).calls, 1, "the yes reviews it again");
  assert.equal((await liveWorkflow(w.db, "app", 7))?.rec?.issue?.action, "backlog");
});

test("a question to the reporter that GitHub refuses comes back with GitHub's answer, and a yes posts it again without a model call", async () => {
  const w = await (await unstarted(false)).issue(7);
  await run(w, "review", 7);
  await reviewJob(w, reviewOf("needs-info", { question: "Which version do you run?" }));
  await run(w, "yes", 7);
  const refused = await reviewJob(w, null, { refused: true });
  assert.equal(refused.calls, 0, "posting the question calls no model");
  const wf = (await liveWorkflow(w.db, "app", 7))!;
  assert.equal(wf.state, "recommending");
  assert.match(wf.rec?.text ?? "", /question to the reporter could not be posted: HTTP 403: issue is locked/);
  assert.equal(wf.rec?.issue?.action, "ask");

  await run(w, "yes", 7);
  const again = await reviewJob(w, null);
  assert.equal(again.calls, 0, "the yes posts the question, no review");
  assert.ok(again.posted.some((p) => p.includes("Which version do you run?")), again.posted.join("\n---\n"));
  assert.equal((await liveWorkflow(w.db, "app", 7))?.state, "waiting", "the issue waits for the reporter");
  assert.match(String((await w.rows("SELECT review FROM issue_reviews WHERE number = 7 ORDER BY id DESC LIMIT 1"))[0]?.review), /needs-info/, "the row that asks keeps the review");
});
