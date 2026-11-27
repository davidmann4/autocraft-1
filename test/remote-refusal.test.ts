// A call the model's safety filter declines runs once more on another Task Runner without using an attempt, and its agent
// run says so; a second refusal fails the call as refused and ends the step's attempts with that error.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { allocation } from "../src/agents/call.ts";
import { listRuns } from "../src/agents/runs.ts";
import { runModelStep } from "../src/agents/step.ts";
import { textStep } from "../src/agents/steps.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { SAMPLE_OPUS_PRS } from "../src/prompts/samples.ts";
import { claimCall, REFUSED_PREFIX, submitCall, type Caller } from "../src/remote/calls.ts";
import { parseStatus, storeStatus } from "../src/remote/helpers.ts";
import { PROTOCOL_VERSION } from "../src/remote/protocol.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });

test("a refused call is retried once on another Task Runner, then fails the step as refused", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "remote-refusal-")), "t.db"));
  allocation.pollMs = 10;
  const T0 = new Date().toISOString();
  await db.run(db.k.insertInto("items").values({ repo: "photocraft", number: 1287, kind: "pr", state: "OPEN", title: "t", author: "alice", created_at: T0, updated_at: T0 }));
  const callers: Record<string, Caller> = {};
  for (const login of ["bob", "carol"]) {
    await db.run(db.k.insertInto("access").values({ login, role: "maintainer" }));
    await db.run(db.k.insertInto("repo_permissions").values({ login, repo: "photocraft", permission: "write", checked_at: T0 }));
    const tokenId = (await createToken(db, login, "helper", { kind: "runner" })).row.id;
    await storeStatus(db, tokenId, login, parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus", mid: "sonnet" }, reserve: { fiveHour: 0, weekly: 0 } }), Date.now());
    callers[login] = { tokenId, login, role: "maintainer" };
  }
  let claims = 0;
  const lease = async (login: string) => (await claimCall(db, callers[login]!, { requestId: `refusal-claim-${String(++claims).padStart(4, "0")}`, protocol: PROTOCOL_VERSION, helperVersion: "1.2.0", harness: "claude", harnessVersion: "2.1", tiers: { top: "opus", mid: "sonnet" } }, async () => true)).lease;
  const queued = async () => {
    for (let i = 0; i < 400 && !await db.get(db.k.selectFrom("remote_calls").select("id").where("state", "=", "queued")); i++) await new Promise((r) => setTimeout(r, 5));
  };

  const step = runModelStep(db, { ...textStep("review.opus"), attempts: 2 }, SAMPLE_OPUS_PRS[0]!);
  await queued();
  const first = (await lease("bob"))!;
  await submitCall(db, first.secret, { ok: false, refused: true, error: "model error API Error: Opus's safeguards flagged this message", durationMs: 5 });
  const run1 = (await db.get(db.k.selectFrom("agent_runs").select(["state", "summary"]).orderBy("id").limit(1)))!;
  assert.equal(run1.state, "failed");
  assert.match(run1.summary ?? "", /^refused by opus on bob's Task Runner; retried on another Task Runner$/);
  assert.equal(await lease("bob"), null, "the runner that refused is not offered the call again");

  // A helper that does not flag the refusal: the harness's text is enough.
  const second = (await lease("carol"))!;
  assert.equal(second.id, first.id, "the same call, queued again");
  await submitCall(db, second.secret, { ok: false, error: "model error API Error: Opus's safeguards flagged this message", durationMs: 5 });
  const r = await step;
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.error.startsWith(REFUSED_PREFIX), "the step fails as refused");
  const calls = await db.all(db.k.selectFrom("remote_calls").select(["state", "attempt", "refusals"]));
  assert.deepEqual(calls.map((c) => [c.state, Number(c.attempt), Number(c.refusals)]), [["failed", 1, 1]], "one call: no attempt used, and the step asked no more");
  const runs = await db.all(db.k.selectFrom("agent_runs").select("summary").orderBy("id"));
  assert.match(runs.at(-1)?.summary ?? "", /^refused by opus on carol's Task Runner$/);
  await db.close();
});

test("a judging call refused with no other Task Runner fails as refused instead of moving to the mid tier", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "remote-refusal-")), "t.db"));
  allocation.pollMs = 10;
  const T0 = new Date().toISOString();
  await db.run(db.k.insertInto("items").values({ repo: "photocraft", number: 1287, kind: "pr", state: "OPEN", title: "t", author: "alice", created_at: T0, updated_at: T0 }));
  await db.run(db.k.insertInto("access").values({ login: "bob", role: "maintainer" }));
  await db.run(db.k.insertInto("repo_permissions").values({ login: "bob", repo: "photocraft", permission: "write", checked_at: T0 }));
  const tokenId = (await createToken(db, "bob", "helper", { kind: "runner" })).row.id;
  await storeStatus(db, tokenId, "bob", parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus", mid: "sonnet" }, reserve: { fiveHour: 0, weekly: 0 } }), Date.now());
  const step = runModelStep(db, { ...textStep("review.opus"), attempts: 2 }, SAMPLE_OPUS_PRS[0]!);
  for (let i = 0; i < 400 && !await db.get(db.k.selectFrom("remote_calls").select("id").where("state", "=", "queued")); i++) await new Promise((r) => setTimeout(r, 5));
  const lease = (await claimCall(db, { tokenId, login: "bob", role: "maintainer" }, { requestId: "refusal-claim-judging", protocol: PROTOCOL_VERSION, helperVersion: "1.2.0", harness: "claude", harnessVersion: "2.1", tiers: { top: "opus", mid: "sonnet" } }, async () => true)).lease!;
  await submitCall(db, lease.secret, { ok: false, refused: true, error: "model error API Error: Opus's safeguards flagged this message", durationMs: 5 });
  const r = await step;
  assert.ok(!r.ok && r.error.startsWith(REFUSED_PREFIX));
  const call = (await db.get(db.k.selectFrom("remote_calls").select(["state", "tier"])))!;
  assert.deepEqual([call.state, call.tier], ["failed", "top"]);
  await db.close();
});

test("the Refused filter lists each refused run with what its retry came to, and no plain failure", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "remote-refusal-")), "t.db"));
  allocation.pollMs = 10;
  const T0 = new Date().toISOString();
  await db.run(db.k.insertInto("items").values({ repo: "photocraft", number: 1287, kind: "pr", state: "OPEN", title: "t", author: "alice", created_at: T0, updated_at: T0 }));
  const callers: Record<string, Caller> = {};
  for (const login of ["bob", "carol"]) {
    await db.run(db.k.insertInto("access").values({ login, role: "maintainer" }));
    await db.run(db.k.insertInto("repo_permissions").values({ login, repo: "photocraft", permission: "write", checked_at: T0 }));
    const tokenId = (await createToken(db, login, "helper", { kind: "runner" })).row.id;
    await storeStatus(db, tokenId, login, parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus", mid: "sonnet" }, reserve: { fiveHour: 0, weekly: 0 } }), Date.now());
    callers[login] = { tokenId, login, role: "maintainer" };
  }
  let claims = 0;
  const lease = async (login: string) => (await claimCall(db, callers[login]!, { requestId: `refused-list-${String(++claims).padStart(4, "0")}`, protocol: PROTOCOL_VERSION, helperVersion: "1.2.0", harness: "claude", harnessVersion: "2.1", tiers: { top: "opus", mid: "sonnet" } }, async () => true)).lease!;
  const queued = async () => {
    for (let i = 0; i < 400 && !await db.get(db.k.selectFrom("remote_calls").select("id").where("state", "=", "queued")); i++) await new Promise((r) => setTimeout(r, 5));
  };
  const refuse = (secret: string) => submitCall(db, secret, { ok: false, refused: true, error: "model error API Error: Opus's safeguards flagged this message", durationMs: 5 });
  const runOf = async (callId: number) => Number((await db.get(db.k.selectFrom("remote_calls").select("run_id").where("id", "=", callId)))!.run_id);

  // Refused on bob's runner, then answered on carol's.
  const okStep = runModelStep(db, { ...textStep("review.opus"), attempts: 1 }, SAMPLE_OPUS_PRS[0]!);
  await queued();
  const a = await lease("bob");
  const aRefused = await runOf(a.id);
  await refuse(a.secret);
  const a2 = await lease("carol");
  const aRetry = await runOf(a2.id);
  await submitCall(db, a2.secret, { ok: true, text: "x", model: "claude-opus-4-5", usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 });
  await okStep;
  // Refused on both runners: the call fails as refused.
  const refusedStep = runModelStep(db, { ...textStep("review.opus"), attempts: 1 }, SAMPLE_OPUS_PRS[0]!);
  await queued();
  const b = await lease("bob");
  const bRefused = await runOf(b.id);
  await refuse(b.secret);
  const b2 = await lease("carol");
  const bRetry = await runOf(b2.id);
  await refuse(b2.secret);
  await refusedStep;
  // A plain failure.
  const failStep = runModelStep(db, { ...textStep("review.opus"), attempts: 1 }, SAMPLE_OPUS_PRS[0]!);
  await queued();
  const c = await lease("bob");
  const plain = await runOf(c.id);
  const overloaded = (secret: string) => submitCall(db, secret, { ok: false, error: "model error: overloaded", durationMs: 5 });
  await overloaded(c.secret);
  // The call goes to the other runner until its attempts are used.
  for (let i = 0; i < 6 && (await db.get(db.k.selectFrom("remote_calls").select("state").where("id", "=", c.id)))!.state !== "failed"; i++) {
    await queued();
    const next = (await claimCall(db, callers.carol!, { requestId: `refused-list-${String(++claims).padStart(4, "0")}`, protocol: PROTOCOL_VERSION, helperVersion: "1.2.0", harness: "claude", harnessVersion: "2.1", tiers: { top: "opus", mid: "sonnet" } }, async () => true)).lease;
    if (next) await overloaded(next.secret);
  }
  await failStep;

  const page = await listRuns(db, { refused: true }, [], true);
  const got = new Map(page.runs.map((r) => [r.id, r.refusal]));
  assert.deepEqual(got.get(aRefused), { outcome: "retried", retry: { id: aRetry, state: "done" } }, "refused, then answered elsewhere");
  assert.deepEqual(got.get(bRefused), { outcome: "retried", retry: { id: bRetry, state: "failed" } }, "refused, then refused again elsewhere");
  assert.deepEqual(got.get(bRetry), { outcome: "failed", retry: null }, "the second refusal: nothing else could take the call");
  assert.ok(!got.has(aRetry) && !got.has(plain), "neither the successful retry nor a plain failure is a refusal");
  await assert.rejects(listRuns(db, { refused: true }, [], false), /operators and maintainers/, "viewers do not see which runs were refused");
  await db.close();
});
