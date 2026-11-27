// The pure rules of who may take a queued call, shared by the claim (calls.ts), the room (room.ts), the taker rule
// (takers.ts), started work (started.ts) and the picks (picks.ts).
import type { ItemRef } from "../../web/src/api/types.ts";
import { gating } from "./claim-class.ts";
import { taskOfStep } from "./my-tasks.ts";
import type { Tier } from "./protocol.ts";
import { itemsFit, type ItemFilter } from "./task-items.ts";

/** Prompts that judge an item: an author or co-author of an item they judge gets their calls only when no other helper that could take them is asking for work. */
export { judges } from "../data/runners/index.ts";

export const sameLogin = (a: string | null, b: string): boolean => a !== null && a.toLowerCase() === b.toLowerCase();

/** What a helper's fast-lane slot takes: gating calls (its own sessions' follow-ups among them) and small-tier calls. */
export const fastLaneFits = (r: { tier: Tier; parent_id: number | null; prompt_id: string }): boolean => gating(r) || r.tier === "small";

/** The role rules: maintainers and operators; discord.* calls and calls that name no repo go to operators only. */
export const roleFits = (role: string, c: { prompt_id: string; repos: readonly string[] }): boolean =>
  (role === "operator" || role === "maintainer") && !((c.prompt_id.startsWith("discord.") || !c.repos.length) && role !== "operator");

/**
 * Whether a Task Runner may take a call, authorship and picks apart: its user fits the role rules, may write to every repo the
 * call names (`canWrite`) and takes calls on each of them (`repos`: the user's My repos narrowed by the runner's own list, null
 * for every repo) and the call's task (`skip`: the tasks the user unticked; a call without a `step` is a question about repos
 * alone) and its items (`items`: the user's item choice; a call without `refs` is a question asked before its items are known).
 */
export const runnerTakes = (r: { login: string; role: string; repos: ReadonlySet<string> | null; skip?: ReadonlySet<string>; items?: ItemFilter }, c: { prompt_id: string; repos: readonly string[]; step?: string; refs?: readonly ItemRef[] }, canWrite: (login: string, repo: string) => boolean): boolean =>
  roleFits(r.role, c) && !(c.step !== undefined && r.skip?.has(taskOfStep(c.step))) && c.repos.every((x) => (!r.repos || r.repos.has(x)) && canWrite(r.login, x)) && itemsFit(r.items ?? null, c);
