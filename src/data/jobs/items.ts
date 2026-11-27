// `job_items` writer and readers (M07 jobs).
import { AsyncLocalStorage } from "node:async_hooks";
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import type { Ref } from "../keys.ts";
import { hasFilter, repoVisible } from "./sql.ts";
import type { HiddenRepos, ItemJobRow, JobItemRow, JobState, NewJobItem, RefKey } from "./types.ts";

/** Multi-row insert, one statement per 500 rows. */
export async function addJobItems(db: Db, rows: NewJobItem[]): Promise<void> {
  if (!rows.length) return;
  const q = queryDb(db);
  const parts = kx.batches(rows);
  const insert = async (part: NewJobItem[]) => void await q.run(q.k.insertInto("job_items").values(part.map((r) => ({ job_id: r.job_id, repo: r.repo, number: r.number, outcome: r.outcome, at: r.at }))));
  if (parts.length === 1) await insert(parts[0]!);
  else await db.write(async () => { for (const p of parts) await insert(p); });
}

const FLUSH_ROWS = 50, FLUSH_MS = 2_000;
type ItemBuffer = { rows: NewJobItem[]; flushedAt: number; timer: NodeJS.Timeout | null };
const buffers = new Map<number, ItemBuffer>();
/** Inserts under way. Only `drainJobItems` waits for those of others: a flush inside a transaction may not wait for one that waits for that transaction. */
const writing = new Set<Promise<void>>();
/** Runs a flush outside the async context of the note that scheduled it: a transaction open there has ended by then. */
const apart = AsyncLocalStorage.snapshot();

/** Writes the buffered rows of the job (all jobs without `jobId`). A failed insert logs and keeps the rows for the next flush: bookkeeping must not fail the stage. */
export async function flushJobItems(db: Db, jobId?: number, log: (line: string) => void = console.error): Promise<void> {
  for (const [id, b] of [...buffers]) {
    if (jobId !== undefined && id !== jobId) continue;
    if (b.timer) clearTimeout(b.timer);
    b.timer = null;
    if (!b.rows.length) { buffers.delete(id); continue; }
    const rows = b.rows.splice(0, b.rows.length);
    b.flushedAt = Date.now();
    const insert = addJobItems(db, rows).catch((e: unknown) => {
      bufferOf(id).rows.unshift(...rows);
      log(`job items not recorded: ${(e as Error).message}`);
    });
    writing.add(insert);
    await insert;
    writing.delete(insert);
  }
}

/** `flushJobItems` at the job's end: inserts under way are waited for, and a failed one is tried once more. */
export async function drainJobItems(db: Db, jobId: number): Promise<void> {
  await Promise.all(writing);
  await flushJobItems(db, jobId);
}

function bufferOf(jobId: number): ItemBuffer {
  let b = buffers.get(jobId);
  if (!b) buffers.set(jobId, (b = { rows: [], flushedAt: Date.now(), timer: null }));
  return b;
}

/**
 * Logs the tagged line at once and queues the row in a per-process buffer keyed by `jobId` (null outside a job: nothing is
 * stored). The buffer flushes through `addJobItems` at 50 rows, within 2 s of a note, and at the job's end or stop
 * (`JobPulse.end`).
 */
export async function noteJobItem(db: Db, jobId: number | null, repo: string, number: number, outcome: string, log: (line: string) => void): Promise<void> {
  const line = outcome.replace(/\s+/g, " ").trim().slice(0, 300);
  log(`[${repo}#${number}] ${line}`);
  if (jobId === null) return;
  const b = bufferOf(jobId);
  b.rows.push({ job_id: jobId, repo, number, outcome: line, at: new Date().toISOString() });
  if (b.rows.length >= FLUSH_ROWS || Date.now() - b.flushedAt >= FLUSH_MS) await flushJobItems(db, jobId, log);
  else b.timer ??= apart(() => setTimeout(() => void flushJobItems(db, jobId, log), FLUSH_MS).unref());
}

/** What each job handled, oldest first; a viewer's hidden repos are left out. */
export async function loadJobItems(db: Db, jobIds: number[], o: { hidden?: HiddenRepos } = {}): Promise<Map<number, JobItemRow[]>> {
  const out = new Map<number, JobItemRow[]>();
  if (!jobIds.length) return out;
  const q = queryDb(db);
  for (const part of kx.chunks(jobIds)) {
    const rows = await q.all(q.k.selectFrom("job_items").select(["id", "job_id", "repo", "number", "outcome", "at"]).where(kx.inList(db, "job_id", part, "bigint"))
      .$if(hasFilter(o.hidden), (b) => b.where((eb) => repoVisible(db, eb, "repo", o.hidden!))).orderBy("id"));
    for (const r of rows) { const l = out.get(r.job_id); if (l) l.push(r); else out.set(r.job_id, [r]); }
  }
  return out;
}

/** `job_items` joined to `jobs`, oldest first, per item. */
export async function loadItemJobTrail(db: Db, refs: Ref[], o: { states?: string[] } = {}): Promise<Map<RefKey, ItemJobRow[]>> {
  const out = new Map<RefKey, ItemJobRow[]>();
  if (!refs.length) return out;
  const q = queryDb(db);
  for (const part of kx.chunks(refs)) {
    const rows = await q.all(q.k.selectFrom("job_items as ji").innerJoin("jobs as j", "j.id", "ji.job_id")
      .innerJoin(kx.refPairs(db, part.map((r): [string, number] => [r.repo, r.number]), "rp"), (jn) => jn.onRef("rp.repo", "=", "ji.repo").onRef("rp.number", "=", "ji.number"))
      .select(["ji.id", "ji.repo", "ji.number", "j.id as job_id", "j.step", "j.state", "ji.outcome", "ji.at", "j.ended_at", "j.error"]).$narrowType<{ state: JobState }>()
      .$if(!!o.states, (b) => b.where("j.state", "in", o.states!)).orderBy("ji.id"));
    for (const r of rows) {
      const key: RefKey = `${r.repo}#${Number(r.number)}`;
      const row: ItemJobRow = { id: Number(r.id), job_id: r.job_id, step: r.step, state: r.state, outcome: r.outcome, at: r.at, ended_at: r.ended_at, error: r.error };
      const l = out.get(key);
      if (l) l.push(row); else out.set(key, [row]);
    }
  }
  return out;
}
