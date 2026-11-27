// Embedding new and changed items into `item_embeddings`. Each batch commits on
// its own, so an interrupted run loses at most one batch and the next run picks
// up where it stopped.
import type { Embedder } from "./model.ts";
import { fillEmbedHashes } from "../itemhash.ts";
import { itemText } from "./text.ts";
import { mayRun } from "../core/authority.ts";
import { CLI_BY, type By } from "../core/gates.ts";
import { plannedItems } from "../core/select-items.ts";
import type { PlanSet } from "../core/plan-set.ts";
import { embedStatements, statementsDue } from "../memory/statements.ts";
import type { Db } from "../db/index.ts";
import { loadItems } from "../data/mirror/index.ts";
import { hasEmbedDiff, listEmbedDiff, pruneEmbeddings, saveEmbeddings } from "../data/triage/index.ts";

export type Todo = { repo: string; number: number; text: string; hash: string };

export const toBlob = (v: Float32Array): Uint8Array => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);

/** The embed texts of `rows`, in the order given: one load for the whole list. */
const todosOf = async (db: Db, rows: readonly { repo: string; number: number; hash: string }[]): Promise<Todo[]> => {
  const found = await loadItems(db, rows.map((r) => ({ repo: r.repo, number: r.number })), "text");
  return rows.map((r) => {
    const t = found.get(`${r.repo}#${r.number}`);
    if (!t) throw new Error(`${r.repo}#${r.number} is not in the database`);
    return { repo: r.repo, number: r.number, text: itemText(t.title, t.body), hash: r.hash };
  });
};

/**
 * What to embed, shortest text first so batches pad little: the open items the Plans send here (every tracked item with `all`).
 * Closed items have no Plan; the ones with a missing or stale vector are added so that duplicate scans still find them.
 * Reads only; the item rows' missing hashes are filled by embedItems.
 */
export async function pending(db: Db, modelId: string, all = false, plans?: PlanSet, by: By = CLI_BY): Promise<Todo[]> {
  // The first query runs on covering indexes; only the rows that differ are read in full.
  const diff = await listEmbedDiff(db, modelId, all);
  const planned = all ? [] : (await plannedItems(db, "embed", { model: modelId, run: null, by, ...(plans ? { plans } : {}) })).map((p) => ({ repo: p.facts.repo, number: p.facts.number, hash: p.facts.embedHash }));
  // A row without a hash waits for fillEmbedHashes (embedItems runs it first).
  const hashed = [...planned, ...diff].filter((r): r is { repo: string; number: number; hash: string } => r.hash !== null);
  return (await todosOf(db, hashed)).sort((a, b) => a.text.length - b.text.length);
}

/**
 * Whether the embed step has work: open items the Plans send here, or closed ones with a missing or stale vector. With `seqs`, the
 * change counters a planner pass read before asking, the closed items' probe is answered again only when DIFF_TOPICS moved.
 */
export async function embedDue(db: Db, modelId: string, plans?: PlanSet, seqs?: Record<string, number>): Promise<boolean> {
  if (plans ? plans.items.some((p) => p.plan.actions.some((a) => a.kind === "embed" && mayRun({ facts: p.facts, action: a }, "pipeline").ok)) : (await plannedItems(db, "embed", { model: modelId, run: null })).length) return true;
  // Owner statements (src/memory/) are embedded by the same step.
  if (await statementsDue(db, modelId)) return true;
  if (!seqs) return await hasEmbedDiff(db, modelId);
  const key = [modelId, ...DIFF_TOPICS.map((t) => seqs[t] ?? 0)].join(",");
  const last = diffProbes.get(db);
  if (last?.key === key) return last.due;
  const due = await hasEmbedDiff(db, modelId);
  diffProbes.set(db, { key, due });
  return due;
}

/**
 * The change topics whose writes can change the embed diff: items and their embed hashes (items), the tracked repos (repos) and
 * vectors written (plan-inputs). Deleting a vector moves none of them; only prune does, and only for vectors the diff skips.
 */
const DIFF_TOPICS = ["items", "repos", "plan-inputs"];
/** The diff probe's last answer per database, under the counters (`seqs` read before it) and model it was asked with. */
const diffProbes = new WeakMap<Db, { key: string; due: boolean }>();

// Vectors of items that left the mirror or the tracked repos.
export const prune = (db: Db): Promise<number> => pruneEmbeddings(db);

export type Progress = { done: number; total: number; ms: number };

export async function embedItems(db: Db, embedder: Embedder,
  opts: { all?: boolean; batch?: number; onProgress?: (p: Progress) => void } = {}): Promise<{ embedded: number; pruned: number; ms: number }> {
  const start = performance.now();
  const pruned = await prune(db);
  await fillEmbedHashes(db);
  const todo = await pending(db, embedder.id, opts.all);
  const size = opts.batch ?? 32;
  let done = 0;
  for (let i = 0; i < todo.length; i += size) {
    const batch = todo.slice(i, i + size);
    const vecs = await embedder.embed(batch.map((t) => t.text), "item");
    // A replace, not an upsert: the rewritten row gets a rowid above every other, which is how the vector index (vectors.ts) sees it changed.
    await saveEmbeddings(db, batch.map((t, k) => ({ repo: t.repo, number: t.number, model: embedder.id, hash: t.hash, vec: toBlob(vecs[k]!) })));
    done += batch.length;
    opts.onProgress?.({ done, total: todo.length, ms: performance.now() - start });
  }
  await embedStatements(db, embedder, size);
  return { embedded: done, pruned, ms: performance.now() - start };
}
