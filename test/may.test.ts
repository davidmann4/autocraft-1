import { test } from "node:test";
import assert from "node:assert/strict";
import { mayMerge, mayPush, mergeApproved, type WorkflowGate } from "../src/core/may.ts";
import type { OwnPush } from "../src/core/evidence.ts";

const wf = (o: Partial<WorkflowGate> = {}): WorkflowGate => ({ live: true, entry: "review", state: "running", startedBy: "starter", approvedBy: null, approvedAt: null, blocker: null, baseHead: "h1", leg: { state: "queued", head: "h1" }, ...o });
const repo = { by: "op", at: "2026-01-01T00:00:00Z" };
const merge = (workflow: WorkflowGate | null, head = "h1", repoApproval: typeof repo | null = null, pushes: OwnPush[] = []) => mayMerge({ repoApproval, workflow, ended: null, head, pushes });
const push = (kind: Parameters<typeof mayPush>[0]["kind"], workflow: WorkflowGate | null, repoApproval: typeof repo | null = null, operatorFix = false) => mayPush({ kind, repoApproval, workflow, operatorFix, by: "asker" });

test("mayMerge with a live workflow", () => {
  assert.deepEqual(merge(wf({ approvedBy: "ann" })), { ok: true, as: "person", by: "ann" });
  assert.deepEqual(merge(wf({ entry: "merge" })), { ok: true, as: "person", by: "starter" });
  assert.equal(merge(wf({ approvedBy: "ann", blocker: "major finding" })).ok, false);
  assert.equal(merge(wf({ approvedBy: "ann" }), "h2").ok, false);
  assert.equal(merge(wf()).ok, false);
});

test("a head counts as ours only when our own pushes lead to it from the base head, step by step", () => {
  const at = (head: string, pushes: OwnPush[]) => merge(wf({ approvedBy: "ann", leg: { state: "queued", head } }), head, null, pushes).ok;
  assert.equal(at("c", [{ from: "h1", to: "b" }, { from: "b", to: "c" }]), true, "two pushes of ours");
  assert.equal(at("c", [{ from: "b", to: "c" }]), false, "our push on top of an author's");
  assert.equal(at("c", [{ from: "h1", to: "x" }, { from: "b", to: "c" }]), false, "an earlier push of ours is no parent of the author's");
  assert.equal(at("c", []), false, "unknown parent");
});

test("a started PR merges only through the leg that handed it over, and is approved before that", () => {
  const w = (leg: WorkflowGate["leg"]) => wf({ approvedBy: "ann", leg });
  for (const leg of [null, { state: "ci", head: "h1" }, { state: "queued", head: "h0" }]) {
    assert.equal(merge(w(leg), "h1", repo).ok, false);
    assert.equal(mergeApproved({ repoApproval: null, workflow: w(leg), ended: null, head: "h1", pushes: [] }).ok, true);
  }
});

test("what a person stopped, put in the backlog, closed or ended with an answer does not merge on the repo's approval", () => {
  for (const [ended, ok] of [["stopped", false], ["backlog", false], ["closed", false], ["done", false], [null, true]] as const) {
    assert.equal(mayMerge({ repoApproval: repo, workflow: null, ended, head: "h1", pushes: [] }).ok, ok, String(ended));
  }
});

test("mayMerge without a live workflow uses the repo switch", () => {
  assert.deepEqual(merge(null, "h1", repo), { ok: true, as: "repo", by: "op" });
  assert.equal(merge(null).ok, false);
  assert.deepEqual(merge(wf({ live: false, approvedBy: "ann" }), "h1", repo), { ok: true, as: "repo", by: "op" });
  assert.equal(merge(wf({ live: false })).ok, false);
});

test("mayPush", () => {
  assert.deepEqual(push("fixup", wf(), null, true), { ok: true, as: "person", by: "asker" });
  for (const entry of ["fix-up", "implement", "merge"] as const) assert.equal(push("fixup", wf({ entry })).ok, true);
  assert.deepEqual(push("fixup", wf({ approvedBy: "ann" })), { ok: true, as: "person", by: "ann" });
  assert.equal(push("fixup", wf()).ok, false);
  for (const kind of ["cifix", "conflict"] as const) {
    assert.equal(push(kind, wf({ entry: "merge" })).ok, true);
    assert.deepEqual(push(kind, wf({ approvedBy: "ann" })), { ok: true, as: "person", by: "ann" });
    assert.equal(push(kind, wf()).ok, false);
  }
  assert.deepEqual(push("cifix", null, repo), { ok: true, as: "repo", by: "op" });
  assert.equal(push("cifix", null).ok, false);
});
