// reads: mirror.items, triage.classifications
// The relations an item page shows: the classifiers' latest verdicts, and the items the classifiers and the closing links tie to one item.
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";

export type LatestClassification = { classifier: string; at: string; type_label: string | null; want: string | null; reference: string | null; reason: string | null; dup_of: number | null };

/** The item's newest verdict of each classifier, over every run. 1 statement; the newest is picked here (a correlated MAX(at) walks the (classifier, at) index on SQLite). */
export async function loadLatestClassifications(db: Db, repo: string, number: number): Promise<LatestClassification[]> {
  const q = queryDb(db);
  const all = await q.all(q.k.selectFrom("main.classifications").select(["classifier", "at", "type_label", "want", "reference", "reason", "dup_of"])
    .where("repo", "=", repo).where("number", "=", number).orderBy("classifier"));
  const latest = new Map<string, string>();
  for (const r of all) if (!(latest.get(r.classifier)! >= r.at)) latest.set(r.classifier, r.at);
  return all.filter((r) => r.at === latest.get(r.classifier));
}

export type RelationSource = { kind: string; closing: string | null; duplicateOf: number[]; duplicatedBy: number[]; linking: { number: number; closing: string }[] };

/** What relates the item to others: its own closing list, the classifiers' duplicate numbers both ways, and the PRs whose closing list may name it. One wave of 4 statements. */
export async function loadRelations(db: Db, repo: string, number: number): Promise<RelationSource> {
  const q = queryDb(db), { k } = q;
  const [item, of, by, linking] = await db.together(() => Promise.all([
    q.get(k.selectFrom("main.items").select(["kind", "closing_issues"]).where("repo", "=", repo).where("number", "=", number)),
    q.all(k.selectFrom("main.classifications").select("dup_of").distinct().where("repo", "=", repo).where("number", "=", number).where("dup_of", "is not", null).limit(10)),
    q.all(k.selectFrom("main.classifications").select("number").distinct().where("repo", "=", repo).where("dup_of", "=", number).limit(10)),
    q.all(k.selectFrom("main.items").select(["number", "closing_issues"]).where("repo", "=", repo).where("kind", "=", "pr").where((eb) => kx.like(db, "closing_issues", eb.val(`%${number}%`))).limit(50)),
  ]));
  return {
    kind: item?.kind ?? "", closing: item?.closing_issues ?? null, duplicateOf: of.map((r) => Number(r.dup_of)), duplicatedBy: by.map((r) => Number(r.number)),
    linking: linking.map((r) => ({ number: Number(r.number), closing: r.closing_issues ?? "[]" })),
  };
}
