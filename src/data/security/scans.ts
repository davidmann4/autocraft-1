// Scans, areas and model calls (package security).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb, type QueryDb } from "../../db/query-db.ts";
import type { RunVisibility } from "../inference/types.ts";
import { loadItemRuns } from "../inference/index.ts";
import { liveJobOfFinding, jobEnded } from "../jobs/fragments.ts";
import { jobStateOf } from "../jobs/fragments.ts";
import { advanceFindings } from "./findings.ts";
import { clearRounds } from "./rounds.ts";
import { briefCols, LISTED_NOT_IN, nowIso, severityRank } from "./internal.ts";
import {
  ACTIVE_STATES, UNCHECKED_RESULT, findingKey,
  type AreaRow, type CallRow, type EndScanCall, type FindingBriefRow, type FindingKey, type FindingMove, type NewArea, type NewScanCall, type ScanDetailData, type ScanListRow,
  type ScanRow, type ScanRunData, type ScanState, type StaleWork, type UnverifiedRow,
} from "./types.ts";

const UNCHECKED_VERIFICATION = JSON.stringify({ kind: "reasoning", result: UNCHECKED_RESULT, notes: "", score: null, proposedTest: null });
const ORPHAN_GRACE_MS = 60_000;
const NEVER_QUEUED = "The scan was never queued.";
const JOB_ENDED = "The scan's job ended before the scan finished.";
const JOB_ENDED_NOTE = "The job ended before it finished. Try again.";

/** Scan rows with the count of their listed findings. */
const scanSelect = (q: QueryDb) => q.k.selectFrom("security_scans as s").select(kx.cols("security_scans", "s"))
  .select((eb) => eb.selectFrom("security_findings as cf").select(eb.fn.countAll<number>().as("n")).whereRef("cf.scan_id", "=", "s.id").where("cf.state", "not in", LISTED_NOT_IN).as("finding_count"));

/** Scan rows with the listed-finding count. 1 statement. */
export async function loadScans(db: Db, ids: number[]): Promise<Map<number, ScanListRow>> {
  if (ids.length === 0) return new Map();
  const q = queryDb(db);
  const rows = await q.all(scanSelect(q).where(kx.inList(db, "s.id", ids, "bigint")));
  return new Map((rows as ScanListRow[]).map((r) => [r.id, r]));
}

/** Newest scans first; does not reconcile. `repos` limits to those repos (and `repo` to one of them); without `repos`, `repo` alone filters. */
export async function listScans(db: Db, f: { repos?: string[]; repo?: string; limit: number }): Promise<ScanListRow[]> {
  const want = f.repos ? (f.repo ? f.repos.filter((r) => r === f.repo) : f.repos) : f.repo ? [f.repo] : null;
  if (want && want.length === 0) return [];
  const q = queryDb(db);
  return (await q.all(scanSelect(q).$if(want !== null, (b) => b.where(kx.inList(db, "s.repo", want!))).orderBy("s.id", "desc").limit(f.limit))) as ScanListRow[];
}

/** The highest-id active scan per repo (window function). */
export async function loadActiveScans(db: Db, repos: string[] | "all"): Promise<Map<string, ScanRow>> {
  if (repos !== "all" && repos.length === 0) return new Map();
  const q = queryDb(db);
  const ranked = q.k.selectFrom("security_scans").select(kx.cols("security_scans")).select((eb) => eb.fn.agg<number>("row_number").over((o) => o.partitionBy("repo").orderBy("id", "desc")).as("rank"))
    .where("state", "in", ACTIVE_STATES).$if(repos !== "all", (b) => b.where(kx.inList(db, "repo", repos as string[])));
  const rows = await q.all(q.k.selectFrom(ranked.as("r")).selectAll().where("r.rank", "=", 1));
  return new Map(rows.map(({ rank: _rank, ...r }) => [r.repo, r as ScanRow]));
}

/** State and cost of a scan, for the stop and cap check before each model call. */
export async function loadScanGuard(db: Db, id: number): Promise<{ state: ScanState; cost_usd: number } | undefined> {
  const q = queryDb(db);
  return await q.get(q.k.selectFrom("security_scans").select(["state", "cost_usd"]).$narrowType<{ state: ScanState }>().where("id", "=", id));
}

/**
 * Everything the scan job's start needs, in one `together` wave: scan, areas, every finding of the scan's repo in narrow
 * columns (`known`), the earlier ok call costs by kind, and the scan's findings by
 * area with their `unverified` rows (`leftover`). 5 statements.
 */
export async function loadScanRun(db: Db, id: number): Promise<ScanRunData | undefined> {
  const q = queryDb(db);
  const [scan, areas, known, calls, inArea] = await db.together(() => Promise.all([
    q.get(q.k.selectFrom("security_scans").select(kx.cols("security_scans")).where("id", "=", id)),
    q.all(q.k.selectFrom("security_areas").select(kx.cols("security_areas")).where("scan_id", "=", id).orderBy("idx")),
    q.all(q.k.selectFrom("security_findings").select(["repo", "number", "state", "fingerprint", "title", "refs", "category"])
      .where("repo", "=", (eb) => eb.selectFrom("security_scans").select("repo").where("id", "=", id)).orderBy("number")),
    q.all(q.k.selectFrom("security_calls").select(["kind", "cost_usd"]).where("scan_id", "=", id).where("kind", "in", ["area", "verify"]).where("ok", "=", 1).where("cost_usd", "is not", null).orderBy("id")),
    q.all(q.k.selectFrom("security_findings as f").innerJoin("security_areas as a", (j) => j.onRef("a.scan_id", "=", "f.scan_id").onRef("a.name", "=", "f.area"))
      .select(["a.idx as area_idx", "f.state", "f.number", "f.title", "f.severity", "f.urgent", "f.category", "f.refs", "f.reach", "f.impact"]).where("f.scan_id", "=", id).orderBy("f.number")),
  ]));
  if (!scan) return undefined;
  const byArea = new Map<number, { areaIdx: number; findings: number; unverified: UnverifiedRow[] }>();
  for (const r of inArea) {
    const e = byArea.get(r.area_idx) ?? { areaIdx: r.area_idx, findings: 0, unverified: [] };
    e.findings++;
    if (r.state === "unverified") e.unverified.push({ number: r.number, title: r.title, severity: r.severity, urgent: r.urgent, category: r.category, refs: r.refs, reach: r.reach, impact: r.impact });
    byArea.set(r.area_idx, e);
  }
  return {
    scan: scan as ScanRow, areas: areas as AreaRow[], known,
    callCosts: calls.map((c) => ({ kind: c.kind, costUsd: c.cost_usd! })), leftover: [...byArea.values()],
  };
}

/**
 * The scan page's data in one wave: scan, areas, calls with area names, listed findings with their scan-test state and, when
 * `o.runs` is given, the scan's runs under its pseudo repo. 5 statements without runs, 6 with. Does not reconcile.
 */
export async function loadScanDetail(db: Db, id: number, o: { runs?: { pseudoRepo: string; vis: RunVisibility } } = {}): Promise<ScanDetailData | undefined> {
  const q = queryDb(db);
  const [scan, areas, calls, findings, runs] = await db.together(() => Promise.all([
    q.get(scanSelect(q).where("s.id", "=", id)),
    q.all(q.k.selectFrom("security_areas").select(kx.cols("security_areas")).where("scan_id", "=", id).orderBy("idx")),
    q.all(q.k.selectFrom("security_calls as c").leftJoin("security_areas as ar", (j) => j.onRef("ar.scan_id", "=", "c.scan_id").onRef("ar.idx", "=", "c.area_idx"))
      .select(kx.cols("security_calls", "c")).select("ar.name as area_name").where("c.scan_id", "=", id).orderBy("c.id")),
    q.all((q.k as any).selectFrom("security_findings as f").leftJoin("security_scan_tests as t", (j: any) => j.onRef("t.repo", "=", "f.repo").onRef("t.number", "=", "f.number"))
      .select(briefCols("f")).select("t.state as scan_test_state").where("f.scan_id", "=", id).where("f.state", "not in", LISTED_NOT_IN)
      .orderBy((eb: any) => severityRank(eb, "f.severity")).orderBy("f.number")),
    o.runs ? loadItemRuns(db, [`${o.runs.pseudoRepo}#${id}`], o.runs.vis) : Promise.resolve(undefined),
  ]));
  if (!scan) return undefined;
  return {
    scan: scan as ScanListRow, areas: areas as AreaRow[], calls: calls as (CallRow & { area_name: string | null })[],
    findings: findings as (FindingBriefRow & { scan_test_state: string | null })[], runs: runs?.get(`${o.runs!.pseudoRepo}#${id}`) ?? [],
  };
}

/** The 20 newest scans of the repo with counts and up to 500 listed findings with scan-test state. 2 statements. */
export async function loadOverview(db: Db, repo: string): Promise<{ scans: ScanListRow[]; findings: FindingBriefRow[] }> {
  const q = queryDb(db);
  const [scans, findings] = await db.together(() => Promise.all([
    q.all(scanSelect(q).where("s.repo", "=", repo).orderBy("s.id", "desc").limit(20)),
    q.all((q.k as any).selectFrom("security_findings as f").leftJoin("security_scan_tests as t", (j: any) => j.onRef("t.repo", "=", "f.repo").onRef("t.number", "=", "f.number"))
      .select(briefCols("f")).select("t.state as scan_test_state").where("f.repo", "=", repo).where("f.state", "not in", LISTED_NOT_IN)
      .orderBy((eb: any) => severityRank(eb, "f.severity")).orderBy("f.number").limit(500)),
  ]));
  return { scans: scans as ScanListRow[], findings: findings as FindingBriefRow[] };
}

// ---- writers ----------------------------------------------------------------------------------------------------

/** Inserts a scan in state `modeling`; joins the caller's transaction. */
export async function addScan(db: Db, r: { repo: string; cap_usd: number | null; started_by: string }): Promise<number> {
  const q = queryDb(db);
  return (await q.get(q.k.insertInto("security_scans").values({ repo: r.repo, state: "modeling", cap_usd: r.cap_usd, started_by: r.started_by, started_at: nowIso() }).returning("id")))!.id;
}

/** Links the scan to its job; joins the caller's transaction. */
export async function linkScanJob(db: Db, scanId: number, jobId: number): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.updateTable("security_scans").set({ job_id: jobId }).where("id", "=", scanId));
}

/** Sets the scan state, guarded by the active states. */
export async function setScanState(db: Db, id: number, state: "modeling" | "scanning" | "verifying"): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.updateTable("security_scans").set({ state }).where("id", "=", id).where("state", "in", ACTIVE_STATES));
}

/** Records the commit the scan reads. */
export async function setScanCommit(db: Db, id: number, sha: string): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.updateTable("security_scans").set({ commit_sha: sha }).where("id", "=", id));
}

/** One multi-row area insert and one scan update with `estimate_usd = cost_usd + guess` in SQL, in one `db.write`. */
export async function saveThreatModel(db: Db, id: number, m: { summaryJson: string; areas: NewArea[]; guessUsd: number }): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    for (const rows of kx.batches(m.areas)) await q.run(q.k.insertInto("security_areas").values(rows.map((a) => ({ scan_id: id, ...a }))));
    await q.run(q.k.updateTable("security_scans").set((eb) => ({ areas_total: m.areas.length, estimate_usd: eb("cost_usd", "+", m.guessUsd), threat_model: m.summaryJson })).where("id", "=", id));
  });
}

/** Inserts a running call row; returns its id. */
export async function beginScanCall(db: Db, c: NewScanCall): Promise<number> {
  const q = queryDb(db);
  return (await q.get(q.k.insertInto("security_calls").values({ scan_id: c.scanId, kind: c.kind, area_idx: c.areaIdx ?? null, finding_number: c.finding ?? null, started_at: nowIso() }).returning("id")))!.id;
}

/** Ends a call: the call row, the scan's cost, the area's cost and the finding verdict in one `db.write`. */
export async function endScanCall(db: Db, e: EndScanCall): Promise<void> {
  const q = queryDb(db);
  const at = nowIso();
  await db.write(async () => {
    await q.run(q.k.updateTable("security_calls").set({ ended_at: at, ok: e.ok ? 1 : 0, cost_usd: e.costUsd, agent_run_id: e.runId }).where("id", "=", e.callId));
    await q.run(q.k.updateTable("security_scans").set((eb) => ({ cost_usd: eb("cost_usd", "+", e.chargeUsd) })).where("id", "=", e.scanId));
    if (e.billArea !== undefined) await q.run(q.k.updateTable("security_areas").set((eb) => ({ cost_usd: eb("cost_usd", "+", e.chargeUsd) })).where("scan_id", "=", e.scanId).where("idx", "=", e.billArea));
    if (e.finding) {
      const { bumpFixAttempts: _b, restoreFixAttempts: _r, ...cols } = e.finding.patch;
      await q.run(q.k.updateTable("security_findings").set({ state: e.finding.state, updated_at: at, ...cols }).where("repo", "=", e.finding.repo).where("number", "=", e.finding.number));
    }
  });
}

/** Inserts call rows; joins the caller's transaction. */
export async function addCalls(db: Db, rows: (NewScanCall & { ok?: boolean; costUsd?: number | null; runId?: number | null; startedAt?: string; endedAt?: string | null })[]): Promise<void> {
  if (rows.length === 0) return;
  const q = queryDb(db);
  const at = nowIso();
  const values = rows.map((r) => ({
    scan_id: r.scanId, kind: r.kind, area_idx: r.areaIdx ?? null, finding_number: r.finding ?? null, started_at: r.startedAt ?? at, ended_at: r.endedAt === undefined ? at : r.endedAt,
    ok: r.ok ? 1 : 0, cost_usd: r.costUsd ?? null, agent_run_id: r.runId ?? null, resumed: r.resumed ? 1 : 0,
  }));
  for (const chunk of kx.batches(values)) await q.run(q.k.insertInto("security_calls").values(chunk));
}

/** Ends an area and updates the scan's `areas_done` and `estimate_usd` (cost so far plus the areas left at the average area cost, in SQL) in one `db.write`. */
export async function finishArea(db: Db, a: { scanId: number; idx: number; failed: boolean }): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    await q.run(q.k.updateTable("security_areas").set({ state: a.failed ? "failed" : "done" }).where("scan_id", "=", a.scanId).where("idx", "=", a.idx));
    await q.run(q.k.updateTable("security_scans").set((eb) => ({
      areas_done: a.idx + 1,
      estimate_usd: eb("cost_usd", "+", eb(eb("areas_total", "-", a.idx + 1), "*", eb.fn.coalesce(eb.selectFrom("security_areas").select(eb.fn.avg<number>("cost_usd").as("a")).where("scan_id", "=", a.scanId).where("state", "!=", "pending"), eb.lit(0)))),
    })).where("id", "=", a.scanId));
  });
}

/**
 * Ends active scans (guarded, `RETURNING id`) and moves the `unverified` findings of every given scan to `new` with the unchecked
 * result: a scan that Stop already ended may have stored findings since, before its job noticed.
 */
export async function finishScans(db: Db, rows: { id: number; state: ScanState; error?: string | null }[]): Promise<{ ended: number[] }> {
  if (rows.length === 0) return { ended: [] };
  const q = queryDb(db);
  const at = nowIso();
  const ended: number[] = [];
  await db.write(async () => {
    for (const chunk of kx.chunks(rows)) {
      const v = kx.valuesTable(db, chunk.map((r) => ({ id: r.id, state: r.state, error: r.error ?? null })), { id: "bigint", state: "text", error: "text" }, "v");
      const hit = await q.all((q.k as any).updateTable("security_scans").from(v)
        .set((eb: any) => ({ state: eb.ref("v.state"), ended_at: at, error: eb.ref("v.error") }))
        .where((eb: any) => eb.and([eb("security_scans.id", "=", eb.ref("v.id")), eb("security_scans.state", "in", ACTIVE_STATES)])).returning("security_scans.id")) as { id: number }[];
      ended.push(...hit.map((h) => h.id));
    }
    for (const chunk of kx.chunks(rows)) await q.run(q.k.updateTable("security_findings").set({ state: "new", verification: UNCHECKED_VERIFICATION, updated_at: at }).where(kx.inList(db, "scan_id", chunk.map((r) => r.id), "bigint")).where("state", "=", "unverified"));
  });
  return { ended };
}

/**
 * Resumes a capped scan: a guarded update to the state the continued job starts in (a `CASE` over the threat model and an
 * `EXISTS` of unchecked listed findings, in the statement), then reopens the unchecked findings. Null when no row changed.
 */
export async function resumeScan(db: Db, r: { id: number; cap_usd: number | null }): Promise<{ state: ScanState } | null> {
  const q = queryDb(db);
  return await db.write(async () => {
    const row = await q.get(q.k.updateTable("security_scans").set((eb) => ({
      state: eb.case().when("threat_model", "is", null).then("modeling")
        .when(eb.exists(eb.selectFrom("security_findings as uf").select(eb.lit(1).as("one")).whereRef("uf.scan_id", "=", "security_scans.id").where("uf.state", "=", "new")
          .where((e) => e(kx.jsonText(db, "uf.verification", "$.result"), "=", UNCHECKED_RESULT)))).then("verifying")
        .else("scanning").end(),
      cap_usd: r.cap_usd, ended_at: null, error: null, job_id: null,
    })).where("id", "=", r.id).where("state", "=", "capped").returning("state"));
    if (!row) return null;
    await q.run(q.k.updateTable("security_findings").set({ state: "unverified", verification: null, updated_at: nowIso() }).where("scan_id", "=", r.id).where("state", "=", "new")
      .where((eb) => eb(kx.jsonText(db, "verification", "$.result"), "=", UNCHECKED_RESULT)));
    return { state: row.state as ScanState };
  });
}

// ---- reconcile --------------------------------------------------------------------------------------------------

/** The three sets `reconcileSecurity` acts on, in one wave. `o.now` is the clock in ms. */
export async function loadStaleWork(db: Db, o: { repo?: string; now: number } = { now: Date.now() }): Promise<StaleWork> {
  const q = queryDb(db);
  const grace = new Date(o.now - ORPHAN_GRACE_MS).toISOString();
  const [ended, jobless, findings] = await db.together(() => Promise.all([
    q.all(q.k.selectFrom("security_scans as s").select(["s.id", (eb) => jobStateOf(eb, "s.job_id").as("job_state")]).where("s.state", "in", ACTIVE_STATES)
      .where((eb) => jobEnded(eb, "s.job_id")).$if(!!o.repo, (b) => b.where("s.repo", "=", o.repo!)).orderBy("s.id")),
    q.all(q.k.selectFrom("security_scans as s").select("s.id").where("s.job_id", "is", null).where("s.started_at", "<", grace).where("s.state", "in", ACTIVE_STATES)
      .$if(!!o.repo, (b) => b.where("s.repo", "=", o.repo!)).orderBy("s.id")),
    q.all(q.k.selectFrom("security_findings as f").select(["f.repo", "f.number", "f.state"]).$narrowType<{ state: "fixing" | "landing" }>().where("f.updated_at", "<", grace)
      .$if(!!o.repo, (b) => b.where("f.repo", "=", o.repo!))
      .where((eb) => eb.or([eb("f.state", "=", "fixing"), eb.and([eb("f.state", "=", "landing"), eb("f.fix_pr", "is", null)])]))
      .where((eb) => eb.not(liveJobOfFinding(db, eb, ["security-fix", "security-land", "security-advisory"], "f.repo", "f.number")))
      .where((eb) => eb.not(eb.exists(eb.selectFrom("security_fix_rounds as r").select(eb.lit(1).as("one")).whereRef("r.repo", "=", "f.repo").whereRef("r.number", "=", "f.number").where("r.state", "=", "building"))))
      .where((eb) => eb.not(eb.and([eb("f.state", "=", "fixing"), eb("f.env_wait_at", "is not", null)]))).orderBy("f.repo").orderBy("f.number")),
  ]));
  return { endedJobScans: ended.map((r) => ({ id: r.id, cancelled: r.job_state === "cancelled" })), jobless: jobless.map((r) => r.id), findings };
}

/**
 * Closes what a dead job left: active scans whose job ended (stopped when it was cancelled, else failed), active scans never
 * queued, and `fixing` or `landing` findings with no job (their rounds are logged and cleared; `fixing` goes back to `new`,
 * `landing` to `ready`). Reads first (1 round trip) and writes in one `db.write` only when there is stale work.
 */
export async function reconcileSecurity(db: Db, o: { repo?: string } = {}): Promise<{ scans: number; findings: number }> {
  const stale = await loadStaleWork(db, { repo: o.repo, now: Date.now() });
  if (!stale.endedJobScans.length && !stale.jobless.length && !stale.findings.length) return { scans: 0, findings: 0 };
  return await db.write(async () => {
    const { ended } = await finishScans(db, [
      ...stale.jobless.map((id) => ({ id, state: "failed" as const, error: NEVER_QUEUED })),
      ...stale.endedJobScans.map((s) => s.cancelled ? { id: s.id, state: "stopped" as const, error: null } : { id: s.id, state: "failed" as const, error: JOB_ENDED }),
    ]);
    const fixing = stale.findings.filter((f) => f.state === "fixing");
    if (fixing.length) await clearRounds(db, fixing.map((f) => findingKey(f.repo, f.number)));
    const moves: FindingMove[] = stale.findings.map((f) => f.state === "fixing"
      ? { repo: f.repo, number: f.number, from: ["fixing"], to: "new", set: { note: JOB_ENDED_NOTE, last_failure: JOB_ENDED_NOTE } }
      : { repo: f.repo, number: f.number, from: ["landing"], to: "ready", set: { note: JOB_ENDED_NOTE } });
    const moved: Set<FindingKey> = await advanceFindings(db, moves);
    return { scans: ended.length, findings: moved.size };
  });
}
