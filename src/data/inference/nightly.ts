// Nightly checks and benchmarks (`nightly_*`).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import type { BenchPoint, NightlyCheckState, NightlyGridRow, NightlyResult, NightlyRun, NightlySelection, ResultState } from "./types.ts";

/** Benchmark points are kept this long. */
export const BENCH_KEEP_MS = 180 * 24 * 3600_000;

const paramsOf = (s: string | null): { crates: string[]; targets: string[] } => {
  try {
    const o = JSON.parse(s ?? "{}") as { crates?: unknown; targets?: unknown };
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return { crates: list(o.crates), targets: list(o.targets) };
  } catch { return { crates: [], targets: [] }; }
};
const selectionOf = (r: { repo: string; check_id: string; enabled: number; params: string | null }): NightlySelection => ({ repo: r.repo, checkId: r.check_id, enabled: Number(r.enabled) === 1, ...paramsOf(r.params) });
const resultOf = (r: { run_id: number; check_id: string; task_id: number | null; state: string; summary: string | null; issue_number: number | null; finished_at: string | null }): NightlyResult =>
  ({ runId: Number(r.run_id), checkId: r.check_id, taskId: r.task_id === null ? null : Number(r.task_id), state: r.state as ResultState, summary: r.summary, issueNumber: Number(r.issue_number) || null, issueClaimed: r.issue_number !== null && Number(r.issue_number) === CLAIMED, finishedAt: r.finished_at });
const runOf = (r: { id: number; repo: string; sha: string; started_at: string; state: string }): NightlyRun => ({ id: Number(r.id), repo: r.repo, sha: r.sha, startedAt: r.started_at, state: r.state as NightlyRun["state"] });
/** `issue_number` of a streak whose issue is being opened. */
const CLAIMED = 0;
const RESULT_COLS = ["run_id", "check_id", "task_id", "state", "summary", "issue_number", "finished_at"] as const;
const group = <K, V>(rows: V[], key: (v: V) => K): Map<K, V[]> => {
  const out = new Map<K, V[]>();
  for (const r of rows) (out.get(key(r)) ?? out.set(key(r), []).get(key(r))!).push(r);
  return out;
};
const benchOf = (r: { repo: string; bench: string; sha: string; at: string; value: number; unit: string }): BenchPoint => ({ repo: r.repo, bench: r.bench, sha: r.sha, at: r.at, value: Number(r.value), unit: r.unit });

/** Check selections per repo, ordered by check id (the caller orders by its catalogue and drops checks it no longer knows). 1 statement. */
export async function loadSelections(db: Db, repos: string[]): Promise<Map<string, NightlySelection[]>> {
  const out = new Map<string, NightlySelection[]>();
  if (repos.length === 0) return out;
  const q = queryDb(db);
  for (const part of kx.chunks(repos)) {
    const rows = await q.all(q.k.selectFrom("main.nightly_selection").select(["repo", "check_id", "enabled", "params"]).where(kx.inList(db, "repo", part)).orderBy("repo").orderBy("check_id"));
    for (const [repo, g] of group(rows, (r) => r.repo)) out.set(repo, g.map(selectionOf));
  }
  return out;
}

/** Upserts a selection, keeping old crates and targets when not given (read and write share one `db.write`). */
export async function setSelection(db: Db, row: { repo: string; checkId: string; enabled: boolean; crates?: string[]; targets?: string[] }): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    const old = row.crates === undefined || row.targets === undefined
      ? await q.get(q.k.selectFrom("main.nightly_selection").select("params").where("repo", "=", row.repo).where("check_id", "=", row.checkId))
      : undefined;
    const prev = paramsOf(old?.params ?? null);
    const params = JSON.stringify({ crates: row.crates ?? prev.crates, targets: row.targets ?? prev.targets });
    await q.run(q.k.insertInto("main.nightly_selection").values({ repo: row.repo, check_id: row.checkId, enabled: row.enabled ? 1 : 0, params })
      .onConflict((oc) => oc.columns(["repo", "check_id"]).doUpdateSet(kx.excluded(["enabled", "params"]))));
  });
}

/**
 * What `nightlyDue` asks per repo, for every repo given: how many checks are enabled (rows of any check id, the caller's catalogue not applied),
 * whether a run started since `since` or one still running started since `staleSince`, and the queued results. 3 statements in one wave. The
 * caller loads the tasks' states of `queued` with `build.loadTaskStates` in a second wave.
 */
export async function loadNightlyState(db: Db, repos: string[], o: { since: string; staleSince: string }): Promise<Map<string, NightlyCheckState>> {
  const out = new Map<string, NightlyCheckState>(repos.map((r) => [r, { enabledChecks: 0, recentRun: false, queued: [] }]));
  if (repos.length === 0) return out;
  const q = queryDb(db);
  const { k } = q;
  const [enabled, recent, queued] = await db.together(() => Promise.all([
    q.all(k.selectFrom("main.nightly_selection").select(["repo", (eb) => eb.fn.countAll<number>().as("n")]).where(kx.inList(db, "repo", repos)).where("enabled", "=", 1).groupBy("repo")),
    q.all(k.selectFrom("main.nightly_runs").select("repo").distinct().where(kx.inList(db, "repo", repos))
      .where((eb) => eb.or([eb("started_at", ">", o.since), eb.and([eb("state", "=", "running"), eb("started_at", ">", o.staleSince)])]))),
    q.all(k.selectFrom("main.nightly_results as r").innerJoin("main.nightly_runs as u", "u.id", "r.run_id").select(["u.repo", "r.run_id", "r.check_id", "r.task_id"])
      .where(kx.inList(db, "u.repo", repos)).where("r.state", "=", "queued").orderBy("r.run_id").orderBy("r.check_id")),
  ]));
  for (const r of enabled) out.get(r.repo)!.enabledChecks = Number(r.n);
  for (const r of recent) out.get(r.repo)!.recentRun = true;
  for (const r of queued) out.get(r.repo)!.queued.push({ runId: Number(r.run_id), checkId: r.check_id, taskId: r.task_id === null ? null : Number(r.task_id) });
  return out;
}

/** Starts a run; returns its id. */
export async function startRun(db: Db, o: { repo: string; sha: string; at: string }): Promise<number> {
  const q = queryDb(db);
  return Number((await q.get(q.k.insertInto("main.nightly_runs").values({ repo: o.repo, sha: o.sha, started_at: o.at, state: "running" }).returning("id")))!.id);
}

/** Inserts results; 1 statement per 500 rows. */
export async function addResults(db: Db, rows: { runId: number; checkId: string; taskId: number | null; state: ResultState; summary: string | null; finishedAt: string | null }[]): Promise<void> {
  if (rows.length === 0) return;
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.batches(rows)) {
      await q.run(q.k.insertInto("main.nightly_results").values(part.map((r) => ({ run_id: r.runId, check_id: r.checkId, task_id: r.taskId, state: r.state, summary: r.summary, finished_at: r.finishedAt }))));
    }
  });
}

/** Open runs per repo, oldest first. 1 statement. */
export async function loadOpenRuns(db: Db, repos: string[]): Promise<Map<string, NightlyRun[]>> {
  const out = new Map<string, NightlyRun[]>();
  if (repos.length === 0) return out;
  const q = queryDb(db);
  for (const part of kx.chunks(repos)) {
    const rows = await q.all(q.k.selectFrom("main.nightly_runs").select(["id", "repo", "sha", "started_at", "state"]).where(kx.inList(db, "repo", part)).where("state", "=", "running").orderBy("id"));
    for (const [repo, g] of group(rows, (r) => r.repo)) out.set(repo, g.map(runOf));
  }
  return out;
}

/** Results per run ordered by check id, optionally of one state. 1 statement. */
export async function loadResults(db: Db, runIds: number[], state?: ResultState): Promise<Map<number, NightlyResult[]>> {
  const out = new Map<number, NightlyResult[]>();
  if (runIds.length === 0) return out;
  const q = queryDb(db);
  for (const part of kx.chunks(runIds)) {
    const rows = await q.all(q.k.selectFrom("main.nightly_results").select(RESULT_COLS).where(kx.inList(db, "run_id", part, "bigint"))
      .$if(state !== undefined, (b) => b.where("state", "=", state!)).orderBy("run_id").orderBy("check_id"));
    for (const [id, g] of group(rows, (r) => Number(r.run_id))) out.set(id, g.map(resultOf));
  }
  return out;
}

/**
 * Updates results with `UPDATE ... FROM`, one statement per column shape (which of `finishedAt` and `issueNumber` a row sets) per 10,000 rows.
 * A column the row leaves out (undefined) keeps its value; null clears it.
 */
export async function setResults(db: Db, rows: { runId: number; checkId: string; state: ResultState; summary: string | null; finishedAt?: string | null; issueNumber?: number | null }[]): Promise<void> {
  if (rows.length === 0) return;
  const q = queryDb(db);
  const shapes = group(rows, (r) => `${r.finishedAt !== undefined ? "f" : ""}${r.issueNumber !== undefined ? "i" : ""}`);
  await db.write(async () => {
    for (const [shape, g] of shapes) {
      const set = ["state", "summary", ...(shape.includes("f") ? ["finished_at"] : []), ...(shape.includes("i") ? ["issue_number"] : [])];
      for (const chunk of kx.chunks(g)) {
        const v = kx.valuesTable(db, chunk.map((r) => ({ run_id: r.runId, check_id: r.checkId, state: r.state, summary: r.summary, finished_at: r.finishedAt ?? null, issue_number: r.issueNumber ?? null })),
          { run_id: "bigint", check_id: "text", state: "text", summary: "text", finished_at: "text", issue_number: "bigint" }, "v");
        await q.run((q.k as any).updateTable("nightly_results").from(v)
          .set((eb: kx.Eb) => Object.fromEntries(set.map((c) => [c, eb.ref(`v.${c}`)])))
          .where((eb: kx.Eb) => eb.and([eb("nightly_results.run_id", "=", eb.ref("v.run_id")), eb("nightly_results.check_id", "=", eb.ref("v.check_id"))])));
      }
    }
  });
}

/** Marks running runs `done` when none of their results is `queued`; returns the runs closed. 1 statement. */
export async function closeRuns(db: Db, runIds: number[]): Promise<number> {
  if (runIds.length === 0) return 0;
  const q = queryDb(db);
  let n = 0;
  for (const part of kx.chunks(runIds)) {
    n += Number((await q.run(q.k.updateTable("main.nightly_runs").set({ state: "done" }).where(kx.inList(db, "id", part, "bigint")).where("state", "=", "running")
      .where((eb) => eb.not(eb.exists(eb.selectFrom("main.nightly_results as r").select(eb.lit(1).as("one")).whereRef("r.run_id", "=", "main.nightly_runs.id").where("r.state", "=", "queued")))))).changes);
  }
  return n;
}

/** Earlier results per check from runs before `beforeRun`, newest first (the failing streak). 1 statement. */
export async function loadHistory(db: Db, repo: string, checkIds: string[], beforeRun: number): Promise<Map<string, NightlyResult[]>> {
  const out = new Map<string, NightlyResult[]>();
  if (checkIds.length === 0) return out;
  const q = queryDb(db);
  for (const part of kx.chunks(checkIds)) {
    const rows = await q.all(q.k.selectFrom("main.nightly_results as r").innerJoin("main.nightly_runs as u", "u.id", "r.run_id")
      .select(["r.run_id", "r.check_id", "r.task_id", "r.state", "r.summary", "r.issue_number", "r.finished_at"])
      .where("u.repo", "=", repo).where(kx.inList(db, "r.check_id", part)).where("r.run_id", "<", beforeRun).orderBy("r.run_id", "desc"));
    for (const [id, g] of group(rows, (r) => r.check_id)) out.set(id, g.map(resultOf));
  }
  return out;
}

/** Sets `issue_number` on the failing streak's results of one check. 1 statement. */
export async function markIssue(db: Db, o: { repo: string; checkId: string; runIds: number[]; issue: number }): Promise<void> {
  if (o.runIds.length === 0) return;
  const q = queryDb(db);
  for (const part of kx.chunks(o.runIds)) {
    await q.run(q.k.updateTable("main.nightly_results").set({ issue_number: o.issue }).where("check_id", "=", o.checkId).where(kx.inList(db, "run_id", part, "bigint"))
      .where("run_id", "in", q.k.selectFrom("main.nightly_runs").select("id").where("repo", "=", o.repo)));
  }
}

/** Claims the streak's results of one check that name no issue, before its issue is opened. 1 statement. */
export async function claimIssue(db: Db, o: { repo: string; checkId: string; runIds: number[] }): Promise<void> {
  const q = queryDb(db);
  for (const part of kx.chunks(o.runIds)) {
    await q.run(q.k.updateTable("main.nightly_results").set({ issue_number: CLAIMED }).where("check_id", "=", o.checkId).where(kx.inList(db, "run_id", part, "bigint")).where("issue_number", "is", null)
      .where("run_id", "in", q.k.selectFrom("main.nightly_runs").select("id").where("repo", "=", o.repo)));
  }
}

/** Gives a claim back: no issue was opened. 1 statement. */
export async function releaseIssue(db: Db, o: { repo: string; checkId: string }): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.updateTable("main.nightly_results").set({ issue_number: null }).where("check_id", "=", o.checkId).where("issue_number", "=", CLAIMED)
    .where("run_id", "in", q.k.selectFrom("main.nightly_runs").select("id").where("repo", "=", o.repo)));
}

/**
 * The Nightly page read model for the repos given: each repo's selections, its last `nights` runs (newest first) with their results, and per bench
 * its newest `max(sparkPoints, window + 1)` points oldest first. A repo is in the result when it has a selection or a run. 4 statements in one wave.
 */
export async function loadNightlyGrid(db: Db, repos: string[], o: { nights: number; sparkPoints: number; window: number }): Promise<Map<string, NightlyGridRow>> {
  const out = new Map<string, NightlyGridRow>();
  if (repos.length === 0) return out;
  const q = queryDb(db);
  const { k } = q;
  const points = Math.max(o.sparkPoints, o.window + 1);
  const [sels, runs, results, bench] = await db.together(() => Promise.all([
    q.all(k.selectFrom("main.nightly_selection").select(["repo", "check_id", "enabled", "params"]).where(kx.inList(db, "repo", repos)).orderBy("repo").orderBy("check_id")),
    q.all(k.selectFrom(k.selectFrom("main.nightly_runs").select(["id", "repo", "sha", "started_at", "state",
      (eb) => eb.fn.agg<number>("row_number").over((w) => w.partitionBy("repo").orderBy("id", "desc")).as("rn")]).where(kx.inList(db, "repo", repos)).as("t"))
      .select(["t.id", "t.repo", "t.sha", "t.started_at", "t.state"]).where("t.rn", "<=", o.nights).orderBy("t.repo").orderBy("t.id", "desc")),
    q.all(k.selectFrom("main.nightly_results as r").select(["r.run_id", "r.check_id", "r.task_id", "r.state", "r.summary", "r.issue_number", "r.finished_at"])
      .where("r.run_id", "in", k.selectFrom(k.selectFrom("main.nightly_runs").select(["id", (eb) => eb.fn.agg<number>("row_number").over((w) => w.partitionBy("repo").orderBy("id", "desc")).as("rn")])
        .where(kx.inList(db, "repo", repos)).as("t")).select("t.id").where("t.rn", "<=", o.nights)).orderBy("r.run_id").orderBy("r.check_id")),
    q.all(k.selectFrom(k.selectFrom("main.nightly_bench").select(["repo", "bench", "sha", "at", "value", "unit",
      (eb) => eb.fn.agg<number>("row_number").over((w) => w.partitionBy(["repo", "bench"]).orderBy("at", "desc").orderBy("sha", "desc")).as("rn")]).where(kx.inList(db, "repo", repos)).as("t"))
      .select(["t.repo", "t.bench", "t.sha", "t.at", "t.value", "t.unit"]).where("t.rn", "<=", points).orderBy("t.repo").orderBy("t.bench").orderBy("t.at").orderBy("t.sha")),
  ]));
  const row = (repo: string): NightlyGridRow => out.get(repo) ?? out.set(repo, { selection: [], runs: [], benches: new Map() }).get(repo)!;
  const byRun = group(results, (r) => Number(r.run_id));
  for (const r of sels) row(r.repo).selection.push(selectionOf(r));
  for (const r of runs) row(r.repo).runs.push({ ...runOf(r), results: (byRun.get(Number(r.id)) ?? []).map(resultOf) });
  for (const r of bench) {
    const b = row(r.repo).benches;
    (b.get(r.bench) ?? b.set(r.bench, []).get(r.bench)!).push(benchOf(r));
  }
  return out;
}

/** One bench's series, oldest first. 1 statement. */
export async function loadBenchSeries(db: Db, repo: string, bench: string): Promise<BenchPoint[]> {
  const q = queryDb(db);
  return (await q.all(q.k.selectFrom("main.nightly_bench").select(["repo", "bench", "sha", "at", "value", "unit"]).where("repo", "=", repo).where("bench", "=", bench).orderBy("at").orderBy("sha"))).map(benchOf);
}

/** The last `window` earlier values per bench (other commits, earlier `at`), newest first. 1 statement. */
export async function loadBenchPrior(db: Db, repo: string, benches: string[], before: { sha: string; at: string }, window: number): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (benches.length === 0) return out;
  const q = queryDb(db);
  const { k } = q;
  for (const part of kx.chunks(benches)) {
    const rows = await q.all(k.selectFrom(k.selectFrom("main.nightly_bench").select(["bench", "value", "at",
      (eb) => eb.fn.agg<number>("row_number").over((w) => w.partitionBy("bench").orderBy("at", "desc")).as("rn")])
      .where("repo", "=", repo).where(kx.inList(db, "bench", part)).where("sha", "<>", before.sha).where("at", "<", before.at).as("t"))
      .select(["t.bench", "t.value"]).where("t.rn", "<=", window).orderBy("t.bench").orderBy("t.at", "desc"));
    for (const [b, g] of group(rows, (r) => r.bench)) out.set(b, g.map((r) => Number(r.value)));
  }
  return out;
}

/** Upserts bench points; the last of a (repo, bench, sha) wins. 1 statement per 500 rows. */
export async function saveBenchPoints(db: Db, rows: BenchPoint[]): Promise<void> {
  if (rows.length === 0) return;
  const q = queryDb(db);
  const last = new Map(rows.map((r) => [`${r.repo}\0${r.bench}\0${r.sha}`, r]));
  await db.write(async () => {
    for (const part of kx.batches([...last.values()])) {
      await q.run(q.k.insertInto("main.nightly_bench").values(part.map((r) => ({ repo: r.repo, bench: r.bench, sha: r.sha, at: r.at, value: r.value, unit: r.unit })))
        .onConflict((oc) => oc.columns(["repo", "bench", "sha"]).doUpdateSet(kx.excluded(["at", "value", "unit"]))));
    }
  });
}

/** Deletes bench points older than the keep window. 1 statement. */
export async function pruneBench(db: Db, nowMs: number): Promise<number> {
  const q = queryDb(db);
  return Number((await q.run(q.k.deleteFrom("main.nightly_bench").where("at", "<", new Date(nowMs - BENCH_KEEP_MS).toISOString()))).changes);
}
