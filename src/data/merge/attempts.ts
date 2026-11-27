// Merge attempts (`merges`) (package merge-a).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import { addAudit } from "../control/index.ts";
import type { NewAudit } from "../control/types.ts";
import { applyLocal } from "../mirror/index.ts";
import { addStageEvents } from "../planner/index.ts";
import { mergedInfoOf, refOf, short } from "./read.ts";
import type { AttemptInput, MergeRow, MergedInfo, RefKey } from "./types.ts";

/** The merged half of `loadMergeFacts` for callers outside the planner. 1 statement. */
export async function loadMergedInfo(db: Db, keys: KeySource): Promise<Map<RefKey, MergedInfo>> {
  return await mergedInfoOf(db, keys);
}

/** Attempt rows with `rowid`, newest first, for the activity feed, trace and item browser. 1 statement. */
export async function listMerges(db: Db, f: { refs?: KeySource; repo?: string; since?: string; outcome?: "merged" | "refused"; after?: number; limit?: number }): Promise<MergeRow[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("merges as m")
    .$if(!!f.refs, (s) => s.innerJoin(resolveKeys(db, f.refs!, "kk"), (j) => j.onRef("kk.repo", "=", "m.repo").onRef("kk.number", "=", "m.number")))
    .select(["m.repo", "m.number", "m.head_oid", "m.run_id", "m.at", "m.path", "m.method", "m.outcome", "m.reason", "m.ci", "m.mergeable", kx.rowid("merges", "m").as("rowid")])
    .$if(!!f.repo, (s) => s.where("m.repo", "=", f.repo!))
    .$if(!!f.since, (s) => s.where("m.at", ">=", f.since!))
    .$if(!!f.outcome, (s) => s.where("m.outcome", "=", f.outcome!))
    .$if(f.after !== undefined, (s) => s.where(kx.rowid("merges", "m"), "<", f.after!))
    .orderBy("m.at", "desc").orderBy(kx.rowid("merges", "m"), "desc")
    .$if(f.limit !== undefined, (s) => s.limit(f.limit!)));
  return rows.map((r) => ({ rowid: Number(r.rowid), repo: r.repo, number: r.number, head: r.head_oid, runId: r.run_id, at: r.at, path: r.path, method: r.method, outcome: r.outcome, reason: r.reason, ci: r.ci, mergeable: r.mergeable }));
}

/** Distinct merged refs and the number of attempts since `f.since`, in one grouped statement. */
export async function countMerges(db: Db, f: { since: string; repos?: string[] }): Promise<{ mergedRefs: RefKey[]; tries: number }> {
  if (f.repos && f.repos.length === 0) return { mergedRefs: [], tries: 0 };
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("merges as m").where("m.at", ">=", f.since)
    .$if(!!f.repos, (s) => s.where(kx.inList(db, "m.repo", f.repos!)))
    .select((eb) => ["m.repo", "m.number", eb.fn.countAll<number>().as("tries"), eb.fn.sum<number>(eb.case().when("m.outcome", "=", "merged").then(1).else(0).end()).as("merged")])
    .groupBy(["m.repo", "m.number"]));
  return { mergedRefs: rows.filter((r) => Number(r.merged) > 0).map((r) => refOf(r.repo, r.number)), tries: rows.reduce((a, r) => a + Number(r.tries), 0) };
}

/**
 * Records attempts in one `db.write`: one multi-row insert into `merges`; for merged rows the mirror write-through, the `merged`
 * stage event and the audit row; for refused rows whose reason is `action_required`, the reread mark. At most 6 statements.
 */
export async function recordAttempts(db: Db, rows: AttemptInput[]): Promise<void> {
  if (rows.length === 0) return;
  const q = queryDb(db);
  await db.write(async () => {
    for (const values of kx.batches(rows.map((r) => ({ repo: r.repo, number: r.number, head_oid: r.head, run_id: r.runId, at: r.at, path: r.path, method: r.method, outcome: r.outcome, reason: r.reason, ci: r.ci, mergeable: r.mergeable }))))
      await q.run(q.k.insertInto("merges").values(values));
    const merged = rows.filter((r) => r.outcome === "merged");
    if (merged.length) {
      await applyLocal(db, merged.map((r) => ({ kind: "merged" as const, repo: r.repo, number: r.number, at: r.at })));
      await addStageEvents(db, merged.map((r) => ({
        repo: r.repo, number: r.number, stage: "merged", at: r.at, actor: r.batch ? "batch" : "merge",
        note: r.note ?? (r.batch ? `merge in ${r.batch} at ${short(r.head)}` : `${r.method ?? "merge"} at ${short(r.head)}`),
      })));
    }
    const audits = rows.flatMap((r): NewAudit[] => r.outcome === "refused"
      ? [{ login: r.batch ? "batch" : "merge", action: "merge-refused", target: refOf(r.repo, r.number), at: r.at, details: { run: r.runId, head: r.head, path: r.path, method: r.method, reason: r.reason } }]
      : r.batch ? [{ login: "batch", action: "merge", target: refOf(r.repo, r.number), at: r.at, details: { run: r.runId, head: r.head, method: r.method, batch: r.batch } }] : []);
    if (audits.length) await addAudit(db, audits);
    // The last refusal per PR marks its head for a read of its workflow runs.
    const rereads = new Map<string, AttemptInput>();
    for (const r of rows) if (r.outcome === "refused" && (r.markReread ?? /action_required/.test(r.reason ?? ""))) rereads.set(refOf(r.repo, r.number), r);
    if (rereads.size) {
      const list = [...rereads.values()];
      await q.run(q.k.deleteFrom("ci_run_approvals").where(kx.refIn(db, "ci_run_approvals", list.map((r): [string, number] => [r.repo, r.number])))
        .where((eb) => eb.not(kx.tupleIn(db, [eb.ref("repo"), eb.ref("number"), eb.ref("head_oid")], list.map((r) => [r.repo, r.number, r.head]), ["text", "bigint", "text"]))));
      for (const values of kx.batches(list.map((r) => ({ repo: r.repo, number: r.number, head_oid: r.head, cross_repo: 1, runs: "[]", approved: "[]", reread: 1, failed: "{}", checked_at: r.at }))))
        await q.run(q.k.insertInto("ci_run_approvals").values(values).onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet((eb) => ({ reread: 1, checked_at: eb.ref("excluded.checked_at") }))));
    }
  });
}
