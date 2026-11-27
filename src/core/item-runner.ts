// Whether a person may take a live workflow's work onto their own Task Runner (`take`), or release it (`release`). The command core
// (src/workflow/apply.ts) refuses with the answer; the item page shows its button only where the answer is null. Who may send commands
// at all (an AutoCraft login with the maintainer or operator role and write access on the repo) is checked before, as for every command.

/** What the rule reads: the person's live Task Runner credentials and the logins that hold a live grant on the workflow. */
export type TakeFacts = { runners: number; takers: readonly string[] };
export type TakeRefusal = "own-work" | "no-runner" | "already-taken" | "not-taken";

/**
 * Why `login` may not take (or release) the workflow's work, or null. Its starter's and approver's own runners take it first anyway,
 * and a take puts work only on the sender's own Task Runner, which they need to have.
 */
export function takeRefusal(wf: { startedBy: string; approvedBy: string | null }, login: string, word: "take" | "release", f: TakeFacts): TakeRefusal | null {
  const me = login.toLowerCase();
  const held = f.takers.some((l) => l.toLowerCase() === me);
  if (word === "release") return held ? null : "not-taken";
  if ([wf.startedBy, wf.approvedBy].some((l) => l?.toLowerCase() === me)) return "own-work";
  if (f.runners === 0) return "no-runner";
  return held ? "already-taken" : null;
}
