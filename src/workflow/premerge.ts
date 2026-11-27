// The pre-merge review's findings as parts of an item's plan.
import { loadPatchFacts, pushChainOf } from "../data/changes/index.ts";
import { loadPremerge } from "../data/review/index.ts";
import type { Db } from "../db/index.ts";
import { findingsOf, type PremergeRow } from "../premerge/store.ts";
import { followUpDefects, stoppingDefects } from "../premerge/types.ts";
import type { PlanPart } from "./types.ts";
import { droppedReviewTitles, overruledAt } from "./work.ts";

/**
 * The findings at the PR's head that a fix-up is asked for, as plan parts numbered after `plan`'s: every defect that stops the merge, and
 * what has a fix. On a PR approved for merge (`approved`) the defects that do not stop it are filed as follow-ups instead.
 */
export async function premergeParts(db: Db, pr: { repo: string; number: number; head: string }, plan: readonly PlanPart[], approved: boolean): Promise<PlanPart[]> {
  const ref = `${pr.repo}#${pr.number}`;
  const [rows, patches] = await db.together(() => Promise.all([loadPremerge(db, [pr]), loadPatchFacts(db, [{ repo: pr.repo, number: pr.number }])]));
  const overruled = overruledAt(plan, approved, pushChainOf(patches.get(ref)?.pushes ?? [], pr.head));
  return premergePartsOf(rows.get(`${ref}@${pr.head}`) ?? null, plan, approved, overruled);
}

/**
 * `premergeParts` of a row already read: a finding a person dropped from the plan (same title) is no part again, but a dropped pre-merge
 * finding only while it overrules the review at the head (`overruled`, overruledAt): after an accepted author push it is a new part, which a
 * person can drop again at that head. Pure.
 */
export function premergePartsOf(row: PremergeRow | null, plan: readonly PlanPart[], approved: boolean, overruled: readonly string[] = []): PlanPart[] {
  const from = plan.reduce((m, p) => Math.max(m, p.n), 0);
  const dropped = [...droppedReviewTitles(plan), ...overruled];
  const all = findingsOf(row).filter((f) => !dropped.includes(f.title.toLowerCase()));
  const stops = new Set(stoppingDefects(all, approved)), filed = new Set(approved ? followUpDefects(all) : []);
  return all.filter((f) => !filed.has(f) && (f.fix || stops.has(f)))
    .map((f, i) => ({ n: from + i + 1, title: f.title, source: "review" as const, file: f.file, ...(stops.has(f) ? { major: true } : {}), premerge: true as const, state: "planned" as const }));
}
