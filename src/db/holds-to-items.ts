// Every merge hold (`merge_holds`) of an open pull request becomes a held item, as the command `hold` leaves one (src/workflow/apply.ts):
// its live workflow, or the one of the issue it implements, is held with what a resume goes back to; a pull request nobody started gets
// a held row. One that a person already took out of the pipeline stays as it is. The converted rows go; the table stays for a release before
// this (src/db/retired-names.ts), which may write more of them (a rollout's old pods, a rollback): whatever rows there are get converted.
// Nothing is converted where the table is gone. Merge legs and queued steps of the held workflows end with the pre-approval pass.
// Runs on SQLite with the value migrations of connect() (src/db.ts), on Postgres inside migratePg's transaction (src/db/pg-triggers.ts), and
// on both when the runner starts to lead (src/runner/index.ts): a database at the current stamp is not migrated.
import type { DatabaseSync } from "node:sqlite";
import type { HeldWork } from "../workflow/types.ts";
import type { Db } from "./index.ts";
import type { PgClient } from "./pg-triggers.ts";
import { queryDb } from "./query-db.ts";

/** Part of the Postgres stamp, so a database migrated before this code reaches the migration. */
export const HOLDS_TO_ITEMS_VERSION = 1;

const LIVE = "('running', 'waiting', 'blocked', 'recommending')";
type HoldRow = {
  repo: string; number: number | string; held_by: string; held_at: string; item: number | string | null; head: string | null;
  id: number | string | null; state: string | null; rec: string | null; blocker: string | null; blocker_params: string | null; last: string | null;
};
type Mark = (n: number) => string;
type Write = { sql: (main: string, p: Mark) => string; args: (string | number | null)[] };

const TABLE_SQLITE = "SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = 'merge_holds'";
const TABLE_PG = "SELECT 1 WHERE to_regclass('merge_holds') IS NOT NULL";
const ANY = (main: string): string => `SELECT 1 FROM ${main}merge_holds LIMIT 1`;
// The issue's newest attempt with a pull request, when the workflow `x` works on it (attemptOf, src/data/workflow/fragments.ts): `x.pr_number` is
// empty in a database whose workflows were never linked.
const IMPLEMENTS = (main: string): string => `EXISTS (SELECT 1 FROM ${main}implementations m WHERE m.repo = x.repo AND m.number = x.number AND m.pr_number = h.number
      AND (m.state NOT IN ('merged', 'closed', 'failed', 'cancelled') OR m.created_at >= x.started_at
        OR (m.updated_at >= x.started_at AND NOT EXISTS (SELECT 1 FROM ${main}implementations n WHERE n.repo = m.repo AND n.number = m.number AND n.id > m.id)))
      AND NOT EXISTS (SELECT 1 FROM ${main}implementations n WHERE n.repo = m.repo AND n.number = m.number AND n.id > m.id AND n.pr_number IS NOT NULL))`;
// The live workflow of the pull request itself comes before the one of its issue. `item`: the open pull request; a hold of any other holds nothing.
const ROWS_SQL = (main: string): string => `SELECT h.repo, h.number, h.held_by, h.held_at, i.number AS item, i.head_oid AS head, w.id, w.state, w.rec, w.blocker, w.blocker_params,
    (SELECT l.state FROM ${main}item_workflows l WHERE l.repo = h.repo AND l.number = h.number ORDER BY l.id DESC LIMIT 1) AS last
  FROM ${main}merge_holds h LEFT JOIN ${main}items i ON i.repo = h.repo AND i.number = h.number AND i.kind = 'pr' AND i.state = 'OPEN'
  LEFT JOIN ${main}item_workflows w ON w.id = (SELECT x.id FROM ${main}item_workflows x WHERE x.repo = h.repo AND x.state IN ${LIVE}
    AND (x.number = h.number OR (x.entry = 'implement' AND (x.pr_number = h.number OR ${IMPLEMENTS(main)}))) ORDER BY CASE WHEN x.number = h.number THEN 0 ELSE 1 END, x.id DESC LIMIT 1)
  ORDER BY h.repo, h.number`;

function json(text: string | null): unknown {
  try {
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

/** The held work of a live row, as holdPatch (src/workflow/apply.ts) makes it. */
function heldWork(r: HoldRow): HeldWork {
  const rec = r.state === "recommending" || r.state === "blocked" ? json(r.rec) : null;
  if (!rec) return {};
  const params = r.blocker === null ? null : json(r.blocker_params);
  return { rec, ...(r.blocker === null ? {} : { blocker: r.blocker }), ...(params ? { params } : {}) } as HeldWork;
}

function writesOf(rows: HoldRow[], at: string): Write[] {
  const done = new Set<number>();
  const held = rows.filter((r) => r.item !== null).flatMap((r): Write[] => {
    if (r.id !== null) {
      // Two held pull requests of one workflow hold it once.
      if (done.has(Number(r.id))) return [];
      done.add(Number(r.id));
      return [{
        sql: (main, p) => `UPDATE ${main}item_workflows SET state = 'stopped', stopped_by = ${p(1)}, stopped_at = ${p(2)}, rec = NULL, blocker = NULL, blocker_params = ${p(3)}, updated_at = ${p(4)}, version = version + 1 WHERE id = ${p(5)} AND state IN ${LIVE}`,
        args: [r.held_by, r.held_at, JSON.stringify({ held: heldWork(r) }), at, Number(r.id)],
      }];
    }
    if (r.last !== null && ["stopped", "backlog", "closed"].includes(r.last)) return [];
    const unstarted: HeldWork = { unstarted: true };
    return [{
      sql: (main, p) => `INSERT INTO ${main}item_workflows (repo, number, kind, entry, weight, state, started_by, started_at, started_via, base_head, accepted_head, stopped_by, stopped_at, blocker_params, plan, updated_at)
        VALUES (${[1, 2].map(p).join(", ")}, 'pr', 'review', 5, 'stopped', ${[3, 4].map(p).join(", ")}, 'cli', ${[5, 6, 7, 8, 9].map(p).join(", ")}, '[]', ${p(10)})`,
      args: [r.repo, Number(r.number), r.held_by, r.held_at, r.head, r.head, r.held_by, r.held_at, JSON.stringify({ held: unstarted }), at],
    }];
  });
  // Only the rows that were read: one written meanwhile is converted next time.
  return [...held, ...rows.map((r): Write => ({
    sql: (main, p) => `DELETE FROM ${main}merge_holds WHERE repo = ${p(1)} AND number = ${p(2)} AND held_at = ${p(3)}`,
    args: [r.repo, Number(r.number), r.held_at],
  }))];
}

export function holdsToItemsSqlite(db: DatabaseSync, at = new Date().toISOString()): void {
  if (!db.prepare(TABLE_SQLITE).get() || !db.prepare(ANY("main.")).get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const w of writesOf(db.prepare(ROWS_SQL("main.")).all() as unknown as HoldRow[], at)) db.prepare(w.sql("main.", () => "?")).run(...w.args);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** The Postgres form, on the migration connection inside its transaction. */
export async function holdsToItemsPg(client: PgClient, at = new Date().toISOString()): Promise<void> {
  if (!(await client.query(TABLE_PG)).rows.length) return;
  for (const w of writesOf((await client.query(ROWS_SQL(""))).rows as HoldRow[], at)) await client.query(w.sql("", (n) => `$${n}`), w.args);
}

/** On an open database of either engine. Returns how many holds there were. */
export async function holdsToItems(db: Db, at = new Date().toISOString()): Promise<number> {
  const q = queryDb(db);
  const rows = (sql: string): Promise<unknown[]> => q.prepare(sql).all();
  if (!(await rows(db.dialect === "postgres" ? TABLE_PG : TABLE_SQLITE)).length || !(await rows(ANY(""))).length) return 0;
  return await db.write(async () => {
    const holds = await rows(ROWS_SQL("")) as HoldRow[];
    for (const w of writesOf(holds, at)) await q.prepare(w.sql("", () => "?")).run(...w.args);
    return holds.length;
  });
}
