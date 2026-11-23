import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as helper from "../worker/autocraft.mjs";

test("the runner updates itself only to a newer version, and never from a git checkout or when switched off", () => {
  const o = { current: "1.4.0", inGit: false, enabled: true };
  assert.equal(helper.selfUpdateDecision({ ...o, served: "1.5.0" }), "update");
  assert.equal(helper.selfUpdateDecision({ ...o, served: "1.4.0" }), "current");
  assert.equal(helper.selfUpdateDecision({ ...o, served: "1.3.9" }), "current");
  assert.equal(helper.selfUpdateDecision({ ...o, served: "1.5.0", inGit: true }), "available");
  assert.equal(helper.selfUpdateDecision({ ...o, served: "1.5.0", enabled: false }), "available");

  const root = mkdtempSync(join(tmpdir(), "selfupdate-"));
  try {
    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    mkdirSync(join(root, "repo", "worker"));
    mkdirSync(join(root, "plain"));
    writeFileSync(join(root, "repo", "worker", "a.mjs"), "");
    writeFileSync(join(root, "plain", "a.mjs"), "");
    assert.equal(helper.inGitCheckout(join(root, "repo", "worker", "a.mjs")), true);
    assert.equal(helper.inGitCheckout(join(root, "plain", "a.mjs")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an interactive claim carries no other lane field, even with the own lane on", () => {
  assert.deepEqual(helper.claimLaneFlags(true, false, true, true), { interactiveLane: true });
  assert.deepEqual(helper.claimLaneFlags(false, false, true, false), { withOwnLane: true });
});
