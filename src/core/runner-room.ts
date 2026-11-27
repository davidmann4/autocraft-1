// Whether a Task Runner can take the work a person just started or approved on an item, for the line the confirmation adds
// (src/workflow/apply.ts). Model calls run only on people's own Task Runners. The person's own runner takes their started work
// whatever their Manual only, My repos and tasks (src/remote/started.ts), under the role rules and write permission alone; another
// person's runner takes it under that person's settings (src/remote/room.ts). Item choices (My tasks: which items) are left out: the
// item becomes started work with this command, which a snapshot read before the write does not show yet.
import type { Db } from "../db/index.ts";
import { loadRunnerSnapshot, STATUS_FRESH_MS, type RunnerRow, type RunnerSnapshot } from "../data/runners/index.ts";
import { claimReposOf } from "../remote/my-repos.ts";
import { skipsIn, TASK_CHOICES } from "../remote/my-tasks.ts";
import { roleFits, runnerTakes } from "../remote/rules.ts";
import { canWriteOf, freshReady, settingsOf } from "../remote/view.ts";

/**
 * `own`: the person has a live Task Runner credential, connected or not. When none can run the work now, `why` says why: `none`, no
 * Task Runner that may take the repo is ready; `held`, those that may take it are held by their usage limit; `own-held`, the only
 * ones held are the person's own. `until`: the earliest time a held one is free again, when the runners reported one.
 */
export type RunnerRoom =
  | { can: true; own: boolean }
  | { can: false; own: boolean; why: "none" | "held" | "own-held"; until: string | null };

/** RunnerRoom over a runner snapshot read at `now`, for work on `repo` that `login` started or approved. */
export function runnerRoomOf(s: RunnerSnapshot, now: number, repo: string, login: string): RunnerRoom {
  const self = login.toLowerCase();
  const mine = (r: RunnerRow): boolean => r.login.toLowerCase() === self;
  const canWrite = canWriteOf(s);
  const call = { prompt_id: "", repos: [repo] };
  const takes = (r: RunnerRow): boolean => {
    if (r.role === null) return false;
    if (mine(r)) return roleFits(r.role, call) && canWrite(r.login, repo);
    const set = settingsOf(s, r.login);
    const skip = skipsIn(set.skipTasks);
    return !set.manualOnly && skip.size < TASK_CHOICES.length && runnerTakes({ login: r.login, role: r.role, repos: claimReposOf(set.repos, r.idleRepos ?? undefined), skip }, call, canWrite);
  };
  const own = s.runners.some(mine);
  const connected = s.runners.filter((r) => r.reportedAt !== null && r.reportedAt >= now - STATUS_FRESH_MS && takes(r));
  if (connected.some((r) => freshReady(s, r, now))) return { can: true, own };
  const held = connected.filter((r) => r.readiness === "quota-held");
  if (!held.length) return { can: false, own, why: "none", until: null };
  const times = held.flatMap((r) => (r.until !== null && Date.parse(r.until) > now ? [r.until] : [])).sort((a, b) => Date.parse(a) - Date.parse(b));
  return { can: false, own, why: held.every(mine) ? "own-held" : "held", until: times[0] ?? null };
}

/** RunnerRoom now, from the runners module's snapshot (cached briefly per process). */
export async function loadRunnerRoom(db: Db, repo: string, login: string, now: number = Date.now()): Promise<RunnerRoom> {
  return runnerRoomOf(await loadRunnerSnapshot(db, now), now, repo, login);
}
