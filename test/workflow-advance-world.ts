// Shared setup of test/workflow-advance.test.ts and test/workflow-advance-answers.test.ts.
import assert from "node:assert/strict";
import { afterEach } from "node:test";
import { advancePreapprovals } from "../src/preapproval/index.ts";
import { addOwnCommits, setStepApproval } from "../src/data/control/index.ts";
import { advanceWorkflows } from "../src/workflow/advance.ts";
import { runCommand, type Actor } from "../src/workflow/apply.ts";
import { parse } from "../src/workflow/parse.ts";
import { liveWorkflow } from "../src/workflow/store.ts";
import type { Surface } from "../src/workflow/types.ts";
import { untilQuiet, world, type World } from "./world-db.ts";
import { setFeature } from "../src/build/features.ts";
import { textHash } from "../src/core/open-prs.ts";
import { implementStep } from "../src/core/decide-item.ts";
import { loadItemFact } from "../src/core/issue-facts.ts";
import { currentAttempt, writeStep } from "../src/implement/attempt.ts";
import { openQuestion } from "../src/implement/questions.ts";
import { startAttempt } from "../src/data/implement/index.ts";
import { recordPlan } from "../src/implement/plan.ts";
import type { PlanReply } from "../src/implement/types.ts";

let current: World | undefined;
/** Closes `w` after the test. */
export const keep = (w: World): World => (current = w);
afterEach(() => current?.close());

export const MAINT = "mira";
export const actor: Actor = { login: MAINT, canWrite: async () => true };
/** A time after the command that started the item: what the pipeline records after it. */
export const later = (): string => new Date(Date.now() + 5_000).toISOString();

/** The repo "app" on the maintainer workflow, the app identity, a maintainer with write access, and PR 1 started at Review with the merge approved. */
export async function approvedReview(): Promise<World> {
  const w = current = await (await world()).repo();
  const db = w.db;
  await setStepApproval(db, [{ repo: "app", step: "merge", on: true }], MAINT);
  await db.run(db.k.updateTable("main.tracked_repos").set({ workflow: "new" }).where("name", "=", "app"));
  await db.run(db.k.insertInto("main.settings").values({ key: "github_identity", value: "app" }).onConflict((oc) => oc.column("key").doUpdateSet({ value: "app" })));
  await db.run(db.k.insertInto("main.access").values({ login: MAINT, role: "maintainer" }));
  await db.run(db.k.insertInto("main.repo_permissions").values({ login: MAINT, repo: "app", permission: "write", checked_at: new Date().toISOString() }));
  await w.pr(1, { label: "feature" });
  const r = await runCommand(db, actor, "dashboard", { parsed: parse("review and merge"), items: [{ repo: "app", number: 1 }] });
  assert.equal(r.items[0]!.outcome, "run", r.lines.join("\n"));
  return w;
}

export const review = async (w: World, o: { head: string; verdict: string; sure?: boolean; fixes?: object[]; outside?: number; at?: string }) =>
  await w.db.run(w.db.k.insertInto("main.opus_reviews").values({
    repo: "app", number: 1, head_oid: o.head, run_id: "rv", at: o.at ?? later(), model: "m", mode: "full", verdict: o.verdict, sure: o.sure === false ? 0 : 1, reason: "r",
    fixes: o.fixes?.length ? JSON.stringify(o.fixes) : null, workflow: o.outside ? JSON.stringify({ outside_purpose: { lines: o.outside, note: "reformats a module" }, recommendation: null }) : null,
  }));
export const fixup = async (w: World, o: { state: string; files?: string[]; patch?: string; from?: string; to?: string }) =>
  await w.db.run(w.db.k.insertInto("main.fixups").values({ repo: "app", number: 1, from_head: o.from ?? "sha1", to_head: o.to ?? null, state: o.state, reason: null, files: JSON.stringify(o.files ?? []), attempt: 1, created_at: later(), source: "review", patch: o.patch ?? null }));
export const legState = async (w: World): Promise<string | undefined> =>
  (await w.db.get(w.db.k.selectFrom("main.preapprovals").select("state").where("number", "=", 1).orderBy("id", "desc").limit(1)))?.state;

/** PR 2, started at Review and not approved, with its question at sha2: a take's "Merge it.", or a close. */
export async function askedReview(verdict = "take"): Promise<World> {
  const w = await approvedReview();
  await w.pr(2, { label: "feature" });
  assert.equal((await answer(w, "review")).outcome, "run");
  await review2(w, "sha2", verdict);
  await advanceWorkflows(w.db);
  const wf = (await liveWorkflow(w.db, "app", 2))!;
  assert.deepEqual([wf.state, wf.recHead], ["recommending", "sha2"]);
  return w;
}
/** PR 2's review at the head, with its verification and a clean pre-merge review: nothing but the merge is left. */
export const review2 = async (w: World, head: string, verdict = "take") => {
  await (await w.verified(2)).premerge(2, "clean");
  await w.db.run(w.db.k.insertInto("main.opus_reviews").values({ repo: "app", number: 2, head_oid: head, run_id: "rv", at: later(), model: "m", mode: "full", verdict, sure: 1, reason: "r" }));
};
export const answer = async (w: World, text: string, via: Surface = "dashboard", number = 2) => (await runCommand(w.db, actor, via, via === "github"
  ? { parsed: parse(text), items: [{ repo: "app", number }], head: String((await w.rows(`SELECT head_oid FROM items WHERE number = ${number}`))[0]!.head_oid) }
  : { parsed: parse(via === "discord" ? `${text}: app#${number}` : text), items: via === "discord" ? [] : [{ repo: "app", number }] })).items[0]!;
export const ownPush = async (w: World, from: string, to: string, number = 2) => {
  await w.db.run(w.db.k.insertInto("main.fixups").values({ repo: "app", number, from_head: from, to_head: to, state: "pushed", files: "[]", attempt: 1, created_at: later(), source: "review" }));
  await w.synced(number, to);
};
export const ANSWERS: [Surface, string][] = [["dashboard", "yes"], ["agent", "approve"], ["discord", "merge"], ["github", "yes"]];

/** PR 2 in the merge queue, stopped at commits its author pushed (head "theirs") that the review round found beyond the approval. */
export async function authorPushed(): Promise<World> {
  const w = await approvedReview();
  await w.pr(2, { label: "feature" });
  assert.equal((await answer(w, "merge")).outcome, "run");
  await w.synced(2, "theirs");
  await w.outOfScope(2, "theirs");
  await advanceWorkflows(w.db);
  assert.equal((await liveWorkflow(w.db, "app", 2))!.blocker, "author-commits");
  await pause();
  return w;
}
export const pause = () => new Promise((r) => setTimeout(r, 5));
export const ticks = (w: World) => untilQuiet(w.db, [() => advanceWorkflows(w.db), () => advancePreapprovals(w.db)], 3);
export const leg2 = async (w: World) => (await w.rows("SELECT state, head, from_head FROM preapprovals WHERE number = 2 ORDER BY id DESC"))[0]!;
export const planned2 = async (w: World) => (await w.prPlan(2)).actions.map((a) => a.kind);
/** A CI fix of ours that lands now. */
export const pushNow = async (w: World, from: string, to: string, lines = 10) => {
  const at = new Date().toISOString();
  await w.db.run(w.db.k.insertInto("main.own_pushes").values({ repo: "app", number: 2, action: "cifix-push", from_oid: from, to_oid: to, lines, at, landed_at: at }));
  await w.synced(2, to);
  await pause();
};
export const reviewNow = async (w: World, head: string, verdict: string) => {
  await review2(w, head, verdict);
  await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ at: new Date().toISOString() }).where("number", "=", 2).where("head_oid", "=", head));
  await w.db.run(w.db.k.deleteFrom("main.review_state").where("number", "=", 2));
  await pause();
};

/** The repo "app" on the maintainer workflow with a maintainer who may act, issue 7 started with `implement`, and its first attempt. */
export async function implementIssue(): Promise<World> {
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
  await startAttempt(db, { repo: "app", number: 7, queuedBy: MAINT, textHash: textHash(it.title ?? "", it.body ?? "") });
  return w;
}

/** A plan call's reply that asks the maintainers one question with two options, "Per document" recommended. */
export const ASKS: PlanReply = {
  ready: false, kind: "feature", summary: "Remember the export folder.", plan: "The dialog keeps no folder.", acceptance: [], verification: { tests: [], app: null }, size: "S", risks: [],
  questions: [{ audience: "maintainer", text: "Remember the folder globally or per document?", options: [{ label: "Globally", hint: "One folder." }, { label: "Per document", hint: "Stored with the file." }], recommended: "Per document" }],
  workflow: { parts: [], recommendation: "Go with 2, per document, then implement it." },
};
/** The issue's implementation asks `reply`'s questions, and the pass after it. */
export async function asked(reply: PlanReply): Promise<World> {
  const w = await implementIssue();
  await recordPlan(w.db, (await currentAttempt(w.db, "app", 7))!.impl, { callId: null, reply }, { commentsApproved: true, postComment: async () => null, log: () => {} });
  await advanceWorkflows(w.db);
  return w;
}
export const say = async (w: World, text: string) => (await runCommand(w.db, actor, "dashboard", { parsed: parse(text), items: [{ repo: "app", number: 7 }] })).items[0]!;
export const nextStep = async (w: World) => implementStep((await loadItemFact(w.db, "app", 7))!);
export const labelOf = async (w: World): Promise<string | undefined> => {
  const { question, answer } = openQuestion((await currentAttempt(w.db, "app", 7))!.rounds);
  return (question!.result as { options: { key: string; label: string }[] }).options.find((o) => o.key === answer?.option)?.label;
};

/** A ready plan whose one part changes src/a.rs. */
const PLANNED: PlanReply = { ...ASKS, ready: true, questions: [], workflow: { parts: [{ title: "Keep the folder", files: ["src/a.rs"] }], recommendation: null } };
/** The issue's attempt opened PR 8 at sha8 (our own commit), having changed `files`. */
export async function implementationOpened(files: string[], approved: boolean): Promise<World> {
  const w = await implementIssue();
  if (approved) await say(w, "merge");
  await w.pr(8, { author: "craft-bot" });
  await addOwnCommits(w.db, [{ repo: "app", sha: "sha8", action: "implement-push" }]);
  await writeStep(w.db, (await currentAttempt(w.db, "app", 7))!.impl, {
    to: "pr-opened", patch: { plan: PLANNED, diffStat: files.map((f) => ` ${f} | +300 -1`).join("\n"), branch: "fix-8", prNumber: 8, prUrl: "https://example.invalid/8" },
  });
  return w;
}
export const review8 = async (w: World, verdict: string, workflow?: object) => await w.db.run(w.db.k.insertInto("main.opus_reviews").values({
  repo: "app", number: 8, head_oid: "sha8", run_id: "rv", at: later(), model: "m", mode: "full", verdict, sure: 1, reason: "r", workflow: workflow ? JSON.stringify(workflow) : null,
}));
export const leg8 = async (w: World) => (await w.rows("SELECT state FROM preapprovals WHERE number = 8 ORDER BY id DESC"))[0]?.state;
