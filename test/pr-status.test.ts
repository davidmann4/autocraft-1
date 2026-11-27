// The PR status comment follows a PR through the merge queue, an integration batch and the merge: one post, then edits of
// the same comment, also after its stored record was lost (found again on GitHub by its marker, on an older page) and after
// the repo's Pipeline was switched off.
import assert from "node:assert/strict";
import { test } from "node:test";
import { writePlanCache } from "../src/core/plan-cache.ts";
import { setStatusApproval } from "../src/prstatus/approval.ts";
import { MARKER, onlyWaitFlip, runPrStatus } from "../src/prstatus/index.ts";
import type { Exec } from "../src/fixup/git.ts";
import type { Querier } from "../src/mirror.ts";
import { runCommand } from "../src/workflow/apply.ts";
import { parse } from "../src/workflow/parse.ts";
import { OPERATOR, world } from "./world-db.ts";

test("one status comment per PR: posted in the queue, edited in a batch and after the merge, also when its record was lost", async () => {
  const w = await (await (await (await (await world()).repo()).pr(1)).review(1)).verified(1);
  await (await w.premerge(1, "clean")).pr(2);
  const db = w.db;
  try {
    await db.prepare("UPDATE items SET url = 'https://github.com/o/app/pull/' || number WHERE repo = 'app'").run();
    await db.prepare("INSERT INTO item_stage (repo, number, stage, at, reviewed) VALUES ('app', 1, 'reviewed', '2026-01-01T00:00:00Z', 1)").run();
    await db.prepare("INSERT INTO settings (key, value) VALUES ('pipeline_login', 'pipeline-bot')").run();
    const replan = async () => { await writePlanCache(db, await w.plan()); };
    await replan();

    const calls: { args: string[]; body: string }[] = [];
    const exec: Exec = async (_cmd, args, opts) => {
      calls.push({ args, body: opts?.input ?? "" });
      return args[0] === "pr"
        ? { code: 0, stdout: "https://github.com/o/app/pull/1#issuecomment-1001\n", stderr: "" }
        : { code: 0, stdout: JSON.stringify({ html_url: "https://github.com/o/app/pull/1#issuecomment-1001" }), stderr: "" };
    };
    const onGitHub = () => calls.at(-1)!.body;
    // GitHub's comments, newest page first: ours sits on the older page behind someone else's newer comment.
    const querier: Querier = { spent: 0, remaining: 5000, query: async (_q, v) => {
      const older = (v as { before: string | null }).before === "c2";
      const nodes = older ? (calls.length ? [{ databaseId: 1001, body: onGitHub(), author: { login: "pipeline-bot" } }] : []) : [{ databaseId: 2002, body: "looks good", author: { login: "someone" } }];
      return { repository: { pullRequest: { comments: { pageInfo: { hasPreviousPage: !older, startCursor: older ? null : "c2" }, nodes } } } } as never;
    } };
    const run = async () => await runPrStatus(db, { repo: "app", by: "pipeline", runId: "t", limit: 10, exec, querier, base: "https://dash.example" });

    assert.deepEqual((await run()).posted, [], "the switch is off by default");
    assert.equal(calls.length, 0);
    await setStatusApproval(db, OPERATOR, "app", true);

    // PR 2 is not past triage: it gets no comment. PR 1 is ready to merge.
    const queued = await run();
    assert.deepEqual([queued.posted, queued.edited], [["app#1"], []]);
    assert.match(onGitHub(), /\*\*Status:\*\* In the merge queue, next in line/);
    assert.match(onGitHub(), /Details for maintainers: \[this PR\]\(https:\/\/dash\.example\/items\/app\/1\) · \[merge queue\]/);
    assert.ok(onGitHub().includes(MARKER));
    assert.deepEqual((await run()).due, 0, "an unchanged line is not written again");

    // A restart lost the record between the post and its row: the comment is found on GitHub and edited.
    await db.prepare("DELETE FROM pr_status_comments").run();
    await db.prepare("INSERT INTO merge_batches (id, repo, branch, state, base_sha, commit_sha, created_at, updated_at) VALUES (7, 'app', 'integration-app-1', 'open', 'b0', 'c1', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')").run();
    await db.prepare("INSERT INTO merge_batch_prs (batch_id, number, head_oid, position) VALUES (7, 1, 'sha1', 0)").run();
    await replan();
    assert.equal((await run()).due, 0, "a batch member keeps its line until the batch PR opens");
    await db.prepare("UPDATE merge_batches SET pr_number = 50 WHERE id = 7").run();
    const batched = await run();
    assert.deepEqual([batched.posted, batched.edited], [[], ["app#1"]]);
    assert.ok(calls.at(-1)!.args.includes("PATCH") && calls.at(-1)!.args.some((a) => a.endsWith("/issues/comments/1001")), "the same comment is edited");
    assert.match(onGitHub(), /Status:\*\* In the merge queue: checked in merge batch #50/);

    // The repo's Pipeline is switched off before the merge: the posted comment still gets its last edit.
    await db.prepare("UPDATE tracked_repos SET pipeline = 0 WHERE name = 'app'").run();
    await db.prepare("UPDATE items SET state = 'MERGED' WHERE repo = 'app' AND number = 1").run();
    await db.prepare("UPDATE merge_batches SET state = 'merged' WHERE id = 7").run();
    await replan();
    const merged = await run();
    assert.deepEqual([merged.posted, merged.edited], [[], ["app#1"]]);
    assert.match(onGitHub(), /Status:\*\* Merged with merge batch #50/);
    assert.equal(calls.filter((c) => c.args[0] === "pr").length, 1, "posted once");
    assert.deepEqual((await run()).due, 0, "a merged PR's comment is final");
  } finally {
    w.close();
  }
});

test("an item nobody started: its hold's comment shows no steps, and says once that nobody holds it any more", async () => {
  const w = await (await world()).repo();
  try {
    await w.acting(OPERATOR);
    await w.issue(7);
    await w.db.prepare("UPDATE items SET url = 'https://github.com/o/app/issues/' || number WHERE repo = 'app'").run();
    await w.db.prepare("INSERT INTO settings (key, value) VALUES ('pipeline_login', 'pipeline-bot') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();
    await setStatusApproval(w.db, OPERATOR, "app", true);
    const bodies: string[] = [];
    const exec: Exec = async (_cmd, _args, opts) => { bodies.push(opts?.input ?? ""); return { code: 0, stdout: "https://github.com/o/app/issues/7#issuecomment-1001\n", stderr: "" }; };
    const querier: Querier = { spent: 0, remaining: 5000, query: async () => ({ repository: { issue: { comments: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [] } } } }) as never };
    // Commands act under the app identity; the comments are written by the box account, since no app is registered to mint a token with.
    const identity = (value: string) => w.db.prepare("UPDATE settings SET value = ? WHERE key = 'github_identity'").run(value);
    const say = async (text: string) => {
      await identity("app");
      assert.equal((await runCommand(w.db, { login: OPERATOR, canWrite: async () => true }, "dashboard", { parsed: parse(text), items: [{ repo: "app", number: 7 }] })).items[0]!.outcome, "run");
      await identity("box");
    };
    const run = async () => await runPrStatus(w.db, { repo: "app", by: "pipeline", runId: "t", limit: 10, exec, querier, base: null });
    await say("hold");
    assert.deepEqual((await run()).posted, ["app#7"]);
    assert.match(bodies.at(-1)!, /Held by op/);
    assert.doesNotMatch(bodies.at(-1)!, /implement|recommend/);
    await say("resume");
    assert.deepEqual((await run()).edited, ["app#7"]);
    assert.match(bodies.at(-1)!, /Not held any more/);
    assert.deepEqual((await run()).due, 0);
  } finally {
    w.close();
  }
});

test("a head line flipping between Running and waiting for a Task Runner is not a new comment edit; other changes are", () => {
  const run = "**Running: merge**\n\n1. review (done)\n2. merge (running)";
  const wait = "**Waiting for a Task Runner**\n\n1. review (done)\n2. merge (running)";
  // A comment already on GitHub may name the person: the next edit takes the name out.
  const named = "**Waiting for ann's Task Runner (usage limit)**\n\n1. review (done)\n2. merge (running)";
  assert.equal(onlyWaitFlip(wait, run), true);
  assert.equal(onlyWaitFlip(run, wait), true);
  assert.equal(onlyWaitFlip(named, wait), false);
  assert.equal(onlyWaitFlip(named, run), false);
  assert.equal(onlyWaitFlip(run, run.replace("(running)", "(done)")), false);
  assert.equal(onlyWaitFlip(wait, "**Held by ann, 10:00 UTC**\n\n1. review (done)\n2. merge (running)"), false);
});
