// A claim with maxTimeoutSeconds (a Task Runner whose login is refreshed soon) takes only calls that fit, and passing over a
// longer call does not make it an idle helper, which other authors' runners would give way to.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { claimCall, enqueueCall } from "../src/remote/calls.ts";
import { parseStatus, storeStatus } from "../src/remote/helpers.ts";
import { setInferenceMode } from "../src/remote/mode.ts";
import { PROTOCOL_VERSION, type Claim } from "../src/remote/protocol.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "../src/db/open.ts";

mkdirSync(SCRATCH, { recursive: true });

test("a claim limited by its login's refresh leases the short call, leaves the long one and is no idle helper", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "remote-claim-timeout-")), "t.db"));
  await setInferenceMode(db, "user-local", "test");
  await db.run(db.k.insertInto("access").values({ login: "olga", role: "operator" }));
  const tokenId = (await createToken(db, "olga", "helper", { kind: "runner" })).row.id;
  await storeStatus(db, tokenId, "olga", parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }));
  const enqueue = async (n: number, timeoutSeconds: number) => await enqueueCall(db, { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", askedModel: "opus", items: [{ repo: "photocraft", number: n }], level: 0, maxAttempts: 1,
    bundle: { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", timeoutSeconds, maxTurns: null, stdin: "x", system: null, mounts: [], mcpServers: [], keepSession: false, hints: {} } });
  const long = await enqueue(1, 1200);
  const short = await enqueue(2, 120);
  let n = 0;
  const claim = async (extra: Partial<Claim>) => await claimCall(db, { tokenId, login: "olga", role: "operator" },
    { requestId: `timeout-claim-${++n}`, protocol: PROTOCOL_VERSION, helperVersion: "1.4.2", harness: "claude", harnessVersion: "2.1", tiers: { top: "opus" }, ...extra }, async () => true);
  const idleAt = async () => (await db.get(db.k.selectFrom("mcp_tokens").select("idle_claim_at").where("id", "=", tokenId)))!.idle_claim_at;

  const first = await claim({ maxTimeoutSeconds: 600 });
  assert.equal(first.lease?.id, short, "the call that fits, although the long one is ahead of it");
  const none = await claim({ maxTimeoutSeconds: 600 });
  assert.equal(none.lease, null);
  assert.ok(!none.lease && none.reason, "the empty reply says why");
  assert.equal(await idleAt(), null, "a claim that passed over a call for its time limit is no idle helper's");
  const later = await claim({});
  assert.equal(later.lease?.id, long, "a claim without the limit takes the long call");
  await db.close();
});
