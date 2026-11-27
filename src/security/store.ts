// Rows of the security deep scan and their views for the API (web/src/api/types.ts), composed from the security data module.
import { dropSessions } from "../prepush/resume.ts";
import { slugOf } from "../owners.ts";
import { securityRepo } from "./rules.ts";
import type { FindingCall, FindingRef, FindingSeverity, FindingState, FindingSummary, FindingVerification, FindingView, ScanArea, ScanCall, ScanDetail, ScanEntryPoint, ScanTestState, FindingScanTest, ScanView, SecurityOverview } from "../../web/src/api/types.ts";
import * as sec from "../data/security/index.ts";
import type { Db } from "../db/index.ts";

export { ACTIVE_STATES, INTERNAL_FINDING_STATES, TRANSITIONS, UNCHECKED_RESULT } from "../data/security/index.ts";
export type ScanRow = sec.ScanListRow;
export type FindingRow = Omit<sec.FindingRow, "severity" | "state"> & { severity: FindingSeverity; state: FindingState };

const asFinding = (r: sec.FindingRow): FindingRow => r as FindingRow;

export const scanRow = async (db: Db, id: number): Promise<ScanRow | undefined> => (await sec.loadScans(db, [id])).get(id);

/** The API view of a scan; `r` carries the count of its listed findings. */
export function scanView(r: sec.ScanListRow): ScanView {
  return {
    id: r.id, repo: r.repo, commit: r.commit_sha, state: r.state as ScanView["state"], capUsd: r.cap_usd, costUsd: r.cost_usd, estimateUsd: r.estimate_usd,
    areasTotal: r.areas_total, areasDone: r.areas_done, findingCount: r.finding_count, startedBy: r.started_by, startedAt: r.started_at, endedAt: r.ended_at, error: r.error, canAct: false, canContinue: false,
  };
}

export async function toScan(db: Db, r: sec.ScanRow): Promise<ScanView> {
  return scanView((await sec.loadScans(db, [r.id])).get(r.id) ?? { ...r, finding_count: 0 });
}

/** The active scan of a repo, if any. Scans of one repo never overlap. */
export async function activeScan(db: Db, repo: string): Promise<sec.ScanRow | undefined> {
  return (await sec.loadActiveScans(db, [repo])).get(repo);
}

/**
 * Closes what a dead job left: scans whose job ended or was never recorded, and fixing or landing findings with no job. The
 * rounds of a cleared fix are logged under the attempt that made them.
 */
export async function reconcile(db: Db, repo?: string): Promise<void> {
  await sec.reconcileSecurity(db, { repo });
}
export const reconcileScans = reconcile;
export const reconcileFindings = reconcile;

/** Ends an active scan; a scan that already ended keeps its state. Leftover unverified findings become listed findings that say so. */
export async function finishScan(db: Db, id: number, state: sec.ScanState, error: string | null = null): Promise<void> {
  await sec.finishScans(db, [{ id, state, error }]);
}

const parse = <T>(s: string | null, fallback: T): T => {
  try { return s ? JSON.parse(s) as T : fallback; } catch { return fallback; }
};

export const findingKey = (repo: string, n: number): string => `${repo}:finding:${n}`;

const summary = (r: sec.FindingBriefRow): FindingSummary => ({
  repo: r.repo, number: r.number, key: findingKey(r.repo, r.number), scanId: r.scan_id, title: r.title, severity: r.severity as FindingSeverity, urgent: r.urgent === 1, area: r.area,
  state: r.state as FindingState, createdAt: r.created_at, updatedAt: r.updated_at,
});

/** Brief rows with the state of their scan test; findings without a scan test keep no key. */
const withScanTest = (rows: (sec.FindingBriefRow & { scan_test_state?: string | null })[]): FindingSummary[] =>
  rows.map((r) => (r.scan_test_state ? { ...summary(r), scanTest: r.scan_test_state as ScanTestState } : summary(r)));

/** Drops the stored sessions of cleared rounds once the surrounding transaction (if any) has committed. */
export function dropRoundSessions(db: Db, sessions: string[]): void {
  const drop = (): void => { for (const s of sessions) dropSessions(s); };
  if (db.inTransaction()) db.afterCommit(drop);
  else drop();
}

/** Forgets the rounds of a finding's fix (it ended, ready or not) and removes the sessions they still keep. The rounds stay in the fix log, without patches. */
export async function clearRounds(db: Db, repo: string, n: number): Promise<void> {
  dropRoundSessions(db, (await sec.clearRounds(db, [sec.findingKey(repo, n)])).sessions);
}

export async function overview(db: Db, repo: string): Promise<SecurityOverview> {
  await reconcile(db, repo);
  const o = await sec.loadOverview(db, repo);
  return { canStart: false, scans: o.scans.map(scanView), findings: withScanTest(o.findings as never) };
}

export const findingRow = async (db: Db, repo: string, n: number): Promise<FindingRow | undefined> => {
  const r = (await sec.loadFindings(db, [sec.findingKey(repo, n)])).get(sec.findingKey(repo, n));
  return r && asFinding(r);
};

/** The finding's row whatever its state, for the steps that work on it. */
export const rawFinding = async (db: Db, repo: string, n: number): Promise<FindingRow | undefined> => {
  const r = (await sec.loadFindings(db, [sec.findingKey(repo, n)], { internal: true })).get(sec.findingKey(repo, n));
  return r && asFinding(r);
};

export type FindingDetail = { view: FindingView; row: FindingRow; log: sec.LogRound[]; rounds: sec.LiveRound[] };

/** The finding page's data in one wave: the view, the fix log and the live rounds. Undefined for a finding that is not listed. */
export async function findingDetail(db: Db, repo: string, n: number): Promise<FindingDetail | undefined> {
  const d = await sec.loadFindingDetail(db, sec.findingKey(repo, n));
  if (!d) return undefined;
  const r = asFinding(d.finding);
  const timeline: FindingCall[] = [
    ...d.calls.map((c) => ({ kind: c.kind as FindingCall["kind"], at: c.started_at, endedAt: c.ended_at, ok: c.ok === 1, costUsd: c.cost_usd })),
    ...d.repeats.map((x): FindingCall => ({ kind: "duplicate", at: x.created_at, endedAt: null, ok: true, costUsd: null })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const view: FindingView = {
    ...summary(r), scanTestResult: d.scanTest ? { state: d.scanTest.state as ScanTestState, detail: d.scanTest.detail, path: d.scanTest.test_path, source: d.scanTest.test_source } satisfies FindingScanTest : null,
    refs: parse<FindingRef[]>(r.refs, []), reach: r.reach, impact: r.impact, verification: parse<FindingVerification | null>(r.verification, null),
    fixDiff: r.fix_patch, fixPr: r.fix_pr, fixPrUrl: r.fix_pr === null ? null : `https://github.com/${r.fork ?? slugOf(r.repo)}/pull/${r.fix_pr}`,
    ghsaId: r.ghsa_id, advisoryUrl: r.ghsa_id ? `https://github.com/${slugOf(r.repo)}/security/advisories/${r.ghsa_id}` : null, note: r.note,
    reason: r.reason, decidedBy: r.decided_by,
    timeline,
  };
  return { view, row: r, log: d.log, rounds: d.rounds };
}

export async function toFinding(db: Db, r: sec.FindingRow): Promise<FindingView> {
  return (await findingDetail(db, r.repo, r.number))!.view;
}

export async function moveFinding(db: Db, repo: string, n: number, action: keyof typeof sec.TRANSITIONS, by: string, reason: string | null): Promise<FindingState | null> {
  return (await sec.moveFindings(db, [{ repo, number: n, action, by, reason }])).get(sec.findingKey(repo, n)) ?? null;
}

/**
 * Moves a finding from one of the states `from` to `to` and sets more columns in the same statement. Returns false when the
 * finding is in none of them, so two requests cannot both start the same step.
 */
export async function advance(db: Db, repo: string, n: number, from: FindingState[], to: FindingState, set: sec.FindingPatch = {}, by?: string): Promise<boolean> {
  return await sec.advanceFinding(db, { repo, number: n, from, to, set, ...(by !== undefined && { by }) });
}

/** Records one model call of a finding's fix in its timeline; the cost may be unknown. */
export async function recordFixCall(db: Db, scanId: number, n: number, kind: "fix" | "review", startedAt: string, ok: boolean, costUsd: number | null, resumed = false): Promise<void> {
  await sec.addCalls(db, [{ scanId, kind, finding: n, ok, costUsd, startedAt, resumed }]);
}

/** Scans of one repo or, with none given, of the repos in `repos`, newest first. */
export async function listScans(db: Db, repos: string[], repo?: string): Promise<ScanView[]> {
  const want = repo ? repos.filter((r) => r === repo) : repos;
  if (!want.length) return [];
  await reconcile(db, repo);
  return (await sec.listScans(db, { repos: want, limit: 200 })).map(scanView);
}

/**
 * The scan with its threat model, calls and findings. A call keeps the agent run it recorded; a call without one (rows from before
 * the link, and a call still running) takes the first run of the scan that started within its time window.
 */
export async function scanDetail(db: Db, r: sec.ScanRow): Promise<ScanDetail> {
  await reconcile(db, r.repo);
  const d = (await sec.loadScanDetail(db, r.id, { runs: { pseudoRepo: securityRepo(r.repo), vis: { hidden: [], staff: true } } }))!;
  const model = parse<{ summary?: string; entryPoints?: ScanEntryPoint[] }>(d.scan.threat_model, {});
  const live = sec.ACTIVE_STATES.includes(d.scan.state as sec.ScanState);
  const runById = new Map(d.runs.map((x) => [x.id, x]));
  const runFor = (startedAt: string, endedAt: string | null) => d.runs.find((x) => x.startedAt >= startedAt && (endedAt === null || x.startedAt <= endedAt));
  const calls: ScanCall[] = d.calls.map((c) => {
    const run = c.agent_run_id !== null ? runById.get(c.agent_run_id) : runFor(c.started_at, c.ended_at);
    const running = c.ended_at === null && live;
    return {
      id: c.id, kind: c.kind as FindingCall["kind"], areaName: c.area_name, findingNumber: c.finding_number,
      state: running ? "running" : c.ok === 1 ? "done" : "failed", startedAt: c.started_at, endedAt: c.ended_at, costUsd: c.cost_usd,
      runId: run?.id ?? null, progress: running ? run?.progress ?? null : null,
    };
  });
  const runningAreas = new Set(d.calls.filter((c) => c.kind === "area" && c.ended_at === null && live).map((c) => c.area_idx));
  const areas = d.areas.map((a): ScanArea => ({ idx: a.idx, name: a.name, risk: a.risk, why: a.why, paths: parse<string[]>(a.paths, []), state: a.state === "done" || a.state === "failed" ? a.state : runningAreas.has(a.idx) ? "running" : "pending", costUsd: a.cost_usd }));
  return { scan: scanView(d.scan), summary: model.summary ?? null, entryPoints: model.entryPoints ?? [], areas, calls, findings: withScanTest(d.findings) };
}
