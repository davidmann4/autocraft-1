// Hashes of an item's text, stored on the item row when sync writes it so the
// planner compares columns instead of reading and hashing every body each minute.
//   embed_hash: hash of the embedded text (src/embed/text.ts); decides re-embedding.
//   class_hash: the classifier's input hash (scheme, title, body, size); decides re-classifying.
//     class_scheme names the scheme it was computed under, so a changed scheme rehashes lazily.
import { createHash } from "node:crypto";
import { BULK_ROWS, bulkWrites } from "./core/plan-changes.ts";
import { itemInput, type Item } from "./classify/parse.ts";
import { LABELS, RULES } from "./classify/rules.ts";
import { itemText, textHash } from "./embed/text.ts";
import type { Db } from "./db/index.ts";
import { fillItemHashes } from "./data/mirror/index.ts";

export const SCHEME = createHash("sha256").update(JSON.stringify(LABELS)).update(RULES).digest("hex");
export const SCHEME_ID = SCHEME.slice(0, 16);

export const inputHash = (i: Item): string =>
  createHash("sha256").update(SCHEME).update(JSON.stringify(itemInput(i))).digest("hex").slice(0, 32);

export const embedHash = (title: string | null, body: string | null): string => textHash(itemText(title, body));

export type Fields = {
  repo: string; number: number; kind: string; title: string | null; body: string | null;
  additions: number | null; deletions: number | null; changed_files: number | null; author_association: string | null;
};

/** The classifier's view of an item row (the same shape `SELECT ... i.additions + i.deletions` gives). */
export function classifyHash(r: Fields): string {
  return inputHash({
    repo: r.repo, number: r.number, kind: r.kind as "pr" | "issue", title: r.title ?? "", body: r.body ?? "",
    lines_changed: r.additions === null || r.deletions === null ? null : r.additions + r.deletions,
    files_changed: r.changed_files, author_association: r.author_association,
  });
}

/** Hash columns for an item row about to be written. */
export function hashColumns(r: Fields): { embed_hash: string; class_hash: string; class_scheme: string } {
  return { embed_hash: embedHash(r.title, r.body), class_hash: classifyHash(r), class_scheme: SCHEME_ID };
}

export const FIELD_COLUMNS = ["repo", "number", "kind", "title", "body", "additions", "deletions", "changed_files", "author_association"] as const;
export const BATCH = 2000;

// A batch of a backfill takes one full-pass mark instead of a log row per item (src/core/plan-changes.ts).
const marked = (db: Db) => async (source: "embed-hashes" | "class-hashes", rows: number, write: () => Promise<void>): Promise<void> => {
  if (rows >= BULK_ROWS) await bulkWrites(db, source, write); else await write();
};

/** Fills embed_hash where it is missing. Returns the number of rows written. */
export async function fillEmbedHashes(db: Db): Promise<number> {
  return await fillItemHashes(db, (r) => ({ embed_hash: embedHash(r.title, r.body), class_hash: null, class_scheme: null }), { scheme: SCHEME_ID, batch: BATCH, around: marked(db) });
}

/** Fills class_hash where it is missing or was computed under another scheme. Only open items: the classifier reads no others. */
export async function fillClassHashes(db: Db): Promise<number> {
  return await fillItemHashes(db, (r) => ({ embed_hash: null, class_hash: classifyHash(r), class_scheme: SCHEME_ID }), { scheme: SCHEME_ID, batch: BATCH, around: marked(db) });
}
