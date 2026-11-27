// Picks ("Run on my Task Runner" in the model call queue): a maintainer or operator reserves a queued call for their own Task
// Runners. Their runners take their picks before the queue's order; other users' runners pass a call over while its pick
// counts (calls.ts claimOrder, leaseCall). A pick counts until its time is up (setting remote_pick_minutes, 0: no time
// limit), while one of the picker's runners is fresh and the picker is neither cooling off nor at their Max calls at once
// (calls.ts pickerExpr); it ends with a lease, a requeue, an unpick, or at a claim that finds
// the call released by or no longer open to the picker. Registered as a wait in src/stages/registry.ts.
import type { ItemRef } from "../../web/src/api/types.ts";
import { HttpError } from "../dash/server/util.ts";
import type { Role } from "../dash/types.ts";
import { judges, roleFits } from "./rules.ts";
import { pickCounts } from "./picks-rules.ts";
import { STATUS_FRESH_MS } from "./helpers.ts";
import { modelsOf, REMOTE_MODELS_KEY } from "./mode.ts";
import type { Tier } from "./protocol.ts";
import { CALLER_STALE_MS } from "./room.ts";
import { tiersOf } from "./view.ts";
import type { Db } from "../db/index.ts";
import { addAudit, saveSettings, setting } from "../data/control/index.ts";
import { clearPicks, loadPickContext, pickCapOf, savePick, type PickContext } from "../data/runners/index.ts";

/** Setting: minutes a pick counts; 0 means until it ends otherwise. */
export const PICK_MINUTES_KEY = "remote_pick_minutes";
export const PICK_MINUTES_DEFAULT = 15;
const PICK_MINUTES_MAX = 24 * 60;
/** The most live picks a user holds, whatever their runners' slots. */
export const PICKS_MAX = 8;

export async function pickMinutes(db: Db): Promise<number> {
  const v = await setting(db, PICK_MINUTES_KEY);
  const n = Number(v);
  return v !== undefined && Number.isInteger(n) && n >= 0 && n <= PICK_MINUTES_MAX ? n : PICK_MINUTES_DEFAULT;
}

export async function setPickMinutes(db: Db, input: unknown, by: string): Promise<number> {
  const n = typeof input === "number" ? input : typeof input === "string" && /^[0-9]+$/.test(input) ? Number(input) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > PICK_MINUTES_MAX) throw new Error(`the minutes a pick counts must be a whole number from 0 (no limit) to ${PICK_MINUTES_MAX}`);
  const was = await pickMinutes(db);
  if (n !== was) await saveSettings(db, [{ key: PICK_MINUTES_KEY, value: String(n) }], by, { action: "remote-pick-minutes", target: "pipeline", details: { minutes: n, was } });
  return n;
}

/** How long a new pick counts, in ms (scaled like the mode's other windows); null for no limit. */
export async function pickCapMs(db: Db): Promise<number | null> {
  return pickCapOf(await setting(db, PICK_MINUTES_KEY));
}

export type Picker = { login: string; role: Role; canWrite: (repo: string) => Promise<boolean> };

/** What the user may pick: `canPick` with the tiers their fresh runners cover, their live picks and the most they may hold. */
export type PickerState = { canPick: boolean; why: string | null; tiers: ReadonlySet<Tier>; picks: number; pickMax: number };

/** The user's fresh Task Runners together: the tiers their models cover (accepted families) and their slots without the fast lane. */
function freshRunnersOf(ctx: PickContext, accepted: Record<Tier, string[]>, nowMs: number): { tiers: Set<Tier>; slots: number; count: number } {
  const rows = ctx.runners.filter((r) => r.reportedAt !== null && r.reportedAt >= nowMs - STATUS_FRESH_MS);
  const tiers = new Set<Tier>();
  let slots = 0;
  for (const r of rows) {
    const n = r.slots ?? 1;
    // A runner reporting 2 or more slots runs one of them as its fast lane (room.ts).
    slots += n - (n >= 2 ? 1 : 0);
    for (const t of tiersOf(r.models, accepted)) tiers.add(t);
  }
  return { tiers, slots, count: rows.length };
}

/** What picks read: the call (none for -1), the user's runners, live picks and cool-off, whose picks count, the cap, with the accepted models. One wave. */
async function pickReads(db: Db, login: string, id: number, nowMs: number): Promise<{ ctx: PickContext; accepted: Record<Tier, string[]> }> {
  const [ctx, models] = await db.together(() => Promise.all([loadPickContext(db, login, id, nowMs), setting(db, REMOTE_MODELS_KEY)]));
  return { ctx, accepted: modelsOf(models).accepted };
}

export async function pickerState(db: Db, user: Pick<Picker, "login" | "role">, nowMs: number): Promise<PickerState> {
  const { ctx, accepted } = await pickReads(db, user.login, -1, nowMs);
  return pickerStateOf(ctx, accepted, user, nowMs);
}

function pickerStateOf(ctx: PickContext, accepted: Record<Tier, string[]>, user: Pick<Picker, "login" | "role">, nowMs: number): PickerState {
  const none = (why: string): PickerState => ({ canPick: false, why, tiers: new Set(), picks: 0, pickMax: 0 });
  if (user.role !== "maintainer" && user.role !== "operator") return none("only maintainers and operators pick calls");
  const runners = freshRunnersOf(ctx, accepted, nowMs);
  const picks = ctx.livePicks;
  const pickMax = Math.min(ctx.max, runners.slots);
  if (!runners.count || !runners.tiers.size) return { ...none("none of your Task Runners is running"), picks };
  if (ctx.cooled) return { ...none(`your Task Runners are cooled off: ${ctx.cooled.reason}`), picks, pickMax };
  return { canPick: pickMax > 0, why: pickMax > 0 ? null : "your Task Runners have no free slots", tiers: runners.tiers, picks, pickMax };
}

/** A queued call as picks read it. */
export type PickCall = { id: number; tier: Tier; promptId: string; parentId: number | null; repos: string[]; authors: ReadonlySet<string>; seenAt: number; pickedBy: string | null; pickUntil: number | null; /** Lowercase login of the user whose own runners alone take it (calls.ts NewCall.forLogin). */ forLogin: string | null };

/**
 * Why the user may not pick the call now, or null: only a queued call with a live caller, bound to no user, not a follow-up, not a judging
 * call on the user's own item, not under another user's live pick, of a tier the user's runners cover, that the role rules
 * give the user and on whose every repo the user may write; and only below the user's most picks. `fresh`: whether a login's
 * picks count (pickerLogins).
 */
export async function pickRefusal(state: PickerState, user: Picker, c: PickCall, nowMs: number, fresh: (login: string) => boolean | Promise<boolean>): Promise<string | null> {
  if (!state.canPick) return state.why;
  const login = user.login.toLowerCase();
  const counts = c.pickedBy !== null && pickCounts(c, nowMs, () => true) && await fresh(c.pickedBy);
  if (c.pickedBy === login && counts) return "you picked it already";
  if (c.pickedBy !== null && counts) return "another user picked it";
  if (c.forLogin === login) return "it runs on your Task Runner already";
  if (c.forLogin !== null) return "it runs on the Task Runner of the person who asked";
  if (c.parentId !== null) return "a follow-up goes to the Task Runner that holds its session";
  if (c.seenAt < nowMs - CALLER_STALE_MS) return "its caller stopped waiting";
  if (!state.tiers.has(c.tier)) return `none of your Task Runners runs the ${c.tier} tier`;
  if (!roleFits(user.role, { prompt_id: c.promptId, repos: c.repos })) return "only operators take this call";
  if (judges(c.promptId) && c.authors.has(login)) return "it judges an item you authored";
  for (const repo of c.repos) if (!(await user.canWrite(repo).catch(() => false))) return `you have no write permission on ${repo}`;
  if (state.picks >= state.pickMax) return `you hold ${state.picks} picks, your most`;
  return null;
}

/** The call of a pick context as picks read it, or null for no such call. */
function callOf(ctx: PickContext): (PickCall & { state: string; refs: ItemRef[] }) | null {
  const c = ctx.call;
  if (!c || ctx.callState === null) return null;
  return { id: c.id, state: ctx.callState, tier: c.tier, promptId: c.promptId, parentId: c.parentId, refs: c.refs, repos: c.repos, authors: c.authors, seenAt: c.seenAt, pickedBy: c.pickedBy, pickUntil: c.pickUntil, forLogin: c.forLogin };
}

const targetOf = (refs: ItemRef[]): string | null => (refs.length ? `${refs[0]!.repo}#${refs[0]!.number}` : null);

/** Picks a queued call for the user's runners (compare and set: only a call no other user's pick counts for); audited. */
export async function pickCall(db: Db, user: Picker, id: number, nowMs: number = Date.now(), via?: string): Promise<void> {
  const { ctx, accepted } = await pickReads(db, user.login, id, nowMs);
  const c = callOf(ctx);
  if (!c) throw new HttpError(404, "no such model call");
  if (c.state !== "queued") throw new HttpError(409, "the call is no longer queued");
  const state = pickerStateOf(ctx, accepted, user, nowMs);
  if (user.role !== "maintainer" && user.role !== "operator") throw new HttpError(403, state.why ?? "only maintainers and operators pick calls");
  const fresh = new Set(ctx.pickerLogins);
  const why = await pickRefusal(state, user, c, nowMs, (l) => fresh.has(l));
  if (why) throw new HttpError(409, why);
  // Parallel picks of one user cannot pass the most picks together: the count and the pick are one compare-and-set.
  const r = await savePick(db, { callId: id, login: user.login, cap: ctx.cap, max: state.pickMax, now: nowMs });
  if (r === "limit") throw new HttpError(409, `you hold ${state.pickMax} picks, your most`);
  if (r === "taken") throw new HttpError(409, "another user picked it, or it is no longer queued");
  await addAudit(db, [{ login: user.login, action: "remote-pick", target: targetOf(c.refs), details: { id, promptId: c.promptId, ...(ctx.cap !== null && { until: new Date(nowMs + ctx.cap).toISOString() }), ...(via && { via }) } }]);
}

/** Ends a pick: the user's own, or any for an operator; audited. */
export async function unpickCall(db: Db, user: Pick<Picker, "login" | "role">, id: number, via?: string): Promise<void> {
  if (user.role !== "maintainer" && user.role !== "operator") throw new HttpError(403, "only maintainers and operators pick calls");
  const c = callOf((await pickReads(db, user.login, id, Date.now())).ctx);
  if (!c) throw new HttpError(404, "no such model call");
  if (c.pickedBy === null) throw new HttpError(409, "the call has no pick");
  const own = c.pickedBy === user.login.toLowerCase();
  if (!own && user.role !== "operator") throw new HttpError(403, "only operators end another user's pick");
  if (await clearPicks(db, [id], c.pickedBy) !== 1) throw new HttpError(409, "the call has no pick");
  await addAudit(db, [{ login: user.login, action: "remote-unpick", target: targetOf(c.refs), details: { id, promptId: c.promptId, ...(!own && { picker: c.pickedBy }), ...(via && { via }) } }]);
}
