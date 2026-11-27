// A helper older than WORKSPACE_HELPER does not lease a workspace call; a current one does.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { WORKSPACE_SERVER } from "../src/build/workspace-tools.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { claimCall, enqueueCall } from "../src/remote/calls.ts";
import { parseStatus, storeStatus } from "../src/remote/helpers.ts";
import { PROTOCOL_VERSION } from "../src/remote/protocol.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });

test("a helper older than the workspace minimum leaves the workspace call queued and says why", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "remote-workspace-helper-")), "t.db"));
  await db.run(db.k.insertInto("access").values({ login: "olga", role: "operator" }));
  const tokenId = (await createToken(db, "olga", "helper", { kind: "runner" })).row.id;
  await storeStatus(db, tokenId, "olga", parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }));
  const id = await enqueueCall(db, { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", askedModel: "opus", items: [{ repo: "photocraft", number: 1 }], level: 0, maxAttempts: 1,
    bundle: { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", timeoutSeconds: 600, maxTurns: null, stdin: "x", system: null, mounts: [], mcpServers: [WORKSPACE_SERVER], keepSession: false, hints: {} } });
  let n = 0;
  const claim = async (helperVersion: string) => await claimCall(db, { tokenId, login: "olga", role: "operator" },
    { requestId: `ws-helper-${++n}`, protocol: PROTOCOL_VERSION, helperVersion, harness: "claude", harnessVersion: "2.1", tiers: { top: "opus" } }, async () => true);

  const old = await claim("1.3.6");
  assert.equal(old.lease, null);
  assert.ok(!old.lease && /1\.3\.7/.test(old.reason ?? ""), "the empty reply names the minimum helper");
  const current = await claim("1.3.7");
  assert.equal(current.lease?.id, id);
  await db.close();
});
