// Pass statistics and shadow-check differences (`plan_pass_hours`, `plan_shadow_diffs`). `plan_pass_stats` stays as it was, for
// pods of the previous release.
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { SHADOW_ROWS, type PassCount, type PassReport, type PassStat, type ShadowDiff } from "./types.ts";

/** Hourly rows older than this are deleted by `recordPass`. */
const HOURS_KEPT_MS = 14 * 86_400_000;
const DETAIL_MAX = 2000;

/**
 * One multi-row upsert of the counts into `plan_pass_hours` (counts of the same kind and hour are summed first, which a
 * multi-row upsert needs; durations are rounded, since Postgres refuses a fraction in an integer column), one insert of the diffs, then the trim of `plan_shadow_diffs` and of old hourly rows. Joins the pass's
 * transaction. The stats of the pass's own write are not in its counts.
 */
export async function recordPass(db: Db, counts: PassCount[], diffs: ShadowDiff[]): Promise<void> {
  if (!counts.length && !diffs.length) return;
  const q = queryDb(db);
  const { k } = q;
  const merged = new Map<string, PassCount>();
  for (const c of counts) {
    const key = `${c.kind}\u0000${c.hour}`;
    const o = merged.get(key);
    merged.set(key, o ? {
      ...o, passes: o.passes + c.passes, refs: o.refs + c.refs, at: c.at > o.at ? c.at : o.at, ms: o.ms + c.ms, maxMs: Math.max(o.maxMs, c.maxMs),
      dbStatements: o.dbStatements + c.dbStatements, dbRoundTrips: o.dbRoundTrips + c.dbRoundTrips, dbMs: o.dbMs + c.dbMs,
    } : c);
  }
  await db.write(async () => {
    for (const part of kx.batches([...merged.values()])) {
      await q.run(k.insertInto("main.plan_pass_hours")
        .values(part.map((c) => ({ kind: c.kind, hour: c.hour, passes: c.passes, refs: c.refs, last_at: c.at, ms: c.ms, max_ms: c.maxMs, db_statements: c.dbStatements, db_round_trips: c.dbRoundTrips, db_ms: Math.round(c.dbMs) })))
        .onConflict((oc) => oc.columns(["kind", "hour"]).doUpdateSet((eb) => ({
          passes: eb("main.plan_pass_hours.passes", "+", eb.ref("excluded.passes")), refs: eb("main.plan_pass_hours.refs", "+", eb.ref("excluded.refs")), last_at: eb.ref("excluded.last_at"),
          ms: eb("main.plan_pass_hours.ms", "+", eb.ref("excluded.ms")),
          max_ms: eb.case().when("excluded.max_ms", ">", eb.ref("main.plan_pass_hours.max_ms")).then(eb.ref("excluded.max_ms")).else(eb.ref("main.plan_pass_hours.max_ms")).end(),
          db_statements: eb("main.plan_pass_hours.db_statements", "+", eb.ref("excluded.db_statements")), db_round_trips: eb("main.plan_pass_hours.db_round_trips", "+", eb.ref("excluded.db_round_trips")),
          db_ms: eb("main.plan_pass_hours.db_ms", "+", eb.ref("excluded.db_ms")),
        }))));
    }
    if (counts.length) {
      const newest = counts.reduce((a, c) => (c.at > a ? c.at : a), "");
      await q.run(k.deleteFrom("main.plan_pass_hours").where("last_at", "<", new Date(Date.parse(newest) - HOURS_KEPT_MS).toISOString()));
    }
    if (diffs.length) {
      for (const part of kx.batches(diffs)) {
        await q.run(k.insertInto("main.plan_shadow_diffs").values(part.map((d) => ({ at: d.at, ref: d.ref, side: d.side, fields: d.fields, detail: d.detail.slice(0, DETAIL_MAX) }))));
      }
      // The table has no key and Postgres has no rowid for it: keep the rows at or after the SHADOW_ROWS-th newest `at`. A pass's diffs
      // share one `at`, so the table can hold up to one pass's diffs more than SHADOW_ROWS.
      await q.run(k.deleteFrom("main.plan_shadow_diffs").where("at", "<", (eb) => eb.selectFrom("main.plan_shadow_diffs").select("at").orderBy("at", "desc").limit(1).offset(SHADOW_ROWS - 1)));
    }
  });
}

/**
 * Logged changes, the hourly pass counts (and their per-kind sums), full-pass causes and the shadow diff count, for `plan-log status`
 * and the `query-growth` check. 4 statements in one wave.
 */
export async function loadPassReport(db: Db): Promise<PassReport> {
  const q = queryDb(db);
  const { k } = q;
  const [logged, hours, causes, shadow] = await db.together(() => Promise.all([
    q.get(k.selectFrom("main.item_changes").select((eb) => eb.fn.countAll<number>().as("n"))),
    q.all(k.selectFrom("main.plan_pass_hours").select(["kind", "hour", "passes", "refs", "last_at", "ms", "max_ms", "db_statements", "db_round_trips", "db_ms"]).orderBy("kind").orderBy("hour")),
    q.all(k.selectFrom("main.plan_full_causes").select(["source", "n"]).orderBy("n", "desc").limit(10)),
    q.get(k.selectFrom("main.plan_shadow_diffs").select((eb) => eb.fn.countAll<number>().as("n"))),
  ]));
  const series: PassReport["hours"] = hours.map((h) => ({
    kind: h.kind, hour: h.hour, passes: Number(h.passes), refs: Number(h.refs), at: h.last_at, ms: Number(h.ms), maxMs: Number(h.max_ms),
    dbStatements: Number(h.db_statements), dbRoundTrips: Number(h.db_round_trips), dbMs: Number(h.db_ms),
  }));
  const totals = new Map<string, PassStat>();
  for (const { hour: _hour, ...h } of series) {
    const t = totals.get(h.kind);
    totals.set(h.kind, t ? {
      ...t, passes: t.passes + h.passes, refs: t.refs + h.refs, at: h.at > t.at ? h.at : t.at, ms: t.ms + h.ms, maxMs: Math.max(t.maxMs, h.maxMs),
      dbStatements: t.dbStatements + h.dbStatements, dbRoundTrips: t.dbRoundTrips + h.dbRoundTrips, dbMs: t.dbMs + h.dbMs,
    } : h);
  }
  return { logged: Number(logged?.n ?? 0), passes: [...totals.values()], hours: series, fullCauses: causes.map((c) => ({ source: c.source, n: Number(c.n) })), shadowDiffs: Number(shadow?.n ?? 0) };
}
