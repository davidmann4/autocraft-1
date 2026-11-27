// Jev answers that were unsure (`jev_unsure`).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";

/** How long a kept unsure Jev answer is reused before it is dropped and Jev is asked again. */
export const JEV_UNSURE_KEEP_MS = 30 * 24 * 3600_000;

/** Stored unsure answers per ref (`answer` is the stored JSON text). 1 statement. */
export async function loadUnsure(db: Db, promptId: string, refs: string[]): Promise<Map<string, { hash: string; answer: string }>> {
  const out = new Map<string, { hash: string; answer: string }>();
  if (refs.length === 0) return out;
  const q = queryDb(db);
  for (const part of kx.chunks(refs)) {
    for (const r of await q.all(q.k.selectFrom("main.jev_unsure").select(["ref", "input_hash", "answer"]).where("prompt_id", "=", promptId).where(kx.inList(db, "ref", part)))) {
      out.set(r.ref, { hash: r.input_hash, answer: r.answer });
    }
  }
  return out;
}

/** Upserts `keep` and deletes `drop` in one `db.write`. */
export async function saveUnsure(db: Db, o: { promptId: string; keep: { ref: string; hash: string; answer: string; at: string }[]; drop: string[] }): Promise<void> {
  if (o.keep.length === 0 && o.drop.length === 0) return;
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.batches(o.keep)) {
      await q.run(q.k.insertInto("main.jev_unsure").values(part.map((r) => ({ prompt_id: o.promptId, ref: r.ref, input_hash: r.hash, answer: r.answer, at: r.at })))
        .onConflict((oc) => oc.columns(["prompt_id", "ref"]).doUpdateSet(kx.excluded(["input_hash", "answer", "at"]))));
    }
    for (const part of kx.chunks(o.drop)) {
      await q.run(q.k.deleteFrom("main.jev_unsure").where("prompt_id", "=", o.promptId).where(kx.inList(db, "ref", part)));
    }
  });
}

/**
 * Deletes rows older than `JEV_UNSURE_KEEP_MS` and rows whose item is not open and tracked; `openOf` is the mirror loader the caller supplies
 * (it answers which of the refs are open and tracked). One read, the caller's wave, and one delete by (prompt, ref) tuples.
 */
export async function pruneUnsure(db: Db, nowMs: number, openOf: (refs: string[]) => Promise<Set<string>>): Promise<number> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.jev_unsure").select(["prompt_id", "ref", "at"]));
  if (rows.length === 0) return 0;
  const open = await openOf([...new Set(rows.map((r) => r.ref))]);
  const cutoff = new Date(nowMs - JEV_UNSURE_KEEP_MS).toISOString();
  const drop = rows.filter((r) => r.at < cutoff || !open.has(r.ref)).map((r) => [r.prompt_id, r.ref] as const);
  let n = 0;
  for (const part of kx.chunks(drop)) {
    n += Number((await q.run(q.k.deleteFrom("main.jev_unsure").where(kx.tupleIn(db, ["prompt_id", "ref"], part, ["text", "text"])))).changes);
  }
  return n;
}
