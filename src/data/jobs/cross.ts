// reads: control.stage_limits
// loadLaneInputs joins the stage limits' reset times into the daily item counts. Everything else goes through loaders, fragments and `together`.
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";

/** Items of jobs started since `max(day, the step's reset)`, per step; `day` is the UTC day start. */
export function itemsStartedSince(db: Db, day: string) {
  const k = queryDb(db).k;
  return k.selectFrom("main.jobs as j").leftJoin("main.stage_limits as sl", "sl.step", "j.step")
    .select((e) => ["j.step", e.fn.coalesce(e.fn.sum<number>("j.items"), e.lit(0)).as("n")])
    .where("j.started_at", ">=", day)
    .where((e) => e("j.started_at", ">=", e.case().when(e.and([e("sl.reset_at", "is not", null), e("sl.reset_at", ">", day)])).then(e.ref("sl.reset_at")).else(e.val(day)).end()))
    .groupBy("j.step");
}

/** The daily-limit reset time per step. */
export const limitResets = (db: Db) => queryDb(db).k.selectFrom("main.stage_limits as sr").select(["sr.step", "sr.reset_at"]).where("sr.reset_at", "is not", null);
