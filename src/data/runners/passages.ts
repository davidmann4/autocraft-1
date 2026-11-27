// Reference passages a call has read (`remote_passages`) (package runners-b).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import type { NewPassage } from "./types.ts";

/** The number of passages a call and run have read. */
export async function loadPassageCount(db: Db, callId: number, runId: number | null): Promise<number> {
  const q = queryDb(db);
  return Number((await q.get(q.k.selectFrom("main.remote_passages").select((eb) => eb.fn.countAll<number>().as("n")).where("call_id", "=", callId).where("run_id", "is not distinct from", runId)))!.n);
}

/** Multi-row insert of passages. */
export async function addPassages(db: Db, rows: NewPassage[]): Promise<void> {
  if (!rows.length) return;
  const q = queryDb(db);
  for (const part of kx.batches(rows)) {
    await q.run(q.k.insertInto("main.remote_passages").values(part.map((r) => ({
      call_id: r.callId, run_id: r.runId, user_login: r.login, repo: r.repo, passage_id: r.passageId, page: r.page, at: r.at,
    }))));
  }
}
