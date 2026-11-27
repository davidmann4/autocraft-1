// Helpers of the mirror's internal files (items, comments, checks, local); not exported by index.ts.
import type { SelectQueryBuilder } from "kysely";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import type { ItemPreset, RefKey } from "./types.ts";

export type AnyQ = SelectQueryBuilder<any, any, any>;

export const refKey = (repo: string, number: number): RefKey => `${repo}#${number}`;

/** A "repo#number" key as its parts (the repo name may contain "#"; the number follows the last one). */
export function splitKey(key: RefKey): { repo: string; number: number } {
  const i = key.lastIndexOf("#");
  return { repo: key.slice(0, i), number: Number(key.slice(i + 1)) };
}

/** Inner-joins the keys of `keys` to the table alias `alias` (columns `repo`, `number`), so a key set stays in the same statement as its loader. */
export function joinKeys<Q extends AnyQ>(db: Db, q: Q, keys: KeySource, alias: string): Q {
  return (q as AnyQ).innerJoin(resolveKeys(db, keys, "k"), (j: any) => j.onRef("k.repo", "=", `${alias}.repo`).onRef("k.number", "=", `${alias}.number`)) as Q;
}

/** A key list in slices of 10,000 (one statement each); any other key source is one statement. An empty list gives none. */
export const keyChunks = (keys: KeySource): KeySource[] => (Array.isArray(keys) ? kx.chunks(keys) : [keys]);

const CARD = ["repo", "number", "kind", "state", "title", "url", "author", "author_type", "labels", "assignees", "comments_count", "is_draft", "created_at", "updated_at", "closed_at", "merged_at", "merged_by", "state_reason"];
const PR = ["repo", "number", "kind", "state", "author", "author_id", "author_type", "assignees", "is_draft", "updated_at", "additions", "deletions", "head_oid", "head_ref", "head_repo", "base_ref", "mergeable", "maintainer_can_modify", "review_decision", "ci_state", "closing_issues", "closed_at", "merged_at"];
const TEXT = [...CARD, "body", "author_id", "author_association", "additions", "deletions", "changed_files", "closing_issues", "text_refs", "head_oid", "embed_hash", "class_hash", "class_scheme"];

/** The columns of a preset (a plain list, no repeats). `full` is every column of `items` but the full-text one and `jev_failed_hash`. */
export function presetColumns(preset: ItemPreset): string[] {
  switch (preset) {
    case "ref": return ["repo", "number", "kind", "state"];
    case "labels": return ["repo", "number", "kind", "state", "url", "labels"];
    case "card": return CARD;
    case "pr": return PR;
    case "text": return [...new Set(TEXT)];
    case "full": return kx.cols("items").filter((c) => c !== "jev_failed_hash");
  }
}

/** `columns` as references to the table alias `a`. */
export const qualified = (a: string, columns: readonly string[]): string[] => columns.map((c) => `${a}.${c}`);
