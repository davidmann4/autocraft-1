// The pre-approved merge: a fix-up pushed, a take review, green CI and the hand-over to the merge queue; and a foreign push that cancels it.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { actionable } from "../src/decisions.ts";
import { mergeDecisionId } from "../src/core/rules.ts";
import { reviewHolds } from "../src/review/gate.ts";
import { advancePreapprovals, cancelPreapproval, preapprovalOf, preapproveMerge, runPipelineStep } from "../src/preapproval/index.ts";
import { addFastTrack, fastScoreOf, fastTrackList, setFastTrackBypass, setFastTrackWeight, workScores } from "../src/fasttrack.ts";
import { operatorEditable, splitChanges } from "../src/fixup/patch.ts";
import { operatorCommentText } from "../src/fixup/template.ts";
import { scopeToTracked } from "../src/repos.ts";
import { excluded } from "../src/db/kx.ts";
import { OPERATOR, T0, world, type World } from "./world-db.ts";
import { queueAdd, queueOrigins, queuePage } from "../src/dash/api/queue-page.ts";
import type { Req } from "../src/dash/types.ts";
import type { CachedEntry } from "../src/core/plan-read.ts";
import { refreshPlanCache } from "../src/core/plan-cache.ts";
import { queuedField } from "../src/review/queued.ts";

let current: World | null = null;
const fresh = async (): Promise<World> => (current = await (await world()).repo());
afterEach(() => current?.close());

const start = (w: World, n: number, merge = true) =>
  runPipelineStep(w.db, { repo: "app", number: n, step: { kind: "fixup", instructions: "rename a to b", merge }, by: OPERATOR });
const fixId = async (w: World, n: number): Promise<number> => ((await w.rows("SELECT id FROM operator_fixups WHERE number = ? ORDER BY id DESC", n))[0]!.id as number);
const fixRow = async (w: World, n: number, state: string, to: string | null = null) =>
  await w.db.run(w.db.k.insertInto("fixups").values({ repo: "app", number: n, from_head: `sha${n}`, to_head: to, state, attempt: 1, created_at: T0, source: "operator", operator_fix: await fixId(w, n) }));
const pushed = async (w: World, n: number, to: string) => await fixRow(w, n, "pushed", to);
const kindsOf = async (w: World, n: number) => (await w.prPlan(n)).actions.map((a) => `${a.kind}:${String(a.params?.source ?? "")}`);
/** A pre-approved merge whose fix-up pushed `<n>b` and whose sure take review of it exists: it waits in ci for CI and the pre-merge review. */
const inCi = async (w: World, n: number) => {
  await start(w, n);
  await pushed(w, n, `sha${n}b`);
  await (await w.synced(n, `sha${n}b`)).review(n, { head: `sha${n}b` });
  await settle(w);
  assert.equal((await preapprovalOf(w.db, "app", n))?.state, "ci");
};
/** inCi, for a pre-approved merge queued with bypass checks. */
const bypassed = async (w: World, n: number) => {
  await inCi(w, n);
  await w.db.run(w.db.k.updateTable("preapprovals").set({ bypass: 1 }).where("number", "=", n));
};
const answerOf = async (w: World, n: number, head: string) => await w.db.all(w.db.k.selectFrom("decisions").select("answer").where("id", "=", mergeDecisionId("app", n, head)));
const settle = async (w: World) => { for (let i = 0; i < 5; i++) await advancePreapprovals(w.db); };

describe("pre-approved merge", () => {
  test("fix-up pushed, review take, CI green: the Merge answer is written for the operator", async () => {
    const w = await (await (await fresh()).pr(1)).review(1, { verdict: "take-fix" });
    await start(w, 1);
    assert.equal((await preapprovalOf(w.db, "app", 1))?.state, "fixup");
    // The planner works the operator's fix-up and merges nothing meanwhile.
    const kinds = (await w.prPlan(1)).actions.map((a) => `${a.kind}:${String(a.params?.source ?? "")}`);
    assert.ok(kinds.includes("fixup:operator"), kinds.join());
    assert.ok(!kinds.some((k) => k.startsWith("fixup:review") || k.startsWith("merge")), kinds.join());

    await pushed(w, 1, "sha1b");
    await w.synced(1, "sha1b");
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 1))?.state, "review");
    assert.equal((await preapprovalOf(w.db, "app", 1))?.head, "sha1b");

    await w.review(1, { head: "sha1b" });
    await settle(w);
    // CI is green, but the pre-merge review of the pushed head comes first.
    assert.equal((await preapprovalOf(w.db, "app", 1))?.state, "ci");
    assert.ok((await kindsOf(w, 1)).includes("premerge:"), (await kindsOf(w, 1)).join());
    await w.premerge(1, "clean");
    await settle(w);
    const p = (await preapprovalOf(w.db, "app", 1))!;
    assert.equal(p.state, "queued");
    const id = mergeDecisionId("app", 1, "sha1b");
    assert.deepEqual((await actionable(w.db)).filter((a) => a.id === id).map((a) => [a.answer, a.kind]), [["merge", "merge"]]);
    assert.ok((await w.db.all(w.db.k.selectFrom("preapprovals").select("state"))).every((r) => r.state === "queued"));
    assert.ok((await w.db.all(w.db.k.selectFrom("audit").select("action").where("target", "=", "app#1").where("action", "=", "preapproval"))).length >= 4);
  });

  test("a push by someone else cancels it, and a red CI asks a Merge question instead", async () => {
    const w = await (await (await (await (await fresh()).pr(2)).review(2, { verdict: "take-fix" })).pr(3)).review(3, { verdict: "take-fix" });
    await start(w, 2);
    await w.synced(2, "foreign");
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 2))?.state, "cancelled");
    assert.equal((await w.rows("SELECT state FROM operator_fixups WHERE number = 2"))[0]!.state, "ended");

    await start(w, 3);
    await pushed(w, 3, "sha3b");
    await (await w.synced(3, "sha3b")).review(3, { head: "sha3b" });
    await w.db.run(w.db.k.updateTable("pr_checks").set({ overall: "failure" }).where("number", "=", 3));
    // The CI fix step may still repair the red head: the pre-approval waits for it, and asks once it has given up.
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 3))?.state, "ci");
    await w.db.run(w.db.k.insertInto("ci_fixes").values({ repo: "app", number: 3, head: "sha3b", kind: "code", state: "capped", attempt: 1, created_at: T0 }));
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 3))?.state, "asked");
    const q = await answerOf(w, 3, "sha3b");
    assert.deepEqual(q, [{ answer: null }]);
  });

  test("a sure take review does not let the queue merge or ask while the pre-approval waits", async () => {
    const w = await (await (await (await (await fresh()).pr(8)).review(8)).verified(8)).premerge(8, "clean");
    assert.ok((await kindsOf(w, 8)).some((k) => k.startsWith("merge")), (await kindsOf(w, 8)).join());
    await start(w, 8);
    assert.ok(!(await kindsOf(w, 8)).some((k) => k.startsWith("merge") || k.startsWith("ask-merge")), (await kindsOf(w, 8)).join());
  });

  test("an unsure take of the push goes on to CI; a hold review of it asks a Merge question", async () => {
    const w = await (await (await fresh()).pr(4)).review(4, { verdict: "take-fix" });
    await start(w, 4);
    await pushed(w, 4, "sha4b");
    await (await w.synced(4, "sha4b")).review(4, { head: "sha4b", sure: false });
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 4))?.state, "ci");
    await w.db.run(w.db.k.updateTable("opus_reviews").set({ verdict: "hold" }).where("number", "=", 4).where("head_oid", "=", "sha4b"));
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 4))?.state, "asked");
    assert.deepEqual(await answerOf(w, 4, "sha4b"), [{ answer: null }]);
  });

  test("a re-review that turns unsure during ci still hands over, after the review", async () => {
    const w = await (await (await fresh()).pr(5)).review(5, { verdict: "take-fix" });
    await inCi(w, 5);
    await w.premerge(5, "clean");
    await w.db.run(w.db.k.updateTable("opus_reviews").set({ sure: 0 }).where("number", "=", 5).where("head_oid", "=", "sha5b"));
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 5))?.state, "queued");
    // The merge queue keeps a Merge answer at an unsure head only when it came after the review.
    const f = (await w.plan()).prs.find((x) => x.facts.number === 5)!.facts;
    assert.ok(f.decision.mergeAnswerAfterReview && f.review!.unsure);
  });

  test("the pre-merge review gates the hand-over: no review waits, a defect asks", async () => {
    const w = await (await (await (await (await fresh()).pr(9)).review(9, { verdict: "take-fix" })).pr(10)).review(10, { verdict: "take-fix" });
    await inCi(w, 9);
    assert.equal((await w.db.all(w.db.k.selectFrom("decisions").select((eb) => eb.lit(1).as("one")).where("id", "=", mergeDecisionId("app", 9, "sha9b")))).length, 0);
    await inCi(w, 10);
    await w.premerge(10, "defect", false);
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 10))?.state, "asked");
    assert.deepEqual(await answerOf(w, 10, "sha10b"), [{ answer: null }]);
  });

  test("cancelling after the hand-over takes the Merge answer back, and the cancelled row stays cancelled", async () => {
    const w = await (await (await fresh()).pr(6)).review(6, { verdict: "take-fix" });
    await inCi(w, 6);
    await w.premerge(6, "clean");
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 6))?.state, "queued");
    assert.deepEqual(await answerOf(w, 6, "sha6b"), [{ answer: "merge" }]);
    assert.equal((await cancelPreapproval(w.db, OPERATOR, "app", 6)).state, "cancelled");
    assert.deepEqual(await answerOf(w, 6, "sha6b"), [{ answer: null }]);
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 6))?.state, "cancelled");
    assert.deepEqual((await actionable(w.db)).filter((a) => a.id === mergeDecisionId("app", 6, "sha6b")), []);
  });

  test("an operator fix-up stored for linting is planned for its lint check, and a dropped one ends the request instead of looping", async () => {
    const w = await (await (await fresh()).pr(11)).pr(12);
    await start(w, 11);
    await fixRow(w, 11, "linting");
    const kinds = await kindsOf(w, 11);
    assert.ok(!kinds.includes("fixup:operator"), kinds.join());
    assert.ok(kinds.includes("lint:operator"), kinds.join());

    await start(w, 12);
    await fixRow(w, 12, "superseded");
    assert.ok(!(await kindsOf(w, 12)).includes("fixup:operator"), (await kindsOf(w, 12)).join());
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 12))?.state, "failed");
  });

  test("a fix-up request without merge ends when the head moves, and a pre-approval whose fix-up cannot run asks", async () => {
    const w = await (await (await (await fresh()).pr(13)).pr(14)).review(14, { verdict: "take-fix" });
    await start(w, 13, false);
    await w.synced(13, "moved13");
    await settle(w);
    assert.equal((await w.rows("SELECT state FROM operator_fixups WHERE number = 13"))[0]!.state, "ended");

    await start(w, 14);
    await w.db.run(w.db.k.updateTable("pr_checks").set({ mergeable: "CONFLICTING" }).where("number", "=", 14));
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 14))?.state, "asked");
  });

  test("a cancel is refused while a merge job runs, and a merge that lands after a cancel turns the row into merged", async () => {
    const w = await (await (await fresh()).pr(15)).review(15, { verdict: "take-fix" });
    await inCi(w, 15);
    await w.premerge(15, "clean");
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 15))?.state, "queued");
    const job = (await w.db.get(w.db.k.insertInto("jobs").values({ step: "merge", params: "{}", requested_by: "pipeline", requested_at: T0, state: "running", repo: "app" }).returning("id")))!;
    await assert.rejects(cancelPreapproval(w.db, OPERATOR, "app", 15), /merge of the repo is running/);
    assert.equal((await preapprovalOf(w.db, "app", 15))?.state, "queued");
    await w.db.run(w.db.k.updateTable("jobs").set({ state: "done" }).where("id", "=", job.id));
    await cancelPreapproval(w.db, OPERATOR, "app", 15);
    await w.db.run(w.db.k.insertInto("merges").values({ repo: "app", number: 15, head_oid: "sha15b", run_id: "r", at: new Date().toISOString(), path: "operator", method: "squash", outcome: "merged" }));
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 15))?.state, "merged");
  });

  test("untracking the repo leaves an active row untouched on the scoped connection, and tracking again resumes it", async () => {
    const w = await (await (await fresh()).pr(40)).review(40, { verdict: "take-fix" });
    await start(w, 40);
    await pushed(w, 40, "sha40b");
    await w.synced(40, "sha40b");
    await scopeToTracked(w.db);
    await w.db.run(w.db.k.deleteFrom("main.tracked_repos").where("name", "=", "app"));
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 40))?.state, "fixup");
    assert.equal((await w.rows("SELECT state FROM operator_fixups WHERE number = 40"))[0]!.state, "queued");
    await w.db.run(w.db.k.insertInto("main.tracked_repos").values({ name: "app", added_by: OPERATOR, added_at: T0, pipeline: 1 }));
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 40))?.state, "review");
  });

  test("a Merge answer at H carries across the pipeline's own conflict merge to H2 as a row in review, once", async () => {
    const w = await (await (await (await fresh()).pr(30)).review(30, { verdict: "take" })).answer(30, "merge");
    await w.db.run(w.db.k.insertInto("conflict_merges").values({ repo: "app", number: 30, from_head: "sha30", to_head: "sha30m", state: "merged", attempt: 1, created_at: T0, own_diff: "same" }));
    await w.synced(30, "sha30m");
    await advancePreapprovals(w.db);
    const p = (await preapprovalOf(w.db, "app", 30))!;
    assert.deepEqual([p.state, p.fromHead, p.head, p.by], ["review", "sha30", "sha30m", OPERATOR]);
    await advancePreapprovals(w.db);
    assert.equal((await w.db.all(w.db.k.selectFrom("preapprovals").select("id").where("number", "=", 30))).length, 1);
    // The question at the old head is not asked again at the new one while the row runs.
    assert.ok(!(await kindsOf(w, 30)).some((k) => k.startsWith("ask-merge") || k.startsWith("merge")), (await kindsOf(w, 30)).join());
  });

  test("the pipeline's own CI fix push ends the pre-approval like a foreign push", async () => {
    const w = await (await (await (await (await fresh()).pr(16)).review(16, { verdict: "take-fix" })).pr(17)).review(17, { verdict: "take-fix" });
    await inCi(w, 16);
    await w.db.run(w.db.k.insertInto("ci_fixes").values({ repo: "app", number: 16, head: "sha16b", to_head: "sha16c", kind: "format", state: "pushed", attempt: 1, created_at: T0 }));
    await w.synced(16, "sha16c");
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 16))?.state, "cancelled");

    await inCi(w, 17);
    await w.synced(17, "foreign17");
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 17))?.state, "cancelled");
  });

  test("with bypass checks, the pipeline's own CI fix and conflict resolution carry the pre-approval to a fresh review; a foreign push still cancels it", async () => {
    const w = await (await (await (await (await (await (await fresh()).pr(16)).review(16, { verdict: "take-fix" })).pr(17)).review(17, { verdict: "take-fix" })).pr(19)).review(19, { verdict: "take-fix" });
    await bypassed(w, 16);
    await w.db.run(w.db.k.insertInto("ci_fixes").values({ repo: "app", number: 16, head: "sha16b", to_head: "sha16c", kind: "format", state: "pushed", attempt: 1, created_at: T0 }));
    await w.synced(16, "sha16c");
    await settle(w);
    const p16 = (await preapprovalOf(w.db, "app", 16))!;
    assert.deepEqual([p16.state, p16.head], ["review", "sha16c"]);

    // A resolution that changed the PR's own diff is model-written code too: it is reviewed again, not merged on the earlier review.
    await bypassed(w, 19);
    await w.db.run(w.db.k.insertInto("conflict_merges").values({ repo: "app", number: 19, from_head: "sha19b", to_head: "sha19m", state: "merged", attempt: 1, created_at: T0, own_diff: "changed" }));
    await w.synced(19, "sha19m");
    await settle(w);
    const p19 = (await preapprovalOf(w.db, "app", 19))!;
    assert.deepEqual([p19.state, p19.head], ["review", "sha19m"]);
    assert.deepEqual(await answerOf(w, 19, "sha19m"), []);

    await bypassed(w, 17);
    await w.synced(17, "foreign17");
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 17))?.state, "cancelled");
  });

  test("pre-merge defects with fixes ask without bypass checks; with it the fix-up makes them and its push is reviewed again, and an unsure review without a defect hands over", async () => {
    const w = await (await (await (await (await (await (await fresh()).pr(20)).review(20, { verdict: "take-fix" })).pr(21)).review(21, { verdict: "take-fix" })).pr(22)).review(22, { verdict: "take-fix" });
    await inCi(w, 22);
    await w.premerge(22, "defect");
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 22))?.state, "asked");

    await bypassed(w, 20);
    await w.premerge(20, "defect");
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 20))?.state, "ci");
    assert.ok((await kindsOf(w, 20)).includes("fixup:premerge"), (await kindsOf(w, 20)).join());
    await w.db.run(w.db.k.insertInto("fixups").values({ repo: "app", number: 20, from_head: "sha20b", to_head: "sha20c", state: "pushed", attempt: 1, created_at: T0, source: "premerge" }));
    // Before the mirror shows the push, the fix-up is no longer planned; the row waits for the new head instead of asking.
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 20))?.state, "ci");
    await w.synced(20, "sha20c");
    await settle(w);
    const p = (await preapprovalOf(w.db, "app", 20))!;
    assert.deepEqual([p.state, p.head], ["review", "sha20c"]);

    await bypassed(w, 21);
    await w.premerge(21, "clean");
    await w.db.run(w.db.k.updateTable("premerge_reviews").set({ unsure: 1 }).where("number", "=", 21));
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 21))?.state, "queued");
  });

  test("cancelling a queued PR that is in a batch removes it from the batch and takes the answer back", async () => {
    const w = await (await (await fresh()).pr(18)).review(18, { verdict: "take-fix" });
    await inCi(w, 18);
    await w.premerge(18, "clean");
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 18))?.state, "queued");
    await w.db.run(w.db.k.insertInto("merge_batches").values({ id: 5, repo: "app", branch: "integration-app-1", state: "open", base_sha: "b", commit_sha: "t", created_at: T0, updated_at: T0 }));
    await w.db.run(w.db.k.insertInto("merge_batch_prs").values({ batch_id: 5, number: 18, head_oid: "sha18b", position: 1 }));
    assert.equal((await cancelPreapproval(w.db, OPERATOR, "app", 18)).state, "cancelled");
    assert.equal((await w.db.get(w.db.k.selectFrom("merge_batches").select("state").where("id", "=", 5)))!.state, "superseded");
    assert.deepEqual(await answerOf(w, 18, "sha18b"), [{ answer: null }]);
    assert.equal((await w.db.all(w.db.k.selectFrom("merge_holds").select((eb) => eb.lit(1).as("one")).where("number", "=", 18))).length, 0);
  });

  test("an operator fix-up may edit any file but the protected ones, and its comment lists the model's changes", () => {
    assert.ok(operatorEditable("docs/guide.txt") && operatorEditable("src/a.rs"));
    for (const f of ["Cargo.toml", "crates/x/Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "rust-toolchain", ".gitmodules", ".gitattributes", "CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS", ".claude/settings.json", "sub/AGENTS.md"]) assert.ok(!operatorEditable(f), f);
    assert.ok(!operatorEditable(".github/workflows/ci.yml") && !operatorEditable("build.rs") && !operatorEditable("CLAUDE.md") && !operatorEditable("a/../b"));
    const r = splitChanges("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n\nCHANGES:\n1. Renamed a to b.\n2) Fixed the doc.\n");
    assert.deepEqual(r.changes, ["Renamed a to b.", "Fixed the doc."]);
    assert.ok(r.diff.endsWith("+b"));
    const quoted = "Keep the exported file names stable across every release of the tool please";
    const c = splitChanges(`d\n\nCHANGES:\n1. See [the docs](https://example.org/x) and @someone for details\n2. ${quoted} and more\n3. Renamed a to b\n`, quoted);
    assert.deepEqual(c.changes, ["See the docs and someone for details.", "Renamed a to b."]);
    assert.equal(operatorCommentText(["x"], r.changes), "Fixes included:\n1. Renamed a to b.\n2. Fixed the doc.");
  });

  test("a cancel whose batch removal fails leaves no hold the removal set", async () => {
    const w = await (await (await fresh()).pr(19)).review(19, { verdict: "take-fix" });
    await inCi(w, 19);
    await w.premerge(19, "clean");
    await settle(w);
    await w.db.run(w.db.k.insertInto("merge_batches").values({ id: 6, repo: "app", branch: "integration-app-2", state: "open", base_sha: "b", commit_sha: "t", pr_number: 77, created_at: T0, updated_at: T0 }));
    await w.db.run(w.db.k.insertInto("merge_batch_prs").values({ batch_id: 6, number: 19, head_oid: "sha19b", position: 1 }));
    const failing = async () => ({ code: 1, stdout: "", stderr: "boom" });
    await assert.rejects(cancelPreapproval(w.db, OPERATOR, "app", 19, failing));
    assert.equal((await w.db.all(w.db.k.selectFrom("merge_holds").select((eb) => eb.lit(1).as("one")).where("number", "=", 19))).length, 0);
    assert.equal((await preapprovalOf(w.db, "app", 19))?.state, "queued");
  });
});

describe("add to merge queue (a pre-approved merge without a fix-up)", () => {
  test("a take review at the current head, a clean pre-merge review and green CI write the Merge answer", async () => {
    const w = await (await fresh()).pr(11);
    await preapproveMerge(w.db, { repo: "app", number: 11, by: OPERATOR });
    const p = (await preapprovalOf(w.db, "app", 11))!;
    assert.equal(p.state, "review");
    assert.equal(p.head, "sha11");
    // A second add while the first runs is refused.
    await assert.rejects(async () => await preapproveMerge(w.db, { repo: "app", number: 11, by: OPERATOR }), /already has a pre-approved merge/);
    await w.review(11, { head: "sha11" });
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 11))?.state, "ci");
    await w.premerge(11, "clean");
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 11))?.state, "queued");
    assert.deepEqual((await answerOf(w, 11, "sha11")).map((r) => r.answer), ["merge"]);
  });

  test("an unsure take-fix review of a queued PR goes to the pipeline's fix-up, whose push is reviewed again, and an unsure take of it asks nothing", async () => {
    const w = await (await fresh()).pr(12);
    await preapproveMerge(w.db, { repo: "app", number: 12, by: OPERATOR });
    await w.review(12, { head: "sha12", verdict: "take-fix", sure: false });
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 12))?.state, "review");
    assert.ok((await kindsOf(w, 12)).includes("fixup:review"), (await kindsOf(w, 12)).join());
    assert.deepEqual(await answerOf(w, 12, "sha12"), []);
    await w.db.run(w.db.k.insertInto("fixups").values({ repo: "app", number: 12, from_head: "sha12", to_head: "sha12b", state: "pushed", attempt: 1, created_at: T0, source: "review" }));
    await w.synced(12, "sha12b");
    await settle(w);
    const p = (await preapprovalOf(w.db, "app", 12))!;
    assert.deepEqual([p.state, p.head], ["review", "sha12b"]);
    // An unsure take of the push waits for CI and the pre-merge review: the queue state needs a decision, but the live pre-approval (operator.hold) keeps the planner from asking.
    await w.review(12, { head: "sha12b", sure: false });
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 12))?.state, "ci");
    await w.verified(12);
    const plan = await w.prPlan(12);
    assert.equal(plan.state, "needs-decision");
    assert.ok(!(await kindsOf(w, 12)).includes("ask-merge:"), (await kindsOf(w, 12)).join());
    assert.deepEqual(await answerOf(w, 12, "sha12b"), []);
  });

  test("only bypass checks tells the review the PR was queued, with the issue it closes as the spec; queuing again with it turns it on", async () => {
    const w = await (await (await (await fresh()).pr(13)).pr(14)).issue(50, { title: "Undo restores the aligned layers", body: "the measured table" });
    await w.db.run(w.db.k.updateTable("items").set({ closing_issues: "[50]" }).where("number", "=", 13));
    await preapproveMerge(w.db, { repo: "app", number: 13, by: OPERATOR });
    assert.deepEqual(await queuedField(w.db, "app", 13), {});
    await preapproveMerge(w.db, { repo: "app", number: 13, by: OPERATOR, bypass: true });
    assert.equal((await w.db.all(w.db.k.selectFrom("preapprovals").select("id").where("number", "=", 13))).length, 1);
    const q = (await queuedField(w.db, "app", 13)).queued!;
    assert.deepEqual([q.how, q.by, q.spec.map((s) => [s.ref, s.body])], ["queued", OPERATOR, [["app#50", "the measured table"]]]);
    // Fast-tracked only: the spec comes from the issue the title names.
    await w.db.run(w.db.k.updateTable("items").set({ title: "Photomerge: one History step (#50)" }).where("number", "=", 14));
    await addFastTrack(w.db, OPERATOR, "app#14");
    assert.deepEqual(await queuedField(w.db, "app", 14), {});
    await setFastTrackBypass(w.db, OPERATOR, "app#14");
    const f = (await queuedField(w.db, "app", 14)).queued!;
    assert.deepEqual([f.how, f.spec.map((s) => s.ref)], ["fast-tracked", ["app#50"]]);
  });

  test("the add asks for no review of its own: running CI still holds the review of the PR's head", async () => {
    const w = await (await fresh()).pr(13);
    await w.db.run(w.db.k.updateTable("pr_checks").set({ overall: "pending" }).where("number", "=", 13));
    await preapproveMerge(w.db, { repo: "app", number: 13, by: OPERATOR });
    assert.equal((await (await reviewHolds(w.db))("app", 13, "sha13"))?.kind, "ci");
  });

  test("the label does not stop it: a plugin candidate or an unclassified PR is reviewed, and a label settled later does not flip it out", async () => {
    const w = await (await (await (await fresh()).pr(16, { label: "plugin candidate" })).pr(17)).pr(18, { label: "plugin candidate", flags: ["needs decision"] });
    await w.db.run(w.db.k.deleteFrom("classifications").where("number", "=", 17));
    for (const n of [16, 17]) {
      assert.equal((await w.prPlan(n)).state, "label-not-reviewed");
      await preapproveMerge(w.db, { repo: "app", number: n, by: OPERATOR });
      await settle(w);
      assert.equal((await preapprovalOf(w.db, "app", n))?.state, "review");
      assert.ok((await kindsOf(w, n)).includes("review:"), (await kindsOf(w, n)).join());
    }
    // An open scope question still refuses it, also behind a label that gets no review.
    await assert.rejects(async () => await preapproveMerge(w.db, { repo: "app", number: 18, by: OPERATOR }), /scope question is still open/);
    await w.db.run(w.db.k.insertInto("classifications").values({ repo: "app", number: 17, classifier: "jev", run_id: "r1", at: T0, type_label: "plugin candidate", flags: "[]", probs: '{"top":0.95}' }));
    await w.review(17, { head: "sha17" });
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 17))?.state, "ci");
    await w.premerge(17, "clean");
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 17))?.state, "queued");
  });

  test("the queue row says who added the PR and how; viewers see no login", async () => {
    const w = await (await (await fresh()).pr(14)).pr(15);
    await preapproveMerge(w.db, { repo: "app", number: 14, by: OPERATOR });
    const entry = (number: number) => ({ repo: "app", number, decisionId: null, reviewedAt: T0 }) as unknown as CachedEntry;
    const staff = await queueOrigins(w.db, true);
    assert.deepEqual({ ...await staff(entry(14)), at: null }, { how: "queued", by: OPERATOR, at: null });
    assert.equal((await (await queueOrigins(w.db, false))(entry(14))).by, null);
    assert.deepEqual(await staff(entry(15)), { how: "review", by: null, at: T0 });
  });

  test("the Merge tab lists a queued PR before its take review, and drops it once the review makes it a queue row", async () => {
    const w = await (await fresh()).pr(16);
    await preapproveMerge(w.db, { repo: "app", number: 16, by: OPERATOR });
    await refreshPlanCache(w.db);
    const req = { query: new URLSearchParams("tab=merge&repos=all"), user: { login: OPERATOR, role: "operator", canWrite: async () => true } } as unknown as Req;
    const before = await queuePage(w.db, req);
    assert.ok(!before.mergeRows.some((r) => r.number === 16));
    assert.deepEqual(before.pending?.map((p) => [p.number, p.step, p.added.how]), [[16, "review", "queued"]]);
    assert.equal(before.counts.merge, before.mergeRows.length + 1);
    await w.review(16, { verdict: "take" });
    await settle(w);
    await refreshPlanCache(w.db);
    const after = await queuePage(w.db, { ...req, query: new URLSearchParams("tab=merge&repos=all") } as Req);
    assert.ok(after.mergeRows.some((r) => r.number === 16));
    assert.ok(!after.pending?.some((p) => p.number === 16));
  });
});

describe("queue items: an issue", () => {
  test("is fast-tracked without lowering its weight; its one closing PR is queued, several are only listed", async () => {
    const w = await (await (await (await (await (await fresh()).issue(31)).pr(32)).issue(33)).pr(34)).pr(35);
    await w.db.run(w.db.k.updateTable("items").set({ closing_issues: "[31]" }).where("repo", "=", "app").where("number", "=", 32));
    await w.db.run(w.db.k.updateTable("items").set({ closing_issues: "[33]" }).where("repo", "=", "app").where("number", "in", [34, 35]));
    await addFastTrack(w.db, OPERATOR, "app#31", 9);
    const req = (item: string) => ({ query: new URLSearchParams(), json: { item, weight: 7 }, user: { login: OPERATOR, role: "operator", canWrite: async () => true } }) as unknown as Req;
    assert.match((await queueAdd(w.db, req("app#31"))).label, /Fast-tracked the issue; queued #32/);
    assert.equal((await preapprovalOf(w.db, "app", 32))?.state, "review");
    assert.deepEqual((await fastTrackList(w.db)).map((f) => [f.number, f.weight]), [[31, 9], [32, 7]]);
    assert.match((await queueAdd(w.db, req("app#33"))).label, /#34, #35 close it; queue one of them/);
    assert.equal(await preapprovalOf(w.db, "app", 34), null);
    assert.equal(await preapprovalOf(w.db, "app", 35), null);
  });

  test("the Merge tab lists it in the Queued group until a PR that closes it is listed", async () => {
    const w = await (await (await fresh()).issue(36)).pr(37);
    const req = (login: string, role: string) =>
      ({ query: new URLSearchParams("tab=merge&repos=all"), json: { item: "app#36" }, user: { login, role, canWrite: async () => true, canRead: async () => true } }) as unknown as Req;
    await queueAdd(w.db, req(OPERATOR, "operator"));
    await refreshPlanCache(w.db);
    const issueRow = async (login = OPERATOR, role = "operator") => (await queuePage(w.db, req(login, role))).pending?.find((p) => p.number === 36);
    const before = await issueRow();
    assert.deepEqual([before?.kind, before?.step, before?.added.how, before?.added.by], ["issue", "build", "fast", OPERATOR]);
    assert.equal((await issueRow("view", "viewer"))?.added.by, null);
    // A PR that closes it but is not queued: the issue stays and names it.
    await w.db.run(w.db.k.updateTable("items").set({ closing_issues: "[36]" }).where("repo", "=", "app").where("number", "=", 37));
    const open = await issueRow();
    assert.deepEqual([open?.step, open?.prs], ["pr", [37]]);
    // Once that PR is queued, its own row stands for the issue.
    await preapproveMerge(w.db, { repo: "app", number: 37, by: OPERATOR });
    const after = await queuePage(w.db, req(OPERATOR, "operator"));
    assert.ok(after.pending?.some((p) => p.number === 37));
    assert.ok(!after.pending?.some((p) => p.number === 36));
  });

  test("a closing PR the board shows in no group, such as a declined one, does not hide the issue", async () => {
    const w = await (await (await (await fresh()).issue(38)).pr(39)).review(39, { verdict: "take" });
    await w.db.run(w.db.k.updateTable("items").set({ closing_issues: "[38]" }).where("repo", "=", "app").where("number", "=", 39));
    await w.answer(39, "hold");
    const req = { query: new URLSearchParams("tab=merge&repos=all"), json: { item: "app#38" }, user: { login: OPERATOR, role: "operator", canWrite: async () => true, canRead: async () => true } } as unknown as Req;
    await addFastTrack(w.db, OPERATOR, "app#38");
    await refreshPlanCache(w.db);
    const page = await queuePage(w.db, req);
    assert.ok(page.mergeRows.some((r) => r.number === 39 && r.state === "declined"));
    assert.deepEqual(page.pending?.filter((p) => p.number === 38).map((p) => [p.step, p.prs]), [["pr", [39]]]);
  });
});

describe("queue items: who may add", () => {
  test("an operator; a maintainer only with maintainer writes on, the app identity and write access on the repo; never a viewer", async () => {
    const w = await (await (await (await fresh()).pr(51)).pr(52)).pr(53);
    await w.db.run(w.db.k.insertInto("access").values([{ login: "maint", role: "maintainer" }, { login: "view", role: "viewer" }]).onConflict((oc) => oc.doNothing()));
    const req = (n: number, login: string, role: string, write = true) =>
      ({ query: new URLSearchParams(), json: { item: `app#${n}` }, user: { login, role, canWrite: async () => write, canRead: async () => true } }) as unknown as Req;
    await assert.rejects(queueAdd(w.db, req(51, "maint", "maintainer")), (e: Error & { status?: number }) => e.status === 403);
    await w.db.run(w.db.k.insertInto("settings").values({ key: "maintainer_writes", value: "1" }).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
    await assert.rejects(queueAdd(w.db, req(51, "maint", "maintainer")), (e: Error & { status?: number }) => e.status === 403);
    await w.db.run(w.db.k.insertInto("settings").values({ key: "github_identity", value: "app" }).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
    await assert.rejects(queueAdd(w.db, req(51, "maint", "maintainer", false)), (e: Error & { status?: number }) => e.status === 403);
    await assert.rejects(queueAdd(w.db, req(51, "view", "viewer")), (e: Error & { status?: number }) => e.status === 403);
    assert.equal(await preapprovalOf(w.db, "app", 51), null);
    await queueAdd(w.db, req(51, "maint", "maintainer"));
    assert.equal((await preapprovalOf(w.db, "app", 51))?.state, "review");
    assert.equal((await preapprovalOf(w.db, "app", 51))?.by, "maint");
    // An operator needs write access on the repo too, as for answering (src/settlers.ts, settleRefusal).
    await assert.rejects(queueAdd(w.db, req(52, OPERATOR, "operator", false)), (e: Error & { status?: number }) => e.status === 403 && /no write access to storytold\/app/.test(e.message));
    assert.equal(await preapprovalOf(w.db, "app", 52), null);
    await queueAdd(w.db, req(52, OPERATOR, "operator"));
    assert.equal((await preapprovalOf(w.db, "app", 52))?.by, OPERATOR);
  });
});

describe("a maintainer's pre-approval after their dashboard session", () => {
  test("the pipeline reads the write permission again through the app: write keeps it, a failed read keeps it for an hour, read cancels it", async () => {
    const w = await (await (await fresh()).pr(61)).pr(62);
    await w.db.run(w.db.k.insertInto("access").values({ login: "maint", role: "maintainer" }).onConflict((oc) => oc.doNothing()));
    await w.db.run(w.db.k.insertInto("settings").values([{ key: "maintainer_writes", value: "1" }, { key: "github_identity", value: "app" }]).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
    const stale = new Date(Date.now() - 11 * 60_000).toISOString();
    const perm = async (permission: string, at: string) =>
      await w.db.run(w.db.k.insertInto("repo_permissions").values({ login: "maint", repo: "app", permission, checked_at: at })
        .onConflict((oc) => oc.columns(["login", "repo"]).doUpdateSet(excluded(["permission", "checked_at"]))));
    await perm("write", new Date().toISOString());
    await preapproveMerge(w.db, { repo: "app", number: 61, by: "maint" });
    // Stands in for appPermission, which writes what GitHub answered to repo_permissions.
    const answer = (permission: string | null) => async () => {
      if (permission === null) return { kind: "error" as const, why: "GitHub permission check failed: 502" };
      await perm(permission, new Date().toISOString());
      return { kind: "ok" as const, permission };
    };
    const pass = async (permission: string | null) => {
      await advancePreapprovals(w.db, () => {}, { permission: answer(permission) });
      await new Promise((r) => setImmediate(r));
      await advancePreapprovals(w.db, () => {}, { permission: answer(permission) });
    };
    await perm("write", stale);
    await pass("write");
    assert.equal((await preapprovalOf(w.db, "app", 61))?.state, "review");
    await perm("write", stale);
    await pass(null);
    assert.equal((await preapprovalOf(w.db, "app", 61))?.state, "review");
    await perm("write", stale);
    await pass("read");
    assert.equal((await preapprovalOf(w.db, "app", 61))?.state, "cancelled");
    // A write permission GitHub last confirmed over an hour ago no longer counts while the reads fail.
    await perm("write", new Date().toISOString());
    await preapproveMerge(w.db, { repo: "app", number: 62, by: "maint" });
    await perm("write", new Date(Date.now() - 61 * 60_000).toISOString());
    await pass(null);
    assert.equal((await preapprovalOf(w.db, "app", 62))?.state, "cancelled");
  });
});

describe("fast track weights", () => {
  test("heavier items go first; equal weights keep the order added", async () => {
    const w = await (await (await (await fresh()).pr(21)).pr(22)).pr(23);
    await addFastTrack(w.db, OPERATOR, "app#21");
    await addFastTrack(w.db, OPERATOR, "app#22", 9);
    await addFastTrack(w.db, OPERATOR, "app#23");
    assert.deepEqual((await fastTrackList(w.db)).map((f) => [f.number, f.weight]), [[22, 9], [21, 5], [23, 5]]);
    const s = await workScores(w.db, "app");
    assert.ok(s.get(22)! > s.get(21)! && s.get(21)! > s.get(23)!);
    await setFastTrackWeight(w.db, OPERATOR, "app#23", 10);
    assert.deepEqual((await fastTrackList(w.db)).map((f) => f.number), [23, 22, 21]);
    assert.ok((await fastScoreOf(w.db, "app", 23))! > (await fastScoreOf(w.db, "app", 22))!);
    await assert.rejects(async () => await setFastTrackWeight(w.db, OPERATOR, "app#21", 11), /from 1 to 10/);
  });
});
