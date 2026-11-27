// reads: jobs.jobs
// What is wrong with the instance: the health checks' inputs, what the pipeline stopped and the jobs that failed lately.
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import { hiddenRepos } from "../control/fragments.ts";
import type { StageDefaults } from "../control/types.ts";
import { loadHealthFacts, type HealthOptions } from "./health.ts";
import { loadStopped } from "./stopped.ts";
import type { AttentionFacts, Scope } from "./types.ts";

/** Jobs that failed in the last hour, per step and repo. */
export async function loadFailedJobs(db: Db, scope: Pick<Scope, "hidden">, nowMs: number): Promise<AttentionFacts["failedJobs"]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("jobs").select((eb) => ["step", "repo", eb.fn.countAll<number>().as("n")]).where("state", "=", "failed")
    .where("ended_at", ">", new Date(nowMs - 3_600_000).toISOString()).where((eb) => eb.or([eb("repo", "is", null), hiddenRepos(db, "repo", scope.hidden)])).groupBy(["step", "repo"]));
  return rows.map((r) => ({ step: r.step, repo: r.repo, n: Number(r.n) }));
}

export async function loadAttention(db: Db, scope: Pick<Scope, "hidden">, o: { nowMs: number; health: HealthOptions; limits: { steps: readonly string[]; defaults: StageDefaults } }): Promise<Pick<AttentionFacts, "health" | "stops" | "failedJobs">> {
  // The health read opens its own wave, so it runs beside this one.
  const [health, [stops, failedJobs]] = await Promise.all([
    loadHealthFacts(db, o.nowMs, o.health),
    db.together(() => Promise.all([loadStopped(db, scope, o.limits), loadFailedJobs(db, scope, o.nowMs)])),
  ]);
  return { health, stops, failedJobs };
}
