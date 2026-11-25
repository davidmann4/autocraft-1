// Takers in the user-local model queue: whether some Task Runner may take calls on a repo now, and what happens when none
// can. A taker is a fresh, ready Task Runner (helpers.ts) of a user who is not cooled off (cooloff.ts) and who may take the
// call (runnerTakes: role rules, write permission by the room's rule roomCanWrite, My repos narrowed by the runner's own
// list), busy or not. A Manual only user's runner (manual-only.ts) is a taker, since the user may pick the call, though it is
// no room. For work its user started or approved (started.ts) a runner is a taker whatever its My repos, tasks and items, and
// whether or not it is connected and ready. takerTest is the one taker rule: pools and the runner's job starts skip work without a taker, the
// dashboard's minute maintenance runs sweepTakers: a queued call with no taker for NO_TAKER_MS is withdrawn, and pipeline-on
// repos with no taker are recorded for the remote-no-taker health check. Follow-up turns and calls with a pick that counts
// keep their own rules (calls.ts awaitCall, picks). A call bound to a user (a maintainer's conversation turn) has a taker only
// in that user's runners.
import { WRITE_PERMISSIONS } from "../dash/server/provider.ts";
import { PERM_READ_TTL } from "../dash/server/sessions.ts";
import { NO_TAKER_PREFIX, pickCounts, pickerLogins, queueSnapshot, roleFits, runnerTakes, withdrawCall } from "./calls.ts";
import { heldForOwner, readStartedCalls } from "./started.ts";
import { STATUS_FRESH_MS } from "./helpers.ts";
import { acceptedModels, familyOf, inferenceMode, isTier } from "./mode.ts";
import type { Tier } from "./protocol.ts";
import { claimRepos } from "./my-repos.ts";
import { SKIP_TASKS_KEY, TASK_CHOICES, taskOfStep, userSkips } from "./my-tasks.ts";
import { CALLER_STALE_MS, roomCanWrite } from "./room.ts";
import { itemFilter, itemsFit, TASK_ITEMS, TASK_ITEMS_KEY, TASK_ITEMS_TITLE, userTaskItems, type ItemFilter, type TaskItems } from "./task-items.ts";
import type { ItemRef } from "../../web/src/api/types.ts";
import { scaled } from "./time-scale.ts";
import { filterSeq, mapSeq } from "../async-seq.ts";
import type { NotNull } from "kysely";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

/** How long a queued call may have no taker before it is withdrawn, and a pipeline-on repo before the health check warns. */
export const NO_TAKER_MS = scaled(10 * 60_000);

/** A call as the taker rule reads it: its prompt (role rules for discord.* calls) and the repos it names. */
/**
 * `step`: the call's step, for the takers' tasks (my-tasks.ts); left out, the question is about repos alone. `someTask`: with no
 * step, only a runner whose user takes at least one task counts (with none ticked a user takes only picks).
 */
export type TakerCall = {
  prompt_id: string; repos: readonly string[]; step?: string; someTask?: boolean; /** The call's items; left out, a question asked before they are known (task-items.ts). */ refs?: readonly ItemRef[]; /** Only runners whose user takes some items count. */ filtered?: boolean;
  /** A call bound to this user (calls.ts NewCall.forLogin): only their runners count, under the role rules and write permission alone, as for a pick, and only those that offer `tier`. */
  forLogin?: string | null;
  tier?: Tier;
};

/**
 * Whether some taker may take a call now, for many questions at one moment (a pool's round, the runner's pass over queued
 * jobs, a sweep): the runners, their repos and permissions are read once, on the first question.
 */
export function takerTest(db: Db, nowMs: number): (c: TakerCall) => Promise<boolean> {
  let test: ((c: TakerCall) => boolean) | null = null;
  return async (c) => (test ??= await readTakers(db, nowMs))(c);
}

/** On a runner token `t` joined to its status `h`: the runner may be a taker (fresh, ready, its user not cooling off). */
const takerExpr = (eb: kx.Eb, nowMs: number) => eb.and([
  eb("t.kind", "=", "runner"), eb("t.expires_at", ">", new Date(nowMs).toISOString()), eb("h.readiness", "=", "ready"), eb("h.reported_at", ">=", nowMs - STATUS_FRESH_MS),
  eb.not(eb.exists(kx.schemaEb(eb).selectFrom("main.remote_cooloffs as co").select(eb.lit(1).as("one")).where("co.login", "=", eb.ref("t.login")).where("co.until", ">", nowMs))),
]);

/**
 * The runners the taker rule reads, in a form that changes only when they or what decides their repos change: each one's
 * login, role, My repos and own repo list. The planner adds it to its input, so work left for want of a taker is planned
 * again when one connects or comes back, without every status report waking the planner. Of write permission it holds the
 * oldest check among their cached non-write permissions that still count (roomCanWrite), so it changes when that one expires.
 */
export async function takerSignature(db: Db, nowMs: number = Date.now()): Promise<string> {
  const r = (await db.get(db.k.selectFrom((eb) => eb.selectFrom("main.mcp_tokens as t").innerJoin("main.remote_helpers as h", "h.token_id", "t.id")
    .leftJoin("main.access as a", "a.login", "t.login")
    .leftJoin("main.user_settings as us", (j) => j.onRef("us.login", "=", "t.login").on("us.key", "=", "repos"))
    .leftJoin("main.user_settings as sk", (j) => j.onRef("sk.login", "=", "t.login").on("sk.key", "=", SKIP_TASKS_KEY))
    .select((e) => [[e.fn<string>("lower", ["t.login"]), e.fn.coalesce("a.role", e.val("")), e.fn.coalesce("us.value", e.val("")), e.fn.coalesce("t.idle_repos", e.val("")), e.fn.coalesce("sk.value", e.val(""))]
      .reduce((acc, part) => e(e(acc, "||", e.val(":")), "||", part)).as("k")])
    .distinct().where((e) => takerExpr(e, nowMs)).as("ks"))
    .select(kx.groupConcat(db, "k", ";", kx.bytewise(db, "k")).as("s"))))!;
  if (!r.s) return "";
  const denied = (await db.get(db.k.selectFrom("main.repo_permissions as p").select((eb) => eb.fn.min<string | null>("p.checked_at").as("at"))
    .where(kx.inList(db, "p.permission", [...WRITE_PERMISSIONS], "text", true)).where("p.checked_at", ">", new Date(nowMs - PERM_READ_TTL).toISOString())
    .where((eb) => eb("p.login", "in", eb.selectFrom("main.mcp_tokens as t").innerJoin("main.remote_helpers as h", "h.token_id", "t.id").select("t.login").where((e) => takerExpr(e, nowMs))))))!;
  // A runner that takes only some items is a taker on the repos of those items, which change as items are fast-tracked.
  const filtered = await mapSeq(await db.all(db.k.selectFrom("main.mcp_tokens as t").innerJoin("main.remote_helpers as h", "h.token_id", "t.id")
    .innerJoin("main.user_settings as ti", (j) => j.onRef("ti.login", "=", "t.login").on("ti.key", "=", TASK_ITEMS_KEY))
    .select("t.login").where((eb) => takerExpr(eb, nowMs)).groupBy("t.login").orderBy((eb) => eb.fn("lower", ["t.login"])).orderBy("t.login")),
    async ({ login }) => `${login.toLowerCase()}=${[...(await itemFilter(db, login))?.repos ?? []].sort().join(",")}`);
  const s = filtered.length ? `${r.s}|items:${filtered.join(";")}` : r.s;
  return denied.at ? `${s}|${denied.at}` : s;
}

type Runner = { tokenId: number; login: string; role: string; repos: ReadonlySet<string> | null; skip: ReadonlySet<string>; items: ItemFilter; /** The tiers its models offer (accepted families). */ tiers: ReadonlySet<Tier> };

/** The takers as the taker rule reads them. */
async function readRunners(db: Db, nowMs: number): Promise<{ runners: Runner[]; canWrite: (login: string, repo: string) => boolean }> {
  const rows = await db.all(db.k.selectFrom("main.mcp_tokens as t").innerJoin("main.remote_helpers as h", "h.token_id", "t.id").innerJoin("main.access as a", "a.login", "t.login")
    .select(["t.id", "t.login", "a.role", "t.idle_repos", "h.models"]).where((eb) => takerExpr(eb, nowMs)));
  const canWrite = await roomCanWrite(db, rows.map((r) => r.login), nowMs);
  const accepted = await acceptedModels(db);
  const runners = await mapSeq(rows, async (h) => {
    let own: string[] | undefined;
    try { own = h.idle_repos ? JSON.parse(h.idle_repos) as string[] : undefined; } catch { /* every repo */ }
    let models: Record<string, unknown> = {};
    try { models = JSON.parse(h.models) as Record<string, unknown>; } catch { /* no models */ }
    const tiers = new Set(Object.entries(models).flatMap(([t, m]) => (isTier(t) && typeof m === "string" && familyOf(m, accepted[t]) !== null ? [t] : [])));
    return { tokenId: Number(h.id), login: h.login, role: h.role, repos: await claimRepos(db, h.login, own), skip: await userSkips(db, h.login), items: await itemFilter(db, h.login), tiers };
  });
  return { runners, canWrite };
}

async function readTakers(db: Db, nowMs: number): Promise<(c: TakerCall) => boolean> {
  const [{ runners, canWrite }, owner] = await Promise.all([readRunners(db, nowMs), ownerTakes(db, nowMs)]);
  return (c) => c.forLogin
    ? runners.some((r) => r.login.toLowerCase() === c.forLogin!.toLowerCase() && (c.tier === undefined || r.tiers.has(c.tier)) && roleFits(r.role, c) && c.repos.every((x) => canWrite(r.login, x)))
    : runners.some((r) => !(c.someTask && r.skip.size >= TASK_CHOICES.length) && !(c.filtered && !r.items) && runnerTakes(r, c, canWrite)) || owner(c);
}

/**
 * The taker rule for work a person started or approved (started.ts): one of their Task Runners takes such a call (or a job of a
 * step their live workflow runs, on its repo; StartedCalls.waitersFor) under the role rules and write permission alone, whatever
 * their Manual only, My repos, My tasks and items. Their runner counts while it is offline, not ready or cooling off, so the
 * work waits for it instead of being skipped for want of a taker. It counts as a runner that takes only some items (`filtered`),
 * as the call waits for it.
 */
async function ownerTakes(db: Db, nowMs: number): Promise<(c: TakerCall) => boolean> {
  const s = await readStartedCalls(db, nowMs);
  return (c) => s.waitersFor(c).size > 0;
}

/** Why a person's Task Runner cannot claim now: no fresh report, held for its plan usage, cooling off, or another readiness. */
export type RunnerHold = "offline" | "usage-limit" | "cooling-off" | "not-ready";

/**
 * The people whose own Task Runners a call waits for: the call has a taker (takerTest), but only through the runners of the
 * people whose started work it is (StartedCalls.waitersFor), none of which may claim it now; with why each one cannot. Empty
 * when a runner may claim it now, or when it has no taker at all.
 */
export async function waitingOn(db: Db, c: TakerCall, nowMs: number = Date.now()): Promise<{ login: string; hold: RunnerHold }[]> {
  const [{ runners, canWrite }, s] = await Promise.all([readRunners(db, nowMs), readStartedCalls(db, nowMs)]);
  if (runners.some((r) => runnerTakes(r, c, canWrite)) || [...s.ownersFor(c)].some((o) => s.canTake(o, c))) return [];
  const logins = [...s.waitersFor(c)].sort();
  if (!logins.length) return [];
  const rows = await db.all(db.k.selectFrom("main.mcp_tokens as t").leftJoin("main.remote_helpers as h", "h.token_id", "t.id").select(["t.login", "h.readiness", "h.reported_at"])
    .where("t.kind", "=", "runner").where("t.expires_at", ">", new Date(nowMs).toISOString()).where(kx.inList(db, "t.login", logins, "citext")));
  const cooled = new Set((await db.all(db.k.selectFrom("main.remote_cooloffs").select("login").where("until", ">", nowMs).where(kx.inList(db, "login", logins, "citext")))).map((r) => r.login.toLowerCase()));
  return logins.map((login) => {
    const fresh = rows.filter((r) => r.login.toLowerCase() === login && r.reported_at !== null && r.reported_at >= nowMs - STATUS_FRESH_MS);
    const hold: RunnerHold = !fresh.length ? "offline" : fresh.some((r) => r.readiness === "quota-held") ? "usage-limit" : cooled.has(login) || fresh.some((r) => r.readiness === "cooled-off") ? "cooling-off" : "not-ready";
    return { login, hold };
  });
}

/**
 * Whether a taker other than the runner token `exceptToken` (null: any) may take `c` on `c.tier` now: where a call that a
 * model's safety filter declined can run once more (calls.ts submitCall). A bound call counts only its user's runners.
 */
export async function tierTaker(db: Db, c: TakerCall & { tier: Tier }, exceptToken: number | null, nowMs: number): Promise<boolean> {
  const { runners, canWrite } = await readRunners(db, nowMs);
  return runners.some((r) => r.tokenId !== exceptToken && r.tiers.has(c.tier) && (c.forLogin
    ? r.login.toLowerCase() === c.forLogin.toLowerCase() && roleFits(r.role, c) && c.repos.every((x) => canWrite(r.login, x))
    : runnerTakes(r, c, canWrite)));
}

/** A key equal for two units exactly when the same users of `logins` take them under their item choices (task-items.ts); "" when none does. */
async function filterKey(db: Db, logins: readonly string[]): Promise<(refs: readonly { repo: string; number: number }[]) => string> {
  const filters = (await mapSeq(logins, async (login) => ({ login: login.toLowerCase(), f: await itemFilter(db, login) }))).filter((x) => x.f !== null);
  if (!filters.length) return () => "";
  return (refs) => filters.filter(({ f }) => itemsFit(f, { repos: [], refs })).map((x) => x.login).join(",");
}

/**
 * For batching: a key equal for two units exactly when the same filtered users take them, so a batch of one key matches a
 * filtered user when every unit in it does and a unit some takers take is never held with units only others take. Every user
 * with a stored item choice counts, connected or not, so a runner that connects after the batches are made is not handed items
 * its user does not take.
 */
export async function batchKey(db: Db): Promise<(refs: readonly { repo: string; number: number }[]) => string> {
  return await filterKey(db, (await db.all(db.k.selectFrom("main.user_settings").select("login").where("key", "=", TASK_ITEMS_KEY).orderBy((eb) => eb.fn("lower", ["login"])))).map((r) => r.login));
}

/**
 * For caching room and taker answers by unit: as batchKey, over the users of the fresh, ready runners with an item choice (a
 * superset of the takers and the room's helpers at `nowMs`), so units of one repo share answers when no connected runner filters.
 */
export async function roomKey(db: Db, nowMs: number = Date.now()): Promise<(refs: readonly { repo: string; number: number }[]) => string> {
  return await filterKey(db, (await db.all(db.k.selectFrom("main.mcp_tokens as t").innerJoin("main.remote_helpers as h", "h.token_id", "t.id")
    .innerJoin("main.user_settings as ti", (j) => j.onRef("ti.login", "=", "t.login").on("ti.key", "=", TASK_ITEMS_KEY))
    .select("t.login").where("t.kind", "=", "runner").where("t.expires_at", ">", new Date(nowMs).toISOString()).where("h.readiness", "=", "ready").where("h.reported_at", ">=", nowMs - STATUS_FRESH_MS)
    .groupBy("t.login").orderBy((eb) => eb.fn("lower", ["t.login"])).orderBy("t.login"))).map((r) => r.login));
}

/**
 * The error of a call withdrawn for lack of a taker: its caller skips the work (NoTakerError). `step`: a taker may take calls on
 * its repos, but none takes its task. `items`: the item choices of the takers that take its repos and task but not its items
 * (task-items.ts).
 */
export const noTakerReason = (repos: readonly string[], step?: string, items?: readonly Exclude<TaskItems, "all">[]): string => {
  const task = step === undefined ? undefined : taskOfStep(step);
  return `${NO_TAKER_PREFIX} ${items?.length ? `on its items (My tasks: ${items.map((x) => TASK_ITEMS_TITLE[x]).join(" or ")})` : task !== undefined ? `of the ${TASK_CHOICES.find((t) => t.id === task)?.title ?? task} task (My tasks)` : repos.length ? `on ${repos.join(", ")}` : "that name no repo"}`;
};

/** Whether one of `login`'s own Task Runners is a taker for a call bound to them (NewCall.forLogin) on `repos` now. */
export async function ownTaker(db: Db, login: string, c: { prompt_id: string; repos: readonly string[]; tier: Tier }, nowMs: number = Date.now()): Promise<boolean> {
  return await takerTest(db, nowMs)({ ...c, forLogin: login });
}

/** The error of a bound call withdrawn because none of its user's Task Runners is ready: its caller skips the work (NoTakerError). */
export const noOwnRunnerReason = (login: string): string => `${NO_TAKER_PREFIX} for ${login}: none of their Task Runners is connected and ready`;

/** Why no taker takes a call `takes` says no to: its user's runners for a bound call; else its repos, else its task, else the item choices of the runners that take the rest. */
async function whyNoTaker(db: Db, nowMs: number, takes: (c: TakerCall) => Promise<boolean>, c: { prompt_id: string; repos: readonly string[]; step: string; forLogin?: string | null }): Promise<string> {
  if (c.forLogin) return noOwnRunnerReason(c.forLogin);
  if (!await takes({ prompt_id: c.prompt_id, repos: c.repos })) return noTakerReason(c.repos);
  if (!await takes({ prompt_id: c.prompt_id, repos: c.repos, step: c.step })) return noTakerReason(c.repos, c.step);
  const { runners, canWrite } = await readRunners(db, nowMs);
  const choices = new Set(await mapSeq(runners.filter((r) => r.items && runnerTakes({ ...r, items: null }, { prompt_id: c.prompt_id, repos: c.repos, step: c.step }, canWrite)), async (r) => await userTaskItems(db, r.login)));
  return noTakerReason(c.repos, c.step, TASK_ITEMS.filter((x): x is Exclude<TaskItems, "all"> => x !== "all" && choices.has(x)));
}

/**
 * Why no connected Task Runner may take a call of `step` on `repo` now, or null when one may (always null outside the user-local
 * mode). For a request that would otherwise queue work nothing takes.
 */
export async function noTakerFor(db: Db, repo: string, step: string, nowMs: number = Date.now()): Promise<string | null> {
  if (await inferenceMode(db) !== "user-local") return null;
  const takes = takerTest(db, nowMs);
  if (await takes({ prompt_id: "", repos: [repo], step })) return null;
  return await whyNoTaker(db, nowMs, takes, { prompt_id: "", repos: [repo], step });
}

/**
 * One maintenance pass at `nowMs`. Each pipeline-on repo with no taker whose user takes some task keeps the time it was first seen so
 * (remote_no_taker); one with a taker loses it. Each queued call with a live caller that is no follow-up, has no pick
 * that counts and is not held for the user who started its work (started.ts) gets the same mark (no_taker_since), and is withdrawn once the mark is NO_TAKER_MS old. Returns the number of
 * calls withdrawn. Outside the user-local mode the repo marks are cleared.
 */
export async function sweepTakers(db: Db, nowMs: number = Date.now()): Promise<number> {
  if (await inferenceMode(db) !== "user-local") {
    await db.run(db.k.deleteFrom("main.remote_no_taker"));
    return 0;
  }
  const takes = takerTest(db, nowMs);
  const repos = (await db.all(db.k.selectFrom("main.tracked_repos").select("name").where("pipeline", "=", 1))).map((r) => r.name);
  const untaken = await filterSeq(repos, async (repo) => !await takes({ prompt_id: "", repos: [repo], someTask: true }));
  await db.run(db.k.deleteFrom("main.remote_no_taker").where(kx.inList(db, "repo", untaken, "text", true)));
  for (const repo of untaken) await db.run(db.k.insertInto("main.remote_no_taker").values({ repo, since: nowMs }).onConflict((oc) => oc.doNothing()));

  const marked = new Map((await db.all(db.k.selectFrom("main.remote_calls").select(["id", "no_taker_since"]).where("state", "=", "queued").where("no_taker_since", "is not", null)
    .$narrowType<{ no_taker_since: NotNull }>())).map((r) => [r.id, r.no_taker_since]));
  const set = async (since: number | null, id: number): Promise<unknown> => await db.run(db.k.updateTable("main.remote_calls").set({ no_taker_since: since }).where("id", "=", id).where("state", "=", "queued"));
  let pickers: Set<string> | null = null;
  let withdrawn = 0;
  const started = await readStartedCalls(db, nowMs);
  for (const c of await queueSnapshot(db, nowMs)) {
    const since = marked.get(c.id);
    const own = c.parent_id !== null || c.seen_at < nowMs - CALLER_STALE_MS || heldForOwner(started, c, null, nowMs)
      || await pickCounts(c, nowMs, async (who) => (pickers ??= await pickerLogins(db, nowMs)).has(who));
    if (own || await takes(c)) {
      if (since !== undefined) await set(null, c.id);
    } else if (since === undefined) await set(nowMs, c.id);
    else if (since <= nowMs - NO_TAKER_MS && await withdrawCall(db, c.id, await whyNoTaker(db, nowMs, takes, c), ["queued"], nowMs)) withdrawn++;
  }
  return withdrawn;
}
