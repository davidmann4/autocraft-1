// A queued call whose only taker went away is withdrawn after NO_TAKER_MS; its caller skips the unit without a failure, and
// the remote-no-taker health check names the repo.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pool } from "../src/classify/run.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { computeChecks } from "../src/health-checks.ts";
import { awaitCall, enqueueCall } from "../src/remote/calls.ts";
import { parseStatus, STATUS_FRESH_MS, storeStatus } from "../src/remote/helpers.ts";
import { setManualOnly } from "../src/remote/manual-only.ts";
import { NO_TAKER_MS, sweepTakers } from "../src/remote/takers.ts";
import { leaseSkips } from "../src/runner/leases.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });

test("a call whose only taker went stale is withdrawn, its caller skips it, and the health check names the repo", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "remote-no-taker-")), "t.db"));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "photocraft", pipeline: 1 }).onConflict((oc) => oc.column("name").doUpdateSet({ pipeline: 1 })));
  await db.run(db.k.insertInto("access").values({ login: "dave", role: "maintainer" }));
  await db.run(db.k.insertInto("repo_permissions").values({ login: "dave", repo: "photocraft", permission: "write", checked_at: new Date().toISOString() }));
  const t0 = Date.now();
  const token = (await createToken(db, "dave", "helper", { kind: "runner" })).row.id;
  await storeStatus(db, token, "dave", parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }), t0);
  const id = await enqueueCall(db, { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", askedModel: "opus", items: [{ repo: "photocraft", number: 7 }], level: 0, maxAttempts: 1,
    bundle: { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", timeoutSeconds: 60, maxTurns: null, stdin: "x", system: null, mounts: [], mcpServers: [], keepSession: false, hints: {} } }, t0);
  // The caller keeps polling: its stamp follows the test clock.
  const sweep = async (at: number): Promise<number> => { await db.run(db.k.updateTable("remote_calls").set({ seen_at: at }).where("id", "=", id)); return await sweepTakers(db, at); };
  const noTaker = async (at: number) => (await computeChecks(db, at)).find((c) => c.id === "remote-no-taker")!;

  // Manual only: dave may still pick the call, so his runner is a taker.
  await setManualOnly(db, "dave", true);
  assert.equal(await sweep(t0), 0);
  assert.equal((await db.get(db.k.selectFrom("remote_calls").select("no_taker_since as s").where("id", "=", id)))!.s, null, "dave's runner takes it");

  // Dave's laptop sleeps: his status goes stale.
  const t1 = t0 + STATUS_FRESH_MS + 1000;
  assert.equal(await sweep(t1), 0);
  assert.equal((await noTaker(t1)).state, "ok", "not yet ten minutes");
  assert.equal(await sweep(t1 + NO_TAKER_MS - 1000), 0);
  const t2 = t1 + NO_TAKER_MS;
  assert.equal(await sweep(t2), 1);
  const row = (await db.get(db.k.selectFrom("remote_calls").select(["state", "error"]).where("id", "=", id)))!;
  assert.deepEqual({ ...row }, { state: "failed", error: "no Task Runner can take calls on photocraft" });
  const check = await noTaker(t2);
  assert.equal(check.state, "warn");
  assert.match(check.text, /photocraft/);

  // The pool unit that waits on the call is skipped: no failure, and the job counts a skipped item so the planner runs it again.
  const skips = leaseSkips();
  let after = false;
  await pool([async () => { await awaitCall(db, id, { log: () => {} }); after = true; }], 1);
  assert.equal(after, false);
  assert.equal(leaseSkips(), skips + 1);
});
