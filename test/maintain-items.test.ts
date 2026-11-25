// The new Items page's lists (src/dash/api/maintain.ts): what needs an answer, and what the Backlog takes out of the active lists.
import assert from "node:assert/strict";
import { test } from "node:test";
import { groupOf, waitsForAnswer } from "../src/dash/api/maintain.ts";

test("an open recommendation or an unclear answer needs an answer; a Backlog item leaves the active lists", () => {
  const rec = { text: "Fix 1, then merge?", parts: { fix: [1], drop: [] }, merges: true };
  const at = (x: { live?: boolean; waits?: boolean; backlog?: boolean }) =>
    groupOf({ open: true, live: false, waits: false, backlog: false, phase: "Review", ...x });

  const recommending = waitsForAnswer({ state: "recommending", rec }, "started");
  assert.equal(at({ live: true, waits: recommending }), "needs");
  // An unclear answer counts whether or not the item was started, and wins over a running workflow.
  assert.equal(at({ waits: waitsForAnswer(null, "ambiguous") }), "needs");
  assert.equal(at({ live: true, waits: waitsForAnswer({ state: "running", rec: null }, "ambiguous") }), "needs");
  // A later event clears it.
  assert.equal(at({ live: true, waits: waitsForAnswer({ state: "running", rec: null }, "answered") }), "started");

  const active = ["needs", "started", "automatic", "rest"];
  assert.ok(active.includes(at({})));
  assert.equal(at({ backlog: true }), "backlog");
  assert.ok(!active.includes(groupOf({ open: true, live: false, waits: false, backlog: true, phase: "Triage" })));
});
