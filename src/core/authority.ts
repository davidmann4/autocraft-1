// Whether an action that is due may run. Pure. The one place that answers it for an item: decidePr and decideItem put the answer on each
// action, and what starts, picks or writes work reads it there (mayRun).
import { refusalWho, type Refusal } from "./codes.ts";
import { CLI_BY, gatePermission, gateRepo, mergeApproval, pushMayOf, type By, type PushKind, type RepoApprovals, type RepoNeed, type Want } from "./gates.ts";
import type { MayResult } from "./may.ts";
import type { Action, ItemFacts, Permission, PrFacts } from "./plan.ts";

/** An action of a plan, as the rules see it. */
export const wantOf = (a: Action): Want => ({
  kind: a.kind, ...(typeof a.params?.bucket === "string" ? { bucket: a.params.bucket } : {}), ...(typeof a.params?.source === "string" ? { source: a.params.source } : {}),
});

/** Whether the action may run, whoever starts the job: the global pipeline switch is not asked (mayRun). */
export const permit = (f: PrFacts | ItemFacts, a: Want): Permission => gatePermission(f, a, CLI_BY);

/** The actions of a plan with the permission of each. */
export const permitted = (f: PrFacts | ItemFacts, actions: readonly Action[]): Action[] => actions.map((a) => ({ ...a, permission: permit(f, wantOf(a)) }));

const refusal = (code: Refusal["code"], text: string, params?: Refusal["params"]): Refusal => ({ code, who: refusalWho(code), ...(params ? { params } : {}), text });

/** Whether a job of `by` may run the planned action: the switch for the pipeline's own jobs, then the action's permission. */
export function mayRun(p: { facts: PrFacts | ItemFacts; action: Action }, by: By): Permission {
  if (by === "pipeline" && !p.facts.pipelineOn) return { ok: false, why: refusal("pipeline-off", "The pipeline is off") };
  return p.action.permission ?? permit(p.facts, wantOf(p.action));
}

const ofMay = (m: MayResult, as: Extract<Permission, { ok: true }>["as"]): Permission =>
  (m.ok ? { ok: true, as, by: { kind: m.as, login: m.by } } : { ok: false, why: refusal(m.code, m.why) });

/** Whether the merge of the PR at its head is approved, handed over to the queue or not; `as`: who it is made as. */
export function mergePermission(f: PrFacts): Permission {
  const m = mergeApproval(f);
  return ofMay(m, m.ok && m.as === "person" ? `user:${m.by}` : "app");
}

/** Whether a push of `kind` to the PR's branch is approved. `operatorFix`: a person's fix-up request. */
export const pushPermission = (f: PrFacts, kind: PushKind, operatorFix = false): Permission => ofMay(pushMayOf(f, kind, operatorFix), "app");

/**
 * Why a repo-level write is refused, or null. `members`: the verdicts of the items the write serves; a "merge", "fix-issue" or "status" write
 * passes without the repo's approval when every one of them passes.
 */
export function repoPermission(a: RepoApprovals, need: RepoNeed, by: By, repo: string, members: readonly { ok: boolean }[] = []): Refusal | null {
  const approved = (need === "merge" || need === "fix-issue" || need === "status") && members.length > 0 && members.every((m) => m.ok);
  const why = gateRepo(a, approved ? null : need, by, repo);
  return why === null ? null : by === "pipeline" && !a.pipelineOn ? refusal("pipeline-off", why) : refusal("repo-approval", why, { need, repo });
}
