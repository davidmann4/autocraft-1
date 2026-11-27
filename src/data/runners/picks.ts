// Picks: "Run on my Task Runner" (package runners-b).
import type { ItemRef } from "../../../web/src/api/types.ts";
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import { scaled } from "../../remote/time-scale.ts";
import { setting } from "../control/index.ts";
import { STATUS_FRESH_MS } from "./helpers.ts";
import { loadRunnerSnapshot } from "./runner-snapshot.ts";
import { dropQueueCache } from "./calls-shared.ts";
import { pickLapsedExpr } from "./cross.ts";
import type { CallState, PickContext, PickResult, QueuedCall, RunnerSnapshot, Tier } from "./types.ts";

/** Setting: minutes a pick counts; 0 means until it ends otherwise. */
export const PICK_MINUTES_KEY = "remote_pick_minutes";
export const PICK_MINUTES_DEFAULT = 15;
const PICK_MINUTES_MAX = 24 * 60;
/** The most live picks a user holds, whatever their runners' slots. */
export const PICKS_MAX = 8;

/** How long a new pick counts, in ms (scaled like the mode's other windows); null for no limit. */
export function pickCapOf(value: string | undefined): number | null {
  const n = Number(value);
  const minutes = value !== undefined && Number.isInteger(n) && n >= 0 && n <= PICK_MINUTES_MAX ? n : PICK_MINUTES_DEFAULT;
  return minutes === 0 ? null : scaled(minutes * 60_000);
}

/** The lowercase logins whose picks count at `now`, from a snapshot: the same rule as `cross.pickLapsedExpr`. Pure. */
export function pickerLoginsOf(s: RunnerSnapshot, now: number): Set<string> {
  const out = new Set<string>();
  for (const r of s.runners) {
    const login = r.login.toLowerCase();
    if (out.has(login) || r.reportedAt === null || r.reportedAt < now - STATUS_FRESH_MS) continue;
    if (s.cooled.has(login)) continue;
    const max = s.settings.get(login)?.maxCalls ?? null;
    if (max !== null && (s.leasedByLogin.get(login)?.leased ?? 0) >= max) continue;
    out.add(login);
  }
  return out;
}

const CALL_COLUMNS = ["id", "state", "prompt_id", "prompt_version", "tier", "step", "parent_id", "sticky_login", "seen_at", "timeout_ms", "items", "repo", "authors", "released_by",
  "released_at", "release_wait_ms", "for_login", "bound_slot", "refused_token", "picked_by", "picked_at", "pick_until", "asked_model", "queued_ms", "queued_since", "error", "level", "job_id", "since", "class as cls"] as const;

/** Live picks of `login` at `now` (a pick counts while its time is not up), not counting call `except`. */
const livePickCount = (db: Db, login: string, now: number, except = -1) => {
  const q = queryDb(db);
  return q.get(q.k.selectFrom("main.remote_calls").select((eb) => eb.fn.countAll<number>().as("n")).where("state", "=", "queued").where("picked_by", "=", login)
    .where((eb) => eb.or([eb("pick_until", "is", null), eb("pick_until", ">=", now)])).where("id", "<>", except));
};

/**
 * The call, the user's live runners, live pick count, cool-off, the logins whose picks count and the pick cap in one wave (the
 * snapshot's own reads join it). The rules over it (`pickRefusal`, `pickerState`) are pure.
 */
export async function loadPickContext(db: Db, user: string, callId: number, now: number): Promise<PickContext> {
  const q = queryDb(db);
  const [snapshot, row, live, minutes] = await db.together(() => Promise.all([
    loadRunnerSnapshot(db, now),
    q.get(q.k.selectFrom("main.remote_calls").select(CALL_COLUMNS).where("id", "=", callId)),
    livePickCount(db, user, now),
    setting(db, PICK_MINUTES_KEY),
  ]));
  const login = user.toLowerCase();
  let call: QueuedCall | null = null;
  if (row) {
    let refs: ItemRef[] = [];
    try { refs = JSON.parse(row.items) as ItemRef[]; } catch { /* no items */ }
    let authors: string[] = [];
    try { authors = row.authors !== null ? JSON.parse(row.authors) as string[] : []; } catch { /* no authors */ }
    call = {
      id: Number(row.id), promptId: row.prompt_id, promptVersion: row.prompt_version, tier: row.tier as Tier, step: row.step, parentId: row.parent_id === null ? null : Number(row.parent_id),
      stickyLogin: row.sticky_login, seenAt: Number(row.seen_at), timeoutMs: Number(row.timeout_ms), refs, repos: [...new Set([...refs.map((i) => i.repo), ...(row.repo ? [row.repo] : [])])],
      authors: new Set(authors.map((a) => a.toLowerCase())), releasedBy: row.released_by?.toLowerCase() ?? null, releasedAt: row.released_at === null ? null : Number(row.released_at),
      releaseWaitMs: row.release_wait_ms === null ? null : Number(row.release_wait_ms),
      forLogin: row.for_login?.toLowerCase() ?? null, boundSlot: Number(row.bound_slot) === 1, refusedToken: row.refused_token === null ? null : Number(row.refused_token),
      pickedBy: row.picked_by?.toLowerCase() ?? null, pickedAt: row.picked_at === null ? null : Number(row.picked_at), pickUntil: row.pick_until === null ? null : Number(row.pick_until),
      askedModel: row.asked_model, queuedMs: Number(row.queued_ms), queuedSince: row.queued_since === null ? null : Number(row.queued_since), error: row.error,
      level: Number(row.level), jobId: row.job_id === null ? null : Number(row.job_id), since: Number(row.since),
      cls: Number(row.cls), repo: row.repo,
    };
  }
  return {
    call, callState: row ? row.state as CallState : null, runners: snapshot.runners.filter((r) => r.login.toLowerCase() === login), livePicks: Number(live!.n),
    cooled: snapshot.cooled.get(login) ?? null, pickerLogins: [...pickerLoginsOf(snapshot, now)], cap: pickCapOf(minutes), max: PICKS_MAX,
  };
}

/**
 * Picks a queued call for `login`: re-counts the login's live picks and sets the pick in one compare-and-set, under the writer lock so two
 * picks of one login cannot both pass the count. `cap`: how long the pick counts in ms (null: until it ends otherwise); `max`: the most
 * live picks the login may hold. `taken`: another user's pick counts, or the call is no longer queued.
 */
export async function savePick(db: Db, a: { callId: number; login: string; cap: number | null; max: number; now: number }): Promise<PickResult> {
  const q = queryDb(db);
  const result = await db.write(async (): Promise<PickResult> => {
    if (Number((await livePickCount(db, a.login, a.now, a.callId))!.n) >= a.max) return "limit";
    const r = await q.run(q.k.updateTable("main.remote_calls").set({ picked_by: a.login, picked_at: a.now, pick_until: a.cap === null ? null : a.now + a.cap })
      .where("id", "=", a.callId).where("state", "=", "queued").where("parent_id", "is", null).where("for_login", "is", null)
      .where((eb) => eb.or([eb("picked_by", "is", null), eb("picked_by", "=", a.login), pickLapsedExpr(db, eb, a.now)])));
    return Number(r.changes) === 1 ? "picked" : "taken";
  });
  // The pick is on the queued row: the queue cache drops, and the snapshot with it.
  if (result === "picked") dropQueueCache(db);
  return result;
}
