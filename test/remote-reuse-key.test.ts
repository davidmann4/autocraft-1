import { test } from "node:test";
import assert from "node:assert/strict";
import { reuseKey } from "../src/remote/reuse-key.ts";
import type { Mount, TaskBundle } from "../src/remote/protocol.ts";

const git = (path: string, repo: string, sha: string, ref?: string): Mount => ({ kind: "git", path, owner: "o", repo, sha, ...(ref && { ref }) });

/** A review call as a run builds it: the item's checkout at /repo, the workspace, the explorer's item server when the snapshot exists. */
function bundle(o: { head: string; workspace: Mount[]; itemServer: boolean }): Omit<TaskBundle, "callId"> {
  const servers = o.itemServer ? ["items", "reference"] : ["reference"];
  return {
    promptId: "review.opus", promptVersion: "v1", tier: "top", effort: "high", timeoutSeconds: 1200, maxTurns: 40, stdin: "review app#7", system: null,
    mounts: [git("/repo", "app", o.head, "refs/pull/7/head"), ...o.workspace], mcpServers: servers, keepSession: false,
    hints: { claude: { args: ["--allowedTools", servers.map((s) => `mcp__${s}__*`).join(",")] } },
  };
}

test("a resumed run's call for the same item at the same head has the same reuse key; a new head does not", () => {
  const items = [{ repo: "app", number: 7 }, { repo: "app", number: 3 }];
  const before = reuseKey(bundle({ head: "a1", workspace: [git("/repos/libs", "libs", "b1"), git("/repos/fonts", "fonts", "c1")], itemServer: true }), items);
  // After the restart: items listed in another order, the workspace's default branches moved and one checkout not ready yet, no item snapshot yet.
  const after = reuseKey(bundle({ head: "a1", workspace: [git("/repos/libs", "libs", "b2")], itemServer: false }), [...items].reverse());
  assert.equal(after, before);
  assert.notEqual(reuseKey(bundle({ head: "a2", workspace: [], itemServer: false }), items), before, "a new head of the item asks again");
});
