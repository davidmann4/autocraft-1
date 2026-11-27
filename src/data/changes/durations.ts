// Check run times, for the check time limits.
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { taskDoneMsExpr } from "../build/fragments.ts";
import { rowsOf } from "./rows.ts";
import type { CheckShape } from "./types.ts";

/**
 * The run times in ms of the repo's last `limit` successful checks of `shape`, newest check first. The task's run time comes from the
 * build fragment `taskDoneMsExpr`, which is null unless the task ended `done`; that filter applies before the limit, so it cannot be two
 * loads. Run time counts from when a worker took the task. A successful `check` or `test` is outcome `exit 0`; `fmt` and `clippy` count whenever they gave a result.
 */
export async function loadCheckDurations(db: Db, repo: string, shape: CheckShape, limit: number): Promise<number[]> {
  const k = queryDb(db).k as any;
  const rows = await rowsOf<{ ms: number | string }>(db, k.selectFrom("main.model_checks as m")
    .select((eb: any) => taskDoneMsExpr(eb, "m.task_id").as("ms"))
    .where("m.repo", "=", repo).where("m.command", "=", shape.command)
    .where("m.crate", shape.crate === undefined ? "is" : "is not", null)
    .where("m.test_name", shape.testName === undefined ? "is" : "is not", null)
    .where((eb: any) => shape.command === "check" || shape.command === "test" ? eb("m.outcome", "=", "exit 0") : eb.and([
      eb.not(kx.like(db, "m.outcome", eb.val("failed%"))), eb.not(kx.like(db, "m.outcome", eb.val("refused%"))),
      eb.not(kx.like(db, "m.outcome", eb.val("cancelled%"))), eb.not(kx.like(db, "m.outcome", eb.val("stopped%"))),
      eb("m.outcome", "<>", "out of time"),
    ]))
    .where((eb: any) => eb(taskDoneMsExpr(eb, "m.task_id"), "is not", null))
    .orderBy("m.id", "desc").limit(limit));
  return rows.map((r) => Number(r.ms));
}
