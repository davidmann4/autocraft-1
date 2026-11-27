// Work leases (M07 jobs).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { nowIso } from "./sql.ts";

/**
 * One statement; returns the keys taken (free, held by the same job, or held by a job that is not running). The takes
 * of one call are atomic with each other and with every other statement on the table.
 */
export async function takeLeases(db: Db, keys: string[], job: { id: number; step: string }): Promise<Set<string>> {
  const unique = [...new Set(keys)];
  if (!unique.length) return new Set();
  const q = queryDb(db);
  const at = nowIso();
  const v = kx.valuesTable(db, unique.map((key) => ({ key })), { key: "text" }, "v");
  const rows = await q.all(q.k.insertInto("work_leases").columns(["key", "job_id", "step", "taken_at"])
    .expression((eb) => eb.selectFrom(v).select(["v.key", eb.cast<number>(eb.val(job.id), "integer").as("job_id"), eb.val(job.step).as("step"), eb.val(at).as("taken_at")]).where(eb.lit(true)))
    .onConflict((oc) => oc.column("key").doUpdateSet(kx.excluded(["job_id", "step", "taken_at"]))
      .where((eb) => eb.or([eb("work_leases.job_id", "=", eb.ref("excluded.job_id")),
        eb.not(eb.exists(eb.selectFrom("jobs as lj").select(eb.lit(1).as("one")).whereRef("lj.id", "=", "work_leases.job_id").where("lj.state", "=", "running")))])))
    .returning("key"));
  return new Set(rows.map((r) => r.key));
}

/** Releases leases: the keys one job holds, or every lease of the jobs. */
export async function releaseLeases(db: Db, o: { keys: string[]; jobId: number } | { jobIds: number[] }): Promise<number> {
  const q = queryDb(db);
  if ("keys" in o) {
    if (!o.keys.length) return 0;
    return (await q.run(q.k.deleteFrom("work_leases").where("job_id", "=", o.jobId).where(kx.inList(db, "key", o.keys)))).changes;
  }
  if (!o.jobIds.length) return 0;
  return (await q.run(q.k.deleteFrom("work_leases").where(kx.inList(db, "job_id", o.jobIds, "bigint")))).changes;
}

/** `recover` clears every lease. */
export async function clearLeases(db: Db): Promise<number> {
  const q = queryDb(db);
  return (await q.run(q.k.deleteFrom("work_leases"))).changes;
}

/** Keys held by running jobs. */
export async function loadHeldLeaseKeys(db: Db): Promise<Set<string>> {
  const q = queryDb(db);
  return new Set((await q.all(q.k.selectFrom("work_leases as l").innerJoin("jobs as j", "j.id", "l.job_id").select("l.key").where("j.state", "=", "running"))).map((r) => r.key));
}
