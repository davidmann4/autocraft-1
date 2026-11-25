// The change log of the planner's inputs: triggers on every table of PLAN_INPUTS log the items a write re-decides in
// `item_changes`, or move the full-pass generation when the write changes facts of items the trigger cannot name. A planner
// reads the rows it has not read yet (changesSince) and later deletes exactly the rows it read (pruneChanges).
//
// The log is consumed by key, not by a seq cursor: on Postgres a seq is taken when the row is written and its transaction may
// commit after a later seq's, so "everything above the last seq read" would skip it. A pass reads the rows its snapshot holds,
// remembers their seqs, and deletes those seqs; a row that commits late is read by the next pass. Seqs never repeat (SQLite
// AUTOINCREMENT, a Postgres identity), so a remembered seq names one row.
//
// `plan_full` holds a generation that every full-pass mark moves; a planner compares it with the one its facts cover. On
// Postgres the mark moves it once per transaction at commit (src/db/pg-triggers.ts), on SQLite once per marking row.
import type { DatabaseSync } from "node:sqlite";
import { BOOKKEEPING_COLUMNS, columnsOf } from "../live.ts";
import { PLAN_INPUTS, type PlanInput } from "./plan-inputs.ts";
import { pgExpr, pgJsonArray } from "./pg-expr.ts";
import type { Db, Dialect } from "../db/index.ts";

/** More unread rows than this: a full pass costs less than re-deciding them one by one. */
export const CHANGES_CAP = 50_000;

/** What a planner's facts cover: the full-pass generation and the log rows read but not yet deleted. */
export type ChangeCursor = { gen: number; seen: Set<number> };

export type Changes = {
  /** Items whose facts may have changed, as "repo#number". Empty when `full`. */
  refs: string[];
  /** Every item must be decided again: a global or cross-item input changed, or the log passed CHANGES_CAP. */
  full: boolean;
  /** Why `full`: a full-pass mark, or more rows than CHANGES_CAP. */
  cause?: "marker" | "cap";
  /** What this answer covers: pass it to the next changesSince and to pruneChanges. When `full`, it covers every row read. */
  cursor: ChangeCursor;
};

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

/** The change log's triggers for `dialect`. With `columns`, an UPDATE trigger fires only when a watched column changed, as the live triggers do (src/live.ts). */
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
  for (const input of PLAN_INPUTS) {
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

/** The current full-pass generation (0 without a marker row). */
async function generation(db: Db): Promise<number> {
  return (await db.get(db.k.selectFrom("plan_full").select("seq").where("id", "=", 1)))?.seq ?? 0;
}

/** What a full pass that starts now covers: the generation and every logged row. Read it in the pass's snapshot. */
export async function changeCursor(db: Db): Promise<ChangeCursor> {
  const gen = await generation(db);
  const seqs = await db.all(db.k.selectFrom("item_changes").select("seq"));
  return { gen, seen: new Set(seqs.map((r) => r.seq)) };
}

/** What changed since `cursor`: the items to decide again, or `full`. Read it in the pass's snapshot. */
export async function changesSince(db: Db, cursor: ChangeCursor): Promise<Changes> {
  if (await generation(db) !== cursor.gen) return { refs: [], full: true, cause: "marker", cursor: await changeCursor(db) };
  // Rows read before and not yet deleted come back first; whatever the limit leaves out is read next time.
  const rows = await db.all(db.k.selectFrom("item_changes")
    .select((eb) => ["seq", eb(eb("repo", "||", eb.val("#")), "||", eb.cast<string>("number", "text")).as("ref")])
    .orderBy("seq").limit(cursor.seen.size + CHANGES_CAP + 1));
  const fresh = rows.filter((r) => !cursor.seen.has(r.seq));
  if (fresh.length > CHANGES_CAP) return { refs: [], full: true, cause: "cap", cursor: await changeCursor(db) };
  const seen = new Set(cursor.seen);
  for (const r of fresh) seen.add(r.seq);
  return { refs: [...new Set(fresh.map((r) => r.ref))], full: false, cursor: { gen: cursor.gen, seen } };
}

/** Ranges of consecutive seqs per DELETE statement. */
const PRUNE_RANGES = 200;

/**
 * Deletes the log rows `cursor` has read, and forgets them. Only those rows: one written before them that commits later stays
 * for the next read. The log has one consumer: the runner's planner (src/core/plan-engine.ts). A second consumer would lose
 * the rows the first one deleted; other readers take full passes.
 */
export async function pruneChanges(db: Db, cursor: ChangeCursor): Promise<void> {
  const seqs = [...cursor.seen].sort((a, b) => a - b);
  // Runs of consecutive seqs: a run holds no seq that was not read.
  const runs: [number, number][] = [];
  for (const q of seqs) {
    const last = runs.at(-1);
    if (last && q === last[1] + 1) last[1] = q; else runs.push([q, q]);
  }
  for (let i = 0; i < runs.length; i += PRUNE_RANGES) {
    const part = runs.slice(i, i + PRUNE_RANGES);
    await db.run(db.k.deleteFrom("item_changes").where((eb) => eb.or(part.map(([from, to]) => eb.between("seq", from, to)))));
  }
  for (const q of seqs) cursor.seen.delete(q);
}

/** Logs the PRs with a review at `head` of `repo`: for a write the triggers cannot see (a file the fact loaders read beside the database). */
export async function logReviewedAt(db: Db, repo: string, head: string): Promise<void> {
  await db.run(db.k.insertInto("item_changes").columns(["repo", "number"])
    .expression((eb) => eb.selectFrom("opus_reviews").select(["repo", "number"]).distinct().where("repo", "=", repo).where("head_oid", "=", head)));
}

/** A write of more rows than this goes through bulkWrites: one full-pass mark costs less than logging every row. */
export const BULK_ROWS = 500;

/** Turns the bulk marker on or off in the open write transaction; off also takes the full-pass mark for `source`. */
const bulk = {
  isOn: async (db: Db): Promise<boolean> => db.dialect === "postgres"
    ? (await db.get(db.k.selectNoFrom((eb) => eb.fn<string | null>("current_setting", [eb.val(PG_BULK), eb.lit(true)]).as("v"))))!.v === "1"
    : !!await db.get(db.k.selectFrom("plan_bulk").select((eb) => eb.lit(1).as("one"))),
  on: async (db: Db): Promise<void> => {
    if (db.dialect === "postgres") await db.get(db.k.selectNoFrom((eb) => eb.fn("set_config", [eb.val(PG_BULK), eb.val("1"), eb.lit(true)]).as("v")));
    else await db.run(db.k.insertInto("plan_bulk").values({ id: 1 }));
  },
  off: async (db: Db, source: string): Promise<void> => {
    if (db.dialect === "postgres") {
      await db.get(db.k.selectNoFrom((eb) => eb.fn("set_config", [eb.val(PG_BULK), eb.val(""), eb.lit(true)]).as("v")));
      await db.get(db.k.selectNoFrom((eb) => eb.fn("ac_mark_full", [eb.val(`bulk:${source}`)]).as("v")));
    } else {
      await db.run(db.k.deleteFrom("plan_bulk"));
      await markFullNow(db, `bulk:${source}`);
    }
  },
};

/** markFull() run as statements, for SQLite. */
async function markFullNow(db: Db, source: string): Promise<void> {
  await db.run(db.k.insertInto("plan_full").columns(["id", "seq"])
    .expression(db.k.selectNoFrom((eb) => [eb.lit(1).as("id"), eb.lit(0).as("seq")])
      .where((eb) => eb.not(eb.exists(eb.selectFrom("plan_full").select(eb.lit(1).as("one")).where("id", "=", 1))))));
  await db.run(db.k.updateTable("plan_full").set((eb) => ({ seq: eb("seq", "+", 1) })).where("id", "=", 1));
  await db.run(db.k.insertInto("plan_full_causes")
    .values((eb) => ({ source, n: 1, last_seq: eb.fn.coalesce(eb.selectFrom("plan_full").select("seq").where("id", "=", 1), eb.lit(0)) }))
    .onConflict((oc) => oc.column("source").doUpdateSet((eb) => ({ n: eb("plan_full_causes.n", "+", 1), last_seq: eb.ref("excluded.last_seq") }))));
}

/**
 * Runs `fn` with the logging triggers off and takes one full-pass mark for `source`, in the caller's transaction or one of its
 * own. The marker (a row on SQLite, a transaction-local setting on Postgres) exists only inside that transaction, so other
 * connections never see the triggers off.
 */
export async function bulkWrites<T>(db: Db, source: string, fn: () => Promise<T>): Promise<T> {
  const own = !db.inTransaction();
  return await db.write(async () => {
    const nested = await bulk.isOn(db);
    try {
      if (!nested) await bulk.on(db);
      const out = await fn();
      if (!nested) await bulk.off(db, source);
      return out;
    } catch (e) {
      // A transaction of its own rolls the marker back; the caller's goes on, so the marker goes now. On Postgres a failed
      // statement has aborted the caller's transaction (or the savepoint around it, which undoes the marker), so this may fail.
      if (!own && !nested) await bulk.off(db, source).catch(() => undefined);
      throw e;
    }
  });
}
