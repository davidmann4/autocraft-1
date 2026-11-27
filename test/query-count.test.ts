// The hot paths read the database in sets: each unit runs at two sizes inside db.meter, and its statement count must not
// grow with the size. The data modules' own loaders are covered in test/data; these are the whole paths over them.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Kysely } from "kysely";
import { join } from "node:path";
import { allocation, poolRoom } from "../src/agents/call.ts";
import { pool, runJev, setRunner } from "../src/classify/run.ts";
import { withConfig } from "../src/data/control/index.ts";
import { effect } from "../src/db/effects.ts";
import { COLUMNS } from "../src/db/types.ts";
import { activity } from "../src/dash/api/activity.ts";
import { allRepos } from "../src/dash/api/admin.ts";
import { nextPage } from "../src/dash/api/next.ts";
import { queuePage } from "../src/dash/api/queue-page.ts";
import { TokenBox } from "../src/dash/server/crypto.ts";
import { FakeProvider } from "../src/dash/server/provider.ts";
import { makeUser } from "../src/dash/server/sessions.ts";
import { refreshPlanCache } from "../src/core/plan-cache.ts";
import { runRank } from "../src/rank/index.ts";
import { runDupeCompare, type CompareDeps } from "../src/dupes/compare.ts";
import { fillEmbedHashes } from "../src/itemhash.ts";
import { embedDue } from "../src/embed/store.ts";
import { parseStatus, storeStatus } from "../src/remote/helpers.ts";
import { queueSlots } from "../src/rank/position.ts";
import { itemPage } from "../src/dash/api/item-page.ts";
import { setMainFixApproval } from "../src/mainfix/approval.ts";
import { live } from "../src/dash/api/live.ts";
import { home, items } from "../src/dash/api/maintain.ts";
import { item } from "../src/dash/api/maintain-item.ts";
import { trace } from "../src/dash/api/trace.ts";
import type { Req } from "../src/dash/types.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { awaitCall, claimCall, enqueueCall } from "../src/remote/calls.ts";
import { planned } from "../src/core/select.ts";
import { applyProposals, detectAutopilot } from "../src/runner/autopilot.ts";
import { JobLogCopy } from "../src/runner/job-log.ts";
import { Runner } from "../src/runner/runner.ts";
import { loadSteps } from "../src/runner/steps.ts";
import { addEvent, insertWorkflow } from "../src/workflow/store.ts";
import { expectFlat, type FlatUnit } from "./helpers/query-count.ts";
import { PROTOCOL_VERSION, type Claim } from "../src/remote/protocol.ts";
import { tmpdir, world, type World } from "./world-db.ts";

const iso = (minAgo: number): string => new Date(Date.now() - minAgo * 60_000).toISOString();
const until = async (done: () => boolean): Promise<void> => { for (let i = 0; i < 500 && !done(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(done()); };
const numbers = (n: number, from = 1): number[] => Array.from({ length: n }, (_, i) => from + i);

const req = (query: Record<string, string> = {}, params: Record<string, string> = {}): Req => ({
  method: "GET", path: "", params, query: new URLSearchParams(query), form: new URLSearchParams(), csrf: "", nonce: "",
  user: { login: "op", role: "operator", canRead: async () => true, canWrite: async () => true },
}) as unknown as Req;

/** A unit over a new database with the tracked repo "app": `seed` fills it and returns the work to count. */
const unit = (seed: (w: World, size: number) => Promise<() => Promise<unknown>>) => async (size: number): Promise<FlatUnit> => {
  const w = await world();
  await w.repo();
  const run = await seed(w, size);
  return { db: w.db, run, close: async () => { w.close(); await w.db.close(); } };
};

/** Where a seeded pull request is in the pipeline. */
const POINTS: { pr?: Parameters<World["pr"]>[1]; review?: Parameters<World["review"]>[1]; checked?: true; started?: "review" | "merge" }[] = [
  {},
  { review: { verdict: "take" } },
  { review: { verdict: "take-fix" }, started: "review" },
  { pr: { ci: "failure" }, review: { verdict: "take" }, started: "review" },
  { pr: { mergeable: "CONFLICTING" } },
  { review: { verdict: "take" }, checked: true, started: "merge" },
];

/** `n` pull requests at each point, numbered from 1, so both sizes of a unit meet the same cases. */
const seedPrs = (w: World, n: number): Promise<void> => w.db.write(async () => {
  for (const i of numbers(n, 0)) {
    for (const [k, p] of POINTS.entries()) {
      const pr = i * POINTS.length + k + 1;
      await w.pr(pr, p.pr);
      if (p.review) await w.review(pr, p.review);
      if (p.checked) { await w.verified(pr); await w.premerge(pr, "clean"); }
      if (p.started) await insertWorkflow(w.db, { kind: "pr", entry: p.started, startedBy: "op", startedAt: iso(60), startedVia: "github", repo: "app", number: pr, state: "running" });
    }
  }
});

/** More tracked repos, each with the rows of "app". */
async function addRepos(w: World, names: readonly string[]): Promise<void> {
  const k = w.db.k as unknown as Kysely<Record<string, Record<string, unknown>>>;
  for (const table of ["tracked_repos", "repos", "items", "classifications", "pr_checks", "opus_reviews", "item_priority", "repo_step_approvals", "main_ci"] as const) {
    const repoCol = table === "tracked_repos" || table === "repos" ? "name" : "repo";
    const rows = await w.db.all(k.selectFrom(table).select([...COLUMNS[table]]).where(repoCol, "=", "app"));
    for (const name of names) if (rows.length) await w.db.run(k.insertInto(table).values(rows.map((r) => ({ ...r, [repoCol]: name }))));
  }
}

/** A job over `list` with one model call and one build task per item. */
const seedJob = (w: World, state: "running" | "done", list: readonly number[]): Promise<number> => w.db.write(async () => {
  const { db } = w;
  const ended = state === "done" ? iso(2) : null;
  const id = Number((await db.get(db.k.insertInto("jobs").values({ step: "opus-review", params: JSON.stringify({ repo: "app" }), requested_by: "pipeline", requested_at: iso(6), state, started_at: iso(5), ended_at: ended }).returning("id")))!.id);
  for (const n of list) {
    await db.run(db.k.insertInto("job_items").values({ job_id: id, repo: "app", number: n, at: iso(5) }));
    const run = Number((await db.get(db.k.insertInto("agent_runs").values({
      job_id: id, step: "opus-review", stage: 5, prompt_id: "review.opus", prompt_version: "1", provider: "claude", model: "opus", items: JSON.stringify([`app#${n}`]), state, started_at: iso(4), ended_at: ended,
    }).returning("id")))!.id);
    await db.run(db.k.insertInto("agent_run_items").values({ run_id: run, repo: "app", number: n }));
    await db.run(db.k.insertInto("build_tasks").values({ job_id: id, step: "verify", repo: "app", number: n, head_sha: `sha${n}`, requires: "{}", plan: "[]", state: state === "done" ? "done" : "running", queued_at: iso(4) }));
  }
  return id;
});

test("a full planner pass, and one over the items that changed, read in sets", async (t) => {
  // Reads kept for a second or so (the Task Runner snapshot) must not expire in a slow pass.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const full = unit(async (w, n) => {
    await seedPrs(w, n);
    for (const i of numbers(n, 100)) await w.issue(i);
    return () => detectAutopilot(w.db);
  });
  await expectFlat(full, 2, 12);
  const changed = unit(async (w, n) => {
    await seedPrs(w, 12);
    await detectAutopilot(w.db);
    for (const i of numbers(n * POINTS.length)) await w.db.run(w.db.k.updateTable("items").set({ title: "new title" }).where("number", "=", i));
    return () => detectAutopilot(w.db);
  });
  await expectFlat(changed, 2, 12);
  // Two repos at the small size: the copies of "app" have no started work, so they meet cases "app" does not.
  await expectFlat(unit(async (w, n) => {
    await seedPrs(w, 2);
    await setMainFixApproval(w.db, "op", "app", true);
    await w.db.run(w.db.k.insertInto("main_ci").values({ repo: "app", head_sha: "main1", branch: "main", state: "red", failing: '[{"name":"gate / test","url":null}]', checks: "[]", committed_at: iso(90), headline: "h", first_seen_at: iso(80), state_changed_at: iso(70), updated_at: iso(5) }));
    await addRepos(w, numbers(n - 1).map((i) => `app${i}`));
    return () => detectAutopilot(w.db);
  }), 2, 5);
});

test("the lanes of repos with the write steps on, and the queueing of a pass's proposals, read in sets", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const repos = (n: number): string[] => ["app", ...numbers(n - 1).map((i) => `app${i}`)];
  const seeded = async (w: World, n: number): Promise<void> => {
    await seedPrs(w, 2);
    for (const i of numbers(4, 100)) await w.issue(i);
    await addRepos(w, repos(n).slice(1));
    const k = w.db.k as unknown as Kysely<Record<string, Record<string, unknown>>>;
    await w.db.write(async () => { for (const repo of repos(n)) {
      for (const step of ["prstatus", "labels"]) await w.db.run(k.insertInto("repo_step_approvals").values({ repo, step, by: "op", at: iso(60) }));
      await w.db.run(k.insertInto("settings").values({ key: `build_feature:pr-builds:${repo}`, value: "on" }));
      for (const pr of numbers(POINTS.length)) {
        await w.db.run(k.insertInto("item_stage").values({ repo, number: pr, stage: "reviewed", at: iso(90), reviewed: 1 }));
        // A started issue's line names what its workflow waits for, read for every started item of every repo at once.
        await w.db.run(k.insertInto("item_workflows").values({ repo, number: 100 + (pr % 4), kind: "issue", entry: "implement", state: "done", started_by: "op", started_at: iso(50), started_via: "github", updated_at: iso(50) }));
      }
      await w.db.run(k.insertInto("item_workflows").values({ repo, number: 1, kind: "pr", entry: "review", state: "waiting", started_by: "op", started_at: iso(50), started_via: "github", updated_at: iso(50) }));
    } });
  };
  await expectFlat(unit(async (w, n) => {
    await seeded(w, n);
    return () => detectAutopilot(w.db);
  }), 2, 5);
  await expectFlat(unit(async (w, n) => {
    await seeded(w, n);
    // The steps' own request checks read per proposal (in shared waves); the rest of queueing does not.
    const steps = await loadSteps(), free = (await detectAutopilot(w.db)).proposals.filter((p) => !steps.get(p.step)!.check);
    assert.ok(free.length > 1, "several proposals, or the count below says nothing");
    return () => applyProposals(w.db, n === 2 ? free.slice(0, 1) : free, {});
  }), 2, 5);
});

test("a job's start decides the PRs and items that can be due in sets", async () => {
  await expectFlat(unit(async (w, n) => {
    await seedPrs(w, n);
    for (const i of numbers(n, 100)) await w.issue(i);
    return () => planned(w.db, "review", { repo: "app" });
  }), 2, 12);
});

const bundle = { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", timeoutSeconds: 600, maxTurns: 10, stdin: "x", system: null, mounts: [], mcpServers: [], keepSession: false, hints: {} } as const;
const queueCall = (w: World, n: number): Promise<number> =>
  enqueueCall(w.db, { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", askedModel: "opus", bundle: { ...bundle } as never, items: [{ repo: "app", number: n }], level: n % 5, maxAttempts: 2 });

test("a Task Runner's claim reads the queue and the other Task Runners in sets", async () => {
  let k = 0;
  const claims = (queued: number, runners: number, leases: boolean) => unit(async (w) => {
    await seedPrs(w, queued);
    for (const n of numbers(queued)) await queueCall(w, n);
    const tokens: number[] = [];
    for (const i of numbers(runners)) {
      const login = `m${i}`;
      await w.db.run(w.db.k.insertInto("access").values({ login, role: "maintainer" }));
      tokens.push((await createToken(w.db, login, "helper", { kind: "runner" })).row.id);
    }
    const claim: Claim = { requestId: `query-count-${++k}`, protocol: PROTOCOL_VERSION, helperVersion: "9.0.0", harness: "claude", harnessVersion: "2.1", tiers: { top: "opus" } } as Claim;
    return async () => assert.equal((await claimCall(w.db, { tokenId: tokens[0]!, login: "m1", role: "maintainer" }, claim, async () => leases)).lease !== null, leases);
  });
  for (const leases of [true, false]) {
    await expectFlat((n) => claims(n, 1, leases)(n), 2, 10);
    await expectFlat((n) => claims(2, n, leases)(n), 1, 4);
  }
});

test("a pool waiting for room reads the room when the queue changes, not on every poll", async () => {
  // A ready Task Runner that is not active: it takes the units' calls, but there is no room for them now.
  const reads = async (unitMs: number): Promise<number> => {
    const w = await world();
    await w.repo();
    await w.db.run(w.db.k.insertInto("access").values({ login: "olga", role: "operator" }));
    const id = (await createToken(w.db, "olga", "helper", { kind: "runner" })).row.id;
    await storeStatus(w.db, id, "olga", parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }));
    // A reading of the room is one wave that holds the change counters' read beside the room's loaders. How many statements a reading
    // takes varies with the 2 s caches of the runner snapshot and the queue (a stale cache adds a read after the wave, on Postgres a
    // statement of its own), so the readings are counted, not their statements; a poll of the counters alone is no reading.
    let n = 0;
    const stop = w.db.observe((e) => { if (e.kind === "query" && /change_seq/.test(e.sql) && e.site.includes(" + ")) n++; });
    try {
      // Each unit stands for a call waiting in the queue: the others wait for room meanwhile.
      await pool(numbers(units).map(() => () => new Promise((r) => setTimeout(r, unitMs))), poolRoom(w.db, () => ["app"], (i) => [{ repo: "app", number: i + 1 }]), { pollMs: 2 });
    } finally {
      stop();
      w.close();
      await w.db.close();
    }
    return n;
  };
  // Each round of the pool reads the room once and either starts a unit or waits for one to end, so a reading per unit start and
  // per unit end bounds them whatever the units take; a pool reading on every poll goes past it when they take long.
  const units = 3;
  const short = await reads(20), long = await reads(200);
  assert.ok(short > 0, "the readings are seen");
  assert.ok(long <= 2 * units, `the room was read ${long} times while ${units} calls took 200 ms each (${short} times at 20 ms)`);
});

test("calls that wait for their result share one poll", async () => {
  await expectFlat(unit(async (w, n) => {
    await seedPrs(w, n);
    const ids: number[] = [];
    for (const i of numbers(n)) ids.push(await queueCall(w, i));
    await w.db.run(w.db.k.updateTable("remote_calls").set({ state: "failed", error: "ended" }));
    // Each await is one model call, which opens and closes its own relays; a call whose relays open late joins the next poll.
    return () => Promise.all(ids.map((id) => { effect("model-call"); return awaitCall(w.db, id, { log: () => {} }); }));
  }), 1, 8, { perEffect: 3 });
});

test("comparing a duplicate set of pull requests reads their CI in sets", async () => {
  await expectFlat(unit(async (w, n) => {
    const prs = numbers(n);
    // A diff cache of its own: a cached diff is read without a fetch.
    process.env.AUTOCRAFT_DIFF_CACHE = tmpdir("query-count-diffs");
    for (const i of prs) await w.pr(i, { ci: i % 2 ? "failure" : "success" });
    await fillEmbedHashes(w.db);
    const hash = new Map((await w.db.all(w.db.k.selectFrom("items").select(["number", "embed_hash"]).where("repo", "=", "app"))).map((r) => [Number(r.number), r.embed_hash!]));
    // One group: a chain of duplicate pairs, compared in one call (n stays within GROUP_MAX).
    await w.db.run(w.db.k.insertInto("duplicate_pairs").values(prs.slice(1).map((b) => ({
      repo: "app", a: b - 1, b, a_hash: hash.get(b - 1)!, b_hash: hash.get(b)!, similarity: 0.9, verdict: "duplicate", canonical: b - 1, created_at: iso(60), checked_at: iso(60),
    }))));
    await w.db.run(w.db.k.insertInto("access").values({ login: "olga", role: "operator" }));
    const id = (await createToken(w.db, "olga", "helper", { kind: "runner" })).row.id;
    await storeStatus(w.db, id, "olga", parseStatus({ slots: 4, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }));
    await w.db.run(w.db.k.updateTable("remote_helpers").set({ idle_claim_at: Date.now() }).where("token_id", "=", id));
    const deps: CompareDeps = {
      fetchDiff: async () => { effect("github-read"); return { ok: true, text: "diff --git a/src/x.rs b/src/x.rs\n--- a/src/x.rs\n+++ b/src/x.rs\n@@ -1 +1 @@\n-a\n+b\n" } as never; },
      ask: (async () => {
        effect("model-call");
        return { text: JSON.stringify({ keep: 1, reason: "first", summary: "The same fix.", why: "It came first.", others: prs.slice(1).map((number) => ({ number, duplicate: true, better: [], carry: [] })) }), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: null } };
      }) as never,
      now: () => new Date(),
    };
    return async () => assert.equal((await runDupeCompare(w.db, {}, () => {}, deps)).compared, 1);
  }), 2, 8).finally(() => { delete process.env.AUTOCRAFT_DIFF_CACHE; });
});

test("calls a Task Runner runs cost their caller no write while nothing asks for a check", async () => {
  const w = await world();
  await w.repo();
  await seedPrs(w, 3);
  const ids: number[] = [];
  for (const i of numbers(3)) ids.push(await queueCall(w, i));
  const now = Date.now();
  await w.db.run(w.db.k.updateTable("remote_calls").set({ state: "leased", leased_at: now, heartbeat_at: now, started_at: now }));
  let polls = 0, writes = 0;
  const stop = w.db.observe((e) => {
    if (e.kind !== "query") return;
    if (/^\s*update\b.*remote_checks/is.test(e.sql)) writes++;
    if (/change_seq/.test(e.sql) && /^\s*select/i.test(e.sql)) polls++;
  });
  const was = allocation.pollMs;
  allocation.pollMs = 10;
  const check = { run: async () => { throw new Error("no check was asked for"); } };
  try {
    const waits = ids.map((id) => awaitCall(w.db, id, { log: () => {}, check: check as never }));
    await until(() => polls >= 3);
    await w.db.run(w.db.k.updateTable("remote_calls").set({ state: "failed", error: "ended" }));
    await Promise.all(waits);
  } finally {
    allocation.pollMs = was;
    stop();
  }
  assert.equal(writes, 0);
  w.close();
  await w.db.close();
});

test("a call that waits while nothing changes reads only the change counters, and its end wakes the poll", async () => {
  const w = await world();
  await w.repo();
  await seedPrs(w, 1);
  const id = await queueCall(w, 1);
  const now = Date.now();
  await w.db.run(w.db.k.updateTable("remote_calls").set({ state: "leased", leased_at: now, heartbeat_at: now, started_at: now }));
  let counters = 0, polls = 0;
  const stop = w.db.observe((e) => {
    if (e.kind !== "query" || !/^\s*select/i.test(e.sql)) return;
    if (/remote_calls/.test(e.sql)) polls++;
    else if (/change_seq/.test(e.sql)) counters++;
  });
  const was = allocation.pollMs;
  allocation.pollMs = 5;
  try {
    const wait = awaitCall(w.db, id, { log: () => {} });
    await until(() => counters >= 10);
    const quiet = polls;
    await w.db.run(w.db.k.updateTable("remote_calls").set({ state: "failed", error: "ended" }));
    assert.equal((await wait).state, "failed");
    assert.ok(quiet < counters, `the call was read ${quiet} times in ${counters} quiet polls`);
    assert.ok(polls > quiet, "the call's end was read");
  } finally {
    allocation.pollMs = was;
    stop();
  }
  w.close();
  await w.db.close();
});

test("the embed lane probes the items for missing vectors only when their counters moved", async () => {
  const w = await world();
  await w.repo();
  await seedPrs(w, 3);
  let probes = 0;
  const stop = w.db.observe((e) => { if (e.kind === "query" && /item_embeddings/.test(e.sql) && /^\s*select/i.test(e.sql)) probes++; });
  const plans = { items: [] } as never;
  try {
    const seqs = await w.db.seqs();
    const first = await embedDue(w.db, "m", plans, seqs);
    const once = probes;
    assert.equal(await embedDue(w.db, "m", plans, seqs), first);
    assert.equal(probes, once, "the same counters ask nothing again");
    await w.pr(9001);
    await embedDue(w.db, "m", plans, await w.db.seqs());
    assert.ok(probes > once, "a new item asks again");
  } finally {
    stop();
  }
  w.close();
  await w.db.close();
});

test("the runs and answers of a classify chunk are written in sets", async () => {
  const restore = setRunner(async () => ({ code: 0, stderr: "", stdout: JSON.stringify({
    answers: { type: { choice: "performance", confidence: 0.95, probabilities: { performance: 0.95, bugfix: 0.05 } }, security: { noul: 0.1 }, needs_decision: { noul: 0.1 } }, usage: { input_tokens: 10, output_tokens: 5 },
  }) }));
  try {
    await expectFlat(unit(async (w, n) => {
      await seedPrs(w, n);
      const chunk = numbers(n).map((number) => ({ repo: "app", number, kind: "pr" as const, title: "t", body: "b", lines_changed: 1, files_changed: 1, author_association: null }));
      return async () => assert.equal((await withConfig(w.db, () => runJev(w.db, "run", chunk, n))).saved.size, n);
    }), 2, 20, { perEffect: 1 });
  } finally { restore(); }
});

test("a runner tick reads its running and queued jobs in sets", async () => {
  const ticks = (running: number, queued: number) => unit(async (w) => {
    const logs = tmpdir("query-count-logs");
    const runner = new Runner({ db: w.db, logs, log: () => {}, detect: async () => ({ proposals: [], logs: [] }) });
    const insert = async (step: string, n: number, state: string): Promise<number> => Number((await w.db.get(w.db.k.insertInto("jobs").values({
      step, params: JSON.stringify({ repo: "app", number: n }), repo: "app", requested_by: "pipeline", requested_at: iso(5), state, started_at: state === "running" ? iso(4) : null,
    }).returning("id")))!.id);
    for (const n of numbers(running)) {
      const id = await insert("opus-review", n, "running");
      const logPath = join(logs, `job-${id}.log`);
      runner.running.set(id, {
        child: { pid: undefined }, termAt: null, exited: Promise.resolve(), startedAt: Date.now(), deadlineMin: 60, logPath, logCopy: JobLogCopy.open(id, logPath), flaggedAt: null,
        noProgressMin: 60, stopMsg: null, remoteSeen: null, remoteWaitMs: 0,
      } as never);
    }
    // No Task Runner is connected, so the queued jobs stay queued.
    for (const n of numbers(queued, 100)) await insert("opus-review", n, "queued");
    // What runs once in a while (the hourly prunes, the first identity read) is done before the counted tick.
    await runner.tick();
    return () => runner.tick();
  });
  await expectFlat((n) => ticks(n, 2)(n), 1, 6);
  await expectFlat((n) => ticks(1, n)(n), 2, 12);
});

test("the live board reads its lanes in sets", async () => {
  await expectFlat(unit(async (w, n) => {
    await seedPrs(w, n);
    for (const i of numbers(n)) { await seedJob(w, "running", [i]); await seedJob(w, "done", [i]); }
    return async () => assert.ok((await live(w.db, req())).lanes.length >= n);
  }), 2, 12);
});

/** One PR with `n` of each thing its pages list. */
const seedBusyPr = (w: World, n: number): Promise<void> => w.db.write(async () => {
  const { db } = w;
  await w.pr(1);
  await w.review(1, { verdict: "take-fix", fixes: numbers(n).map((i) => ({ file: `src/f${i}.rs`, change: "rename" })) });
  for (const i of numbers(n)) {
    await w.issue(100 + i);
    await seedJob(w, "done", [1]);
    await db.run(db.k.insertInto("comments").values({ repo: "app", number: 1, id: `c${i}`, kind: "comment", author: "someone", created_at: iso(100 - i), body: `note ${i}, see #${100 + i}` }));
    await db.run(db.k.insertInto("opus_review_history").values({ repo: "app", number: 1, head_oid: "sha1", at: iso(90 - i), model: "opus", mode: "full", verdict: "take", sure: 1, reason: "r" }));
    const wf = await insertWorkflow(db, { kind: "pr", entry: "review", startedBy: "op", startedAt: iso(80 - i), startedVia: "github", repo: "app", number: 1, state: i === n ? "running" : "stopped" } as never);
    await addEvent(db, { workflowId: wf, repo: "app", number: 1, login: "op", via: "github", kind: "answered" });
  }
  await db.run(db.k.updateTable("items").set({ closing_issues: JSON.stringify(numbers(n, 101)) }).where("number", "=", 1));
});

test("an item's pages read its history in sets", async () => {
  const at = { repo: "app", n: "1" };
  const page = (read: (w: World) => Promise<unknown>) => unit(async (w, n) => { await seedBusyPr(w, n); return () => read(w); });
  await expectFlat(page((w) => itemPage(w.db, req({}, at))), 2, 12);
  await expectFlat(page((w) => item(w.db, req({}, at))), 2, 12);
  await expectFlat(page((w) => trace(w.db, req({}, at))), 2, 12);
});

/** `n` more repos the pipeline works, each with an approval, an optional check and an open PR. */
const seedRepos = ({ db }: World, n: number): Promise<string[]> => db.write(async () => {
  const names = numbers(n).map((i) => `r${i}`);
  for (const r of names) {
    await db.prepare("INSERT INTO tracked_repos (name, pipeline) VALUES (?, 1)").run(r);
    await db.prepare("INSERT INTO repos (name, visibility) VALUES (?, 'private')").run(r);
    await db.prepare("INSERT INTO repo_step_approvals (repo, step, by, at) VALUES (?, 'labels', 'op', ?)").run(r, iso(1));
    await db.prepare("INSERT INTO settings (key, value) VALUES (?, 'on')").run(`build_feature:implement:${r}`);
    await db.prepare("INSERT INTO items (repo, number, kind, state, title, author, created_at, updated_at) VALUES (?, 1, 'pr', 'OPEN', 't', 'dev', ?, ?)").run(r, iso(9), iso(9));
    await db.prepare("INSERT INTO pr_checks (repo, number, head_oid, overall, checks, fetched_at) VALUES (?, 1, 'h', 'success', '[{\"name\":\"build\",\"state\":\"success\"}]', ?)").run(r, iso(5));
    await db.prepare("INSERT INTO repo_permissions (login, repo, permission, checked_at) VALUES ('Mia', ?, 'write', ?)").run(r, new Date().toISOString());
  }
  return names;
});

test("the Repos page reads every repo's settings in sets", async () => {
  await expectFlat(unit(async (w, n) => {
    await seedRepos(w, n);
    return async () => {
      const rows = (await allRepos(w.db, req())).filter((r) => r.name.startsWith("r"));
      assert.equal(rows.length, n);
      assert.ok(rows.every((r) => r.labels?.approved && r.labels.skipped === 1 && !r.merging?.approved && r.seenChecks[0] === "build" && r.buildFeatures.some((f) => f.feature === "implement" && f.on)));
    };
  }), 2, 20);
});

test("a person's permissions on many repos are one read", async () => {
  await expectFlat(unit(async (w, n) => {
    const names = await seedRepos(w, n);
    const session = { rowid: 1, idHash: "h", login: "mia", role: "maintainer" as const, csrf: "c", tokenEnc: null };
    return async () => {
      const user = makeUser(w.db, new TokenBox("k".repeat(32)), new FakeProvider(null), session, false);
      assert.deepEqual(await Promise.all(names.map((r) => user.canWrite(r))), names.map(() => true));
    };
  }), 2, 20);
});

test("the Work queue and Next read their rows in sets", async () => {
  const seed = async (w: World, n: number): Promise<void> => {
    await seedPrs(w, n);
    await runRank(w.db);
    await refreshPlanCache(w.db);
  };
  await expectFlat(unit(async (w, n) => {
    await seed(w, n);
    return async () => {
      for (const tab of ["all", "merge"]) assert.ok((await queuePage(w.db, req({ tab }))).total >= n);
      assert.ok([...(await queueSlots(w.db, ["app"])).values()].length >= n);
    };
  }), 2, 12);
  await expectFlat(unit(async (w, n) => {
    await seed(w, n);
    await w.db.prepare("INSERT INTO lane_next (lane, total, items, at) VALUES ('review', ?, ?, ?)").run(n, JSON.stringify(numbers(n).map((number) => ({ repo: "app", number, action: "review" }))), iso(1));
    return async () => assert.equal((await nextPage(w.db, ["app"])).steps.find((s) => s.lane === "review")?.items.length, n);
  }), 2, 12);
});

test("the activity feed, Home and the Items page read their rows in sets", async () => {
  const pages = (read: (w: World) => Promise<unknown>) => unit(async (w, n) => {
    await seedPrs(w, n);
    for (const i of numbers(n)) {
      await seedJob(w, "done", [i]);
      await w.issue(100 + i);
      await insertWorkflow(w.db, {
        kind: "issue", entry: "implement", startedBy: "op", startedAt: iso(50), startedVia: "github", repo: "app", number: 100 + i, state: "recommending",
        rec: { text: "Fix 1, then merge?", parts: { fix: [1], drop: [] }, merges: true },
      });
    }
    return () => read(w);
  });
  await expectFlat(pages((w) => activity(w.db, req())), 2, 12);
  await expectFlat(pages((w) => home(w.db, req())), 2, 12);
  await expectFlat(pages((w) => items(w.db, req())), 2, 12);
});
