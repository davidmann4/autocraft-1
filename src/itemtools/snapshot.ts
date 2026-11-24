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
import type { Db } from "../db/index.ts";
import { connectDb, dbTarget, isPgUrl } from "../db/open.ts";
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
export const SCHEMA_VERSION = "3";

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
const cell = (name: string, v: unknown): unknown => (INTEGER_COLUMNS.has(name) && v !== null && v !== undefined ? Number(v) : v ?? null);

/**
 * Builds the snapshot at `dest` from a Db handle (the Postgres app database). The same rows as the SQLite path, read in
 * one snapshot and keyset-paged, are written into a new file in one transaction, renamed over `dest`. A refresh whose stamp
 * (change markers and embedding count and time) equals the one stored in the file's meta writes nothing; otherwise
 * it rewrites the file, and `changed` counts the rows written.
 */
export async function writeSnapshotFromDb(db: Db, dest: string = snapshotFile(), pageSize: number = PAGE): Promise<SnapshotStats> {
  mkdirSync(dirname(dest), { recursive: true });
  recoverJournal(dest);
  let stamp = "";
  const target = tmpFile(dest);
  rmSync(target, { force: true });
  const out = new DatabaseSync(target, { timeout: 30_000 });
  try {
    out.exec("PRAGMA journal_mode=DELETE");
    out.exec(DDL);
    out.prepare("INSERT INTO meta VALUES ('schema', ?)").run(SCHEMA_VERSION);
    out.exec("BEGIN");
    const counts = { items: 0, comments: 0, embeddings: 0 };
    let unchanged = false;
    await db.read(async () => {
      // A cheap stamp of what is copied: the change markers of the topics covering repos, items, comments and decisions,
      // and the embeddings' count and newest write time (no topic covers them).
      const seqs = await db.prepare("SELECT topic, seq FROM change_seq WHERE topic IN ('repos', 'items', 'decisions') ORDER BY topic").all<{ topic: string; seq: unknown }>();
      const emb = await db.prepare("SELECT COUNT(*) AS n, MAX(at) AS at FROM item_embeddings").get<{ n: unknown; at: string | null }>();
      stamp = JSON.stringify([seqs.map((r) => [r.topic, Number(r.seq)]), Number(emb?.n ?? 0), emb?.at ?? null]);
      if (hasVersion(dest) && storedStamp(dest) === stamp) {
        unchanged = true;
        return;
      }
      const pub = "repo IN (SELECT name FROM repos WHERE visibility = 'public')";
      const copy = async (table: string, columns: string[], key: string[], where: string, into: string, count: keyof typeof counts | null) => {
        const ins = out.prepare(`INSERT INTO ${into} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
        const after = key.length === 1 ? `${key[0]} > ?` : `(${key.join(", ")}) > (${key.map(() => "?").join(", ")})`;
        const q = (first: boolean) => `SELECT ${columns.join(", ")} FROM ${table} WHERE ${where}${first ? "" : ` AND ${after}`} ORDER BY ${key.join(", ")} LIMIT ${pageSize}`;
        let last: (string | number)[] | null = null;
        for (;;) {
          const rows: Record<string, unknown>[] = await db.prepare(q(!last)).all<Record<string, unknown>>(...(last ?? []));
          for (const r of rows) ins.run(...(columns.map((c) => cell(c, r[c])) as SQLInputValue[]));
          if (count) counts[count] += rows.length;
          if (rows.length < pageSize) break;
          const lr: Record<string, unknown> = rows[rows.length - 1]!;
          last = key.map((k) => (INTEGER_COLUMNS.has(k) ? Number(lr[k]) : String(lr[k])));
        }
      };
      await copy("items", ITEM_COLUMNS, ["repo", "number"], pub, "items", "items");
      // A review still pending is the author's draft and is not public.
      await copy("comments", COMMENT_COLUMNS, ["id"], `${pub} AND (review_state IS NULL OR review_state <> 'PENDING')`, "comments", null);
      await copy("item_embeddings", ["repo", "number", "model", "at", "vec"], ["repo", "number"], pub, "item_embeddings", "embeddings");
      const rows = await db.prepare(`SELECT kind, repo, number, items, options, answer, exceptions, answered_at FROM decisions
        WHERE answer IS NOT NULL AND answered_at IS NOT NULL`).all<DecisionRow>();
      const have = new Set((out.prepare("SELECT repo, number FROM items").all() as { repo: string; number: number }[]).map((r) => `${r.repo}#${r.number}`));
      const ins = out.prepare("INSERT INTO decision_outcomes (repo, number, kind, answer, answer_label, answered_at) VALUES (?,?,?,?,?,?)");
      for (const o of outcomes(rows.map((r) => ({ ...r, number: r.number === null ? null : Number(r.number) }))).filter((o) => have.has(`${o.repo}#${o.number}`))) {
        ins.run(o.repo, o.number, o.kind, o.answer, o.label, o.at);
      }
    });
    if (unchanged) {
      out.exec("ROLLBACK");
      out.close();
      rmSync(target, { force: true });
      const same = new DatabaseSync(dest, { readOnly: true });
      try {
        const n = (t: string) => Number((same.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
        return { items: n("items"), comments: n("comments"), bytes: statSync(dest).size, rebuilt: false, changed: { items: 0, comments: 0, embeddings: 0 } };
      } finally {
        same.close();
      }
    }
    out.prepare("INSERT OR REPLACE INTO meta VALUES ('refreshed_at', ?)").run(new Date().toISOString());
    out.prepare("INSERT OR REPLACE INTO meta VALUES ('pg_stamp', ?)").run(stamp);
    const n = (t: string) => Number((out.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
    const result = { items: n("items"), comments: n("comments") };
    out.exec("COMMIT");
    out.close();
    dropJournal(dest);
    renameSync(target, dest);
    return { ...result, bytes: statSync(dest).size, rebuilt: true, changed: { items: result.items, comments: result.comments, embeddings: counts.embeddings } };
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

function storedStamp(file: string): string | undefined {
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return (db.prepare("SELECT value FROM meta WHERE key = 'pg_stamp'").get() as { value: string } | undefined)?.value;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
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
