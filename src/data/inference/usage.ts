// Token usage (`token_usage`).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { filtered, repoShown, runVisible } from "./fragments.ts";
import type { HiddenRepos, JobUsage, RunVisibility, UsageModelRow, UsageReport, UsageRow } from "./types.ts";

const USAGE_COLS = ["stage", "model", "items", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "started_at", "ended_at", "cost_usd"] as const;
/** Sums come back as numeric text on Postgres. */
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const seconds = (a: string | null, b: string | null): number => (a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000)) : 0);

/** Upserts usage rows, expanding subagent rows (`u.extra`); 1 statement per 500 rows. The last row of an (run, agent) wins. */
export async function recordUsage(db: Db, rows: UsageRow[]): Promise<void> {
  if (rows.length === 0) return;
  const q = queryDb(db);
  const out = new Map<string, { run_id: string; agent: string; stage: string; model: string; items: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; started_at: string; ended_at: string; cost_usd: number | null }>();
  for (const { runId, agent, stage, model, items, u, start, end } of rows) {
    const row = (a: string, m: string, n: number, x: UsageRow["u"]) => ({ run_id: runId, agent: a, stage, model: m, items: n, input_tokens: x.input, output_tokens: x.output, cache_read_tokens: x.cacheRead, cache_write_tokens: x.cacheWrite, started_at: start, ended_at: end, cost_usd: x.cost });
    out.set(`${runId}\0${agent}`, row(agent, model, items, u));
    for (const e of u.extra ?? []) out.set(`${runId}\0${agent}+${e.model}`, row(`${agent}+${e.model}`, e.model, 0, e.usage));
  }
  await db.write(async () => {
    for (const part of kx.batches([...out.values()])) {
      await q.run(q.k.insertInto("main.token_usage").values(part).onConflict((oc) => oc.columns(["run_id", "agent"]).doUpdateSet(kx.excluded(USAGE_COLS))));
    }
  });
}

/**
 * Renames rows of an earlier pass (`agent || '@' || started_at`) so a later upsert does not overwrite their cost: 1 statement for any
 * number of agents (a JSON list, per 10,000).
 */
export async function keepEarlierUsage(db: Db, runId: string, agents: string[]): Promise<number> {
  if (agents.length === 0) return 0;
  const q = queryDb(db);
  let n = 0;
  for (const part of kx.chunks(agents)) {
    n += Number((await q.run(q.k.updateTable("main.token_usage")
      .set((eb) => ({ agent: eb(eb("agent", "||", eb.val("@")), "||", eb.fn.coalesce("started_at", eb.val(""))) }))
      .where("run_id", "=", runId).where(kx.inList(db, "agent", part)))).changes);
  }
  return n;
}

/** Calls, tokens and cost of the runs since `sinceIso`; null for no run ids. */
export async function loadJobUsage(db: Db, runIds: string[], sinceIso: string): Promise<JobUsage | null> {
  if (runIds.length === 0) return null;
  const q = queryDb(db);
  const r = (await q.get(q.k.selectFrom("main.token_usage").select((eb) => [
    eb.fn.countAll<number>().as("calls"), eb.fn.coalesce(eb.fn.sum<number>("input_tokens"), eb.val(0)).as("input"),
    eb.fn.coalesce(eb.fn.sum<number>("output_tokens"), eb.val(0)).as("output"), eb.fn.sum<number | null>("cost_usd").as("cost"),
  ]).where(kx.inList(db, "run_id", runIds)).where("started_at", ">=", sinceIso)))!;
  return { calls: num(r.calls), input: num(r.input), output: num(r.output), costUsd: numOrNull(r.cost) };
}

/** Cost since a UTC day (`YYYY-MM-DD`), calls without a repo included. */
export async function loadUsageSpend(db: Db, o: { fromDay: string; hidden: HiddenRepos }): Promise<number> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("main.token_usage").select((eb) => eb.fn.coalesce(eb.fn.sum<number>("cost_usd"), eb.lit(0)).as("s"))
    .where((eb) => eb(eb.fn<string>("substr", [eb.fn.coalesce("ended_at", "started_at"), eb.lit(1), eb.lit(10)]), ">=", o.fromDay))
    .$if(filtered(o.hidden), (b) => b.where((eb) => eb.or([eb("repo", "is", null), repoShown(eb, "repo", o.hidden)]))));
  return num(r?.s);
}

/**
 * Usage per model of one classify run. The wall and summed call times come from the rows in code, not from `julianday`, so it runs on both
 * engines; the run's rows are one per agent, so the read is bounded by the run.
 */
export async function loadUsageByModel(db: Db, runId: string): Promise<UsageModelRow[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.token_usage").select(["model", "items", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_usd", "started_at", "ended_at"])
    .where("run_id", "=", runId).orderBy("model", (o) => o.asc().nullsFirst()));
  const by = new Map<string, UsageModelRow>();
  for (const r of rows) {
    const key = r.model ?? "";
    const m = by.get(key) ?? by.set(key, { model: key, calls: 0, items: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null, wallSeconds: 0, busySeconds: 0, first: null, last: null }).get(key)!;
    m.calls++;
    m.items += num(r.items);
    m.input += num(r.input_tokens);
    m.output += num(r.output_tokens);
    m.cacheRead += num(r.cache_read_tokens);
    m.cacheWrite += num(r.cache_write_tokens);
    if (r.cost_usd !== null) m.costUsd = (m.costUsd ?? 0) + Number(r.cost_usd);
    if (r.started_at && (m.first === null || r.started_at < m.first)) m.first = r.started_at;
    if (r.ended_at && (m.last === null || r.ended_at > m.last)) m.last = r.ended_at;
    if (r.started_at && r.ended_at) m.busySeconds += (Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000;
  }
  return [...by.values()].map((m) => ({ ...m, wallSeconds: seconds(m.first, m.last) }));
}

/** The totals columns of a usage statement; `items` names the column that counts items. */
const totals = (eb: kx.Eb, items: "items" | "item_count") => [
  eb.fn.countAll<number>().as("calls"), eb.fn.coalesce(eb.fn.sum<number>(items), eb.lit(0)).as("items"),
  eb.fn.coalesce(eb.fn.sum<number>("input_tokens"), eb.lit(0)).as("input"), eb.fn.coalesce(eb.fn.sum<number>("output_tokens"), eb.lit(0)).as("output"),
  eb.fn.coalesce(eb.fn.sum<number>("cache_read_tokens"), eb.lit(0)).as("cacheRead"), eb.fn.coalesce(eb.fn.sum<number>("cache_write_tokens"), eb.lit(0)).as("cacheWrite"),
  eb.fn.sum<number | null>("cost_usd").as("usd"), eb.fn.min<string | null>("started_at").as("first"), eb.fn.max<string | null>("ended_at").as("last"),
];
type TotalsRow = { calls: unknown; items: unknown; input: unknown; output: unknown; cacheRead: unknown; cacheWrite: unknown; usd: unknown; first: string | null; last: string | null };
const toTotals = (r: TotalsRow) => ({ calls: num(r.calls), items: num(r.items), input: num(r.input), output: num(r.output), cacheRead: num(r.cacheRead), cacheWrite: num(r.cacheWrite), usd: numOrNull(r.usd), wallSeconds: seconds(r.first, r.last) });

/** Input, output and cache tokens of a call, null counted as 0. */
const tokensOf = (eb: kx.Eb) => eb.fn.coalesce(eb.fn.sum<number>(eb(eb(eb(eb.fn.coalesce("input_tokens", eb.lit(0)), "+", eb.fn.coalesce("output_tokens", eb.lit(0))), "+", eb.fn.coalesce("cache_read_tokens", eb.lit(0))), "+", eb.fn.coalesce("cache_write_tokens", eb.lit(0)))), eb.lit(0));

/**
 * The Cost page without `itemsClassified`, in one wave: total with span, run list, stages, repos, series per hour and per day (the
 * bucket size depends on the span, which is read in the same wave), and per user for staff. Calls without a repo stay in the totals.
 * The caller adds `triage.countVerdicts` in the same `together`.
 */
export async function loadUsageReport(db: Db, f: { run?: string; vis: RunVisibility }): Promise<UsageReport> {
  const q = queryDb(db);
  const { k } = q;
  const run = f.run ?? "";
  const hidden = f.vis.hidden;
  const at = (eb: kx.Eb) => eb.fn.coalesce("ended_at", "started_at");
  const usage = () => k.selectFrom("main.token_usage").where((eb) => eb.and([
    ...(run ? [eb("run_id", "=", run)] : []), ...(filtered(hidden) ? [eb.or([eb("repo", "is", null), repoShown(eb, "repo", hidden)])] : []),
  ]));
  const lastAt = (eb: kx.Eb) => eb.fn.max(at(eb));
  const series = (len: number) => usage().select((eb) => [eb.fn<string>("substr", [at(eb), eb.lit(1), eb.lit(len)]).as("bucket"), tokensOf(eb).as("tokens"), eb.fn.sum<number | null>("cost_usd").as("usd")])
    .where((eb) => eb(at(eb), "is not", null)).groupBy("bucket").orderBy("bucket");
  const [total, runs, stages, repos, users, hourly, daily] = await db.together(() => Promise.all([
    q.get(usage().select((eb) => [...totals(eb, "items"), eb.fn.min<string | null>(at(eb)).as("a"), eb.fn.max<string | null>(at(eb)).as("b")])),
    q.all(k.selectFrom("main.token_usage").select(["run_id as id", (eb) => eb.fn.min<string>("started_at").as("from"), (eb) => lastAt(eb).as("to")])
      .$narrowType<{ from: string; to: string }>().$if(filtered(hidden), (b) => b.where((eb) => eb.or([eb("repo", "is", null), repoShown(eb, "repo", hidden)])))
      .groupBy("run_id").orderBy(lastAt, (o) => o.desc().nullsLast()).orderBy("run_id")),
    q.all(usage().select((eb) => [eb.fn.coalesce("stage", eb.val("")).as("stage"), eb.fn.coalesce("model", eb.val("")).as("model"), ...totals(eb, "items")]).groupBy(["stage", "model"]).orderBy("stage").orderBy("model")),
    q.all(usage().select((eb) => ["repo", ...totals(eb, "items")]).where("repo", "is not", null).groupBy("repo").orderBy(tokensOf, "desc").orderBy("repo")),
    !f.vis.staff ? Promise.resolve([]) : q.all(k.selectFrom("main.agent_runs as r").select((eb) => ["user_login as login", ...totals(eb, "item_count")])
      .where("provider", "=", "claude")
      .$if(filtered(hidden), (b) => b.where((eb) => runVisible(f.vis, eb, "r")))
      .$if(!!run, (b) => b.where((eb) => eb.between("started_at",
        eb.selectFrom("main.token_usage").select(eb.fn.min<string>("started_at").as("lo")).where("run_id", "=", run),
        eb.selectFrom("main.token_usage").select(eb.fn.max<string>(eb.fn.coalesce("ended_at", "started_at")).as("hi")).where("run_id", "=", run))))
      .groupBy("user_login").orderBy((eb) => eb.case().when("user_login", "is", null).then(eb.lit(1)).else(eb.lit(0)).end())
      .orderBy((eb) => eb.fn.coalesce(eb.fn.sum<number>("cost_usd"), eb.lit(0)), "desc").orderBy("user_login")),
    q.all(series(13)),
    q.all(series(10)),
  ]));
  const hours = total?.a && total?.b ? (Date.parse(total.b) - Date.parse(total.a)) / 3600_000 : 0;
  const bucketSize = hours > 72 ? "day" : "hour";
  return {
    runs: runs.map((r) => ({ id: r.id, from: r.from, to: r.to })),
    run,
    total: toTotals(total as TotalsRow),
    stages: (stages as (TotalsRow & { stage: string; model: string })[]).map((r) => ({ stage: r.stage, model: r.model, ...toTotals(r) })),
    repos: (repos as (TotalsRow & { repo: string })[]).map((r) => ({ repo: r.repo, ...toTotals(r) })),
    users: (users as (TotalsRow & { login: string | null })[]).map((r) => ({ login: r.login, ...toTotals(r) })),
    series: (bucketSize === "day" ? daily : hourly).map((r) => ({ bucket: r.bucket, tokens: num(r.tokens), usd: numOrNull(r.usd) })),
    bucketSize,
  };
}
