// The job log copy (M07 jobs).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { octets } from "./sql.ts";
import type { LogChunkRow, LogDrop, LogTail } from "./types.ts";

/** The `copyLogs` insert: one statement per 500 rows. */
export async function addLogChunks(db: Db, rows: LogChunkRow[]): Promise<void> {
  if (!rows.length) return;
  const q = queryDb(db);
  const parts = kx.batches(rows);
  const insert = async (part: LogChunkRow[]) => void await q.run(q.k.insertInto("job_log_chunks").values(part));
  if (parts.length === 1) await insert(parts[0]!);
  else await db.write(async () => { for (const p of parts) await insert(p); });
}

/** The `copyLogs` delete: each job's chunks up to its `upTo`, in one statement. */
export async function dropLogChunks(db: Db, drops: LogDrop[]): Promise<number> {
  if (!drops.length) return 0;
  const q = queryDb(db);
  const v = kx.valuesTable(db, drops.map((d) => ({ job: d.job, upto: d.upTo })), { job: "bigint", upto: "bigint" }, "d");
  return (await q.run(q.k.deleteFrom("job_log_chunks").where((eb) => eb.exists(eb.selectFrom(v).select(eb.lit(1).as("one"))
    .whereRef("d.job", "=", "job_log_chunks.job_id").whereRef("job_log_chunks.seq", "<=", "d.upto"))))).changes;
}

/** `DELETE ... WHERE at < ?` limited by a subselect on `(job_id, seq)`; one batch. */
export async function pruneLogChunks(db: Db, before: string, limit: number): Promise<number> {
  const q = queryDb(db);
  return (await q.run(q.k.deleteFrom("job_log_chunks").where((eb) => eb(eb.refTuple("job_id", "seq"), "in",
    eb.selectFrom("job_log_chunks as old").select(["old.job_id", "old.seq"]).where("old.at", "<", before).limit(limit) as never)))).changes;
}

/** The kept chunks of one job, newest first, stopping at `bytes` through a window sum of the chunk sizes; the last text is cut to `bytes` from a line start. */
export async function loadLogTail(db: Db, job: number, bytes: number): Promise<LogTail | null> {
  const q = queryDb(db);
  const sized = q.k.selectFrom("job_log_chunks").select((eb) => ["chunk", "start", octets(db, "chunk").as("size"), "seq",
    eb.fn.sum<number>(octets(db, "chunk")).over((o) => o.orderBy("seq", "desc")).as("through")]).where("job_id", "=", job);
  // A chunk is kept while the chunks after it hold fewer than `bytes`: the one that crosses the cap is read whole.
  const rows = await q.all(q.k.selectFrom(sized.as("t")).select(["t.chunk", "t.start"]).where((eb) => eb(eb("t.through", "-", eb.ref("t.size")), "<", bytes)).orderBy("t.seq", "desc"));
  if (!rows.length) return null;
  const size = rows.reduce((n, c) => n + Buffer.byteLength(c.chunk), 0);
  const first = Number(rows.at(-1)!.start);
  const joined = rows.map((c) => c.chunk).reverse().join("");
  if (size <= bytes) return { log: joined, logTruncated: first > 0 };
  const cut = Buffer.from(joined).subarray(-bytes).toString("utf8");
  return { log: cut.slice(cut.indexOf("\n") + 1), logTruncated: true };
}

/** Finished jobs older than the keep window, oldest first. */
export async function loadPrunable(db: Db, before: string, limit: number): Promise<{ id: number; log_path: string | null }[]> {
  const q = queryDb(db);
  return await q.all(q.k.selectFrom("jobs").select(["id", "log_path"]).where("ended_at", "is not", null).where("ended_at", "<", before)
    .where("state", "in", ["done", "failed", "cancelled"]).orderBy("ended_at").limit(limit));
}

/** Deletes items, chunks and jobs, three statements per batch of 1,000; one `db.write`. The caller unlinks log files first. */
export async function removeJobs(db: Db, ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  const q = queryDb(db);
  return await db.write(async () => {
    let n = 0;
    for (const part of kx.chunks(ids, 1000)) {
      const list = kx.inList(db, "job_id", part, "bigint");
      await q.run(q.k.deleteFrom("job_items").where(list));
      await q.run(q.k.deleteFrom("job_log_chunks").where(list));
      n += (await q.run(q.k.deleteFrom("jobs").where(kx.inList(db, "id", part, "bigint")))).changes;
    }
    return n;
  });
}
