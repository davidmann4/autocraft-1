// Random facts of an item's triage steps, for the tests that go over many of them.
import type { ItemFacts } from "../src/core/plan.ts";
import type { Rnd } from "./random-pr.ts";
import { itemFacts } from "./world.ts";

export function randomItem(x: Rnd): ItemFacts {
  return itemFacts({
    kind: x.pick(["pr", "issue"] as const), open: x.bool(0.9), draft: x.bool(0.1), inScope: x.bool(0.7), integration: x.bool(0.05),
    held: x.pick([null, null, null, "backlog"] as const), pipelineOn: x.bool(0.85), run: x.pick(["run1", "run1", null]),
    repoFacts: { labelsApproved: x.bool(0.8), commentApproved: x.bool(0.8) },
    classification: {
      status: x.pick(["settled", "settled", "waiting", "disagree", "unclassified"] as const), label: x.pick(["bugfix", "bugfix", "plugin candidate", null]),
      flags: x.pick([[], [], ["needs decision"], ["security"]]), jevLabel: x.pick(["bugfix", "small extra", "plugin candidate"]), haikuLabel: x.pick([null, "bugfix", "small extra"]),
    },
    embeddedHash: x.pick(["e1", "e1", null]), priorityHash: x.pick(["e1", "e1", null]), scannedHash: x.pick(["e1", "e1", null]),
    pairsToCheck: x.int(2),
    labels: { existing: x.pick([["bugfix"], []]), labeledNote: null },
    close: x.bool(0.2) ? { id: 1, by: "m", weight: 5, at: "2026-11-04T08:00:00.000Z" } : null,
    openPr: x.bool(0.1) ? { number: 7, closes: x.bool(0.5) } : null,
    implement: {
      queuedBy: x.pick([null, "maint"]), standing: x.pick(["yes", "yes", "yes", "no", "unknown"] as const), featureOn: x.bool(0.7), liveInRepo: x.int(3),
      row: x.bool(0.4) ? {
        state: x.pick(["planning", "asked", "planned", "implementing", "pr-opened", "revising", "stuck", "failed", "merged"]), attempt: 1 + x.int(2),
        textChanged: x.bool(0.3), newCommentAfterQuestion: x.bool(0.3), decisionAnswered: x.bool(0.3), requeuedAfterEnd: x.bool(0.2), asked: x.pick(["author", "maintainer", null] as const), prOpen: x.bool(),
      } : null,
    },
  } as Parameters<typeof itemFacts>[0]);
}
