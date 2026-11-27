// Heads at which a take or take-fix review was unsure (M13 review).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import { headRef, noKeys } from "./rows.ts";
import type { HeadRef } from "./types.ts";

/** The statement of `loadUnsureHeads`: the current and overwritten reviews of `keys` that were a take or take-fix with sure = 0. */
export function unsureHeadsQuery(db: Db, keys: KeySource) {
  const q = queryDb(db);
  const of = (table: "main.opus_review_history" | "main.opus_reviews") => q.k.selectFrom(`${table} as u` as "main.opus_reviews as u")
    .innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "u.repo").onRef("kk.number", "=", "u.number"))
    .select(["u.repo", "u.number", "u.head_oid"]).where("u.verdict", "in", ["take", "take-fix"]).where("u.sure", "=", 0);
  return of("main.opus_review_history").unionAll(of("main.opus_reviews"));
}

/** Every head of `keys` at which a stored Opus review (current or overwritten) was an unsure take or take-fix. 1 statement. */
export async function loadUnsureHeads(db: Db, keys: KeySource): Promise<Set<HeadRef>> {
  const out = new Set<HeadRef>();
  if (noKeys(keys)) return out;
  for (const r of await queryDb(db).all(unsureHeadsQuery(db, keys), { label: "review.loadUnsureHeads" })) out.add(headRef(r.repo, r.number, r.head_oid));
  return out;
}
