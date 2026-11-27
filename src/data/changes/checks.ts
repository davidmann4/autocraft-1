// Patch checks (`patch_checks`), model checks (`model_checks`) and stored-patch sessions.
import { createHash } from "node:crypto";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { MODEL_CHECK_COLS, modelCheckRow, rowsOf } from "./rows.ts";
import type { ModelCheckRow, ModelCheckStart, PatchCheckInput, SessionRow } from "./types.ts";

/** The first 16 hex digits of the patch's SHA-256, as `patch_checks.patch_hash` stores it. */
export const patchHash = (patch: string): string => createHash("sha256").update(patch).digest("hex").slice(0, 16);

/** One multi-row insert per 500 rows. */
export async function recordPatchChecks(db: Db, rows: PatchCheckInput[]): Promise<void> {
  if (!rows.length) return;
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.batches(rows)) {
      await q.run((q.k as any).insertInto("patch_checks").values(part.map((r) => ({
        kind: r.kind, repo: r.repo, number: r.number, subject: r.subject, patch_hash: patchHash(r.patch), round: r.round, verdict: r.check.verdict,
        reasons: r.check.reasons, problems: JSON.stringify(r.check.problems), model: r.model, created_at: r.at,
      }))));
    }
  });
}

/** Opens a model check row; the launched build task runs between start and end, so they are two statements. */
export async function startModelCheck(db: Db, r: ModelCheckStart): Promise<number> {
  const q = queryDb(db);
  const row = await q.get((q.k as any).insertInto("model_checks")
    .values({ run_id: r.runId, step: r.step, repo: r.repo, number: r.number, head: r.head, command: r.command, crate: r.crate, test_name: r.testName, started_at: r.startedAt }).returning("id"));
  return Number((row as { id: unknown }).id);
}

/** Closes a model check row (the outcome is cut to 200 characters). */
export async function endModelCheck(db: Db, id: number, o: { outcome: string; taskId: number | null; endedAt: string }): Promise<void> {
  const q = queryDb(db);
  await q.run((q.k as any).updateTable("model_checks").set({ outcome: o.outcome.slice(0, 200), task_id: o.taskId, ended_at: o.endedAt }).where("id", "=", id));
}

/** The highest model check id, 0 for none (dry-run tool). */
export async function maxModelCheckId(db: Db): Promise<number> {
  const q = queryDb(db);
  const r = await q.get((q.k as any).selectFrom("model_checks").select((eb: any) => eb.fn.coalesce(eb.fn.max("id"), eb.lit(0)).as("n")));
  return Number((r as { n: unknown } | undefined)?.n ?? 0);
}

/** Model checks after `id` by id, optionally of one step and item head (dry-run tool). */
export async function loadModelChecksAfter(db: Db, id: number, f: { step?: string; repo?: string; number?: number; head?: string } = {}): Promise<ModelCheckRow[]> {
  const k = queryDb(db).k as any;
  let sel = k.selectFrom("main.model_checks as m").select([...MODEL_CHECK_COLS]).where("m.id", ">", id);
  if (f.step !== undefined) sel = sel.where("m.step", "=", f.step);
  if (f.repo !== undefined) sel = sel.where("m.repo", "=", f.repo);
  if (f.number !== undefined) sel = sel.where("m.number", "=", f.number);
  if (f.head !== undefined) sel = sel.where("m.head", "=", f.head);
  return (await rowsOf<any>(db, sel.orderBy("m.id"))).map(modelCheckRow);
}

/**
 * `{ kind, id, state, session }` of every row with a session in the three patch tables and `main_fixes`, by id (the id is the
 * rowid). 4 statements in one wave; which state waits for a lint task is the caller's rule.
 */
export async function loadSessionRows(db: Db): Promise<SessionRow[]> {
  const k = queryDb(db).k as any;
  const tables = [["fixup", "fixups"], ["cifix", "ci_fixes"], ["conflict", "conflict_merges"], ["main", "main_fixes"]] as const;
  const lists = await db.together(() => Promise.all(tables.map(([, t]) => rowsOf<any>(db, k.selectFrom(`main.${t} as t`)
    .select([kx.rowid(`main.${t}` as "main.fixups", "t").as("id"), "t.state", "t.session"]).where("t.session", "is not", null).orderBy(kx.rowid(`main.${t}` as "main.fixups", "t"))))));
  return tables.flatMap(([kind], i) => lists[i]!.map((r): SessionRow => ({ kind, id: Number(r.id), state: r.state, session: r.session })));
}
