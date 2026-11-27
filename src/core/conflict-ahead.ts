// Who settles a PR's conflict with its base branch once its merge is approved, asked before the approval.
import { loadChecks, loadItems } from "../data/mirror/index.ts";
import type { Db } from "../db/index.ts";
import { authorWrites } from "../fixup/author-permission.ts";
import { conflictBucket } from "../fixup/conflict-state.ts";
import { longLivedOf, pushable } from "../fixup/pushable.ts";
import { conflictPath, settlesConflict, type ConflictPath } from "./decide.ts";
import { loadPrFact } from "./facts.ts";
import type { PrFacts } from "./plan.ts";
import { BASE_NAME } from "./rules.ts";

/** Who settles the PR's conflict once its merge is approved, also while no review says it is wanted yet; null when it does not conflict. */
export async function conflictAhead(db: Db, item: { repo: string; number: number }, read?: PrFacts | null): Promise<ConflictPath | null> {
  const { repo, number } = item, one = [{ repo, number }], key = `${repo}#${number}`;
  const [items, checks] = await db.together(() => Promise.all([loadItems(db, one, "pr"), loadChecks(db, one)]));
  const it = items.get(key), ch = checks.get(key);
  if (it?.mergeable !== "CONFLICTING" && ch?.mergeable !== "CONFLICTING") return null;
  const f = read === undefined ? await loadPrFact(db, repo, number) : read;
  if (f?.mergeable !== "CONFLICTING" || !it) return null;
  const known = conflictPath(f);
  if (known !== null || !f.head) return known;
  const [longLived, writes] = await db.together(() => Promise.all([longLivedOf(db, repo), authorWrites(db, repo, number)]));
  // An author whose permission has not been read yet counts as able to write, as in the plan.
  const can = pushable(it.head_repo, repo, ch?.head_oid === f.head ? ch?.maintainer_can_modify : it.maintainer_can_modify, it.head_ref, longLived, false, writes !== "no");
  const bucket = await conflictBucket(db, { repo, number, head: f.head, pushable: can, uncapped: true }, { push: true, comment: f.repoFacts.commentApproved && !f.quiet });
  return settlesConflict({ conflict: { bucket, base: it.base_ref ?? "", baseOk: BASE_NAME.test(it.base_ref ?? "") }, pushable: can });
}
