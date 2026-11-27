// The advance pass of the maintainer workflow (src/workflow/advance.ts) with the merge leg (src/preapproval): blockers stop an
// approved item and keep its approval, a yes resumes it, and an approved review entry with minor findings is fixed, then merged.
// An implement issue's plan question comes back as its recommendation, and answers on the issue reach its implementation PR.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { computeChecks } from "../src/health-checks.ts";
import { Runner } from "../src/runner/runner.ts";
import { SCRATCH } from "./scratch.ts";
import { advancePreapprovals } from "../src/preapproval/index.ts";
import { parseOpusReply } from "../src/review/opus-parse.ts";
import { advanceWorkflows, type FailedCheck } from "../src/workflow/advance.ts";
import { runCommand } from "../src/workflow/apply.ts";
import { parse } from "../src/workflow/parse.ts";
import { liveWorkflow, workflowHistory } from "../src/workflow/store.ts";
import { legWait } from "../src/workflow/waits.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { SNAPSHOT_CACHE_MS } from "../src/data/runners/snapshot-cache.ts";
import { parseStatus, storeStatus } from "../src/remote/helpers.ts";
import type { Blocker } from "../src/workflow/types.ts";
import { mergeVerdicts } from "../src/merge/approval.ts";
import { T0, T1, untilQuiet, world, type World } from "./world-db.ts";
import { currentAttempt, writeStep } from "../src/implement/attempt.ts";
import { openQuestion } from "../src/implement/questions.ts";
import { recordSteps, startAttempt } from "../src/data/implement/index.ts";
import { applyStuckAnswer, markStuck } from "../src/implement/stuck.ts";
import { actor, approvedReview, asked, ASKS, fixup, implementationOpened, implementIssue, keep, labelOf, later, leg8, legState, MAINT, nextStep, ownPush, review, review8, say } from "./workflow-advance-world.ts";

test("each blocker stops an approved item and keeps its approval", async () => {
  const cases: [Blocker, (w: World) => Promise<unknown>][] = [
    ["major-finding", (w) => review(w, { head: "sha1", verdict: "hold" })],
    ["author-commits", async (w) => { await w.synced(1, "sha9"); await w.outOfScope(1, "sha9"); }],
    ["failed-twice", async (w) => { await fixup(w, { state: "failed" }); await fixup(w, { state: "refused" }); }],
    // A review job of the PR's approved lane that fails before it records anything, twice in a row.
    ["failed-twice", async (w) => {
      for (const id of [901, 902]) await w.db.run(w.db.k.insertInto("main.jobs").values({ id, step: "opus-review", params: JSON.stringify({ repo: "app", number: 1, lane: "approved", limit: 10 }), requested_by: "pipeline", requested_at: later(), state: "failed", started_at: later(), ended_at: later(), error: "reply could not be read", repo: "app" }));
    }],
    ["beyond-agreed", async (w) => {
      await review(w, { head: "sha1", verdict: "take-fix", fixes: [{ file: "src/lib.rs", change: "check the bound", title: "bound check" }], at: "2026-01-01T00:00:00Z" });
      await fixup(w, { state: "pushed", files: ["src/lib.rs", "src/other.rs"], patch: "+a\n-b" });
    }],
    ["outside-purpose", (w) => review(w, { head: "sha1", verdict: "take", outside: 60 })],
  ];
  for (const [blocker, evidence] of cases) {
    const w = await approvedReview();
    await evidence(w);
    await advanceWorkflows(w.db);
    const wf = (await liveWorkflow(w.db, "app", 1))!;
    assert.deepEqual([wf.state, wf.blocker, wf.approvedBy], ["blocked", blocker, MAINT], blocker);
    assert.ok(wf.rec?.text, `${blocker}: one recommendation`);
    assert.notEqual(await legState(w), "review", `${blocker}: the merge leg stops`);
    w.close();
  }
});

test("however much our own pushes change, they never stop an approved item", async () => {
  for (const extra of ["cifix", "merge"] as const) {
    const w = await approvedReview();
    const made = (action: string, from_oid: string, to_oid: string, lines: number, at: string, landed_at: string | null = at) =>
      w.db.run(w.db.k.insertInto("main.own_pushes").values({ repo: "app", number: 1, action, from_oid, to_oid, lines, at, landed_at }));
    const push = async (action: string, from: string, to: string, lines: number) => {
      await made(action, from, to, lines, later());
      await w.synced(1, to);
      await advanceWorkflows(w.db);
    };
    // Before the approval: what the person saw.
    await made("fixup-push", "sha0", "sha1", 900, "2020-01-01T00:00:00Z");
    // Recorded, and never landed.
    await made("fixup-push", "sha1", "lost", 900, later(), null);
    await push("fixup-push", "sha1", "sha1b", 250);
    assert.equal((await liveWorkflow(w.db, "app", 1))!.state, "running");
    await (extra === "cifix" ? push("cifix-push", "sha1b", "sha1c", 250) : push("conflict-push", "sha1b", "sha1c", 0));
    const wf = (await liveWorkflow(w.db, "app", 1))!;
    assert.deepEqual([wf.state, wf.blocker], ["running", null], extra);
    w.close();
  }
});

test("an answer to merge after a blocker resumes the merge leg and does not stop again on what the person saw", async () => {
  const w = await approvedReview();
  const db = w.db;
  await new Promise((r) => setTimeout(r, 10));
  await review(w, { head: "sha1", verdict: "hold", at: new Date().toISOString() });
  await advanceWorkflows(db);
  assert.equal((await liveWorkflow(db, "app", 1))!.state, "blocked");

  // A hold with no recommendation of its own offers a new review, never a merge it did not recommend.
  assert.match((await liveWorkflow(db, "app", 1))!.rec!.text, /hold it/);
  // The answer comes after the review: what it found is what the person chose to go on with.
  await new Promise((r) => setTimeout(r, 10));
  const r = await runCommand(db, actor, "dashboard", { parsed: parse("merge"), items: [{ repo: "app", number: 1 }] });
  assert.equal(r.items[0]!.outcome, "run", r.lines.join("\n"));
  await advanceWorkflows(db);
  const wf = (await liveWorkflow(db, "app", 1))!;
  assert.deepEqual([wf.state, wf.blocker, wf.approvedBy], ["running", null, MAINT]);
  const leg = (await db.get(db.k.selectFrom("main.preapprovals").select(["state", "workflow_id"]).orderBy("id", "desc").limit(1)))!;
  assert.deepEqual([leg.state, leg.workflow_id], ["review", wf.id], "a new merge leg works for the workflow");
  await advancePreapprovals(db);
  assert.equal(await legState(w), "ci", "the hold the person answered past counts as a take");

  // It goes on like any approved merge: the pre-merge review, the hand-over, the merge.
  assert.ok((await w.prPlan(1)).actions.some((a) => a.kind === "premerge"), "the pre-merge review runs");
  await (await w.premerge(1, "clean")).verified(1);
  await advancePreapprovals(db);
  assert.equal(await legState(w), "queued");
  assert.ok((await w.prPlan(1)).actions.some((a) => a.kind === "merge"), "the merge queue merges it");
});

test("a failed verification or a lasting refusal after the hand-over asks once, and a yes goes on past it", async () => {
  for (const what of ["verification", "refusal"] as const) {
    const w = await approvedReview();
    const db = w.db;
    const pass = async () => { await advanceWorkflows(db); await untilQuiet(db, [() => advancePreapprovals(db)], 3); await advanceWorkflows(db); };
    const plansMerge = async () => (await w.prPlan(1)).actions.some((a) => a.kind === "merge");
    await review(w, { head: "sha1", verdict: "take", at: new Date().toISOString() });
    await w.premerge(1, "clean");
    if (what === "refusal") await w.verified(1);
    await pass();
    assert.equal(await legState(w), "queued");
    await new Promise((r) => setTimeout(r, 5));
    const at = new Date().toISOString();
    if (what === "verification") {
      await w.verified(1, "failed");
      await db.run(db.k.updateTable("main.verifications").set({ finished_at: at }));
    } else {
      await db.run(db.k.insertInto("main.merges").values({ repo: "app", number: 1, head_oid: "sha1", run_id: "r", at, path: "operator", method: "squash", outcome: "refused", reason: "safe-merge: a workflow file may not be changed", ci: "success", mergeable: "MERGEABLE" }));
    }
    await pass();
    const wf = (await liveWorkflow(db, "app", 1))!;
    assert.deepEqual([wf.state, wf.approvedBy], ["blocked", MAINT], what);
    assert.ok(wf.rec?.text, what);
    assert.equal(await plansMerge(), false, what);

    await new Promise((r) => setTimeout(r, 5));
    const r = await runCommand(db, actor, "dashboard", { parsed: parse("yes"), items: [{ repo: "app", number: 1 }] });
    assert.equal(r.items[0]!.outcome, "run", r.lines.join("\n"));
    await pass();
    await pass();
    assert.equal((await liveWorkflow(db, "app", 1))!.state, "running", what);
    assert.equal(await legState(w), "queued", what);
    assert.equal(await plansMerge(), true, `${what}: the merge is tried`);
    w.close();
  }
});

test("an answer that runs nothing leaves the PR alone until someone starts it; an issue's workflow that ended as its PR merged leaves its other PRs as they were", async () => {
  const w = keep(await (await (await world()).repo()).acting());
  const db = w.db;
  for (const n of [1, 2]) await (await (await (await w.pr(n)).review(n)).verified(n)).premerge(n, "clean");
  const merges = async (n: number): Promise<boolean> => (await w.prPlan(n)).actions.some((a) => a.kind === "merge") && (await mergeVerdicts(db, "app", [{ number: n, head: `sha${n}` }])).get(n)!.ok;
  assert.deepEqual([await merges(1), await merges(2)], [true, true], "the merge rule takes both");
  const ended = (number: number, kind: "pr" | "issue", entry: "review" | "implement") =>
    db.run(db.k.insertInto("main.item_workflows").values({ repo: "app", number, kind, entry, state: "done", started_by: MAINT, started_at: T0, started_via: "dashboard", plan: "[]", updated_at: T0 }));
  await ended(1, "pr", "review");
  assert.equal((await w.prPlan(1)).state, "not-started");
  assert.equal((await mergeVerdicts(db, "app", [{ number: 1, head: "sha1" }])).get(1)!.ok, false);

  // Issue 9's workflow: while its PR 2 is open an answer ended it, and once another PR of it merged the merge did.
  await w.issue(9);
  await ended(9, "issue", "implement");
  const attempt = (number: number, state: string) =>
    db.run(db.k.insertInto("main.implementations").values({ repo: "app", number: 9, queued_by: MAINT, state, attempt: 1, text_hash: `x${number}`, pr_number: number, created_at: T0, updated_at: T0 }));
  await attempt(2, "cancelled");
  assert.equal(await merges(2), false);
  await w.pr(3);
  await attempt(3, "merged");
  await db.run(db.k.updateTable("main.items").set({ state: "MERGED", closed_at: T1 }).where("number", "=", 3));
  assert.equal(await merges(2), true);
});

test("an approved review entry with minor findings is fixed, reviewed again and handed to the merge queue as the approver", async () => {
  const w = await approvedReview();
  const db = w.db;
  // Reviews in the order a real run makes them: this one, the next at the pushed head, then the hand-over's Merge answer.
  await review(w, { head: "sha1", verdict: "take-fix", sure: false, at: new Date().toISOString(), fixes: [{ file: "src/lib.rs", change: "rename a to b", title: "clearer name", major: false }] });
  await advanceWorkflows(db);
  assert.equal((await liveWorkflow(db, "app", 1))!.state, "running", "a minor finding of an unsure review is no blocker for an approved item");
  assert.ok((await w.prPlan(1)).actions.some((a) => a.kind === "fixup" && a.params?.source === "review"), "the review's fix-up runs");

  // The fix-up pushes; our own push moves the head the workflow accepted.
  await fixup(w, { state: "pushed", files: ["src/lib.rs"], patch: "+b\n-a", to: "sha2" });
  await db.run(db.k.insertInto("main.push_outcomes").values({ at: later(), stage: "fixup", action: "fixup-push", repo: "app", number: 1, from_oid: "sha1", to_oid: "sha2", before_res: "green" }));
  await w.synced(1, "sha2");
  await advanceWorkflows(db);
  assert.deepEqual([(await liveWorkflow(db, "app", 1))!.state, (await liveWorkflow(db, "app", 1))!.baseHead], ["running", "sha2"]);
  await advancePreapprovals(db);
  assert.equal(await legState(w), "review");

  await review(w, { head: "sha2", verdict: "take", at: new Date().toISOString() });
  await w.premerge(1, "clean");
  await advanceWorkflows(db);
  await untilQuiet(db, [() => advancePreapprovals(db)], 3);
  assert.equal(await legState(w), "queued");
  const leg = (await db.get(db.k.selectFrom("main.preapprovals").select(["by", "workflow_id"]).where("number", "=", 1).orderBy("id", "desc").limit(1)))!;
  assert.equal(leg.by, MAINT, "the merge is made as the approver");
  assert.equal((await liveWorkflow(db, "app", 1))!.approvedBy, MAINT);
  await w.verified(1);
  assert.ok((await w.prPlan(1)).actions.some((a) => a.kind === "merge"), "the merge queue merges it once verified");

  await db.run(db.k.updateTable("main.items").set({ state: "MERGED" }).where("number", "=", 1));
  await advanceWorkflows(db);
  assert.equal(await liveWorkflow(db, "app", 1), null);
});

test("a queued merge leg whose workflow ended with the merge is recorded merged, not cancelled", async () => {
  const w = await approvedReview();
  const db = w.db;
  await review(w, { head: "sha1", verdict: "take" });
  await w.premerge(1, "clean");
  await advanceWorkflows(db);
  await untilQuiet(db, [() => advancePreapprovals(db)], 3);
  assert.equal(await legState(w), "queued");
  // The merge lands and the workflow ends on it before the leg's pass sees the merge.
  await db.run(db.k.updateTable("main.items").set({ state: "MERGED" }).where("number", "=", 1));
  await advanceWorkflows(db);
  assert.equal(await liveWorkflow(db, "app", 1), null);
  await advancePreapprovals(db);
  assert.equal(await legState(w), "merged");
});

test("an approved merge goes on past an unsure pre-merge review with no defect; a defect stops it as a major finding", async () => {
  for (const kind of ["clean", "defect"] as const) {
    const w = await approvedReview();
    const db = w.db;
    await review(w, { head: "sha1", verdict: "take", at: new Date().toISOString() });
    if (kind === "clean") {
      // Waiting in ci for a pre-merge check no Task Runner can take: the state line says so.
      for (let i = 0; i < 2; i++) await advancePreapprovals(db);
      assert.equal(await legState(w), "ci");
      assert.equal(await legWait(db, (await liveWorkflow(db, "app", 1))!), "Waiting for the pre-merge check: no Task Runner can take it");
      // The approver's runner takes it: the state line names it while it cannot claim, and goes back to the steps once it can.
      const token = (await createToken(db, MAINT, "runner", { kind: "runner" })).row.id;
      // Read past the window the runner snapshot is kept for, so the new credential shows.
      const line = async () => await legWait(db, (await liveWorkflow(db, "app", 1))!, Date.now() + 2 * SNAPSHOT_CACHE_MS);
      assert.equal(await line(), "Waiting for mira's Task Runner (offline)");
      const report = (readiness: string) => storeStatus(db, token, MAINT, parseStatus({ slots: 1, busy: 0, readiness, harness: "claude", models: { top: "opus", small: "haiku" }, reserve: { fiveHour: 0, weekly: 0 } }));
      await report("quota-held");
      assert.equal(await line(), "Waiting for mira's Task Runner (usage limit)");
      await report("ready");
      assert.equal(await line(), null);
    }
    await w.premerge(1, kind, false);
    if (kind === "defect") await w.premergeRoundsSpent(1);
    await db.run(db.k.updateTable("main.premerge_reviews").set({ unsure: 1 }).where("number", "=", 1));
    await untilQuiet(db, [() => advanceWorkflows(db), () => advancePreapprovals(db)], 3);
    await advanceWorkflows(db);
    const wf = (await liveWorkflow(db, "app", 1))!;
    if (kind === "clean") assert.deepEqual([await legState(w), wf.state], ["queued", "running"], "unsure with no finding: the merge queue has it");
    else assert.deepEqual([await legState(w), wf.state, wf.blocker], ["failed", "blocked", "major-finding"]);
    w.close();
  }
});

test("a started PR that is not approved comes back with the review's recommendation and its numbered plan", async () => {
  const w = await approvedReview();
  const db = w.db;
  await w.pr(2, { label: "feature" });
  assert.equal((await runCommand(db, actor, "dashboard", { parsed: parse("review"), items: [{ repo: "app", number: 2 }] })).items[0]!.outcome, "run");
  await db.run(db.k.insertInto("main.opus_reviews").values({
    repo: "app", number: 2, head_oid: "sha2", run_id: "rv", at: later(), model: "m", mode: "full", verdict: "take-fix", sure: 1, reason: "r",
    fixes: JSON.stringify([{ file: "src/a.rs", change: "x", title: "guard empty input" }, { file: "src/b.rs", change: "y", title: "typo" }]),
    workflow: JSON.stringify({ outside_purpose: null, recommendation: { text: "Fix 1, then merge.", fix: [1], merge: true, close: false } }),
  }));
  await advanceWorkflows(db);
  const wf = (await liveWorkflow(db, "app", 2))!;
  assert.deepEqual([wf.state, wf.rec?.text, wf.rec?.parts.fix, wf.rec?.merges, wf.plan.map((p) => p.title)], ["recommending", "Fix 1, then merge.", [1], true, ["guard empty input", "typo"]]);
});

test("a recommendation's fix numbers follow the stored fixes, not the model's list", () => {
  const reply = JSON.stringify({
    ref: "app#1", verdict: "take-fix", sure: true, reason: "two fixes", risks: [],
    fixes: [{ file: "src/a.rs", change: "guard a" }, { file: "src/b.rs", change: "guard b" }],
    claims: [{ claim: "handles empty input", status: "contradicted", evidence: "src/c.rs:3 indexes element 0", impact: "code-wrong", fix: { file: "src/c.rs", change: "check the length" } }],
    recommendation: { text: "Fix 2, then merge.", fix: [2], merge: true, close: false },
  });
  const r = parseOpusReply(reply, "app#1", true, new Set(), false, [], "Handles empty input.", ["src/a.rs", "src/b.rs", "src/c.rs"])!;
  assert.deepEqual([r.fixes.map((f) => f.file), r.workflow?.recommendation?.fix], [["src/c.rs", "src/a.rs", "src/b.rs"], [3]], "the claim's fix goes first, so the model's 2 is the stored 3");
});

test("an implement question comes back as one recommendation, and a yes answers it so the implementation plans again", async () => {
  const w = await asked(ASKS);
  const wf = (await liveWorkflow(w.db, "app", 7))!;
  assert.deepEqual([wf.state, wf.rec?.text], ["recommending", ASKS.workflow!.recommendation]);
  assert.deepEqual(wf.plan.map((p) => [p.n, p.title]), [[1, "Globally"], [2, "Per document"]]);
  assert.ok("wait" in (await nextStep(w))!, "the implementation waits for the answer");

  const r = await say(w, "yes");
  assert.equal(r.outcome, "run", r.line);
  assert.match(r.line, /Per document/);
  assert.equal(await labelOf(w), "Per document");
  assert.equal(openQuestion((await currentAttempt(w.db, "app", 7))!.rounds).answer?.by, MAINT);
  assert.deepEqual(await nextStep(w), { bucket: "plan" });
  await advanceWorkflows(w.db);
  const on = (await liveWorkflow(w.db, "app", 7))!;
  assert.deepEqual([on.state, on.rec, on.plan], ["running", null, []]);
});

test("an option's number or its words answer an implement question; a reply that names none or several runs nothing", async () => {
  for (const [text, label] of [["1", "Globally"], ["fix 1", "Globally"], ["go with per document", "Per document"], ["not per document", undefined], ["3", undefined], ["1 or 2", undefined]] as const) {
    const w = await asked(ASKS);
    const r = await say(w, text);
    assert.equal(r.outcome, label ? "run" : "ambiguous", `${text}: ${r.line}`);
    assert.equal(await labelOf(w), label, text);
    w.close();
  }
});

test("a question set aside elsewhere takes its recommendation with it, and a late yes answers nothing", async () => {
  const w = await asked(ASKS);
  const at = (await currentAttempt(w.db, "app", 7))!;
  // A comment on the issue answered it: the implementation plans again.
  await writeStep(w.db, at.impl, { to: "planning" });
  const r = await say(w, "yes");
  assert.equal(r.outcome, "refused", r.line);
  await advanceWorkflows(w.db);
  const wf = (await liveWorkflow(w.db, "app", 7))!;
  assert.deepEqual([wf.state, wf.rec], ["running", null]);
});

test("a stuck implementation comes back with Try again, and a yes starts it again", async () => {
  for (const approved of [false, true]) {
    const w = await implementIssue();
    const db = w.db;
    if (approved) await say(w, "merge");
    await markStuck(db, (await currentAttempt(db, "app", 7))!.impl, "session-failed", null);
    await advanceWorkflows(db);
    const wf = (await liveWorkflow(db, "app", 7))!;
    assert.deepEqual([wf.state, wf.blocker, wf.rec?.merges], approved ? ["blocked", "failed-twice", true] : ["recommending", null, false]);
    assert.ok("wait" in (await nextStep(w))!);

    const r = await say(w, "yes");
    assert.equal(r.outcome, "run", r.line);
    assert.deepEqual(await nextStep(w), { bucket: "build" });
    assert.match((await applyStuckAnswer(db, (await currentAttempt(db, "app", 7))!))!.did, /attempt 2 started/);
    await advanceWorkflows(db);
    const on = (await liveWorkflow(db, "app", 7))!;
    assert.deepEqual([on.state, on.blocker, on.approvedBy], ["running", null, approved ? MAINT : null]);
    w.close();
  }
});

test("an answer on an implement issue queues a fix-up of the named part on its implementation PR", async () => {
  const w = await implementIssue();
  const db = w.db;
  await w.pr(8, { author: "craft-bot" });
  const im = (await currentAttempt(db, "app", 7))!.impl;
  await writeStep(db, im, { to: "pr-opened", patch: { branch: "fix-8", prNumber: 8, prUrl: "https://example.invalid/8" } });
  await db.run(db.k.insertInto("main.opus_reviews").values({
    repo: "app", number: 8, head_oid: "sha8", run_id: "rv", at: later(), model: "m", mode: "full", verdict: "take-fix", sure: 1, reason: "r",
    fixes: JSON.stringify([{ file: "src/export.rs", change: "store the folder on the document", title: "folder per document" }]),
  }));
  await advanceWorkflows(db);
  assert.deepEqual((await liveWorkflow(db, "app", 7))!.plan.map((p) => p.title), ["folder per document"]);

  const r = await runCommand(db, actor, "dashboard", { parsed: parse("fix 1"), items: [{ repo: "app", number: 7 }] });
  assert.equal(r.items[0]!.outcome, "run", r.lines.join("\n"));
  const fx = await db.all(db.k.selectFrom("main.operator_fixups").select(["number", "state", "instructions"]).where("repo", "=", "app"));
  assert.equal(fx.length, 1);
  assert.equal(fx[0]!.number, 8);
  assert.match(fx[0]!.instructions ?? "", /folder per document/);
});

test("an approved implementation that changed files its plan does not name comes back before it merges, once", async () => {
  const w = await implementationOpened(["src/a.rs", "src/zzz.rs", "Cargo.lock"], true);
  await advanceWorkflows(w.db);
  const wf = (await liveWorkflow(w.db, "app", 7))!;
  assert.deepEqual([wf.state, wf.blocker, wf.approvedBy, wf.blockerParams?.files], ["blocked", "beyond-agreed", MAINT, ["src/zzz.rs"]]);
  assert.match(wf.rec!.text, /src\/zzz\.rs/);
  assert.equal(await leg8(w), undefined, "no merge leg starts");
  const r = await say(w, "yes");
  assert.equal(r.outcome, "run", r.line);
  await advanceWorkflows(w.db);
  assert.deepEqual([(await liveWorkflow(w.db, "app", 7))!.state, await leg8(w)], ["running", "review"]);
});

test("an implementation inside its plan merges without asking; one beyond it names the files in the end recommendation", async () => {
  const inside = await implementationOpened(["src/a.rs"], true);
  await advanceWorkflows(inside.db);
  assert.deepEqual([(await liveWorkflow(inside.db, "app", 7))!.state, await leg8(inside)], ["running", "review"]);
  inside.close();
  const w = await implementationOpened(["src/a.rs", "src/zzz.rs"], false);
  await review8(w, "take");
  await w.verified(8);
  await advanceWorkflows(w.db);
  const wf = (await liveWorkflow(w.db, "app", 7))!;
  assert.equal(wf.state, "recommending");
  assert.match(wf.rec!.text, /src\/zzz\.rs/);
});

test("the other blockers stop an approved implementation too", async () => {
  const cases: [Blocker, (w: World) => Promise<unknown>][] = [
    ["author-commits", (w) => w.synced(8, "theirs")],
    ["major-finding", (w) => review8(w, "hold")],
    ["outside-purpose", (w) => review8(w, "take", { outside_purpose: { lines: 60, note: "n" }, recommendation: null })],
    ["failed-twice", async (w) => { for (const state of ["failed", "rejected"]) await w.db.run(w.db.k.insertInto("main.ci_fixes").values({ repo: "app", number: 8, head: "sha8", kind: "patch", state, attempt: state === "failed" ? 1 : 2, created_at: later() })); }],
  ];
  for (const [blocker, evidence] of cases) {
    const w = await implementationOpened(["src/a.rs"], true);
    await advanceWorkflows(w.db);
    assert.equal(await leg8(w), "review");
    await evidence(w);
    await advanceWorkflows(w.db);
    const wf = (await liveWorkflow(w.db, "app", 7))!;
    assert.deepEqual([wf.state, wf.blocker, wf.approvedBy], ["blocked", blocker, MAINT], blocker);
    assert.equal(await leg8(w), "cancelled", blocker);
    w.close();
  }
});

test("an implementation's question is for the head it showed: our push leaves it, someone else's refuses the answer and is asked about", async () => {
  const w = await implementationOpened(["src/a.rs"], true);
  await advanceWorkflows(w.db);
  await review8(w, "hold");
  await advanceWorkflows(w.db);
  const asked = (await liveWorkflow(w.db, "app", 7))!;
  assert.deepEqual([asked.blocker, asked.recHead], ["major-finding", "sha8"]);
  await ownPush(w, "sha8", "ours8", 8);
  await advanceWorkflows(w.db);
  assert.equal((await liveWorkflow(w.db, "app", 7))!.recAt, asked.recAt);

  await w.synced(8, "theirs");
  assert.equal((await say(w, "yes")).outcome, "refused");
  await advanceWorkflows(w.db);
  const again = (await liveWorkflow(w.db, "app", 7))!;
  assert.deepEqual([again.state, again.blocker, again.recHead], ["blocked", "author-commits", "theirs"]);
  assert.match(again.rec!.text, /author pushed/);

  await ownPush(w, "theirs", "ours9", 8);
  const o = await say(w, "yes");
  assert.equal(o.outcome, "run", o.line);
});

test("a person's stop, approval or drop during the pass wins over what the pass writes", async () => {
  for (const text of ["stop", "merge", "drop 1", "stop, then review"]) {
    const w = await approvedReview();
    const db = w.db;
    await w.pr(2, { label: "feature" });
    const say2 = async (t: string) => { const o = (await runCommand(db, actor, "dashboard", { parsed: parse(t), items: [{ repo: "app", number: 2 }] })).items[0]!; assert.equal(o.outcome, "run", o.line); };
    await say2("review");
    await db.run(db.k.insertInto("main.opus_reviews").values({ repo: "app", number: 2, head_oid: "sha2", run_id: "rv", at: later(), model: "m", mode: "full", verdict: "take-fix", sure: 1, reason: "r", fixes: JSON.stringify([{ file: "a", change: "x", title: "one" }]) }));
    await db.run(db.k.updateTable("main.item_workflows").set({ plan: JSON.stringify([{ n: 1, title: "one", source: "review", state: "planned" }]) }).where("number", "=", 2));
    // Another process handles the command between the pass's reads and its write.
    const write = db.write;
    db.write = (async (f: () => Promise<unknown>, o?: never) => {
      db.write = write;
      for (const t of text.split(", then ")) await say2(t);
      return await write.call(db, f, o);
    }) as typeof write;
    await advanceWorkflows(db);
    const wf = (await workflowHistory(db, "app", 2)).map((x) => [x.state, x.approvedBy, x.rec]);
    const want = { stop: [["stopped", null, null]], merge: [["running", MAINT, null]], "drop 1": [["running", null, null]], "stop, then review": [["stopped", null, null], ["running", null, null]] }[text];
    assert.deepEqual(wf, want, text);
    if (text === "drop 1") assert.equal((await liveWorkflow(db, "app", 2))!.plan[0]!.state, "dropped");
    w.close();
  }
});

test("one workflow's change that cannot be stored loses no other's, and the pass is told to run again", async () => {
  const w = await approvedReview();
  const db = w.db;
  for (const number of [2, 3]) {
    await w.pr(number, { label: "feature" });
    await runCommand(db, actor, "dashboard", { parsed: parse("review"), items: [{ repo: "app", number }] });
    await db.run(db.k.insertInto("main.opus_reviews").values({ repo: "app", number, head_oid: `sha${number}`, run_id: "rv", at: later(), model: "m", mode: "full", verdict: "hold", sure: 1, reason: "r" }));
  }
  const write = db.write;
  // The joint write fails, then the first workflow's own.
  let failures = 2;
  let woken = 0;
  const pass = async () => {
    db.write = (async (f: () => Promise<unknown>, o?: never) => {
      const joint = /moveWorkflows/.test(String(f));
      if (joint && failures > 0) { failures--; throw new Error("not stored"); }
      return await write.call(db, f, o);
    }) as typeof write;
    woken = 0;
    try { await advanceWorkflows(db, () => {}, () => { woken++; }); } finally { db.write = write; }
    return (await Promise.all([2, 3].map((n) => liveWorkflow(db, "app", n)))).map((x) => x!.state).sort();
  };
  assert.deepEqual(await pass(), ["recommending", "running"]);
  assert.ok(woken > 0);
  assert.deepEqual(await pass(), ["recommending", "recommending"]);
  assert.equal(woken, 0);
});

test("a workflow whose change cannot be stored keeps its merge leg where it is, shows on its item and in the health check after three failures and is not tried on every tick; the others go on", async () => {
  const w = await approvedReview();
  const db = w.db;
  await w.pr(2, { label: "feature" });
  await runCommand(db, actor, "dashboard", { parsed: parse("review and merge"), items: [{ repo: "app", number: 2 }] });
  const lines: string[] = [];
  const runner = new Runner({ db, logs: mkdtempSync(join(SCRATCH, "workflow-runner-")), log: (l) => lines.push(l), detect: async () => ({ proposals: [], logs: [] }) });
  const legs = async () => (await db.all(db.k.selectFrom("main.preapprovals").select(["number", "state"]).orderBy("number"))).map((l) => `${l.number} ${l.state}`);
  const row = async () => (await liveWorkflow(db, "app", 1))!.updatedAt;
  const checks = async () => (await computeChecks(db)).filter((c) => c.group === "workflows");
  for (let i = 0; i < 2; i++) await runner.tick();
  assert.deepEqual(await legs(), ["1 review", "2 review"]);
  for (const number of [1, 2]) await db.run(db.k.insertInto("main.opus_reviews").values({ repo: "app", number, head_oid: `sha${number}`, run_id: "rv", at: later(), model: "m", mode: "full", verdict: "take", sure: 1, reason: "r",
    fixes: JSON.stringify([{ title: "A typo", file: "src/a.rs", change: "fix it", severity: "minor" }]) }));
  const write = db.write;
  const was = await row();
  db.write = (async (f: () => Promise<unknown>, o?: never) => await write.call(db, async () => {
    const r = await f();
    if (await row() !== was) throw new Error("bad row");
    return r;
  }, o)) as typeof write;
  const tries = () => lines.filter((l) => l === "workflow app#1: bad row").length;
  for (let i = 0; i < 3; i++) await runner.tick();
  assert.deepEqual(await legs(), ["1 review", "2 ci"], lines.join("\n"));
  assert.deepEqual((await checks()).map((c) => c.state), ["ok"], "two failures in a row do not show yet");
  // The backoff has passed, and the pass runs again on new input: the third failure in a row shows.
  for (const f of (runner as unknown as { failedWorkflows: Map<number, FailedCheck> }).failedWorkflows.values()) f.until = 0;
  await review(w, { head: "sha-old", verdict: "take", at: "2026-01-01T00:00:00Z" });
  await runner.tick();
  const [bad, ...others] = await checks();
  assert.deepEqual([bad!.state, bad!.repo, others.length], ["warn", "app", 0]);
  assert.match(bad!.text, /app#1.*: bad row/);
  assert.match((await legWait(db, (await liveWorkflow(db, "app", 1))!))!, /failed to check/);
  const before = tries();
  // The inputs of the pass change on every tick.
  for (let i = 0; i < 4; i++) { await review(w, { head: `sha-old${i}`, verdict: "take", at: "2026-01-01T00:00:00Z" }); await runner.tick(); }
  assert.equal(tries(), before);
  assert.deepEqual(await legs(), ["1 review", "2 ci"]);
  // The write works again: a person's command on the item does not wait for the backoff.
  db.write = write;
  await runCommand(db, actor, "dashboard", { parsed: parse("urgent"), items: [{ repo: "app", number: 1 }] });
  for (let i = 0; i < 3; i++) await runner.tick();
  assert.deepEqual(await legs(), ["1 ci", "2 ci"], lines.join("\n"));
  assert.deepEqual((await checks()).map((c) => c.state), ["ok"]);
  assert.doesNotMatch((await legWait(db, (await liveWorkflow(db, "app", 1))!)) ?? "", /failed to check/);
  await runner.stop();
  await db.close();
});

test("the third attempt on an issue text offers no Try again, whatever became of the first two", async () => {
  const w = await implementIssue();
  const db = w.db;
  for (const end of ["cancelled", "closed"] as const) {
    const im = (await currentAttempt(db, "app", 7))!.impl;
    await recordSteps(db, [{ id: im.id, to: end }]);
    await startAttempt(db, { repo: "app", number: 7, queuedBy: MAINT, textHash: im.textHash });
  }
  await markStuck(db, (await currentAttempt(db, "app", 7))!.impl, "session-failed", null);
  await advanceWorkflows(db);
  const wf = (await liveWorkflow(db, "app", 7))!;
  assert.deepEqual([wf.state, wf.rec?.answer], ["recommending", undefined]);
});
