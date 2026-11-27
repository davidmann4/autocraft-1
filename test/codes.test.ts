// Every wait a plan can have, and every reason a merge leg can end with, has a code.
import assert from "node:assert/strict";
import { test } from "node:test";
import { needsQuestion, stopCodeOf, type WaitCode } from "../src/core/codes.ts";
import { decideItem } from "../src/core/decide-item.ts";
import { decidePr } from "../src/core/decide.ts";
import { legBlocker, premergeStop } from "../src/workflow/blockers.ts";
import { factsOf, prng, randomPrRows, rnd, type PrRows, type Rnd } from "./random-pr.ts";
import { randomItem } from "./random-item.ts";

const CASES = Number(process.env.INVARIANT_CASES ?? 4000);

test("a wait has a code exactly when the plan waits, and no text of decide or decide-item is without one of its own", () => {
  const seed = process.env.INVARIANT_SEED ? Number(process.env.INVARIANT_SEED) : (Date.now() & 0x7fffffff);
  const x: Rnd = rnd(prng(seed));
  const at = { seed, texts: new Map<string, Set<WaitCode>>() };
  const check = (p: { wait: string | null; waitCode?: WaitCode | null }, what: () => unknown): void => {
    assert.equal(p.waitCode === null, p.wait === null);
    if (p.wait === null) return;
    at.texts.set(p.wait, (at.texts.get(p.wait) ?? new Set()).add(p.waitCode!));
    assert.notEqual(p.waitCode, "other", `INVARIANT_SEED=${seed}: no code for the wait "${p.wait}"\n${JSON.stringify(what())}`);
  };
  for (let i = 0; i < CASES; i++) {
    const w: PrRows = randomPrRows(x);
    check(decidePr(factsOf(w)), () => w);
    const item = randomItem(x);
    check(decideItem(item), () => item);
  }
  assert.ok(at.texts.size > 30, `only ${at.texts.size} different waits came up`);
  // One text is one wait, except where a person and the system wait in the same words.
  const sameWords = new Set(["approval of CI runs", "its batch", "a maintainer's answer"]);
  for (const [text, codes] of at.texts) assert.ok(codes.size === 1 || sameWords.has(text), `INVARIANT_SEED=${seed}: "${text}" as ${[...codes].join(", ")}`);
  // Started items whose wait is left to the person who set it, or to GitHub, are asked nothing.
  assert.deepEqual((["answer", "merge-refused", "repo-approval", "breaker", "box-identity", "changes-requested", "sign-in"] as const).map((c) => needsQuestion(c, "person")), [true, true, false, false, false, false, false]);
  assert.equal(needsQuestion("merge-refused", "system"), false);
});

/** The reasons src/preapproval gives, `H`: what it calls the head. */
const REASONS = (H: string): string[] => [
  "another push moved the head to abc1234", "the head went back to abc1234", "its workflow ended", "the PR is gone", "the PR was closed",
  "the PR was merged before the fix-up finished", "the PR was merged before the pre-approved merge reached the merge queue",
  "mira no longer may act on app", "mira no longer may act on app, so the approval no longer counts",
  "the fix-up failed", "the fix-up failed: cargo check", "the fix-up refused: too-large for one push", "the fix-up too-large", "the fix-up too-large: 900 lines", "the fix-up push-denied: no", "the fix-up superseded",
  "the fix-up cannot run: the PR is a draft", "the fix-up cannot run: the push is not approved: nobody", `${H} cannot be reviewed (backlog)`,
  `the review of ${H} waits on its review failed 4 times at this commit`, `the review of ${H} asks for fixes and its fix-up cannot run`, `the review of ${H} asks for fixes and its fix-up cannot run (asked)`,
  "the review says hold", "the review says hold (unsure): another PR does it", "the review says close: a duplicate", "the review says close: the pre-merge review found it", "the review says hold: the diff is too-large",
  "merging is no longer approved", "the repo has no CI, and nothing is merged without it", `CI failed at ${H} and the CI fix did not repair it`, `the pre-merge review of ${H} failed`, "the pre-merge review found 1 defect", "the pre-merge review found 2 defects",
  `verification failed at ${H}`, "the merge was refused: a required review", "the merge was refused: verification failed", "cancelled by pipeline", "cancelled by mira", "cancelled", "failed", "asked",
];

test("a merge leg's reason stands for the same blocker by its code as by its text", () => {
  // What a person sees a leg stop for, told from the text alone.
  const byText = (reason: string): string =>
    /another push moved the head|the head went back/.test(reason) ? "author-commits"
    : /the review says (hold|close)|verification failed|pre-merge review found/.test(reason) ? "major-finding"
    : "other";
  const given = new Set(["cancelled", "failed", "asked"]);
  for (const reason of ["the pushed head", "the new head", "the PR's head"].flatMap(REASONS)) {
    const code = stopCodeOf(reason);
    assert.equal(legBlocker(code), byText(reason), `${reason}: ${code}`);
    assert.equal(code === "other", given.has(reason), `${reason}: ${code}`);
    // Of two reasons in one text the first blocker wins; a pre-merge defect is told from its own sentence.
    if (/^the pre-merge review found/.test(reason)) assert.ok(code === "premerge-defect" && premergeStop({ reason }) && premergeStop({ reason: "x", code }));
  }
});
