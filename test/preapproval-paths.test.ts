// Who makes the next fix of an approved PR (src/preapproval/paths.ts): the merge leg waits for our own steps and for a contributor who has a
// patch to apply, and stops for a person otherwise. Review fixes and red CI our steps give up on stop for the approver.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decidePr, pushHeld } from "../src/core/decide.ts";
import { detectBlocker } from "../src/workflow/blockers.ts";
import { atBlocker } from "../src/workflow/recommend.ts";
import { fixPath, redCiPath, type FixPath } from "../src/preapproval/paths.ts";
import { CIFIX_ASK_REASON, CIFIX_NO_LOG_REASON, PUSHES_PER_APPROVAL } from "../src/core/rules.ts";
import { cifixAt } from "../src/data/changes/pure.ts";
import type { CifixRow } from "../src/data/changes/types.ts";
import { HEAD, prFacts } from "./world.ts";

type Over = Parameters<typeof prFacts>[0];
const NO_COMMENT = { repoFacts: { commentApproved: false } } as const;
const LATER = { unsent: { until: Date.parse("2026-11-04T13:00:00Z") } } as const;
const FINAL = { unsent: "final" } as const;
const red = (o: Record<string, unknown> = {}, over: Over = {}): Over => ({
  ci: "failure", cifix: { states: [], tries: 0, rerunAt: null, infraRuns: null, formattingTask: null, formatterEnded: true, totalPushes: 0, totalTries: 0, checksAt: "2026-11-04T11:00:00.000Z", ...o } as never, ...over,
});
const takefix = (o: Record<string, unknown> = {}, over: Over = {}): Over => ({ review: { verdict: "take-fix", fixes: 2 }, fixup: { fixes: 2, attempts: 0, recorded: [], ...o } as never, ...over });
const CLOSED = { pushable: false } as const;

const CI: [string, Over, FixPath][] = [
  ["the CI fix can try", red(), "fix"],
  ["a formatter run", red({ states: ["formatting"], formattingTask: 4, formatterEnded: false }), "fix"],
  ["a push under way", red({ states: ["pushing"] }), "fix"],
  ["a required check still runs: the CI fix waits for the run to end", red({ running: true }), "fix"],
  ["the failure log could not be read yet: read again after a backoff", red({ readAgainAt: Date.parse("2026-11-04T13:00:00Z") }), "fix"],
  ["a rerun waits for approval", red({ infraRuns: [7] }, { repoFacts: { ciApproved: false } }), null],
  // A person approved the merge: what the CI fix gives up on is theirs, never the contributor's.
  ["the tries at the head are used: the approver is asked", red({ tries: 2, states: ["failed", "failed"] }), null],
  ["the pushes of the PR are used: the approver is asked", red({ totalPushes: 2 }), null],
  ["the contributor was asked on an approved PR: the CI fix tries again", red({ states: ["asked"] }), "fix"],
  ["a patch posted as a comment waits for the contributor", red({ states: ["asked"], askedPatch: true }), "contributor"],
  ["the patch comment did not reach GitHub and is posted again", red(LATER), "contributor"],
  ["the patch comment never reached GitHub", red(FINAL), null],
  ["the comment failed", red({ states: ["comment-failed"] }), null],
  ["nobody to ask: a PR of our own", red({ states: ["asked"], askedPatch: true }, { authorIsPipeline: true }), null],
  ["our own push broke it and the CI fix gave up", red({ tries: 2, states: ["failed", "failed"] }, { brokeByUs: true }), null],
  ["the push was refused", red({ states: ["push-denied"] }), null],
  ["nothing to fix", red({ states: ["skipped"] }), null],
];

const FIX: [string, Over, FixPath][] = [
  ["the fix-up can run", takefix(), "fix"],
  ["pushed", takefix({ recorded: ["pushed"] }), "fix"],
  ["stored for its lint run", takefix({ recorded: ["linting"] }), "fix"],
  ["the push was refused", takefix({ recorded: ["push-denied"] }), null],
  // A person approved the merge: fixes our fix-up cannot make are theirs, never the contributor's.
  ["the branch takes no push: the approver is asked", takefix({}, CLOSED), null],
  ["the contributor was asked before the approval: the approver is asked", takefix({ recorded: ["asked"] }, CLOSED), null],
  ["too large: the approver is asked", takefix({ recorded: ["too-large"] }), null],
  ["the tries since the approval are used: the approver is asked", takefix({ attempts: 2 }), null],
  ["an ask that did not reach GitHub is not posted again: the approver is asked", takefix(LATER, CLOSED), null],
  ["the ask never reached GitHub", takefix(FINAL, CLOSED), null],
  ["the ask failed", takefix({ recorded: ["comment-failed"] }, CLOSED), null],
  ["nobody can be asked: no comment approval", takefix({}, { ...CLOSED, ...NO_COMMENT }), null],
  ["tries used up and no comment approval", takefix({ attempts: 2 }, NO_COMMENT), null],
  ["nobody can be asked: a quiet PR", takefix({}, { ...CLOSED, quiet: true }), null],
  ["nobody to ask: a PR of our own", takefix({ recorded: ["asked"] }, { ...CLOSED, authorIsPipeline: true }), null],
];

test("an approved PR waits for our own steps and for a contributor who has a patch to apply, and stops for a person otherwise", () => {
  for (const [rows, path] of [[CI, redCiPath], [FIX, fixPath]] as const) {
    for (const [name, over, want] of rows) {
      const f = prFacts(over);
      assert.equal(path(f), want, name);
      // The leg and the plan wait for the same.
      if (want === "contributor") assert.notEqual(decidePr(f).waitKind, "person", name);
      if (decidePr(f).waitKind === "contributor" && !f.quiet && !f.authorIsPipeline) assert.equal(want, "contributor", name);
    }
  }
});

test("an approved PR whose CI fix found no log yet and asked the contributor is picked up by the CI fix again", () => {
  const row = (id: number, state: string, reason: string | null): CifixRow => ({ id, repo: "photocraft", number: 7, createdAt: `2026-11-04T10:0${id}:00.000Z`, head: HEAD, toHead: null, kind: "code", state, reason, files: [], attempt: id, taskId: null, lintTask: null, runs: null });
  const rows = [row(1, "failed", CIFIX_NO_LOG_REASON), row(2, "failed", CIFIX_NO_LOG_REASON), row(3, "asked", CIFIX_ASK_REASON)];
  const cifix = { ...cifixAt(rows, HEAD, Date.parse("2026-11-04T11:00:00Z"), new Map()), checksAt: "2026-11-04T11:00:00.000Z", running: false, failing: ["gate / gate (ubuntu-24.04)"] };
  const f = prFacts({ ci: "failure", cifix });
  assert.equal(redCiPath(f), "fix");
  assert.equal(decidePr(f).actions.find((a) => a.kind === "cifix")?.params?.bucket, "work");
  // Nobody approved the merge: the ask stands, and the PR waits for its contributor.
  assert.notEqual(decidePr(prFacts({ ci: "failure", cifix, workflow: { entry: "fixup", approved: false, startedBy: "maint", startedAt: "2026-11-04T09:00:00.000Z", own: true } })).actions.find((a) => a.kind === "cifix")?.params?.bucket, "work");
});

test("after the limit of pushes of ours since the approval, the next one waits for the approver, who is asked what a yes lets AutoCraft do", () => {
  const cases: [Over, string][] = [[takefix(), "fixup"], [red(), "cifix"]];
  for (const [over, step] of cases) {
    const pushes = (n: number) => prFacts({ ...over, ownPushes: n });
    const pushing = (n: number) => decidePr(pushes(n)).actions.some((a) => (a.kind === "fixup" && a.params?.bucket === "fix") || (a.kind === "cifix" && a.params?.bucket === "work"));
    assert.ok(pushing(PUSHES_PER_APPROVAL - 1), step);
    assert.ok(!pushing(PUSHES_PER_APPROVAL), step);
    assert.equal(pushHeld(pushes(PUSHES_PER_APPROVAL)), step);
    const found = detectBlocker({ entry: "review", approved: true, authorPush: null, review: null, failures: [], fix: null, plannedFiles: [], leg: null, thresholds: { outsideMin: 50 }, limit: { kind: "pushes", count: PUSHES_PER_APPROVAL, step: pushHeld(pushes(PUSHES_PER_APPROVAL))! } });
    const rec = atBlocker(found!, null, []);
    assert.ok(rec.merges && !rec.parts.fix.length, step);
    assert.match(rec.text, new RegExp(`pushed ${PUSHES_PER_APPROVAL} changes.*Yes lets it go on`), step);
  }
});
