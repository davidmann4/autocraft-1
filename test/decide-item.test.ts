// The decision table for the triage steps of open items (issues and PRs): facts overrides in, state and due actions out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BOX_IDENTITY_WAIT, decideAll, decideItem } from "../src/core/decide-item.ts";
import { TYPE_LABEL_NAMES } from "../src/core/item-rules.ts";
import type { ItemPlan } from "../src/core/plan.ts";
import { TYPE_LABELS } from "../src/labels/set.ts";
import { NOW, itemFacts, prFacts } from "./world.ts";

type Over = Parameters<typeof itemFacts>[0];
type Row = { name: string; facts: Over; expect: { state: string; actions?: string[]; next?: string; wait?: string | null; bucket?: string } };

const tokens = (p: ItemPlan): string[] => p.actions.map((a) => a.kind).sort();
const T = "2026-11-04";
const jev = (o: Partial<{ at: string; changed: boolean; unsure: boolean }> = {}) => ({ at: `${T}T08:00:00.000Z`, changed: false, unsure: false, ...o });
const disagree = (o: Over = {}): Over => ({ classification: { status: "disagree", label: null, jevLabel: "bugfix", haikuLabel: "infra", jev: jev({ unsure: true }), haiku: { at: `${T}T09:00:00.000Z`, aloneCurrent: false }, ...(o?.classification ?? {}) } });
const needsDecision: Over = { classification: { flags: ["needs decision"] }, labels: { existing: ["bugfix", "needs decision"] } };
type ImplementRow = NonNullable<ReturnType<typeof itemFacts>["implement"]["row"]>;
const attempt = (state: string, o: Partial<ImplementRow> = {}): ImplementRow => ({ state, attempt: 1, textChanged: false, newCommentAfterQuestion: false, decisionAnswered: false, requeuedAfterEnd: false, asked: null, prOpen: false, ...o });
/** An issue queued by a settler, in a repo with Implement on. */
const queued = (o: Over = {}): Over => ({ ...o, implement: { queuedBy: "maint", standing: "yes", featureOn: true, row: null, liveInRepo: 0, ...(o?.implement ?? {}) } });
const close = () => ({ id: 1, by: "mira", weight: 5, at: `${T}T08:00:00.000Z` });
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

const rows: Row[] = [
  { name: "a classified, labelled, embedded issue has nothing due", facts: {}, expect: { state: "classified", actions: [], next: "Triage by a person", wait: "an open request for a person to pick up" } },

  // ---- classify
  { name: "no verdict in the run: Jev is due", facts: { classification: { status: "unclassified", label: null, jevLabel: null, jev: null } }, expect: { state: "unclassified", actions: ["classify"], next: "Classify" } },
  { name: "no classification run yet: nothing to classify", facts: { run: null, classification: { status: "unclassified", label: null, jevLabel: null, jev: null } }, expect: { state: "unclassified", actions: [] } },
  { name: "the item's text changed since Jev's verdict", facts: { classification: { jev: jev({ changed: true }) } }, expect: { state: "classified", actions: ["classify"] } },
  { name: "Haiku classified it alone at the current text: not due for Jev", facts: { classification: { status: "settled", jev: null, haiku: { at: `${T}T08:00:00.000Z`, aloneCurrent: true } } }, expect: { state: "classified", actions: [] } },
  { name: "Jev unsure, no Haiku verdict: Haiku is due", facts: { classification: { status: "waiting", label: null, jev: jev({ unsure: true }) } }, expect: { state: "waiting-haiku", actions: ["classify"], next: "Classify" } },
  { name: "Haiku older than Jev: Haiku is due again", facts: { classification: { status: "waiting", label: null, jev: jev({ unsure: true }), haiku: { at: `${T}T07:00:00.000Z`, aloneCurrent: false } } }, expect: { state: "waiting-haiku", actions: ["classify"] } },
  { name: "Haiku as new as Jev's verdict: not due", facts: { classification: { status: "settled", jev: jev({ unsure: true }), haiku: { at: `${T}T09:00:00.000Z`, aloneCurrent: false } } }, expect: { state: "classified", actions: [] } },
  { name: "an item out of scope is not classified", facts: { inScope: false, classification: { status: "unclassified", label: null, jev: null } }, expect: { state: "unclassified", wait: "not in scope" } },
  { name: "our own integration PR is not classified", facts: { kind: "pr", integration: true, classification: { status: "unclassified", label: null, jev: null } }, expect: { state: "unclassified", actions: [] } },
  { name: "a held item is still classified", facts: { held: "backlog", classification: { status: "unclassified", label: null, jev: null } }, expect: { state: "held-backlog", actions: ["classify"], next: "Held" } },

  // ---- referee and disagreement
  { name: "labels disagree, Sonnet has not answered", facts: disagree(), expect: { state: "referee-due", actions: ["referee"], next: "Referee: waiting for Sonnet" } },
  { name: "labels disagree, Sonnet was unsure: Opus is due", facts: disagree({ classification: { referee: { sure: false, final: false } } }), expect: { state: "referee-due", actions: ["referee"], next: "Referee: waiting for Opus" } },
  { name: "Sonnet sure: settled with its label", facts: { classification: { status: "settled", label: "infra", referee: { sure: true, final: false }, jevLabel: "bugfix", haikuLabel: "infra", jev: jev({ unsure: true }), haiku: { at: `${T}T09:00:00.000Z`, aloneCurrent: false } }, labels: { existing: ["infra"] } }, expect: { state: "classified", actions: [] } },
  { name: "both labels are scope labels: no referee and no label", facts: disagree({ classification: { jevLabel: "missing feature", haikuLabel: "small extra" } }), expect: { state: "classified", actions: [], next: "Triage by a person" } },
  { name: "one scope label is refereed", facts: disagree({ classification: { jevLabel: "missing feature" } }), expect: { state: "referee-due", actions: ["referee"], next: "Referee: waiting for Sonnet" } },
  { name: "a draft is not refereed", facts: { ...disagree(), draft: true }, expect: { state: "referee-due", actions: [], wait: "the label referee" } },
  { name: "a held item is not refereed", facts: { ...disagree(), held: "backlog" }, expect: { state: "held-backlog", actions: [] } },

  // ---- prioritize, embed
  { name: "no priority row", facts: { priorityHash: null }, expect: { state: "classified", actions: ["prioritize"] } },
  { name: "priority made at older text", facts: { priorityHash: "old" }, expect: { state: "classified", actions: ["prioritize"] } },
  { name: "no priority row while Jev's classify call is due: that request asks the impact", facts: { priorityHash: null, classification: { jev: jev({ changed: true }) } }, expect: { state: "classified", actions: ["classify"] } },
  { name: "no priority row after a classify request failed for the item's current input: prioritize asks it", facts: { priorityHash: null, classification: { jev: jev({ changed: true }), jevFailed: true } }, expect: { state: "classified", actions: ["classify", "prioritize"] } },
  { name: "no priority row while only Haiku's classify call is due: prioritize asks it", facts: { priorityHash: null, classification: { status: "waiting", label: null, jev: jev({ unsure: true }) } }, expect: { state: "waiting-haiku", actions: ["classify", "prioritize"] } },
  { name: "no vector for the current model", facts: { embeddedHash: null }, expect: { state: "classified", actions: ["embed"] } },
  { name: "vector of older text: embed again, no scan until it is current", facts: { embeddedHash: "old", scannedHash: null }, expect: { state: "classified", actions: ["embed"] } },
  { name: "embed does not depend on scope", facts: { inScope: false, embeddedHash: null }, expect: { state: "classified", actions: ["embed"] } },
  { name: "out of scope: priority waits", facts: { inScope: false, priorityHash: null }, expect: { state: "classified", actions: [] } },

  // ---- duplicates
  { name: "embedded and not scanned yet", facts: { scannedHash: null }, expect: { state: "classified", actions: ["dupes"] } },
  { name: "scanned at older text", facts: { scannedHash: "old" }, expect: { state: "classified", actions: ["dupes"] } },
  { name: "in an unchecked pair", facts: { pairsToCheck: 2 }, expect: { state: "classified", actions: ["dupes"] } },
  { name: "an out-of-scope item whose partner is in scope is still in the pair check", facts: { inScope: false, pairsToCheck: 1 }, expect: { state: "classified", actions: ["dupes"] } },
  { name: "member of a set to compare", facts: { inCompareSet: "model" }, expect: { state: "classified", actions: ["dupes-compare"] } },
  { name: "pair check and compare together", facts: { pairsToCheck: 1, inCompareSet: "model" }, expect: { state: "classified", actions: ["dupes", "dupes-compare"] } },

  // ---- plugin candidates and failed referees
  { name: "a PR settled as plugin candidate stays open with its label", facts: { kind: "pr", classification: { label: "plugin candidate" }, labels: { existing: ["plugin candidate"] } }, expect: { state: "classified", actions: [], wait: "stays open as a plugin candidate", next: "Stays open as a plugin candidate" } },
  { name: "a failed Opus call is not repeated within the backoff", facts: disagree({ classification: { referee: { sure: false, final: false, failedAt: new Date(NOW - 60_000).toISOString() } } }), expect: { state: "referee-due", actions: [], wait: "the label referee" } },

  // ---- labels
  { name: "a settled type label is missing on GitHub", facts: { labels: { existing: [] } }, expect: { state: "classified", actions: ["label"] } },
  { name: "flags are added next to the type", facts: { classification: { flags: ["security"] }, labels: { existing: ["bugfix"] } }, expect: { state: "classified", actions: ["label"] } },
  { name: "another type label is on the item: conflict, nothing added", facts: { labels: { existing: ["infra"] } }, expect: { state: "classified", actions: [] } },
  { name: "label match ignores case", facts: { labels: { existing: ["Bugfix"] } }, expect: { state: "classified", actions: [] } },
  { name: "the previous pass already added them", facts: { labels: { existing: [], labeledNote: "added: bugfix" } }, expect: { state: "classified", actions: [] } },
  { name: "labelling approval is a fact: gates() applies it, not decideItem", facts: { labels: { existing: [] }, repoFacts: { labelsApproved: false } }, expect: { state: "classified", actions: ["label"] } },
  { name: "a Backlog hold stops labelling", facts: { labels: { existing: [] }, held: "backlog" }, expect: { state: "held-backlog", actions: [] } },
  { name: "an unsettled item is not labelled", facts: { classification: { status: "waiting", label: null, jev: jev({ unsure: true }), haiku: { at: `${T}T09:00:00.000Z`, aloneCurrent: false } }, labels: { existing: [] } }, expect: { state: "waiting-haiku", actions: [] } },

  // ---- act
  { name: "a person's close is carried out", facts: { close: close() }, expect: { state: "classified", actions: ["act"] } },
  { name: "a closed item gets nothing but its close: no classify, embed, prioritize or label", facts: { open: false, priorityHash: null, embeddedHash: null, classification: { status: "unclassified", label: null, jev: null }, close: close() }, expect: { state: "unclassified", actions: ["act"] } },
  { name: "a closed item without one has nothing due", facts: { open: false, embeddedHash: null }, expect: { state: "classified", actions: [] } },
  { name: "a Backlog hold stops the close", facts: { held: "backlog", close: close() }, expect: { state: "held-backlog", actions: [] } },
  { name: "a close applies outside the scope, also to an item whose workflow it ended", facts: { inScope: false, endedWorkflow: "closed", close: close() }, expect: { state: "classified", actions: ["act"] } },
  { name: "comment approval is a fact: gates() applies it, not decideItem", facts: { repoFacts: { commentApproved: false }, close: close() }, expect: { state: "classified", actions: ["act"] } },

  // ---- implement
  { name: "a settled bugfix issue nobody queued is left for a person", facts: {}, expect: { state: "classified", actions: [], wait: "an open request for a person to pick up", next: "Triage by a person" } },
  { name: "a queued issue is planned", facts: queued(), expect: { state: "classified", actions: ["implement"], bucket: "plan", next: "Implement" } },
  { name: "Implement off for the repo: the queued issue waits on it", facts: queued({ implement: { featureOn: false } }), expect: { state: "classified", actions: [], wait: "Implement is off for app" } },
  { name: "queued by someone who no longer settles", facts: queued({ implement: { standing: "no" } }), expect: { state: "classified", actions: [], wait: "an open request for a person to pick up" } },
  { name: "GitHub has not answered on who queued it: nothing runs, nobody is asked", facts: queued({ implement: { standing: "unknown", row: attempt("planned") } }), expect: { state: "classified", actions: [], wait: "GitHub's answer on maint's access to app" } },
  { name: "under the box identity the wait names it", facts: queued({ implement: { standing: "unknown", boxIdentity: true, row: attempt("planned") } }), expect: { state: "classified", actions: [], wait: BOX_IDENTITY_WAIT } },
  { name: "a queued PR is not implemented", facts: queued({ kind: "pr" }), expect: { state: "classified", actions: [] } },
  { name: "the repo's live implementations are full", facts: queued({ implement: { liveInRepo: 2 } }), expect: { state: "classified", actions: [], wait: "2 implementations already running in app" } },
  { name: "an open PR closes the queued issue", facts: queued({ openPr: { number: 7, closes: true } }), expect: { state: "classified", actions: [], wait: "open PR #7, which closes it: answer that pull request" } },
  { name: "a PR that only mentions the queued issue does not hold it", facts: queued({ openPr: { number: 7, closes: false } }), expect: { state: "classified", actions: ["implement"], bucket: "plan" } },
  { name: "a Backlog hold stops it", facts: queued({ held: "backlog" }), expect: { state: "held-backlog", actions: [] } },
  { name: "a stored plan is built", facts: queued({ implement: { row: attempt("planned") } }), expect: { state: "classified", actions: ["implement"], bucket: "build", next: "Implement: in progress" } },
  { name: "a session cut off by a restart is built again", facts: queued({ implement: { row: attempt("checking"), liveInRepo: 2 } }), expect: { state: "classified", actions: ["implement"], bucket: "build" } },
  { name: "an interrupted revision resumes", facts: queued({ implement: { row: attempt("revising") } }), expect: { state: "classified", actions: ["implement"], bucket: "revise" } },
  { name: "a question waits for the author", facts: queued({ implement: { row: attempt("asked", { asked: "author" }) } }), expect: { state: "classified", actions: [], wait: "the author's answer", next: "Implement: waiting for an answer" } },
  { name: "a question waits for a maintainer", facts: queued({ implement: { row: attempt("asked", { asked: "maintainer" }) } }), expect: { state: "classified", actions: [], wait: "a maintainer's answer" } },
  { name: "a comment after the question plans again", facts: queued({ implement: { row: attempt("asked", { asked: "author", newCommentAfterQuestion: true }) } }), expect: { state: "classified", actions: ["implement"], bucket: "plan" } },
  { name: "an answered question plans again", facts: queued({ implement: { row: attempt("asked", { asked: "maintainer", decisionAnswered: true }) } }), expect: { state: "classified", actions: ["implement"], bucket: "plan" } },
  { name: "a stuck implementation waits on a maintainer", facts: queued({ implement: { row: attempt("stuck") } }), expect: { state: "classified", actions: [], wait: "a maintainer's answer on the stuck implementation", next: "Needs a person" } },
  { name: "our open PR is the wait", facts: queued({ implement: { row: attempt("pr-opened", { prOpen: true }) }, openPr: { number: 9, closes: true } }), expect: { state: "classified", actions: [], wait: "open PR #9", next: "Implement: pull request opened" } },
  { name: "an ended attempt is not repeated on the same text", facts: queued({ implement: { row: attempt("failed") } }), expect: { state: "classified", actions: [], wait: "a person to queue the implementation again" } },
  { name: "an ended attempt starts again when the text changed", facts: queued({ implement: { row: attempt("failed", { textChanged: true }) } }), expect: { state: "classified", actions: ["implement"], bucket: "plan" } },
  { name: "an ended attempt starts again when the issue was queued again after it", facts: queued({ implement: { row: attempt("failed", { requeuedAfterEnd: true }) } }), expect: { state: "classified", actions: ["implement"], bucket: "plan" } },
  { name: "a running implementation keeps our assignment", facts: queued({ implement: { row: attempt("planned") }, assignment: { login: "bot", assignees: ["bot"], ours: true } }), expect: { state: "classified", actions: ["implement"] } },
  { name: "a question releases our assignment", facts: queued({ implement: { row: attempt("asked", { asked: "author" }) }, assignment: { login: "bot", assignees: ["bot"], ours: true } }), expect: { state: "classified", actions: ["unassign"] } },

  // ---- next-step text of issues
  { name: "issue that is not a bugfix", facts: { classification: { label: "infra" }, labels: { existing: ["infra"] } }, expect: { state: "classified", next: "Triage by a person" } },

  { name: "a needs-decision item gets no question", facts: needsDecision, expect: { state: "classified", actions: [] } },
];

for (const r of rows) {
  test(r.name, () => {
    const f = itemFacts(r.facts);
    const p = decideItem(f);
    assert.equal(p.state, r.expect.state, "state");
    if (r.expect.actions) assert.deepEqual(tokens(p), [...r.expect.actions].sort(), "actions");
    if (r.expect.wait !== undefined) assert.equal(p.wait, r.expect.wait, "wait");
    if (r.expect.next) assert.equal(decideAll(f).next, r.expect.next, "next");
    if (r.expect.bucket) assert.equal(p.actions.find((a) => a.kind === "implement")?.params?.bucket, r.expect.bucket, "bucket");
  });
}

test("a PR's triage actions and its review-to-merge actions are both due", () => {
  const v = decideAll(itemFacts({ kind: "pr", labels: { existing: [] } }), prFacts({ workflow: null }));
  assert.deepEqual(v.actions.map((a) => a.kind), ["label", "merge"]);
  assert.equal(v.pr?.state, "ready");
  assert.equal(v.next, "Merge queue");
  assert.equal(v.head, "h1");
});

test("a PR without a review is next to be reviewed; with a take-fix review, fix-up", () => {
  assert.equal(decideAll(itemFacts({ kind: "pr" }), prFacts({ review: null })).next, "Review");
  assert.equal(decideAll(itemFacts({ kind: "pr" }), prFacts({ review: { verdict: "take-fix" } })).next, "Fix-up");
  assert.equal(decideAll(itemFacts({ kind: "pr" }), prFacts({ review: { stale: true } })).next, "Review");
});

test("the type labels are the ones the label step sets", () => {
  assert.deepEqual(TYPE_LABEL_NAMES, TYPE_LABELS.map((l) => l.name));
});
