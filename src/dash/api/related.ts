// The relations an item page shows: the classifiers' latest verdicts, and the duplicates and links of one item.
import type { Classification, RelatedItem, Relation } from "../../../web/src/api/types.ts";
import { loadItems } from "../../data/mirror/index.ts";
import { loadLatestClassifications, loadRelations } from "../../data/views/related.ts";
import type { Db } from "../../db/index.ts";
import { itemState } from "./shown.ts";

const numbers = (s: string | null): number[] => {
  try {
    const v = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
  } catch {
    return [];
  }
};

export async function classificationsOf(db: Db, repo: string, n: number): Promise<Classification[]> {
  return (await loadLatestClassifications(db, repo, n)).map((r) => ({
    classifier: r.classifier as Classification["classifier"], at: r.at,
    typeLabel: r.type_label as Classification["typeLabel"], want: (r.want ?? "unclear") as Classification["want"],
    reference: r.reference, reason: r.reason ?? "", dupOf: r.dup_of,
  }));
}

/** Duplicates from the classifiers, issues a PR closes, and PRs that close this issue. */
export async function relatedOf(db: Db, repo: string, n: number): Promise<RelatedItem[]> {
  const src = await loadRelations(db, repo, n);
  const out = new Map<number, Relation>();
  const add = (number: number, relation: Relation) => {
    if (number !== n && Number.isInteger(number) && !out.has(number)) out.set(number, relation);
  };
  for (const x of src.duplicateOf) add(x, "duplicate-of");
  for (const x of src.duplicatedBy) add(x, "duplicated-by");
  for (const x of numbers(src.closing)) add(x, "fixes");
  if (src.kind === "issue") for (const p of src.linking) if (numbers(p.closing).includes(n)) add(p.number, "links");
  const listed = [...out].slice(0, 10);
  const rows = await loadItems(db, listed.map(([number]) => ({ repo, number })), "card");
  return listed.flatMap(([number, relation]) => {
    const row = rows.get(`${repo}#${number}`);
    return row ? [{ repo, number, relation, title: row.title ?? "", state: itemState(row.state), kind: row.kind === "pr" ? "pr" as const : "issue" as const }] : [];
  });
}
