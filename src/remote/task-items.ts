// Each user's item choice for their Task Runners: which items the runners take work on, next to My tasks (my-tasks.ts). "all"
// takes every item; "started" only items with work someone started or approved in the maintainer workflow (src/workflow);
// "mine" only the items whose work the user started or approved. Stored in the runners user settings (`task_items`); no row
// means "all". Picks ("Run on my Task Runner") and follow-ups of the user's own sessions do not go by it, as with My tasks and
// My repos.
//
// A call matches when any item it names matches: a call about a chosen item (a duplicate check against an older item, say) is
// work on that item. Batches (repoBatches in src/agents/call.ts) never mix items that different filtered users take
// (batchKey in takers.ts), so a batch matches a filtered user only when every item in it does. A question asked before the items are known
// (a job about to start, a repo's takers) counts a filtered runner only for the repos that have a matching item.
import type { Db } from "../db/index.ts";
import { loadRunnerSnapshot, loadUserSettings, saveUserSettings, type StartedWork } from "../data/runners/index.ts";

export const TASK_ITEMS_KEY = "task_items";
export const TASK_ITEMS = ["all", "started", "mine"] as const;
export type TaskItems = (typeof TASK_ITEMS)[number];

const isTaskItems = (v: unknown): v is TaskItems => typeof v === "string" && (TASK_ITEMS as readonly string[]).includes(v);

/** The user's item choice; "all" with no row or a value no longer offered. */
export async function userTaskItems(db: Db, login: string): Promise<TaskItems> {
  return (await loadUserSettings(db, [login])).get(login.toLowerCase())!.taskItems;
}

/** The item choice from a request body ("fast", the choice before fast track went, is "started"); throws with the reason for a bad one. */
export function parseTaskItems(raw: unknown): TaskItems {
  if (raw === "fast") return "started";
  if (!isTaskItems(raw)) throw new Error(`taskItems must be one of ${TASK_ITEMS.join(", ")}`);
  return raw;
}

/** Stores the item choice ("all" removes the row); a change is audited. */
export async function setUserTaskItems(db: Db, login: string, v: TaskItems): Promise<TaskItems> {
  return (await saveUserSettings(db, login, { taskItems: v }, login)).taskItems;
}

/** The open items a filtered user takes (`refs`, as `repo#number`) and their repos; null for a user who takes every item. */
export type ItemFilter = { refs: ReadonlySet<string>; repos: ReadonlySet<string> } | null;

/** The user's ItemFilter, read now. */
export async function itemFilter(db: Db, login: string): Promise<ItemFilter> {
  const now = Date.now();
  const [settings, snapshot] = await db.together(() => Promise.all([loadUserSettings(db, [login]), loadRunnerSnapshot(db, now)]));
  return itemFilterOf(snapshot.started, login, settings.get(login.toLowerCase())!.taskItems);
}

/** The ItemFilter of the user's `choice` over the started work of the runner snapshot. */
export function itemFilterOf(started: StartedWork, login: string, choice: TaskItems): ItemFilter {
  if (choice === "all") return null;
  const self = login.toLowerCase();
  const mine = (r: { started_by: string; approved_by: string | null }): boolean => choice !== "mine" || r.started_by.toLowerCase() === self || r.approved_by?.toLowerCase() === self;
  const refs = [...started.live.filter(mine).map((r) => ({ repo: r.repo, number: r.number })), ...started.prs.filter(mine).map((r) => ({ repo: r.repo, number: r.prNumber }))];
  return { refs: new Set(refs.map((r) => `${r.repo}#${r.number}`)), repos: new Set(refs.map((r) => r.repo)) };
}

/**
 * Whether a filter lets a runner take work: `refs` known (a queued call, a pool's unit), when any of them matches, so a call about
 * no item never does; `refs` unknown (a job about to start), when any of `repos` has a matching item.
 */
export function itemsFit(f: ItemFilter, c: { repos: readonly string[]; refs?: readonly { repo: string; number: number }[] }): boolean {
  if (!f) return true;
  if (c.refs) return c.refs.some((r) => f.refs.has(`${r.repo}#${r.number}`));
  return c.repos.some((x) => f.repos.has(x));
}

/** The choice a filtered user made, as the no-taker reason names it. */
export const TASK_ITEMS_TITLE: Record<Exclude<TaskItems, "all">, string> = { started: "started items only", mine: "only the items they started or approved" };

