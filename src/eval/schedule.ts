// When the self-evaluation runs: once an hour, only while the setting eval_repo names a tracked repo.
import type { Db } from "../db/index.ts";
import { loadTrackedRepos, saveSettings, setting, SETTINGS } from "../data/control/index.ts";

export const EVAL_REPO_KEY = "eval_repo";
/** Least time between two eval jobs (the owner asked for hourly runs). */
export const EVAL_EVERY_MS = 55 * 60_000;

/** The eval repo when one is set and tracked; otherwise null (the evaluation is off). */
export async function evalRepo(db: Db): Promise<string | null> {
  const r = SETTINGS.evalRepo.read(await setting(db, EVAL_REPO_KEY));
  return r && (await loadTrackedRepos(db, [r])).has(r) ? r : null;
}

/** Sets the eval repo (a tracked repo) or clears it with null; audited as `eval-repo`. */
export async function setEvalRepo(db: Db, repo: string | null, by: string): Promise<void> {
  if (repo !== null && !(await loadTrackedRepos(db, [repo])).has(repo)) throw new Error(`${repo} is not a tracked repo`);
  await saveSettings(db, [{ key: EVAL_REPO_KEY, value: repo }], by, { action: "eval-repo", target: "pipeline", details: { repo } });
}
