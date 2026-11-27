// CI run approvals (`ci_run_approvals`) (package merge-b).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { loadStepApprovals } from "../control/index.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import { headOf, refOf } from "./read.ts";
import { splitHead } from "./settle.ts";
import type { HeadRef, RunApproval, RunResult, RunsInput, WaitingRun } from "./types.ts";

/** How long approved runs may stay unfinished before the PR is trusted to CI's own state again. */
const APPROVED_TTL_MS = 2 * 3_600_000;

const parse = <T>(text: string | null | undefined, fallback: T): T => {
  try { return text ? (JSON.parse(text) as T) : fallback; } catch { return fallback; }
};

/** Waiting and approved runs of the items in `keys`, per head. 1 statement. */
export async function loadRunApprovals(db: Db, keys: KeySource): Promise<Map<HeadRef, RunApproval>> {
  const q = queryDb(db);
  const rows = await q.all((q.k as any).selectFrom("ci_run_approvals as a")
    .innerJoin(resolveKeys(db, keys, "kk"), (j: any) => j.onRef("kk.repo", "=", "a.repo").onRef("kk.number", "=", "a.number"))
    .select(["a.repo", "a.number", "a.head_oid", "a.runs", "a.approved", "a.reread", "a.failed", "a.cross_repo", "a.checked_at", "a.approved_at"])) as
    { repo: string; number: number; head_oid: string; runs: string; approved: string; reread: number; failed: string; cross_repo: number; checked_at: string; approved_at: string | null }[];
  return new Map(rows.map((r) => [headOf(r.repo, r.number, r.head_oid), {
    head: r.head_oid, runs: parse<WaitingRun[]>(r.runs, []), approved: parse<number[]>(r.approved, []), reread: !!r.reread, failed: parse<Record<string, number>>(r.failed, {}),
    crossRepo: !!r.cross_repo, checkedAt: r.checked_at, approvedAt: r.approved_at,
  } satisfies RunApproval]));
}

/**
 * Records the workflow runs waiting for approval at each open PR's head, from the check suites the sync read. The previous rows are read
 * and rewritten in one `db.write` because `approved` and `reread` carry over from them; the repos' CI-approval switches are read before it.
 */
export async function recordRuns(db: Db, rows: RunsInput[], at: string): Promise<void> {
  const open = new Map<string, RunsInput>();
  for (const c of rows) if (c.state === "OPEN") open.set(refOf(c.repo, c.number), c);
  if (open.size === 0) return;
  const list = [...open.values()];
  const switches = await loadStepApprovals(db, [...new Set(list.map((c) => c.repo))], ["ci"]);
  const q = queryDb(db);
  await db.write(async () => {
    const prevs = new Map<string, { repo: string; number: number; head_oid: string; approved: string; reread: number; failed: string; approved_at: string | null }>();
    for (const chunk of kx.chunks(list))
      for (const p of await q.all(q.k.selectFrom("ci_run_approvals").select(["repo", "number", "head_oid", "approved", "reread", "failed", "approved_at"])
        .where(kx.refIn(db, "ci_run_approvals", chunk.map((c): [string, number] => [c.repo, c.number])))))
        prevs.set(refOf(p.repo, p.number), p);
    const puts: { repo: string; number: number; head_oid: string; cross_repo: number; runs: string; approved: string; reread: number; failed: string; checked_at: string; approved_at: string | null }[] = [];
    for (const c of list) {
      const prev = prevs.get(refOf(c.repo, c.number));
      const suites = c.suites ?? [];
      const same = prev?.head_oid === c.head_oid ? prev : undefined;
      const approved = parse<number[]>(same?.approved, []);
      const byId = new Map(suites.map((x) => [x.id, x]));
      const fresh = !!same?.approved_at && Date.now() - Date.parse(same.approved_at) < APPROVED_TTL_MS;
      // An approved run is settled once its suite completed with something other than the old action_required.
      const left = approved.filter((id) => fresh && !(byId.get(id)?.status === "COMPLETED" && byId.get(id)?.conclusion !== "ACTION_REQUIRED"));
      const waiting: WaitingRun[] = suites.filter((x) => x.conclusion === "ACTION_REQUIRED" && !approved.includes(x.id)).map((x) => ({ id: x.id, name: x.name, event: x.event }));
      if (!prev && !waiting.length) continue;
      // With the approval off nothing clears a mark the suites do not confirm, so the sync does.
      const reread = same?.reread && (suites.some((x) => x.conclusion === "ACTION_REQUIRED") || !!switches.get(c.repo)?.ci) ? 1 : 0;
      puts.push({ repo: c.repo, number: c.number, head_oid: c.head_oid, cross_repo: c.cross_repo ? 1 : 0, runs: JSON.stringify(waiting), approved: JSON.stringify(left), reread, failed: same?.failed ?? "{}", checked_at: at, approved_at: same?.approved_at ?? null });
    }
    for (const values of kx.batches(puts))
      await q.run(q.k.insertInto("ci_run_approvals").values(values)
        .onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet(kx.excluded(["head_oid", "cross_repo", "runs", "approved", "reread", "failed", "checked_at", "approved_at"]))));
  });
}

/** Marks PRs for a read of their workflow runs: deletes rows of other heads and upserts the `reread` mark at the given head. */
export async function markRereads(db: Db, rows: { repo: string; number: number; head: string }[], at: string): Promise<void> {
  if (rows.length === 0) return;
  const q = queryDb(db);
  const last = new Map(rows.map((r) => [refOf(r.repo, r.number), r]));
  const list = [...last.values()];
  await db.write(async () => {
    await q.run(q.k.deleteFrom("ci_run_approvals").where(kx.refIn(db, "ci_run_approvals", list.map((r): [string, number] => [r.repo, r.number])))
      .where((eb) => eb.not(kx.tupleIn(db, [eb.ref("repo"), eb.ref("number"), eb.ref("head_oid")], list.map((r) => [r.repo, r.number, r.head], ), ["text", "bigint", "text"]))));
    for (const values of kx.batches(list.map((r) => ({ repo: r.repo, number: r.number, head_oid: r.head, cross_repo: 1, runs: "[]", approved: "[]", reread: 1, failed: "{}", checked_at: at }))))
      await q.run(q.k.insertInto("ci_run_approvals").values(values).onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet((eb) => ({ reread: 1, checked_at: eb.ref("excluded.checked_at") }))));
  });
}

/**
 * Stores approval results: reads the current `approved` lists of the heads, merges the new ids in, and updates the rows, in one
 * `db.write`. `approvedNow` stamps `approved_at`; the `reread` mark is cleared.
 */
export async function saveRunResults(db: Db, rows: RunResult[]): Promise<void> {
  if (rows.length === 0) return;
  const q = queryDb(db);
  const k = q.k as any;
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const list = [...byKey.values()].map((r) => ({ r, ...splitHead(r.key) }));
  await db.write(async () => {
    const prev = new Map<HeadRef, number[]>();
    for (const chunk of kx.chunks(list))
      for (const p of await q.all(q.k.selectFrom("ci_run_approvals").select(["repo", "number", "head_oid", "approved"])
        .where((eb) => kx.tupleIn(db, [eb.ref("repo"), eb.ref("number"), eb.ref("head_oid")], chunk.map((c) => [c.repo, c.number, c.head]), ["text", "bigint", "text"]))))
        prev.set(headOf(p.repo, p.number, p.head_oid), parse<number[]>(p.approved, []));
    const at = new Date().toISOString();
    for (const chunk of kx.chunks(list)) {
      const v = kx.valuesTable(db, chunk.map(({ r, repo, number, head }) => ({
        repo, number, head, runs: JSON.stringify(r.runs), approved: JSON.stringify([...new Set([...(prev.get(r.key) ?? []), ...r.approved])]),
        failed: JSON.stringify(r.failed), stamp: r.approvedNow ? at : null,
      })), { repo: "text", number: "bigint", head: "text", runs: "text", approved: "text", failed: "text", stamp: "text" }, "v");
      await q.run(k.updateTable("ci_run_approvals").from(v)
        .set((eb: any) => ({ runs: eb.ref("v.runs"), approved: eb.ref("v.approved"), reread: 0, failed: eb.ref("v.failed"), approved_at: eb.fn.coalesce(eb.ref("v.stamp"), eb.ref("ci_run_approvals.approved_at")) }))
        .where((eb: any) => eb.and([eb("ci_run_approvals.repo", "=", eb.ref("v.repo")), eb("ci_run_approvals.number", "=", eb.ref("v.number")), eb("ci_run_approvals.head_oid", "=", eb.ref("v.head"))])));
    }
  });
}
