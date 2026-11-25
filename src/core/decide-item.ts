// decideItem: the triage rules of one open item (issue or PR) in one place: classify, referee, prioritize, embed, duplicates,
// scope decision, label. Pure: no database, no clock (facts carry `now`). The rules are ported from the step selectors named at each rule.
// decideAll adds a PR's review-to-merge Plan (decide.ts) and derives the Work page's next-step text.
import { BUILD_STATES, ENDED_STATES, MAX_LIVE_PER_REPO, type ImplementBucket, type ImplementationState } from "../implement/types.ts";
import { isWork, unassignActions } from "./assignment.ts";
import { decidePr, implementOffWait, notStarted } from "./decide.ts";
import { RECOMMEND_MAX_FAILURES, RECOMMEND_RETRY_MS, alreadyLabeled, isScope, labelsToAdd } from "./item-rules.ts";
import type { Action, ItemFacts, ItemPlan, ItemState, ItemView, PassFacts, PrFacts, WaitKind } from "./plan.ts";

const act = (kind: Action["kind"], head: string | null, params?: Record<string, unknown>): Action => ({ kind, head, ...(params ? { params } : {}) });

/** Why the item would become a scope decision, or null. */
export function scopeReason(f: ItemFacts): "needs-decision" | "scope-disagreement" | null {
  const c = f.classification;
  if (c.status === "settled" && c.flags.includes("needs decision")) return "needs-decision";
  if (c.status === "disagree" && isScope(c.jevLabel) && isScope(c.haikuLabel)) return "scope-disagreement";
  return null;
}

export { implementOffWait };
/** The wait of a queued issue whose latest attempt ended without a merged PR and whose text has not changed since. */
export const IMPLEMENT_ENDED_WAIT = "a person to queue the implementation again";

/**
 * The Implement stage's step for an issue, or the wait that holds it; null when the issue is not queued (no fast_track
 * row by someone who settles on the repo) or another rule says what it waits on (a hold, an open PR that closes or mentions it).
 * A new attempt starts when there is none, or the last one ended and the issue text changed or it was queued again since; it needs the repo's
 * Implement feature and room among the repo's live implementations. A question is planned again when its answer may have
 * come: the issue text changed, a person commented after it, or its decision is answered.
 */
export function implementStep(f: ItemFacts): { bucket: ImplementBucket } | { wait: string; waitKind: WaitKind } | null {
  const im = f.implement, row = im.row, fix = f.fix;
  if (f.kind !== "issue" || !f.open || !f.inScope || f.held || im.queuedBy === null) return null;
  const state = row?.state as ImplementationState | undefined;
  const ended = !row || ENDED_STATES.has(state!);
  if (!im.settles) return ended ? null : { wait: `a person who settles on ${f.repo} to queue it again`, waitKind: "person" };
  const due = (bucket: ImplementBucket) => (im.featureOn ? { bucket } : { wait: implementOffWait(f.repo), waitKind: "system" as const });
  if (ended) {
    if (fix.openPr !== null) return null;
    if (row && !row.textChanged && !row.requeuedAfterEnd) return { wait: IMPLEMENT_ENDED_WAIT, waitKind: "person" };
    if (im.featureOn && im.liveInRepo >= MAX_LIVE_PER_REPO) return { wait: `${im.liveInRepo} implementations already running in ${f.repo}`, waitKind: "system" };
    return due("plan");
  }
  if (state === "planning") return due("plan");
  if (state === "asked") {
    if (row!.textChanged || row!.newCommentAfterQuestion || row!.decisionAnswered) return due("plan");
    return row!.asked === "author" ? { wait: "the author's answer", waitKind: "contributor" } : { wait: "a maintainer's answer", waitKind: "person" };
  }
  if (BUILD_STATES.has(state!)) return due("build");
  if (state === "revising") return due("revise");
  if (state === "stuck") return row!.decisionAnswered ? due("build") : { wait: "a decision on the stuck implementation", waitKind: "person" };
  // pr-opened: the open PR is the wait (fix.openPr); a PR that merged or closed while the issue stayed open ends the attempt with
  // it (the revise work records that and ends the workspace). Its revisions, and the end of an attempt whose issue is closed
  // too, are planned on the PR (decidePr).
  // Ending the attempt is bookkeeping: it needs neither the Implement feature nor the approval (gates()).
  return row!.prOpen ? null : { bucket: "revise" };
}

/** Jev and Haiku chose different labels and it is not a scope call: a referee (Sonnet, then Opus when Sonnet was unsure) still has to settle it. An unsure Opus settles the label too and flags a scope decision. */
const labelDisagreement = (f: ItemFacts): boolean => f.classification.status === "disagree" && scopeReason(f) !== "scope-disagreement";

/**
 * A scope decision should be asked: the reason holds and no open decision, scope decision or Backlog answer covers the item. Labelling or a later stage does not suppress it.
 * Never in a repo on the maintainer workflow, where a maintainer picks what enters.
 */
const scopeNeeded = (f: ItemFacts): boolean => scopeReason(f) !== null && !f.scope.covered && f.repoFacts.workflow !== "new";

/** An issue's wait on the open PR that closes it or mentions it. The plan stores only this text, so liveness recognises the wait with `isOpenPrWait`. */
export const openPrWait = (n: number, closes: boolean): string => `open PR #${n}${closes ? "" : " mentions it"}`;
export const isOpenPrWait = (wait: string | null): boolean => wait !== null && /^open PR #\d+( mentions it)?$/.test(wait);


/** The wait of an open issue with nothing due and nothing to ask: it stays open as a request for anyone to pick up. */
export const TRIAGE_WAIT = "an open request for a person to pick up";
/** The wait of an issue whose fix attempt of the retired Fix stage was skipped or failed; the planner no longer gives it. */
export const fixStoppedWait = (state: string): string => `a person to retry the ${state} fix`;

const PLUGIN_WAIT = "stays open as a plugin candidate";
/** A PR settled as a plugin candidate is not reviewed or merged: it stays open with its label (no question) unless a scope decision about it is open. */
const pluginPr = (f: ItemFacts): boolean => f.kind === "pr" && f.classification.status === "settled" && f.classification.label === "plugin candidate" && !f.scope.open;

export function itemState(f: ItemFacts): ItemState {
  if (f.held) return f.held === "backlog" ? "held-backlog" : "held-duplicate";
  const c = f.classification;
  if (labelDisagreement(f)) return "referee-due";
  if (c.status === "unclassified") return "unclassified";
  if (c.status === "waiting") return "waiting-haiku";
  if (f.scope.open) return "scope-open";
  return scopeNeeded(f) ? "scope-due" : "classified";
}

const WAITS: Partial<Record<ItemState, string>> = {
  "held-duplicate": "a Duplicate? answer", "held-backlog": "a Backlog hold", "referee-due": "the label referee",
  "waiting-haiku": "Haiku's second opinion", "scope-open": "a scope answer", "scope-due": "the scope question to be asked",
};

/** The item has no priority row at its current text hash; the prioritize step asks it unless a classify request does. */
export const priorityDue = (f: ItemFacts): boolean => f.inScope && !f.integration && f.priorityHash !== f.embedHash;

export function decideItem(f: ItemFacts): ItemPlan {
  const state = itemState(f);
  const c = f.classification;
  const live = f.inScope && !f.integration;
  const actions: Action[] = [];

  // classify-new: Jev for items without a verdict or whose classifier input changed (unless Haiku classified the item alone at this input);
  // Haiku for items Jev is unsure of that have no Haiku verdict as new as Jev's.
  const jevDue = !c.haiku?.aloneCurrent && (!c.jev || c.jev.changed);
  const haikuDue = !!c.jev && c.jev.unsure && (!c.haiku || c.haiku.at < c.jev.at);
  if (f.run && live && (jevDue || haikuDue)) actions.push(act("classify", null, { source: jevDue ? "jev" : "haiku" }));
  // referee: open, not a draft, not held, in scope.
  // A failed Opus call is asked again after a backoff; the third failure sends the item to Decide.
  const backoff = !!c.referee?.failedAt && Date.parse(c.referee.failedAt) > f.now - RECOMMEND_RETRY_MS;
  // Not while Jev or Haiku is due again: the referee would judge the verdicts they are about to replace.
  if (f.run && live && !f.draft && state === "referee-due" && !backoff && !jevDue && !haikuDue) actions.push(act("referee", null, { source: c.referee ? "opus" : "sonnet" }));
  // prioritize: no priority row at the current text hash. Not while Jev's classify call is due: that request asks the impact
  // question too and settles the priority (src/runner/classify.ts), so the two steps never ask Jev the same item at once.
  // The hold ends once a classify request failed for the item's current input, so an item Jev cannot classify still gets a priority.
  if (priorityDue(f) && !(f.run && live && jevDue && !c.jevFailed)) actions.push(act("prioritize", null));
  // embed: every open item, with no scope test.
  if (f.embeddedHash !== f.embedHash) actions.push(act("embed", null));
  // dupes: items to scan, pairs to check, groups to ask.
  const scan = live && f.embeddedHash === f.embedHash && f.scannedHash !== f.embedHash;
  if (scan || f.pairsToCheck > 0 || f.inGroupToAsk) actions.push(act("dupes", null, { scan, pairs: f.pairsToCheck, group: f.inGroupToAsk }));
  // dupe-answer: operator answers to duplicate decisions that change no GitHub state. The pilot test is in the loader.
  if (f.dupeAnswers.length) actions.push(act("dupe-answer", null, { decisions: f.dupeAnswers }));
  if (f.inCompareSet) actions.push(act("dupes-compare", null));
  // decide: a new scope decision, or the prepare step for an open decision of the item (any kind, held or not; in scope only) that has no prepare for its current state.
  // A repo on the maintainer workflow asks no scope question and prepares no decision: a maintainer picks what enters, and the workflow's own steps write the recommendation.
  const newRepo = f.repoFacts.workflow === "new";
  if (!newRepo && f.run && live && !f.draft && state === "scope-due") actions.push(act("decide", null, { source: "new" }));
  else if (!newRepo && live && f.scope.recommend && f.scope.recommend.failures < RECOMMEND_MAX_FAILURES
    && (f.scope.recommend.failedAt === null || Date.parse(f.scope.recommend.failedAt) < f.now - RECOMMEND_RETRY_MS)) actions.push(act("decide", null, { source: "prepare" }));
  // label: the repo's labelling approval is applied by gates().
  if (f.run && live && f.held !== "backlog") {
    const settled = c.status === "settled" && c.label ? { type: c.label, security: c.flags.includes("security") && !f.labels.quietFix, needsDecision: c.flags.includes("needs decision") } : null;
    const add = labelsToAdd(settled, f.labels.pluginAnswer, f.labels.existing);
    if (add && add.length && !alreadyLabeled(f.labels.labeledNote, add)) actions.push(act("label", null, { add }));
  }

  const backlog = f.held === "backlog";
  // act: answers that close the item (in scope, or asked by a security scan; not held by Backlog; no final action row yet)
  // and Close? questions for PRs the final review says close (asked once per head). Selecting applies nothing; the repo's comment approval is applied by gates().
  for (const t of f.answeredClose) {
    // A Close answer that ended an item's workflow (`closed`) is carried out whatever the item's scope.
    if ((f.inScope || t.security || t.group || (f.repoFacts.workflow === "new" && f.endedWorkflow === "closed")) && !backlog && !t.waiting && (t.action === null || t.action === "failed")) actions.push(act("act", null, { bucket: t.kind, decisionId: t.decisionId, security: t.security, ...(t.group ? { group: true } : {}) }));
  }
  // Not in a repo on the maintainer workflow, which asks no Close? question: the close review is a blocker of the item's workflow.
  if (live && !backlog && !newRepo && f.kind === "pr" && f.closeReview && f.closeReview.atHead && !f.closeReview.asked) actions.push(act("act", f.closeReview.head, { bucket: "close", ask: true }));
  // implement: a queued issue's next step (implementStep); the repo's fix-issue approval and the breaker are applied by gates().
  const fix = f.fix, step = implementStep(f);
  if (step && "bucket" in step) actions.push(act("implement", null, { bucket: step.bucket }));

  // unassign (issues; a PR's is decided with its review-to-merge plan): kept while an implementation is due or runs, or its PR is open;
  // released when the issue waits on a person (a question, a stuck attempt, a switch), was given up or left the scope.
  if (f.kind === "issue") {
    const row = f.implement.row;
    // A fix attempt of the retired Fix stage whose PR is open keeps it too, until that stage's code goes.
    const running = (!!step && "bucket" in step) || (row?.state === "pr-opened" && fix.openPr !== null) || (fix.attempt?.state === "pr-opened" && fix.openPr !== null);
    actions.push(...unassignActions(f.assignment, f.open, !f.inScope || !!f.held || !running));
  }

  // A closed item is here for its unapplied answered close only.
  if (!f.open) actions.splice(0, actions.length, ...actions.filter((a) => a.kind === "act" && !a.params?.ask));
  const base = actions.some(isWork) ? null : !f.inScope ? "not in scope" : state === "classified" && pluginPr(f) ? PLUGIN_WAIT : WAITS[state] ?? null;
  // An issue with nothing else due waits on the PR that closes it, or on a person when its fix attempt was skipped or failed.
  let wait = base, waitKind: ItemPlan["waitKind"] = base === null ? null : f.inScope && (state === "held-duplicate" || state === "scope-open") ? "person" : "system";
  // A queued issue waits on what holds its implementation.
  if (step && "wait" in step && f.open && actions.every((x) => !isWork(x))) { wait = step.wait; waitKind = step.waitKind; }
  if (wait === null && f.kind === "issue" && f.open && f.inScope && !backlog && !f.held && actions.every((x) => !isWork(x))) {
    if (fix.openPr !== null) { wait = openPrWait(fix.openPr.number, fix.openPr.closes); waitKind = "system"; }
    else if (state === "classified") { wait = TRIAGE_WAIT; waitKind = "system"; }
  }
  return { repo: f.repo, number: f.number, kind: f.kind, state, actions, wait, waitKind };
}

/** The Work page's next-step text (rank/next.ts nextStepOf), from the item's state and, for a PR, the facts of its review-to-merge path. */
export function nextStep(item: ItemPlan, f: ItemFacts, pr: PrFacts | null): string {
  switch (item.state) {
    case "held-duplicate": case "held-backlog": return "Held: waiting for a Duplicate? answer";
    case "referee-due": return `Referee: waiting for ${f.classification.referee ? "Opus" : "Sonnet"}`;
    case "unclassified": case "waiting-haiku": return "Classify";
    case "scope-open": return "Decide: waiting for a scope answer";
    default:
  }
  const c = f.classification;
  if (item.state === "classified" && pluginPr(f)) return "Stays open as a plugin candidate";
  if (item.state === "scope-due" && c.status === "disagree") return "Decide";
  const needsDecision = c.flags.includes("needs decision") && f.repoFacts.workflow !== "new";
  if (f.kind === "issue") {
    const im = f.implement, s = im.row?.state;
    if (im.queuedBy !== null && im.settles) {
      switch (s) {
        case "planning": return "Implement: planning";
        case "asked": return "Implement: waiting for an answer";
        case "planned": case "implementing": case "checking": case "fixing": case "opening": case "revising": return "Implement: in progress";
        case "pr-opened": return "Implement: pull request opened";
        case "stuck": return "Needs a person";
        default: return "Implement";
      }
    }
    return needsDecision ? "Decide" : "Triage by a person";
  }
  if (pr && pr.ghState === "OPEN" && pr.inScope && notStarted(pr)) return "Waiting for a maintainer to start it";
  const o = pr && !pr.inScope ? pr.outside ?? null : null;
  const r = o ? o.review : pr?.review && pr.review.head === pr.head && !pr.review.stale ? pr.review.verdict : null;
  if (needsDecision && !r) return "Decide";
  switch (r) {
    case null: return "Review";
    case "take-fix": return "Fix-up";
    case "hold": return pr?.decision.hold.answer === "wait" ? "Waiting for the author" : pr?.decision.hold.open ? "Hold? decision: waiting for an answer" : "Needs a person";
    case "close": return "Close";
    default: {
      const v = o ? o.verify : pr?.verification?.state ?? null;
      if (v === "unavailable") return "Merge? decision: not verified (Verify cannot build this repo)";
      if ((o ? o.ci : pr?.ci) === "none" && pr?.repoFacts.noCi) return "Merge? decision: the repo has no CI";
      if (v === "passed" || v === "ci-enough") return "Merge queue";
      if (v === "failed" || v === "error") return pr?.decision.openQuestion || pr?.decision.asked ? "Merge? decision: verification failed" : "Needs a person: verification failed";
      return v ? "Verify: running" : "Verify";
    }
  }
}

/** Every plan of an item together. A PR's triage actions (classify, label, ...) and its review-to-merge actions can both be due: triage actions come first. */
export function decideAll(item: ItemFacts, pr: PrFacts | null = null, pass?: PassFacts): ItemView {
  const plan = decideItem(item);
  const prPlan = pr ? decidePr(pr, pass) : null;
  return {
    repo: item.repo, number: item.number, kind: item.kind, head: pr?.head ?? null, item: plan, pr: prPlan,
    actions: [...plan.actions, ...(prPlan?.actions ?? [])], next: nextStep(plan, item, pr),
  };
}
