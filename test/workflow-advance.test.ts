// The advance pass of the maintainer workflow (src/workflow/advance.ts) with the merge leg (src/preapproval): blockers stop an
// approved item and keep its approval, a yes resumes it, and an approved review entry with minor findings is fixed, then merged.
// An implement issue's plan question comes back as its recommendation, and answers on the issue reach its implementation PR.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { advancePreapprovals } from "../src/preapproval/index.ts";
import { parseOpusReply } from "../src/review/opus-parse.ts";
import { mergeDecisionId } from "../src/core/rules.ts";
import { advanceWorkflows } from "../src/workflow/advance.ts";
import { runCommand, type Actor } from "../src/workflow/apply.ts";
import { parse } from "../src/workflow/parse.ts";
import { liveWorkflow } from "../src/workflow/store.ts";
import { legWait } from "../src/workflow/waits.ts";
import { setInferenceMode } from "../src/remote/mode.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { parseStatus, storeStatus } from "../src/remote/helpers.ts";
import type { Blocker } from "../src/workflow/types.ts";
import { world, type World } from "./world-db.ts";
import { setFeature } from "../src/build/features.ts";
import { textHash } from "../src/core/open-prs.ts";
import { implementStep } from "../src/core/decide-item.ts";
import { loadItemFact } from "../src/core/issue-facts.ts";
import { getDecision, optionsOf } from "../src/decisions.ts";
import { recordPlan } from "../src/implement/plan.ts";
import { currentImplementation, setImplementationState, startImplementation } from "../src/implement/store.ts";
import type { PlanReply } from "../src/implement/types.ts";

let current: World | undefined;
afterEach(() => current?.close());

const MAINT = "mira";
const actor: Actor = { login: MAINT, canWrite: async () => true };
/** A time after the command that started the item: what the pipeline records after it. */
const later = (): string => new Date(Date.now() + 5_000).toISOString();

/** The repo "app" on the maintainer workflow, the app identity, a maintainer with write access, and PR 1 started at Review with the merge approved. */
async function approvedReview(): Promise<World> {
  const w = current = await (await world()).repo();
  const db = w.db;
  await db.run(db.k.updateTable("main.tracked_repos").set({ workflow: "new" }).where("name", "=", "app"));
  await db.run(db.k.insertInto("main.settings").values({ key: "github_identity", value: "app" }).onConflict((oc) => oc.column("key").doUpdateSet({ value: "app" })));
  await db.run(db.k.insertInto("main.access").values({ login: MAINT, role: "maintainer" }));
  await db.run(db.k.insertInto("main.repo_permissions").values({ login: MAINT, repo: "app", permission: "write", checked_at: new Date().toISOString() }));
  await w.pr(1, { label: "feature" });
  const r = await runCommand(db, actor, "dashboard", { parsed: parse("review and merge"), items: [{ repo: "app", number: 1 }] });
  assert.equal(r.items[0]!.outcome, "run", r.lines.join("\n"));
  return w;
}

const review = async (w: World, o: { head: string; verdict: string; sure?: boolean; fixes?: object[]; outside?: number; at?: string }) =>
  await w.db.run(w.db.k.insertInto("main.opus_reviews").values({
    repo: "app", number: 1, head_oid: o.head, run_id: "rv", at: o.at ?? later(), model: "m", mode: "full", verdict: o.verdict, sure: o.sure === false ? 0 : 1, reason: "r",
    fixes: o.fixes?.length ? JSON.stringify(o.fixes) : null, workflow: o.outside ? JSON.stringify({ outside_purpose: { lines: o.outside, note: "reformats a module" }, recommendation: null }) : null,
  }));
const fixup = async (w: World, o: { state: string; files?: string[]; patch?: string; from?: string; to?: string }) =>
  await w.db.run(w.db.k.insertInto("main.fixups").values({ repo: "app", number: 1, from_head: o.from ?? "sha1", to_head: o.to ?? null, state: o.state, reason: null, files: JSON.stringify(o.files ?? []), attempt: 1, created_at: later(), source: "review", patch: o.patch ?? null }));
const legState = async (w: World): Promise<string | undefined> =>
  (await w.db.get(w.db.k.selectFrom("main.preapprovals").select("state").where("number", "=", 1).orderBy("id", "desc").limit(1)))?.state;

test("each blocker stops an approved item and keeps its approval", async () => {
  const bigPatch = Array.from({ length: 450 }, (_, i) => `+line ${i}`).join("\n");
  const cases: [Blocker, (w: World) => Promise<unknown>][] = [
    ["major-finding", (w) => review(w, { head: "sha1", verdict: "hold" })],
    ["author-commits", (w) => w.synced(1, "sha9")],
    ["failed-twice", async (w) => { await fixup(w, { state: "failed" }); await fixup(w, { state: "refused" }); }],
    ["large-fix", (w) => fixup(w, { state: "pushed", files: ["src/lib.rs"], patch: bigPatch })],
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

test("a yes after a blocker resumes the merge leg and does not stop again on what the person saw", async () => {
  const w = await approvedReview();
  const db = w.db;
  await review(w, { head: "sha1", verdict: "hold" });
  await advanceWorkflows(db);
  assert.equal((await liveWorkflow(db, "app", 1))!.state, "blocked");

  // The answer comes after the review: what it found is what the person chose to go on with.
  await new Promise((r) => setTimeout(r, 10));
  const r = await runCommand(db, actor, "dashboard", { parsed: parse("yes"), items: [{ repo: "app", number: 1 }], at: new Date(Date.now() + 10_000).toISOString() });
  assert.equal(r.items[0]!.outcome, "run", r.lines.join("\n"));
  await advanceWorkflows(db);
  const wf = (await liveWorkflow(db, "app", 1))!;
  assert.deepEqual([wf.state, wf.blocker, wf.approvedBy], ["running", null, MAINT]);
  const leg = (await db.get(db.k.selectFrom("main.preapprovals").select(["state", "workflow_id"]).orderBy("id", "desc").limit(1)))!;
  assert.deepEqual([leg.state, leg.workflow_id], ["review", wf.id], "a new merge leg works for the workflow");
  await advancePreapprovals(db);
  assert.equal(await legState(w), "ci", "the hold the person answered past counts as a take");
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
  for (let i = 0; i < 3; i++) await advancePreapprovals(db);
  assert.equal(await legState(w), "queued");
  const d = (await db.get(db.k.selectFrom("main.decisions").select(["answer", "answered_by"]).where("id", "=", mergeDecisionId("app", 1, "sha2"))))!;
  assert.deepEqual([d.answer, d.answered_by], ["merge", MAINT], "the merge is made as the approver");
  await w.verified(1);
  assert.ok((await w.prPlan(1)).actions.some((a) => a.kind === "merge"), "the merge queue merges it once verified");

  await db.run(db.k.updateTable("main.items").set({ state: "MERGED" }).where("number", "=", 1));
  await advanceWorkflows(db);
  assert.equal(await liveWorkflow(db, "app", 1), null);
});

test("an approved merge goes on past an unsure pre-merge review with no defect; a defect stops it as a major finding", async () => {
  for (const kind of ["clean", "defect"] as const) {
    const w = await approvedReview();
    const db = w.db;
    await review(w, { head: "sha1", verdict: "take", at: new Date().toISOString() });
    if (kind === "clean") {
      // Waiting in ci for a pre-merge check no Task Runner can take: the state line says so.
      await setInferenceMode(db, "user-local", "test");
      for (let i = 0; i < 2; i++) await advancePreapprovals(db);
      assert.equal(await legState(w), "ci");
      assert.equal(await legWait(db, (await liveWorkflow(db, "app", 1))!), "Waiting for the pre-merge check: no Task Runner can take it");
      // The approver's runner takes it: the state line names it while it cannot claim, and goes back to the steps once it can.
      const token = (await createToken(db, MAINT, "runner", { kind: "runner" })).row.id;
      const line = async () => await legWait(db, (await liveWorkflow(db, "app", 1))!);
      assert.equal(await line(), "Waiting for mira's Task Runner (offline)");
      const report = (readiness: string) => storeStatus(db, token, MAINT, parseStatus({ slots: 1, busy: 0, readiness, harness: "claude", models: { top: "opus", small: "haiku" }, reserve: { fiveHour: 0, weekly: 0 } }));
      await report("quota-held");
      assert.equal(await line(), "Waiting for mira's Task Runner (usage limit)");
      await report("ready");
      assert.equal(await line(), null);
    }
    await w.premerge(1, kind, false);
    await db.run(db.k.updateTable("main.premerge_reviews").set({ unsure: 1 }).where("number", "=", 1));
    for (let i = 0; i < 3; i++) { await advanceWorkflows(db); await advancePreapprovals(db); }
    await advanceWorkflows(db);
    const wf = (await liveWorkflow(db, "app", 1))!;
    if (kind === "clean") assert.deepEqual([await legState(w), wf.state], ["queued", "running"], "unsure with no finding: the merge queue has it");
    else assert.deepEqual([await legState(w), wf.state, wf.blocker], ["asked", "blocked", "major-finding"]);
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

test("a plain approval does not accept a hold review nobody was shown", async () => {
  const w = await approvedReview();
  const db = w.db;
  await w.pr(2, { label: "feature" });
  await runCommand(db, actor, "dashboard", { parsed: parse("review"), items: [{ repo: "app", number: 2 }] });
  await db.run(db.k.insertInto("main.opus_reviews").values({ repo: "app", number: 2, head_oid: "sha2", run_id: "rv", at: later(), model: "m", mode: "full", verdict: "hold", sure: 1, reason: "r" }));
  await runCommand(db, actor, "dashboard", { parsed: parse("merge"), items: [{ repo: "app", number: 2 }], at: new Date(Date.now() + 10_000).toISOString() });
  await advanceWorkflows(db);
  assert.equal((await liveWorkflow(db, "app", 2))!.blocker, "major-finding");
});

/** The repo "app" on the maintainer workflow with a maintainer who may act, issue 7 started with `implement`, and its first attempt. */
async function implementIssue(): Promise<World> {
  const w = current = await (await (await world()).repo()).issue(7);
  const db = w.db;
  await db.run(db.k.updateTable("main.tracked_repos").set({ workflow: "new" }).where("name", "=", "app"));
  await db.run(db.k.insertInto("main.settings").values({ key: "github_identity", value: "app" }).onConflict((oc) => oc.column("key").doUpdateSet({ value: "app" })));
  await db.run(db.k.insertInto("main.access").values({ login: MAINT, role: "maintainer" }));
  await db.run(db.k.insertInto("main.repo_permissions").values({ login: MAINT, repo: "app", permission: "write", checked_at: new Date().toISOString() }));
  await setFeature(db, "implement", true, MAINT, "app");
  const r = await runCommand(db, actor, "dashboard", { parsed: parse("implement"), items: [{ repo: "app", number: 7 }] });
  assert.equal(r.items[0]!.outcome, "run", r.lines.join("\n"));
  const it = (await db.get(db.k.selectFrom("items").select(["title", "body"]).where("repo", "=", "app").where("number", "=", 7)))!;
  await startImplementation(db, { repo: "app", number: 7, queuedBy: MAINT, textHash: textHash(it.title ?? "", it.body ?? "") });
  return w;
}

test("an implement question comes back as one recommendation, and a yes answers it so the implementation plans again", async () => {
  const w = await implementIssue();
  const db = w.db;
  const asks: PlanReply = {
    ready: false, kind: "feature", summary: "Remember the export folder.", plan: "The dialog keeps no folder.", acceptance: [], verification: { tests: [], app: null }, size: "S", risks: [],
    questions: [{ audience: "maintainer", text: "Remember the folder globally or per document?", options: [{ label: "Globally", hint: "One folder." }, { label: "Per document", hint: "Stored with the file." }], recommended: "Per document" }],
    workflow: { parts: [], recommendation: "Go with 2, per document, then implement it." },
  };
  await recordPlan(db, (await currentImplementation(db, "app", 7))!, { callId: null, reply: asks }, { commentsApproved: true, postComment: async () => null, log: () => {} });
  await advanceWorkflows(db);
  const wf = (await liveWorkflow(db, "app", 7))!;
  assert.equal(wf.state, "recommending");
  assert.deepEqual(wf.plan.map((p) => p.title), ["Globally", "Per document"]);
  assert.equal(wf.rec?.text, asks.workflow!.recommendation);

  const r = await runCommand(db, actor, "dashboard", { parsed: parse("yes"), items: [{ repo: "app", number: 7 }] });
  assert.equal(r.items[0]!.outcome, "run", r.lines.join("\n"));
  assert.match(r.lines[0]!, /Per document/);
  const d = (await getDecision(db, (await currentImplementation(db, "app", 7))!.decisionId!))!;
  assert.equal(optionsOf(d).find((o) => o.key === d.answer)?.label, "Per document");
  assert.equal(d.answered_by, MAINT);
  assert.deepEqual(implementStep((await loadItemFact(db, "app", 7))!), { bucket: "plan" });
  assert.equal((await liveWorkflow(db, "app", 7))!.state, "running");
});

test("an answer on an implement issue queues a fix-up of the named part on its implementation PR", async () => {
  const w = await implementIssue();
  const db = w.db;
  await w.pr(8, { author: "craft-bot" });
  const im = (await currentImplementation(db, "app", 7))!;
  await setImplementationState(db, im.id, "pr-opened", { branch: "fix-8", prNumber: 8, prUrl: "https://example.invalid/8" });
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
