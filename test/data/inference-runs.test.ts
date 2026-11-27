// Inference run records and reads: writers whose logic changed shape (batched end with its guard, first item, texts, hidden test) and
// query-count tests of the set loaders.
import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import {
  failRunning, finishRuns, listRunEvents, listRuns, loadCallDurations, loadCostSamples, loadItemRuns, loadJobRuns, loadPromptSpend, loadRun, loadRunBuckets, loadRunStamp,
  loadRunsAfter, loadRunsById, loadRunningCounts, loadStepSpend, loadWorkerRuns, openRun, recordTexts, removeRunTexts, runWatermark, saveTools, setReportedModel, setRunProgress,
  type RunVisibility,
} from "../../src/data/inference/index.ts";
import { loadActivityRound } from "../../src/data/views/activity.ts";
import { queryDb } from "../../src/db/query-db.ts";
import type { Db } from "../../src/db/index.ts";
import { expectFlat } from "../helpers/query-count.ts";
import { both, dialects, openApp, openBoth, scrub } from "./inference-helpers.ts";

const everyone: RunVisibility = { hidden: [], staff: true };
const text = (v: unknown): string => (v instanceof Uint8Array ? gunzipSync(v).toString("utf8") : String(v));
const start = (db: Db, items: { repo: string; number: number }[], o: { step?: string; jobId?: number | null; promptId?: string } = {}) =>
  openRun(db, { ...openBoth, step: o.step ?? "review", jobId: o.jobId ?? null, promptId: o.promptId ?? "p.one", items, prompt: "hello SECRET" }, scrub);

both("openRun stores the scrubbed prompt, the items and the first item by repo and number", async ({ db }) => {
  const id = await start(db, [{ repo: "o/b", number: 2 }, { repo: "o/a", number: 9 }, { repo: "o/a", number: 3 }]);
  const run = (await loadRunsById(db, [id])).get(id)!;
  assert.equal(run.state, "running");
  assert.equal(run.itemCount, 3);
  assert.deepEqual([run.firstRepo, run.firstNumber], ["o/a", 3]);
  const detail = (await loadRun(db, id, everyone))!;
  assert.match(text(detail.prompt), /hello \[removed\]/);
  assert.equal(await loadRun(db, id + 100, everyone), null);
});

both("finishRuns ends only running runs, keeps a finished run's row and writes output only for runs it ended", async ({ db }) => {
  const [a, b, c] = [await start(db, [{ repo: "o/a", number: 1 }]), await start(db, [{ repo: "o/a", number: 2 }]), await start(db, [{ repo: "o/a", number: 3 }])];
  assert.equal(await finishRuns(db, [{ id: a, state: "done", summary: "first", output: "out SECRET", costUsd: 0.5, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }], scrub), 1);
  const ended = await finishRuns(db, [{ id: a, state: "failed", summary: "again", output: "late" }, { id: b, state: "failed", error: "x".repeat(900) }, { id: c, state: "done", output: "c-out" }], scrub);
  assert.equal(ended, 2, "the finished run is not ended again");
  const runs = await loadRunsById(db, [a, b, c]);
  assert.equal(runs.get(a)!.state, "done");
  assert.equal(runs.get(a)!.summary, "first");
  assert.equal(runs.get(a)!.costUsd, 0.5);
  assert.ok(runs.get(b)!.error!.length < 900);
  assert.equal(runs.get(b)!.endedAt !== null, true);
  assert.equal(text((await loadRun(db, a, everyone))!.output), "out [removed]");
  assert.equal(text((await loadRun(db, c, everyone))!.output), "c-out");
});

both("a string text with no scrub function is refused, so nothing is stored unscrubbed", async ({ db }) => {
  await assert.rejects(openRun(db, { ...openBoth, step: "review", items: [], prompt: "plain" }), /scrub/);
});

both("progress and reported model update many runs, progress only while running", async ({ db }) => {
  const [a, b] = [await start(db, []), await start(db, [])];
  await finishRuns(db, [{ id: b, state: "done" }]);
  assert.equal(await setRunProgress(db, [{ id: a, line: "half" }, { id: b, line: "late" }]), 1);
  assert.equal(await setReportedModel(db, [{ id: a, model: "m1" }, { id: b, model: "m2" }]), 2);
  const runs = await loadRunsById(db, [a, b]);
  assert.equal(runs.get(a)!.progress, "half");
  assert.equal(runs.get(b)!.progress, null);
  assert.equal(runs.get(b)!.reportedModel, "m2");
});

both("failRunning fails running runs of a job or of all jobs", async ({ db }) => {
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.jobs").values([{ step: "review", state: "running", requested_at: "2026-01-01T00:00:00.000Z", params: "{}", requested_by: "t" }, { step: "review", state: "running", requested_at: "2026-01-01T00:00:00.000Z", params: "{}", requested_by: "t" }] as never));
  const jobs = (await q.all(q.k.selectFrom("main.jobs").select("id").orderBy("id"))).map((j) => Number(j.id));
  const [a, b] = [await start(db, [], { jobId: jobs[0] }), await start(db, [], { jobId: jobs[1] })];
  assert.equal(await failRunning(db, "gone", { jobId: jobs[0]! }), 1);
  assert.equal((await loadRunsById(db, [a])).get(a)!.state, "failed");
  assert.equal((await loadRunsById(db, [b])).get(b)!.state, "running");
  assert.equal(await failRunning(db, "all gone"), 1);
});

both("recordTexts upserts by column shape and removeRunTexts drops finished runs of the steps", async ({ db }) => {
  const [a, b] = [await start(db, [], { step: "discord-issue" }), await start(db, [], { step: "discord-issue" })];
  await finishRuns(db, [{ id: a, state: "done" }]);
  await recordTexts(db, [{ runId: a, output: "o" }, { runId: b, prompt: "p", output: "o2" }], scrub);
  assert.equal(text((await loadRun(db, b, everyone))!.prompt), "p");
  assert.equal(await removeRunTexts(db, { steps: ["discord-issue"], finishedOnly: true }), 1);
  assert.equal((await loadRun(db, a, everyone))!.output, null);
  assert.notEqual((await loadRun(db, b, everyone))!.output, null);
  assert.equal(await removeRunTexts(db, { steps: ["discord-issue"], finishedOnly: false }), 1);
});

both("loadRun hides texts and tool arguments from a viewer who is not staff, and a hidden run is not found", async ({ db }) => {
  const id = await start(db, [{ repo: "o/secret", number: 1 }]);
  await saveTools(db, [{ runId: id, seq: 1, tool: "Read", args: "/x", resultBytes: 3, isError: false, startedAt: null, endedAt: null, checkId: null }]);
  const viewer: RunVisibility = { hidden: [], staff: false };
  const seen = (await loadRun(db, id, viewer))!;
  assert.equal(seen.prompt, null);
  assert.equal(seen.tools[0]!.args, null);
  assert.equal((await loadRun(db, id, everyone))!.tools[0]!.args, "/x");
  assert.equal(await loadRun(db, id, { hidden: ["o/secret"], staff: true }), null);
  const allow: RunVisibility = { hidden: Object.assign([] as string[], { visible: ["o/other"] }), staff: true };
  assert.equal(await loadRun(db, id, allow), null, "an allowlist hides the repos it does not name");
});

both("listRuns pages newest first by keyset; a repo filter lists one row per run at its lowest item in that repo", async ({ db }) => {
  const ids = [await start(db, [{ repo: "o/a", number: 5 }]), await start(db, [{ repo: "o/b", number: 1 }, { repo: "o/a", number: 2 }, { repo: "o/a", number: 7 }]), await start(db, [{ repo: "o/b", number: 4 }])];
  const p1 = await listRuns(db, { limit: 2 }, everyone);
  assert.deepEqual(p1.rows.map((r) => r.id), [ids[2], ids[1]]);
  assert.ok(p1.nextCursor);
  assert.deepEqual((await listRuns(db, { limit: 2, cursor: p1.nextCursor! }, everyone)).rows.map((r) => r.id), [ids[0]]);
  const byRepo = await listRuns(db, { repo: "o/a" }, everyone);
  assert.deepEqual(byRepo.rows.map((r) => r.id), [ids[1], ids[0]]);
  assert.equal(byRepo.nextCursor, null);
  assert.deepEqual((await listRuns(db, { repo: "o/b" }, { hidden: ["o/a"], staff: true })).rows.map((r) => r.id), [ids[2]]);
});

both("loadItemRuns lists runs per item in run order with tool counts; the activity page has one row per run at its first item", async ({ db }) => {
  const a = await start(db, [{ repo: "o/a", number: 1 }, { repo: "o/a", number: 2 }]);
  const b = await start(db, [{ repo: "o/a", number: 1 }]);
  await saveTools(db, [1, 2, 3].map((seq) => ({ runId: a, seq, tool: "Read", args: "", resultBytes: null, isError: false, startedAt: null, endedAt: null, checkId: null })));
  const m = await loadItemRuns(db, ["o/a#1", "o/a#2"], everyone);
  assert.deepEqual(m.get("o/a#1")!.map((r) => [r.id, r.toolCount]), [[a, 3], [b, 0]]);
  assert.deepEqual(m.get("o/a#2")!.map((r) => r.id), [a]);
  assert.deepEqual([...(await loadItemRuns(db, ["o/a#1"], everyone, { state: "running" })).keys()], ["o/a#1"]);
  const events = await listRunEvents(db, { limit: 10, vis: everyone });
  assert.deepEqual(events.map((r) => [r.id, r.firstNumber, r.toolCount]), [[b, 1, 0], [a, 1, 3]]);
  assert.deepEqual((await listRunEvents(db, { limit: 10, vis: everyone, repo: "o/none" })), []);
});

both("rows from an old pod without a first item still show their lowest item", async ({ db }) => {
  const id = await start(db, [{ repo: "o/z", number: 8 }, { repo: "o/y", number: 3 }]);
  const q = queryDb(db);
  await q.run(q.k.updateTable("main.agent_runs").set({ first_repo: null, first_number: null }).where("id", "=", id));
  const run = (await loadWorkerRuns(db, everyone, "2000-01-01T00:00:00.000Z", 10))[0]!;
  assert.deepEqual([run.firstRepo, run.firstNumber], ["o/y", 3]);
  assert.equal((await listRunEvents(db, { limit: 5, vis: everyone }))[0]!.firstRepo, "o/y");
});

both("loadRunsAfter, spend and bucket aggregates read the runs they describe", async ({ db }) => {
  const mark = await runWatermark(db);
  const a = await start(db, [{ repo: "o/a", number: 1 }], { promptId: "fixup.patch", step: "fixup" });
  const b = await start(db, [{ repo: "o/b", number: 1 }], { promptId: "discord.x", step: "discord-issue" });
  await finishRuns(db, [{ id: a, state: "done", costUsd: 1.5, summary: "s" }, { id: b, state: "failed", costUsd: 0.25 }]);
  assert.deepEqual((await loadRunsAfter(db, mark, { promptIds: ["fixup.patch"] })).map((r) => [r.id, r.costUsd]), [[a, 1.5]]);
  assert.deepEqual((await loadRunsAfter(db, mark, { item: { repo: "o/b", number: 1 } })).map((r) => r.id), [b]);
  assert.equal((await loadStepSpend(db, ["fixup", "discord-issue", "none"], "2000-01-01")).get("fixup"), 1.5);
  const spend = await loadPromptSpend(db, "discord.", "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z");
  assert.deepEqual(spend.map((s) => [s.prompt, s.dayCalls, s.weekUsd]), [["discord.x", 1, 0.25]]);
  const buckets = await loadRunBuckets(db, { from: "2000-01-01", to: "2999-01-01", prefixLen: 4, vis: everyone });
  assert.deepEqual(buckets.map((x) => [x.step, x.runs, x.failed]).sort(), [["discord-issue", 1, 1], ["fixup", 1, 0]]);
  assert.equal((await loadRunStamp(db)).running, 0);
});

test("run reads and writers: statements do not grow with the number of runs, items or jobs", async () => {
  for (const dialect of dialects()) {
    const seed = async (n: number) => {
      const o = await openApp(dialect);
      const ids: number[] = [];
      for (let i = 0; i < n; i++) ids.push(await start(o.db, [{ repo: `o/r${i % 3}`, number: i + 1 }], { step: `s${i % 4}` }));
      return { o, ids };
    };
    await expectFlat(async (n) => {
      const { o, ids } = await seed(n);
      const refs = ids.map((_, i) => `o/r${i % 3}#${i + 1}`);
      return {
        db: o.db, close: () => o.t.close(),
        run: async () => {
          await loadItemRuns(o.db, refs, everyone);
          await loadItemRuns(o.db, refs, { hidden: ["o/none"], staff: false });
          await loadRunsById(o.db, ids);
          await loadJobRuns(o.db, ids, everyone);
          await loadCostSamples(o.db, ["p.one", "p.two", "p.three"], 5);
          await loadCallDurations(o.db, ids.map((_, i) => ({ step: `s${i % 4}`, model: "opus" })), 5);
          await setRunProgress(o.db, ids.map((id) => ({ id, line: "x" })));
          await setReportedModel(o.db, ids.map((id) => ({ id, model: "m" })));
          await finishRuns(o.db, ids.map((id) => ({ id, state: "done" as const, output: new Uint8Array([1]), costUsd: 0.1 })));
          await loadWorkerRuns(o.db, everyone, "2000-01-01", 50);
          await listRunEvents(o.db, { limit: 50, vis: { hidden: ["o/none"], staff: true } });
          await listRuns(o.db, { limit: 50 }, everyone);
          await loadRunningCounts(o.db, Date.now());
        },
      };
    }, 2, 12);
  }
});

both("the activity feed's model calls: one row per run at its first item, newest first, of one repo, without hidden repos' runs, and before a cursor", async ({ db }) => {
  const q = queryDb(db);
  const at = (i: number) => `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`;
  const runs: number[] = [];
  for (let i = 0; i < 9; i++) {
    const id = await start(db, i === 4 ? [] : [{ repo: i % 2 ? "o/a" : "o/b", number: i + 1 }, ...(i === 5 ? [{ repo: "o/hidden", number: 1 }] : [])]);
    await q.run(q.k.updateTable("main.agent_runs").set({ started_at: at(i), ...(i === 3 ? { first_repo: null, first_number: null } : {}) }).where("id", "=", id));
    runs.push(id);
  }
  await saveTools(db, [{ runId: runs[7]!, seq: 1, tool: "Read", args: "{}", resultBytes: 1, isError: false, startedAt: null, endedAt: null, checkId: null }]);
  const feed = async (o: { repo?: string; limit?: number; before?: number; hidden?: string[]; repos?: string[] }) => {
    const r = await loadActivityRound(db, { staff: true, operator: true, hidden: o.hidden ?? [], own: new Set(), repos: o.repos ?? ["o/a", "o/b"] },
      { kinds: new Set(["model-call"]), only: false, repo: o.repo ?? null, limit: o.limit ?? 50, before: o.before === undefined ? null : { at: at(o.before), id: "x" }, writeActions: null });
    return r.bySource[0]!.rows;
  };
  const order = async (o: Parameters<typeof feed>[0]) => (await feed(o)).map((r) => runs.indexOf(Number(r.id)));
  assert.deepEqual(await order({}), [8, 7, 6, 5, 3, 2, 1, 0], "a run with no items is left out");
  assert.deepEqual(await order({ limit: 3 }), [8, 7, 6]);
  assert.deepEqual(await order({ repo: "o/a" }), [7, 5, 3, 1], "a run without a stored first item counts");
  assert.deepEqual(await order({ repo: "o/a", limit: 2, before: 5 }), [5, 3]);
  assert.deepEqual(await order({ repo: "o/a", hidden: ["o/hidden"], limit: 2 }), [7, 3]);
  assert.deepEqual(await order({ repos: ["o/b"], limit: 2 }), [8, 6]);
  assert.deepEqual(await order({ repo: "o/a", repos: ["o/b"] }), []);
  const [row] = await feed({ repo: "o/a" });
  assert.deepEqual([row!.repo, Number(row!.number), Number(row!.tools)], ["o/a", 8, 1]);
});
