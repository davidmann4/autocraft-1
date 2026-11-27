// Invariants of the Plan, checked on random facts: whatever the facts, decide() and gates() never plan a write that the rules
// forbid, and an open pull request in scope is never left with nothing that moves it and nobody it waits on. The random pull
// requests and their facts are test/random-pr.ts. Set INVARIANT_SEED to replay a failing run, INVARIANT_CASES to try more of them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decideItem } from "../src/core/decide-item.ts";
import { decidePr, premergeFix } from "../src/core/decide.ts";
import { permit, wantOf } from "../src/core/authority.ts";
import type { RefusalCode } from "../src/core/codes.ts";
import { gates, mergeMay } from "../src/core/gates.ts";
import { isWork } from "../src/core/assignment.ts";
import type { Action, ItemFacts, Plan, PrFacts } from "../src/core/plan.ts";
import type { PlanSet } from "../src/core/plan-set.ts";
import { planned } from "../src/core/select.ts";
import type { Db } from "../src/db/index.ts";
import { LANE_KINDS, LANES, type PlanCtx } from "../src/runner/autopilot.ts";
import { factsOf, greenRows, headOf, prng, randomPrRows, reached, reviewed, rnd, startedAs, type PrRows, type Rnd } from "./random-pr.ts";
import { randomItem } from "./random-item.ts";

const CASES = Number(process.env.INVARIANT_CASES ?? 4000);

const has = (p: Plan, kind: string, pred: (a: Action) => boolean = () => true) => p.actions.filter((a) => a.kind === kind && pred(a));
const label = (a: Action) => a.kind + (a.params?.bucket ? `:${String(a.params.bucket)}` : "") + (a.params?.source ? `/${String(a.params.source)}` : "");
/** An action that pushes a commit to the PR's branch. */
const pushes = (f: PrFacts, a: Action): boolean => {
  const b = a.params?.bucket;
  return (a.kind === "fixup" && b === "fix") || (a.kind === "conflict" && b === "merge") || (a.kind === "cifix" && f.pushable && (b === "work" || b === "collect")) || (a.kind === "lint" && f.pushable);
};

// ---- who approved what, read off the rows (the rules of the workflow, apart from src/core/may.ts)

/** Why nobody's approval covers a merge at the head; null when one does. */
function mergeUncovered(w: PrRows): string | null {
  const wf = w.workflow, head = headOf(w);
  if (!wf) return w.ended !== null ? `it ended ${w.ended}` : w.duplicates && w.ghState === "OPEN" ? "a duplicate" : w.approvals.merge ? null : "the repo does not approve merges";
  if (wf.state === "blocked") return "the workflow is blocked";
  if (!wf.approvedBy) return "nobody approved the merge";
  const leg = w.legs.find((l) => l.workflow === wf.id);
  if (!leg || leg.state !== "queued" || leg.head !== head) return "the leg did not hand it over at the head";
  if (w.standing && w.standing.merge !== "yes") return `the approver's standing is ${w.standing.merge}`;
  // An issue's workflow accepts the heads its leg accepted.
  return wf.kind === "issue" || reached(w, wf.baseHead, head) ? null : "someone else's commits are on the accepted head";
}

/** Why nobody's approval covers the action's push; null when one does. */
function pushUncovered(w: PrRows, a: Action): string | null {
  const wf = w.workflow;
  if (wf && w.standing && w.standing.work !== "yes") return `the standing of whom it acts for is ${w.standing.work}`;
  if (a.params?.source === "operator") return w.request?.from === headOf(w) ? null : "nobody asked for a fix-up of the head";
  if (!wf) return w.ended !== null ? `it ended ${w.ended}` : w.approvals.push ? null : "the repo does not approve pushes";
  return wf.entry !== "review" || wf.approvedBy ? null : "a review nobody approved anything after";
}

/** What goes on while the workflow waits for a person: bookkeeping. */
const GOES_ON = ["unassign", "post-review", "postmerge"];
/** The refusals of a planned action that name what the PR waits for: the question that is asked, the one the next workflow pass asks, or GitHub's answer on a person. */
const NAMED: readonly RefusalCode[] = ["blocked", "unaccepted-head", "actor-gone", "actor-unknown", "box-identity"];
const refusalOf = (f: PrFacts, a: Action): RefusalCode | null => { const r = permit(f, wantOf(a)); return r.ok ? null : r.why.code; };
const named = (f: PrFacts, a: Action): boolean => { const c = refusalOf(f, a); return c !== null && NAMED.includes(c); };

type Case = { w: PrRows; f: PrFacts; p: Plan };
type Violation = { rule: string; detail: string };

function safety({ w, f, p }: Case): Violation[] {
  const out: Violation[] = [];
  const need = (rule: string, ok: unknown, detail: string): void => void (ok || out.push({ rule, detail }));
  const merges = has(p, "merge"), mergeEntry = f.workflow?.entry === "merge" && !f.reviewOwed;
  const runs = (a: Action): boolean => gates(f, wantOf(a), "pipeline") === null;

  if (!f.inScope) need("out-of-scope", p.actions.every((a) => !isWork(a)), "work for an out-of-scope PR");
  for (const a of p.actions) {
    if (a.kind !== "postmerge" && a.kind !== "unassign") need("head", a.head === p.head || (a.kind === "implement" && f.ghState !== "OPEN"), `${label(a)} at a head other than the plan's`);
    if (a.kind === "fixup" && a.params?.bucket === "fix") need("pushable", f.pushable, `${label(a)} on a branch that cannot be pushed to`);
    if (!f.pipelineOn) need("pipeline-off", !runs(a), `${label(a)} passes the gates with the pipeline off`);
    if (pushes(f, a)) need("changes-requested-push", !f.changesRequested || a.params?.source === "operator", `${label(a)} while a maintainer requests changes`);
    if (pushes(f, a) && runs(a)) {
      const why = pushUncovered(w, a);
      need("push-approved", why === null, `${label(a)}: ${why}`);
      need("blocked-push", w.workflow?.state !== "blocked", `${label(a)} while the workflow is blocked`);
      need("unaccepted-push", !w.workflow || w.workflow.kind === "issue" || !w.workflow.approvedBy || reached(w, w.workflow.baseHead, headOf(w)), `${label(a)} on commits the workflow did not accept`);
    }
    if (a.kind === "implement" && f.ghState === "OPEN") need("revise-standing", w.workflow?.kind === "issue" && f.implementation?.standing === "yes", "a revision nobody who may act commanded");
    // Bookkeeping aside (the end of an attempt, too), nothing runs while the workflow asks a person, or for people who are gone.
    if (!GOES_ON.includes(a.kind) && !(a.kind === "implement" && f.ghState !== "OPEN") && runs(a)) {
      need("blocked-work", w.workflow?.state !== "blocked", `${label(a)} while the workflow is blocked`);
      need("gone-work", !w.workflow || !w.standing || (a.kind === "merge" ? w.standing.merge : w.standing.work) !== "no", `${label(a)} for a person who may not act on the repo`);
    }
    if (a.kind === "implement" && f.ghState === "OPEN" && runs(a)) need("revise-unknown", !w.standing || w.standing.work === "yes", "a revision for a person nobody knows may act");
  }
  // The verdict of every merge, planned or not: the gates let exactly the covered ones through.
  if (f.inScope && !f.integration) {
    const uncovered = mergeUncovered(w), gate = gates(f, { kind: "merge" }, "pipeline"), stopped = !f.pipelineOn || f.tripped?.merge !== undefined;
    need("merge-approved", gate !== null || uncovered === null, `the merge passes the gates: ${uncovered}`);
    need("merge-covered", stopped || gate === null || uncovered !== null, `a covered merge is refused: ${gate}`);
    if (gate === null && w.workflow) {
      need("merge-head", reached(w, w.workflow.kind === "issue" ? w.legs.find((l) => l.workflow === 7)!.head : w.workflow.baseHead, headOf(w)), "a merge at a head the accepted head does not lead to");
      need("merge-as", (() => { const m = mergeMay(f); return m.ok && m.as === "person"; })(), "the merge of a started PR is not its approver's");
    }
    if (gate === null) need("merge-stopped", w.workflow?.state !== "blocked" && w.ended === null, "a merge while blocked or after its workflow ended");
  }
  // An unsure head merges only when a PR approved for merge was handed over at it.
  if (f.review?.unsure && !mergeEntry && merges.length) need("unsure", f.handOver && w.workflow?.approvedBy, "merge on an unsure head that nobody handed over");
  // A merge entry whose head holds a push of ours that a model has to read gets that review, unless something names what it waits for.
  if (f.reviewOwed && f.ghState === "OPEN" && f.inScope && !f.draft && !f.pushedOff && !(f.review && f.review.head === f.head)) need("owed-review", has(p, "review").length || has(p, "carry").length || p.wait !== null, "nothing plans the review our push owes");
  if (merges.length) {
    if (w.workflow) need("unapproved", w.workflow.approvedBy && f.handOver, "merge of a started PR that nobody handed over");
    if (!mergeEntry) need("reviewed", f.review && f.review.head === f.head && (f.review.verdict === "take" || f.review.verdict === "take-fix"), "merge without a take review of the head");
    if (p.path === "rule") {
      need("premerge", f.premerge && f.premerge.hasFindings && f.premerge.defects === 0, "rule merge without a clean pre-merge review");
      need("ci", f.ci === "success", "rule merge with CI not green");
      need("verified", ["passed", "ci-enough"].includes(f.verification?.state ?? ""), "rule merge with verification not ok");
    } else need("path", p.path === "operator", `merge on the path ${p.path}`);
    need("base", !f.baseOffDefault, "merge into another branch than the default");
    need("changes-requested", f.changesRequested === null, "merge while changes are requested");
    need("mergeable", f.mergeable === "MERGEABLE" && f.ghState === "OPEN" && !f.draft, "merge of a PR not open, a draft or not mergeable");
    need("backlog", !f.heldBacklog, "merge of a PR in the backlog");
    // A hold or close review at the head is merged past only by a person who answered after it.
    if (w.review && !mergeEntry && w.review.head === f.head && (w.review.verdict === "hold" || w.review.verdict === "close")) need("answered-past", w.legs.some((l) => l.head === f.head && l.updatedAt > "2026-11-04T10:00:00.000Z"), "merge past a hold or close review nobody answered after");
    need("batch", f.batch === null, "single merge of a batch member");
    need("ci", f.ci === "success", "merge with CI not green");
  }
  // A person's approval stands whatever the repo's step approvals are: the plan and its gates are the same with all of them on and off.
  if (w.workflow) {
    const all = (on: boolean): PrRows => ({ ...w, approvals: { ...w.approvals, merge: on, push: on, fixissue: on } });
    const view = (v: PrRows): string => { const g = factsOf(v), q = decidePr(g); return JSON.stringify({ ...q, actions: q.actions.map((a) => [label(a), gates(g, wantOf(a), "pipeline") === null]) }); };
    const on = view(all(true)), off = view(all(false));
    need("person-approval", on === off, `with the repo's approvals ${on}\n  without them ${off}`);
  }
  // The leg of an approved PR waits while the defects' fix-up can be made: the plan makes it, or says what comes first.
  if (f.operator?.premerge && premergeFix(f) === "fix" && f.ci === "success" && f.mergeable === "MERGEABLE" && !f.pushedOff) {
    need("premerge-fix", p.wait !== null || has(p, "fixup").length || has(p, "verify").length || f.operator.fix || f.draft || !f.review || f.review.stale, "a pre-merge fix-up that can be made is not planned");
  }
  // A refused merge of a started PR is never all there is: something says what it waits for.
  if (w.workflow) for (const a of merges) if (runs(a) === false && f.pipelineOn && !f.tripped?.merge && !named(f, a)) {
    need("refused-merge", p.wait !== null || f.operator?.hold, `a merge its gate refuses (${gates(f, wantOf(a), "pipeline")}) with no wait and no leg at work`);
  }
  return out;
}

/** The lanes whose detect needs nothing but the pass's Plans: run as they are. The others read more first, and are asked for their planned and allowed actions. */
const PURE_LANES = LANES.filter((l) => ["cifix", "cifix-rerun", "review-carry", "review-post", "premerge", "implement"].includes(l.name));
const NO_DB = new Proxy({}, { get: (_t, k) => { throw new Error(`a lane read the database (${String(k)})`); } }) as Db;

/** Whether some lane takes one of the PR's actions: work the gates let through. */
async function taken({ f, p }: Pick<Case, "f" | "p">): Promise<string | null> {
  const plans: PlanSet = { run: "r1", now: f.now, pass: { rereadPaceAt: 0 }, prs: [{ facts: f, plan: p }], items: [] };
  const ctx: PlanCtx = { run: "r1", tracked: ["app"], plans, wake: [] };
  for (const lane of PURE_LANES) if ((await lane.detect(NO_DB, ctx)).length) return lane.name;
  for (const name of ["review", "merge", "fixup", "verify", "ci-approve"]) {
    for (const k of name === "fixup" ? [...LANE_KINDS[name]!, "lint" as const] : LANE_KINDS[name]!) {
      const due = (await planned(NO_DB, k, { plans })).filter((x) => k !== "lint" || x.action.params?.bucket !== "cifix");
      if (due.some((x) => gates(f, wantOf(x.action), "pipeline") === null)) return name;
    }
  }
  return null;
}

/** States that end the work on an open PR, or that a person or its author put it in. */
const TERMINAL = ["out-of-scope", "integration", "backlog", "held-backlog", "closed", "merged"];

/** An approved item's merge leg is at work, or the next workflow pass starts it (or blocks the item). */
const underWay = (w: PrRows): boolean => !!w.workflow?.approvedBy && w.workflow.state !== "blocked" && w.workflow.state !== "recommending";
/** System waits on AutoCraft's own steps: each ends only while the step it names can still run. */
const OWN_WAITS: Record<string, (c: Case) => boolean> = {
  "the pre-merge review": ({ w, f }) => (!!f.premerge && !f.premerge.hasFindings) || underWay(w),
  verification: ({ f }) => ["planned", "running"].includes(f.verification?.state ?? ""),
  "the approved merge to be handed over to its approver": ({ w }) => underWay(w) || w.legs.length > 0,
  "the workflow's steps before the merge": ({ w }) => underWay(w) || w.legs.length > 0,
  "its pre-approved merge": ({ w }) => underWay(w) || w.legs.length > 0 || w.request !== null,
  "the review's fixes to be applied": ({ f }) => f.lint.length > 0 || f.implementation?.state === "revising",
  "the formatter or lint run of the CI fix": ({ f }) => (f.cifix?.formattingTask != null && !f.cifix.formatterEnded) || f.lint.some((l) => l.step === "cifix" && !l.ended),
  "the lint run of the conflict resolution": ({ f }) => f.lint.some((l) => l.step === "conflict" && !l.ended),
  "its batch": ({ w }) => w.batch !== null,
};

async function progress(c: Case): Promise<Violation[]> {
  const { w, f, p } = c;
  if (f.ghState !== "OPEN" || !f.inScope || f.gone || TERMINAL.includes(p.state)) return [];
  // Every action the gates let through is one a lane takes.
  const out: Violation[] = [];
  for (const a of p.actions) if (isWork(a) && gates(f, wantOf(a), "pipeline") === null && !await taken({ f, p: { ...p, actions: [a] } })) out.push({ rule: "untaken", detail: `no lane takes ${label(a)}` });
  if (await taken(c)) return out;
  if (p.wait === null) return p.actions.some((a) => isWork(a) && named(f, a)) ? out : [...out, { rule: "dead-end", detail: `state ${p.state}, actions [${p.actions.map(label).join(", ")}], no lane takes one and nothing is waited for` }];
  const ends = p.waitKind === "system" ? OWN_WAITS[p.wait] : undefined;
  return ends && !ends(c) ? [...out, { rule: "false-wait", detail: `waits for ${p.wait}, which nothing is working on` }] : out;
}

function checkItem(f: ItemFacts): void {
  const p = decideItem(f);
  const writes = p.actions.filter((a) => ["label", "implement", "act"].includes(a.kind));
  // 6. Out of scope: no write, except the close a person asked for.
  if (!f.inScope) for (const a of writes) assert.ok(a.kind === "act" && f.close !== null && a.params?.id === f.close.id, `${label(a)} for an out-of-scope item`);
  // A Backlog hold stops labelling, closing and fixing.
  if (f.held === "backlog") assert.deepEqual(writes, [], "write for an item held by Backlog");
  // A closed item has only its close left.
  if (!f.open) assert.ok(p.actions.every((a) => a.kind === "act"), "action for a closed item other than its close");
  // A person's command is the approval of the implementation or the close, whatever the repo approves.
  const bare: ItemFacts = { ...f, repoFacts: { labelsApproved: false, commentApproved: false } };
  for (const a of decideItem(bare).actions) if (["implement", "act"].includes(a.kind) && f.pipelineOn) assert.equal(gates(bare, wantOf(a), "pipeline"), null, `${label(a)} needs a repo approval`);
  if (!f.pipelineOn) for (const a of p.actions) assert.ok(gates(f, wantOf(a), "pipeline"), `${label(a)} passes the gates with the pipeline off`);
  for (const a of writes) if (a.kind === "implement") assert.equal(f.kind, "issue", "implement for a PR");
  // A blocked item runs no implementation, but the end of its attempt.
  const blocked: ItemFacts = { ...f, workflow: { entry: "implement", state: "blocked", approved: true, startedBy: "maint", startedAt: "2026-11-04T08:00:00.000Z", own: true } };
  const ending = f.implement.row?.state === "pr-opened" && !f.implement.row.prOpen;
  for (const a of decideItem(blocked).actions) if (a.kind === "implement") assert.equal(a.permission?.ok, ending, `${label(a)} while the workflow is blocked`);
  // Implement runs only for an issue queued by someone who settles on the repo, with the repo's Implement switch on; ending
  // an attempt whose PR merged or closed is bookkeeping and needs no switch.
  if (p.actions.some((a) => a.kind === "implement")) assert.ok(f.implement.queuedBy !== null && f.implement.standing === "yes" && (f.implement.featureOn || ending), "implement for an issue not queued by a settler or with Implement off");
}

/** Every planned action is refused at the gates, some of them for `why`. */
const refusedFor = (c: Case, why: RegExp): boolean => {
  const refusals = c.p.actions.filter(isWork).map((a) => gates(c.f, wantOf(a), "pipeline"));
  return refusals.every((r) => r !== null) && refusals.some((r) => why.test(r!));
};

/** A failure of a rule that stands: the cases it covers and why. `example` still fails, so an entry does not outlive its reason. */
type Exception = { id: string; rules: string[]; why: string; covers: (c: Case) => boolean; example: PrRows };
const EXCEPTIONS: Exception[] = [
  {
    id: "pipeline-off", rules: ["dead-end"], why: "The plan shows what would run with the pipeline on.",
    covers: (c) => refusedFor(c, /^The pipeline is off$/), example: greenRows({ pipelineOn: false }),
  },
  {
    id: "request-window", rules: ["dead-end", "false-wait"], why: "A fix-up request that cannot run (any more) holds the fix-ups of the reviews back until the next leg pass ends the request (endStaleRequests).",
    covers: ({ f, p }) => !!f.operator?.fix && !p.actions.some((a) => a.params?.source === "operator"), example: greenRows({ request: { from: "c0", by: "noor", id: 41 }, pushable: false, legs: [], review: reviewed("take-fix"), workflow: startedAs("fixup", { approvedBy: null }) }),
  },
  {
    id: "opus-close", rules: ["dead-end"], why: "A review that says close plans no wait: the workflow asks for a started PR, and an unstarted one waits for someone to pick it up.",
    covers: ({ p }) => p.state === "opus-close", example: greenRows({ workflow: null, legs: [], review: reviewed("close") }),
  },
];

const caseOf = (w: PrRows): Case => { const f = factsOf(w); return { w, f, p: decidePr(f) }; };
const violations = async (c: Case): Promise<Violation[]> => [...safety(c), ...await progress(c)];

test("the plan of a pull request never plans a forbidden write and never ends with nothing to move it", async () => {
  const seed = process.env.INVARIANT_SEED ? Number(process.env.INVARIANT_SEED) : (Date.now() & 0x7fffffff);
  const x = rnd(prng(seed));
  for (let i = 0; i < CASES; i++) {
    const c = caseOf(randomPrRows(x));
    for (const v of await violations(c)) {
      if (!EXCEPTIONS.some((e) => e.rules.includes(v.rule) && e.covers(c))) assert.fail(`INVARIANT_SEED=${seed} case ${i}: ${v.rule}: ${v.detail}\n${JSON.stringify(c.w)}\n${JSON.stringify(c.p)}`);
    }
  }
});

test("a green PR that its approver handed over breaks no rule, and every exception still fails on its example", async () => {
  assert.deepEqual(await violations(caseOf(greenRows())), []);
  for (const e of EXCEPTIONS) {
    const c = caseOf(e.example);
    assert.ok(e.covers(c) && (await violations(c)).some((v) => e.rules.includes(v.rule)), `${e.id} no longer happens: remove it`);
  }
});

test("the CI fix lane takes the asks and the notes of a fix it gave up", async () => {
  const failed = (n: number): PrRows["patches"] => ({ fixups: [], conflicts: [], pushes: [], cifixes: Array.from({ length: n }, (_, i) => ({ id: i, repo: "app", number: 1, createdAt: "2026-11-04T09:30:00.000Z", reason: null, attempt: 1, head: i < 2 ? "c0" : "old", toHead: null, kind: "code" as const, state: "failed", files: [], taskId: null, lintTask: null, runs: null })) });
  const red = { legs: [], checks: { head: "c0", overall: "failure" as const, approvedRuns: false } };
  for (const [action, w] of [["cifix:ask", greenRows({ ...red, patches: failed(2), workflow: startedAs("fixup", { approvedBy: null }) })], ["cifix:capped", greenRows({ ...red, patches: failed(4), approvals: { merge: true, push: true, comment: false, ci: true, fixissue: true } })]] as const) {
    const c = caseOf(w);
    assert.deepEqual(c.p.actions.filter(isWork).map(label), [action]);
    assert.equal(await taken(c), "cifix", action);
  }
});

test("the plan of an item never plans a forbidden write", () => {
  const seed = process.env.INVARIANT_SEED ? Number(process.env.INVARIANT_SEED) : (Date.now() & 0x7fffffff);
  const x = rnd(prng(seed));
  for (let i = 0; i < CASES; i++) {
    const item = randomItem(x);
    try { checkItem(item); } catch (e) {
      throw new Error(`INVARIANT_SEED=${seed} case ${i}: ${(e as Error).message}\n${JSON.stringify(item)}`, { cause: e });
    }
  }
});
