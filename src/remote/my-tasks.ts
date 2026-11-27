// Each user's task picks for their Task Runners: which kinds of work (pipeline stages) the runners take from the queue. Stored
// in `user_settings` under `skip_tasks` as a JSON list of the tasks the user unticked, so no row means every task, and a task
// added later starts ticked. Picks ("Run on my Task Runner") and follow-ups of the user's own sessions do not go by it, as with
// My repos (my-repos.ts).
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { STAGES, stageOfStep } from "../stages/registry.ts";
import type { Db } from "../db/index.ts";
import { loadUserSettings, saveUserSettings } from "../data/runners/index.ts";

export const SKIP_TASKS_KEY = "skip_tasks";
/** The task of a call whose step belongs to no stage that makes model calls (security scans, Discord, and a step not known). */
export const OTHER_TASK = "other";

/** `about`: the first sentence of the stage's description; `models`: the Claude models its calls ask for, largest first. */
export type TaskChoice = { id: string; title: string; about: string; models: string[] };

const CLAUDE_MODELS = ["opus", "sonnet", "haiku"] as const;
const firstSentence = (text: string): string => /^.*?\.(?=\s|$)/.exec(text)?.[0] ?? text;

/** What a task's first description sentence leaves out of the steps it covers. */
const ALSO: Record<string, string> = {
  merge: "It also covers the Opus review of a PR's head commit before the PR goes into a batch or a pre-approved merge is handed to the queue.",
};

/** The tasks a user can tick, in pipeline order: each stage that makes model calls, then Other. */
export const TASK_CHOICES: readonly TaskChoice[] = [
  ...[...STAGES].filter((s) => s.promptIds.length > 0).sort((a, b) => a.order - b.order).map((s) => ({
    id: s.id, title: s.title, about: [firstSentence(s.description), ALSO[s.id]].filter(Boolean).join(" "),
    models: CLAUDE_MODELS.filter((m) => s.models.some((x) => x.model === m)),
  })),
  {
    id: OTHER_TASK, title: "Other", about: "Calls of steps outside the stages above: the security scan's checks and private fixes, Discord mentions, searches and issue drafts, and any call whose step is not known.",
    models: CLAUDE_MODELS.filter((m) => Object.values(CLAUDE_PROMPTS).some((p) => /^(security|discord)\./.test(p.id) && (p.models as readonly string[]).includes(m))),
  },
];
const TASK_IDS = new Set(TASK_CHOICES.map((t) => t.id));

/** The task a call of `step` belongs to. */
export function taskOfStep(step: string): string {
  const id = stageOfStep(step)?.id;
  return id !== undefined && TASK_IDS.has(id) ? id : OTHER_TASK;
}

/** The tasks the user unticked; empty when they take every task. Ids no longer offered are dropped. */
export async function userSkips(db: Db, login: string): Promise<Set<string>> {
  return skipsIn((await loadUserSettings(db, [login])).get(login.toLowerCase())!.skipTasks);
}

/** The offered tasks among stored skipped ids. */
export const skipsIn = (ids: readonly string[]): Set<string> => new Set(ids.filter((x) => TASK_IDS.has(x)));

/** The unticked tasks of a stored `skip_tasks` value (undefined: no row). */
export function skipsOf(value: string | undefined): Set<string> {
  if (value === undefined) return new Set();
  try {
    const v = JSON.parse(value) as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && TASK_IDS.has(x)) : []);
  } catch {
    return new Set();
  }
}

/** The tasks the user takes, in TASK_CHOICES order. */
export const userTasks = async (db: Db, login: string): Promise<string[]> => {
  const skip = await userSkips(db, login);
  return TASK_CHOICES.map((t) => t.id).filter((id) => !skip.has(id));
};

/** Ticked tasks from a request body, checked against TASK_CHOICES; throws with the reason for a bad list. */
export function parseTasks(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > TASK_CHOICES.length * 2 || !raw.every((x) => typeof x === "string")) throw new Error("tasks must be a list of task ids");
  const unknown = (raw as string[]).filter((x) => !TASK_IDS.has(x));
  if (unknown.length) throw new Error(`unknown task: ${unknown.slice(0, 5).join(", ")}; tasks are ${[...TASK_IDS].join(", ")}`);
  return [...new Set(raw as string[])];
}

/** Stores the ticked tasks as the unticked rest (every task ticked removes the row); a change is audited. */
export async function setUserTasks(db: Db, login: string, tasks: readonly string[]): Promise<string[]> {
  const on = new Set(tasks);
  const skip = skipsIn((await saveUserSettings(db, login, { skipTasks: TASK_CHOICES.map((t) => t.id).filter((id) => !on.has(id)) }, login)).skipTasks);
  return TASK_CHOICES.map((t) => t.id).filter((id) => !skip.has(id));
}
