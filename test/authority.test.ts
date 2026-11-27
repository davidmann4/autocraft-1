// Whether an action that is due may run (src/core/authority.ts): each refusal by its code, the order they are asked in, and what goes on
// while an item waits for a person. The random facts of test/invariants.test.ts hold every planned action against the same rules.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mayRun, permit } from "../src/core/authority.ts";
import { CLI_BY, type Want } from "../src/core/gates.ts";
import { guard, type Live } from "../src/core/guard.ts";
import type { RefusalCode } from "../src/core/codes.ts";
import type { ItemFacts, PrFacts, StandingFact } from "../src/core/plan.ts";
import { world } from "./world-db.ts";
import { HEAD, itemFacts, prFacts } from "./world.ts";

const MERGE: Want = { kind: "merge" }, FIX: Want = { kind: "fixup", bucket: "fix" }, REVIEW: Want = { kind: "review" }, REQUEST: Want = { ...FIX, source: "operator" };
const CONFLICT: Want = { kind: "conflict", bucket: "merge" }, ASK: Want = { kind: "fixup", bucket: "ask" }, REVISE: Want = { kind: "implement", bucket: "revise" }, PLAN: Want = { kind: "implement", bucket: "plan" };
const code = (f: PrFacts | ItemFacts, a: Want): RefusalCode | null => { const p = permit(f, a); return p.ok ? null : p.why.code; };

/** A PR whose approver's leg handed it over, with other approval inputs. */
const pr = (over: Parameters<typeof prFacts>[0] = {}) => prFacts({ handOver: true, ...over });
const may = (over: Partial<NonNullable<PrFacts["may"]["workflow"]>>, o: Parameters<typeof prFacts>[0] = {}): PrFacts => { const f = pr(o); return { ...f, may: { ...f.may, workflow: { ...f.may.workflow!, ...over } } }; };
const standing = (s: StandingFact["standing"], o: { boxIdentity?: true } = {}): StandingFact => ({ login: "maint", standing: s, ...o });
const by = (work: StandingFact, merge = work): PrFacts => pr({ standing: { merge, work } });
const unstarted = (over: Parameters<typeof prFacts>[0] = {}): PrFacts => prFacts({ workflow: null, ...over });
const revising = (over: Partial<NonNullable<PrFacts["implementation"]>> = {}, o: Parameters<typeof prFacts>[0] = {}): PrFacts => pr({ implementation: { issue: 4, state: "pr-opened", revisedHeads: [], queuedBy: "maint", standing: "yes", ...over }, ...o });
const issue = (state: string, over: Parameters<typeof itemFacts>[0] = {}): ItemFacts =>
  itemFacts({ workflow: { entry: "implement", state, approved: true, startedBy: "maint", startedAt: "2026-11-04T08:00:00.000Z", own: true }, implement: { queuedBy: "maint", standing: "yes", featureOn: true, row: null, liveInRepo: 0 }, ...over });
const ended = { state: "pr-opened", attempt: 1, textChanged: false, newCommentAfterQuestion: false, decisionAnswered: false, requeuedAfterEnd: false, asked: null, prOpen: false };

const TABLE: [string, PrFacts | ItemFacts, Want, RefusalCode | null][] = [
  ["a handed-over merge", pr(), MERGE, null],
  ["work outside the scope", pr({ inScope: false }), REVIEW, "scope"],
  ["the release of an item outside the scope", pr({ inScope: false }), { kind: "unassign" }, null],
  ["a person's close outside the scope", itemFacts({ inScope: false, close: { id: 1, by: "maint", weight: 5, at: "" } }), { kind: "act", bucket: "close" }, null],
  ["a merge outside the scope since a stop", unstarted({ inScope: false, endedWorkflow: "stopped" }), MERGE, "ended"],
  ["a merge after a stop", unstarted({ endedWorkflow: "stopped" }), MERGE, "ended"],
  ["a push after a stop", unstarted({ endedWorkflow: "stopped" }), FIX, "ended"],
  ["a merge of a duplicate", unstarted({ duplicates: { of: [2], compared: true } }), MERGE, "duplicate"],
  ["a merge while blocked", may({ state: "blocked", blocker: "other" }), MERGE, "blocked"],
  ["a merge whose blocker stands", may({ blocker: "other" }), MERGE, "blocked"],
  ["a review while blocked", may({ state: "blocked", blocker: "other" }), REVIEW, "blocked"],
  ["a person's fix-up request while blocked", may({ state: "blocked", blocker: "other" }), REQUEST, "blocked"],
  ["a review while the item asks with its recommendation", may({ state: "recommending", approvedBy: null }), REVIEW, null],
  ["an implementation while its issue is blocked", issue("blocked"), PLAN, "blocked"],
  ["an implementation of a running issue", issue("running"), PLAN, null],
  ["the end of an attempt while its issue is blocked", issue("blocked", { implement: { queuedBy: "maint", standing: "no", featureOn: false, liveInRepo: 0, row: ended } }), REVISE, null],
  ["a merge nobody approved", may({ approvedBy: null }), MERGE, "not-approved"],
  ["a push to a review-entry PR nobody approved", may({ approvedBy: null }), FIX, "not-approved"],
  ["a push to it at another head's request", may({ approvedBy: null }, { may: { fixupBy: "noor" } }), FIX, "not-approved"],
  ["an implementation nobody queued, whatever the repo approves", itemFacts(), PLAN, "not-approved"],
  ["a revision nobody queued", revising({ queuedBy: null }), REVISE, "not-approved"],
  ["a merge on the author's commits", may({ baseHead: "old" }), MERGE, "unaccepted-head"],
  ["a push on the author's commits", may({ baseHead: "old" }), CONFLICT, "unaccepted-head"],
  ["a review of the author's commits", may({ baseHead: "old" }), REVIEW, null],
  ["a push on our own push", may({ baseHead: "old" }, { may: { pushes: [{ from: "old", to: HEAD }] } }), CONFLICT, null],
  ["a push on a head accepted besides the base", may({ baseHead: null, accepted: ["old", HEAD] }), CONFLICT, null],
  ["a push to a PR nobody approved, on the author's commits", may({ baseHead: "old", approvedBy: null, entry: "fix-up" }), FIX, null],
  ["a revision on someone else's commits", may({ baseHead: "old" }, { ...revising(), workflow: { own: false } } as Parameters<typeof prFacts>[0]), REVISE, "unaccepted-head"],
  ["a revision on our own commits", may({ baseHead: null }, { ...revising(), workflow: { own: false }, may: { ownHead: true } } as Parameters<typeof prFacts>[0]), REVISE, null],
  ["a merge its leg has not handed over", may({ leg: null }), MERGE, "not-handed-over"],
  ["a review for a person who is gone", by(standing("no")), REVIEW, "actor-gone"],
  ["a push for a person who is gone", by(standing("no")), CONFLICT, "actor-gone"],
  ["a merge for an approver who is gone", by(standing("yes"), standing("no")), MERGE, "actor-gone"],
  ["other work while only the approver is gone", by(standing("yes"), standing("no")), CONFLICT, null],
  ["a person's fix-up request after its person is gone", by(standing("no")), REQUEST, "actor-gone"],
  ["a push while GitHub has not answered", by(standing("unknown")), CONFLICT, "actor-unknown"],
  ["a merge while GitHub has not answered", by(standing("unknown")), MERGE, "actor-unknown"],
  ["a review while GitHub has not answered", by(standing("unknown")), REVIEW, null],
  ["a comment while GitHub has not answered", by(standing("unknown")), ASK, null],
  ["a push under the box identity", by(standing("unknown", { boxIdentity: true })), CONFLICT, "box-identity"],
  ["an implementation while GitHub has not answered", issue("running", { standing: { merge: null, work: standing("unknown") } }), PLAN, "actor-unknown"],
  ["a close by a person who is gone, which is read live", itemFacts({ standing: { merge: null, work: standing("no") }, close: { id: 1, by: "maint", weight: 5, at: "" } }), { kind: "act", bucket: "close" }, null],
  ["a fix-up request without its maker", unstarted({ may: { fixupBy: null } }), REQUEST, "request-unnamed"],
  ["a merge the repo does not approve", unstarted({ may: { repoMerge: null } }), MERGE, "repo-approval"],
  ["a comment the repo does not approve", pr({ repoFacts: { commentApproved: false } }), ASK, "repo-approval"],
  ["a push of a stage that stopped itself", pr({ tripped: { fixup: "broke main" } }), FIX, "breaker"],
  ["an ask of a stage that stopped itself", pr({ tripped: { fixup: "broke main" } }), ASK, null],
  // The order: what a person has to settle for the item comes before what the repo or the approval says.
  ["outside the scope and blocked", may({ state: "blocked" }, { inScope: false }), MERGE, "scope"],
  ["blocked, its stage stopped", may({ state: "blocked" }, { tripped: { merge: "main is red" } }), MERGE, "blocked"],
  ["its stage stopped, its person gone", pr({ tripped: { merge: "main is red" }, standing: { merge: standing("no"), work: null } }), MERGE, "breaker"],
  ["its person gone, on the author's commits", may({ baseHead: "old" }, { standing: { merge: standing("no"), work: null } }), MERGE, "actor-gone"],
  ["on the author's commits, not handed over", may({ baseHead: "old", leg: null }), MERGE, "unaccepted-head"],
];

test("each rule refuses with its code, in order", () => {
  for (const [name, f, a, expected] of TABLE) assert.equal(code(f, a), expected, name);
  // The global switch holds back the pipeline's own jobs, whatever the permission says.
  const off = { facts: pr({ pipelineOn: false }), action: { kind: "merge", head: HEAD } } as const;
  const r = mayRun(off, "pipeline");
  assert.equal(r.ok ? null : r.why.code, "pipeline-off");
  assert.equal(mayRun(off, CLI_BY).ok, true);
});

test("a merge a person approved is made as them, everything else as the app", () => {
  assert.deepEqual(permit(pr(), MERGE), { ok: true, as: "user:maint", by: { kind: "person", login: "maint" } });
  assert.deepEqual(permit(unstarted(), MERGE), { ok: true, as: "app", by: { kind: "repo", login: "op" } });
  assert.deepEqual(permit(pr(), CONFLICT), { ok: true, as: "app", by: { kind: "person", login: "maint" } });
  assert.deepEqual(permit(issue("running"), PLAN), { ok: true, as: "app", by: { kind: "person", login: "maint" } });
});

test("a blocked item, and one whose person is gone, keep their bookkeeping and nothing else", () => {
  const KINDS = ["review", "carry", "post-review", "verify", "approve-ci", "premerge", "merge", "fixup", "conflict", "cifix", "lint", "postmerge", "implement", "unassign", "label", "classify"] as const;
  const wants = KINDS.flatMap((kind): Want[] => (kind === "fixup" || kind === "conflict" || kind === "cifix" ? ["ask", "fix", "merge", "work", "rerun"].map((bucket) => ({ kind, bucket })) : [{ kind }]));
  const goOn = (f: PrFacts): string[] => [...new Set(wants.filter((a) => permit(f, a).ok).map((a) => a.kind))];
  // Labels are judged on the item's facts.
  const bookkeeping = ["post-review", "postmerge", "unassign", "classify"];
  assert.deepEqual(goOn(revising({}, { handOver: true, may: { workflow: { ...pr().may.workflow!, state: "blocked", blocker: "other" } } })), bookkeeping);
  assert.deepEqual(goOn(revising({}, { standing: { merge: standing("no"), work: standing("no") } })), bookkeeping);
  assert.equal(permit(issue("blocked", { standing: { merge: null, work: standing("no") } }), { kind: "label" }).ok, true);
});

test("started work whose person lost access gets no review, push or merge at the write", async () => {
  const w = await (await (await world()).repo([])).acting();
  try {
    await (await w.pr(1, { mergeable: "CONFLICTING" })).review(1);
    await w.pr(2);
    await (await (await (await w.pr(3)).review(3)).verified(3)).premerge(3, "clean");
    for (const n of [1, 2, 3]) await w.workflow(n);
    await w.handedOver(3);
    await w.db.run(w.db.k.updateTable("items").set({ base_ref: "main" }));
    const live: Live = async (_, n) => ({ state: "OPEN", head: `sha${n}`, draft: false, mergeable: n === 1 ? "CONFLICTING" : "MERGEABLE" });
    const wants = [[1, { kind: "conflict", bucket: "merge" }], [2, { kind: "review" }], [3, { kind: "merge" }]] as const;
    const refused = async () => await Promise.all(wants.map(async ([n, a]) => (await guard(w.db, { repo: "app", number: n }, { ...a, head: `sha${n}` }, CLI_BY, live) as { refused?: string }).refused ?? null));
    assert.deepEqual(await refused(), [null, null, null]);
    await w.db.run(w.db.k.updateTable("repo_permissions").set({ permission: "read", checked_at: new Date().toISOString() }));
    for (const why of await refused()) assert.match(why ?? "", /can no longer act on app/);
    for (const [n, a] of wants) assert.equal((await w.prPlan(n)).actions.find((x) => x.kind === a.kind)?.permission?.ok, false, a.kind);
  } finally { w.close(); }
});

test("a blocked workflow gets no push at the write, and gets it again once a person answered", async () => {
  const w = await (await (await (await (await (await world()).repo([])).acting()).pr(1, { mergeable: "CONFLICTING" })).review(1)).workflow(1);
  try {
    await w.db.run(w.db.k.updateTable("items").set({ base_ref: "main" }).where("number", "=", 1));
    const live: Live = async () => ({ state: "OPEN", head: "sha1", draft: false, mergeable: "CONFLICTING" });
    const push = async () => await guard(w.db, { repo: "app", number: 1 }, { kind: "conflict", bucket: "merge", head: "sha1" }, CLI_BY, live) as { refused?: string };
    const set = async (state: string, blocker: string | null) => await w.db.run(w.db.k.updateTable("item_workflows").set({ state, blocker }).where("number", "=", 1));
    assert.equal((await push()).refused, undefined);
    await set("blocked", "other");
    assert.match((await push()).refused ?? "", /asks again: other/);
    assert.equal((await w.prPlan(1)).actions.find((a) => a.kind === "conflict")?.permission?.ok, false);
    await set("running", null);
    assert.equal((await push()).refused, undefined);
  } finally { w.close(); }
});
