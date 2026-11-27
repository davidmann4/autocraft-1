// Search over a repo's imported reference documentation without mounting it: the text pages are
// split into passages, embedded locally and kept with an FTS5 table in a database outside the
// reference folder (that folder is mounted into sandboxes as is). Images and PDFs are never indexed.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { dataDir } from "../../db.ts";
import { DEFAULT_MODEL, localEmbedder, type Embedder } from "../../embed/model.ts";
import { toBlob } from "../../embed/store.ts";
import type { ScoreReply, ScoreRequest } from "./score-worker.ts";
import type { BuildMode, Passage, SearchOptions } from "./types.ts";


export const MAX_RESULTS = 8;
export const MAX_AROUND = 3;
const PASSAGE_CHARS = 1000; // about 256 tokens of English, the length the model runs at
const RESULT_CHARS = 1200;
const RRF_K = 60;
const REPO = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const TEXT = /\.(txt|md)$/;
const SCHEMA_VERSION = "1";

const referenceFolder = (repo: string): string => join(dataDir(), "reference", repo);
export const indexPath = (repo: string): string => join(dataDir(), "reference-index", `${repo}.db`);

let defaultEmbedder: Embedder | undefined, queryEmbedder: Embedder | undefined;
const embedderOf = (o: SearchOptions): Embedder => o.embedder ?? (defaultEmbedder ??= localEmbedder({ name: DEFAULT_MODEL }));
// A search embeds one short query: one thread, so the dashboard that serves searches keeps no spinning thread pool.
const queryEmbedderOf = (o: SearchOptions): Embedder => o.embedder ?? (queryEmbedder ??= localEmbedder({ name: DEFAULT_MODEL, threads: 1 }));
/** Builds in progress per index file: a second request for the same index waits for the first. */
const building = new Map<string, Promise<boolean>>();

function checkRepo(repo: string): void {
  if (!REPO.test(repo)) throw new Error(`invalid repo name ${repo}`);
}

/** Splits a page into passages of about PASSAGE_CHARS, on paragraph boundaries where possible. */
export function splitPassages(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  const flush = (): void => { if (cur.trim()) out.push(cur.trim()); cur = ""; };
  for (const para of text.replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
    let p = para.trim();
    if (!p) continue;
    while (p.length > PASSAGE_CHARS) {
      let cut = p.lastIndexOf(" ", PASSAGE_CHARS);
      if (cut < PASSAGE_CHARS / 2) cut = PASSAGE_CHARS;
      flush();
      out.push(p.slice(0, cut).trim());
      p = p.slice(cut).trim();
    }
    if (cur && cur.length + p.length + 2 > PASSAGE_CHARS) flush();
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  flush();
  return out;
}

const pageTitle = (file: string, text: string): string => /^#{1,6}\s+(.+)$/m.exec(text)?.[1]?.trim() ?? /^(.*\S.*)$/m.exec(file.replace(/\.[^.]+$/, ""))?.[1] ?? file;

function listFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out.sort();
}

/** Hash of every file's name and size, plus the content of the text pages. */
export function importFingerprint(dir: string): string {
  const h = createHash("sha256");
  for (const f of listFiles(dir)) {
    h.update(`${f}\0${statSync(join(dir, f)).size}\0`);
    if (TEXT.test(f)) h.update(readFileSync(join(dir, f)));
  }
  return h.digest("hex");
}

/** Cheap fingerprint of every file's name, size and mtime; no file is read. */
export function statFingerprint(dir: string): string {
  const h = createHash("sha256");
  for (const f of listFiles(dir)) {
    const st = statSync(join(dir, f));
    h.update(`${f}\0${st.size}\0${st.mtimeMs}\0`);
  }
  return h.digest("hex");
}


function openIndex(file: string): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS passages (id INTEGER PRIMARY KEY, page TEXT NOT NULL, title TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL, vec BLOB NOT NULL);
    CREATE INDEX IF NOT EXISTS passages_page ON passages(page, seq);
    CREATE VIRTUAL TABLE IF NOT EXISTS passages_fts USING fts5(text, content='passages', content_rowid='id');`);
  return db;
}

const metaGet = (db: DatabaseSync, key: string): string | undefined => (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;

/**
 * Builds the repo's index when it is missing or its model or fingerprint differ; returns whether it was rebuilt.
 * "stat" compares only the cheap name/size/mtime fingerprint (used on every search), "content" also hashes the
 * text pages (when only mtimes changed, the stored stat fingerprint is refreshed without rebuilding), "force" always rebuilds.
 */
export function buildReferenceIndex(repo: string, opts: SearchOptions = {}, mode: BuildMode = "content"): Promise<boolean> {
  checkRepo(repo);
  const file = opts.indexFile ?? indexPath(repo);
  let p = building.get(file);
  if (!p) {
    p = buildIndex(repo, file, opts, mode).finally(() => building.delete(file));
    building.set(file, p);
  }
  return p;
}

async function buildIndex(repo: string, file: string, opts: SearchOptions, mode: BuildMode): Promise<boolean> {
  const dir = opts.dir ?? referenceFolder(repo);
  if (!existsSync(dir)) {
    rmSync(file, { force: true });
    return false;
  }
  const embedder = embedderOf(opts), stat = statFingerprint(dir);
  let db = openIndex(file);
  let fingerprint = "";
  try {
    const same = metaGet(db, "model") === embedder.id && metaGet(db, "schema") === SCHEMA_VERSION;
    if (mode !== "force" && same && metaGet(db, "stat") === stat) return false;
    fingerprint = importFingerprint(dir);
    if (mode !== "force" && same && metaGet(db, "fingerprint") === fingerprint) {
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('stat', ?)").run(stat);
      return false;
    }
    const rows: { page: string; title: string; seq: number; text: string }[] = [];
    for (const f of listFiles(dir).filter((x) => TEXT.test(x))) {
      const body = readFileSync(join(dir, f), "utf8"), title = pageTitle(f, body);
      splitPassages(body).forEach((text, seq) => rows.push({ page: f, title, seq, text }));
    }
    const vecs: Float32Array[] = [];
    for (let i = 0; i < rows.length; i += 32) vecs.push(...await embedder.embed(rows.slice(i, i + 32).map((r) => `${r.title}\n${r.text}`), "item"));
    db.close();
    rmSync(file, { force: true });
    db = openIndex(file);
    db.exec("BEGIN");
    const ins = db.prepare("INSERT INTO passages (page, title, seq, text, vec) VALUES (?, ?, ?, ?, ?)");
    rows.forEach((r, i) => ins.run(r.page, r.title, r.seq, r.text, toBlob(vecs[i]!)));
    db.exec("INSERT INTO passages_fts(passages_fts) VALUES ('rebuild')");
    const setMeta = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
    setMeta.run("model", embedder.id);
    setMeta.run("fingerprint", fingerprint);
    setMeta.run("stat", stat);
    setMeta.run("schema", SCHEMA_VERSION);
    db.exec("COMMIT");
    return true;
  } finally {
    db.close();
  }
}

/** Concurrent searches; more wait in a queue. The scoring worker itself handles one request at a time. */
const MAX_SEARCHES = 4;
let active = 0;
const waiting: (() => void)[] = [];
async function slot<T>(run: () => Promise<T>): Promise<T> {
  if (active >= MAX_SEARCHES) await new Promise<void>((r) => waiting.push(r));
  else active++;
  try {
    return await run();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

let scorer: Worker | undefined, seq = 0;
const pending = new Map<number, { ok: (ids: number[]) => void; fail: (e: Error) => void }>();
function scoreWorker(): Worker {
  if (scorer) return scorer;
  const w = new Worker(new URL("./score-worker.ts", import.meta.url));
  const drop = (e: Error): void => {
    if (scorer === w) scorer = undefined;
    for (const p of pending.values()) p.fail(e);
    pending.clear();
  };
  w.on("message", (m: ScoreReply) => {
    const p = pending.get(m.n);
    pending.delete(m.n);
    if (m.error !== undefined) p?.fail(new Error(m.error));
    else p?.ok(m.ids ?? []);
  });
  w.on("error", drop);
  w.on("exit", () => drop(new Error("the reference scoring worker stopped")));
  w.unref();
  return (scorer = w);
}

/** Ids of the `top` passages nearest to the query vector, scored in the worker thread. */
const nearest = (file: string, query: Float32Array, top: number): Promise<number[]> =>
  new Promise((ok, fail) => {
    const n = ++seq;
    pending.set(n, { ok, fail });
    scoreWorker().postMessage({ n, file, query, top } satisfies ScoreRequest);
  });

const ftsQuery = (q: string): string => (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 32).map((t) => `"${t}"`).join(" OR ");

const toPassage = (r: { id: number; page: string; title: string; text: string }): Passage => ({ id: r.id, page: r.page, title: r.title, text: r.text.slice(0, RESULT_CHARS) });

/**
 * Hybrid search: embedding similarity and FTS5 rank, fused by reciprocal rank. Up to 8 passages. It reads the index as
 * built and never builds one: embedding a whole manual takes many minutes of CPU, which the dashboard serving the search
 * cannot spare. `autocraft-server reference import` and `autocraft-server reference index` build it.
 */
export async function referenceSearch(repo: string, query: string, limit = 5, opts: SearchOptions = {}): Promise<Passage[]> {
  checkRepo(repo);
  const n = Math.max(0, Math.min(MAX_RESULTS, Math.floor(limit)));
  if (!n || !query.trim()) return [];
  const file = opts.indexFile ?? indexPath(repo);
  if (!existsSync(file)) return [];
  return slot(async () => {
    const [qv] = await queryEmbedderOf(opts).embed([query], "query");
    const byVec = await nearest(file, qv!, 50);
    const db = openIndex(file);
    try {
      const match = ftsQuery(query);
      const byText = match ? (db.prepare("SELECT rowid AS id FROM passages_fts WHERE passages_fts MATCH ? ORDER BY rank LIMIT 50").all(match) as { id: number }[]).map((x) => x.id) : [];
      const fused = new Map<number, number>();
      for (const list of [byVec, byText]) list.forEach((id, rank) => fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
      const top = [...fused].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, n).map(([id]) => id);
      const get = db.prepare("SELECT id, page, title, text FROM passages WHERE id = ?");
      return top.map((id) => toPassage(get.get(id) as Passage));
    } finally {
      db.close();
    }
  });
}

/** The passages next to one passage on the same page, in page order, up to 3 on each side; the passage itself is not included. */
export function referenceAround(repo: string, passageId: number, before = 1, after = 1, opts: SearchOptions = {}): Passage[] {
  checkRepo(repo);
  const file = opts.indexFile ?? indexPath(repo);
  if (!existsSync(file)) return [];
  const b = Math.max(0, Math.min(MAX_AROUND, Math.floor(before))), a = Math.max(0, Math.min(MAX_AROUND, Math.floor(after)));
  const db = openIndex(file);
  try {
    const me = db.prepare("SELECT page, seq FROM passages WHERE id = ?").get(passageId) as { page: string; seq: number } | undefined;
    if (!me) return [];
    const rows = db.prepare("SELECT id, page, title, text FROM passages WHERE page = ? AND seq != ? AND seq BETWEEN ? AND ? ORDER BY seq")
      .all(me.page, me.seq, me.seq - b, me.seq + a) as Passage[];
    return rows.map(toPassage);
  } finally {
    db.close();
  }
}
