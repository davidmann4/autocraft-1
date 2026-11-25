// The item snapshot: a read-only SQLite file with only GitHub-sourced data
// (items, comments, reviews, their full-text index, item embeddings) plus the
// outcome of each decision (kind, chosen option, date). Sandboxed model calls
// read it through the item tools (src/itemtools/server). Nothing written on the
// dashboard (notes, opinions, comments), no settings, audit, accounts, access
// lists, tokens or host paths goes in. Only public repositories are copied.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { dataDir } from "../db.ts";
import type { ExpressionBuilder, Kysely, RawBuilder, SelectQueryBuilder } from "kysely";
import type { Db } from "../db/index.ts";
import { connectDb, dbTarget, isPgUrl } from "../db/open.ts";
import * as kx from "../db/kx.ts";
import { sql } from "../db/sql.ts";
import { envVar } from "../env.ts";

export function snapshotDir(): string {
  return envVar("SNAPSHOT_DIR") ?? join(dataDir(), "item-snapshot");
}
export const snapshotFile = (): string => join(snapshotDir(), "items.db");

/** The SQLite database the snapshot is copied from: the configured one. */
function snapshotSource(): string {
  const target = dbTarget();
  if (isPgUrl(target)) throw new Error("the configured database is Postgres: build the snapshot with buildSnapshot(), which reads it through a Db handle");
  return target;
}

const ITEM_COLUMNS = ["repo", "number", "kind", "state", "title", "body", "url", "author", "author_association", "created_at", "updated_at",
  "closed_at", "merged_at", "state_reason", "is_draft", "labels", "comments_count", "additions", "deletions", "changed_files",
  "head_ref", "head_oid", "head_repo", "base_ref", "review_decision", "mergeable", "ci_state"];
const COMMENT_COLUMNS = ["id", "repo", "number", "kind", "author", "created_at", "body", "review_state", "commit_oid", "url"];

/** Bumped when the snapshot's tables change; a file with another version is rebuilt. */
export const SCHEMA_VERSION = "4";

const cols = (names: string[], types: Record<string, string> = {}) => names.map((c) => `${c} ${types[c] ?? ""}`.trim()).join(", ");

// The full-text index follows the rows through triggers, so refreshing is plain inserts and deletes.
const DDL = `
CREATE TABLE items (${cols(ITEM_COLUMNS, { repo: "TEXT NOT NULL", number: "INTEGER NOT NULL" })}, PRIMARY KEY (repo, number));
CREATE TABLE comments (${cols(COMMENT_COLUMNS, { id: "TEXT PRIMARY KEY", number: "INTEGER NOT NULL" })});
CREATE INDEX comments_item ON comments(repo, number);
CREATE TABLE item_embeddings (repo TEXT NOT NULL, number INTEGER NOT NULL, model TEXT NOT NULL, at TEXT, vec BLOB NOT NULL, PRIMARY KEY (repo, number));
CREATE TABLE decision_outcomes (repo TEXT NOT NULL, number INTEGER NOT NULL, kind TEXT NOT NULL, answer TEXT NOT NULL, answer_label TEXT, answered_at TEXT);
CREATE INDEX decision_outcomes_item ON decision_outcomes(repo, number);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE item_src (repo TEXT NOT NULL, number INTEGER NOT NULL, h TEXT NOT NULL, PRIMARY KEY (repo, number)) WITHOUT ROWID;
CREATE TABLE comment_src (id TEXT PRIMARY KEY, h TEXT NOT NULL) WITHOUT ROWID;
CREATE VIRTUAL TABLE items_fts USING fts5(title, body, content='items', content_rowid='rowid', tokenize='porter unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE comments_fts USING fts5(body, content='comments', content_rowid='rowid', tokenize='porter unicode61 remove_diacritics 2');
CREATE TRIGGER items_fts_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts (rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER items_fts_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts (items_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER comments_fts_ai AFTER INSERT ON comments BEGIN
  INSERT INTO comments_fts (rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER comments_fts_ad AFTER DELETE ON comments BEGIN
  INSERT INTO comments_fts (comments_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;
`;

const KEY = /^[A-Za-z0-9_.-]{1,60}$/;

type DecisionRow = { kind: string; repo: string | null; number: number | null; items: string | null; options: string; answer: string; exceptions: string | null; answered_at: string | null };

function outcomes(rows: DecisionRow[]): { repo: string; number: number; kind: string; answer: string; label: string | null; at: string | null }[] {
  const out: { repo: string; number: number; kind: string; answer: string; label: string | null; at: string | null }[] = [];
  const parse = <T>(s: string | null): T | null => {
    try { return s ? (JSON.parse(s) as T) : null; } catch { return null; }
  };
  for (const r of rows) {
    const options = parse<{ key?: unknown; label?: unknown }[]>(r.options) ?? [];
    const labelOf = (k: string) => {
      const o = options.find((x) => x.key === k);
      return o && typeof o.label === "string" ? o.label.slice(0, 120) : null;
    };
    const push = (repo: string, number: number, answer: string) => {
      // Only a chosen option's key goes in: an answer that is not a plain key could be free text.
      if (!KEY.test(answer) || !Number.isInteger(number)) return;
      out.push({ repo, number, kind: r.kind, answer, label: labelOf(answer), at: r.answered_at });
    };
    if (r.repo && r.number !== null) push(r.repo, r.number, r.answer);
    else {
      const ex = new Map((parse<{ repo: string; number: number; answer: string }[]>(r.exceptions) ?? []).map((e) => [`${e.repo}#${e.number}`, e.answer]));
      for (const it of parse<{ repo: string; number: number }[]>(r.items) ?? []) push(it.repo, it.number, ex.get(`${it.repo}#${it.number}`) ?? r.answer);
    }
  }
  return out;
}

export type SnapshotStats = { items: number; comments: number; bytes: number; rebuilt: boolean; changed: { items: number; comments: number; embeddings: number } };

const differs = (a: string, b: string, names: string[]) => names.filter((c) => c !== "id").map((c) => `${a}.${c} IS NOT ${b}.${c}`).join(" OR ");

/**
 * Brings the snapshot at `dest` up to date with the mirror at `src`: rows
 * added, changed or gone since the last refresh are applied in one
 * transaction, so a refresh that finds nothing new writes nothing. The file is
 * built from scratch (in a temporary file renamed into place) only when it is
 * missing or has another schema version. Only repositories with visibility
 * `public` are copied. The source is only read.
 */
export function writeSnapshot(src: string = snapshotSource(), dest: string = snapshotFile()): SnapshotStats {
  mkdirSync(dirname(dest), { recursive: true });
  recoverJournal(dest);
  let rebuilt = false;
  let target = dest;
  if (!existsSync(dest) || !hasVersion(dest)) {
    rebuilt = true;
    target = tmpFile(dest);
    rmSync(target, { force: true });
    const fresh = new DatabaseSync(target);
    fresh.exec("PRAGMA journal_mode=DELETE");
    fresh.exec(DDL);
    fresh.prepare("INSERT INTO meta VALUES ('schema', ?)").run(SCHEMA_VERSION);
    fresh.close();
  }
  const db = new DatabaseSync(target, { timeout: 30_000 });
  try {
    db.prepare("ATTACH DATABASE ? AS src").run(`file:${encodeURI(src).replace(/\?/g, "%3F").replace(/#/g, "%23")}?mode=ro`);
    const changed = { items: 0, comments: 0, embeddings: 0 };
    // A plain BEGIN: the comparison below only reads, so it holds no write lock; the lock is taken by the first write.
    db.exec("BEGIN");
    const pub = "repo IN (SELECT name FROM src.repos WHERE visibility = 'public')";
    db.exec(`CREATE TEMP VIEW pub_items AS SELECT * FROM src.items WHERE ${pub}`);
    // A review still pending is the author's draft and is not public.
    db.exec(`CREATE TEMP VIEW pub_comments AS SELECT * FROM src.comments WHERE ${pub} AND (review_state IS NULL OR review_state <> 'PENDING')`);
    db.exec(`CREATE TEMP VIEW pub_embeddings AS SELECT * FROM src.item_embeddings WHERE ${pub}`);
    // Compare first (reads only), then apply what differs.
    // Items: the new or changed ones are replaced as a whole; the gone ones are deleted.
    db.exec(`CREATE TEMP TABLE chg AS SELECT s.repo, s.number FROM pub_items s LEFT JOIN main.items m ON m.repo = s.repo AND m.number = s.number
      WHERE m.number IS NULL OR ${differs("m", "s", ITEM_COLUMNS)}`);
    db.exec(`CREATE TEMP TABLE gone AS SELECT repo, number FROM main.items WHERE (repo, number) NOT IN (SELECT repo, number FROM pub_items)`);
    const count = (...tables: string[]) => (db.prepare(`SELECT ${tables.map((t) => `(SELECT COUNT(*) FROM ${t})`).join(" + ")} AS n`).get() as { n: number }).n;
    changed.items = count("chg", "gone");
    // Comments and reviews, by id.
    const cc = COMMENT_COLUMNS.filter((c) => c !== "id");
    db.exec(`CREATE TEMP TABLE cchg AS SELECT s.id FROM pub_comments s LEFT JOIN main.comments m ON m.id = s.id WHERE m.id IS NULL OR ${differs("m", "s", cc)}`);
    db.exec("CREATE TEMP TABLE cgone AS SELECT id FROM main.comments WHERE id NOT IN (SELECT id FROM pub_comments)");
    changed.comments = count("cchg", "cgone");
    // Embeddings, by item and write time.
    db.exec(`CREATE TEMP TABLE echg AS SELECT s.repo, s.number FROM pub_embeddings s LEFT JOIN main.item_embeddings m ON m.repo = s.repo AND m.number = s.number
      WHERE m.number IS NULL OR m.at IS NOT s.at OR m.model IS NOT s.model`);
    db.exec("CREATE TEMP TABLE egone AS SELECT repo, number FROM main.item_embeddings WHERE (repo, number) NOT IN (SELECT repo, number FROM pub_embeddings)");
    changed.embeddings = count("echg", "egone");
    // Decision outcomes are few: replaced when the set differs. After the apply step below main.items equals pub_items.
    const rows = db.prepare(`SELECT kind, repo, number, items, options, answer, exceptions, answered_at FROM src.decisions
      WHERE answer IS NOT NULL AND answered_at IS NOT NULL`).all() as unknown as DecisionRow[];
    const have = new Set((db.prepare("SELECT repo, number FROM pub_items").all() as { repo: string; number: number }[]).map((r) => `${r.repo}#${r.number}`));
    const want = outcomes(rows).filter((o) => have.has(`${o.repo}#${o.number}`)).map((o) => [o.repo, o.number, o.kind, o.answer, o.label, o.at] as const);
    const key = (xs: readonly (readonly unknown[])[]) => JSON.stringify([...xs].map((x) => JSON.stringify(x)).sort());
    const current = (db.prepare("SELECT repo, number, kind, answer, answer_label, answered_at FROM main.decision_outcomes").all() as Record<string, unknown>[]).map((r) => Object.values(r));
    const outcomesDiffer = key(want) !== key(current);
    if (outcomesDiffer) changed.items += 1;

    if (changed.items || changed.comments || changed.embeddings) {
      if (count("chg", "gone")) {
        db.exec("DELETE FROM main.items WHERE (repo, number) IN (SELECT repo, number FROM chg) OR (repo, number) IN (SELECT repo, number FROM gone)");
        db.exec(`INSERT INTO main.items (${ITEM_COLUMNS.join(",")}) SELECT ${ITEM_COLUMNS.map((c) => `s.${c}`).join(",")} FROM pub_items s JOIN chg USING (repo, number)`);
      }
      if (changed.comments) {
        db.exec("DELETE FROM main.comments WHERE id IN (SELECT id FROM cchg) OR id IN (SELECT id FROM cgone)");
        db.exec(`INSERT INTO main.comments (${COMMENT_COLUMNS.join(",")}) SELECT ${COMMENT_COLUMNS.map((c) => `s.${c}`).join(",")} FROM pub_comments s JOIN cchg USING (id)`);
      }
      if (changed.embeddings) {
        db.exec("DELETE FROM main.item_embeddings WHERE (repo, number) IN (SELECT repo, number FROM echg) OR (repo, number) IN (SELECT repo, number FROM egone)");
        db.exec("INSERT INTO main.item_embeddings (repo, number, model, at, vec) SELECT s.repo, s.number, s.model, s.at, s.vec FROM pub_embeddings s JOIN echg USING (repo, number)");
      }
      if (outcomesDiffer) {
        db.exec("DELETE FROM main.decision_outcomes");
        const ins = db.prepare("INSERT INTO main.decision_outcomes (repo, number, kind, answer, answer_label, answered_at) VALUES (?,?,?,?,?,?)");
        for (const w of want) ins.run(...w);
      }
      db.prepare("INSERT OR REPLACE INTO meta VALUES ('refreshed_at', ?)").run(new Date().toISOString());
    }
    const n = (t: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM main.${t}`).get() as { n: number }).n);
    const counts = { items: n("items"), comments: n("comments") };
    db.exec("COMMIT");
    db.close();
    if (rebuilt) {
      dropJournal(dest);
      renameSync(target, dest);
    }
    return { ...counts, bytes: statSync(dest).size, rebuilt, changed };
  } catch (e) {
    try { db.close(); } catch { /* already closed */ }
    if (rebuilt) rmSync(target, { force: true });
    throw e;
  }
}

const INTEGER_COLUMNS = new Set(["number", "is_draft", "comments_count", "additions", "deletions", "changed_files"]);
const PAGE = 2000;

/** A Postgres bigint may arrive as a string or bigint; the snapshot stores integers. */
const cell = (name: string, v: unknown): SQLInputValue => (INTEGER_COLUMNS.has(name) && v !== null && v !== undefined ? Number(v) : (v ?? null) as SQLInputValue);

/** The change topics whose counters cover the copied rows: repository visibility, items and comments, decisions. */
const SEQ_TOPICS = ["decisions", "items", "repos"] as const;
type Seqs = Record<string, number>;

/**
 * A table copied from Postgres. `hash` is a Postgres expression over the copied columns (except the key); `local` selects
 * each snapshot row's key and the hash it was copied with (null when unknown, which counts as changed); `hashes` is the
 * snapshot table that stores the hashes, when the copied table does not carry them itself.
 */
type PgTable = {
  name: "items" | "comments" | "item_embeddings";
  columns: readonly string[];
  key: readonly string[];
  hash: () => RawBuilder<string>;
  local: string;
  hashes: string | null;
  pending: boolean;
};

const md5Row = (columns: readonly string[]) => (): RawBuilder<string> =>
  sql<string>`md5(row(${sql.join(columns.filter((c) => c !== "id").map((c) => sql.ref(c)))})::text)`;

const PG_TABLES: readonly PgTable[] = [
  { name: "items", columns: ITEM_COLUMNS, key: ["repo", "number"], hash: md5Row(ITEM_COLUMNS), pending: false, hashes: "item_src",
    local: "SELECT i.repo, i.number, s.h FROM main.items i LEFT JOIN main.item_src s ON s.repo = i.repo AND s.number = i.number" },
  // A review still pending is the author's draft and is not public.
  { name: "comments", columns: COMMENT_COLUMNS, key: ["id"], hash: md5Row(COMMENT_COLUMNS), pending: true, hashes: "comment_src",
    local: "SELECT c.id, s.h FROM main.comments c LEFT JOIN main.comment_src s ON s.id = c.id" },
  // A vector is rewritten with a new write time, so model and time identify it.
  { name: "item_embeddings", columns: ["repo", "number", "model", "at", "vec"], key: ["repo", "number"], pending: false, hashes: null,
    hash: () => sql<string>`model || '|' || at`, local: "SELECT repo, number, model || '|' || at AS h FROM main.item_embeddings" },
];

/** An incremental refresh that would rewrite more rows of a table than this (and more than half of them) rebuilds the file instead. */
const LARGE_DELTA = 20_000;

/**
 * Inserts rows into `table` several per statement: one prepared statement for full groups, another for the remainder.
 * Call `flush` after the last row.
 */
function inserter(out: DatabaseSync, table: string, columns: readonly string[]): { add: (values: SQLInputValue[]) => void; flush: () => void } {
  const per = Math.max(1, Math.min(100, Math.floor(999 / columns.length)));
  const tuple = `(${columns.map(() => "?").join(",")})`;
  const stmt = (n: number) => out.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES ${Array.from({ length: n }, () => tuple).join(",")}`);
  const full = stmt(per);
  let buf: SQLInputValue[] = [];
  let n = 0;
  return {
    add: (values) => {
      buf.push(...values);
      if (++n === per) {
        full.run(...buf);
        buf = [];
        n = 0;
      }
    },
    flush: () => {
      if (n) stmt(n).run(...buf);
      buf = [];
      n = 0;
    },
  };
}

// The tables are named at run time, so the queries go through an untyped view of the handle's Kysely.
const anyK = (db: Db): Kysely<any> => db.k as unknown as Kysely<any>;

async function readSeqs(db: Db): Promise<Seqs> {
  const out: Seqs = {};
  for (const r of await db.all(db.k.selectFrom("change_seq").select(["topic", "seq"]).where("topic", "in", [...SEQ_TOPICS]))) out[r.topic] = Number(r.seq);
  return out;
}

/** The public rows of `t` with `select` added, keyset-paged by its key in pages of `size`. */
async function* pgPages(db: Db, t: PgTable, select: (q: SelectQueryBuilder<any, any, any>) => SelectQueryBuilder<any, any, any>, size: number): AsyncGenerator<Record<string, unknown>[]> {
  let last: (string | number)[] | null = null;
  for (;;) {
    const after = last;
    const q = select(anyK(db).selectFrom(t.name))
      .where("repo", "in", (eb: ExpressionBuilder<any, any>) => eb.selectFrom("repos").select("name").where("visibility", "=", "public"))
      .$if(t.pending, (q) => q.where((eb) => eb.or([eb("review_state", "is", null), eb("review_state", "<>", "PENDING")])))
      .$if(after !== null, (q) => q.where((eb) => (t.key.length === 1 ? eb(t.key[0]!, ">", after![0]) : eb(eb.refTuple(t.key[0]!, t.key[1]!), ">", eb.tuple(after![0]!, after![1]!)))))
      .$call((q) => t.key.reduce((o, k) => o.orderBy(k), q))
      .limit(size);
    const rows = (await db.all(q)) as Record<string, unknown>[];
    if (rows.length) yield rows;
    if (rows.length < size) return;
    const lr = rows[rows.length - 1]!;
    last = t.key.map((k) => (INTEGER_COLUMNS.has(k) ? Number(lr[k]) : String(lr[k])));
  }
}

/** Writes rows read from Postgres (the copied columns and `h`) into the snapshot table of `t` and its hash table, or with `into` another schema's prefix, into one staging table `<into><name>` with `h` as its last column. */
function writer(out: DatabaseSync, t: PgTable, into: string): { add: (rows: Record<string, unknown>[]) => void; flush: () => void } {
  if (into !== "main.") {
    const all = inserter(out, `${into}${t.name}`, [...t.columns, "h"]);
    return { add: (rs) => rs.forEach((r) => all.add([...t.columns.map((c) => cell(c, r[c])), r.h as SQLInputValue])), flush: all.flush };
  }
  const rows = inserter(out, `main.${t.name}`, t.columns);
  const hashes = t.hashes ? inserter(out, `main.${t.hashes}`, [...t.key, "h"]) : null;
  return {
    add: (rs) => {
      for (const r of rs) {
        rows.add(t.columns.map((c) => cell(c, r[c])));
        hashes?.add([...t.key.map((c) => cell(c, r[c])), r.h as string]);
      }
    },
    flush: () => (rows.flush(), hashes?.flush()),
  };
}

type Decisions = DecisionRow[];

/** The answered decisions, for the outcomes of the items in the snapshot. */
async function readDecisions(db: Db): Promise<Decisions> {
  const rows = await db.all(db.k.selectFrom("decisions").select(["kind", "repo", "number", "items", "options", "answer", "exceptions", "answered_at"])
    .where("answer", "is not", null).where("answered_at", "is not", null));
  return rows.map((r) => ({ ...r, answer: r.answer!, number: r.number === null ? null : Number(r.number) }));
}

/** Replaces the decision outcomes of the items in the snapshot when they differ from `rows`'; true when replaced. */
function applyOutcomes(out: DatabaseSync, rows: Decisions): boolean {
  const have = new Set((out.prepare("SELECT repo, number FROM main.items").all() as { repo: string; number: number }[]).map((r) => `${r.repo}#${r.number}`));
  const want = outcomes(rows).filter((o) => have.has(`${o.repo}#${o.number}`)).map((o) => [o.repo, o.number, o.kind, o.answer, o.label, o.at] as const);
  const key = (xs: readonly (readonly unknown[])[]) => JSON.stringify([...xs].map((x) => JSON.stringify(x)).sort());
  const current = (out.prepare("SELECT repo, number, kind, answer, answer_label, answered_at FROM main.decision_outcomes").all() as Record<string, unknown>[]).map((r) => Object.values(r));
  if (key(want) === key(current)) return false;
  out.exec("DELETE FROM main.decision_outcomes");
  const ins = inserter(out, "main.decision_outcomes", ["repo", "number", "kind", "answer", "answer_label", "answered_at"]);
  for (const w of want) ins.add([...w]);
  ins.flush();
  return true;
}

/** Which database the counters belong to: a database recreated or copied into a new one has another oid. */
async function readSource(db: Db): Promise<string> {
  const r = await db.get(anyK(db).selectFrom("pg_database").select([sql<string>`current_database()`.as("name"), sql<string>`oid::text`.as("oid")])
    .where("datname", "=", sql<string>`current_database()`));
  return `${String(r?.name)}:${String(r?.oid)}`;
}

/** What a refresh stored about its source: the database, its change counters, and when every row was last compared. */
type SourceMark = { source: string; seqs: Seqs; comparedAt: string };

/** Items and comments are compared in full at least this often, whatever the counters say. */
const FULL_COMPARE_MS = 24 * 3600_000;

const countOf = (out: DatabaseSync, table: string): number => Number((out.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

/**
 * Brings the snapshot at `dest` up to date from a Db handle (the Postgres app database). Every row copied carries a hash
 * of its columns (embeddings: model and write time); a refresh compares the public rows' keys and hashes with the
 * file's and rewrites only the rows added, changed or gone, in one transaction. Items and comments are compared only
 * when the change counters of their topics moved since the last refresh, so a refresh after an embed run reads keys
 * and hashes of the embeddings alone; they are compared regardless when a counter went down (a restore, a copy), the
 * database is another one, or the last such compare is a day old. The file is built from scratch (in a temporary file renamed into place) when it
 * is missing, has another schema version, or the change is too large to apply row by row. All reads share one snapshot.
 */
export async function writeSnapshotFromDb(db: Db, dest: string = snapshotFile(), pageSize: number = PAGE): Promise<SnapshotStats> {
  mkdirSync(dirname(dest), { recursive: true });
  recoverJournal(dest);
  if (existsSync(dest) && hasVersion(dest)) {
    const r = await refreshFromDb(db, dest, pageSize);
    if (r) return r;
  }
  return rebuildFromDb(db, dest, pageSize);
}

/** The incremental refresh; null when the change is large enough that a rebuild is cheaper. */
async function refreshFromDb(db: Db, dest: string, pageSize: number): Promise<SnapshotStats | null> {
  const out = new DatabaseSync(dest, { timeout: 30_000 });
  try {
    const stored = storedMark(out);
    const changed = { items: 0, comments: 0, embeddings: 0 };
    // A plain BEGIN: everything read from Postgres goes into temp tables first, so the write lock on the file is taken
    // only by the apply step at the end, which does local work alone.
    out.exec("BEGIN");
    let mark: SourceMark = { source: "", seqs: {}, comparedAt: stored?.comparedAt ?? "" };
    let large = false;
    let decisions: Decisions | null = null;
    const deltas: { t: PgTable; n: number }[] = [];
    await db.read(async () => {
      mark = { ...mark, source: await readSource(db), seqs: await readSeqs(db) };
      const moved = (t: string) => stored?.seqs[t] !== mark.seqs[t];
      // Counters that went down, another database or an old full compare: the counters say nothing, so compare every row.
      const full = !stored || stored.source !== mark.source || SEQ_TOPICS.some((t) => (mark.seqs[t] ?? 0) < (stored.seqs[t] ?? 0))
        || !(Date.now() - Date.parse(stored.comparedAt) < FULL_COMPARE_MS);
      const rowsMoved = full || moved("items") || moved("repos");
      // Comparing items and comments compares all of them.
      if (rowsMoved) mark.comparedAt = new Date().toISOString();
      for (const t of PG_TABLES) {
        if (t.name !== "item_embeddings" && !rowsMoved) continue;
        const keys = t.key.join(", ");
        const on = t.key.map((k) => `l.${k} = p.${k}`).join(" AND ");
        for (const x of [`pg_${t.name}`, `chg_${t.name}`, `new_${t.name}`]) out.exec(`DROP TABLE IF EXISTS temp.${x}`);
        out.exec(`CREATE TEMP TABLE pg_${t.name} (${keys}, h, PRIMARY KEY (${keys}))`);
        const stage = inserter(out, `temp.pg_${t.name}`, [...t.key, "h"]);
        for await (const rows of pgPages(db, t, (q) => q.select([...t.key.map((k) => sql.ref(k).as(k)), t.hash().as("h")]), pageSize * 10)) {
          for (const r of rows) stage.add([...t.key.map((k) => cell(k, r[k])), r.h as string]);
        }
        stage.flush();
        // The keys to delete: changed rows (rewritten from new_*) and rows no longer public or present.
        out.exec(`CREATE TEMP TABLE chg_${t.name} AS
          SELECT p.${t.key.join(", p.")}, 1 AS refetch FROM temp.pg_${t.name} p LEFT JOIN (${t.local}) l ON ${on} WHERE l.h IS NULL OR l.h <> p.h
          UNION ALL SELECT l.${t.key.join(", l.")}, 0 FROM (${t.local}) l WHERE NOT EXISTS (SELECT 1 FROM temp.pg_${t.name} p WHERE ${on})`);
        const n = countOf(out, `temp.chg_${t.name}`);
        if (n > LARGE_DELTA && n * 2 > countOf(out, `temp.pg_${t.name}`)) {
          large = true;
          return;
        }
        if (!n) continue;
        deltas.push({ t, n });
        out.exec(`CREATE TEMP TABLE new_${t.name} (${t.columns.join(", ")}, h)`);
        const fetch = out.prepare(`SELECT ${keys} FROM temp.chg_${t.name} WHERE refetch = 1`).all() as Record<string, string | number>[];
        const w = writer(out, t, "temp.new_");
        for (let i = 0; i < fetch.length; i += kx.BATCH_ROWS) {
          const chunk = fetch.slice(i, i + kx.BATCH_ROWS);
          const where = t.key.length === 1
            ? kx.inList(db, sql.ref(t.key[0]!), chunk.map((r) => r[t.key[0]!]!))
            : kx.refIn(db, t.name, chunk.map((r) => [String(r.repo), Number(r.number)] as const));
          w.add((await db.all(anyK(db).selectFrom(t.name).select([...t.columns.map((c) => sql.ref(c).as(c)), t.hash().as("h")]).where(where))) as Record<string, unknown>[]);
        }
        w.flush();
      }
      if (rowsMoved || moved("decisions")) decisions = await readDecisions(db);
    });
    if (large) {
      out.exec("ROLLBACK");
      return null;
    }
    // The apply step: synchronous, from the temp tables.
    for (const { t, n } of deltas) {
      changed[t.name === "item_embeddings" ? "embeddings" : t.name] = n;
      const keys = t.key.join(", ");
      const keyIn = `(${keys}) IN (SELECT ${keys} FROM temp.chg_${t.name})`;
      out.exec(`DELETE FROM main.${t.name} WHERE ${keyIn}`);
      out.exec(`INSERT INTO main.${t.name} (${t.columns.join(", ")}) SELECT ${t.columns.join(", ")} FROM temp.new_${t.name}`);
      if (t.hashes) {
        out.exec(`DELETE FROM main.${t.hashes} WHERE ${keyIn}`);
        out.exec(`INSERT INTO main.${t.hashes} (${keys}, h) SELECT ${keys}, h FROM temp.new_${t.name}`);
      }
    }
    if (decisions && applyOutcomes(out, decisions)) changed.items += 1;
    const any = changed.items || changed.comments || changed.embeddings;
    if (any) out.prepare("INSERT OR REPLACE INTO main.meta VALUES ('refreshed_at', ?)").run(new Date().toISOString());
    if (any || JSON.stringify(mark) !== JSON.stringify(stored)) out.prepare("INSERT OR REPLACE INTO main.meta VALUES ('pg_source', ?)").run(JSON.stringify(mark));
    const counts = { items: countOf(out, "main.items"), comments: countOf(out, "main.comments") };
    out.exec("COMMIT");
    return { ...counts, bytes: statSync(dest).size, rebuilt: false, changed };
  } catch (e) {
    try { out.exec("ROLLBACK"); } catch { /* no transaction */ }
    throw e;
  } finally {
    out.close();
  }
}

/** Writes the whole snapshot into a new file, keyset-paged from one read snapshot, and renames it over `dest`. */
async function rebuildFromDb(db: Db, dest: string, pageSize: number): Promise<SnapshotStats> {
  const target = tmpFile(dest);
  rmSync(target, { force: true });
  const out = new DatabaseSync(target, { timeout: 30_000 });
  try {
    out.exec("PRAGMA journal_mode=DELETE");
    out.exec(DDL);
    out.prepare("INSERT INTO meta VALUES ('schema', ?)").run(SCHEMA_VERSION);
    out.exec("BEGIN");
    let mark: SourceMark | null = null;
    await db.read(async () => {
      mark = { source: await readSource(db), seqs: await readSeqs(db), comparedAt: new Date().toISOString() };
      for (const t of PG_TABLES) {
        const w = writer(out, t, "main.");
        for await (const rows of pgPages(db, t, (q) => q.select([...t.columns.map((c) => sql.ref(c).as(c)), t.hash().as("h")]), pageSize)) w.add(rows);
        w.flush();
      }
      applyOutcomes(out, await readDecisions(db));
    });
    out.prepare("INSERT OR REPLACE INTO meta VALUES ('refreshed_at', ?)").run(new Date().toISOString());
    out.prepare("INSERT OR REPLACE INTO meta VALUES ('pg_source', ?)").run(JSON.stringify(mark));
    const result = { items: countOf(out, "items"), comments: countOf(out, "comments") };
    const embeddings = countOf(out, "item_embeddings");
    out.exec("COMMIT");
    out.close();
    dropJournal(dest);
    renameSync(target, dest);
    return { ...result, bytes: statSync(dest).size, rebuilt: true, changed: { items: result.items, comments: result.comments, embeddings } };
  } catch (e) {
    try { out.close(); } catch { /* already closed */ }
    rmSync(target, { force: true });
    throw e;
  }
}

/**
 * Updates the snapshot from the configured database: a SQLite file by the incremental ATTACH copy, Postgres through a
 * Db handle (`db` if given and Postgres, else a connection opened and closed here).
 */
export async function buildSnapshot(db?: Db, dest: string = snapshotFile()): Promise<SnapshotStats> {
  return withSnapshotLock(dest, async () => {
    if (db?.dialect === "postgres") return writeSnapshotFromDb(db, dest);
    const target = dbTarget();
    if (!isPgUrl(target)) return writeSnapshot(target, dest);
    const own = await connectDb(target, { role: "cli", migrate: false });
    try {
      return await writeSnapshotFromDb(own, dest);
    } finally {
      await own.close();
    }
  });
}

/** The partial file a rebuild writes before renaming it over `dest`; one name is enough because builds hold the lock. */
const tmpFile = (dest: string): string => `${dest}.tmp`;

const LOCK_WAIT_MS = 15 * 60_000;
let inProcess: Promise<unknown> = Promise.resolve();
// The lock's connection while held: a build awaiting something no handle keeps alive would otherwise let the
// connection be collected, and closing it releases the lock.
let held: DatabaseSync | undefined;

/**
 * Runs `fn` as the only snapshot build for `dest`: after the builds already running in this process, and while holding
 * an exclusive SQLite lock on `<dest>.lock`. Builders are separate processes (the runner leader's build child, embed
 * jobs, the `item-tools snapshot` command), possibly in separate containers that share the directory, so a pid in a lock file cannot tell whether its
 * holder is alive; the lock is a POSIX file lock, which the kernel releases when the holding process dies. A waiter
 * polls without blocking the event loop. Holding the lock means no other build is writing, so every partial file in the
 * directory is left over from an interrupted one and is deleted.
 */
export async function withSnapshotLock<T>(dest: string, fn: () => Promise<T>, waitMs: number = LOCK_WAIT_MS): Promise<T> {
  const run = inProcess.then(() => holdingLock(dest, fn, waitMs));
  inProcess = run.catch(() => undefined);
  return run;
}

async function holdingLock<T>(dest: string, fn: () => Promise<T>, waitMs: number): Promise<T> {
  mkdirSync(dirname(dest), { recursive: true });
  const lock = new DatabaseSync(`${dest}.lock`, { timeout: 0 });
  try {
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        lock.exec("BEGIN EXCLUSIVE");
        break;
      } catch (e) {
        if (!isBusy(e)) throw e;
        if (Date.now() >= deadline) throw new Error(`another item snapshot build has held ${dest}.lock for over ${Math.round(waitMs / 60_000)} min`);
        await sleep(1000);
      }
    }
    held = lock;
    removePartials(dest);
    try {
      return await fn();
    } finally {
      removePartials(dest);
      lock.exec("ROLLBACK");
      held = undefined;
    }
  } finally {
    lock.close();
  }
}

const isBusy = (e: unknown): boolean => ((e as { errcode?: number })?.errcode ?? 0) % 256 === 5;

/** Deletes the partial files of interrupted rebuilds: `<file>.tmp`, the `<file>.<pid>.tmp` of older versions, and their journals. */
function removePartials(dest: string): void {
  const name = basename(dest);
  const partial = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(?:\\d+\\.)?tmp(?:-journal)?$`);
  let entries: string[];
  try { entries = readdirSync(dirname(dest)); } catch { return; }
  for (const f of entries) if (partial.test(f)) rmSync(join(dirname(dest), f), { force: true });
}

/**
 * A writer killed mid-transaction leaves `<file>-journal`. Readers cannot open
 * the file until a read-write open has rolled it back, and a journal left next
 * to a file renamed over it would later be rolled back into the new file. So
 * the journal is rolled back before anything else, and one with no file to
 * belong to is deleted.
 */
function recoverJournal(dest: string): void {
  const journal = `${dest}-journal`;
  if (!existsSync(journal)) return;
  if (existsSync(dest)) {
    try {
      const db = new DatabaseSync(dest, { timeout: 30_000 });
      try { db.prepare("SELECT COUNT(*) FROM sqlite_master").get(); } finally { db.close(); }
    } catch { /* not a database: the file is rebuilt below */ }
  }
  dropJournal(dest);
}

function dropJournal(dest: string): void {
  try { unlinkSync(`${dest}-journal`); } catch { /* none */ }
}

function storedMark(db: DatabaseSync): SourceMark | null {
  const v = (db.prepare("SELECT value FROM meta WHERE key = 'pg_source'").get() as { value: string } | undefined)?.value;
  try { return v ? (JSON.parse(v) as SourceMark) : null; } catch { return null; }
}

function hasVersion(file: string): boolean {
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return (db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string } | undefined)?.value === SCHEMA_VERSION;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/** Updates the snapshot after a run that changed what it copies; a failure is logged, never thrown into the run. */
export async function refreshSnapshot(log: (line: string) => void = console.log, db?: Db): Promise<void> {
  try {
    const r = await buildSnapshot(db);
    log(`item snapshot${r.rebuilt ? " (rebuilt)" : ""}: ${r.items} items, ${r.comments} comments, changed ${r.changed.items}/${r.changed.comments}/${r.changed.embeddings} (items/comments/embeddings), ${Math.round(r.bytes / 1e6)} MB`);
  } catch (e) {
    log(`item snapshot failed: ${String((e as Error).message).slice(0, 200)}`);
  }
}
