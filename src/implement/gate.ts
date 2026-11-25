// What an implement job needs before it starts, checked again at the run: the repo's issue implementation approval, its
// Implement switch, and a fast_track row on the issue by someone who settles on the repo (src/settlers.ts); in a repo on the
// maintainer workflow, a live implement workflow started by such a person instead. A job that only ends an attempt whose PR
// merged or closed needs none of them.
import { fixIssueApprovalOf } from "./approval.ts";
import { featureOn } from "../build/features.ts";
import { settlesNow } from "../settlers.ts";
import { currentImplementation } from "./store.ts";
import { liveWorkflow, repoWorkflow } from "../workflow/store.ts";
import type { Db } from "../db/index.ts";

/** The login that queued the issue (its fast_track row; in a repo on the maintainer workflow, who started its live implement workflow), or null. */
export async function queuerOf(db: Db, repo: string, number: number): Promise<string | null> {
  if (await repoWorkflow(db, repo) === "new") {
    const w = await liveWorkflow(db, repo, number);
    return w?.entry === "implement" ? w.startedBy : null;
  }
  return (await db.get(db.k.selectFrom("main.fast_track").select("added_by").where("repo", "=", repo).where("number", "=", number)))?.added_by ?? null;
}

/** Why an implement job of the issue may not run, or null. `dry`: a dry run, which may run while the repo's Implement switch is off. */
export async function implementRefusal(db: Db, repo: string, number: number, o: { dry?: boolean } = {}): Promise<string | null> {
  // A live attempt whose PR merged or closed only ends (attempt and workspace): bookkeeping that always runs.
  if (!o.dry && await endsAttempt(db, repo, number)) return null;
  if (!await fixIssueApprovalOf(db, repo)) return `issue implementations in ${repo} are not approved`;
  if (!o.dry && !await featureOn(db, "implement", repo)) return `Implement is off for ${repo}`;
  const by = await queuerOf(db, repo, number);
  if (!by) return `${repo}#${number} is not queued`;
  if (!await settlesNow(db, by, [repo])) return `${by}, who queued ${repo}#${number}, does not settle on ${repo}`;
  return null;
}

/** The issue's live attempt has a PR that merged or closed: its next implement job only ends it. */
async function endsAttempt(db: Db, repo: string, number: number): Promise<boolean> {
  const impl = await currentImplementation(db, repo, number);
  if (impl?.prNumber == null) return false;
  const pr = await db.get(db.k.selectFrom("main.items").select("state").where("repo", "=", repo).where("number", "=", impl.prNumber));
  return !!pr && pr.state !== "OPEN";
}
