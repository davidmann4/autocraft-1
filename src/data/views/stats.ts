// reads: mirror.items, planner.item_stage, review.opus_reviews
// The numbers of the Stats page.
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { hiddenRepos } from "../control/fragments.ts";
import * as inference from "../inference/index.ts";
import * as mirror from "../mirror/index.ts";
import type { Scope, StatsFacts } from "./types.ts";

const DAY = 86_400_000;
const FAR = "9999-12-31";

/** Items closed in the last `days` UTC days (today included) by day, state, plan stage and kind, plus items created, the open backlog, items reviewed and spend. */
export async function loadMaintainStats(db: Db, scope: Pick<Scope, "repos" | "hidden">, o: { days: number; today: string }): Promise<StatsFacts> {
  const from = new Date(Date.parse(o.today) - (o.days - 1) * DAY).toISOString().slice(0, 10);
  const q = queryDb(db);
  const day = (eb: kx.Eb, col: string) => eb.fn<string>("substr", [col, eb.lit(1), eb.lit(10)]);
  const repos = scope.repos;
  const [closed, created, backlog, reviewed, spend] = await db.together(() => Promise.all([
    repos.length ? q.all(q.k.selectFrom("main.items as i").leftJoin("main.item_stage as l", (j) => j.onRef("l.repo", "=", "i.repo").onRef("l.number", "=", "i.number"))
      .select((eb) => [day(eb, "i.closed_at").as("day"), "i.state", "l.stage", "i.kind", eb.fn.countAll<number>().as("n")])
      .where("i.closed_at", ">=", from).where("i.state", "<>", "OPEN").where(kx.inList(db, "i.repo", repos))
      .groupBy((eb) => [day(eb, "i.closed_at"), "i.state", "l.stage", "i.kind"])) : Promise.resolve([]),
    mirror.countItems(db, { repos, createdBetween: [from, FAR] }),
    mirror.countItems(db, { repos, states: ["OPEN"] }),
    q.get(q.k.selectFrom((eb) => eb.selectFrom("main.opus_reviews as o").select(["o.repo", "o.number"]).distinct()
      .where("o.at", ">=", from).where(hiddenRepos(db, "o.repo", scope.hidden)).as("m")).select((eb) => eb.fn.countAll<number>().as("n"))),
    inference.loadUsageSpend(db, { fromDay: from, hidden: scope.hidden }),
  ]));
  return {
    closed: closed.map((r) => ({ day: String(r.day), state: r.state, stage: r.stage ?? null, kind: r.kind, n: Number(r.n) })),
    created: created.get("") ?? 0, backlog: backlog.get("") ?? 0, reviewed: Number(reviewed?.n ?? 0), spendUsd: spend,
  };
}
