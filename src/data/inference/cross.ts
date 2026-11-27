// reads: jobs.jobs
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { RUN_SLOT_MS, type RunningCounts } from "./types.ts";

/**
 * Running Claude calls by job repo and by step, for the Task Runner claim order. One statement (`UNION ALL` of the two groupings); reads
 * `jobs.repo`, which is why the join is declared here: the claim reads the counts with its candidates and must see the same jobs.
 * Only calls started within `RUN_SLOT_MS` count, and a call with no job has no repo.
 */
export async function loadRunningCounts(db: Db, nowMs: number): Promise<RunningCounts> {
  const q = queryDb(db);
  const since = new Date(nowMs - RUN_SLOT_MS).toISOString();
  const running = () => q.k.selectFrom("main.agent_runs as r").where("r.state", "=", "running").where("r.provider", "=", "claude").where("r.started_at", ">=", since);
  const byRepo = running().leftJoin("main.jobs as j", "j.id", "r.job_id").select((eb) => [kx.literal("repo").as("kind"), "j.repo as k", eb.fn.countAll<number>().as("n")])
    .where("j.repo", "is not", null).groupBy("j.repo");
  const byStep = running().select((eb) => [kx.literal("step").as("kind"), "r.step as k", eb.fn.countAll<number>().as("n")]).groupBy("r.step");
  const out: RunningCounts = { repoN: new Map(), stepN: new Map() };
  for (const r of await q.all((byRepo as any).unionAll(byStep) as typeof byRepo)) (r.kind === "repo" ? out.repoN : out.stepN).set(String(r.k), Number(r.n));
  return out;
}
