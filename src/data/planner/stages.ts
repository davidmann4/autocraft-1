// The stage log (`stages`; `item_stage` is kept by a trigger).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { keysOf } from "./fragments.ts";
import type { ItemKeys, RefKey, StageEvent, StageEventRow, StageFacts } from "./types.ts";

const refKey = (repo: string, number: number): RefKey => `${repo}#${number}`;
const noKeys = (keys: ItemKeys): boolean => Array.isArray(keys) && keys.length === 0;

const insertRow = (r: StageEventRow) => ({ repo: r.repo, number: r.number, stage: r.stage, at: r.at, actor: r.actor, note: r.note });

/** The only writer of `stages`; joins the caller's transaction; 1 statement per 500 rows. Never writes `item_stage`. */
export async function addStageEvents(db: Db, rows: StageEventRow[]): Promise<void> {
  if (!rows.length) return;
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.batches(rows)) await q.run(q.k.insertInto("main.stages").values(part.map(insertRow)));
  });
}

/**
 * Inserts a row unless a row of that (repo, number, stage) has a note starting with `notePrefix`: one conditional insert instead
 * of a read then a write. Two rows of one call with the same (repo, number, stage, prefix) insert the first only. Returns the rows
 * inserted.
 */
export async function addStageEventsOnce(db: Db, rows: (StageEventRow & { notePrefix: string })[]): Promise<number> {
  if (!rows.length) return 0;
  const q = queryDb(db);
  const seen = new Set<string>();
  const fresh = rows.filter((r) => {
    const key = JSON.stringify([r.repo, r.number, r.stage, r.notePrefix]);
    return !seen.has(key) && !!seen.add(key);
  });
  return await db.write(async () => {
    let n = 0;
    for (const part of kx.chunks(fresh, 500)) {
      const v = kx.valuesTable(db, part.map((r, ord) => ({ ...insertRow(r), ord, pattern: `${kx.likeEscape(r.notePrefix)}%` })),
        { repo: "text", number: "bigint", stage: "text", at: "text", actor: "text", note: "text", ord: "bigint", pattern: "text" }, "v");
      const fresh = q.k.selectFrom(v).select(["v.repo", "v.number", "v.stage", "v.at", "v.actor", "v.note"])
        .where((w) => w.not(w.exists(kx.schemaEb(w).selectFrom("main.stages as x").select(w.lit(1).as("one"))
          .where("x.repo", "=", w.ref("v.repo")).where("x.number", "=", w.ref("v.number")).where("x.stage", "=", w.ref("v.stage"))
          .where(kx.like(db, "x.note", w.ref("v.pattern"), "\\"))))).orderBy("v.ord");
      n += Number((await q.run(q.k.insertInto("main.stages").columns(["repo", "number", "stage", "at", "actor", "note"]).expression(fresh))).changes);
    }
    return n;
  });
}

/**
 * The latest stage per item and the latest `labeled` note by (at, rowid), for the pass's items. 2 statements in one wave; keyed, so
 * the cost does not follow the size of the log. A tie on `at` goes to the later row.
 */
export async function loadStageFacts(db: Db, keys: ItemKeys): Promise<Map<RefKey, StageFacts>> {
  const out = new Map<RefKey, StageFacts>();
  if (noKeys(keys)) return out;
  const q = queryDb(db);
  const { k } = q;
  const [stages, labeled] = await db.together(() => Promise.all([
    q.all(k.selectFrom("main.item_stage as st").innerJoin(keysOf(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "st.repo").onRef("kk.number", "=", "st.number")).select(["st.repo", "st.number", "st.stage", "st.at", "st.reviewed"])),
    q.all(k.selectFrom(k.selectFrom("main.stages as s").innerJoin(keysOf(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "s.repo").onRef("kk.number", "=", "s.number"))
      .select(["s.repo", "s.number", "s.note", (eb) => eb.fn.agg<number>("row_number").over((o) => o.partitionBy(["s.repo", "s.number"]).orderBy("s.at", "desc").orderBy(kx.rowid("main.stages", "s"), "desc")).as("rn")])
      .where("s.stage", "=", "labeled").as("t")).select(["t.repo", "t.number", "t.note"]).where("t.rn", "=", 1)),
  ]));
  const notes = new Map(labeled.map((l) => [refKey(l.repo, l.number), l.note]));
  for (const s of stages) out.set(refKey(s.repo, s.number), { stage: s.stage, at: s.at, reviewed: !!Number(s.reviewed), labeledNote: notes.get(refKey(s.repo, s.number)) ?? null });
  return out;
}

/** The stage log per ref ordered by (at, rowid). 1 statement. */
export async function loadStageLog(db: Db, keys: RefKey[]): Promise<Map<RefKey, StageEvent[]>> {
  const out = new Map<RefKey, StageEvent[]>();
  if (!keys.length) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.stages as s").select(["s.repo", "s.number", kx.rowid("main.stages", "s").as("rowid"), "s.stage", "s.at", "s.actor", "s.note"])
    .where(kx.refIn(db, "s", keys)).orderBy("s.at").orderBy(kx.rowid("main.stages", "s")));
  for (const r of rows) (out.get(refKey(r.repo, r.number)) ?? out.set(refKey(r.repo, r.number), []).get(refKey(r.repo, r.number))!).push({ rowid: Number(r.rowid), stage: r.stage, at: r.at, actor: r.actor, note: r.note });
  return out;
}

/** Row count and newest rowid per ref. 1 statement. */
export async function loadStageVersions(db: Db, keys: RefKey[]): Promise<Map<RefKey, { count: number; newestRowid: number | null }>> {
  const out = new Map<RefKey, { count: number; newestRowid: number | null }>();
  if (!keys.length) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.stages as s").select(["s.repo", "s.number", (eb) => eb.fn.countAll<number>().as("n"), (eb) => eb.fn.max<number | null>(kx.rowid("main.stages", "s")).as("newest")])
    .where(kx.refIn(db, "s", keys)).groupBy(["s.repo", "s.number"]));
  for (const r of rows) out.set(refKey(r.repo, r.number), { count: Number(r.n), newestRowid: r.newest == null ? null : Number(r.newest) });
  return out;
}

/** Row count and max rowid of the whole log (the Progress cache signature). 1 statement. */
export async function loadStageVersion(db: Db): Promise<{ count: number; maxRowid: number | null }> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("main.stages as s").select([(eb) => eb.fn.countAll<number>().as("n"), (eb) => eb.fn.max<number | null>(kx.rowid("main.stages", "s")).as("m")]));
  return { count: Number(r?.n ?? 0), maxRowid: r?.m == null ? null : Number(r.m) };
}

/**
 * Stage events for the activity feed. With `sinceRowid`, the rows after it, oldest first; without, the newest `limit` rows,
 * newest first. `since` keeps rows at or after that time. 1 statement. Reads through the scoped view like the feed did.
 */
export async function listStageEvents(db: Db, opts: { sinceRowid?: number; since?: string; limit: number }): Promise<(StageEvent & { repo: string; number: number })[]> {
  const q = queryDb(db);
  const asc = opts.sinceRowid !== undefined;
  const rid = kx.rowid("stages", "s");
  const rows = await q.all(q.k.selectFrom("stages as s").select(["s.repo", "s.number", rid.as("rowid"), "s.stage", "s.at", "s.actor", "s.note"])
    .$if(asc, (b) => b.where(rid, ">", opts.sinceRowid!))
    .$if(!!opts.since, (b) => b.where("s.at", ">=", opts.since!))
    .orderBy(rid, asc ? "asc" : "desc").limit(Math.floor(opts.limit)));
  return rows.map((r) => ({ repo: r.repo, number: Number(r.number), rowid: Number(r.rowid), stage: r.stage, at: r.at, actor: r.actor, note: r.note }));
}
