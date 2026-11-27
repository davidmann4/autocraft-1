// Nightly checks per repo (build feature "nightly"): once a day a repo's selected checks run as sandbox tasks at the
// default branch head, below all PR work. A later run of the step reads the finished tasks (pass or fail from the exit
// codes, never from a model), stores one result per check and parses benchmark lines. An operator opens an issue for a
// failing check from the Nightly page (openNightlyIssue), one per failing streak. Nothing is read, written or queued while the switch is off.
import { readFileSync } from "node:fs";
import type { BuildTask } from "../../web/src/api/types.ts";
import { absolute } from "../build/artifacts.ts";
import { listEnvs } from "../build/envs.ts";
import { featureOn } from "../build/features.ts";
import { createTask, getTask, TERMINAL } from "../build/tasks.ts";
import { BuildError } from "../build/envs.ts";
import type { By } from "../core/gates.ts";
import { guardRepo } from "../core/guard.ts";
import { byUs, issueMade, type GhRead } from "../github/made.ts";
import { createIssue, IssueError, PACE_MAX_WAIT_MS, unclearWrite } from "../github/write.ts";
import { ghExec } from "../merge/safe-merge.ts";
import { exec } from "../fixup/git.ts";
import { cleanLine } from "../review/post-template.ts";
import { scrub } from "../runner/scrub.ts";
import { outcomeOf } from "../verify/results.ts";
import { checkOf, NIGHTLY_CHECKS, type CheckOpts, type NightlyCheck } from "./checks.ts";
import { filterSeq } from "../async-seq.ts";
import { loadArtifactFiles, loadTaskStates } from "../data/build/index.ts";
import { addAudit, listAudit } from "../data/control/index.ts";
import * as inference from "../data/inference/index.ts";
import type { BenchPoint, NightlyResult, NightlyRun, NightlySelection, ResultState } from "../data/inference/index.ts";
import { loadLatestMainHeads } from "../data/mirror/index.ts";
import type { Db } from "../db/index.ts";

export { NIGHTLY_CHECKS, checkOf } from "./checks.ts";
export type { NightlyCheck, CheckOpts } from "./checks.ts";

export const ACTOR = "nightly";
/** Nightly tasks wait behind PR verification (0) and the warm build (-10). */
export const NIGHTLY_PRIORITY = -20;
/** The once-a-day schedule: a repo with a run started within this long ago is not queued again. */
const DAY_MS = 24 * 3600_000;
export const NIGHTLY_EVERY_MS = DAY_MS;
/** A run whose tasks never finished (no environment claims them) blocks the next night's run for this long, so tasks do not pile up. */
export const STALE_RUN_MS = 3 * DAY_MS;
export { BENCH_KEEP_MS } from "../data/inference/index.ts";
export type { BenchPoint, NightlyResult, NightlyRun, NightlySelection, ResultState } from "../data/inference/index.ts";
/** A bench is judged against its last 7 nights, once at least this many are known. */
export const BENCH_WINDOW = 7;
export const BENCH_MIN_HISTORY = 3;
export const BENCH_WARN_RATIO = 1.1;

export type NightlyDeps = {
  now: () => Date;
  /** Toolchain names some enabled, online build environment reports. */
  toolchains: (db: Db) => Promise<Set<string>>;
  /** The text of a finished task's artifact, or null. */
  readArtifact: (db: Db, taskId: number, name: string) => Promise<string | null>;
  /** Opens the issue `by` asked for; throws IssueError. The default checks the repo's comment approval first. */
  openIssue: (db: Db, o: { repo: string; checkId: string; title: string; body: string; by: string }) => Promise<{ number: number; url: string }>;
  /** Reads GitHub, to look for an issue whose create lost its answer. */
  read: GhRead;
};

export type NightlySummary = { repo: string; queued: number; skipped: number; collected: number; note: string | null };

// ---- selection ----------------------------------------------------------------

/** The repo's rows for checks the catalogue knows, in catalogue order. */
export async function selectionOf(db: Db, repo: string): Promise<NightlySelection[]> {
  return inCatalogue((await inference.loadSelections(db, [repo])).get(repo) ?? []);
}

const inCatalogue = (rows: NightlySelection[]): NightlySelection[] => NIGHTLY_CHECKS.flatMap((c) => rows.filter((x) => x.checkId === c.id));

/** Sets one check on or off for a repo, keeping its crates and targets unless new ones are given. */
export async function setSelection(db: Db, repo: string, checkId: string, enabled: boolean, o: { crates?: string[]; targets?: string[] } = {}): Promise<void> {
  if (!checkOf(checkId)) throw new Error(`unknown nightly check ${checkId}`);
  await inference.setSelection(db, { repo, checkId, enabled, ...o });
}

const enabledOf = (rows: NightlySelection[]): { check: NightlyCheck; opts: CheckOpts }[] =>
  inCatalogue(rows).filter((s) => s.enabled).map((s) => ({ check: checkOf(s.checkId)!, opts: { crates: s.crates, targets: s.targets } }));

// ---- schedule -----------------------------------------------------------------

/**
 * The repos among `repos` that have work for a run of the step: a result whose task ended, or (the once-a-day schedule, in data,
 * not a timer) a selected check, a known default branch head and no run started in the last 24 hours.
 */
async function dueAmong(db: Db, repos: string[], nowMs: number): Promise<string[]> {
  const on = await filterSeq(repos, async (r) => await featureOn(db, "nightly", r));
  if (!on.length) return [];
  const [state, selections, heads] = await db.together(() => Promise.all([
    inference.loadNightlyState(db, on, { since: new Date(nowMs - NIGHTLY_EVERY_MS).toISOString(), staleSince: new Date(nowMs - STALE_RUN_MS).toISOString() }),
    inference.loadSelections(db, on),
    loadLatestMainHeads(db, on),
  ]));
  const taskIds = [...new Set([...state.values()].flatMap((s) => s.queued.flatMap((q) => (q.taskId === null ? [] : [q.taskId]))))];
  const tasks = await loadTaskStates(db, taskIds);
  return on.filter((repo) => {
    const s = state.get(repo)!;
    if (s.queued.some((q) => q.taskId !== null && TERMINAL.includes(tasks.get(q.taskId)?.state as never))) return true;
    if (!enabledOf(selections.get(repo) ?? []).length || s.recentRun) return false;
    return heads.has(repo);
  });
}

/** Whether a run of the step has work for the repo. */
export async function nightlyDue(db: Db, repo: string, nowMs: number = Date.now()): Promise<boolean> {
  return (await dueAmong(db, [repo], nowMs)).length === 1;
}

/** The lane's candidates: tracked repos with the work above, sorted. */
export const nightlyRepos = async (db: Db, tracked: string[], nowMs: number = Date.now()): Promise<string[]> =>
  (await dueAmong(db, tracked, nowMs)).sort();

// ---- reading ------------------------------------------------------------------

/** Newest runs of a repo with their results; for the Nightly page. */
export async function recentRuns(db: Db, repo: string, limit = 14): Promise<(NightlyRun & { results: NightlyResult[] })[]> {
  return (await inference.loadNightlyGrid(db, [repo], { nights: limit, sparkPoints: 0, window: 0 })).get(repo)?.runs ?? [];
}

/** A bench's points, oldest first. */
export async function benchSeries(db: Db, repo: string, bench: string): Promise<BenchPoint[]> {
  return await inference.loadBenchSeries(db, repo, bench);
}

export function defaultDeps(): NightlyDeps {
  return {
    now: () => new Date(),
    toolchains: async (db) => new Set((await listEnvs(db)).filter((e) => e.enabled && e.online).flatMap((e) => e.capabilities?.toolchains ?? [])),
    readArtifact: async (db, taskId, name) => {
      const file = (await loadArtifactFiles(db, [{ taskId, name }])).get(`${taskId}/${name}`);
      const path = file ? absolute(file) : null;
      if (!path) return null;
      try { return readFileSync(path, "utf8"); } catch { return null; }
    },
    openIssue: async (db, o) => {
      const g = await guardRepo(db, o.repo, "comment", { operator: o.by }, o.by);
      if ("refused" in g) throw new IssueError(g.refused, true);
      return createIssue({ db, login: o.by }, g, exec, { repo: o.repo, target: issueTarget(o.repo), title: o.title, body: o.body }, { by: "fixed-operator" }, { check: o.checkId });
    },
    read: ghExec,
  };
}

// ---- benchmarks ---------------------------------------------------------------

/** The lines of `cargo bench -- --output-format bencher`: `test name ... bench:   1,234 ns/iter (+/- 56)`. */
export function parseBench(text: string): { bench: string; value: number; unit: string }[] {
  const out: { bench: string; value: number; unit: string }[] = [];
  for (const line of text.split("\n")) {
    const m = /^test\s+(\S+)\s+\.\.\.\s+bench:\s+([\d,]+(?:\.\d+)?)\s+(\S+)/.exec(line);
    if (m) out.push({ bench: m[1]!.slice(0, 200), value: Number(m[2]!.replace(/,/g, "")), unit: m[3]!.slice(0, 20) });
  }
  return out;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** Stores the points and returns the benches more than 10% above the median of their last 7 earlier nights. */
async function storeBench(db: Db, repo: string, sha: string, at: string, points: { bench: string; value: number; unit: string }[]): Promise<{ bench: string; pct: number }[]> {
  const prior = await inference.loadBenchPrior(db, repo, [...new Set(points.map((p) => p.bench))], { sha, at }, BENCH_WINDOW);
  const slow: { bench: string; pct: number }[] = [];
  for (const p of points) {
    const before = prior.get(p.bench) ?? [];
    if (before.length >= BENCH_MIN_HISTORY) {
      const m = median(before);
      if (m > 0 && p.value > m * BENCH_WARN_RATIO) slow.push({ bench: p.bench, pct: Math.round((p.value / m - 1) * 100) });
    }
  }
  await inference.saveBenchPoints(db, points.map((p) => ({ repo, bench: p.bench, sha, at, value: p.value, unit: p.unit })));
  return slow;
}

/** Drops benchmark points older than BENCH_KEEP_MS. */
export async function pruneBench(db: Db, nowMs: number = Date.now()): Promise<number> {
  return await inference.pruneBench(db, nowMs);
}

// ---- collecting ---------------------------------------------------------------

const one = (s: string, n = 200): string => scrub(s).replace(/\s+/g, " ").trim().slice(0, n);

/** Advisory ids only: the audit's text never reaches an issue. */
export function advisoryIds(text: string | null): string[] {
  return [...new Set(text?.match(/RUSTSEC-\d{4}-\d{4}/g) ?? [])].slice(0, 20);
}

async function judge(db: Db, c: NightlyCheck, t: BuildTask, run: NightlyRun, at: string, deps: NightlyDeps): Promise<{ state: ResultState; summary: string | null }> {
  const o = outcomeOf(t);
  if (o.kind === "error") return { state: "error", summary: one(o.reason) };
  if (o.kind === "fail") {
    const why = o.timedOut ? "timed out" : `exit ${o.exitCode ?? "none"}`;
    if (c.kind === "audit") {
      const ids = advisoryIds(c.artifact ? await deps.readArtifact(db, t.id, c.artifact) : null);
      return { state: "fail", summary: ids.length ? `advisories: ${ids.join(", ")}` : `${o.step} failed (${why})` };
    }
    return { state: "fail", summary: `${o.step} failed (${why})` };
  }
  if (c.kind === "bench") {
    const text = c.artifact ? await deps.readArtifact(db, t.id, c.artifact) : null;
    const points = text ? parseBench(text) : [];
    if (!points.length) return { state: "error", summary: "no benchmark lines in the output" };
    const slow = await storeBench(db, run.repo, run.sha, at, points);
    if (slow.length) return { state: "warn", summary: one(`slower than the 7-night median: ${slow.slice(0, 5).map((s) => `${s.bench} +${s.pct}%`).join(", ")}${slow.length > 5 ? `, ${slow.length - 5} more` : ""}`, 300) };
  }
  return { state: "pass", summary: null };
}

/** Issue text: fixed layout; the summary is scrubbed and, for an audit, only advisory ids. */
export function nightlyIssueBody(c: NightlyCheck, sha: string, summary: string | null): string {
  return `The nightly check "${cleanLine(c.label, 80)}" failed on the default branch at ${sha.slice(0, 8)} on two nights in a row.${summary ? `\n\n${cleanLine(summary, 300)}` : ""}`;
}
const issueTitle = (c: NightlyCheck): string => `Nightly check fails: ${cleanLine(c.label, 80)}`;

const issueTarget = (repo: string): string => `${repo}:nightly`;

/** Failing nights in a row before an issue can be opened. */
export const STREAK_TO_OPEN = 2;
/** The nights the Open issue control looks back over. */
const ISSUE_NIGHTS = 30;
/** A create that was claimed longer ago than this is not running any more (a create takes seconds; the write pacing waits at most PACE_MAX_WAIT_MS). */
const CLAIM_MS = Math.max(10 * 60_000, 4 * PACE_MAX_WAIT_MS);

type Night = { run: NightlyRun; result: NightlyResult };

/** The check's failing streak: the consecutive failed nights up to the newest (a skipped, queued or errored night says nothing; a pass or warn ends it), newest first. */
export function failingStreak(runs: (NightlyRun & { results: NightlyResult[] })[], checkId: string): Night[] {
  const nights = runs.flatMap((run): Night[] => { const result = run.results.find((x) => x.checkId === checkId); return result && !["error", "skipped", "queued"].includes(result.state) ? [{ run, result }] : []; });
  const end = nights.findIndex((m) => m.result.state !== "fail");
  return end < 0 ? nights : nights.slice(0, end);
}

/** The issue opened for the streak, or null. */
export const issueOf = (streak: Night[]): number | null => streak.find((m) => m.result.issueNumber !== null)?.result.issueNumber ?? null;

/** Whether a person may open an issue for the streak of check `c`. */
export const mayOpenIssue = (c: NightlyCheck, streak: Night[]): boolean => !c.experimental && streak.length >= STREAK_TO_OPEN && issueOf(streak) === null;

/** The Open issue control refused: the message is the presser's answer. */
export class NightlyRefused extends Error {}

const streakNow = async (db: Db, repo: string, checkId: string): Promise<Night[]> =>
  failingStreak((await inference.loadNightlyGrid(db, [repo], { nights: ISSUE_NIGHTS, sparkPoints: 0, window: 0 })).get(repo)?.runs ?? [], checkId);

/**
 * The Open issue control: opens one issue for a check that is failing, naming the check and the failure. Refused for an experimental
 * check, a streak shorter than STREAK_TO_OPEN, and a streak that has its issue, or one being opened. The streak's results are claimed
 * (with the presser's audit row) before the create, and then carry the issue's number. A claim whose create stopped, or whose outcome was not
 * known, is settled by the next press: from the create's audit row, else by looking for the issue on GitHub, and only an issue that is not
 * there is opened again.
 */
export async function openNightlyIssue(db: Db, o: { repo: string; checkId: string; by: string }, deps: NightlyDeps = defaultDeps()): Promise<{ number: number; url: string }> {
  const c = checkOf(o.checkId);
  if (!c) throw new NightlyRefused(`unknown nightly check ${o.checkId}`);
  if (c.experimental) throw new NightlyRefused(`no issue is opened for the experimental check ${c.id}`);
  const press = async (state: "opening" | "unknown", why?: string) =>
    await addAudit(db, [{ login: o.by, action: "nightly-issue", target: o.repo, at: deps.now().toISOString(), details: { check: c.id, state, ...(why && { error: why }) } }]);
  const { streak, claimedBefore } = await db.write(async () => {
    const streak = await streakNow(db, o.repo, c.id);
    if (streak.length < STREAK_TO_OPEN) throw new NightlyRefused(`the nightly check ${c.id} is not failing ${STREAK_TO_OPEN} nights in a row on ${o.repo}`);
    const had = issueOf(streak);
    if (had !== null) throw new NightlyRefused(`issue #${had} is already open for the nightly check ${c.id} on ${o.repo}`);
    const claimedBefore = streak.some((m) => m.result.issueClaimed);
    if (claimedBefore) {
      const last = (await listAudit(db, { actions: ["nightly-issue"], targets: [o.repo], order: "desc" })).find((a) => a.details?.check === c.id);
      if (last && last.details?.state === "opening" && deps.now().getTime() - Date.parse(last.at) < CLAIM_MS) throw new NightlyRefused(`an issue for the nightly check ${c.id} on ${o.repo} is being opened`);
    }
    await inference.claimIssue(db, { repo: o.repo, checkId: c.id, runIds: streak.map((m) => m.run.id) });
    await press("opening");
    return { streak, claimedBefore };
  });
  const mark = async (made: { number: number; url: string }): Promise<{ number: number; url: string }> => {
    await inference.markIssue(db, { repo: o.repo, checkId: c.id, runIds: streak.map((m) => m.run.id), issue: made.number });
    return made;
  };
  const lost = async (e: unknown): Promise<never> => {
    const why = one(String((e as Error).message ?? e));
    await press("unknown", why);
    throw new IssueError(`whether the issue was opened is not known: ${why}`, false);
  };
  if (claimedBefore) {
    const since = streak[streak.length - 1]!.run.startedAt;
    const began = (await listAudit(db, { actions: ["postmerge-file"], targets: [issueTarget(o.repo)], since, order: "desc" })).filter((a) => a.details?.check === c.id);
    for (const a of began) {
      const url = a.details?.state === "done" ? String(a.details.url ?? "") : "";
      const m = /\/issues\/(\d+)$/.exec(url);
      if (m) return await mark({ number: Number(m[1]), url });
    }
    for (const a of began.filter((a) => unclearWrite(a.details))) {
      let made: { number: number; url: string } | null;
      try { made = await issueMade(deps.read, { repo: o.repo, title: String(a.details?.title ?? ""), body: String(a.details?.text ?? ""), since: a.at, mine: await byUs(db) }); } catch (e) { return await lost(e); }
      if (made) return await mark(made);
    }
  }
  const last = streak[0]!;
  let made: { number: number; url: string };
  try {
    made = await deps.openIssue(db, { repo: o.repo, checkId: c.id, title: issueTitle(c), body: nightlyIssueBody(c, last.run.sha, last.result.summary), by: o.by });
  } catch (e) {
    if (!(e instanceof IssueError) || !e.clear) return await lost(e);
    await inference.releaseIssue(db, { repo: o.repo, checkId: c.id });
    throw e;
  }
  return await mark(made);
}

/** A night that goes on a streak with an issue carries its number, so the streak keeps it however long it lasts. */
async function carryIssues(db: Db, repo: string, checkIds: string[]): Promise<void> {
  if (!checkIds.length) return;
  const runs = (await inference.loadNightlyGrid(db, [repo], { nights: ISSUE_NIGHTS, sparkPoints: 0, window: 0 })).get(repo)?.runs ?? [];
  for (const checkId of new Set(checkIds)) {
    const streak = failingStreak(runs, checkId), issue = issueOf(streak);
    if (issue !== null) await inference.markIssue(db, { repo, checkId, runIds: streak.filter((m) => m.result.issueNumber === null).map((m) => m.run.id), issue });
  }
}

async function collect(db: Db, repo: string, deps: NightlyDeps, s: NightlySummary): Promise<void> {
  const at = deps.now().toISOString();
  const runs = (await inference.loadOpenRuns(db, [repo])).get(repo) ?? [];
  if (!runs.length) return;
  const queued = await inference.loadResults(db, runs.map((u) => u.id), "queued");
  const taskIds = [...new Set([...queued.values()].flatMap((rs) => rs.flatMap((r) => (r.taskId === null ? [] : [r.taskId]))))];
  const tasks = new Map<number, BuildTask | null>();
  for (const id of taskIds) tasks.set(id, await getTask(db, id));
  const set: Parameters<typeof inference.setResults>[1] = [];
  for (const u of runs) {
    for (const r of queued.get(u.id) ?? []) {
      const c = checkOf(r.checkId);
      const t = r.taskId === null ? null : tasks.get(r.taskId) ?? null;
      if (!c || !t) { set.push({ runId: u.id, checkId: r.checkId, state: "error", summary: !c ? "check no longer in the catalogue" : "the build task is gone", finishedAt: at }); s.collected++; continue; }
      if (!TERMINAL.includes(t.state)) continue;
      const j = await judge(db, c, t, u, t.endedAt ?? at, deps);
      set.push({ runId: u.id, checkId: r.checkId, state: j.state, summary: j.summary, finishedAt: at });
      s.collected++;
    }
  }
  await db.write(async () => {
    await inference.setResults(db, set);
    await inference.closeRuns(db, runs.map((u) => u.id));
    await carryIssues(db, repo, set.filter((r) => r.state === "fail").map((r) => r.checkId));
  });
}

// ---- queueing -----------------------------------------------------------------

/** One run: a row, and per selected check a queued task, or `skipped` when no environment has the toolchain or the selection leaves nothing to run. */
async function queueRun(db: Db, repo: string, deps: NightlyDeps, s: NightlySummary): Promise<void> {
  const nowMs = deps.now().getTime();
  const [state, selections, heads] = await db.together(() => Promise.all([
    inference.loadNightlyState(db, [repo], { since: new Date(nowMs - NIGHTLY_EVERY_MS).toISOString(), staleSince: new Date(nowMs - STALE_RUN_MS).toISOString() }),
    inference.loadSelections(db, [repo]),
    loadLatestMainHeads(db, [repo]),
  ]));
  const sha = heads.get(repo)?.head_sha ?? null;
  const checks = enabledOf(selections.get(repo) ?? []);
  if (!sha || !checks.length || state.get(repo)!.recentRun) return;
  const have = await deps.toolchains(db);
  const at = new Date(nowMs).toISOString();
  const skipped = (check: NightlyCheck, summary: string) => ({ checkId: check.id, taskId: null, state: "skipped" as ResultState, summary, finishedAt: at });
  try {
    await db.write(async () => {
      const runId = await inference.startRun(db, { repo, sha, at });
      const rows: Parameters<typeof inference.addResults>[1] = [];
      let queued = 0, skippedN = 0;
      for (const { check, opts } of checks) {
        if (!have.has(check.toolchain)) { rows.push({ runId, ...skipped(check, "no toolchain") }); skippedN++; continue; }
        const plan = check.steps(opts);
        if (!plan) { rows.push({ runId, ...skipped(check, check.id === "fuzz" ? "no fuzz targets chosen" : "no crates chosen") }); skippedN++; continue; }
        const id = await createTask(db, { step: "nightly", repo, headSha: sha, baseSha: sha, requires: { os: "linux", toolchains: [check.toolchain] }, priority: NIGHTLY_PRIORITY, plan });
        rows.push({ runId, checkId: check.id, taskId: id, state: "queued", summary: null, finishedAt: null });
        queued++;
      }
      await inference.addResults(db, rows);
      s.queued += queued;
      s.skipped += skippedN;
    });
  } catch (e) {
    // A full build queue refuses a task: the run row and its tasks roll back together and the next run tries again.
    if (!(e instanceof BuildError) || e.status !== 429) throw e;
    s.note = "the build queue is full; tried again at the next run";
  }
}

/** One repo: results of finished tasks first, then (once a day) the next run. Nothing at all with the switch off. */
export async function runNightly(db: Db, params: { repo: string; by?: By; onHandled?: (n: number) => void }, log: (l: string) => void = console.log, deps: NightlyDeps = defaultDeps()): Promise<NightlySummary> {
  const { repo } = params;
  const s: NightlySummary = { repo, queued: 0, skipped: 0, collected: 0, note: null };
  if (!await featureOn(db, "nightly", repo)) {
    s.note = `the Nightly checks feature is off for ${repo}`;
    log(`nightly ${repo}: ${s.note}; nothing done`);
    return s;
  }
  await collect(db, repo, deps, s);
  await queueRun(db, repo, deps, s);
  params.onHandled?.(s.queued + s.skipped + s.collected);
  log(`nightly ${repo}: queued ${s.queued}, skipped ${s.skipped}, collected ${s.collected}`);
  return s;
}
