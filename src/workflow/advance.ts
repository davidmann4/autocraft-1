// Moves each live maintainer workflow on from what the pipeline recorded: its numbered plan from the latest review, a blocker that
// stops an approved item, the one recommendation an unapproved item comes back with when its steps are done, the merge leg of an
// approved PR (the pre-approved merge in src/preapproval, owned through preapprovals.workflow_id, which merges as the approver), and
// the end once the PR merged or closed. The runner runs it on each tick its inputs changed, before the pre-approval pass.
//
// It never asks a question: a person answers the recommendation with a command (apply.ts), and nothing here writes to GitHub.
import type { Db } from "../db/index.ts";
import { decidePr, MAINTAINER_ANSWER_WAIT } from "../core/decide.ts";
import { loadPrFacts } from "../core/facts.ts";
import type { PrFacts } from "../core/plan.ts";
import { isLimitDecision, LIMIT_CLOSE, LIMIT_IMPLEMENT } from "../implement/questions.ts";
import { currentImplementation } from "../implement/store.ts";
import type { Implementation, PlanReply } from "../implement/types.ts";
import { cancelPreapproval, inActiveBatch, PreapprovalRefused, preapproveMerge } from "../preapproval/index.ts";
import { BACKLOG, getDecision, optionsOf, type DecisionRow } from "../decisions.ts";
import { implementDecisionId, STUCK_OPTIONS } from "../implement/stuck.ts";
import { findingsOf, premergeAt } from "../premerge/store.ts";
import { t } from "../i18n/index.ts";
import type { ReviewFix, ReviewWorkflow } from "../review/opus-parse.ts";
import { withSettingsSnapshot } from "../settings-read.ts";
import { detectBlocker, PREMERGE_STOP, type BlockerFacts, type Found } from "./blockers.ts";
import { afterSteps, atBlocker, planOf, type ReviewView } from "./recommend.ts";
import { largeFixLines, outsidePurposeMin } from "./settings.ts";
import { listText, stepsFor, type StepName } from "./status.ts";
import { addEvent, goOnAt, liveWorkflows, repoWorkflows, updateWorkflow, type WorkflowPatch } from "./store.ts";
import type { ItemWorkflow, PlanPart, Recommendation } from "./types.ts";

const ACTOR = "pipeline";
const ACTIVE_LEG = ["fixup", "review", "ci", "queued"];
const ENDED_LEG = ["asked", "cancelled", "failed"];
/** Fix-up and CI fix tries that failed (src/fixup, src/cifix). */
const FAILED_TRY = ["failed", "refused", "rejected", "cannot-push", "push-denied"];

/** What changed in a pass, for the Discord alerts and the log. */
export type Moved = { id: number; repo: string; number: number; to: ItemWorkflow["state"] };

const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};

/** Changed lines of a unified diff. */
export const patchLines = (patch: string | null): number =>
  (patch ?? "").split("\n").filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---")).length;

/** Whether our own pushes (fix-up, CI fix, base merge, implementation revision, autorepin) lead from `from` to `to`. */
async function ownChain(db: Db, repo: string, number: number, from: string, to: string): Promise<boolean> {
  let cur = from;
  for (let i = 0; i < 20 && cur !== to; i++) {
    const next = (await db.get(db.k.selectFrom("main.push_outcomes").select("to_oid as to").where("repo", "=", repo).where("number", "=", number).where("from_oid", "=", cur).orderBy("id", "desc").limit(1)))?.to
      ?? (await db.get(db.k.selectFrom("main.conflict_merges").select("to_head as to").where("repo", "=", repo).where("number", "=", number).where("from_head", "=", cur).where("state", "=", "merged").limit(1)))?.to
      ?? (await db.get(db.k.selectFrom("main.autorepins").select("to_head as to").where("repo", "=", repo).where("number", "=", number).where("head", "=", cur).where("state", "=", "pushed").limit(1)))?.to
      ?? null;
    if (!next || next === cur) return false;
    cur = next;
  }
  return cur === to;
}

type Review = { at: string; verdict: string; sure: boolean; fixes: ReviewFix[]; workflow: ReviewWorkflow | null };

async function reviewAt(db: Db, repo: string, number: number, head: string): Promise<Review | null> {
  const r = await db.get(db.k.selectFrom("main.opus_reviews").select(["at", "verdict", "sure", "fixes", "workflow"]).where("repo", "=", repo).where("number", "=", number).where("head_oid", "=", head).where("verdict", "is not", null));
  return r ? { at: r.at, verdict: r.verdict!, sure: r.sure === 1, fixes: json<ReviewFix[]>(r.fixes, []), workflow: json<ReviewWorkflow | null>(r.workflow, null) } : null;
}

/** Tries of a step on the PR that failed after `since`. */
async function failures(db: Db, repo: string, number: number, since: string): Promise<{ step: string; count: number }[]> {
  const count = async (table: "main.fixups" | "main.ci_fixes"): Promise<number> => Number((await db.get(db.k.selectFrom(table).select((eb) => eb.fn.countAll<number>().as("n"))
    .where("repo", "=", repo).where("number", "=", number).where("state", "in", FAILED_TRY).where("created_at", ">", since)))?.n ?? 0);
  return [{ step: "fix-up", count: await count("main.fixups") }, { step: "CI fix", count: await count("main.ci_fixes") }];
}

/** Lockfiles a fix-up may touch as a side effect of its change: never "beyond what was agreed". */
const LOCKFILE = /(^|\/)(Cargo\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Gemfile\.lock|poetry\.lock|go\.sum)$/;

/**
 * Our latest pushed fix-up of the PR's review findings (the review's own, or one a person asked for) after `since`: its changed lines,
 * its files, and the files the plan of the review it fixed names (that review is at the head it started from).
 */
async function latestFix(db: Db, w: ItemWorkflow, number: number, since: string): Promise<{ fix: BlockerFacts["fix"]; plannedFiles: string[] }> {
  const r = await db.get(db.k.selectFrom("main.fixups").select(["patch", "files", "from_head"]).where("repo", "=", w.repo).where("number", "=", number).where("state", "=", "pushed")
    .where("created_at", ">", since).where((eb) => eb(eb.fn.coalesce("source", eb.val("review")), "in", ["review", "operator"])).orderBy("created_at", "desc").limit(1));
  if (!r) return { fix: null, plannedFiles: [] };
  const fixed = await reviewAt(db, w.repo, number, r.from_head);
  const plannedFiles = fixed ? planOf(fixed.fixes, w.plan).filter((p) => p.state !== "dropped" && p.file).map((p) => p.file!) : [];
  return { fix: { lines: patchLines(r.patch), files: json<string[]>(r.files, []).filter((f) => !LOCKFILE.test(f)) }, plannedFiles };
}

/**
 * Keys of a question's options that are no plan part: Backlog, and closing the issue or PR, are commands of their own (so no drop
 * or part number ever closes anything), and "Answer in the note" needs words a command cannot carry.
 */
const NOT_A_PART = new Set([BACKLOG.key, "answer", LIMIT_CLOSE.key, STUCK_OPTIONS.close.key, STUCK_OPTIONS.closePr.key]);

/** A question's options as numbered parts of the plan, tied to the question; a part a person dropped before (same title) stays dropped. */
function questionParts(d: DecisionRow, before: readonly PlanPart[]): PlanPart[] {
  const dropped = new Set(before.filter((p) => p.option !== undefined && p.state === "dropped").map((p) => p.title.toLowerCase()));
  return optionsOf(d).filter((o) => !NOT_A_PART.has(o.key)).map((o, i) => ({
    n: i + 1, title: o.label, source: "implement" as const, option: o.key, question: d.id, state: dropped.has(o.label.toLowerCase()) ? "dropped" as const : "planned" as const,
  }));
}

/**
 * A stuck implementation's open question: with Try again, what a yes answers; without it (only a draft PR, closing or the
 * backlog are offered), its options as parts and a sentence that asks for a named option or a command, since a yes cannot choose.
 */
async function stuckQuestion(db: Db, w: ItemWorkflow): Promise<{ answer: { decision: string; option: string; label: string } } | { decision: string; parts: PlanPart[]; text: string } | null> {
  const id = implementDecisionId(w.repo, w.number);
  const d = await getDecision(db, id);
  if (!d || d.answer !== null) return null;
  if (optionsOf(d).some((o) => o.key === STUCK_OPTIONS.tryAgain.key)) return { answer: { decision: id, option: STUCK_OPTIONS.tryAgain.key, label: STUCK_OPTIONS.tryAgain.label } };
  const parts = questionParts(d, w.plan);
  return {
    decision: id, parts,
    text: parts.length ? t("The implementation is stuck. Name the option to go with, such as “fix 1”, or reply close or stop.") : t("The implementation is stuck. Reply close or stop, or answer on the item page."),
  };
}

/** The pre-merge review's findings at the head, as plan parts numbered after `plan`'s. */
async function premergeParts(db: Db, repo: string, number: number, head: string, plan: readonly PlanPart[]): Promise<PlanPart[]> {
  const fs = findingsOf(await premergeAt(db, repo, number, head) ?? null).filter((f) => f.fix);
  const from = plan.reduce((m, p) => Math.max(m, p.n), 0);
  return fs.map((f, i) => ({ n: from + i + 1, title: f.title, source: "review" as const, file: f.file, ...(f.severity === "defect" ? { major: true } : {}), state: "planned" as const }));
}

/** The merge leg of the workflow that ended after `since` (and none active), with its reason. */
async function endedLeg(db: Db, w: ItemWorkflow, since: string): Promise<{ reason: string } | null> {
  const r = await db.get(db.k.selectFrom("main.preapprovals").select(["state", "reason", "updated_at"]).where("workflow_id", "=", w.id).orderBy("id", "desc").limit(1));
  if (!r || !ENDED_LEG.includes(r.state) || r.updated_at <= since) return null;
  return { reason: r.reason ?? r.state };
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Whether the PR's plan stops for a maintainer's answer: its steps are done, or a review verdict needs a person. */
const waitsForAnswer = (f: PrFacts): boolean => {
  const p = decidePr(f);
  return p.wait === MAINTAINER_ANSWER_WAIT || p.state === "opus-hold" || p.state === "opus-close";
};

/** Starts or adopts the approved PR's merge leg; a refusal is returned as the reason it cannot go on. */
async function ensureLeg(db: Db, w: ItemWorkflow, repo: string, pr: number, head: string): Promise<string | null> {
  const active = await db.get(db.k.selectFrom("main.preapprovals").select(["id", "workflow_id"]).where("repo", "=", repo).where("number", "=", pr).where("state", "in", ACTIVE_LEG).orderBy("id", "desc").limit(1));
  if (!active) {
    // The queue merged the leg and the mirror does not show it yet: no new leg on a merged PR.
    if ((await db.get(db.k.selectFrom("main.preapprovals").select("state").where("repo", "=", repo).where("number", "=", pr).orderBy("id", "desc").limit(1)))?.state === "merged") return null;
    try {
      await preapproveMerge(db, { repo, number: pr, by: w.approvedBy!, via: "workflow", head, workflowId: w.id });
    } catch (e) {
      // A refusal by rule (not reviewable, merging not approved) needs a person; anything else is tried again on the next pass.
      if (e instanceof PreapprovalRefused) return e.message;
      throw e;
    }
  } else if (active.workflow_id === w.id) return null;
  await db.run(db.k.updateTable("main.preapprovals").set({ workflow_id: w.id }).where("repo", "=", repo).where("number", "=", pr).where("state", "in", ACTIVE_LEG).where("workflow_id", "is", null));
  return null;
}

/** The PR a workflow works on: its own item, or an implement workflow's implementation PR; null while an issue has none. */
export async function prOf(db: Db, w: ItemWorkflow): Promise<{ number: number; stuck: boolean } | null> {
  if (w.kind === "pr") return { number: w.number, stuck: false };
  const im = await currentImplementation(db, w.repo, w.number);
  if (im?.prNumber != null) return { number: im.prNumber, stuck: im.state === "stuck" };
  if (im?.state === "stuck") return { number: -1, stuck: true };
  // The attempt may have ended with its PR: the latest one of this workflow that opened a PR.
  const ended = await db.get(db.k.selectFrom("main.implementations").select("pr_number").where("repo", "=", w.repo).where("number", "=", w.number).where("pr_number", "is not", null)
    .where("created_at", ">=", w.startedAt).orderBy("id", "desc").limit(1));
  return ended?.pr_number != null ? { number: ended.pr_number, stuck: false } : null;
}

/**
 * One pass over the live workflows of repos on the maintainer workflow. Writes only what changed; returns the workflows that moved to
 * another state.
 */
export async function advanceWorkflows(db: Db, log: (line: string) => void = () => {}): Promise<Moved[]> {
  const repos = new Set((await repoWorkflows(db)).filter((r) => r.workflow === "new").map((r) => r.repo));
  if (!repos.size) return [];
  const live = (await liveWorkflows(db)).filter((w) => repos.has(w.repo));
  if (!live.length) return [];
  const thresholds = { largeFix: await largeFixLines(db), outsideMin: await outsidePurposeMin(db) };
  const targets = new Map<number, { number: number; stuck: boolean } | null>();
  for (const w of live) targets.set(w.id, await prOf(db, w));
  const refs = [...new Set(live.flatMap((w) => { const t = targets.get(w.id); return t && t.number > 0 ? [`${w.repo}#${t.number}`] : []; }))];
  const facts = new Map((refs.length ? await withSettingsSnapshot(db, () => loadPrFacts(db, { refs })) : []).map((f) => [`${f.repo}#${f.number}`, f]));
  const moved: Moved[] = [];
  for (const w of live) {
    try {
      const to = await advanceOne(db, w, targets.get(w.id) ?? null, facts, thresholds);
      if (to) moved.push({ id: w.id, repo: w.repo, number: w.number, to });
    } catch (e) {
      log(`workflow ${w.repo}#${w.number}: ${(e as Error).message}`);
    }
  }
  return moved;
}

/** Whether a question of the legacy machinery is still open (asked and unanswered). */
async function openQuestion(db: Db, id: string): Promise<boolean> {
  const d = await getDecision(db, id);
  return !!d && d.answer === null;
}

/**
 * An implement attempt's open maintainer question, as the workflow shows it: its options as numbered parts (a part a person dropped
 * before, by its title, stays dropped) and one recommendation whose yes answers the question with the recommended option as the
 * person. The plan's own sentence is used when it gave one for this question; the question after the last round of questions
 * recommends going on with the stated assumptions, since a maintainer asked for the implementation. A question with no
 * recommended option, or one only words answer, gets a recommendation a yes cannot run: the person names an option or comments.
 */
async function implementQuestion(db: Db, w: ItemWorkflow, im: Implementation): Promise<{ plan: PlanPart[]; rec: Recommendation } | null> {
  if (im.state !== "asked" || !im.decisionId) return null;
  const d = await getDecision(db, im.decisionId);
  if (!d || d.answer !== null) return null;
  const plan = questionParts(d, w.plan);
  const drop = plan.filter((p) => p.state === "dropped").map((p) => p.n);
  const limit = isLimitDecision(d.id);
  const key = limit ? LIMIT_IMPLEMENT.key : d.recommended;
  const pick = plan.find((p) => p.option === key && p.state === "planned");
  if (!pick) {
    const text = plan.length
      ? t("Answer the question “{question}” by naming the option to go with, such as “fix 1”.", { question: d.question })
      : t("Answer the question “{question}” in a comment on the issue; the plan runs again with the answer.", { question: d.question });
    return { plan, rec: { text, parts: { fix: [], drop }, merges: false, question: d.id } };
  }
  // The plan's own sentence only when the one option number it names is the one a yes answers.
  const own = !limit ? im.plan?.workflow?.recommendation ?? null : null;
  const named = own ? [...new Set([...own.matchAll(/\b(\d+)\b/g)].map((m) => Number(m[1])).filter((n) => n >= 1 && n <= plan.length))] : [];
  const text = own && named.length === 1 && named[0] === pick.n ? own : t("Go with {n}, {title}, then implement it.", { n: pick.n, title: pick.title });
  return { plan, rec: { text, parts: { fix: [], drop }, merges: w.approvedBy !== null, answer: { decision: d.id, option: pick.option!, label: pick.title }, question: d.id } };
}

/** A ready plan's numbered parts; a part a person dropped before (same title) stays dropped. Null when the plan gave none. */
function implementParts(before: readonly PlanPart[], reply: PlanReply | null): PlanPart[] | null {
  const parts = reply?.ready ? reply.workflow?.parts ?? [] : [];
  if (!parts.length) return null;
  const dropped = new Set(before.filter((p) => p.source === "implement" && p.state === "dropped").map((p) => p.title.toLowerCase()));
  return parts.map((p, i) => ({ n: i + 1, title: p.title, source: "implement" as const, ...(p.files[0] ? { file: p.files[0] } : {}), files: p.files, state: dropped.has(p.title.toLowerCase()) ? "dropped" as const : "planned" as const }));
}

/** The files of a diff stat (src/build/workspaces.ts diffStat): one ` path | +a -d` line per file, at most its first 40. */
const statFiles = (stat: string | null): string[] =>
  (stat ?? "").split("\n").flatMap((l) => { const m = / (.+) \| (?:binary|\+\d+ -\d+)$/.exec(l); return m ? [m[1]!.trim()] : []; });

/**
 * The files the implementation itself changed (its own diff when its PR opened, not our later fix-ups or revisions) that no
 * planned part of the plan it was built from names; null when the plan named no files or the attempt recorded no diff.
 */
async function implementationBeyond(db: Db, w: ItemWorkflow, pr: number): Promise<string[] | null> {
  const im = await db.get(db.k.selectFrom("main.implementations").select(["plan_json", "diff_stat"]).where("repo", "=", w.repo).where("number", "=", w.number).where("pr_number", "=", pr).orderBy("id", "desc").limit(1));
  const parts = implementParts([], json<PlanReply | null>(im?.plan_json, null)) ?? [];
  const plannedFiles = new Set(parts.flatMap((p) => p.files ?? []));
  const files = statFiles(im?.diff_stat ?? null).filter((f) => !LOCKFILE.test(f));
  if (!plannedFiles.size || !files.length) return null;
  return files.filter((f) => !plannedFiles.has(f));
}

/** Whether an earlier head of the PR was reviewed: a review pending at the current head is the second one. */
async function reviewedBefore(db: Db, repo: string, number: number, head: string): Promise<boolean> {
  return !!await db.get(db.k.selectFrom("main.opus_reviews").select("head_oid").where("repo", "=", repo).where("number", "=", number).where("head_oid", "!=", head).where("verdict", "is not", null).limit(1));
}

/** The first of `names` the workflow's steps have, else its first step. */
const stepIn = (w: ItemWorkflow, ...names: StepName[]): StepName => {
  const steps = stepsFor(w.entry, w.approvedBy !== null);
  return names.find((n) => steps.includes(n)) ?? steps[0]!;
};

async function advanceOne(db: Db, w0: ItemWorkflow, target: { number: number; stuck: boolean } | null, facts: Map<string, PrFacts>, thresholds: BlockerFacts["thresholds"]): Promise<ItemWorkflow["state"] | null> {
  const at = new Date().toISOString();
  let w = w0;
  /** The step the pass found the workflow at; written with the pass's other changes, or alone when only it changed. */
  let step: StepName | null = null;
  /** The step to record: an item back with its end recommendation is at "recommend"; one back with a question waits at its step. */
  const stepTo = (patch: WorkflowPatch): StepName | null => {
    const rec = patch.rec !== undefined ? patch.rec : w.rec;
    return (patch.state ?? w.state) === "recommending" && !rec?.question ? stepIn(w, "recommend", "merge") : step;
  };
  const write = async (patch: WorkflowPatch, event?: "blocked"): Promise<ItemWorkflow["state"] | null> => {
    const next = patch.state ?? w.state;
    const s = stepTo(patch);
    await updateWorkflow(db, w.id, { ...patch, ...(s !== null && s !== w0.step ? { step: s } : {}) }, at);
    if (event) await addEvent(db, { workflowId: w.id, repo: w.repo, number: w.number, login: ACTOR, via: "cli", kind: event, line: patch.rec?.text ?? null, at });
    return next !== w0.state ? next : null;
  };
  /** Ends the pass: writes what changed (the step included). */
  const settle = async (patch: WorkflowPatch): Promise<ItemWorkflow["state"] | null> => {
    const s = stepTo(patch);
    return Object.keys(patch).length || (s !== null && s !== w0.step) ? await write(patch) : null;
  };
  const self = await db.get(db.k.selectFrom("main.items").select(["state"]).where("repo", "=", w.repo).where("number", "=", w.number));
  const base: WorkflowPatch = {};
  // A recommendation that stands for a question of the legacy machinery goes once the question is answered or set aside elsewhere
  // (the classic page, a later plan round): the workflow runs on.
  const asks = w.rec?.question ?? w.rec?.answer?.decision ?? null;
  if ((w.state === "blocked" || w.state === "recommending") && asks && !await openQuestion(db, asks)) {
    // Answered Backlog there: the item is kept open with nothing planned, which ends the workflow as the backlog command does.
    if ((await getDecision(db, asks))?.answer === BACKLOG.key) return await write({ state: "backlog", rec: null, recAt: null, recHead: null, blocker: null, blockerParams: null });
    Object.assign(base, { state: "running", rec: null, recAt: null, recHead: null, blocker: null, blockerParams: null } satisfies WorkflowPatch);
    w = { ...w, state: "running", rec: null, recAt: null, recHead: null, blocker: null, blockerParams: null };
  }
  // A stuck implementation comes back once per stuck question (a yes answers it, Try again): blocked when approved, else as the recommendation.
  // Without Try again, its options are the parts and a yes cannot choose.
  const stuck = async (head: string | null): Promise<ItemWorkflow["state"] | null> => {
    const q = await stuckQuestion(db, w);
    if (!q) return null;
    if (!("answer" in q)) {
      const found: Found = { blocker: "failed-twice", params: { step: "implement" } };
      const rec: Recommendation = { text: q.text, parts: { fix: [], drop: q.parts.filter((p) => p.state === "dropped").map((p) => p.n) }, merges: false, question: q.decision };
      const patch: WorkflowPatch = { ...base, plan: q.parts, rec, recAt: at, recHead: head };
      return w.approvedBy ? await write({ ...patch, state: "blocked", blocker: found.blocker, blockerParams: found.params }, "blocked") : await write({ ...patch, state: "recommending" });
    }
    const answer = q.answer;
    const found: Found = { blocker: "failed-twice", params: { step: "implement", answer } };
    const rec = { ...atBlocker(found, null, w.plan), question: answer.decision };
    return w.approvedBy
      ? await write({ ...base, state: "blocked", blocker: found.blocker, blockerParams: found.params, rec, recAt: at, recHead: head }, "blocked")
      : await write({ ...base, state: "recommending", rec: { ...rec, merges: false, text: t("Start the implementation again, then come back.") }, recAt: at, recHead: head });
  };
  if (!target || target.number < 0) {
    // An issue with no PR yet: it ends when the issue closes, stops when its implementation is stuck, comes back with the plan's
    // question, and shows a ready plan's parts.
    if (self && self.state !== "OPEN") return await write({ state: "closed", rec: null, blocker: null, blockerParams: null });
    step = stepIn(w, "implement");
    if (w.state === "blocked" || w.state === "recommending") return await settle(base);
    if (target?.stuck) {
      const moved = await stuck(null);
      if (moved) return moved;
    }
    const im = w.kind === "issue" ? await currentImplementation(db, w.repo, w.number) : null;
    if (!im) return await settle(base);
    const q = await implementQuestion(db, w, im);
    if (q) return await write({ ...base, state: "recommending", plan: q.plan, rec: q.rec, recAt: at, recHead: null });
    // A ready plan's parts; an answered question's options are no plan any more.
    const parts = implementParts(w.plan, im.plan) ?? (w.plan.some((p) => p.option !== undefined) ? [] : null);
    if (parts && !sameJson(parts, w.plan)) base.plan = parts;
    return await settle(base);
  }
  const pr = await db.get(db.k.selectFrom("main.items").select(["state", "head_oid"]).where("repo", "=", w.repo).where("number", "=", target.number));
  if (!pr) return await settle(base);
  if (pr.state === "MERGED") return await write({ state: "done", rec: null, blocker: null, blockerParams: null });
  if (pr.state !== "OPEN") return await write({ state: "closed", rec: null, blocker: null, blockerParams: null });
  // Waiting for a person: nothing moves until they answer.
  if (w.state === "blocked" || w.state === "recommending") return await settle(base);
  const head = pr.head_oid;
  if (!head) return await settle(base);
  const since = await goOnAt(db, w);
  const patch: WorkflowPatch = { ...base };

  // The head the workflow accepted moves along our own pushes; any other push is the author's.
  let authorPush: BlockerFacts["authorPush"] = null;
  const baseHead = w.kind === "pr" ? w.baseHead : null;
  if (!baseHead || w.kind !== "pr") {
    if (w.kind === "pr") patch.baseHead = head;
  } else if (baseHead !== head) {
    if (await ownChain(db, w.repo, target.number, baseHead, head)) patch.baseHead = head;
    else authorPush = { from: baseHead, to: head };
  }

  // The numbered plan follows the latest review at the head; a merge-queue entry has no review.
  const review = w.entry === "merge" ? null : await reviewAt(db, w.repo, target.number, head);
  const plan: PlanPart[] = review ? planOf(review.fixes, w.plan) : w.plan;
  if (!sameJson(plan, w.plan)) patch.plan = plan;
  const view: ReviewView | null = review ? { verdict: review.verdict, sure: review.sure, rec: review.workflow?.recommendation ?? null } : null;

  // The step: the merge leg's state for the merge part, else where the review and its fixes are.
  const leg = (await db.get(db.k.selectFrom("main.preapprovals").select("state").where("repo", "=", w.repo).where("number", "=", target.number).where("state", "in", ACTIVE_LEG).orderBy("id", "desc").limit(1)))?.state ?? null;
  if (leg === "fixup") step = stepIn(w, "fix-up", "update from main");
  else if (leg === "review") step = stepIn(w, "review again", "update from main");
  else if (leg === "ci") step = stepIn(w, "fix CI and conflicts", "merge");
  else if (leg === "queued") step = stepIn(w, "batch", "merge");
  else if (w.entry === "merge") step = stepIn(w, "update from main");
  else if (!review) step = await reviewedBefore(db, w.repo, target.number, head) ? stepIn(w, "review again", "review") : stepIn(w, "review");
  else if (review.verdict === "take-fix" && plan.some((p) => p.state === "planned") && (w.entry !== "review" || w.approvedBy !== null)) step = stepIn(w, "fix-up", "merge", "recommend");
  else step = stepIn(w, "merge", "recommend");

  if (target.stuck && w.kind === "issue") {
    const moved = await stuck(head);
    if (moved) return moved;
  }
  // An implementation's files beyond its plan are shown once: base_head of an implement issue is the implementation PR head the
  // workflow showed them at, and it follows our own pushes; a new attempt's PR, or someone else's push, is shown again.
  let beyond: string[] | null = null;
  if (w.kind === "issue") {
    const shown = w.baseHead !== null && (w.baseHead === head || await ownChain(db, w.repo, target.number, w.baseHead, head));
    if (shown) { if (w.baseHead !== head) patch.baseHead = head; }
    else beyond = await implementationBeyond(db, w, target.number);
  }
  const approved = w.approvedBy !== null;
  const fresh = review && review.at > since ? review : null;
  const fixed = await latestFix(db, w, target.number, since);
  const found = detectBlocker({
    entry: w.entry, approved, authorPush,
    review: fresh ? { verdict: fresh.verdict, sure: fresh.sure, majors: plan.filter((p) => p.major && p.state === "planned").map((p) => p.n), outsideLines: fresh.workflow?.outside_purpose?.lines ?? 0 } : null,
    failures: await failures(db, w.repo, target.number, since),
    fix: fixed.fix,
    plannedFiles: fixed.plannedFiles,
    ...(beyond?.length ? { implementationBeyond: beyond } : {}),
    leg: approved ? await endedLeg(db, w, since) : null,
    thresholds,
  });
  if (found) {
    // The merge leg stops before it can merge. One an integration batch holds goes through (cancelling it would undo the batch
    // under its running CI); a queued leg outside a batch is cancelled like any other.
    if (leg === "queued" && await inActiveBatch(db, w.repo, target.number)) return await settle(patch);
    if (leg) {
      try {
        await cancelPreapproval(db, ACTOR, w.repo, target.number, undefined, "workflow");
      } catch {
        // A merge of the repo is running, or the leg changed a moment ago: the next pass looks again.
        return await settle(patch);
      }
    }
    // A pre-merge review's findings become plan parts the recommendation fixes; nothing merges past them as they are.
    let blockPlan = plan;
    if (typeof found.params.reason === "string" && PREMERGE_STOP.test(found.params.reason)) {
      const extra = await premergeParts(db, w.repo, target.number, head, plan);
      blockPlan = [...plan, ...extra];
      found.params.premerge = extra.map((p) => p.n);
    }
    if (found.blocker === "beyond-agreed" && beyond?.length) patch.baseHead = head;
    return await write({ ...patch, ...(blockPlan !== plan ? { plan: blockPlan } : {}), state: "blocked", blocker: found.blocker, blockerParams: found.params, rec: atBlocker(found, view, blockPlan), recAt: at, recHead: head }, "blocked");
  }

  const f = facts.get(`${w.repo}#${target.number}`);
  if (!approved) {
    if (f && f.head === head && waitsForAnswer(f)) {
      let rec: Recommendation = afterSteps(view, plan);
      // The end recommendation also says which files the implementation changed beyond its plan; they count as shown.
      if (beyond?.length) {
        rec = { ...rec, text: t("{text} The implementation also changes {files}, which no part of its plan names.", { text: rec.text, files: listText(beyond.slice(0, 10)) }) };
        patch.baseHead = head;
      }
      return await write({ ...patch, state: "recommending", rec, recAt: at, recHead: head });
    }
  } else {
    const refused = await ensureLeg(db, w, w.repo, target.number, head);
    if (refused) {
      const stop: Found = { blocker: "other", params: { reason: refused } };
      return await write({ ...patch, state: "blocked", blocker: stop.blocker, blockerParams: stop.params, rec: atBlocker(stop, view, plan), recAt: at, recHead: head }, "blocked");
    }
  }
  return await settle(patch);
}
