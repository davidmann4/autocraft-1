// Inference usage, Jev unsure answers and nightly checks: writers that changed shape and query-count tests of the set loaders.
import assert from "node:assert/strict";
import test from "node:test";
import {
  addResults, closeRuns, keepEarlierUsage, loadBenchPrior, loadBenchSeries, loadHistory, loadJobUsage, loadNightlyGrid, loadNightlyState, loadOpenRuns, loadResults, loadSelections,
  loadUnsure, loadUsageByModel, loadUsageReport, loadUsageSpend, markIssue, pruneBench, pruneUnsure, recordUsage, saveBenchPoints, saveUnsure, setResults, setSelection, startRun,
  type UsageRow,
} from "../../src/data/inference/index.ts";
import { expectFlat } from "../helpers/query-count.ts";
import { both, dialects, openApp } from "./inference-helpers.ts";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
const usage = (runId: string, agent: string, o: Partial<UsageRow> & { cost?: number } = {}): UsageRow => ({
  runId, agent, stage: "classify", model: "haiku", items: 2, u: { ...zero, input: 10, output: 5, cost: o.cost ?? 0.5, ...(o.u ?? {}) }, start: "2026-01-01T10:00:00.000Z", end: "2026-01-01T10:00:30.000Z", ...o,
});

both("recordUsage expands subagent rows, and keepEarlierUsage renames an earlier pass so a new upsert keeps its cost", async ({ db }) => {
  await recordUsage(db, [usage("r1", "haiku-00", { u: { ...zero, input: 1, output: 1, cost: 1, extra: [{ model: "sonnet", usage: { ...zero, cost: 2 } }] } })]);
  assert.equal((await loadJobUsage(db, ["r1"], "2000-01-01"))!.calls, 2);
  assert.equal(await keepEarlierUsage(db, "r1", ["haiku-00", "none"]), 1);
  await recordUsage(db, [usage("r1", "haiku-00", { cost: 3 })]);
  const job = (await loadJobUsage(db, ["r1"], "2000-01-01"))!;
  assert.equal(job.calls, 3, "the earlier pass keeps its own row");
  assert.equal(job.costUsd, 6);
  assert.equal(await loadJobUsage(db, [], "2000-01-01"), null);
});

both("loadUsageByModel sums per model with wall and call times from the rows; the report splits by hidden repos and buckets by span", async ({ db }) => {
  await recordUsage(db, [usage("r1", "a", { model: "haiku" }), usage("r1", "b", { model: "haiku", start: "2026-01-01T10:01:00.000Z", end: "2026-01-01T10:01:10.000Z" }), usage("r1", "c", { model: "jev", cost: 0 })]);
  const rows = await loadUsageByModel(db, "r1");
  const haiku = rows.find((r) => r.model === "haiku")!;
  assert.equal(haiku.calls, 2);
  assert.equal(haiku.wallSeconds, 70);
  assert.equal(haiku.busySeconds, 40);
  const report = await loadUsageReport(db, { run: "r1", vis: { hidden: [], staff: true } });
  assert.equal(report.total.calls, 3);
  assert.equal(report.bucketSize, "hour");
  assert.deepEqual(report.runs.map((r) => r.id), ["r1"]);
  assert.ok(report.stages.length >= 2);
  assert.ok(await loadUsageSpend(db, { fromDay: "2026-01-01", hidden: [] }) > 0);
  assert.equal(await loadUsageSpend(db, { fromDay: "2026-02-01", hidden: [] }), 0);
});

both("unsure answers: load, upsert and drop in one write, prune by age and by what the caller says is open", async ({ db }) => {
  const at = new Date().toISOString();
  await saveUnsure(db, { promptId: "p", keep: [{ ref: "o/a#1", hash: "h1", answer: "1", at }, { ref: "o/a#2", hash: "h2", answer: "2", at }, { ref: "o/a#3", hash: "h3", answer: "3", at: "2000-01-01T00:00:00.000Z" }], drop: [] });
  await saveUnsure(db, { promptId: "p", keep: [{ ref: "o/a#1", hash: "h1b", answer: "1b", at }], drop: ["o/a#2"] });
  assert.deepEqual([...(await loadUnsure(db, "p", ["o/a#1", "o/a#2", "o/a#3"])).entries()].map(([k, v]) => [k, v.hash]), [["o/a#1", "h1b"], ["o/a#3", "h3"]]);
  await saveUnsure(db, { promptId: "q", keep: [{ ref: "o/b#1", hash: "x", answer: "x", at }], drop: [] });
  const open = async (refs: string[]) => new Set(refs.filter((r) => r !== "o/b#1"));
  assert.equal(await pruneUnsure(db, Date.now(), open), 2, "the old row and the closed one");
  assert.deepEqual([...(await loadUnsure(db, "p", ["o/a#1", "o/a#3"])).keys()], ["o/a#1"]);
});

both("nightly: selection keeps old crates, results update by shape, runs close when nothing is queued, history is newest first", async ({ db }) => {
  await setSelection(db, { repo: "o/a", checkId: "audit", enabled: true, crates: ["c1"], targets: ["t1"] });
  await setSelection(db, { repo: "o/a", checkId: "audit", enabled: false, crates: ["c2"] });
  const sel = (await loadSelections(db, ["o/a", "o/none"])).get("o/a")!;
  assert.deepEqual([sel[0]!.enabled, sel[0]!.crates, sel[0]!.targets], [false, ["c2"], ["t1"]]);

  const r1 = await startRun(db, { repo: "o/a", sha: "s1", at: "2026-01-01T00:00:00.000Z" });
  await addResults(db, [{ runId: r1, checkId: "audit", taskId: null, state: "queued", summary: null, finishedAt: null }, { runId: r1, checkId: "fuzz", taskId: null, state: "queued", summary: null, finishedAt: null }]);
  assert.equal(await closeRuns(db, [r1]), 0, "results are still queued");
  await setResults(db, [{ runId: r1, checkId: "audit", state: "fail", summary: "bad", finishedAt: "2026-01-01T01:00:00.000Z" }, { runId: r1, checkId: "fuzz", state: "pass", summary: null, finishedAt: "2026-01-01T01:00:00.000Z", issueNumber: 7 }]);
  const rs = (await loadResults(db, [r1])).get(r1)!;
  assert.deepEqual(rs.map((r) => [r.checkId, r.state, r.issueNumber]), [["audit", "fail", null], ["fuzz", "pass", 7]]);
  assert.equal(await closeRuns(db, [r1]), 1);
  assert.equal((await loadOpenRuns(db, ["o/a"])).size, 0);

  const r2 = await startRun(db, { repo: "o/a", sha: "s2", at: "2026-01-02T00:00:00.000Z" });
  await addResults(db, [{ runId: r2, checkId: "audit", taskId: null, state: "fail", summary: null, finishedAt: "2026-01-02T01:00:00.000Z" }]);
  const hist = (await loadHistory(db, "o/a", ["audit"], r2)).get("audit")!;
  assert.deepEqual(hist.map((h) => h.runId), [r1]);
  await markIssue(db, { repo: "o/a", checkId: "audit", runIds: [r1, r2], issue: 99 });
  assert.equal((await loadResults(db, [r2], "fail")).get(r2)![0]!.issueNumber, 99);
  const state = (await loadNightlyState(db, ["o/a", "o/b"], { since: "2026-01-01T12:00:00.000Z", staleSince: "2026-01-01T00:00:00.000Z" }));
  assert.equal(state.get("o/a")!.enabledChecks, 0);
  assert.equal(state.get("o/a")!.recentRun, true);
  assert.equal(state.get("o/b")!.recentRun, false);
});

both("bench points upsert by commit, prior values exclude the commit, and prune drops old points", async ({ db }) => {
  const p = (sha: string, at: string, value: number) => ({ repo: "o/a", bench: "b1", sha, at, value, unit: "ns" });
  await saveBenchPoints(db, [p("s1", "2026-01-01T00:00:00.000Z", 1), p("s2", "2026-01-02T00:00:00.000Z", 2), p("s3", "2026-01-03T00:00:00.000Z", 3), p("s3", "2026-01-03T00:00:00.000Z", 4)]);
  assert.deepEqual((await loadBenchSeries(db, "o/a", "b1")).map((x) => x.value), [1, 2, 4]);
  assert.deepEqual((await loadBenchPrior(db, "o/a", ["b1"], { sha: "s3", at: "2026-01-03T00:00:00.000Z" }, 1)).get("b1"), [2]);
  const grid = (await loadNightlyGrid(db, ["o/a", "o/empty"], { nights: 14, sparkPoints: 2, window: 1 })).get("o/a")!;
  assert.deepEqual(grid.benches.get("b1")!.map((x) => x.value), [2, 4], "newest points, oldest first");
  assert.ok(!(await loadNightlyGrid(db, ["o/empty"], { nights: 14, sparkPoints: 2, window: 1 })).has("o/empty"));
  assert.equal(await pruneBench(db, Date.parse("2027-01-01T00:00:00.000Z")), 3);
});

test("usage, unsure and nightly loaders: statements do not grow with agents, refs or repos", async () => {
  for (const dialect of dialects()) {
    await expectFlat(async (n) => {
      const o = await openApp(dialect);
      const repos = Array.from({ length: n }, (_, i) => `o/r${i}`);
      const runs: number[] = [];
      for (const repo of repos) {
        await setSelection(o.db, { repo, checkId: "audit", enabled: true });
        const id = await startRun(o.db, { repo, sha: "s", at: "2026-01-01T00:00:00.000Z" });
        runs.push(id);
        await addResults(o.db, [{ runId: id, checkId: "audit", taskId: null, state: "queued", summary: null, finishedAt: null }]);
        await saveBenchPoints(o.db, [{ repo, bench: "b", sha: "s", at: "2026-01-01T00:00:00.000Z", value: 1, unit: "ns" }]);
      }
      await saveUnsure(o.db, { promptId: "p", keep: repos.map((r) => ({ ref: `${r}#1`, hash: "h", answer: "1", at: new Date().toISOString() })), drop: [] });
      return {
        db: o.db, close: () => o.t.close(),
        run: async () => {
          await recordUsage(o.db, repos.map((r) => usage("run", r)));
          await keepEarlierUsage(o.db, "run", repos);
          await loadJobUsage(o.db, ["run"], "2000-01-01");
          await loadUsageByModel(o.db, "run");
          await loadUsageReport(o.db, { run: "run", vis: { hidden: ["x/y"], staff: true } });
          await loadUnsure(o.db, "p", repos.map((r) => `${r}#1`));
          await pruneUnsure(o.db, Date.now(), async (refs) => new Set(refs));
          await loadSelections(o.db, repos);
          await loadNightlyState(o.db, repos, { since: "2026-01-01", staleSince: "2026-01-01" });
          await loadOpenRuns(o.db, repos);
          await loadResults(o.db, runs);
          await setResults(o.db, runs.map((runId) => ({ runId, checkId: "audit", state: "pass" as const, summary: null })));
          await closeRuns(o.db, runs);
          await loadNightlyGrid(o.db, repos, { nights: 14, sparkPoints: 30, window: 7 });
          await loadBenchPrior(o.db, "o/r0", ["b"], { sha: "z", at: "2027-01-01" }, 7);
          await saveBenchPoints(o.db, repos.map((repo) => ({ repo, bench: "b", sha: "t", at: "2026-01-02T00:00:00.000Z", value: 2, unit: "ns" })));
        },
      };
    }, 2, 12);
  }
});
