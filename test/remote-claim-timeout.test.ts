// A claim with maxTimeoutSeconds (a Task Runner whose login is refreshed soon): with little room it takes only calls that fit,
// and passing over a longer call does not make it an idle helper, which other authors' runners would give way to; with enough
// room it leases a longer call with the lease's time limit cut to the room, and a run that reaches the cut is retried unpenalised.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { bundleOf, claimCall, enqueueCall, heartbeat, submitCall } from "../src/remote/calls.ts";
import { parseStatus, storeStatus } from "../src/remote/helpers.ts";
import { PROTOCOL_VERSION, type Claim } from "../src/remote/protocol.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });

test("a claim limited by its login's refresh leases the short call, leaves the long one and is no idle helper", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "remote-claim-timeout-")), "t.db"));
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
  const idleAt = async () => (await db.get(db.k.selectFrom("remote_helpers").select("idle_claim_at").where("token_id", "=", tokenId)))!.idle_claim_at;

  const first = await claim({ maxTimeoutSeconds: 600 });
  assert.equal(first.lease?.id, short, "the call that fits, although the long one is ahead of it");
  const none = await claim({ maxTimeoutSeconds: 600 });
  assert.equal(none.lease, null);
  assert.ok(!none.lease && none.reason, "the empty reply says why");
  assert.equal(await idleAt(), null, "a claim that passed over a call for its time limit is no idle helper's");
  const renews = (await db.get(db.k.selectFrom("remote_helpers").select("login_renews_at").where("token_id", "=", tokenId)))!.login_renews_at;
  assert.ok(renews !== null && Number(renews) > Date.now() + 600_000, "the helper records when its login renews, after the room it claimed with");
  const later = await claim({});
  assert.equal(later.lease?.id, long, "a claim without the limit takes the long call");
  await db.close();
});

test("a claim with enough login room leases a longer call cut to the room; a run that reaches the cut goes back without using an attempt", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "remote-claim-cut-")), "t.db"));
  await db.run(db.k.insertInto("access").values({ login: "olga", role: "operator" }));
  const tokenId = (await createToken(db, "olga", "helper", { kind: "runner" })).row.id;
  await storeStatus(db, tokenId, "olga", parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }));
  const id = await enqueueCall(db, { promptId: "fixup.patch", promptVersion: "1", tier: "top", effort: "medium", askedModel: "opus", items: [{ repo: "photocraft", number: 1 }], level: 0, maxAttempts: 1,
    bundle: { promptId: "fixup.patch", promptVersion: "1", tier: "top", effort: "medium", timeoutSeconds: 3600, maxTurns: null, stdin: "x", system: null, mounts: [], mcpServers: [], keepSession: false, hints: {} } });
  const room = 1800;
  const got = await claimCall(db, { tokenId, login: "olga", role: "operator" },
    { requestId: "cut-claim", protocol: PROTOCOL_VERSION, helperVersion: "1.4.2", harness: "claude", harnessVersion: "2.1", tiers: { top: "opus" }, maxTimeoutSeconds: room }, async () => true);
  assert.equal(got.lease?.id, id, "the call is leased although its timeout is longer than the room");
  const secret = got.lease!.secret;
  const b = (await bundleOf(db, secret))!;
  assert.ok(b.timeoutSeconds <= room && b.timeoutSeconds > room - 60, "the bundle the helper runs carries the room as its time limit");
  const start = Date.now();
  assert.ok(await heartbeat(db, secret, { phase: "running" }, start));
  const end = start + b.timeoutSeconds * 1000;
  for (let at = start + 20_000; at < end; at += 20_000) assert.ok(await heartbeat(db, secret, { phase: "running" }, at), "the lease stays live up to its cut");
  assert.deepEqual(await submitCall(db, secret, { ok: false, error: `timed out after ${b.timeoutSeconds} s` }, end), { accepted: true });
  const row = (await db.get(db.k.selectFrom("remote_calls").select(["state", "attempt", "released_by"]).where("id", "=", id)))!;
  assert.equal(row.state, "queued", "back in the queue although its only attempt ran: the cut is not the call's failure");
  assert.equal(Number(row.attempt), 1);
  assert.equal(row.released_by, null, "the same Task Runner may take it again after its login's refresh");
  await db.close();
});
