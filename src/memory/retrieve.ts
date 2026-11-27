// The owner statements a review of a PR gets: the closest ones to the PR's embedding, from the PR's own repo.
import type { OwnerStatement } from "../review/opus-parse.ts";
import { STATEMENT_PROMPT_CHARS } from "../review/opus-parse.ts";
import { loadStatementPools } from "../data/conversations/index.ts";
import { loadEmbeddingVectors } from "../data/triage/index.ts";
import type { Db } from "../db/index.ts";

/** How many statements a review sees. */
export const STATEMENTS_PER_REVIEW = 5;
/**
 * Cosine similarity a statement needs to the PR. Whole-item pairs of the same kind become duplicate candidates from
 * SIM_THRESHOLD (src/dupes/scan.ts); a statement is short and about a topic, so related work scores lower. 0.7 sits above
 * the 0.5 to 0.65 that unrelated text gets from the bge-small model.
 */
export const STATEMENT_MIN_SIMILARITY = 0.7;

const asFloats = (b: Uint8Array): Float32Array => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

/**
 * Up to STATEMENTS_PER_REVIEW statements by cosine similarity to the PR's stored vector, best first, newest first among
 * equal scores. Only statements of the PR's own repo, and none on the PR itself or on a quiet security pull request:
 * operators' words reach a review only for the repo they were said about, and a quiet PR stays unnamed until its advisory.
 */
export async function relatedStatements(db: Db, repo: string, number: number): Promise<OwnerStatement[]> {
  const pr = (await loadEmbeddingVectors(db, [{ repo, number }])).get(`${repo}#${number}`);
  if (!pr) return [];
  const q = asFloats(pr.vec);
  const rows = (await loadStatementPools(db, [repo], [pr.model])).get(repo) ?? [];
  const hits: (OwnerStatement & { score: number })[] = [];
  for (const r of rows) {
    if (r.number === number) continue;
    const v = asFloats(r.vec);
    if (v.length !== q.length) continue;
    let dot = 0;
    for (let i = 0; i < q.length; i++) dot += q[i]! * v[i]!;
    if (dot >= STATEMENT_MIN_SIMILARITY) {
      hits.push({ id: r.id, where: r.number === null ? r.repo : `${r.repo}#${r.number}`, kind: r.source_kind, title: r.item_title, at: r.at, text: r.text.slice(0, STATEMENT_PROMPT_CHARS), score: Math.round(dot * 1000) });
    }
  }
  hits.sort((a, b) => b.score - a.score || b.at.localeCompare(a.at));
  return hits.slice(0, STATEMENTS_PER_REVIEW).map(({ score: _s, ...s }) => s);
}
