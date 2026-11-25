// Calls for work a person started or approved in the maintainer workflow (src/workflow): every item a queued call names has a
// live workflow in a repo on that workflow whose starter or approver is the person, or is the PR of an issue whose live
// implement workflow they started or approved (a current attempt). Their own Task Runners take such a call first, ahead of
// automatic work, in a slot that counts toward their Max calls at once, and not held back by their cool-off. While one of
// their runners is fresh, ready and not cooling off, offers the call's tier and may take it (role rules, write permission, a
// token whose model did not decline it), other users' runners pass the call over, for at most STARTED_HOLD_MS from its
// queueing (calls.ts claimOrder, takers.ts sweepTakers). Then, or when no owner can take it, any runner takes it under all
// its own limits. For the taker rule (takers.ts) an owner's runner counts connected or not, ready or not: the work waits for
// it rather than being reported as having no taker. Registered as a wait in src/stages/registry.ts.
import type { ItemRef } from "../../web/src/api/types.ts";
import type { Db } from "../db/index.ts";
import { WRITE_PERMISSIONS } from "../dash/server/provider.ts";
import { PERM_READ_TTL } from "../dash/server/sessions.ts";
import { inList } from "../db/kx.ts";
import { LIVE_STATES } from "../workflow/store.ts";
import type { Entry } from "../workflow/types.ts";
import { judges, roleFits } from "./calls.ts";
import { STATUS_FRESH_MS } from "./helpers.ts";
import { acceptedModels, familyOf, isTier } from "./mode.ts";
import { taskOfStep } from "./my-tasks.ts";
import type { Tier } from "./protocol.ts";
import { scaled } from "./time-scale.ts";

/** How long other users' runners pass a started call over for its owner, from its queueing. */
export const STARTED_HOLD_MS = scaled(10 * 60_000);
/** How long claims reuse one reading (calls.ts QUEUE_CACHE_MS). */
const CACHE_MS = 2_000;

/** The attempts that are not current, as the implementations_current index leaves them out. */
export const ENDED_ATTEMPTS = ["merged", "closed", "failed", "cancelled"];

/** The My tasks ids (my-tasks.ts) of the steps a live workflow of each entry runs. */
const ENTRY_TASKS: Record<Entry, ReadonlySet<string>> = {
  review: new Set(["review", "fixup", "verify", "merge"]),
  fixup: new Set(["fixup", "review", "verify", "merge"]),
  implement: new Set(["fix", "review", "fixup", "verify", "merge"]),
  merge: new Set(["fixup", "merge"]),
};
/** Workflow states in which AutoCraft runs steps; in the others the workflow waits for a person. */
const WORKING = new Set(["running", "waiting"]);

export type StartedCalls = {
  /** The lowercase logins whose call one with these items is: those that started or approved work on every one of them. */
  owners: (refs: readonly ItemRef[]) => ReadonlySet<string>;
  /** The tiers the lowercase login's fresh, ready Task Runners offer while the login is not cooling off (empty: none). */
  tiersOf: (login: string) => ReadonlySet<Tier>;
  /** Whether one of the login's such runners, of a credential other than `refusedToken`, may take a call on `repos` of `prompt_id`. */
  canTake: (login: string, c: { prompt_id: string; repos: readonly string[]; tier?: Tier; refusedToken?: number | null }) => boolean;
  /** The lowercase logins with such a runner. */
  runnerLogins: readonly string[];
  /**
   * The lowercase logins whose started work a call or job is: with `refs`, owners(refs); without (a job asked about before its
   * items are known), the logins with such a runner that have, in every one of `repos`, a live workflow AutoCraft is working
   * on (running or waiting) whose steps include `step`'s task. No step: none.
   */
  ownersFor: (c: { repos: readonly string[]; refs?: readonly ItemRef[]; step?: string }) => ReadonlySet<string>;
  /**
   * The lowercase logins whose started work a call or job is (as ownersFor) and who have a runner token, connected or not, ready
   * or not, cooling off or not, that may take it once it claims: the role rules, write permission, and its tier among the models
   * the runner last reported (any tier before its first report). The taker rule counts them, so the work waits for their runner.
   */
  waitersFor: (c: { prompt_id: string; repos: readonly string[]; refs?: readonly ItemRef[]; step?: string; tier?: Tier }) => ReadonlySet<string>;
};

const NONE: ReadonlySet<never> = new Set();

/** Reads the live workflows' starters and approvers and the runners that may take their calls. */
export async function readStartedCalls(db: Db, nowMs: number): Promise<StartedCalls> {
  const [live, prs, runners, tokens, accepted] = await Promise.all([
    db.all(db.k.selectFrom("main.item_workflows as w").innerJoin("main.tracked_repos as r", "r.name", "w.repo")
      .select(["w.repo", "w.number", "w.entry", "w.state", "w.started_by", "w.approved_by"]).where("r.workflow", "=", "new").where("w.state", "in", LIVE_STATES)),
    db.all(db.k.selectFrom("main.implementations as i").innerJoin("main.item_workflows as w", (j) => j.onRef("w.repo", "=", "i.repo").onRef("w.number", "=", "i.number"))
      .innerJoin("main.tracked_repos as r", "r.name", "w.repo")
      .select(["i.repo", "i.pr_number", "w.started_by", "w.approved_by"]).where("i.pr_number", "is not", null).where("i.state", "not in", ENDED_ATTEMPTS).where("w.entry", "=", "implement")
      .where("r.workflow", "=", "new").where("w.state", "in", LIVE_STATES)),
    db.all(db.k.selectFrom("main.remote_helpers as h").innerJoin("main.mcp_tokens as t", "t.id", "h.token_id").leftJoin("main.access as a", "a.login", "t.login").select(["t.id", "h.login", "h.models", "a.role"])
      .where("t.kind", "=", "runner").where("t.expires_at", ">", new Date(nowMs).toISOString()).where("h.reported_at", ">=", nowMs - STATUS_FRESH_MS).where("h.readiness", "=", "ready")
      .where((eb) => eb.not(eb.exists(eb.selectFrom("main.remote_cooloffs as co").select(eb.lit(1).as("one")).whereRef("co.login", "=", "t.login").where("co.until", ">", nowMs))))),
    db.all(db.k.selectFrom("main.mcp_tokens as t").leftJoin("main.remote_helpers as h", "h.token_id", "t.id").leftJoin("main.access as a", "a.login", "t.login").select(["t.login", "h.models", "a.role"])
      .where("t.kind", "=", "runner").where("t.expires_at", ">", new Date(nowMs).toISOString())),
    acceptedModels(db),
  ]);
  const byItem = new Map<string, Set<string>>();
  const add = (repo: string, number: number, logins: (string | null)[]) => {
    const key = `${repo}#${number}`;
    let s = byItem.get(key);
    if (!s) byItem.set(key, (s = new Set()));
    for (const l of logins) if (l) s.add(l.toLowerCase());
  };
  for (const w of live) add(w.repo, w.number, [w.started_by, w.approved_by]);
  for (const p of prs) add(p.repo, p.pr_number!, [p.started_by, p.approved_by]);
  const tiersIn = (json: string): Set<Tier> => {
    let models: Record<string, unknown> = {};
    try { models = JSON.parse(json) as Record<string, unknown>; } catch { /* no models */ }
    return new Set(Object.entries(models).flatMap(([t, m]) => (isTier(t) && typeof m === "string" && familyOf(m, accepted[t]) !== null ? [t] : [])));
  };
  const runnersOf = new Map<string, { role: string; tokens: Map<number, Set<Tier>> }>();
  for (const r of runners) {
    const login = r.login.toLowerCase();
    const u = runnersOf.get(login) ?? { role: r.role ?? "", tokens: new Map<number, Set<Tier>>() };
    u.tokens.set(Number(r.id), tiersIn(r.models));
    runnersOf.set(login, u);
  }
  const runnerLogins = [...runnersOf.keys()];
  // Every runner token, by login: its tiers as last reported, null before its first report.
  const tokensOf = new Map<string, { role: string; tiers: (Set<Tier> | null)[] }>();
  for (const r of tokens) {
    const login = r.login.toLowerCase();
    const u = tokensOf.get(login) ?? { role: r.role ?? "", tiers: [] };
    u.tiers.push(r.models === null ? null : tiersIn(r.models));
    tokensOf.set(login, u);
  }
  const tokenLogins = [...tokensOf.keys()];
  // The room's write rule (room.ts roomCanWrite): only a non-write permission confirmed within PERM_READ_TTL leaves a login out.
  const denied = new Set<string>();
  if (tokenLogins.length) for (const p of await db.all(db.k.selectFrom("main.repo_permissions").select(["login", "repo", "permission", "checked_at"]).where(inList(db, "login", tokenLogins, "citext"))))
    if (!WRITE_PERMISSIONS.has(p.permission) && nowMs - Date.parse(p.checked_at) < PERM_READ_TTL) denied.add(`${p.login.toLowerCase()}\n${p.repo}`);
  const owners = (refs: readonly ItemRef[]): ReadonlySet<string> => {
    if (!refs.length || !byItem.size) return NONE;
    const [first, ...rest] = refs.map((r) => byItem.get(`${r.repo}#${r.number}`));
    if (!first || rest.some((s) => !s)) return NONE;
    return new Set([...first].filter((l) => rest.every((s) => s!.has(l))));
  };
  /** owners(refs) with `refs`; without, those of `logins` with a working live workflow in every repo whose steps include the step's task. */
  const startedBy = (logins: readonly string[], c: { repos: readonly string[]; refs?: readonly ItemRef[]; step?: string }): ReadonlySet<string> => {
    if (c.refs) return owners(c.refs);
    if (c.step === undefined || !c.repos.length) return NONE;
    const task = taskOfStep(c.step);
    const working = live.filter((w) => WORKING.has(w.state) && ENTRY_TASKS[w.entry as Entry]?.has(task));
    return new Set(logins.filter((l) => c.repos.every((x) => working.some((w) => w.repo === x && [w.started_by, w.approved_by].some((b) => b?.toLowerCase() === l)))));
  };
  const deniedOn = (login: string, repos: readonly string[]): boolean => repos.some((x) => denied.has(`${login.toLowerCase()}\n${x}`));
  return {
    owners, runnerLogins,
    tiersOf: (login) => new Set([...runnersOf.get(login.toLowerCase())?.tokens.values() ?? []].flatMap((t) => [...t])),
    canTake: (login, c) => {
      const u = runnersOf.get(login.toLowerCase());
      if (!u || !roleFits(u.role, c) || deniedOn(login, c.repos)) return false;
      return [...u.tokens].some(([id, tiers]) => id !== c.refusedToken && (c.tier === undefined ? tiers.size > 0 : tiers.has(c.tier)));
    },
    ownersFor: (c) => startedBy(runnerLogins, c),
    waitersFor: (c) => new Set([...startedBy(tokenLogins, c)].filter((l) => {
      const u = tokensOf.get(l);
      return !!u && roleFits(u.role, c) && !deniedOn(l, c.repos) && u.tiers.some((t) => t === null || (c.tier === undefined ? t.size > 0 : t.has(c.tier)));
    })),
  };
}

const caches = new WeakMap<Db, { at: number; v: Promise<StartedCalls> }>();
/** readStartedCalls for claims, read at most once per CACHE_MS. */
export function startedCallsCached(db: Db, nowMs: number): Promise<StartedCalls> {
  const hit = caches.get(db);
  if (hit && nowMs >= hit.at && nowMs - hit.at < CACHE_MS) return hit.v;
  const v = readStartedCalls(db, nowMs);
  caches.set(db, { at: nowMs, v });
  // The caller awaits v; this only drops a failed reading from the cache.
  void v.catch(() => { if (caches.get(db)?.v === v) caches.delete(db); });
  return v;
}
/** Drops the cached reading (with the queue cache, calls.ts dropQueueCache). */
export const dropStartedCache = (db: Db): void => void caches.delete(db);

/**
 * Whether a queued call is held for an owner other than `login` (null: anyone): within STARTED_HOLD_MS of its queueing, an
 * owner who may take it (canTake: a fresh, ready runner not cooling off that offers its tier, the role rules, write permission,
 * a credential other than the one whose model declined it; not a judging call on an item they authored). A call bound to a
 * user is never one of these. A runner's harness, effort and time limit are known only at its claim: a call none of the
 * owner's runners will lease for those is free once the hold ends.
 */
export function heldForOwner(s: StartedCalls, c: { forLogin: string | null; refs: readonly ItemRef[]; repos: readonly string[]; prompt_id: string; tier: Tier; authors: ReadonlySet<string>; refusedToken: number | null; since: number }, login: string | null, nowMs: number): boolean {
  if (c.forLogin !== null || c.since < nowMs - STARTED_HOLD_MS) return false;
  const self = login?.toLowerCase() ?? null;
  const judging = judges(c.prompt_id);
  for (const o of s.owners(c.refs)) if (o !== self && !(judging && c.authors.has(o)) && s.canTake(o, c)) return true;
  return false;
}
