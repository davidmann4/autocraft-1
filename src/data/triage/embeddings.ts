// Item embeddings (blobs; loaders marked `alone`) (M09 triage-b).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import { embedDiffExists, embedDiffRows, embeddingMarkRow, embeddingPage, pruneEmbeddingRows } from "./cross.ts";
import type { EmbedDiffRow, EmbeddingMark, EmbeddingPut, RefKey, StreamedEmbedding } from "./types.ts";

const onKey = (alias: string, a: string) => (j: any) => j.onRef(`${alias}.repo`, "=", `${a}.repo`).onRef(`${alias}.number`, "=", `${a}.number`);

/** Stored vector hash per item for `model`. */
export async function loadEmbeddingHashes(db: Db, keys: KeySource, model: string): Promise<Map<RefKey, string>> {
  if (Array.isArray(keys) && !keys.length) return new Map();
  const q = queryDb(db), k = q.k as any;
  const rows = await q.all(k.selectFrom("main.item_embeddings as e").innerJoin(resolveKeys(db, keys, "kk"), onKey("kk", "e"))
    .select(["e.repo", "e.number", "e.hash"]).where("e.model", "=", model)) as { repo: string; number: number; hash: string }[];
  return new Map(rows.map((r) => [`${r.repo}#${r.number}`, r.hash]));
}

/** Tracked items whose vector is missing, from another model or at another hash (closed items); every tracked item with `all`. */
export async function listEmbedDiff(db: Db, model: string, all: boolean): Promise<EmbedDiffRow[]> {
  return await embedDiffRows(db, model, all);
}

/** `LIMIT 1` probe for `embedDue`. */
export async function hasEmbedDiff(db: Db, model: string): Promise<boolean> {
  return await embedDiffExists(db, model);
}

/**
 * A replace, not an upsert: a rewritten row gets a rowid above every other, which is how the vector index sees it changed
 * (`kx.replaceRows`: one statement per 500 rows, two on Postgres). The embed loop commits per batch of 32.
 */
export async function saveEmbeddings(db: Db, rows: EmbeddingPut[]): Promise<void> {
  if (!rows.length) return;
  const at = new Date().toISOString();
  const last = new Map(rows.map((r) => [`${r.repo}#${r.number}`, r]));
  await db.write(async () => {
    await kx.replaceRows(db, "main.item_embeddings", ["repo", "number"], [...last.values()].map((r) => ({ repo: r.repo, number: r.number, model: r.model, hash: r.hash, vec: r.vec, at })));
  });
}

/** Deletes rows of untracked repos or items not in the mirror. */
export async function pruneEmbeddings(db: Db): Promise<number> {
  return await pruneEmbeddingRows(db);
}

/** Vectors by item, of `model` when given. Marked `alone`: blobs. */
export async function loadEmbeddingVectors(db: Db, keys: KeySource, model?: string): Promise<Map<RefKey, { model: string; vec: Uint8Array }>> {
  if (Array.isArray(keys) && !keys.length) return new Map();
  const q = queryDb(db), k = q.k as any;
  const rows = await q.all(k.selectFrom("main.item_embeddings as e").innerJoin(resolveKeys(db, keys, "kk"), onKey("kk", "e"))
    .select(["e.repo", "e.number", "e.model", "e.vec"]).$if(model !== undefined, (b: any) => b.where("e.model", "=", model!)), { alone: true, label: "triage.loadEmbeddingVectors" }) as { repo: string; number: number; model: string; vec: Uint8Array }[];
  return new Map(rows.map((r) => [`${r.repo}#${r.number}`, { model: r.model, vec: r.vec }]));
}

/** Row count, max rowid and tracked set for `VectorIndex.check`. */
export async function embeddingIndexMark(db: Db): Promise<EmbeddingMark> {
  return await embeddingMarkRow(db);
}

/** One page of up to 1,000 vectors after rowid `after`; a metered stream, skipped by the query-growth check. Marked `alone`. */
export async function streamEmbeddings(db: Db, model: string, after: number, limit: number): Promise<StreamedEmbedding[]> {
  return await embeddingPage(db, model, after, limit);
}
