// The change log that drives incremental passes (`item_changes`, `plan_full`, `plan_full_causes`, `plan_bulk`).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import type { Ref } from "../keys.ts";
import type { ChangeCursor, Changes } from "./types.ts";

/** More unread rows than this: a full pass costs less than re-deciding them one by one. */
const CHANGES_CAP = 50_000;
/** Ranges of consecutive seqs per DELETE statement. */
const PRUNE_RANGES = 200;
/** The transaction-local setting that turns the Postgres logging triggers off (src/db/pg-triggers.ts reads it). */
const PG_BULK = "ac.bulk";

/** How long the pass's snapshot may sit idle while the process parses a wave of 70 MB; it holds no lock, unlike the writes the server's shorter default is for. */
const SNAPSHOT_IDLE_MS = 60_000;

/** Lets the open read transaction sit idle for SNAPSHOT_IDLE_MS (Postgres). 1 statement, which rides in the caller's wave. */
export async function allowIdleSnapshot(db: Db): Promise<void> {
  if (db.dialect !== "postgres" || !db.inTransaction("read")) return;
  const { k, all } = parts(db);
  await all(k().selectNoFrom((eb) => eb.fn<string>("set_config", [eb.val("idle_in_transaction_session_timeout"), eb.val(String(SNAPSHOT_IDLE_MS)), eb.lit(true)]).as("v")));
}

/**
 * The change log's generation and the seqs already read. 2 statements in one wave; inside the pass's `together` they ride in its wave.
 * Read in the pass's snapshot: the log first, so the loads of the same wave cover every row it names.
 */
export async function loadChangeCursor(db: Db): Promise<ChangeCursor> {
  const { k, all } = parts(db);
  return await db.together(async () => {
    const [gen, seqs] = await Promise.all([
      all(k().selectFrom("main.plan_full").select("seq").where("id", "=", 1)),
      all(k().selectFrom("main.item_changes").select("seq")),
    ]);
    return { gen: gen[0]?.seq ?? 0, seen: new Set(seqs.map((r) => Number(r.seq))) };
  });
}

/**
 * Refs logged since the cursor, or `full` with its cause. The generation and the rows are one wave of 2 statements.
 * A marker or cap result needs the whole log as the new cursor: that second wave runs only then, and its answer replaces the
 * first wave's, so no result mixes snapshots (planner.md risk 1).
 */
export async function readChanges(db: Db, cursor: ChangeCursor): Promise<Changes> {
  const { k, all } = parts(db);
  const [gen, rows] = await db.together(() => Promise.all([
    all(k().selectFrom("main.plan_full").select("seq").where("id", "=", 1)),
    // Rows read before and not yet deleted come back first; whatever the limit leaves out is read next time.
    all(k().selectFrom("main.item_changes").select(["seq", "repo", "number"]).orderBy("seq").limit(cursor.seen.size + CHANGES_CAP + 1)),
  ]));
  if ((gen[0]?.seq ?? 0) !== cursor.gen) return { refs: [], full: true, cause: "marker", cursor: await loadChangeCursor(db) };
  const fresh = rows.filter((r) => !cursor.seen.has(Number(r.seq)));
  if (fresh.length > CHANGES_CAP) return { refs: [], full: true, cause: "cap", cursor: await loadChangeCursor(db) };
  const seen = new Set(cursor.seen);
  for (const r of fresh) seen.add(Number(r.seq));
  return { refs: [...new Set(fresh.map((r) => `${r.repo}#${r.number}`))], full: false, cursor: { gen: cursor.gen, seen } };
}

/**
 * Deletes exactly the seqs the cursor read, as ranges of consecutive seqs; joins the caller's transaction. Does not mutate the
 * cursor: the pass clears `cursor.seen` after its transaction commits, or a rolled-back pass would forget rows it never deleted.
 * The log has one consumer, the runner's planner; a second would lose the rows the first deleted. Returns the rows deleted.
 */
export async function pruneChanges(db: Db, cursor: ChangeCursor): Promise<number> {
  const seqs = [...cursor.seen].sort((a, b) => a - b);
  // Runs of consecutive seqs: a run holds no seq that was not read.
  const runs: [number, number][] = [];
  for (const q of seqs) {
    const last = runs.at(-1);
    if (last && q === last[1] + 1) last[1] = q; else runs.push([q, q]);
  }
  if (!runs.length) return 0;
  const { k } = parts(db);
  return await db.write(async () => {
    let n = 0;
    for (let i = 0; i < runs.length; i += PRUNE_RANGES) {
      const part = runs.slice(i, i + PRUNE_RANGES);
      n += Number((await queryDb(db).run(k().deleteFrom("main.item_changes").where((eb) => eb.or(part.map(([from, to]) => eb.between("seq", from, to)))))).changes);
    }
    return n;
  });
}

/** Logs refs as changed (a write the triggers cannot see); 1 statement per 10,000 refs. */
export async function logChanged(db: Db, refs: Ref[]): Promise<void> {
  if (!refs.length) return;
  const { k } = parts(db);
  for (const chunk of kx.chunks(refs)) {
    await queryDb(db).run(k().insertInto("main.item_changes").columns(["repo", "number"])
      .expression(k().selectFrom(kx.refPairs(db, chunk.map((r): [string, number] => [r.repo, r.number]), "rp")).select(["rp.repo", "rp.number"])));
  }
}

/**
 * Starts a bulk write: the logging triggers are off until `endBulk`, which takes one full-pass mark instead. SQLite writes the
 * `plan_bulk` row, Postgres sets the transaction-local `ac.bulk`; either way the marker ends with the transaction, so other
 * connections never see the triggers off. Throws outside `db.write`. A second call in the same transaction changes nothing, and
 * the first `endBulk` ends the marker for both.
 */
export async function beginBulk(db: Db): Promise<void> {
  needTransaction(db, "beginBulk");
  const q = queryDb(db);
  if (db.dialect === "postgres") await q.get(q.k.selectNoFrom((eb) => eb.fn("set_config", [eb.val(PG_BULK), eb.val("1"), eb.lit(true)]).as("v")));
  else await q.run(q.k.insertInto("main.plan_bulk").values({ id: 1 }).onConflict((oc) => oc.column("id").doNothing()));
}

/** Ends a bulk write and takes one full-pass mark named `bulk:<source>` (1-3 statements). Throws outside `db.write`. */
export async function endBulk(db: Db, source: string): Promise<void> {
  needTransaction(db, "endBulk");
  const q = queryDb(db);
  if (db.dialect === "postgres") {
    await q.get(q.k.selectNoFrom((eb) => eb.fn("set_config", [eb.val(PG_BULK), eb.val(""), eb.lit(true)]).as("v")));
    await q.get(q.k.selectNoFrom((eb) => eb.fn("ac_mark_full", [eb.val(`bulk:${source}`)]).as("v")));
    return;
  }
  await q.run(q.k.deleteFrom("main.plan_bulk"));
  // The full-pass mark the SQLite triggers take, as statements (core/plan-changes.ts markFull): recreate a missing marker row,
  // move the generation, count the cause.
  await q.run(q.k.insertInto("main.plan_full").columns(["id", "seq"])
    .expression(q.k.selectNoFrom((eb) => [eb.lit(1).as("id"), eb.lit(0).as("seq")])
      .where((eb) => eb.not(eb.exists(eb.selectFrom("main.plan_full").select(eb.lit(1).as("one")).where("id", "=", 1))))));
  await q.run(q.k.updateTable("main.plan_full").set((eb) => ({ seq: eb("seq", "+", 1) })).where("id", "=", 1));
  await q.run(q.k.insertInto("main.plan_full_causes")
    .values((eb) => ({ source: `bulk:${source}`, n: 1, last_seq: eb.fn.coalesce(eb.selectFrom("main.plan_full").select("seq").where("id", "=", 1), eb.lit(0)) }))
    .onConflict((oc) => oc.column("source").doUpdateSet((eb) => ({ n: eb("main.plan_full_causes.n", "+", 1), last_seq: eb.ref("excluded.last_seq") }))));
}

function needTransaction(db: Db, fn: string): void {
  if (!db.inTransaction("write")) throw new Error(`planner.${fn} runs inside db.write: the bulk marker must end with its transaction`);
}

function parts(db: Db) {
  const q = queryDb(db);
  return { k: () => q.k, all: q.all.bind(q) as typeof q.all };
}
