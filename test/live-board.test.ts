import { test } from "node:test";
import assert from "node:assert/strict";
import { buildKind, live } from "../src/dash/api/live.ts";
import { insertRun } from "../src/agents/runs.ts";
import type { Req } from "../src/dash/types.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { parseStatus, storeStatus } from "../src/remote/helpers.ts";
import { setSettings } from "../src/dash/api/user-settings.ts";

const req = { query: new URLSearchParams(), user: { role: "operator", login: "o", canRead: async () => true } } as unknown as Req;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

test("the live board shows a running job with its call and build steps, an estimate from earlier runs, and drops idle ended jobs", async () => {
  const db = await connectDb(":memory:");
  await db.run(db.k.insertInto("items").values({ repo: "app", number: 7, kind: "pr", state: "OPEN", title: "Fix the thing", updated_at: ago(1) }));
  const job = async (step: string, requested_at: string, state: string, started_at: string, ended_at: string | null, progress: string | null, summary: string | null) =>
    (await db.get(db.k.insertInto("jobs").values({ step, params: "{}", requested_by: "pipeline", requested_at, state, started_at, ended_at, progress, summary }).returning("id")))!.id;
  // Earlier review jobs of 10, 12, 14 and 30 minutes and the 1-minute one below give the estimate.
  for (const m of [10, 12, 14, 30]) await job("review", ago(200), "done", ago(200), ago(200 - m), null, "old");
  const running = await job("review", ago(5), "running", ago(5), null, "Reviewing app#7", null);
  await job("review", ago(3), "done", ago(4), ago(3), null, "nothing to do");
  await db.run(db.k.insertInto("job_items").values({ job_id: running, repo: "app", number: 7, at: ago(5) }));
  await db.run(db.k.insertInto("agent_runs").values({ job_id: running, step: "review", stage: 1, prompt_id: "p", prompt_version: "1", provider: "claude", model: "opus", items: "[]", item_count: 1, state: "done", started_at: ago(5), ended_at: ago(4) }));
  await db.run(db.k.insertInto("build_tasks").values({ job_id: running, step: "verify", repo: "app", number: 7, head_sha: "abc", requires: "{}", plan: "[]", state: "done", queued_at: ago(4), started_at: ago(4), ended_at: ago(2),
    results: JSON.stringify([{ step: "install", exitCode: 0, durationMs: 30_000, timedOut: false }, { step: "test", exitCode: 1, durationMs: 60_000, timedOut: false }]) }));

  const { lanes } = await live(db, req);
  const lane = lanes.find((l) => l.key === `job:${running}`)!;
  assert.equal(lane.state, "running");
  assert.equal(lane.line, "Reviewing app#7");
  assert.equal(lane.item?.title, "Fix the thing");
  assert.deepEqual(lane.estimate && { median: Math.round(lane.estimate.median / 60_000), samples: lane.estimate.samples }, { median: 12, samples: 5 });
  assert.deepEqual(lane.ops.map((o) => [o.kind, o.label, !!o.failed]), [["model", "opus", false], ["setup", "install", false], ["tests", "test", true]]);
  // The ended job touched no item: it is left out.
  assert.equal(lanes.length, 1);
});

test("build steps are sorted into kinds by name", () => {
  assert.deepEqual(["npm ci", "cargo build", "cargo test", "clippy", "tsc", "deploy"].map(buildKind), ["setup", "build", "tests", "lint", "lint", "other"]);
});

test("viewers see no progress line that names a repo hidden from them on the Live board", async () => {
  const db = await connectDb(":memory:");
  await db.run(db.k.insertInto("repos").values([{ name: "app", visibility: "public" }, { name: "secret", visibility: "private" }]));
  await db.run(db.k.insertInto("tracked_repos").values([{ name: "app" }, { name: "secret" }]).onConflict((oc) => oc.doNothing()));
  const job = (await db.get(db.k.insertInto("jobs").values({ step: "review", params: "{}", requested_by: "pipeline", requested_at: ago(5), state: "running", started_at: ago(5), progress: "Reviewing app#7" }).returning("id")))!.id;
  await db.run(db.k.insertInto("job_items").values({ job_id: job, repo: "app", number: 7, at: ago(5) }));
  const run = async (jobId: number | null, progress: string) => {
    const id = await insertRun(db, { jobId, step: "review", stage: 1, promptId: "p", promptVersion: "1", provider: "claude", model: "opus", items: [{ repo: "app", number: 7 }], prompt: "p" });
    await db.run(db.k.updateTable("agent_runs").set({ state: "running", started_at: ago(4), progress }).where("id", "=", id));
  };
  await run(job, "Reading app/src/main.rs");
  await run(null, "Comparing with secret#3");
  const as = (role: "viewer" | "maintainer" | "operator") => ({ query: new URLSearchParams(), user: { role, login: "u", canRead: async (r: string) => r !== "secret" } }) as unknown as Req;

  const board = (await live(db, as("viewer"))).lanes;
  assert.deepEqual(board.flatMap((l) => l.ops.map((o) => o.detail)), ["Review", "Review"]);
  assert.equal(board.find((l) => l.key.startsWith("run:"))?.line, null);
});

test("the worker view: staff see shared runners with owner, slots and models, private runners as one neutral row; never a hostname", async () => {
  const db = await connectDb(":memory:");
  await db.run(db.k.insertInto("repos").values([{ name: "app", visibility: "public" }, { name: "secret", visibility: "private" }]));
  await db.run(db.k.insertInto("tracked_repos").values([{ name: "app" }, { name: "secret" }]).onConflict((oc) => oc.doNothing()));
  const token = async (login: string, label: string, hostname: string) => (await db.get(db.k.insertInto("mcp_tokens").values({
    login, token_hash: `h-${label}`, label, kind: "runner", can_run: 1, created_at: ago(600), expires_at: new Date(Date.now() + 86400_000).toISOString(),
    machine: JSON.stringify({ hostname, platform: "linux", arch: "x64" }),
  }).returning("id")))!.id;
  const status = (slots: number, readiness: string, models: Record<string, string>) => parseStatus({ slots, busy: 0, readiness, harness: "claude", models, reserve: { fiveHour: 0, weekly: 0 } });
  const alice = await token("alice", "alice laptop", "alice-host.lan");
  const carol = await token("carol", "carol-box", "carol-box"); // the label defaulted to the hostname
  const bob = await token("bob", "bob desktop", "bob-host.lan");
  await storeStatus(db, alice, "alice", status(2, "ready", { top: "opus", mid: "sonnet" }));
  await storeStatus(db, carol, "carol", status(1, "ready", { mid: "sonnet" }));
  await storeStatus(db, bob, "bob", status(3, "ready", { top: "opus" }));
  const as = (role: "viewer" | "maintainer" | "operator", login = "u", json?: unknown) =>
    ({ query: new URLSearchParams(), json, user: { role, login, canRead: async (r: string) => r !== "secret", canWrite: async () => false } }) as unknown as Req;
  await setSettings(db, as("maintainer", "bob", { runnerPrivate: true }));
  assert.ok(await db.get(db.k.selectFrom("audit").select("at").where("action", "=", "runner-private").where("login", "=", "bob")), "the switch is audited");

  const call = async (o: { runner?: { token: number; login: string }; repo?: string; started: number; ended?: number }) => {
    const id = await insertRun(db, { jobId: null, step: "review", stage: 1, promptId: "p", promptVersion: "1", provider: "claude", model: "opus", items: [{ repo: o.repo ?? "app", number: 7 }], prompt: "p" });
    const ended = o.ended === undefined ? null : ago(o.ended);
    await db.run(db.k.updateTable("agent_runs").set({ state: ended ? "done" : "running", started_at: ago(o.started), ended_at: ended, input_tokens: 100, user_login: o.runner?.login ?? null }).where("id", "=", id));
    if (o.runner) await db.run(db.k.insertInto("remote_calls").values({
      step: "review", stage: 1, run_id: id, prompt_id: "p", prompt_version: "1", tier: "top", effort: "high", asked_model: "opus", bundle: "{}", state: ended ? "done" : "leased",
      since: 0, seen_at: 0, max_attempts: 1, timeout_ms: 60000, token_id: o.runner.token, user_login: o.runner.login, ended_at: ended ? Date.now() - o.ended! * 60_000 : null,
    }));
    return id;
  };
  const running = await call({ runner: { token: alice, login: "alice" }, started: 3 });
  const done = await call({ runner: { token: alice, login: "alice" }, started: 20, ended: 12 });
  await call({ runner: { token: alice, login: "alice" }, started: 300, ended: 200 }); // before the window
  await call({ runner: { token: alice, login: "alice" }, repo: "secret", started: 9, ended: 8 });
  const bobs = await call({ runner: { token: bob, login: "bob" }, started: 5 });

  assert.equal((await live(db, as("viewer"))).workers, undefined, "viewers get no workers");
  const steps = async (login: string) => (await live(db, as("operator", login))).lanes.flatMap((l) => l.ops.map((o) => o.detail));
  assert.ok((await steps("u")).some((d) => d?.endsWith(" on alice")), "an operator's lanes name the shared runner's owner");
  assert.ok(!(await steps("u")).some((d) => d?.includes("bob")), "and not the private one's");
  assert.ok((await steps("bob")).some((d) => d?.endsWith(" on bob")), "except to its owner");
  const board = await live(db, as("maintainer"));
  const rows = board.workers!;
  const a = rows.find((w) => w.key === `runner:${alice}`)!;
  assert.deepEqual([a.login, a.name, a.status, a.busy, a.slots, a.models], ["alice", "alice laptop", "online", 1, 2, ["opus", "sonnet"]]);
  assert.deepEqual(a.calls.map((c) => c.id), [done, running], "the window's calls, oldest first, without the hidden repo's");
  assert.equal(rows.find((w) => w.key === `runner:${carol}`)!.name, "Task Runner", "a label that is the hostname is not shown");
  const p = rows.find((w) => w.kind === "private")!;
  assert.deepEqual([p.name, p.login, p.harness, p.slots, p.models, p.calls.map((c) => c.id)], ["Private Task Runner", null, null, null, [], [bobs]]);
  assert.ok(!rows.some((w) => w.login === "bob" || w.key === `runner:${bob}`), "no row names the private runner's owner");
  assert.doesNotMatch(JSON.stringify(rows), /bob/, "the private runner's login and label go nowhere");
  assert.equal(rows.find((w) => w.key === `runner:${bob}`), undefined);
  const own = (await live(db, as("maintainer", "bob"))).workers!.find((w) => w.key === `runner:${bob}`)!;
  assert.deepEqual([own.login, own.calls.map((c) => c.id)], ["bob", [bobs]], "the owner sees their own private runner");
  const op = await live(db, as("operator"));
  for (const r of [board, op, await live(db, as("maintainer", "bob"))]) assert.doesNotMatch(JSON.stringify(r), /alice-host|carol-box|bob-host/, "no hostname in any reply");
});
