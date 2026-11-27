// The model call queue as the dashboard shows it (GET /api/model-queue, src/dash/api/model-queue.ts): every queued call with
// a live caller in claim order, why it waits, and the ready Task Runners. Reads only; picks are in picks.ts.
import type { ItemRef, ModelQueueWhyCode } from "../../web/src/api/types.ts";
import { orderedOf } from "./cands.ts";
import { t } from "../i18n/index.ts";
import { gating } from "./claim-class.ts";
import { pickCounts } from "./picks-rules.ts";
import { heldFor, startedOf } from "./started.ts";
import { loginWaitIn, runnerWaitText, waitingOnIn, type RunnerWait } from "./takers.ts";
import { runnerTakes } from "./rules.ts";
import { skipsIn, taskOfStep, TASK_CHOICES } from "./my-tasks.ts";
import { itemsFit, type ItemFilter } from "./task-items.ts";
import type { Tier } from "./protocol.ts";
import { CALLER_STALE_MS } from "./room.ts";
import type { Db } from "../db/index.ts";
import { loadQueue, pickerLoginsOf, readyRunnersOf, type QueueSnapshot } from "../data/runners/index.ts";
import { canWriteOf as roomCanWrite, itemFilterIn, loadView, tiersOf, type RemoteView } from "./view.ts";

/** A fresh, ready Task Runner of a user who is not cooled off. `free`: slots without the fast lane its token does not use, within the user's Max calls at once. */
export type ReadyRunner = { login: string; role: string; manual: boolean; tiers: ReadonlySet<Tier>; free: number; repos: ReadonlySet<string> | null; skip: ReadonlySet<string>; items?: ItemFilter };

export async function readyRunners(db: Db, nowMs: number): Promise<ReadyRunner[]> {
  return readyIn(await loadView(db, nowMs));
}

/** The ready runners of one reading, with their users' offered tasks and item filters. */
export const readyIn = (v: RemoteView): ReadyRunner[] =>
  readyRunnersOf(v.snapshot, (m) => tiersOf(m, v.accepted)).map((r) => ({ ...r, skip: skipsIn([...r.skip]), items: itemFilterIn(v.snapshot, r.login) }));

/** What whyWaiting reads of a queued call. `picked`: its live pick (login null when the viewer may not see it). */
export type WhyCall = { tier: Tier; promptId: string; step: string; repos: readonly string[]; refs?: readonly ItemRef[]; followUp: boolean; picked: { login: string | null } | null;
  /** The user whose own runners alone take it; `shown`: the viewer may see the login. */
  bound?: { login: string; shown: boolean } | null;
  /** The one person whose runner it waits for (waitOf); `shown` as for `bound`. */
  waits?: ({ kind: "owner-off" } & RunnerWait | { kind: "owner"; login: string } | { kind: "login"; login: string; renewsAt: number }) & { shown: boolean } | null };

/**
 * Why a queued call waits, most specific first: its pick; the runner that holds its session; the user it is bound to (their
 * runners not ready, busy or next); the people whose started work it is, whose runners alone take it and cannot claim now
 * (src/remote/takers.ts waitingOn); the one of them it is held for (started.ts heldForOwner); the harness login every runner
 * that takes it waits to renew (takers.ts loginWaitIn); no ready runner for its tier;
 * every such runner Manual only; no such runner's user may take it (role rules, write permission as last confirmed, My
 * repos); none of them takes its task (my-tasks.ts); none of those takes its items (task-items.ts); every runner that may take
 * it busy; else the calls ahead of it.
 */
export function whyWaiting(c: WhyCall, runners: readonly ReadyRunner[], ahead: number, canWrite: (login: string, repo: string) => boolean): { code: ModelQueueWhyCode; text: string } {
  if (c.picked) return { code: "picked", text: c.picked.login ? `Picked by ${c.picked.login}` : "Picked by a user" };
  if (c.followUp) return { code: "session", text: "Waiting for the Task Runner that holds its session" };
  if (c.bound) {
    const whose = c.bound.shown ? `${c.bound.login}'s Task Runner` : "the asker's own Task Runner";
    const own = runners.filter((r) => r.login.toLowerCase() === c.bound!.login.toLowerCase() && r.tiers.has(c.tier));
    if (!own.length) return { code: "bound-off", text: `Runs only on ${whose}, which is not ready` };
    return { code: "bound", text: own.some((r) => r.free > 0) ? `Next on ${whose}` : `Waiting for ${whose}: it is busy` };
  }
  const w = c.waits;
  if (w?.kind === "owner-off") return { code: "owner-off", text: runnerWaitText(w, w.shown) };
  if (w?.kind === "owner") return { code: "owner", text: w.shown ? t("Held for {login}'s Task Runner: the work is theirs", { login: w.login }) : t("Waiting for a Task Runner") };
  if (w?.kind === "login") return { code: "login", text: runnerWaitText(w, w.shown) };
  const forTier = runners.filter((r) => r.tiers.has(c.tier));
  if (!forTier.length) return { code: "no-runner", text: `No Task Runner is ready for the ${c.tier} tier` };
  const auto = forTier.filter((r) => !r.manual);
  if (!auto.length) return { code: "manual-only", text: "Every ready Task Runner is Manual only" };
  // The items are the last question: here only the role, the repos and write permission.
  const may = auto.filter((r) => runnerTakes({ ...r, items: null }, { prompt_id: c.promptId, repos: c.repos }, canWrite));
  if (!may.length) return { code: "no-repo-access", text: c.repos.length ? "No ready Task Runner's user takes calls on its repo" : "No ready Task Runner's user may take it" };
  const task = taskOfStep(c.step);
  const takes = may.filter((r) => !r.skip.has(task));
  if (!takes.length) return { code: "task-off", text: `No ready Task Runner's user takes ${TASK_CHOICES.find((t) => t.id === task)?.title ?? task} tasks` };
  const forItems = takes.filter((r) => itemsFit(r.items ?? null, { repos: c.repos, refs: c.refs }));
  if (!forItems.length) return { code: "items-off", text: "No ready Task Runner's user takes its items: they take started items only" };
  if (!forItems.some((r) => r.free > 0)) return { code: "busy", text: "Every Task Runner that may take it is busy" };
  return { code: "behind", text: ahead === 0 ? "Next in line" : `${ahead} call${ahead === 1 ? "" : "s"} ahead` };
}

/** A queued call of the view, before the role's redaction. `pickedBy`: the login of its live pick. */
export type QueuedCall = {
  id: number; step: string; promptId: string; tier: Tier; model: string; refs: ItemRef[]; repos: string[]; authors: ReadonlySet<string>; forLogin: string | null;
  waitedMs: number; followUp: boolean; gating: boolean; pickedBy: string | null; pickUntil: number | null; seenAt: number; lastError: string | null;
  why: { code: ModelQueueWhyCode; text: string };
};

/**
 * The queued calls with a live caller in claim order, why each waits (`showPicker`: name the picker), and the ready runners.
 * Write permission follows the room's rule (a non-write permission confirmed lately leaves a login out), unless `canWriteOf`
 * gives the rule for the runners' logins. One read wave.
 */
export async function queueView(db: Db, nowMs: number, showPicker: boolean, canWriteOf?: (logins: string[]) => (login: string, repo: string) => boolean): Promise<{ calls: QueuedCall[]; runners: ReadyRunner[] }> {
  const [v, queue] = await db.together(() => Promise.all([loadView(db, nowMs), loadQueue(db, nowMs)]));
  return queueViewIn(v, queue, showPicker, { ...(canWriteOf && { canWriteOf }) });
}

/**
 * queueView over a reading already made. `about`: only the calls that name one of these items (`repo#n`) are returned and asked who
 * they wait for; the others still count toward the calls ahead.
 */
export function queueViewIn(v: RemoteView, queue: QueueSnapshot, showPicker: boolean, o: { canWriteOf?: (logins: string[]) => (login: string, repo: string) => boolean; about?: ReadonlySet<string> } = {}): { calls: QueuedCall[]; runners: ReadyRunner[] } {
  const nowMs = v.now, canWriteOf = o.canWriteOf, about = o.about;
  const runners = readyIn(v);
  const snap = orderedOf(queue, nowMs).all.filter((r) => r.seen_at >= nowMs - CALLER_STALE_MS);
  if (!snap.length) return { calls: [], runners };
  const canWrite = canWriteOf?.(runners.map((r) => r.login)) ?? roomCanWrite(v.snapshot);
  const fresh = pickerLoginsOf(v.snapshot, nowMs), started = startedOf(v);
  const ahead = new Map<Tier, number>();
  const calls: QueuedCall[] = [];
  for (const r of snap) {
    const picked = pickCounts(r, nowMs, (l) => fresh.has(l)) ? r.pickedBy : null;
    const followUp = r.parent_id !== null;
    const n = ahead.get(r.tier) ?? 0;
    const asked = !about || r.refs.some((x) => about.has(`${x.repo}#${x.number}`));
    const waits = !asked || followUp || picked !== null || r.forLogin !== null ? null : waitOf(v, started, r, nowMs, showPicker);
    const why = whyWaiting({ tier: r.tier, promptId: r.prompt_id, step: r.step, repos: r.repos, refs: r.refs, followUp, picked: picked === null ? null : { login: showPicker ? picked : null }, bound: r.forLogin === null ? null : { login: r.forLogin, shown: showPicker }, waits }, runners, n, canWrite);
    // A call of repos or a task no ready runner takes is passed over, so it is no call ahead of the next; nor is one bound to a user.
    if (!followUp && picked === null && r.forLogin === null && why.code !== "task-off" && why.code !== "items-off" && why.code !== "no-repo-access") ahead.set(r.tier, n + 1);
    if (!asked) continue;
    calls.push({
      id: r.id, step: r.step, promptId: r.prompt_id, tier: r.tier, model: r.askedModel, refs: r.refs, repos: r.repos, authors: r.authors, forLogin: r.forLogin,
      waitedMs: r.queuedMs + (r.queuedSince === null ? 0 : Math.max(0, nowMs - r.queuedSince)), followUp, gating: gating(r),
      pickedBy: picked, pickUntil: picked === null ? null : r.pickUntil, seenAt: r.seen_at, lastError: r.error, why,
    });
  }
  return { calls, runners };
}

/** The one person whose Task Runner a queued call waits for (WhyCall.waits), from the same rules the claims and the taker rule use; null when none. */
function waitOf(v: RemoteView, started: ReturnType<typeof startedOf>, r: ReturnType<typeof orderedOf>["all"][number], nowMs: number, shown: boolean): WhyCall["waits"] {
  const call = { prompt_id: r.prompt_id, repos: r.repos, step: r.step, refs: r.refs, tier: r.tier };
  const [off] = waitingOnIn(v, call);
  if (off) return { kind: "owner-off", ...off, shown };
  const owner = heldFor(started, r, null, nowMs);
  if (owner) return { kind: "owner", login: owner, shown };
  const renew = loginWaitIn(v, call);
  return renew ? { kind: "login", login: renew.login, renewsAt: renew.at, shown } : null;
}
