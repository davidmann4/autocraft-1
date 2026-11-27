// The Items page's lists (src/dash/api/maintain.ts): an awaited answer keeps an item in Started, and the Backlog takes items out of the active lists.
import assert from "node:assert/strict";
import { test } from "node:test";
import { groupOf, waitsForAnswer } from "../src/dash/api/maintain.ts";

test("an open recommendation or an unclear answer puts an item in Started; a Backlog item leaves the active lists", () => {
  const rec = { text: "Fix 1, then merge?", parts: { fix: [1], drop: [] }, merges: true };
  const at = (x: { live?: boolean; waits?: boolean; backlog?: boolean }) =>
    groupOf({ open: true, live: false, waits: false, backlog: false, phase: "Review", ...x });

  const recommending = waitsForAnswer({ state: "recommending", rec }, "started");
  assert.equal(at({ live: true, waits: recommending }), "started");
  assert.equal(at({ live: true, waits: waitsForAnswer({ state: "blocked", rec }, "blocked") }), "started");
  // An unclear answer counts whether or not the item was started.
  assert.equal(at({ waits: waitsForAnswer(null, "ambiguous") }), "started");
  // A later event clears it.
  assert.equal(at({ waits: waitsForAnswer(null, "answered") }), "automatic");

  const active = ["started", "automatic", "rest"];
  assert.ok(active.includes(at({})));
  assert.equal(at({ backlog: true }), "backlog");
  assert.ok(!active.includes(groupOf({ open: true, live: false, waits: false, backlog: true, phase: "Triage" })));
});
