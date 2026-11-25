// Room in the user-local model queue: how many more calls may be made now. Each helper whose last status is `ready` and
// fresh (helpers.ts), and which is active (its last claim found nothing within IDLE_FRESH_MS, or it runs a lease that
// heartbeats), is room for its free slots: its `--parallel` slots (the fast lane is not counted, see remoteRoom) less the
// leases its token holds. Only helpers that may take a call naming the caller's repos count (runnerTakes: the role rules, write
// permission, My repos narrowed by the helper's own list). A user's helpers together count no more than the user's "Max calls
// at once" leaves (max-calls.ts). The queued calls that rank at or above the caller's class in the claim order (claim-class.ts)
// and that a counted helper may take come first. A helper held by its plan usage or paused stops asking for work and reports
// so; a helper that stopped without a word stops counting once its last claim and heartbeats are old. The helpers of a Manual
// only user (manual-only.ts) take only the user's own picks and follow-ups, so they are no room. For work its user started or
// approved (started.ts) a helper is room whatever its Manual only, My repos, tasks and items.
import { WRITE_PERMISSIONS } from "../dash/server/provider.ts";
import { PERM_READ_TTL } from "../dash/server/sessions.ts";
import { ownLaneLeasesOfToken, leasedBy, queueSnapshot, runnerTakes } from "./calls.ts";
import { claimClass } from "./claim-class.ts";
import { STATUS_FRESH_MS } from "./helpers.ts";
import { manualExpr } from "./manual-only.ts";
import { userMaxCalls } from "./max-calls.ts";
import { claimRepos } from "./my-repos.ts";
import { TASK_CHOICES, taskOfStep, userSkips } from "./my-tasks.ts";
import { itemFilter, type ItemFilter } from "./task-items.ts";
import { scaled } from "./time-scale.ts";
import { readStartedCalls, type StartedCalls } from "./started.ts";
import { HEARTBEAT_S } from "./protocol.ts";
import { filterSeq, mapSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";
import { inList } from "../db/kx.ts";

/** How long an empty claim counts as an idle helper: two claim intervals and some slack. */
export const IDLE_FRESH_MS = scaled(45_000);
/** How often a waiting caller stamps its call's `seen_at` (it polls more often, but writes only this often). */
export const SEEN_EVERY_MS = scaled(30_000);
/** A queued call whose caller has not stamped it for this long has lost its caller and is not counted or claimed: two stamps and some slack. */
export const CALLER_STALE_MS = 2 * SEEN_EVERY_MS + scaled(15_000);

/** A lease whose last heartbeat is at most this old shows its helper is running (three heartbeats). */
const LIVE_LEASE_MS = 3 * scaled(HEARTBEAT_S * 1000);

/**
 * Room for calls of class `cls` that name `repos` (undefined: any repo, every helper counts; empty: no repo, which only
 * operators take) and are of `step` (only helpers whose users take its task count; undefined: every task). A helper's fast-lane slot takes only small-tier and gating calls, and the planner does not
 * know which calls it is about to make, so the fast lane is not room. The status names no fast lane: a helper reporting 2
 * or more slots is taken to run one (work adds it to `--parallel N`, except for a harness that runs one call at a time,
 * which reports 1, and on macOS at `--parallel 16`, which this undercounts by one). A lease in the fast lane is not told
 * apart from the others', so it also undercounts by one while it runs.
 *
 * Write permission is the cached one (repo_permissions, roomCanWrite): only a non-write permission confirmed within
 * PERM_READ_TTL leaves a user out. A user with no fresh row for a repo counts for it, so a repo nobody's claim has looked at
 * lately still gets calls; the claim then checks the permission itself. The helper's repos are those of its last idle claim
 * (`idle_repos`) narrowed by the user's current My repos.
 */
export async function remoteRoom(db: Db, cls: number, nowMs: number = Date.now(), repos?: readonly string[], step?: string): Promise<number> {
  return await roomOf(db, await roomState(db, nowMs), cls, nowMs, repos, step);
}

/**
 * Whether each of `logins` counts as able to write to a repo for the room: true unless a non-write permission confirmed within
 * PERM_READ_TTL is cached. One query for every login.
 */
export async function roomCanWrite(db: Db, logins: readonly string[], nowMs: number): Promise<(login: string, repo: string) => boolean> {
  const denied = new Set<string>();
  for (const p of await db.all(db.k.selectFrom("main.repo_permissions").select(["login", "repo", "permission", "checked_at"]).where(inList(db, "login", [...new Set(logins)], "citext"))))
    if (!WRITE_PERMISSIONS.has(p.permission) && nowMs - Date.parse(p.checked_at) < PERM_READ_TTL) denied.add(`${p.login.toLowerCase()}\n${p.repo}`);
  return (login, repo) => !denied.has(`${login.toLowerCase()}\n${repo}`);
}

type Helper = { token_id: number; login: string; role: string | null; idle_claim_at: number | null; idle_repos: string | null; slots: number; leased: number; beat: number | null };
type Taker = { h: Helper; active: boolean; r: { login: string; role: string; repos: ReadonlySet<string> | null; skip: ReadonlySet<string>; items: ItemFilter } };
/**
 * What the room reads of the helpers, once for any number of room questions at one moment: the fresh, ready helpers that are
 * not Manual only and whose users take some task and some item (`ready`; with no task ticked, or only fast-tracked items and none
 * open, a user takes only picks, as Manual only), those of them that are active, and on first use their permissions, repos and users' caps.
 */
export type RoomState = {
  ready: Helper[]; active: Helper[]; takers?: { list: Taker[]; canWrite: (login: string, repo: string) => boolean }; left: Map<string, number>;
  /** Every fresh, ready helper, Manual only and without tasks too: room for the work its user started or approved (started.ts). */
  fresh: Helper[];
  /** Read on first use: whose started work is whose. */
  started?: StartedCalls;
};

export async function roomState(db: Db, nowMs: number = Date.now()): Promise<RoomState> {
  const fresh = await db.all(db.k.selectFrom("main.mcp_tokens as t").innerJoin("main.remote_helpers as h", "h.token_id", "t.id").leftJoin("main.access as a", "a.login", "t.login")
    .select((eb) => ["t.id as token_id", "t.login", "a.role", manualExpr(db, eb, "t.login").as("manual"), "t.idle_claim_at", "t.idle_repos", eb.fn.coalesce("h.slots", eb.lit(1)).as("slots"),
      eb.selectFrom("main.remote_calls as c").select((e) => e(e.fn.countAll<number>(), "-", ownLaneLeasesOfToken(db, "t.id")).as("n")).where("c.state", "=", "leased").whereRef("c.token_id", "=", "t.id").as("leased"),
      eb.selectFrom("main.remote_calls as c").select((e) => e.fn.max<number | null>("c.heartbeat_at").as("m")).where("c.state", "=", "leased").whereRef("c.token_id", "=", "t.id").as("beat")]).$narrowType<{ leased: number }>()
    .where("t.kind", "=", "runner").where("t.expires_at", ">", new Date(nowMs).toISOString()).where("h.readiness", "=", "ready").where("h.reported_at", ">=", nowMs - STATUS_FRESH_MS));
  const rows = await filterSeq(fresh, async (h) => !h.manual && (await userSkips(db, h.login)).size < TASK_CHOICES.length && ((await itemFilter(db, h.login))?.refs.size ?? 1) > 0);
  return { ready: rows, active: rows.filter((h) => isActive(h, nowMs)), left: new Map(), fresh };
}

const isActive = (h: Helper, nowMs: number): boolean =>
  (h.beat !== null && Number(h.beat) >= nowMs - LIVE_LEASE_MS) || (h.idle_claim_at !== null && Number(h.idle_claim_at) >= nowMs - IDLE_FRESH_MS);

async function takersOf(db: Db, st: RoomState, nowMs: number): Promise<NonNullable<RoomState["takers"]>> {
  return st.takers ??= {
    canWrite: await roomCanWrite(db, st.ready.map((h) => h.login), nowMs),
    list: await mapSeq(st.ready, async (h) => {
      let own: string[] | undefined;
      try { own = h.idle_repos ? JSON.parse(h.idle_repos) as string[] : undefined; } catch { /* every repo */ }
      return { h, active: isActive(h, nowMs), r: { login: h.login, role: h.role ?? "", repos: await claimRepos(db, h.login, own), skip: await userSkips(db, h.login), items: await itemFilter(db, h.login) } };
    }),
  };
}

/**
 * Room for class `cls`, `repos`, `step` and `refs` (see remoteRoom) from a state read at `nowMs`. `step` left out: every task
 * counts. `refs`: the call's items (with `repos` their repos), so a runner whose user takes only some items (task-items.ts) counts
 * only for a call on them; left out, it counts on the repos that have such an item.
 *
 * The calls ahead that only runners taking every item may take use up those runners' slots alone, so a call on a chosen item
 * finds the filtered runners' slots free while the others are busy with calls they alone take.
 */
export async function roomOf(db: Db, st: RoomState, cls: number, nowMs: number, repos?: readonly string[], step?: string, refs?: readonly { repo: string; number: number }[]): Promise<number> {
  let takers: { h: Helper; filtered: boolean }[] = st.active.map((h) => ({ h, filtered: false }));
  let takes: (c: { prompt_id: string; repos: readonly string[]; step?: string; refs?: readonly { repo: string; number: number }[] }) => boolean = () => true;
  let filteredTake: typeof takes = () => false;
  if ((repos !== undefined || step !== undefined || refs !== undefined) && st.active.length) {
    const t = await takersOf(db, st, nowMs);
    const task = step === undefined ? undefined : taskOfStep(step);
    const on = repos ?? (refs ? [...new Set(refs.map((x) => x.repo))] : undefined);
    const fit = t.list.filter(({ active, r }) => active && (on === undefined ? !(task !== undefined && r.skip.has(task)) && (r.items === null || [...r.items.repos].some((x) => runnerTakes(r, { prompt_id: "", repos: [x], step }, t.canWrite))) : runnerTakes(r, { prompt_id: "", repos: on, step, refs }, t.canWrite)));
    takers = fit.map((x) => ({ h: x.h, filtered: x.r.items !== null }));
    takes = (c) => fit.some(({ r }) => runnerTakes(r, c, t.canWrite));
    filteredTake = (c) => fit.some(({ r }) => r.items !== null && runnerTakes(r, c, t.canWrite));
  }
  // The active helpers of the users whose started work this is (started.ts) are room for it whatever their Manual only, My
  // repos, tasks and items, as runners that take only some items; the calls ahead they take are those of their own started work.
  const on = repos ?? (refs ? [...new Set(refs.map((x) => x.repo))] : undefined);
  if (on?.length) {
    const sw = st.started ??= await readStartedCalls(db, nowMs);
    const owners = sw.ownersFor({ repos: on, ...(refs && { refs }), ...(step !== undefined && { step }) });
    const counted = new Set(takers.map((x) => x.h.token_id));
    const extra = owners.size ? st.fresh.filter((h) => isActive(h, nowMs) && !counted.has(h.token_id) && owners.has(h.login.toLowerCase())
      && sw.canTake(h.login, { prompt_id: "", repos: on })) : [];
    if (extra.length) {
      const logins = new Set(extra.map((h) => h.login.toLowerCase()));
      const own = (c: { refs?: readonly { repo: string; number: number }[] }): boolean => !!c.refs && [...sw.owners(c.refs)].some((o) => logins.has(o));
      // With no other helper counted nothing ahead is theirs.
      const [t0, f0] = takers.length ? [takes, filteredTake] : [() => false, () => false];
      takers = [...takers, ...extra.map((h) => ({ h, filtered: true }))];
      takes = (c) => t0(c) || own(c);
      filteredTake = (c) => f0(c) || own(c);
    }
  }
  // Free slots by login, within the user's cap, split into users who take every item (`all`) and filtered users (`some`).
  const free = new Map<string, { n: number; filtered: boolean }>();
  for (const { h, filtered } of takers) {
    const key = h.login.toLowerCase();
    const slots = Number(h.slots) - (Number(h.slots) >= 2 ? 1 : 0);
    free.set(key, { n: (free.get(key)?.n ?? 0) + Math.max(0, slots - Number(h.leased)), filtered });
  }
  let all = 0, some = 0;
  for (const [login, { n, filtered }] of free) {
    let left = st.left.get(login);
    if (left === undefined) {
      const max = await userMaxCalls(db, login);
      left = max === null ? Infinity : Math.max(0, max - await leasedBy(db, login));
      st.left.set(login, left);
    }
    if (filtered) some += Math.min(n, left);
    else all += Math.min(n, left);
  }
  if (all + some === 0) return 0;
  let aheadAll = 0, aheadSome = 0;
  for (const r of await queueSnapshot(db, nowMs)) {
    if (r.seen_at < nowMs - CALLER_STALE_MS || claimClass(r, nowMs) < cls || !takes(r)) continue;
    if (some > 0 && filteredTake(r)) aheadSome++;
    else aheadAll++;
  }
  // Calls the filtered runners may take go to them first; what they cannot hold falls to the others.
  return Math.max(0, all - aheadAll - Math.max(0, aheadSome - some)) + Math.max(0, some - aheadSome);
}
