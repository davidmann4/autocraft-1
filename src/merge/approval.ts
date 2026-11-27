// Merge approval. A repo's `merge` step approval lets the pipeline merge PRs nobody approved one by one (the automatic
// path); an operator, or a maintainer of the repo, turns it on (src/dash/api/admin.ts). A live workflow carries the
// approval of its own PR, or of the PR that implements its issue. `mergeVerdicts` asks the merge's permission (src/core/authority.ts) on the
// facts the planner decides on, read now.
import { setStepApproval } from "../data/control/index.ts";
import { permit } from "../core/authority.ts";
import { loadPrFacts } from "../core/facts.ts";
import { memberRefusal } from "../core/guard.ts";
import type { Permission, PrFacts } from "../core/plan.ts";
import type { Db } from "../db/index.ts";

// Returns false when nothing changed.
export async function setMergeApproval(db: Db, by: string, repo: string, approved: boolean): Promise<boolean> {
  return await setStepApproval(db, [{ repo, step: "merge", on: approved }], by) > 0;
}

const refuse = (code: "other" | "scope", text: string): Permission => ({ ok: false, why: { code, who: "system", text } });

/** Whether the PR may merge at `head`, on whose say and as whom. `batch`: as a member of an integration batch. Pure. */
export function mergeVerdict(f: PrFacts | undefined, head: string, o: { batch?: boolean } = {}): Permission {
  if (!f) return refuse("scope", "not an open PR the pipeline tracks");
  if (f.ghState !== "OPEN") return refuse("other", `no longer open (${f.ghState.toLowerCase()})`);
  if (f.head !== head) return refuse("other", `its head is ${(f.head ?? "unknown").slice(0, 7)}, not ${head.slice(0, 7)}`);
  const may = permit(f, { kind: "merge" });
  const out = may.ok && o.batch ? memberRefusal(f) : null;
  return out ? refuse("other", out) : may;
}

/** Whether each PR of the repo may merge at the given head (`mergeVerdict`), from one load of the facts. */
export async function mergeVerdicts(db: Db, repo: string, items: { number: number; head: string }[], o: { batch?: boolean } = {}): Promise<Map<number, Permission>> {
  if (!items.length) return new Map();
  const facts = new Map((await loadPrFacts(db, { repo, refs: items.map((i) => `${repo}#${i.number}`) })).map((f) => [f.number, f]));
  return new Map(items.map((i) => [i.number, mergeVerdict(facts.get(i.number), i.head, o)]));
}

/** `repo#n: why` of the first PR that may not merge, or null when all may. */
export const firstRefusal = (verdicts: Map<number, Permission>, repo: string): string | null => {
  for (const [n, v] of verdicts) if (!v.ok) return `${repo}#${n}: ${v.why.text}`;
  return null;
};
