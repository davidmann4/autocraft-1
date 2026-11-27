// What makes the planner due: a change to any of its inputs, the end of work, a wait that ends by itself; never its own or other bookkeeping.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { addLogin, endPermissions, savePermissions, setRole } from "../src/data/access/index.ts";
import { claimTasks, createTasks, finishTask } from "../src/data/build/index.ts";
import { finishPatch } from "../src/data/changes/index.ts";
import { addAudit } from "../src/data/control/index.ts";
import { finishRuns, openRun } from "../src/data/inference/index.ts";
import { releaseHeld } from "../src/data/intake/index.ts";
import { releaseLeases, takeLeases } from "../src/data/jobs/index.ts";
import { noteMergeable } from "../src/data/merge/index.ts";
import { bindAuthorIds, finishSyncRun, markGateFailures, saveAuthorPermissions, saveGates, saveSyncState, startSyncRun } from "../src/data/mirror/index.ts";
import { markStale, recordReviewFailures } from "../src/data/review/index.ts";
import { markHelperIdle } from "../src/data/runners/index.ts";
import { addFindings, moveFindings } from "../src/data/security/index.ts";
import { saveEmbeddings, markJevFailed } from "../src/data/triage/index.ts";
import { liveTriggers } from "../src/db/live.ts";
import { runSync } from "../src/mirror.ts";
import { applyProposals, detectAutopilot, DUE_TOPICS, fingerprintOf, INPUT_TOPICS, LANES, pauseOf, planDue, setEnabled, setLimit } from "../src/runner/autopilot.ts";
import { Runner } from "../src/runner/runner.ts";
import { PLAN_INPUTS } from "../src/trigger-sources.ts";
import { connectDb, type Db } from "./helpers/raw-db.ts";
import { SCRATCH } from "./scratch.ts";
import { OPERATOR, world } from "./world-db.ts";

test("a step paused until an operator acts sets no wake time", async () => {
  const w = await (await (await world()).repo()).issue(1);
  const lanes = LANES.filter((l) => l.name === "priority");
  await setLimit(w.db, "prioritize", { perDay: 0 }, OPERATOR);
  assert.equal((await pauseOf(w.db, "prioritize"))?.wakeAt, null);
  const r = await detectAutopilot(w.db, { lanes });
  assert.equal(r.wakeAt ?? null, null, "only a write lifts a limit of 0");
});

const T = "2026-01-01T00:00:00.000Z";
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

mkdirSync(SCRATCH, { recursive: true });
const scratch = async (): Promise<Db> => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "planner-wakes-")), "t.db"));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", pipeline: 1 }));
  await db.run(db.k.insertInto("items").values([1, 2].map((number) => ({ repo: "app", number, kind: "pr", state: "OPEN", title: "t", body: "b", is_draft: 0, author: "ann", created_at: T, updated_at: T, head_oid: "h" }))));
  await setEnabled(db, true, OPERATOR);
  return db;
};
const settle = async (db: Db): Promise<void> => {
  for (let i = 0; i < 3; i++) if (!await planDue(db)) return;
  assert.fail("the planner stays due with no write in between");
};
/** Whether `write` makes a planner due that was not. */
const wakes = async (db: Db, write: () => Promise<unknown>): Promise<boolean> => {
  await settle(db);
  await write();
  return await planDue(db);
};

test("every planner input table feeds a topic that makes the planner due, or says why it needs none", () => {
  const fed = new Set(liveTriggers().filter((t) => DUE_TOPICS.includes(t.topic)).map((t) => t.table));
  const unplanned = [...new Set(PLAN_INPUTS.filter((i) => i.class !== "none" && !i.noTopic && !fed.has(i.table)).map((i) => i.table))];
  assert.deepEqual(unplanned, [], "register a source of the plan-inputs topic, or give the input a noTopic reason");
});

describe("a write to one planner input alone", async () => {
  const db = await scratch();
  after(() => db.close());
  const gate = (o: { blocked: number; by?: string; at: string }) => saveGates(db, [{ repo: "app", number: 1, blocked: o.blocked, by_login: o.by ?? "", read_at: o.at }]);
  const perm = (permission: string, checkedAt: string) => savePermissions(db, [{ login: "mia", repo: "app", permission, checkedAt }]);
  const author = (permission: string | null) => saveAuthorPermissions(db, [{ login: "ann", repo: "app", permission, at: new Date().toISOString(), authorId: 7 }]);
  const embed = (hash: string) => saveEmbeddings(db, [{ repo: "app", number: 1, model: "m", hash, vec: new Uint8Array(4) }]);
  const finding = (number: number, fix_pr: number | null) => ({ number, fix_pr, scan_id: 1, area: "a", title: "t", severity: "high", urgent: 0, state: "new", refs: "[]", reach: "r", impact: "i", fingerprint: `f${number}`, fork: null }) as never;
  const merge = (state: string) => finishPatch(db, { kind: "conflict", repo: "app", number: 1, head: "h", state, reason: "r", files: [], attempt: 1, at: T } as never);

  for (const [what, write, due] of [
    ["a role given", () => addLogin(db, OPERATOR, { login: "mia", role: "viewer", note: null }), true],
    ["a role changed", () => setRole(db, OPERATOR, "mia", "maintainer"), true],
    ["a first permission", () => perm("write", ago(60_000)), true],
    ["a fresh permission read again", () => perm("write", ago(0)), false],
    ["a permission lowered", () => perm("read", ago(3600_000)), true],
    ["a lapsed permission read again", () => perm("read", ago(0)), true],
    ["permissions ended", () => endPermissions(db, ["mia"]), true],
    ["the app's slug", () => db.run(db.k.insertInto("github_app").values({ id: 1, app_id: "1", slug: "bot", keys_enc: "x", updated_at: T })), true],
    ["the app's keys", () => db.run(db.k.updateTable("github_app").set({ keys_enc: "y", updated_at: T })), false],
    ["an author's account id", () => bindAuthorIds(db, [{ login: "ann", id: 7 }]), true],
    ["a bound account id", () => bindAuthorIds(db, [{ login: "ann", id: 7 }]), false],
    ["a failed read of an author's permission", () => author(null), false],
    ["an author's permission", () => author("write"), true],
    ["the same permission again", () => author("write"), false],
    ["a review marked stale", () => markStale(db, [{ repo: "app", number: 1 }], null), true],
    ["a failed review", () => recordReviewFailures(db, [{ repo: "app", number: 1, head: "h", at: T }]), false],
    ["a failed gate read", () => markGateFailures(db, ["app#1"]), false],
    ["a first gate read", () => gate({ blocked: 1, by: "mia", at: ago(60_000) }), true],
    ["the gate read again", () => gate({ blocked: 1, by: "mia", at: ago(50_000) }), false],
    ["the gate lifted", () => gate({ blocked: 0, at: ago(40_000) }), true],
    ["a vector", () => embed("1"), true],
    ["a failed classify request", () => markJevFailed(db, [{ repo: "app", number: 1, hash: "1" }] as never), true],
    ["the same request failed again", () => markJevFailed(db, [{ repo: "app", number: 1, hash: "1" }] as never), false],
    ["a conflict merge", () => merge("failed"), true],
    ["a finding without a pull request", () => addFindings(db, "app", [finding(1, null)]), false],
    ["a finding without a pull request settled", () => moveFindings(db, [{ repo: "app", number: 1, action: "dismiss", by: OPERATOR, reason: null }]), false],
    ["a finding with one", () => addFindings(db, "app", [finding(2, 2)]), true],
    ["a finding with one settled", () => moveFindings(db, [{ repo: "app", number: 2, action: "dismiss", by: OPERATOR, reason: null }]), true],
    ["a PR moved, so its gate read is old", () => db.run(db.k.updateTable("items").set({ updated_at: ago(30_000) }).where("number", "=", 1)), true],
    ["the gate read since, with the same answer", () => gate({ blocked: 0, at: ago(20_000) }), true],
    ["and once more", () => gate({ blocked: 0, at: ago(10_000) }), false],
  ] as [string, () => Promise<unknown>, boolean][]) {
    test(`${what} ${due ? "makes the planner due" : "does not"}`, async () => {
      const before = await db.seqs();
      assert.equal(await wakes(db, write), due);
      const after = await db.seqs();
      const inputs = INPUT_TOPICS.filter((t) => after[t] !== before[t]);
      assert.equal(inputs.length > 0, due, "a lane whose job handled nothing sees it too");
    });
  }

  test("an outside hold released and one that ends with the clock make the planner due", async () => {
    const hold = (number: number) => db.run(db.k.insertInto("outside_holds").values({ repo: "app", number, author: "ann", kind: "pr", reason: "daily" } as never));
    await hold(1);
    await hold(2);
    assert.equal(await wakes(db, () => releaseHeld(db, OPERATOR, [{ repo: "app", number: 1 }])), true);
    const seq = async () => (await db.seqs())["plan-inputs"];
    const before = await seq();
    await detectAutopilot(db);
    assert.notEqual(await seq(), before, "the pass found the hold gone");
    await settle(db);
  });
});

describe("the end of work", async () => {
  const db = await scratch();
  after(() => db.close());
  const job = async (o: { by: string; state: string; ended?: string; step?: string }) => Number((await db.get(db.k.insertInto("jobs")
    .values({ step: o.step ?? "embed", params: "{}", requested_by: o.by, requested_at: T, state: o.state, started_at: T, ended_at: o.ended ?? null }).returning("id")))!.id);

  test("a job that ended makes the planner due once, whoever asked for it and however old its end time is", async () => {
    for (const by of ["pipeline", OPERATOR]) {
      const id = await job({ by, state: "queued" });
      assert.equal(await wakes(db, () => db.run(db.k.updateTable("jobs").set({ state: "cancelled", ended_at: T }).where("id", "=", id))), true);
      assert.equal(await planDue(db), false);
    }
  });

  test("a job's progress and start do not", async () => {
    const id = await job({ by: "pipeline", state: "queued" });
    assert.equal(await wakes(db, () => db.run(db.k.updateTable("jobs").set({ state: "running", progress: "1 of 2" }).where("id", "=", id))), false);
  });

  test("a job that ended is no new input to a lane, so one that handled nothing is not queued again", async () => {
    const lane = LANES.find((l) => l.name === "embed")!;
    const fp = () => fingerprintOf(db, lane, "embed", {});
    const before = await fp();
    await job({ by: "pipeline", state: "done", ended: T });
    assert.equal(await fp(), before);
  });

  test("a lease given back makes the planner due", async () => {
    const id = await job({ by: "pipeline", state: "running", step: "fixup" });
    await takeLeases(db, ["pr:app#1"], { id, step: "fixup" });
    assert.equal(await wakes(db, () => releaseLeases(db, { keys: ["pr:app#1"], jobId: id })), true);
  });

  test("a sandbox task that ended makes the planner due, also when a later one ended before it, and is new input to the lanes that read results", async () => {
    await db.run(db.k.insertInto("build_envs").values({ id: "w", label: "w", kind: "remote", slots: 4, key_hash: "none", created_at: T }));
    const task = (number: number) => ({ step: "verify", repo: "app", number, headSha: "a".repeat(40), plan: [{ name: "build", cmd: ["true"], network: "none" as const, timeoutSec: 60 }] });
    const [a, b] = await createTasks(db, [task(1), task(2)]);
    await claimTasks(db, "w", [{ id: a! }, { id: b! }], T);
    const end = (id: number) => finishTask(db, "w", id, { results: [{ step: "b", exitCode: 1, durationMs: 1, timedOut: false }], summary: null, sandbox: null, failed: false });
    assert.equal(await wakes(db, () => end(b!)), true);
    const collect = LANES.find((l) => l.name === "verify-collect")!;
    const before = await fingerprintOf(db, collect, "verify-collect", {});
    assert.equal(await wakes(db, async () => {
      await end(a!);
      await db.run(db.k.updateTable("build_tasks").set({ ended_at: T }).where("id", "=", a!));
    }), true);
    assert.notEqual(await fingerprintOf(db, collect, "verify-collect", {}), before);
  });
});

describe("an idle system's bookkeeping does not make the planner due", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "planner-idle-")), "t.db"));
  after(() => db.close());
  await db.run(db.k.deleteFrom("tracked_repos"));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", pipeline: 1 }));
  await db.run(db.k.insertInto("repos").values({ name: "app", synced_at: ago(3600_000), high_water: ago(3600_000), reconciled_at: ago(0) }));
  await db.run(db.k.insertInto("items").values({ repo: "app", number: 1, kind: "pr", state: "OPEN", title: "t", body: "b", is_draft: 0, author: "ann", created_at: T, updated_at: T, head_oid: "h" }));
  await setEnabled(db, true, OPERATOR);

  test("a pass that plans nothing", async () => {
    // The first pass stores the plans, the next finds them unchanged.
    const lanes = LANES.filter((l) => l.name === "merge");
    const pass = async () => {
      const found = await detectAutopilot(db);
      const merge = await detectAutopilot(db, { lanes });
      assert.deepEqual(merge.proposals, []);
      await applyProposals(db, [], { wakeAt: found.wakeAt, ...(found.status ? { status: found.status } : {}) });
    };
    await pass();
    assert.equal(await wakes(db, pass), false);
  });

  test("a runner tick", async () => {
    let passes = 0;
    const dir = mkdtempSync(join(SCRATCH, "planner-idle-runner-"));
    const r = new Runner({ db, dbTarget: join(dir, "none.db"), logs: join(dir, "logs"), killAfterMs: 100, log: () => {}, detect: async () => { passes++; return { proposals: [], logs: [], wakeAt: null }; } });
    const tick = async () => { await r.tick(); await new Promise((x) => setTimeout(x, 50)); };
    try {
      for (let i = 0; i < 4; i++) await tick();
      const settled = passes;
      for (let i = 0; i < 4; i++) await tick();
      assert.equal(passes, settled);
    } finally { await r.stop(); }
  });

  test("a caller's poll", async () => {
    await markHelperIdle(db, { tokenId: 1, login: "mia" } as never, { now: Date.now(), tiers: [], repos: null });
    assert.equal(await wakes(db, () => markHelperIdle(db, { tokenId: 1, login: "mia" } as never, { now: Date.now() + 1000, tiers: [], repos: null })), false);
  });

  test("a sync that changes nothing", async () => {
    await saveSyncState(db, { org_high_water: ago(60_000), repos_refreshed_at: "2999-01-01T00:00:00Z", search_catchup_at: "2999-01-01T00:00:00Z" });
    const client = { spent: 0, remaining: 4000 as number | null, query: async () => ({ search: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } }) };
    let mode: string | undefined;
    assert.equal(await wakes(db, async () => {
      const id = await startSyncRun(db, ago(0));
      mode = (await runSync(db, client, { only: [], all: false, full: false, perRepo: false })).mode;
      await finishSyncRun(db, id, { endedAt: ago(0), mode: "search", items: 0 });
    }), false);
    assert.equal(mode, "search");
  });

  test("model runs, audit rows and reads that repeat a known answer", async () => {
    assert.equal(await wakes(db, async () => {
      const id = await openRun(db, { jobId: null, step: "opus-review", stage: 8, promptId: "p", promptVersion: 1, provider: "claude", model: "opus", items: [{ repo: "app", number: 1 }], prompt: "x" } as never, (x) => x);
      await finishRuns(db, [{ id, state: "done", output: "x" }] as never, (x) => x);
      await addAudit(db, [{ login: "pipeline", action: "comment", target: "app#1" }]);
      await noteMergeable(db, [{ repo: "app", number: 1, head_oid: "h", state: "OPEN", overall: "success", mergeable: "UNKNOWN" }] as never, T, new Set(["app#1@h"]));
    }), false);
  });
});
