// The change log's triggers: AFTER-row triggers on every table of the planner's inputs log the items a write re-decides in
// `item_changes`, or move the full-pass generation when the write changes facts of items the trigger cannot name. The planner
// reads and prunes the log through the `planner` module (src/data/planner/changes.ts).
//
// The log is consumed by key, not by a seq cursor: on Postgres a seq is taken when the row is written and its transaction may
// commit after a later seq's, so "everything above the last seq read" would skip it. Seqs never repeat (SQLite AUTOINCREMENT,
// a Postgres identity), so a remembered seq names one row.
//
// `plan_full` holds a generation that every full-pass mark moves; a planner compares it with the one its facts cover. On
// Postgres the mark moves it once per transaction at commit (src/db/pg-triggers.ts), on SQLite once per marking row.
import type { DatabaseSync } from "node:sqlite";
import { BOOKKEEPING_COLUMNS, columnsOf } from "./live.ts";
import { pgExpr, pgJsonArray } from "../core/pg-expr.ts";
import type { Dialect } from "./index.ts";

/** More rows written at once than this go through one bulk marker: a single full-pass mark costs less than logging every row. */
export const BULK_ROWS = 500;

/**
 * - item: a row belongs to one item; a change re-decides that item.
 * - cross: a row changes facts of several items, or of items it does not name; the trigger logs every affected item, or forces
 *   a full pass where that set is not readable with a simple subquery.
 * - global: settings, repo-level rows, roles and breakers; a change forces a full pass.
 * - none: read, but not as a fact input (a memo key); no trigger.
 */
export type PlanInputClass = "item" | "cross" | "global" | "none";

export type PlanInput = {
  table: string;
  class: PlanInputClass;
  why: string;
  /** SELECT of the `repo` and `number` columns of the items row `r` decides; an item input defaults to the row's own repo and number, a cross input without it only forces full passes. */
  refs?: string;
  /** Condition on `r`: only rows that meet it are logged. */
  when?: string;
  /** An UPDATE counts only when one of these columns changed (default: every column but the bookkeeping ones, src/db/live.ts). */
  columns?: string[];
  /** Condition on `old` and `new` that replaces the changed-columns check of an UPDATE. */
  updateWhen?: string;
  /** Condition on `r` that forces a full pass: on INSERT and DELETE of such a row, and on an UPDATE that counts where either row meets it. */
  full?: string;
  /** Condition on `old` and `new` that forces a full pass on UPDATE, instead of `full`; it is checked on its own, without the changed-columns check. */
  fullUpdate?: string;
  /**
   * Postgres forms of the fragments above, for those the mechanical rewrite (pgExpr in src/core/pg-expr.ts) cannot
   * translate: JSON functions, GLOB, integer results used as conditions.
   */
  pg?: Partial<Record<"refs" | "when" | "updateWhen" | "full" | "fullUpdate", string>>;
  /** Why a write to the table needs no topic that makes the planner due (src/runner/autopilot.ts DUE_TOPICS); every other input table feeds one. */
  noTopic?: string;
};


let inputs: PlanInput[] | null = null;

/** Sets the planner's inputs, the list the triggers are made from (src/trigger-sources.ts registers it). */
export function registerPlanInputs(list: PlanInput[]): void {
  inputs = list;
}

function planInputs(): PlanInput[] {
  if (!inputs) throw new Error("planner inputs not registered: load src/trigger-sources.ts before generating triggers");
  return inputs;
}

const OPS = ["INSERT", "UPDATE", "DELETE"] as const;
type Op = (typeof OPS)[number];

/**
 * Body of a full-pass mark on SQLite: the next generation, and a count for `source`, which names the input that forced it. It
 * recreates a missing marker row, so a write to a global input never fails on it. No OR IGNORE: in a trigger the outer
 * statement's conflict policy replaces it.
 */
export const markFull = (source: string): string => `INSERT INTO plan_full (id, seq) SELECT 1, 0 WHERE NOT EXISTS (SELECT 1 FROM plan_full WHERE id = 1);
          UPDATE plan_full SET seq = seq + 1 WHERE id = 1;
          INSERT INTO plan_full_causes (source, n, last_seq) VALUES ('${source.replace(/'/g, "''")}', 1, COALESCE((SELECT seq FROM plan_full WHERE id = 1), 0))
            ON CONFLICT (source) DO UPDATE SET n = n + 1, last_seq = excluded.last_seq;`;

/** Every logging trigger is off while a bulk write holds the marker (bulkWrites). */
const NOT_BULK = "NOT EXISTS (SELECT 1 FROM plan_bulk)";

/** Postgres: the bulk marker is a transaction-local setting, so other sessions never see the triggers off. */
export const PG_BULK = "ac.bulk";

/** The blocker refs of a stored blocked_by value of review row `o` (a JSON array of "repo#number") that review_blockers does not hold yet. */
function blockerRows(dialect: Dialect, o: string, from = ""): string {
  const missing = `WHERE NOT EXISTS (SELECT 1 FROM review_blockers x WHERE x.b_repo = nb.b_repo AND x.b_number = nb.b_number AND x.repo = nb.repo AND x.number = nb.number AND x.head_oid = nb.head_oid)`;
  if (dialect === "postgres") {
    const v = "(j.value #>> '{}')";
    return `SELECT b_repo, b_number, repo, number, head_oid FROM (
            SELECT DISTINCT substr(${v}, 1, instr(${v}, '#') - 1) AS b_repo, ac_int(substr(${v}, instr(${v}, '#') + 1)) AS b_number,
              ${o}.repo AS repo, ${o}.number AS number, ${o}.head_oid AS head_oid
            FROM ${from}json_array_elements(${pgJsonArray(`${o}.blocked_by`)}) j
            WHERE json_typeof(j.value) = 'string' AND instr(${v}, '#') > 1) nb
          ${missing}`;
  }
  return `SELECT b_repo, b_number, repo, number, head_oid FROM (
            SELECT DISTINCT substr(j.value, 1, instr(j.value, '#') - 1) AS b_repo, CAST(substr(j.value, instr(j.value, '#') + 1) AS INTEGER) AS b_number,
              ${o}.repo AS repo, ${o}.number AS number, ${o}.head_oid AS head_oid
            FROM ${from}json_each(CASE WHEN json_valid(${o}.blocked_by) THEN CASE WHEN json_type(${o}.blocked_by) = 'array' THEN ${o}.blocked_by ELSE '[]' END ELSE '[]' END) j
            WHERE j.type = 'text' AND instr(j.value, '#') > 1) nb
          ${missing}`;
}

/** Statements that keep review_blockers in step with opus_reviews, per operation, with their conditions (also during a bulk write). */
export function blockerSync(dialect: Dialect): Record<Op, { cond: string; body: string }> {
  const conflict = dialect === "postgres" ? " ON CONFLICT DO NOTHING" : "";
  const changed = ["blocked_by", "repo", "number", "head_oid"].map((c) => `old.${c} ${dialect === "postgres" ? "IS DISTINCT FROM" : "IS NOT"} new.${c}`).join(" OR ");
  const insert = `INSERT INTO review_blockers (b_repo, b_number, repo, number, head_oid) ${blockerRows(dialect, "new")}${conflict};`;
  const remove = "DELETE FROM review_blockers WHERE repo = old.repo AND number = old.number AND head_oid = old.head_oid;";
  return {
    INSERT: { cond: "new.blocked_by IS NOT NULL", body: insert },
    DELETE: { cond: "old.blocked_by IS NOT NULL", body: remove },
    UPDATE: { cond: changed, body: `${remove}\n          ${insert}` },
  };
}

/** Fills review_blockers from every stored review (migration). */
export const blockerFill = (dialect: Dialect): string =>
  `INSERT INTO review_blockers (b_repo, b_number, repo, number, head_oid) ${blockerRows(dialect, "o", "opus_reviews o, ")}${dialect === "postgres" ? " ON CONFLICT DO NOTHING" : ""};`;

const on = (sql: string, alias: "new" | "old"): string => sql.replace(/\br\./g, `${alias}.`);

/** UPDATE condition of an input: its own, or a change to a watched column. Null: every UPDATE counts. */
function updateCondition(input: PlanInput, columns: Map<string, string[]> | undefined): string | null {
  if (input.updateWhen) return input.updateWhen;
  const skip = new Set(BOOKKEEPING_COLUMNS[input.table] ?? []);
  const watched = input.columns ?? columns?.get(input.table)?.filter((c) => !skip.has(c));
  return watched?.length ? watched.map((c) => `old."${c}" IS NOT new."${c}"`).join(" OR ") : null;
}

const and = (...parts: (string | null | undefined)[]): string => parts.filter((p): p is string => !!p).map((p) => `(${p})`).join(" AND ");

/**
 * One change-log trigger: an AFTER `op` on `table` that, when `cond` holds (empty: always), takes a full-pass mark named `full`
 * or logs the (repo, number) rows of the `refs` query. SQL is in the dialect it was made for; `new`/`old` name the rows.
 */
export type PlanTrigger = { name: string; table: string; op: Op; cond: string } & ({ full: string } | { refs: string });

/** The change log's triggers for `dialect`. With `columns`, an UPDATE trigger fires only when a watched column changed, as the live triggers do (src/db/live.ts). */
export function planTriggers(dialect: Dialect, columns?: Map<string, string[]>): PlanTrigger[] {
  const pg = dialect === "postgres";
  // A registry fragment in the dialect: its written Postgres form, or the SQLite one rewritten.
  const frag = (input: PlanInput, key: "refs" | "when" | "full" | "fullUpdate" | "updateWhen"): string | undefined => {
    const v = input[key];
    if (v === undefined || !pg) return v;
    return input.pg?.[key] ?? pgExpr(v);
  };
  const out: PlanTrigger[] = [];
  const seen = new Map<string, number>();
  for (const input of planInputs()) {
    if (input.class === "none") continue;
    const n = seen.get(input.table) ?? 0;
    seen.set(input.table, n + 1);
    const base = `plan_${input.table}${n ? `_${n}` : ""}`;
    const inputWhen = frag(input, "when");
    const fullUpdate = frag(input, "fullUpdate");
    const fullRow = input.class === "global" ? (pg ? "true" : "1") : frag(input, "full");
    for (const op of OPS) {
      const rows: ("new" | "old")[] = op === "INSERT" ? ["new"] : op === "DELETE" ? ["old"] : ["old", "new"];
      const when = inputWhen ? rows.map((a) => `(${on(inputWhen, a)})`).join(" OR ") : null;
      let upd = op === "UPDATE" ? updateCondition(input, columns) : null;
      if (upd && pg) upd = input.updateWhen ? frag(input, "updateWhen")! : pgExpr(upd);
      // Full pass.
      if (fullRow || (op === "UPDATE" && fullUpdate)) {
        const cond = op === "UPDATE" && fullUpdate ? and(fullUpdate, when)
          : and(upd, rows.map((a) => `(${on(fullRow!, a)})`).join(" OR "), when);
        const name = `${base}_full_${op[0]!.toLowerCase()}`;
        out.push({ name, table: input.table, op, cond, full: name });
      }
      // Affected items.
      if (input.class === "global" || (input.class === "cross" && !input.refs)) continue;
      const refs = frag(input, "refs") ?? "SELECT r.repo AS repo, r.number AS number";
      const select = rows.map((a, i) => `SELECT repo, number FROM (${on(refs, a)}) AS s${i}${inputWhen ? ` WHERE ${on(inputWhen, a)}` : ""}`).join(" UNION ");
      out.push({ name: `${base}_${op[0]!.toLowerCase()}`, table: input.table, op, cond: and(upd, when), refs: select });
    }
  }
  return out;
}

/** The change log's tables and indexes (SQLite; src/db/pg-triggers.ts translates them). */
export const PLAN_TABLES = [
  "CREATE TABLE IF NOT EXISTS main.item_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, number INTEGER NOT NULL);",
  // `seq` is the full-pass generation.
  "CREATE TABLE IF NOT EXISTS main.plan_full (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL);",
  // Full-pass marks per trigger: which inputs force full passes. last_seq is the generation of the latest mark.
  "CREATE TABLE IF NOT EXISTS main.plan_full_causes (source TEXT PRIMARY KEY, n INTEGER NOT NULL, last_seq INTEGER NOT NULL);",
  // The incremental planner's own records (src/core/plan-engine.ts); no trigger reads them.
  "CREATE TABLE IF NOT EXISTS main.plan_shadow_diffs (at TEXT NOT NULL, ref TEXT NOT NULL, side TEXT NOT NULL, fields TEXT NOT NULL, detail TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS main.plan_pass_stats (kind TEXT PRIMARY KEY, passes INTEGER NOT NULL, refs INTEGER NOT NULL, last_at TEXT NOT NULL, ms INTEGER NOT NULL DEFAULT 0, max_ms INTEGER NOT NULL DEFAULT 0);",
  // The blocker refs of every stored review, so a write to a blocking item finds the PRs held for it with an index lookup.
  "CREATE TABLE IF NOT EXISTS main.review_blockers (b_repo TEXT NOT NULL, b_number INTEGER NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL, head_oid TEXT NOT NULL, PRIMARY KEY (b_repo, b_number, repo, number, head_oid)) WITHOUT ROWID;",
  "CREATE INDEX IF NOT EXISTS main.review_blockers_review ON review_blockers(repo, number, head_oid);",
  // The pairs of an item as either item, with the verdict: covering, so SQLite looks them up instead of scanning a repo's range
  // of the primary key (it has no statistics to tell the two apart).
  "CREATE INDEX IF NOT EXISTS main.duplicate_pairs_a ON duplicate_pairs(repo, a, b, verdict);",
  "CREATE INDEX IF NOT EXISTS main.duplicate_pairs_b ON duplicate_pairs(repo, b, a, verdict);",
];

/**
 * DDL for the log, the marker and the triggers (SQLite). Idempotent: every `plan_` trigger is rebuilt. With `db`, an UPDATE
 * trigger fires only when a watched column changed. Postgres gets the same triggers from src/db/pg-triggers.ts.
 */
export function planChangesSql(db?: DatabaseSync): string {
  const out = [
    ...PLAN_TABLES,
    "INSERT OR IGNORE INTO main.plan_full (id, seq) VALUES (1, 0);",
    // Present only inside a bulk write's transaction (bulkWrites).
    "CREATE TABLE IF NOT EXISTS main.plan_bulk (id INTEGER PRIMARY KEY CHECK (id = 1));",
    "DELETE FROM main.plan_bulk;",
    "DELETE FROM main.review_blockers;",
    blockerFill("sqlite").replace("INSERT INTO review_blockers", "INSERT INTO main.review_blockers").replace("opus_reviews o, ", "main.opus_reviews o, "),
  ];
  if (db) {
    for (const { name } of db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'trigger' AND name LIKE 'plan\\_%' ESCAPE '\\'").all() as { name: string }[]) out.push(`DROP TRIGGER IF EXISTS main.${name};`);
  }
  // review_blockers follows opus_reviews, also during a bulk write.
  const sync = blockerSync("sqlite");
  for (const op of OPS) {
    const name = `plan_blockers_${op[0]!.toLowerCase()}`;
    out.push(`DROP TRIGGER IF EXISTS main.${name};`);
    out.push(`CREATE TRIGGER main.${name} AFTER ${op === "UPDATE" ? "UPDATE OF repo, number, head_oid, blocked_by" : op} ON opus_reviews WHEN ${sync[op].cond} BEGIN
          ${sync[op].body}
        END;`);
  }
  for (const t of planTriggers("sqlite", db ? columnsOf(db) : undefined)) {
    const body = "full" in t ? markFull(t.full) : `INSERT INTO item_changes (repo, number) SELECT repo, number FROM (${t.refs}) WHERE repo IS NOT NULL AND number IS NOT NULL;`;
    out.push(`DROP TRIGGER IF EXISTS main.${t.name};`);
    out.push(`CREATE TRIGGER main.${t.name} AFTER ${t.op} ON ${t.table} WHEN ${and(t.cond, NOT_BULK)} BEGIN
          ${body}
        END;`);
  }
  return out.join("\n");
}
