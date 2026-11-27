// A helper's last error, slots and busy count are stored from its status and listed; a ready helper with a queued call
// waiting past its tier's limit raises a health warning that names the tier and the wait.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { computeChecks, THRESHOLDS } from "../src/health-checks.ts";
import { listHelpers, parseStatus, storeStatus } from "../src/remote/helpers.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });

test("a helper's last error and busy count are listed, and a starved tier warns", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "helper-vis-")), "t.db"));
  await db.prepare("INSERT INTO access (login, role) VALUES ('alice', 'maintainer')").run();
  const tokenId = (await createToken(db, "alice", "laptop", { kind: "runner" })).row.id;
  const now = Date.now();
  const status = parseStatus({ readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 20, weekly: 20 }, slots: 4, busy: 2,
    lastError: { text: "/api/remote/heartbeat: HTTP 502", at: new Date(now - 60_000).toISOString() } });
  await storeStatus(db, tokenId, "alice", status, now);
  const [h] = await listHelpers(db, "alice", now);
  assert.deepEqual([h!.slots, h!.busy, h!.lastError?.text], [4, 2, "/api/remote/heartbeat: HTTP 502"]);

  const queue = async (tier: string, waitedMs: number) => await db.run(db.k.insertInto("remote_calls").values({
    step: "review", stage: 1, prompt_id: "p", prompt_version: "1", tier, effort: "high", asked_model: "opus", bundle: "{}", state: "queued",
    since: now - waitedMs, seen_at: now, queued_since: now - waitedMs, max_attempts: 3, timeout_ms: 600000 }));
  await queue("small", THRESHOLDS.remoteTierWaitMs.small - 60_000);
  await queue("top", THRESHOLDS.remoteTierWaitMs.top - 60_000);
  assert.equal((await computeChecks(db, now)).some((c) => c.id.startsWith("remote-starved-")), false);
  await queue("small", THRESHOLDS.remoteTierWaitMs.small + 60_000);
  const warn = (await computeChecks(db, now)).find((c) => c.id === "remote-starved-small");
  assert.equal(warn?.state, "warn");
  assert.match(warn!.text, /small-tier.*6 min/);
});
