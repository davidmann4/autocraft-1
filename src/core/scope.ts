// Which tracked repos the pipeline works, and which build tasks it runs: one rule per kind of work. Pure.

/**
 * What a repo is in scope for:
 * - `work`: the steps on items, the merge steps among them; its Pipeline switch is on, or a workflow is live in it;
 * - `cards`: what people asked for one by one, closes and the action cards of conversations; as `work`, or a close is due in it;
 * - `cleanup`: taking back what the pipeline left in it, and the last word on what it did; every tracked repo;
 * - `builds`: build tasks and merge batches of items nobody started; the switch.
 */
export type ScopeFor = "work" | "cards" | "cleanup" | "builds";

/** A tracked repo: its Pipeline switch, whether a workflow is live in it and whether a close a person asked for is due. */
export type RepoScope = { pipeline: boolean; live: boolean; close: boolean };

/** `r` undefined: the repo is not tracked. */
export function repoInScope(r: RepoScope | undefined, what: ScopeFor): boolean {
  if (!r) return false;
  switch (what) {
    case "builds": return r.pipeline;
    case "work": return r.pipeline || r.live;
    case "cards": return r.pipeline || r.live || r.close;
    case "cleanup": return true;
  }
}

/** Whether a build task for `refs` (its PR, or the members of its batch) runs: in a repo in scope for builds, or when a person started every item it is for. */
export const taskInScope = (r: Pick<RepoScope, "pipeline"> | undefined, refs: readonly string[], started: ReadonlySet<string>): boolean =>
  !!r?.pipeline || (refs.length > 0 && refs.every((ref) => started.has(ref)));
