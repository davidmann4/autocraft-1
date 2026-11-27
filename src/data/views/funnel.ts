// reads: mirror.items, planner.item_stage, triage.classifications, triage.item_settled, control.tracked_repos
// The Progress page's item numbers: the funnel per repo, what is done, open items per day and the closes of the last day.
import type { Expression, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { trackedRepo } from "../control/fragments.ts";
import { hiddenRepos } from "../control/fragments.ts";
import { settledJoin } from "../triage/fragments.ts";
import * as triage from "../triage/index.ts";
import type { HiddenRepos, Scope } from "./types.ts";

const DAY = 86_400_000;

/** `WITH latest AS (item_stage)`: the latest stage per item, to build a query on. */
export const latestCteExpr = (db: Db, repo?: string) =>
  queryDb(db).k.with("latest", (qc) => qc.selectFrom("main.item_stage").select(["repo", "number", "stage", "reviewed"]).$if(!!repo, (b) => b.where("repo", "=", repo!)));

/** The repo in `col` is a tracked repo. */
export const trackedExpr = (_db: Db, eb: kx.AnyEb, col: kx.Ex = "repo") => trackedRepo(eb, col);

export type FunnelRow = {
  repo: string; open: number; classified: number; second_opinion: number; disagreement: number; reviewed: number;
  take: number; hold: number; close: number; needs_decision: number; batched: number;
};
export type DoneRow = { repo: string; merged_pipeline: number; closed_pipeline: number; closed_others: number; total: number };

/** When tracking began; now when it was never set. */
export async function trackingStart(db: Db): Promise<string> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("main.settings").select("value").where("key", "=", "tracking_started_at"));
  return r?.value ?? new Date().toISOString();
}

/** "classified" counts settled type labels in the current classification run. */
export async function funnelByRepo(db: Db, repo?: string): Promise<FunnelRow[]> {
  const run = await triage.currentRunReady(db);
  const q = queryDb(db);
  const rows = await q.all(latestCteExpr(db, repo).selectFrom("items as i")
    .leftJoin("latest as l", (j) => j.onRef("l.repo", "=", "i.repo").onRef("l.number", "=", "i.number"))
    .leftJoin("item_settled as st", (j) => j.on((eb) => settledJoin(eb, run, "st")))
    .select((eb) => {
      const count = (cond: Expression<SqlBool>) => eb.fn.sum<number>(eb.case().when(cond).then(eb.lit(1)).else(eb.lit(0)).end());
      return [
        "i.repo", eb.fn.countAll<number>().as("open"),
        count(eb("st.status", "=", "settled")).as("classified"), count(eb("st.status", "=", "waiting")).as("second_opinion"), count(eb("st.status", "=", "disagree")).as("disagreement"),
        count(eb.or([
          eb(eb.fn.coalesce("l.reviewed", eb.lit(0)), "=", 1),
          eb.exists(eb.selectFrom("main.classifications as c").select(eb.lit(1).as("one")).whereRef("c.repo", "=", "i.repo").whereRef("c.number", "=", "i.number").where("c.classifier", "=", "sonnet")),
        ])).as("reviewed"),
        count(eb.or([eb("l.stage", "in", ["take", "verified"]), eb.and([kx.like(db, "l.stage", eb.val("verify-%")), eb("l.stage", "<>", "verify-failed")])])).as("take"),
        count(eb("l.stage", "=", "hold")).as("hold"), count(eb("l.stage", "=", "close")).as("close"),
        count(eb("l.stage", "=", "needs-decision")).as("needs_decision"), count(eb("l.stage", "=", "batched")).as("batched"),
      ];
    })
    .where("i.state", "=", "OPEN").$if(!!repo, (b) => b.where("i.repo", "=", repo!))
    .groupBy("i.repo"));
  return rows.map((r) => ({ ...r, open: Number(r.open), classified: Number(r.classified), second_opinion: Number(r.second_opinion), disagreement: Number(r.disagreement), reviewed: Number(r.reviewed),
    take: Number(r.take), hold: Number(r.hold), close: Number(r.close), needs_decision: Number(r.needs_decision), batched: Number(r.batched) }));
}

/** Done since `start`. Merged PRs carry closed_at too, so one range covers both. */
export async function doneByRepo(db: Db, start: string, repo?: string): Promise<DoneRow[]> {
  const q = queryDb(db);
  return (await q.all(latestCteExpr(db, repo)
    .with("d", (qb) => qb.selectFrom(kx.indexedBy(db, "main.items", "items_closed", "i")).leftJoin("latest as l", (j) => j.onRef("l.repo", "=", "i.repo").onRef("l.number", "=", "i.number"))
      .select(["i.repo", "i.state", "l.stage"])
      .where("i.closed_at", ">=", start).where("i.state", "<>", "OPEN").where((eb) => trackedRepo(eb, "i.repo"))
      .$if(!!repo, (b) => b.where("i.repo", "=", repo!)))
    .selectFrom("d")
    .select((eb) => {
      const count = (cond: Expression<SqlBool>) => eb.fn.sum<number>(eb.case().when(cond).then(eb.lit(1)).else(eb.lit(0)).end());
      return [
        "repo",
        count(eb.and([eb("state", "=", "MERGED"), eb("stage", "=", "merged")])).as("merged_pipeline"),
        count(eb.and([eb("state", "=", "CLOSED"), eb("stage", "in", ["closed", "fixed-by-us"])])).as("closed_pipeline"),
        eb.fn.countAll<number>().as("total"),
      ];
    })
    .groupBy("repo"))).map((x) => {
    const merged = Number(x.merged_pipeline), closed = Number(x.closed_pipeline), total = Number(x.total);
    return { repo: x.repo, merged_pipeline: merged, closed_pipeline: closed, total, closed_others: total - merged - closed };
  });
}

/** Items created and closed per repo and day since `start`, as the deltas the open-count trend is rebuilt from. */
async function dayDeltas(db: Db, start: string, repo?: string): Promise<{ created: { repo: string; d: string; n: number }[]; closed: { repo: string; d: string; n: number }[] }> {
  const q = queryDb(db);
  const day = (eb: kx.Eb, col: string) => eb.fn<string>("substr", [col, eb.lit(1), eb.lit(10)]);
  const [created, closed] = await db.together(() => Promise.all([
    q.all(q.k.selectFrom(kx.indexedBy(db, "main.items", "items_created", "i"))
      .select((eb) => ["repo", day(eb, "created_at").as("d"), eb.fn.countAll<number>().as("n")])
      .where("created_at", ">=", start).where((eb) => trackedRepo(eb, "repo")).$if(!!repo, (b) => b.where("repo", "=", repo!))
      .groupBy((eb) => ["repo", day(eb, "created_at")]).orderBy("repo").orderBy("d")),
    q.all(q.k.selectFrom(kx.indexedBy(db, "main.items", "items_closed", "i"))
      .select((eb) => ["repo", day(eb, "closed_at").as("d"), eb.fn.countAll<number>().as("n")])
      .where("closed_at", ">=", start).where("state", "<>", "OPEN").where((eb) => trackedRepo(eb, "repo")).$if(!!repo, (b) => b.where("repo", "=", repo!))
      .groupBy((eb) => ["repo", day(eb, "closed_at")]).orderBy("repo").orderBy("d")),
  ]));
  const num = (r: { repo: string; d: unknown; n: unknown }) => ({ repo: r.repo, d: String(r.d), n: Number(r.n) });
  return { created: created.map(num), closed: closed.map(num) };
}

/** Open items per repo per day since tracking began, rebuilt backwards from the current open count and the created and closed dates. */
export async function trend(db: Db, start: string, openNow: Map<string, number>, repo?: string): Promise<{ days: string[]; series: Map<string, number[]> }> {
  const today = new Date().toISOString().slice(0, 10);
  const days: string[] = [];
  for (let t = Date.parse(start.slice(0, 10)); ; t += DAY) {
    const d = new Date(t).toISOString().slice(0, 10);
    days.push(d);
    if (d >= today || days.length > 365) break;
  }
  const { created, closed } = await dayDeltas(db, start, repo);
  const delta = new Map<string, Map<string, number>>();
  const add = (r: string, d: string, n: number) => {
    if (!delta.has(r)) delta.set(r, new Map());
    const m = delta.get(r)!;
    m.set(d, (m.get(d) ?? 0) + n);
  };
  for (const x of created) add(x.repo, x.d, x.n);
  for (const x of closed) add(x.repo, x.d, -x.n);
  const series = new Map<string, number[]>();
  for (const name of new Set([...openNow.keys(), ...delta.keys()])) {
    const m = delta.get(name) ?? new Map<string, number>();
    const out = new Array<number>(days.length);
    let v = openNow.get(name) ?? 0;
    for (let k = days.length - 1; k >= 0; k--) {
      out[k] = v;
      v -= m.get(days[k]) ?? 0;
    }
    series.set(name, out);
  }
  return { days, series };
}

/** Items closed since `hourSince` with whether the pipeline closed them (stage merged, closed or fixed-by-us), for the hourly counts. */
export async function closedSince(db: Db, hourSince: string, hidden: HiddenRepos): Promise<{ closedAt: string; ours: boolean }[]> {
  const q = queryDb(db);
  const rows = await q.all(latestCteExpr(db).selectFrom("main.items as i")
    .leftJoin("latest as l", (j) => j.onRef("l.repo", "=", "i.repo").onRef("l.number", "=", "i.number"))
    .select((eb) => ["i.closed_at", eb("l.stage", "in", ["merged", "closed", "fixed-by-us"]).as("ours")])
    .where("i.closed_at", ">=", hourSince).where("i.state", "<>", "OPEN")
    .where((eb) => trackedRepo(eb, "i.repo")).where(hiddenRepos(db, "i.repo", hidden))
    .$narrowType<{ closed_at: string }>());
  return rows.map((r) => ({ closedAt: r.closed_at, ours: !!r.ours }));
}

export type FunnelFacts = {
  funnel: FunnelRow[]; done: DoneRow[]; trackingStart: string; closedRecent: { closedAt: string; ours: boolean }[];
  /** Created and closed per repo and day since `trackingStart`. */
  deltas: { created: { repo: string; d: string; n: number }[]; closed: { repo: string; d: string; n: number }[] };
};

/** Everything the Progress page reads of the items, in one wave; hidden repos are left out of every part. */
export async function loadFunnel(db: Db, scope: Pick<Scope, "hidden">, o: { hourSince: string }): Promise<FunnelFacts> {
  const start = await trackingStart(db);
  const keep = (r: { repo: string }) => !scope.hidden.visible ? !scope.hidden.includes(r.repo) : scope.hidden.visible.includes(r.repo);
  const [funnel, done, closedRecent, deltas] = await db.together(() => Promise.all([funnelByRepo(db), doneByRepo(db, start), closedSince(db, o.hourSince, scope.hidden), dayDeltas(db, start)]));
  return { funnel: funnel.filter(keep), done: done.filter(keep), trackingStart: start, closedRecent, deltas: { created: deltas.created.filter(keep), closed: deltas.closed.filter(keep) } };
}
