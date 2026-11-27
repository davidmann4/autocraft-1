// Worker thread of the reference search: keeps each repo's passage ids and vectors in memory (at most MAX_REPOS repos,
// least recently used dropped, reloaded when the index file changes) and scores a query against them, so the dashboard's
// event loop does neither the database read nor the dot products. Imports only node: modules.
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parentPort } from "node:worker_threads";

const MAX_REPOS = 4;
export type ScoreRequest = { n: number; file: string; query: Float32Array; top: number };
export type ScoreReply = { n: number; ids?: number[]; error?: string };

type Entry = { stamp: string; ids: number[]; vecs: Float32Array; dim: number };
const cache = new Map<string, Entry>();

function load(file: string): Entry {
  const st = statSync(file), stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
  const hit = cache.get(file);
  if (hit && hit.stamp === stamp) {
    cache.delete(file);
    cache.set(file, hit);
    return hit;
  }
  cache.delete(file);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare("SELECT id, vec FROM passages ORDER BY id").all() as { id: number; vec: Uint8Array }[];
    const dim = rows.length ? rows[0]!.vec.byteLength / 4 : 0;
    const vecs = new Float32Array(rows.length * dim), ids: number[] = [];
    rows.forEach((r, i) => {
      ids.push(r.id);
      vecs.set(new Float32Array(r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + r.vec.byteLength), 0, dim), i * dim);
    });
    const e = { stamp, ids, vecs, dim };
    cache.set(file, e);
    while (cache.size > MAX_REPOS) cache.delete(cache.keys().next().value!);
    return e;
  } finally {
    db.close();
  }
}

function score(file: string, q: Float32Array, top: number): number[] {
  const { ids, vecs, dim } = load(file);
  const scored: { id: number; score: number }[] = [];
  for (let r = 0; r < ids.length; r++) {
    let s = 0;
    for (let i = 0, o = r * dim; i < dim; i++) s += vecs[o + i]! * q[i]!;
    scored.push({ id: ids[r]!, score: s });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, top).map((x) => x.id);
}

parentPort!.on("message", (m: ScoreRequest) => {
  try {
    parentPort!.postMessage({ n: m.n, ids: score(m.file, m.query, m.top) } satisfies ScoreReply);
  } catch (e) {
    parentPort!.postMessage({ n: m.n, error: (e as Error).message } satisfies ScoreReply);
  }
});
