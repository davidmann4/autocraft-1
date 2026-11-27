// SQLite-only migration and maintenance code that runs on the synchronous DatabaseSync inside connect()'s migrations
// (src/db.ts), or maintains the SQLite change-log triggers. Raw SQL lives here so the rest of src/ uses the query builder.
import type { DatabaseSync } from "node:sqlite";
import { markFull, BULK_ROWS } from "./plan-triggers.ts";
import { BATCH, FIELD_COLUMNS, SCHEME_ID, classifyHash, embedHash, type Fields } from "../itemhash.ts";
import { textRefs } from "../core/open-prs.ts";
import type { Db } from "./index.ts";
import { queryDb } from "./query-db.ts";

const FIELDS = FIELD_COLUMNS.join(", ");

/** `select`, `update` and `values` are the SQL text of the synchronous fill of one hash column set. */
type SyncFill = { source: string; select: string; update: string; values: (r: Fields) => string[] };

const EMBED: SyncFill = {
  source: "embed-hashes", select: `SELECT ${FIELDS} FROM main.items WHERE embed_hash IS NULL LIMIT ${BATCH}`,
  update: "UPDATE main.items SET embed_hash = ? WHERE repo = ? AND number = ?", values: (r) => [embedHash(r.title, r.body)],
};

const CLASS: SyncFill = {
  source: "class-hashes", select: `SELECT ${FIELDS} FROM main.items WHERE state = 'OPEN' AND class_scheme IS NOT '${SCHEME_ID}' LIMIT ${BATCH}`,
  update: `UPDATE main.items SET class_hash = ?, class_scheme = '${SCHEME_ID}' WHERE repo = ? AND number = ?`, values: (r) => [classifyHash(r)],
};

/** bulkWrites() inside the caller's transaction, for connect()'s migrations, which stay synchronous. */
export function bulkWritesSync(db: DatabaseSync, source: string, fn: () => void): void {
  if (db.prepare("SELECT 1 FROM main.plan_bulk").get()) return fn();
  db.exec("INSERT INTO main.plan_bulk (id) VALUES (1)");
  try {
    fn();
  } finally {
    db.exec("DELETE FROM main.plan_bulk");
    db.exec(markFull(`bulk:${source}`));
  }
}

/** fillEmbedHashes() then fillClassHashes(), for connect()'s migrations, which stay synchronous. */
export function fillHashesSync(db: DatabaseSync): void {
  for (const { source, select, update, values } of [EMBED, CLASS]) {
    const sel = db.prepare(select), upd = db.prepare(update);
    for (;;) {
      const rows = sel.all() as unknown as Fields[];
      if (!rows.length) break;
      db.exec("BEGIN IMMEDIATE");
      try {
        const write = (): void => { for (const r of rows) upd.run(...values(r), r.repo, r.number); };
        if (rows.length >= BULK_ROWS) bulkWritesSync(db, source, write); else write();
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
  }
}

/** Writes text_refs of the open PRs without one, in batches so other processes can write between them. */
export function fillTextRefs(db: DatabaseSync): void {
  const sel = db.prepare("SELECT repo, number, title, body FROM main.items WHERE kind = 'pr' AND state = 'OPEN' AND text_refs IS NULL LIMIT 2000");
  const upd = db.prepare("UPDATE main.items SET text_refs = ? WHERE repo = ? AND number = ? AND text_refs IS NULL");
  for (;;) {
    const rows = sel.all() as { repo: string; number: number; title: string | null; body: string | null }[];
    if (!rows.length) return;
    db.exec("BEGIN IMMEDIATE");
    try {
      const write = (): void => { for (const r of rows) upd.run(textRefs(r.title, r.body), r.repo, r.number); };
      if (rows.length >= BULK_ROWS) bulkWritesSync(db, "text-refs", write); else write();
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

/**
 * Removes the change log, its triggers and the incremental planner's tables, and clears the schema stamp so the next connect
 * migrates. For a rollback to a release without the incremental planner, whose migration would leave the triggers logging.
 */
export async function dropPlanChanges(db: Db): Promise<number> {
  // Postgres has no release before the change log; its triggers serve the live topics too (src/db/pg-triggers.ts).
  if (db.dialect === "postgres") throw new Error("dropping the change log is for SQLite databases only");
  const q = queryDb(db);
  const triggers = await q.prepare("SELECT name FROM main.sqlite_master WHERE type = 'trigger' AND name LIKE 'plan\\_%' ESCAPE '\\'").all() as { name: string }[];
  await db.write(async () => {
    for (const { name } of triggers) await q.script(`DROP TRIGGER IF EXISTS main.${name}`);
    for (const t of ["item_changes", "plan_full", "plan_full_causes", "plan_bulk", "plan_shadow_diffs", "plan_pass_stats", "review_blockers"] as const) await q.run(q.k.schema.dropTable(`main.${t}`).ifExists());
    await q.script("DELETE FROM main.sqlite_sequence WHERE name = 'item_changes'");
    await q.run(q.k.deleteFrom("main.settings").where("key", "=", "schema_stamp"));
  });
  return triggers.length;
}
