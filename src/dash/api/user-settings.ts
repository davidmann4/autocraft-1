// The signed-in user's own settings (GET and PUT /api/me/settings); their Task Runners are listed by GET /api/runners (runners.ts).
// Maintainers and operators set their own settings; a viewer has none.
import { loadTrackedRepos } from "../../data/control/index.ts";
import { manualOnly, parseManualOnly, setManualOnly } from "../../remote/manual-only.ts";
import { parseInteractiveSlots, setUserInteractiveSlots, userInteractiveSlots } from "../../remote/interactive-slots.ts";
import { parseMaxCalls, setUserMaxCalls, userMaxCalls } from "../../remote/max-calls.ts";
import { parseRepos, setUserRepos, userRepos } from "../../remote/my-repos.ts";
import { parseTasks, setUserTasks, TASK_CHOICES, userTasks, type TaskChoice } from "../../remote/my-tasks.ts";
import type { UserSettingsReply } from "../../remote/protocol.ts";
import { parseTaskItems, setUserTaskItems, userTaskItems, type TaskItems } from "../../remote/task-items.ts";
import { parseReserve, setUserReserve, userReserve } from "../../remote/reserve.ts";
import { parseRunnerPrivate, runnerPrivate, setRunnerPrivate } from "../../remote/runner-private.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import type { Db } from "../../db/index.ts";

/** Repos with the pipeline on where the user has write permission, the permission a claim requires. */
async function repoChoices(db: Db, req: Req): Promise<string[]> {
  const repos = [...(await loadTrackedRepos(db)).values()].filter((r) => r.pipeline).map((r) => r.name).sort();
  const ok = await Promise.all(repos.map((r) => req.user.canWrite(r).catch(() => false)));
  return repos.filter((_, i) => ok[i]);
}

/**
 * The reply: the protocol's settings, `manualOnly` (manual-only.ts), the ticked `tasks` of `taskChoices` (my-tasks.ts), `taskItems`
 * (task-items.ts) and `runnerPrivate` (runner-private.ts).
 */
type SettingsReply = UserSettingsReply & { interactiveSlots: number; manualOnly: boolean; tasks: string[]; taskChoices: readonly TaskChoice[]; taskItems: TaskItems; runnerPrivate: boolean };

export const settings = async (db: Db, req: Req): Promise<SettingsReply> =>
  ({ reserve: await userReserve(db, req.user.login), repos: await userRepos(db, req.user.login), maxCalls: await userMaxCalls(db, req.user.login), interactiveSlots: await userInteractiveSlots(db, req.user.login, req.user.role), manualOnly: await manualOnly(db, req.user.login), tasks: await userTasks(db, req.user.login), taskChoices: TASK_CHOICES, taskItems: await userTaskItems(db, req.user.login), runnerPrivate: await runnerPrivate(db, req.user.login), repoChoices: await repoChoices(db, req) });

export async function setSettings(db: Db, req: Req): Promise<SettingsReply> {
  const b = req.json;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "the body must be a UserSettings object");
  const body = b as Record<string, unknown>;
  const known = ["reserve", "repos", "maxCalls", "interactiveSlots", "manualOnly", "tasks", "taskItems", "runnerPrivate"];
  for (const k of Object.keys(body)) if (!known.includes(k)) throw new HttpError(400, `unknown setting ${k}`);
  if (known.every((k) => body[k] === undefined)) throw new HttpError(400, "send reserve, repos, maxCalls, interactiveSlots, manualOnly, tasks, taskItems, runnerPrivate or several of them");
  if (req.user.role === "viewer") throw new HttpError(403, "viewers have no settings to change");
  let reserve, repos, tasks, maxCalls: number | null | undefined, slots: number | undefined, manual: boolean | undefined, priv: boolean | undefined, items: TaskItems | undefined;
  try {
    if (body.reserve !== undefined) reserve = parseReserve(body.reserve);
    if (body.repos !== undefined) repos = await parseRepos(db, body.repos);
    if (body.maxCalls !== undefined) maxCalls = parseMaxCalls(body.maxCalls);
    if (body.interactiveSlots !== undefined) slots = parseInteractiveSlots(body.interactiveSlots);
    if (body.manualOnly !== undefined) manual = parseManualOnly(body.manualOnly);
    if (body.tasks !== undefined) tasks = parseTasks(body.tasks);
    if (body.taskItems !== undefined) items = parseTaskItems(body.taskItems);
    if (body.runnerPrivate !== undefined) priv = parseRunnerPrivate(body.runnerPrivate);
  } catch (e) { throw new HttpError(400, (e as Error).message); }
  if (reserve) await setUserReserve(db, req.user.login, reserve);
  if (repos) await setUserRepos(db, req.user.login, repos);
  if (maxCalls !== undefined) await setUserMaxCalls(db, req.user.login, maxCalls);
  if (slots !== undefined) await setUserInteractiveSlots(db, req.user.login, req.user.role, slots);
  if (manual !== undefined) await setManualOnly(db, req.user.login, manual);
  if (tasks) await setUserTasks(db, req.user.login, tasks);
  if (items) await setUserTaskItems(db, req.user.login, items);
  if (priv !== undefined) await setRunnerPrivate(db, req.user.login, priv);
  return settings(db, req);
}
