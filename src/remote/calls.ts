// Remote calls of the user-local inference mode. The calling process (askClaude, src/classify/run.ts) inserts a call
// and polls its row; a maintainer's helper claims it with an agent token that may run tasks, fetches the bundle and
// sends heartbeats and the reply with the lease secret (routes in src/dash/server/index.ts, wire format in protocol.ts).
// Leases are checked by the calling process on each poll and by every claim; the dashboard deletes old rows once a minute (pruneRemote).
import type { ItemRef } from "../../web/src/api/types.ts";
import { allocation, callQueue, NoTakerError, runningCounts, sortQueue, stepOf, throwIfHalted, WaitLimitError, type Waiter } from "../agents/call.ts";
import { finishRun, insertRun, packPrompt, setRunProgress } from "../agents/runs.ts";
import { saveRemoteTools } from "../agents/tools.ts";
import { scrubError } from "../agents/text.ts";
import type { Usage } from "../classify/run.ts";
import { randomToken, sha256hex } from "../dash/server/crypto.ts";
import { HttpError } from "../dash/server/util.ts";
import type { Role } from "../dash/types.ts";
import { fillHarness, rootArgs, validRoot } from "../prompts/harness.ts";
import { rootAgents } from "../sandbox/agents.ts";
import { joinParts } from "../prompts/index.ts";
import { scrub } from "../runner/scrub.ts";
import { cooledOf, cooloffOf, cooloffRow, noteDrop, noteFailure, noteSuccess, pruneCooloffs } from "./cooloff.ts";
import { aliveOf, dashboardAlive, livenessRow } from "./liveness.ts";
import { acceptedModels, familyOf, INFERENCE_KEY, isEffort, isTier, meetsEffort, modeOf, modelsOf, REMOTE_MODELS_KEY, TIERS, type InferenceMode } from "./mode.ts";
import { ACCEPTED_PROTOCOLS, CLAIM_ID_TTL_S, HEARTBEAT_S, PREPARE_MAX_S, ROUTES, type Claim, type ClaimReply, type Effort, type HarnessId, type Heartbeat, type Release, type Reserve, type Submit, type SubmitReply, type TaskBundle, type Tier } from "./protocol.ts";
import { claimRepos, claimReposOf, reposOf, REPOS_KEY } from "./my-repos.ts";
import { SKIP_TASKS_KEY, skipsOf, taskOfStep, userSkips } from "./my-tasks.ts";
import { itemFilter, itemFilterOf, itemsFit, TASK_ITEMS_KEY, taskItemsOf, type ItemFilter } from "./task-items.ts";
import { INTERACTIVE_HELPER, INTERACTIVE_PROMPTS, interactive, userInteractiveSlots } from "./interactive-slots.ts";
import { MAX_CALLS_KEY, MAX_CALLS_MAX, maxCallsOf, userMaxCalls } from "./max-calls.ts";
import { claimClass, gating } from "./claim-class.ts";
import { holdMs, Ticket, type ClaimTry, type ClaimWaits, type EmptyReply } from "./claim-wait.ts";
import { RESERVE_KEYS, reserveOf, userReserve } from "./reserve.ts";
import { scaled, scaledS } from "./time-scale.ts";
import { CALLER_STALE_MS, IDLE_FRESH_MS, SEEN_EVERY_MS } from "./room.ts";
import { STATUS_FRESH_MS } from "./helpers.ts";
import { MANUAL_ONLY_KEY, manualExpr, manualOf, manualOnly } from "./manual-only.ts";
import { WRITE_PERMISSIONS } from "../dash/server/provider.ts";
import { PERM_READ_TTL } from "../dash/server/sessions.ts";
import { endChecks, serveChecks } from "./check-relay.ts";
import { WorkspaceServer, type ToolSession } from "../build/workspace-relay.ts";
import { resumePrompt } from "../build/workspace-call.ts";
import { WORKSPACE_SERVER } from "../build/workspace-tools.ts";
import { NO_TAKER_SKIP, skipItem } from "../runner/leases.ts";
import { tierTaker } from "./takers.ts";
import type { CheckTool } from "../checktool/index.ts";
import { filterSeq, mapSeq } from "../async-seq.ts";
import type { AliasableExpression, SqlBool } from "kysely";
import { adoptableCallExpr, earlierRunCallExpr, resumedRun, resumingJobsExpr } from "../runner/resuming.ts";
import type { Db } from "../db/index.ts";
import { ciEq as ciEqExpr, greatest, indexedBy, inList, least, literal, ref, rowValues, type Eb, type Ex } from "../db/kx.ts";
import { settings } from "../settings-read.ts";

/** A lease with no heartbeat for this long, while the dashboard was serving (liveness.ts), goes back to the queue. */
export const LEASE_IDLE_MS = scaled(2 * 60_000);
/** A lease also ends this long after the bundle's own time limit, counted from its first `running` heartbeat. */
export const LEASE_MARGIN_MS = scaled(2 * 60_000);
/**
 * How long a follow-up turn waits for the helper that holds its session before the caller falls back to a fresh call, while
 * that login runs no live lease. While it does (the helper is busy, and its fast lane takes the turn as soon as it is free),
 * the turn waits up to STICKY_CAP_MS.
 */
export const STICKY_MS = LEASE_IDLE_MS;
export const STICKY_CAP_MS = scaled(15 * 60_000);
/** A lease counts as live for a waiting follow-up while its last heartbeat is at most this old (three heartbeats). */
const STICKY_LIVE_MS = 3 * scaled(HEARTBEAT_S * 1000);
/** A call whose caller has not polled for this long has lost it (the process died): the call fails. */
export const CALLER_GONE_MS = scaled(5 * 60_000);
/** Seconds a helper waits before claiming again when nothing could be taken. */
export const CLAIM_RETRY_S = scaledS(15);
/** The oldest helper version that may run a lease. */
export const REQUIRED_HELPER = "1.2.0";
/** Where interactive calls go (claimOrder): only to the interactive lane, to no claim (the claim's pipeline slots), or, for a helper older than INTERACTIVE_HELPER that has no such lane, to any claim. */
type InteractiveMode = "lane" | "off" | "legacy";
/** Where a claim's bound calls go (claimOrder). */
type BoundCalls = "only" | "with" | "without";
/** A call this login released is not offered to it again for this long (its helper could not run it). */
export const RELEASE_SKIP_MS = scaled(10 * 60_000);
/**
 * The most queue time the runner leaves out of a job's deadline and no-progress stop. Helpers run on people's own machines
 * across time zones, so a call may wait out a night with nobody online; past 12 hours the call is unlikely to be taken at all
 * (no eligible helper: the only maintainers authored the item), and the job is stopped so it no longer holds its item.
 */
export const REMOTE_WAIT_CAP_MS = 12 * 3600_000;
/** The start of the error of a call withdrawn because no Task Runner could take it (takers.ts sweepTakers). */
export const NO_TAKER_PREFIX = "no Task Runner can take calls";
/** Ended calls are kept this long (task status, follow-up lookups), then deleted. */
const KEEP_MS = 24 * 3600_000;
const LEASE_PREFIX = "aclease_";
const PROGRESS_MAX = 200;
const REPLY_MAX = 4_000_000;

/** Prompts that judge an item: an author or co-author of an item they judge gets their calls only when no other helper that could take them is asking for work. */
const JUDGING = new Set(["review.opus", "premerge.opus", "postmerge.opus", "fixup.check", "decide.prepare", "conversation.turn", "verify.compare", "classify.haiku", "security.verify", "security.fixcheck"]);
export const judges = (promptId: string): boolean => JUDGING.has(promptId) || promptId.startsWith("dupes.compare-");

/** What a helper's fast-lane slot takes: gating calls (its own sessions' follow-ups among them) and small-tier calls. */
const fastLaneFits = (r: { tier: Tier; parent_id: number | null; prompt_id: string }): boolean => gating(r) || r.tier === "small";

type Row = {
  id: number; job_id: number | null; step: string; stage: number; run_id: number | null; prompt_id: string; prompt_version: string;
  tier: Tier; effort: string; asked_model: string; bundle: string; state: "queued" | "leased" | "done" | "failed"; items: string; repo: string | null;
  cls: number; level: number; since: number; seen_at: number; queued_since: number | null; queued_ms: number;
  user_login: string | null; harness: string | null; model: string | null; leased_at: number | null; heartbeat_at: number | null; started_at: number | null;
  token_id: number | null; lease_secret_hash: string | null;
  attempt: number; max_attempts: number; timeout_ms: number; parent_id: number | null; sticky_login: string | null; progress: string | null;
  reply: string | null; usage: string | null; turns: number | null; session_id: string | null; error: string | null; root: string | null;
  for_login: string | null; refusals: number;
};
const COLS = ["id", "job_id", "step", "stage", "run_id", "prompt_id", "prompt_version", "tier", "effort", "asked_model", "bundle", "state", "items", "repo", "class as cls", "level", "since", "seen_at", "queued_since", "queued_ms", "user_login", "harness", "model", "leased_at", "heartbeat_at", "started_at", "token_id", "lease_secret_hash", "attempt", "max_attempts", "timeout_ms", "parent_id", "sticky_login", "progress", "reply", "usage", "turns", "session_id", "error", "root", "for_login", "refusals"] as const;
const rowOf = async (db: Db, id: number): Promise<Row | undefined> =>
  await db.get(db.k.selectFrom("main.remote_calls").select(COLS).where("id", "=", id).$narrowType<{ tier: Tier; state: Row["state"] }>());

export type NewCall = {
  promptId: string; promptVersion: string; tier: Tier; effort: string; askedModel: string;
  bundle: Omit<TaskBundle, "callId">; items: ItemRef[]; level: number; maxAttempts: number;
  /** A follow-up turn on the session of this call. */
  parentId?: number;
  /** The repo whose reference documentation the call's reference tools search (when its bundle lists REFERENCE_SERVER). */
  referenceRepo?: string;
  /** Only this user's own Task Runners take the call (a maintainer's conversation turn); a follow-up keeps its parent's. */
  forLogin?: string;
  /**
   * With forLogin: the call runs in one of that user's Task Runner slots and counts toward their Max calls at once, never in
   * the own lane (Claim.ownLane), which is for short turns; a follow-up keeps its parent's.
   */
  boundSlot?: boolean;
};

/** JSON with object keys sorted, so equal values give equal text. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x === undefined ? null : x)).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** The bundle hash a resumed run matches its earlier run's calls by: everything the call asks (prompt, mounts at their commits, arguments, the parent of a follow-up). */
export const bundleHash = (bundle: NewCall["bundle"]): string => sha256hex(canonicalJson(bundle));

/** Calls this process queued or adopted: a resumed run adopts each earlier call once. */
const adopted = new Set<number>();
/** One adoption at a time, so two equal calls of one job made side by side do not adopt the same earlier call. */
let adopting: Promise<unknown> = Promise.resolve();

/**
 * In a resumed job: adopts a call of the job's earlier runs with the same prompt, version, bundle and parent that is still
 * open or answered and unread, and returns its id. When there is none, the earlier runs' open calls with the same prompt,
 * items and parent asked something else (the input changed meanwhile): the resumed run will not adopt them, so they are
 * withdrawn and free their Task Runner.
 */
function adoptEarlier(db: Db, jobId: number, startedMs: number, c: NewCall, hash: string, nowMs: number): Promise<number | null> {
  const turn = adopting.then(async (): Promise<number | null> => {
    const taken = [...adopted];
    const parent = (eb: Eb) => (c.parentId === undefined ? eb("parent_id", "is", null) : eb("parent_id", "=", c.parentId));
    const earlier = await db.get(db.k.selectFrom("main.remote_calls").select("id").where("job_id", "=", jobId).where("since", "<", startedMs).where("prompt_id", "=", c.promptId)
      .where("prompt_version", "=", c.promptVersion).where("bundle_hash", "=", hash).where(parent).where((e) => adoptableCallExpr(e))
      .$if(taken.length > 0, (q) => q.where("id", "not in", taken)).orderBy("id").limit(1));
    if (earlier) {
      const id = Number(earlier.id);
      adopted.add(id);
      // Fresh again for claims and the room: its caller is back. A queued call's wait starts again: the time it waited
      // before the stop (its earlier caller's last poll) counts toward its wait limits, the restart's does not.
      await db.run(db.k.updateTable("main.remote_calls").set((eb) => ({
        queued_ms: eb("queued_ms", "+", eb.case().when(eb.and([eb("state", "=", "queued"), eb("queued_since", "is not", null)]))
          .then(greatest(db, [eb.lit(0), eb(least(db, ["seen_at", eb.val(nowMs)]), "-", eb.ref("queued_since"))])).else(eb.lit(0)).end()),
        queued_since: eb.case().when("state", "=", "queued").then(nowMs).else(eb.ref("queued_since")).end(), seen_at: nowMs,
      })).where("id", "=", id));
      dropQueueCache(db);
      console.log(`adopted remote call ${id} (${c.promptId}) of the job's run before the restart`);
      return id;
    }
    const stale = await db.all(db.k.selectFrom("main.remote_calls").select("id").where("job_id", "=", jobId).where("since", "<", startedMs).where("prompt_id", "=", c.promptId)
      .where("items", "=", JSON.stringify(c.items)).where(parent).where("state", "=", "queued").$if(taken.length > 0, (q) => q.where("id", "not in", taken)));
    for (const r of stale) await withdrawCall(db, Number(r.id), "the resumed job asked again with other input", ["queued"], nowMs);
    return null;
  });
  adopting = turn.catch(() => undefined);
  return turn;
}

/**
 * Queues a call for the current job and step; a follow-up is offered only to the helper of the parent's lease holder. In a
 * resumed job (src/runner/resuming.ts) it first adopts an equal call of the job's earlier run (adoptEarlier): the reply a
 * Task Runner sends, or sent during the restart, lands there.
 */
export async function enqueueCall(db: Db, c: NewCall, nowMs: number = Date.now()): Promise<number> {
  const s = stepOf(c.promptId), q = callQueue(c.promptId);
  const hash = bundleHash(c.bundle);
  const run = s.jobId === null ? null : await resumedRun(db, s.jobId);
  if (s.jobId !== null && run) {
    const id = await adoptEarlier(db, s.jobId, Date.parse(run.startedAt), c, hash, nowMs);
    if (id !== null) return id;
  }
  const parent = c.parentId === undefined ? undefined : await db.get(db.k.selectFrom("main.remote_calls").select(["user_login", "for_login", "bound_slot"]).where("id", "=", c.parentId));
  const sticky = parent?.user_login ?? null;
  const authors = judges(c.promptId) ? JSON.stringify(await authorsOf(db, c.items)) : "[]";
  const forLogin = c.forLogin ?? parent?.for_login ?? null;
  const boundSlot = forLogin !== null && (c.forLogin !== undefined ? c.boundSlot === true : Number(parent?.bound_slot) === 1);
  const id = Number((await db.get(db.k.insertInto("main.remote_calls").values({
    job_id: s.jobId, step: s.step, stage: s.stage, prompt_id: c.promptId, prompt_version: c.promptVersion, tier: c.tier, effort: c.effort, asked_model: c.askedModel,
    bundle: JSON.stringify(c.bundle), bundle_hash: hash, state: "queued", items: JSON.stringify(c.items), repo: q.repo, class: q.cls, level: c.level, since: nowMs, seen_at: nowMs, queued_since: nowMs,
    max_attempts: Math.max(1, c.maxAttempts), timeout_ms: c.bundle.timeoutSeconds * 1000, parent_id: c.parentId ?? null, sticky_login: sticky, reference_repo: c.referenceRepo ?? null, authors,
    for_login: forLogin, bound_slot: boundSlot ? 1 : 0,
  }).returning("id")))!.id);
  if (s.jobId !== null) adopted.add(id);
  dropQueueCache(db);
  return id;
}

/** Ends a call that is in one of `states` as failed; true when it did. A leased call's agent run fails with it. */
export async function withdrawCall(db: Db, id: number, reason: string, states: ("queued" | "leased")[] = ["queued", "leased"], nowMs: number = Date.now()): Promise<boolean> {
  const r = await db.get(db.k.updateTable("main.remote_calls").set((eb) => ({
    state: "failed", error: reason, ended_at: nowMs,
    queued_ms: eb("queued_ms", "+", eb.case().when("queued_since", "is", null).then(eb.lit(0)).else(greatest(db, [eb.lit(0), eb(eb.val(nowMs), "-", eb.ref("queued_since"))])).end()), queued_since: null,
  })).where("id", "=", id).where(inList(db, "state", states)).returning("run_id"));
  if (!r) return false;
  if (r.run_id !== null) await finishRun(db, r.run_id, { state: "failed", error: reason, summary: "withdrawn" });
  return true;
}

/**
 * Withdraws the open calls of a job that ended, or of every job (the runner restarted); calls made outside a job are left to
 * their caller, and calls of jobs waiting to resume stay for the resumed run to adopt.
 */
export async function withdrawJobCalls(db: Db, reason: string, jobId?: number): Promise<number> {
  const ids = await db.all(db.k.selectFrom("main.remote_calls").select("id").where("state", "in", ["queued", "leased"])
    .where((eb) => (jobId === undefined ? eb("job_id", "is not", null) : eb("job_id", "=", jobId))).where("job_id", "not in", resumingJobsExpr(db)));
  return (await filterSeq(ids, async (r) => await withdrawCall(db, Number(r.id), reason))).length;
}

/** Keeps the secret hash of a lease that just ended or went back to the queue, so its routes answer 410 (leaseState); kept as long as ended calls (pruneRemote). */
async function bury(db: Db, id: number, hash: string | null, nowMs: number): Promise<void> {
  if (hash === null) return;
  await db.run(db.k.insertInto("main.remote_lease_tombstones").values({ secret_hash: hash, call_id: id, at: nowMs }).onConflict((oc) => oc.doNothing()));
}

/**
 * A lost or failed lease goes back to the queue with the next attempt, or fails once the prompt's attempts are used up.
 * `skipLogin`: the login whose helper failed the call is not offered it again for RELEASE_SKIP_MS.
 */
async function requeue(db: Db, r: Pick<Row, "id" | "run_id" | "attempt" | "max_attempts" | "leased_at" | "lease_secret_hash">, reason: string, nowMs: number, opts: { skipLogin?: string; summary?: string } = {}): Promise<boolean> {
  const fail = r.attempt >= r.max_attempts;
  const skip = opts.skipLogin ?? null;
  // Compare and set: only the lease that was read ends, so two processes that saw it expire end it once.
  const up = await db.run(db.k.updateTable("main.remote_calls").set((eb) => ({
    state: fail ? "failed" : "queued", attempt: eb("attempt", "+", fail ? 0 : 1), lease_secret_hash: null, token_id: null, claim_id: null, started_at: null, queued_since: fail ? null : nowMs, ended_at: fail ? nowMs : null, error: reason,
    progress: null, picked_by: null, picked_at: null, pick_until: null, ...(skip !== null && { released_by: skip, released_at: nowMs }),
  })).where("id", "=", r.id).where("state", "=", "leased").where("attempt", "=", r.attempt)
    .where((eb) => (r.leased_at === null ? eb("leased_at", "is", null) : eb("leased_at", "=", r.leased_at))));
  if (Number(up.changes) !== 1) return false;
  dropQueueCache(db);
  await bury(db, r.id, r.lease_secret_hash, nowMs);
  if (r.run_id !== null) await finishRun(db, r.run_id, { state: "failed", error: reason, summary: opts.summary ?? "lease ended" });
  return true;
}

/** Puts a leased call back in the queue without using an attempt (released by its helper, or its token lost the right to run it). */
async function unlease(db: Db, r: { id: number; runId: number | null; hash: string | null }, why: string, nowMs: number, releasedBy: string | null = null): Promise<void> {
  const up = await db.run(db.k.updateTable("main.remote_calls").set({
    state: "queued", lease_secret_hash: null, token_id: null, claim_id: null, started_at: null, queued_since: nowMs, error: why, progress: null, picked_by: null, picked_at: null, pick_until: null,
    ...(releasedBy !== null && { released_by: releasedBy, released_at: nowMs }),
  }).where("id", "=", r.id).where("state", "=", "leased").where((eb) => (r.hash === null ? eb("lease_secret_hash", "is", null) : eb("lease_secret_hash", "=", r.hash))));
  if (Number(up.changes) !== 1) return;
  dropQueueCache(db);
  await bury(db, r.id, r.hash, nowMs);
  if (r.runId !== null) await finishRun(db, r.runId, { state: "failed", error: why, summary: "returned to the queue" });
}

/**
 * The failure backoff of remote calls (registered in src/stages/registry.ts): a lease with no heartbeat for LEASE_IDLE_MS, a
 * lease still preparing PREPARE_MAX_S after the claim, or one running past its time limit plus LEASE_MARGIN_MS goes back to
 * the queue (attempt + 1, up to the prompt's attempts); a call whose caller stopped polling fails. Leases end only while the
 * dashboard serves, and for lack of heartbeats only when it served for the whole idle window (liveness.ts): helpers reach
 * the server only through it. The lost lease counts toward its login's cool-off. Run by each claim (every call) and by the
 * caller's poll (`id`: that call only); old rows go with pruneRemote.
 */
export async function expireLeases(db: Db, nowMs: number = Date.now(), id?: number): Promise<void> {
  await applyExpiry(db, await readExpiry(db, nowMs, id), nowMs, id);
}

type Expiry = { idle: number; lost: LostLease[]; gone: { id: number }[] };
type LostLease = Pick<Row, "id" | "run_id" | "attempt" | "max_attempts" | "heartbeat_at" | "leased_at" | "started_at" | "timeout_ms" | "token_id" | "user_login" | "lease_secret_hash">;

/** Queued and leased calls whose caller stopped polling. The calls of a resumed job's earlier runs have no caller until the resumed run adopts them; they end with the job (endJob). */
const goneCalls = async (db: Db, nowMs: number, id?: number): Promise<{ id: number }[]> =>
  await db.all(db.k.selectFrom("main.remote_calls").select("id").where("state", "in", ["queued", "leased"]).where("seen_at", "<", nowMs - CALLER_GONE_MS)
    .$if(id !== undefined, (q) => q.where("id", "=", id!)).where((eb) => eb.not(earlierRunCallExpr(db, eb))));

/** What expireLeases reads before it writes: the lost leases (after the liveness stamp, read here unless `alive` gives it) and, at the same time, the gone calls. */
async function readExpiry(db: Db, nowMs: number, id?: number, alive?: Promise<{ alive: boolean; since: number }>): Promise<Expiry> {
  const lost = async (): Promise<Pick<Expiry, "idle" | "lost">> => {
    const live = await (alive ?? dashboardAlive(db, nowMs));
    if (!live.alive) return { idle: 0, lost: [] };
    const idle = live.since <= nowMs - LEASE_IDLE_MS ? 1 : 0;
    // Every lease: the leased rows are found in remote_calls_leased and only the lost ones are read. One call: by its id.
    const ended = (eb: Eb) => eb.and([eb("state", "=", literal("leased")), eb.or([
      ...(idle === 1 ? [eb("heartbeat_at", "<", nowMs - LEASE_IDLE_MS)] : []),
      eb.and([eb("started_at", "is", null), eb(eb("leased_at", "+", scaled(PREPARE_MAX_S * 1000)), "<", nowMs)]),
      eb.and([eb("started_at", "is not", null), eb(eb(eb("started_at", "+", eb.ref("timeout_ms")), "+", LEASE_MARGIN_MS), "<", nowMs)]),
    ])]);
    const rows = await db.all(db.k.selectFrom("main.remote_calls").select(["id", "run_id", "attempt", "max_attempts", "heartbeat_at", "leased_at", "started_at", "timeout_ms", "token_id", "user_login", "lease_secret_hash"])
      .where((eb) => (id === undefined
        ? eb("id", "in", eb.selectFrom(indexedBy(db, "main.remote_calls", "remote_calls_leased", "rl")).select("rl.id").where(ended))
        : eb.and([ended(eb), eb("id", "=", id)]))));
    return { idle, lost: rows };
  };
  const [l, gone] = await Promise.all([lost(), goneCalls(db, nowMs, id)]);
  return { ...l, gone };
}

/** The writes of expireLeases. A requeued lost lease changes the rows the gone calls are read from, so they are read again after it. */
async function applyExpiry(db: Db, e: Expiry, nowMs: number, id?: number): Promise<void> {
  for (const r of e.lost) {
    const why = e.idle && Number(r.heartbeat_at) < nowMs - LEASE_IDLE_MS ? `lease expired: no heartbeat for ${Math.round(LEASE_IDLE_MS / 1000)} s`
      : r.started_at === null ? `lease expired: still preparing ${Math.round(scaled(PREPARE_MAX_S * 1000) / 1000)} s after the claim` : "lease expired: past the call's time limit";
    // A lost lease counts toward its login's cool-off (cooloff.ts), and uses an attempt like a failed call. A lease that never
    // had a heartbeat does not count: the helper most likely never got the claim's reply.
    const beaten = Number(r.heartbeat_at) > Number(r.leased_at);
    if (await requeue(db, r, why, nowMs) && beaten && r.token_id !== null && r.user_login !== null) await noteDrop(db, Number(r.token_id), r.user_login, Number(r.id), nowMs);
  }
  for (const r of e.lost.length ? await goneCalls(db, nowMs, id) : e.gone) await withdrawCall(db, Number(r.id), "the caller stopped waiting", undefined, nowMs);
}

/**
 * Deletes ended calls, finished check relays and lease tombstones older than KEEP_MS, lease drops and cool-offs that no
 * longer count (cooloff.ts), and the last status of deleted tokens. The dashboard runs it once a minute.
 */
export async function pruneRemote(db: Db, nowMs: number = Date.now()): Promise<void> {
  const old = nowMs - KEEP_MS;
  // Each condition is a range of the (state, ended_at) indexes; a row without ended_at goes by when it began.
  await db.run(db.k.deleteFrom("main.remote_calls").where("state", "in", ["done", "failed"]).where("ended_at", "<", old));
  await db.run(db.k.deleteFrom("main.remote_calls").where("state", "in", ["done", "failed"]).where("ended_at", "is", null).where("since", "<", old));
  await db.run(db.k.deleteFrom("main.remote_checks").where("state", "=", "done").where("ended_at", "<", old));
  await db.run(db.k.deleteFrom("main.remote_checks").where("state", "=", "done").where("ended_at", "is", null).where("requested_at", "<", old));
  await db.run(db.k.deleteFrom("main.remote_lease_tombstones").where("at", "<", old));
  await pruneCooloffs(db, nowMs);
  await db.run(db.k.deleteFrom("main.remote_helpers").where((eb) => eb.not(eb.exists(db.k.selectFrom("main.mcp_tokens as t").select(eb.lit(1).as("one")).where("t.id", "=", ref<number>("remote_helpers.token_id"))))));
}

/** The call a lease secret belongs to while its lease is live (expired leases are ended first), or null. For the per-lease routes: bundle, heartbeat, submit, the task MCP servers and the tarball. */
export async function liveLease(db: Db, secret: string | undefined, nowMs: number = Date.now()): Promise<{ id: number; jobId: number | null; runId: number | null; login: string; promptId: string; items: ItemRef[]; repo: string | null; root: string | null } | null> {
  if (!secret || secret.length > 200 || !secret.startsWith(LEASE_PREFIX)) return null;
  const hash = sha256hex(secret);
  const found = await db.get(db.k.selectFrom("main.remote_calls").select("id").where("lease_secret_hash", "=", hash).where("state", "=", "leased"));
  if (!found) return null;
  await expireLeases(db, nowMs, Number(found.id));
  // The lease lives only while the Task Runner credential that claimed it lives and its login is still a maintainer or operator.
  const r = await db.get(db.k.selectFrom("main.remote_calls as c")
    .leftJoin("main.mcp_tokens as t", (j) => j.onRef("t.id", "=", "c.token_id").on("t.kind", "=", "runner").on("t.expires_at", ">", new Date(nowMs).toISOString()))
    .leftJoin("main.access as a", (j) => j.onRef("a.login", "=", "t.login").on("a.role", "in", ["maintainer", "operator"]))
    .select(["c.id", "c.job_id", "c.run_id", "c.user_login", "c.prompt_id", "c.items", "c.repo", "c.root", "a.login as ok"])
    .where("c.id", "=", found.id).where("c.lease_secret_hash", "=", hash).where("c.state", "=", "leased"));
  if (r && r.ok === null) {
    await unlease(db, { id: Number(r.id), runId: r.run_id, hash }, "returned to the queue: the Task Runner that claimed it was removed or may no longer run tasks", nowMs);
    return null;
  }
  // A claim always records its login; a leased row without one has no one to act for.
  return r && r.user_login !== null ? { id: Number(r.id), jobId: r.job_id, runId: r.run_id, login: r.user_login, promptId: r.prompt_id, items: JSON.parse(r.items) as ItemRef[], repo: r.repo, root: r.root } : null;
}

/**
 * The call a lease secret was issued for, whether its lease is live or has ended (submitted, failed, expired, released or
 * requeued: the tombstones), or null for a secret never issued. The lease routes answer 410 for an ended lease and 401 only for null.
 */
export async function leaseState(db: Db, secret: string | undefined): Promise<{ id: number; live: boolean } | null> {
  if (!secret || secret.length > 200 || !secret.startsWith(LEASE_PREFIX)) return null;
  const hash = sha256hex(secret);
  const r = await db.get(db.k.selectFrom("main.remote_calls").select(["id", "state"]).where("lease_secret_hash", "=", hash));
  if (r) return { id: Number(r.id), live: r.state === "leased" };
  const t = await db.get(db.k.selectFrom("main.remote_lease_tombstones").select("call_id").where("secret_hash", "=", hash));
  return t ? { id: Number(t.call_id), live: false } : null;
}

// ---- claims ------------------------------------------------------------------------

export type Caller = { tokenId: number; login: string; role: Role };

const sameLogin = (a: string | null, b: string): boolean => a !== null && a.toLowerCase() === b.toLowerCase();

/** The lowercase logins that authored any of the items, or authored or co-authored (a Co-authored-by trailer, as GitHub lists the commit's authors) a commit of one. */
export async function authorsOf(db: Db, refs: readonly ItemRef[]): Promise<string[]> {
  if (!refs.length) return [];
  const out = new Set<string>();
  for (const r of refs) {
    const a = await db.get(db.k.selectFrom("main.items").select("author").where("repo", "=", r.repo).where("number", "=", r.number).where("author", "is not", null).$narrowType<{ author: string }>());
    if (a) out.add(a.author.toLowerCase());
    for (const c of await db.all(db.k.selectFrom("main.pr_commits").select(["author", "co_authors"]).where("repo", "=", r.repo).where("number", "=", r.number))) {
      if (c.author) out.add(c.author.toLowerCase());
      let co: unknown = [];
      try { co = c.co_authors ? JSON.parse(c.co_authors) : []; } catch { /* not JSON: no co-authors */ }
      if (Array.isArray(co)) for (const x of co) if (typeof x === "string") out.add(x.toLowerCase());
    }
  }
  return [...out];
}

/** A queued call as claims read it: the items parsed, the repos it names and its authors. */
type Cand = Waiter & Pick<Row, "prompt_id" | "tier" | "parent_id" | "sticky_login" | "seen_at"> & {
  /** The call's time limit (its bundle's timeout). */
  timeoutMs: number;
  refs: ItemRef[]; repos: string[]; authors: ReadonlySet<string>; releasedBy: string | null; releasedAt: number | null;
  /** The lowercase login whose own Task Runners alone take the call (NewCall.forLogin), or null for the shared pool. */
  forLogin: string | null;
  /** A bound call that runs in a slot of its user's Task Runners, not their own lane (NewCall.boundSlot). */
  boundSlot: boolean;
  /** The runner token whose model's safety filter declined the call: it is not offered the call again (submitCall). */
  refusedToken: number | null;
  /** The lowercase login of the call's pick ("Run on my Task Runner", picks.ts), when it has one, live or not (pickCounts). */
  pickedBy: string | null; pickedAt: number | null; pickUntil: number | null;
  /** Ends the call's pick; set while it has one. */
  unpick?: () => void;
};

/** The role rules: maintainers and operators; discord.* calls and calls that name no repo go to operators only. */
export const roleFits = (role: string, c: { prompt_id: string; repos: readonly string[] }): boolean =>
  (role === "operator" || role === "maintainer") && !((c.prompt_id.startsWith("discord.") || !c.repos.length) && role !== "operator");

/**
 * Whether a Task Runner may take a call, authorship and picks apart: its user fits the role rules, may write to every repo the
 * call names (`canWrite`, from the cached permissions as the caller reads them) and takes calls on each of them (`repos`: the
 * user's My repos narrowed by the runner's own list, null for every repo; claimRepos) and the call's task (`skip`: the tasks
 * the user unticked, my-tasks.ts; a call without a `step` is a question about repos alone) and its items (`items`: the user's
 * item choice, task-items.ts; a call without `refs` is a question asked before its items are known).
 */
export const runnerTakes = (r: { login: string; role: string; repos: ReadonlySet<string> | null; skip?: ReadonlySet<string>; items?: ItemFilter }, c: { prompt_id: string; repos: readonly string[]; step?: string; refs?: readonly ItemRef[] }, canWrite: (login: string, repo: string) => boolean): boolean =>
  roleFits(r.role, c) && !(c.step !== undefined && r.skip?.has(taskOfStep(c.step))) && c.repos.every((x) => (!r.repos || r.repos.has(x)) && canWrite(r.login, x)) && itemsFit(r.items ?? null, c);

type IdleHelper = { login: string; role: string; tiers: ReadonlySet<string>; only: ReadonlySet<string> | null; skip: ReadonlySet<string>; items: ItemFilter };

/**
 * Whether a login other than the caller could take a call now: its helper's last claim found nothing within IDLE_FRESH_MS
 * and the login is not Manual only (manual-only.ts),
 * that claim covered the call's tier and repos, the login fits the role rules, its cached write permission covers every repo
 * and it authored no item of the call. A state check made at each claim; nothing waits on it. The idle helpers and their
 * permissions are read once per claim, on the first call that needs them.
 */
function idleOthers(db: Db, login: string, nowMs: number): (c: Cand) => Promise<boolean> {
  let idle: IdleHelper[] | null = null;
  // The cached write permissions of the idle logins, read in one query with the idle helpers.
  const writable = new Set<string>();
  const canWrite = (who: string, repo: string): boolean => writable.has(`${who.toLowerCase()}\n${repo}`);
  // The idle helpers that could take a call of this tier, prompt kind and repos, apart from authorship: calls share them.
  const takers = new Map<string, string[]>();
  return async (c) => {
    if (!idle) {
      idle = await mapSeq(await db.all(db.k.selectFrom("main.mcp_tokens as t").innerJoin("main.access as a", "a.login", "t.login").select(["t.login", "a.role", "t.idle_tiers", "t.idle_repos"])
          .where("t.kind", "=", "runner").where("t.expires_at", ">", new Date(nowMs).toISOString()).where("t.idle_claim_at", ">=", nowMs - IDLE_FRESH_MS)
          .where((eb) => eb.and([eb.not(ciEqExpr(db, "t.login", eb.val(login))), eb.not(manualExpr(db, eb, "t.login"))]))), async (o) => ({ login: o.login, role: o.role, tiers: new Set(o.idle_tiers ? JSON.parse(o.idle_tiers) as string[] : []), only: o.idle_repos ? new Set(JSON.parse(o.idle_repos) as string[]) : null, skip: await userSkips(db, o.login), items: await itemFilter(db, o.login) }));
      for (const p of await db.all(db.k.selectFrom("main.repo_permissions").select(["login", "repo", "permission", "checked_at"]).where(inList(db, "login", idle.map((o) => o.login), "citext"))))
        if (WRITE_PERMISSIONS.has(p.permission) && nowMs - Date.parse(p.checked_at) < PERM_READ_TTL) writable.add(`${p.login.toLowerCase()}\n${p.repo}`);
    }
    const key = `${c.tier}\n${c.prompt_id.startsWith("discord.")}\n${taskOfStep(c.step)}\n${c.repos.join("\n")}`;
    let logins = takers.get(key);
    if (!logins) {
      logins = idle.filter((o) => o.tiers.has(c.tier) && runnerTakes({ login: o.login, role: o.role, repos: o.only, skip: o.skip }, c, canWrite)).map((o) => o.login.toLowerCase());
      takers.set(key, logins);
    }
    // The key leaves the items out, so a runner that takes only some items is asked about this call's own.
    return logins.some((l) => !c.authors.has(l) && itemsFit(idle!.find((o) => o.login.toLowerCase() === l)?.items ?? null, c));
  };
}

/**
 * Who may take a call: a maintainer or operator with write permission on every repo of the call (which covers reading a
 * private one); discord.* calls and calls that name no repo go to operators only. An author or co-author of an item a judging
 * prompt judges is passed over only while another helper that could take the call is asking for work (idleOthers). A call
 * bound to a user (NewCall.forLogin) goes to that user alone, author or not.
 */
async function eligible(caller: Caller, c: Cand, canWrite: (repo: string) => Promise<boolean>, othersIdle: (c: Cand) => Promise<boolean>): Promise<boolean> {
  const ok = await mayTake(caller, c, canWrite, othersIdle);
  // The caller's own pick of a call it may no longer take ends: it would hold the call from every other user.
  if (!ok && c.pickedBy === caller.login.toLowerCase()) c.unpick?.();
  return ok;
}

async function mayTake(caller: Caller, c: Cand, canWrite: (repo: string) => Promise<boolean>, othersIdle: (c: Cand) => Promise<boolean>): Promise<boolean> {
  if (c.forLogin !== null && !sameLogin(c.forLogin, caller.login)) return false;
  if (!roleFits(caller.role, c)) return false;
  for (const repo of c.repos) if (!(await canWrite(repo))) return false;
  // A call bound to the caller is theirs whatever they authored: nobody else may take it.
  return c.forLogin !== null || !(judges(c.prompt_id) && c.authors.has(caller.login.toLowerCase()) && await othersIdle(c));
}

const HARNESSES: HarnessId[] = ["claude", "codex"];
const short = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/** The claim body, checked; throws HttpError 400 for a malformed one and 409 for a protocol version outside ACCEPTED_PROTOCOLS. */
export function parseClaim(raw: unknown): Claim {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "the body must be a Claim object");
  const c = raw as Record<string, unknown>;
  if (typeof c.protocol !== "number" || !ACCEPTED_PROTOCOLS.includes(c.protocol)) throw new HttpError(409, `this server speaks protocol ${ACCEPTED_PROTOCOLS.join(" or ")}; update the helper`);
  const protocol = c.protocol;
  if (!HARNESSES.includes(c.harness as HarnessId)) throw new HttpError(400, `harness must be one of ${HARNESSES.join(", ")}`);
  if (!short(c.helperVersion, 40) || !short(c.harnessVersion, 80)) throw new HttpError(400, "helperVersion and harnessVersion must be short strings");
  if (!c.tiers || typeof c.tiers !== "object" || Array.isArray(c.tiers)) throw new HttpError(400, "tiers must map a tier to a model");
  const tiers: Claim["tiers"] = {};
  for (const [t, m] of Object.entries(c.tiers as Record<string, unknown>)) {
    if (!isTier(t) || !short(m, 100)) throw new HttpError(400, `tier ${t}: a known tier with a model name`);
    tiers[t] = m;
  }
  let efforts: Claim["efforts"];
  if (c.efforts !== undefined) {
    if (!c.efforts || typeof c.efforts !== "object" || Array.isArray(c.efforts) || !Object.entries(c.efforts).every(([t, e]) => isTier(t) && isEffort(e))) throw new HttpError(400, "efforts must map a tier to an effort of the ladder low, medium, high, xhigh, max");
    efforts = c.efforts as Claim["efforts"];
  }
  if (c.repos !== undefined && (!Array.isArray(c.repos) || c.repos.length > 500 || !c.repos.every((x) => short(x, 100)))) throw new HttpError(400, "repos must be a list of repo names");
  if (c.sessions !== undefined && (!Array.isArray(c.sessions) || c.sessions.length > 500 || !c.sessions.every((x) => Number.isInteger(x)))) throw new HttpError(400, "sessions must be a list of call ids");
  if (c.root !== undefined && (typeof c.root !== "string" || !validRoot(c.root))) throw new HttpError(400, "root must be an absolute path of plain characters (letters, digits, . _ + @ -) without . or .. components");
  if (typeof c.requestId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(c.requestId)) throw new HttpError(400, "requestId must be 8 to 64 letters, digits, - or _");
  if (c.fastLane !== undefined && typeof c.fastLane !== "boolean") throw new HttpError(400, "fastLane must be a boolean");
  if (c.ownLane !== undefined && typeof c.ownLane !== "boolean") throw new HttpError(400, "ownLane must be a boolean");
  if (c.interactiveLane !== undefined && typeof c.interactiveLane !== "boolean") throw new HttpError(400, "interactiveLane must be a boolean");
  if (c.interactiveLane === true && (c.fastLane === true || c.ownLane === true || c.withOwnLane === true)) throw new HttpError(400, "interactiveLane excludes the other lanes");
  if (c.withOwnLane !== undefined && typeof c.withOwnLane !== "boolean") throw new HttpError(400, "withOwnLane must be a boolean");
  if (c.maxTimeoutSeconds !== undefined && (!Number.isInteger(c.maxTimeoutSeconds) || (c.maxTimeoutSeconds as number) < 1)) throw new HttpError(400, "maxTimeoutSeconds must be whole seconds, at least 1");
  // Protocol 3 helpers know no wait; a field they might send is not read.
  const wait = protocol >= 4 ? c.wait : undefined;
  if (wait !== undefined && (!Number.isInteger(wait) || (wait as number) < 0 || (wait as number) > 30)) throw new HttpError(400, "wait must be whole seconds from 0 to 30");
  return { requestId: c.requestId, ...(c.fastLane === true && { fastLane: true }), ...(c.ownLane === true && { ownLane: true }), ...(c.withOwnLane === true && { withOwnLane: true }), ...(c.interactiveLane === true && { interactiveLane: true }), ...(wait !== undefined && { wait: wait as number }), protocol, helperVersion: c.helperVersion, harness: c.harness as HarnessId, harnessVersion: c.harnessVersion, tiers, ...(efforts && { efforts }), ...(c.repos !== undefined && { repos: c.repos as string[] }), ...(c.sessions !== undefined && { sessions: c.sessions as number[] }), ...(c.root !== undefined && { root: c.root as string }), ...(c.maxTimeoutSeconds !== undefined && { maxTimeoutSeconds: c.maxTimeoutSeconds as number }) };
}

/** Whether dotted version `v` is older than `min` (numeric parts compared in order; a part that is not a number counts as 0). */
export function olderVersion(v: string, min: string): boolean {
  const a = v.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0), b = min.split(".").map((x) => Number(x));
  for (let i = 0; i < b.length; i++) if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) < b[i]!;
  return false;
}

/** One line for the lease: the prompt and its first item. */
function titleOf(promptId: string, refs: ItemRef[]): string {
  if (!refs.length) return promptId;
  return `${promptId} on ${refs[0]!.repo}#${refs[0]!.number}${refs.length > 1 ? ` (+${refs.length - 1})` : ""}`;
}

/**
 * The calls the login's helpers hold leases on now, all helpers together, that count toward its Max calls at once: a call its
 * own lane runs (Claim.ownLane, a call bound to the login) does not; one in a slot does (a bound call an older helper runs,
 * or one that runs in a slot, NewCall.boundSlot).
 */
export const leasedBy = async (db: Db, login: string): Promise<number> => Number((await db.get(leasedRow(db, login)))!.n);

/**
 * The login's leases as one value that changes whenever one of its helpers takes or ends a call: their count and the newest
 * lease time (a turnover that keeps the count brings a newer lease).
 */
export const leaseTurnover = async (db: Db, login: string): Promise<string> => {
  const r = (await db.get(db.k.selectFrom(indexedBy(db, "main.remote_calls", "remote_calls_leased", "c")).select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max<number | null>("c.leased_at").as("at")])
    .where((eb) => eb.and([eb("c.state", "=", literal("leased")), ciEqExpr(db, "c.user_login", eb.val(login))]))))!;
  return `${Number(r.n)}:${r.at ?? ""}`;
};

/** The own-lane leases the login holds (`login`: an expression of the login), from their own small partial index. */
export const ownLaneLeases = (db: Db, login: Ex) => db.k.selectFrom(indexedBy(db, "main.remote_calls", "remote_calls_leased_own", "bl")).select((e) => e.fn.countAll<number>().as("n"))
  .where("bl.state", "=", literal("leased")).where("bl.own_lane", "=", literal(1)).where(ciEqExpr(db, "bl.user_login", login));
/** The same for the leases of one helper credential (`tokenCol`: the outer query's mcp_tokens id column), for its free slots. */
export const ownLaneLeasesOfToken = (db: Db, tokenCol: string) => db.k.selectFrom(indexedBy(db, "main.remote_calls", "remote_calls_leased_own", "bt")).select((e) => e.fn.countAll<number>().as("n"))
  .where("bt.state", "=", literal("leased")).where("bt.own_lane", "=", literal(1)).where((eb) => eb(eb.ref("bt.token_id"), "=", ref<number>(tokenCol)));
/** The interactive-lane leases the login holds: own-lane leases of interactive calls (a maintainer's own-lane turns are not). */
export const interactiveLeased = async (db: Db, login: string): Promise<number> => Number((await db.get(db.k.selectFrom(indexedBy(db, "main.remote_calls", "remote_calls_leased_own", "il")).select((e) => e.fn.countAll<number>().as("n"))
  .where((eb) => eb.and([eb("il.state", "=", literal("leased")), eb("il.own_lane", "=", literal(1)), ciEqExpr(db, "il.user_login", eb.val(login)), eb.or(INTERACTIVE_PROMPTS.map((p) => eb("il.prompt_id", "like", `${p}%`)))]))))!.n);
const leasedRow = (db: Db, login: string) => db.k.selectFrom(indexedBy(db, "main.remote_calls", "remote_calls_leased", "c")).select((eb) => eb(eb.fn.countAll<number>(), "-", ownLaneLeases(db, eb.val(login))).as("n"))
  .where((eb) => eb.and([eb("c.state", "=", literal("leased")), ciEqExpr(db, "c.user_login", eb.val(login))]));

/** The role of a live Task Runner credential's user, or null when the credential is gone or expired. */
const runnerRoleRow = (db: Db, tokenId: number, nowMs: number) => db.k.selectFrom("main.mcp_tokens as t").innerJoin("main.access as a", "a.login", "t.login")
  .select(["a.role", "t.idle_claim_at"]).where("t.id", "=", tokenId).where("t.kind", "=", "runner").where("t.expires_at", ">", new Date(nowMs).toISOString());

/** Thrown in the lease transaction when the call was taken meanwhile: the run inserted for it goes with the rollback. */
class Taken extends Error {}

/**
 * Leases the call to the caller if it is still queued, bound to no other user and no other user's pick counts for it (a
 * Manual only caller: only its own pick, a call bound to it or a follow-up); the pick ends with the lease. The agent run starts now, on no account, with the user and
 * harness. With `cap`, only while the login holds fewer leases than that (checked in the same transaction, so parallel claims
 * of one user cannot pass it together); "limit" when it holds that many. `live` is asked inside the same transaction, just
 * before the lease is written: "gone" when no one waits for the reply any more, and nothing is written. With `clearIdle`, the
 * lease also marks the caller's credential busy (idle_claim_at). A call whose bundle lists the workspace server goes only to
 * the claude harness (null for another).
 */
async function leaseCall(db: Db, id: number, caller: Caller, claim: Claim, model: string, nowMs: number, cap: number | null, live: () => boolean, clearIdle: boolean, interactiveCap: number | null = null): Promise<Extract<ClaimReply, { lease: object }>["lease"] | "limit" | "gone" | null> {
  const secret = `${LEASE_PREFIX}${randomToken(32)}`;
  // The run's stored prompt is built before the write lock is taken: scrubbing and compressing a large prompt takes milliseconds.
  // What the run is made of changes on a call's row only here (a workspace session's resume note), so it is read with the
  // bundle and the run goes in before the lease.
  const q = await db.get(db.k.selectFrom("main.remote_calls").select(["bundle", "base_stdin", "job_id", "step", "stage", "prompt_id", "prompt_version", "asked_model", "items"]).where("id", "=", id).where("state", "=", "queued"));
  if (!q) return null;
  const bundle = JSON.parse(q.bundle) as Omit<TaskBundle, "callId">;
  // A workspace session runs only in Claude Code with its own tools off; another harness would keep a shell of its own.
  const workspace = bundle.mcpServers.includes(WORKSPACE_SERVER);
  if (workspace && claim.harness !== "claude") return null;
  // Its prompt tells a session after a lost lease that the workspace keeps the earlier session's work; stored with the lease.
  const base = q.base_stdin ?? bundle.stdin;
  const stdin = workspace ? await resumePrompt(db, id, base) : bundle.stdin;
  const rewritten = stdin !== bundle.stdin;
  bundle.stdin = stdin;
  const refs = JSON.parse(q.items) as ItemRef[];
  const prompt = packPrompt(joinParts(forHarness(bundle, claim.harness, claim.root ?? "")));
  try {
    // Under the login's lock, not the writer lock: the counts read here change only by this login's leases, and the lease is a
    // compare-and-set on the queued row, so two claims never lease one call; a claim never waits for a long write elsewhere.
    return await db.write(async () => {
      if (cap !== null && await leasedBy(db, caller.login) >= cap) return "limit";
      if (interactiveCap !== null && await interactiveLeased(db, caller.login) >= interactiveCap) return "limit";
      if (!live()) return "gone";
      const runId = await insertRun(db, { jobId: q.job_id, step: q.step, stage: q.stage, promptId: q.prompt_id, promptVersion: q.prompt_version, provider: "claude", model: q.asked_model, accountId: null, items: refs, prompt,
        remote: { userLogin: caller.login, harness: claim.harness, reportedModel: model } });
      const r = await db.get(db.k.updateTable("main.remote_calls").set((eb) => ({
        state: "leased", token_id: caller.tokenId, user_login: caller.login, harness: claim.harness, harness_version: claim.harnessVersion, model, root: claim.root ?? null, lease_secret_hash: sha256hex(secret),
        leased_at: nowMs, heartbeat_at: nowMs, started_at: null, claim_id: claim.requestId, run_id: runId, own_lane: claim.ownLane || interactiveCap !== null ? 1 : 0, ...(rewritten && { bundle: JSON.stringify(bundle), base_stdin: base }),
        queued_ms: eb("queued_ms", "+", eb.case().when("queued_since", "is", null).then(eb.lit(0)).else(greatest(db, [eb.lit(0), eb(eb.val(nowMs), "-", eb.ref("queued_since"))])).end()), queued_since: null, progress: null, error: null,
        picked_by: null, picked_at: null, pick_until: null, no_taker_since: null,
      })).where("id", "=", id).where("state", "=", "queued")
        .where((eb) => eb.or([eb("picked_by", "is", null), eb("picked_by", "=", caller.login), pickLapsedExpr(db, eb, nowMs)]))
        // The runner whose model declined the call does not take it again (another process's queue cache may still offer it).
        .where((eb) => eb.or([eb("refused_token", "is", null), eb("refused_token", "!=", caller.tokenId)]))
        // Only the user a call is bound to takes it. A Manual only caller takes only follow-ups, its own picks and calls bound to it.
        .where((eb) => eb.or([eb("for_login", "is", null), eb("for_login", "=", caller.login)]))
        .where((eb) => eb.or([eb.not(manualExpr(db, eb, eb.val(caller.login))), eb("parent_id", "is not", null), eb("picked_by", "=", caller.login), eb("for_login", "=", caller.login)]))
        .where((eb) => eb.exists(db.k.selectFrom("main.mcp_tokens as lt").select(eb.lit(1).as("one")).where("lt.id", "=", caller.tokenId).where("lt.kind", "=", "runner").where("lt.expires_at", ">", new Date(nowMs).toISOString())))
        .returning("id"));
      if (!r) throw new Taken();
      // The fast lane says nothing about the helper's other slots: only their claims mark it idle or busy.
      if (clearIdle) await db.run(db.k.updateTable("main.mcp_tokens").set({ idle_claim_at: null }).where("id", "=", caller.tokenId));
      return { id, secret, title: titleOf(q.prompt_id, refs), requiredHelper: REQUIRED_HELPER };
    }, { lock: `remote-lease:${caller.login.toLowerCase()}` });
  } catch (e) {
    if (e instanceof Taken) return null;
    throw e;
  }
}

/**
 * How long claims reuse the queued calls in queue order (queueOrder) before reading them again. The order, small-tier aging
 * across classes (claimClass) included, is taken when the cache is built, so it is at most this old.
 */
export const QUEUE_CACHE_MS = 2_000;
type QueueCache = { at: number; sig: string; followUps: Cand[]; ordered: Cand[] };
const queueCaches = new WeakMap<Db, QueueCache>();
/** The parsed items, repos, authors, bound login and time limit of each queued call by id: they never change, so a rebuild reads them only for new calls. */
type Parsed = Pick<Cand, "refs" | "repos" | "authors" | "forLogin" | "boundSlot" | "refusedToken" | "timeoutMs">;
const parsedCalls = new WeakMap<Db, Map<number, Parsed>>();
/** Drops the cached queue order: a call was queued or leased by this process. Other processes' changes show in the signature (count and newest id of the queued calls) or within QUEUE_CACHE_MS. */
export const dropQueueCache = (db: Db): void => void queueCaches.delete(db);
/** The signature of the queued calls as queuedCalls reads it from the table: their count and newest id. */
const queueSig = (n: number, m: number | null): string => `${n}:${m}`;
/**
 * Takes a call this process just leased out of the cached queue order, so a burst of claims does not rebuild the order
 * after every lease; the signature follows, so the cache stays valid while no other process changed the queue.
 */
function takeFromQueueCache(db: Db, id: number): void {
  const c = queueCaches.get(db);
  if (!c) return;
  // New arrays, not splices: another claim may be walking the old ones across its awaits (claimOrder), and a splice
  // would shift an element past its loop index.
  const followUps = c.followUps.filter((r) => r.id !== id), ordered = c.ordered.filter((r) => r.id !== id);
  if (followUps.length === c.followUps.length && ordered.length === c.ordered.length) return dropQueueCache(db);
  c.followUps = followUps;
  c.ordered = ordered;
  let m: number | null = null;
  for (const r of c.followUps) if (m === null || r.id > m) m = r.id;
  for (const r of c.ordered) if (m === null || r.id > m) m = r.id;
  c.sig = queueSig(c.followUps.length + c.ordered.length, m);
}

/** The count and newest id of the queued calls: the queue cache's signature (queueSig). */
const queueSigRow = (db: Db) => db.k.selectFrom("main.remote_calls").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max<number | null>("id").as("m")]).where("state", "=", "queued");

/** Every queued call, read once per QUEUE_CACHE_MS: follow-ups by age, the rest in queue order. Callers filter it and must not change it; only takeFromQueueCache replaces its arrays. */
async function queuedCalls(db: Db, nowMs: number, sigRow?: { n: number; m: number | null }): Promise<QueueCache> {
  const q = sigRow ?? (await db.get(queueSigRow(db)))!;
  const sig = queueSig(Number(q.n), q.m === null ? null : Number(q.m));
  const hit = queueCaches.get(db);
  if (hit && hit.sig === sig && nowMs >= hit.at && nowMs - hit.at < QUEUE_CACHE_MS) return hit;
  const known = parsedCalls.get(db) ?? new Map<number, Parsed>(), seen = new Map<number, Parsed>();
  // Calls newer than every parsed one bring their items and authors with the rows; the running counts are read at the same time.
  let newest = -1;
  for (const id of known.keys()) if (id > newest) newest = id;
  const running = runningCounts(db, nowMs);
  void running.catch(() => {});
  const queued = await db.all(db.k.selectFrom(indexedBy(db, "main.remote_calls", "remote_calls_waiting", "c"))
    .select(["id", "class as cls", "level", "step", "repo", "since", "seen_at", "prompt_id", "tier", "parent_id", "sticky_login", "released_by", "released_at", "picked_by", "picked_at", "pick_until",
      (eb) => eb("id", ">", newest).as("inline"), (eb) => eb.case().when("id", ">", newest).then(eb.ref("items")).end().as("items"),
      (eb) => eb.case().when("id", ">", newest).then(eb.ref("authors")).end().as("authors"), (eb) => eb.case().when("id", ">", newest).then(eb.ref("for_login")).end().as("for_login"),
      (eb) => eb.case().when("id", ">", newest).then(eb.ref("bound_slot")).end().as("bound_slot"), (eb) => eb.case().when("id", ">", newest).then(eb.ref("timeout_ms")).end().as("timeout_ms")])
    .where("state", "=", literal("queued")).$narrowType<{ tier: Tier }>());
  // The items and authors of older calls not parsed yet (a requeued lease), in one read.
  const fresh = queued.filter((r) => !known.has(Number(r.id)) && !r.inline).map((r) => Number(r.id));
  // A new call has no refused_token yet: only a requeued one, read here, can have one.
  const texts = new Map<number, { items: string | null; authors: string | null; for_login: string | null; bound_slot: number | null; timeout_ms: number | null; refused_token?: number | null }>(queued.filter((r) => r.inline).map((r) => [Number(r.id), r]));
  if (fresh.length) for (const x of await db.all(db.k.selectFrom("main.remote_calls").select(["id", "items", "authors", "for_login", "bound_slot", "timeout_ms", "refused_token"]).where(inList(db, "id", fresh, "bigint")))) texts.set(Number(x.id), x);
  const rows = await mapSeq(queued, async (r): Promise<Cand> => {
    const id = Number(r.id);
    let p = known.get(id);
    if (!p) {
      const x = texts.get(id)!;
      const refs = JSON.parse(x.items!) as ItemRef[];
      // Calls queued before authors were stored on the row are read now.
      const authors = x.authors !== null ? JSON.parse(x.authors) as string[] : judges(r.prompt_id) ? await authorsOf(db, refs) : [];
      p = { refs, repos: [...new Set([...refs.map((i) => i.repo), ...(r.repo ? [r.repo] : [])])], authors: new Set(authors), forLogin: x.for_login?.toLowerCase() ?? null, boundSlot: Number(x.bound_slot) === 1,
        refusedToken: x.refused_token == null ? null : Number(x.refused_token), timeoutMs: Number(x.timeout_ms) };
    }
    seen.set(id, p);
    return {
      id, cls: r.cls, level: r.level, step: r.step, repo: r.repo, since: r.since, seen_at: r.seen_at, prompt_id: r.prompt_id, tier: r.tier, parent_id: r.parent_id, sticky_login: r.sticky_login,
      ...p, releasedBy: r.released_by?.toLowerCase() ?? null, releasedAt: r.released_at,
      pickedBy: r.picked_by?.toLowerCase() ?? null, pickedAt: r.picked_at, pickUntil: r.pick_until,
      ...(r.picked_by !== null && { unpick: async () => void await clearPick(db, id) }),
    };
  });
  parsedCalls.set(db, seen);
  const c: QueueCache = {
    at: nowMs, sig,
    followUps: rows.filter((r) => r.parent_id !== null).sort((a, b) => a.since - b.since || a.id - b.id),
    ordered: sortQueue(rows.filter((r) => r.parent_id === null), await running, nowMs, (r) => claimClass(r, nowMs)),
  };
  queueCaches.set(db, c);
  return c;
}

/** Every queued call in queue order (follow-ups first), as claims read it: for the queue view (queue-view.ts). Read only. */
export async function queueSnapshot(db: Db, nowMs: number): Promise<readonly Readonly<Cand>[]> {
  const q = await queuedCalls(db, nowMs);
  return [...q.followUps, ...q.ordered];
}

type OrderReads = { q: QueueCache; manual: boolean; skip: Set<string>; items: ItemFilter };

/** What claimOrder reads, all at once: the queued calls and the user's Manual only switch, skipped tasks and item filter. */
const orderReads = async (db: Db, login: string, nowMs: number): Promise<OrderReads> => {
  const [q, manual, skip, items] = await Promise.all([queuedCalls(db, nowMs), manualOnly(db, login), userSkips(db, login), itemFilter(db, login)]);
  return { q, manual, skip, items };
};

/**
 * The queued calls a claim could take in the order it takes them, before eligibility: follow-up turns of the sessions its
 * helper holds first, then the user's own live picks (picks.ts) oldest first, then the model queue's order with gating and
 * long-waiting small calls raised (claimClass) and without other users' live picks, filtered by tiers and repos (claimRepos:
 * every repo a call names must be in the set; picks do not go by it); the queue's order also by the user's tasks
 * (my-tasks.ts) and items (task-items.ts), which picks and follow-ups do not go by. Calls bound to the caller (NewCall.forLogin)
 * come after its follow-ups, like picks; calls bound to another user are not offered. `bound` says where the caller's bound
 * calls and their follow-ups go: an own-lane claim (Claim.ownLane) gets only them ("only"), the slots of a Task Runner that has
 * an own lane (Claim.withOwnLane) none of them ("without"), and other Task Runners' slots take them with the rest ("with": older
 * ones, and a harness that runs one call at a time). Bound calls that run in a slot (NewCall.boundSlot) and their follow-ups
 * go with the slots' calls: never to the own lane, and to the slots of a Task Runner that has one. A fast-lane claim gets only what fastLaneFits. A Manual
 * only user (manual-only.ts) gets no calls from the queue's order. The caller's pick of a call it released or whose role
 * rules it no longer fits ends here; one it may not take for another reason ends in eligible.
 */
async function claimOrder(db: Db, caller: Caller, tiers: ReadonlySet<Tier>, repos: ReadonlySet<string> | null, sessionIds: readonly number[], nowMs: number, fastLane = false, reads?: OrderReads, bound: BoundCalls = "with", lane: InteractiveMode = "off"): Promise<Cand[]> {
  const all = await claimOrderAll(db, caller, tiers, repos, sessionIds, nowMs, fastLane, reads, bound);
  return lane === "legacy" ? all : all.filter((r) => interactive(r) === (lane === "lane"));
}
async function claimOrderAll(db: Db, caller: Caller, tiers: ReadonlySet<Tier>, repos: ReadonlySet<string> | null, sessionIds: readonly number[], nowMs: number, fastLane = false, reads?: OrderReads, bound: BoundCalls = "with"): Promise<Cand[]> {
  const { q, manual, skip, items } = reads ?? await orderReads(db, caller.login, nowMs);
  const login = caller.login.toLowerCase();
  const live = (r: Cand): boolean => r.seen_at >= nowMs - CALLER_STALE_MS;
  const released = (r: Cand): boolean => r.refusedToken === caller.tokenId || (r.releasedBy === login && r.releasedAt !== null && r.releasedAt >= nowMs - RELEASE_SKIP_MS);
  const fits = (r: Cand): boolean => live(r) && !released(r) && tiers.has(r.tier) && (!repos || r.repos.every((x) => repos.has(x)));
  const sessions = new Set(sessionIds);
  const allFollowUps = q.followUps.filter((r) => sessions.has(r.parent_id!) && sameLogin(r.sticky_login, caller.login) && fits(r));
  // Calls bound to the caller (a maintainer's own conversation turn) next, oldest first: like picks, they go by no repo, task or item choice.
  const own = q.ordered.filter((r) => r.forLogin === login && live(r) && !released(r) && tiers.has(r.tier) && (!fastLane || fastLaneFits(r)));
  if (bound === "only") return [...allFollowUps.filter((r) => r.forLogin === login && !r.boundSlot), ...own.filter((r) => !r.boundSlot)];
  const followUps = bound === "without" ? allFollowUps.filter((r) => r.forLogin === null || r.boundSlot) : allFollowUps;
  const ownHere = bound === "with" ? own : own.filter((r) => r.boundSlot);
  let fresh: Set<string> | null = null;
  // The caller's own picks count for it; whether other pickers can take theirs is read once, when a pick needs it.
  const counts = async (r: Cand): Promise<boolean> => await pickCounts(r, nowMs, async (who) => who === login || (fresh ??= await pickerLogins(db, nowMs)).has(who));
  const mine: Cand[] = [];
  for (const r of q.ordered) {
    if (r.forLogin !== null || r.pickedBy !== login || !await counts(r)) continue;
    if (released(r) || !roleFits(caller.role, r)) await clearPick(db, r.id);
    else if (live(r) && tiers.has(r.tier) && (!fastLane || fastLaneFits(r))) mine.push(r);
  }
  mine.sort((a, b) => a.pickedAt! - b.pickedAt! || a.id - b.id);
  if (manual) return [...followUps, ...ownHere, ...mine];
  return [...followUps, ...ownHere, ...mine, ...await filterSeq(q.ordered, async (r) => r.forLogin === null && fits(r) && !skip.has(taskOfStep(r.step)) && itemsFit(items, r) && !(r.pickedBy !== null && await counts(r)) && (!fastLane || fastLaneFits(r)))];
}

// ---- picks ("Run on my Task Runner", picks.ts) ----------------------------------------

const pickerArgs = (nowMs: number): [string, number, number] => [new Date(nowMs).toISOString(), nowMs - STATUS_FRESH_MS, nowMs];

/**
 * The login in `login` can take its picks at `nowMs`, so they count. It has a fresh Task Runner (last status within
 * STATUS_FRESH_MS), is not cooling off (cooloff.ts) and holds fewer leases than its "Max calls at once" (max-calls.ts); a
 * picker who cannot take a call does not hold it away from other runners.
 */
function pickerExpr(db: Db, eb: Eb, login: Ex, nowMs: number): AliasableExpression<SqlBool> {
  const [expires, fresh, now] = pickerArgs(nowMs);
  const max = eb.cast<number>(eb.case().when("ps.key", "=", MAX_CALLS_KEY).then(eb.ref("ps.value")).end(), "bigint");
  const leased = db.k.selectFrom(indexedBy(db, "main.remote_calls", "remote_calls_leased", "pl")).select((e) => e(e.fn.countAll<number>(), "-", ownLaneLeases(db, login)).as("n"))
    .where("pl.state", "=", literal("leased")).where(ciEqExpr(db, "pl.user_login", login));
  return eb.and([
    eb.exists(db.k.selectFrom("main.remote_helpers as ph").innerJoin("main.mcp_tokens as pt", "pt.id", "ph.token_id").select(eb.lit(1).as("one"))
      .where("ph.login", "=", ref<string>(login)).where("pt.kind", "=", "runner").where("pt.expires_at", ">", expires).where("ph.reported_at", ">=", fresh)),
    eb.not(eb.exists(db.k.selectFrom("main.remote_cooloffs as pc").select(eb.lit(1).as("one")).where("pc.login", "=", ref<string>(login)).where("pc.until", ">", now))),
    eb.not(eb.exists(db.k.selectFrom("main.user_settings as ps").select(eb.lit(1).as("one"))
      .where("ps.login", "=", ref<string>(login)).where("ps.key", "=", MAX_CALLS_KEY)
      .where(eb.between(max, 1, MAX_CALLS_MAX)).where(eb(leased, ">=", max)))),
  ]);
}

/** On a remote_calls row that has a pick: the pick no longer counts at `nowMs`, as its time is up or its picker cannot take it now (pickerExpr). */
export const pickLapsedExpr = (db: Db, eb: Eb, nowMs: number): AliasableExpression<SqlBool> =>
  eb.or([eb("pick_until", "<", nowMs), eb.not(pickerExpr(db, eb, "remote_calls.picked_by", nowMs))]);

/** The logins (lowercase) whose picks count now (pickerExpr). */
export async function pickerLogins(db: Db, nowMs: number): Promise<Set<string>> {
  const rows = await db.all(db.k.selectFrom("main.remote_helpers as h").select((eb) => eb.fn<string>("lower", ["h.login"]).as("login")).distinct().where((eb) => pickerExpr(db, eb, "h.login", nowMs)));
  return new Set(rows.map((r) => r.login));
}

/** Whether a queued call's pick counts now: it has one, its time is not up (no time: until it ends) and its picker can take it (`fresh`: pickerLogins). */
export const pickCounts = async (r: { pickedBy: string | null; pickUntil: number | null }, nowMs: number, fresh: (login: string) => Promise<boolean>): Promise<boolean> =>
  r.pickedBy !== null && (r.pickUntil === null || r.pickUntil >= nowMs) && await fresh(r.pickedBy.toLowerCase());

/** Ends a queued call's pick (only `login`'s, when given); true when one ended. */
export async function clearPick(db: Db, id: number, login?: string): Promise<boolean> {
  const r = login === undefined
    ? await db.run(db.k.updateTable("main.remote_calls").set({ picked_by: null, picked_at: null, pick_until: null }).where("id", "=", id).where("picked_by", "is not", null))
    : await db.run(db.k.updateTable("main.remote_calls").set({ picked_by: null, picked_at: null, pick_until: null }).where("id", "=", id).where("picked_by", "=", login));
  if (Number(r.changes) !== 1) return false;
  dropQueueCache(db);
  return true;
}

/** Memoises the caller's write permission per repo; a failed lookup counts as no permission. */
const memoWrite = (canWrite: (repo: string) => Promise<boolean>): ((repo: string) => Promise<boolean>) => {
  const memo = new Map<string, Promise<boolean>>();
  return (repo) => {
    let p = memo.get(repo);
    if (!p) memo.set(repo, (p = canWrite(repo).catch(() => false)));
    return p;
  };
};

/** How many queued calls the caller could claim now (same filters and eligibility as claimCall, nothing is leased), for a session's next_task. Follow-ups of a helper's own sessions are not counted. */
export async function claimableCalls(db: Db, caller: Caller, opts: { tiers?: readonly Tier[]; models?: Partial<Record<Tier, string>> }, canWrite: (repo: string) => Promise<boolean>, nowMs: number = Date.now()): Promise<number> {
  await expireLeases(db, nowMs);
  if (await cooloffOf(db, caller.login, nowMs) !== null) return 0;
  const max = await userMaxCalls(db, caller.login);
  if (max !== null && await leasedBy(db, caller.login) >= max) return 0;
  const accepted = await acceptedModels(db);
  // A tier counts when the model the helper would use for it is of an accepted family; without a model, when the tier accepts any.
  const tiers = new Set((opts.tiers ?? TIERS).filter((t) => accepted[t].length > 0 && (opts.models?.[t] === undefined || familyOf(opts.models[t]!, accepted[t]) !== null)));
  const can = memoWrite(canWrite), others = idleOthers(db, caller.login, nowMs);
  let n = 0;
  for (const r of await claimOrder(db, caller, tiers, await claimRepos(db, caller.login, undefined), [], nowMs)) if (await eligible(caller, r, can, others)) n++;
  return n;
}

/** The state of a call this login holds or held (by its lease id); null for an unknown call and for another login's. */
export async function callStatus(db: Db, id: number, login: string): Promise<{ id: number; state: Row["state"]; error: string | null; title: string } | null> {
  const r = await db.get(db.k.selectFrom("main.remote_calls").select(["id", "state", "error", "prompt_id", "items", "user_login"]).where("id", "=", id).$narrowType<{ state: Row["state"] }>());
  if (!r || !sameLogin(r.user_login, login)) return null;
  return { id: Number(r.id), state: r.state, error: r.error, title: titleOf(r.prompt_id, JSON.parse(r.items) as ItemRef[]) };
}

/**
 * Claim replies by agent token and request id, for CLAIM_ID_TTL_S: a repeated claim (its reply was lost) gets the same reply,
 * the same lease with the same secret included. Kept in the memory of the dashboard process, the only one that serves
 * claims, so the secret is never stored; the promise is kept from the start, so a repeat that arrives while the first is
 * still being answered waits for it.
 */
const claimReplies = new Map<string, { at: number; reply: Promise<ClaimReply>; ticket?: Ticket }>();

/**
 * Gives the caller the first queued call it may take (claimOrder), filtered by eligibility. `canWrite` reads the caller's live
 * write permission on a repo. The reply carries the user's reserve either way. A claim repeated with the same request id
 * gets the first one's reply. While the login's leases are at the user's "Max calls at once" (max-calls.ts), only a follow-up
 * of its own sessions is leased, one past the limit at most, so a session can finish; otherwise the reply says why.
 * With `hold`, a protocol 4 claim that finds nothing and has no reason to give waits for a call up to its `wait` (claim-wait.ts).
 */
export function claimCall(db: Db, caller: Caller, claim: Claim, canWrite: (repo: string) => Promise<boolean>, nowMs: number = Date.now(), hold?: Hold, o: ClaimOptions = {}): Promise<ClaimReply> {
  // Entries are in claim order, so the expired ones come first.
  for (const [k, v] of claimReplies) { if (v.at >= nowMs - scaled(CLAIM_ID_TTL_S * 1000)) break; claimReplies.delete(k); }
  const key = `${caller.tokenId}:${claim.requestId}`;
  const seen = claimReplies.get(key);
  if (seen) {
    if (hold) seen.ticket?.attach(hold.signal);
    return seen.reply;
  }
  // Protocol 3 helpers send no wait (parseClaim); their claims are answered at once.
  const ms = hold && claim.protocol >= 4 ? holdMs(claim.wait) : 0;
  const ticket = hold && ms > 0 ? new Ticket(hold.signal) : undefined;
  // An own-lane claim's reply says the lane was honoured: a server without it ignores the field and would offer any call.
  const reply = claimNew(db, caller, claim, canWrite, nowMs, hold && ticket ? { ...hold, ms, ticket } : undefined, o).then(async (r): Promise<ClaimReply> => (claim.interactiveLane ? { ...r, interactiveSlots: await userInteractiveSlots(db, caller.login, caller.role) } : claim.ownLane ? { ...r, ownLane: true } : r));
  claimReplies.set(key, { at: nowMs, reply, ticket });
  reply.catch(() => { if (claimReplies.get(key)?.reply === reply) claimReplies.delete(key); });
  // Every request for a held claim left before its reply: a retry with the same id claims afresh. A lease already given stays
  // remembered, so the retry gets it.
  if (ticket) ticket.onGone = () => void reply.then((r) => { if (!r.lease && claimReplies.get(key)?.reply === reply) claimReplies.delete(key); }, () => {});
  return reply;
}

/**
 * How a claim may wait (claim-wait.ts): `signal` aborts when the request's connection closes before its reply; `blocked` says
 * the claim has a reason to give outside its tries (a write permission GitHub could not confirm), so it is answered at once.
 * `waits.closed` (shutting down) answers at once too.
 */
export type Hold = { waits: ClaimWaits; signal: AbortSignal; blocked: () => boolean };

/** `userLocalOnly`: in the server mode the claim takes nothing and says when to ask again (the claim route), read with the claim's first reads. */
export type ClaimOptions = { userLocalOnly?: boolean };

async function claimNew(db: Db, caller: Caller, claim: Claim, canWrite: (repo: string) => Promise<boolean>, nowMs: number, hold: (Hold & { ms: number; ticket: Ticket }) | undefined, o: ClaimOptions): Promise<ClaimReply> {
  const c = await prepareClaim(db, caller, claim, canWrite, nowMs, o);
  if ("reply" in c) return c.reply;
  const live = hold ? () => !hold.ticket.gone && !hold.waits.closed : () => true;
  const first = await c.attempt(nowMs, { quick: false, live });
  if (first) return first;
  await c.idle(nowMs);
  if (!hold || hold.waits.closed || hold.ticket.gone || hold.blocked()) return await c.empty(nowMs, false);
  return hold.waits.hold(hold.ticket, nowMs + hold.ms, { ...c, blocked: hold.blocked });
}

type TryReads = {
  role: Role | null; idle: boolean; cooled: { until: number; reason: string } | null; accepted: Record<Tier, string[]>; floors: Partial<Record<Tier, Effort>>;
  repos: ReadonlySet<string> | null; max: number | null; leased: number; reserve: Reserve; mode: InferenceMode; order: OrderReads;
};

/** The user settings a claim try reads. */
const CLAIM_USER_KEYS = [REPOS_KEY, MAX_CALLS_KEY, RESERVE_KEYS.fiveHour, RESERVE_KEYS.weekly, MANUAL_ONLY_KEY, SKIP_TASKS_KEY, TASK_ITEMS_KEY] as const;

/** A claim try's single-row reads, with the first try's orphan and liveness stamp (`requestId`), as one statement and one settings read. */
type ClaimRow = Omit<TryReads, "repos" | "order"> & { picks: string[]; sig: { n: number; m: number | null }; user: Map<string, string>; orphan?: { id: number; run_id: number | null; lease_secret_hash: string | null } | undefined; alive?: { alive: boolean; since: number } };

async function claimRow(db: Db, caller: Caller, now: number, requestId?: string): Promise<ClaimRow> {
  const user = (key: string) => db.k.selectFrom("main.user_settings").select("value").where("login", "=", caller.login).where("key", "=", key);
  const first = requestId !== undefined ? [orphanRow(db, caller.tokenId, requestId), livenessRow(db)] : [];
  const [v, set] = await Promise.all([
    rowValues(db, [runnerRoleRow(db, caller.tokenId, now), cooloffRow(db, caller.login), leasedRow(db, caller.login), queueSigRow(db), ...CLAIM_USER_KEYS.map(user), ...first]),
    settings(db, [REMOTE_MODELS_KEY, INFERENCE_KEY]),
  ]);
  const [role, cool, leased, sig] = v as [[Role, number | null] | [], [number | null, string | null] | [], [number], [number, number | null]];
  const us = new Map(CLAIM_USER_KEYS.flatMap((k, i) => { const x = v[4 + i]![0]; return typeof x === "string" ? [[k, x] as const] : []; }));
  const at = 4 + CLAIM_USER_KEYS.length;
  const orphan = v[at] as [number, number | null, string | null] | [] | undefined, live = v[at + 1] as [number, number] | [] | undefined;
  return {
    role: role[0] ?? null, idle: role.length > 0 && role[1] !== null,
    cooled: cooledOf(cool.length ? { until: cool[0], reason: cool[1] } : undefined, now),
    ...modelsOf(set.get(REMOTE_MODELS_KEY)), mode: modeOf(set.get(INFERENCE_KEY)),
    picks: reposOf(us.get(REPOS_KEY)), max: maxCallsOf(us.get(MAX_CALLS_KEY)), leased: Number(leased[0]),
    reserve: reserveOf([RESERVE_KEYS.fiveHour, RESERVE_KEYS.weekly].flatMap((key) => { const value = us.get(key); return value !== undefined ? [{ key, value }] : []; })),
    sig: { n: Number(sig[0]), m: sig[1] === null ? null : Number(sig[1]) }, user: us,
    ...(requestId !== undefined && {
      orphan: orphan?.length ? { id: Number(orphan[0]), run_id: orphan[1], lease_secret_hash: orphan[2] } : undefined,
      alive: aliveOf(live?.length ? { alive_at: live[0], since: live[1] } : undefined, now),
    }),
  };
}

/** The rest of a full claim try, after its row: the queued calls and the item filter, at the same time; nothing here writes. */
async function tryReadsOf(db: Db, caller: Caller, helperRepos: readonly string[] | undefined, now: number, r: ClaimRow): Promise<TryReads> {
  const [q, items] = await Promise.all([queuedCalls(db, now, r.sig), itemFilterOf(db, caller.login, taskItemsOf(r.user.get(TASK_ITEMS_KEY)))]);
  const { picks, sig: _s, user, orphan: _o, alive: _a, ...rest } = r;
  return { ...rest, repos: claimReposOf(picks, helperRepos), order: { q, manual: manualOf(user.get(MANUAL_ONLY_KEY)), skip: skipsOf(user.get(SKIP_TASKS_KEY)), items } };
}

/** What a full claim try reads; nothing here writes. */
const tryReads = async (db: Db, caller: Caller, helperRepos: readonly string[] | undefined, now: number): Promise<TryReads> =>
  await tryReadsOf(db, caller, helperRepos, now, await claimRow(db, caller, now));

/** The lease a repeated claim took, while it is live: the claim was answered before a restart (prepareClaim). */
const orphanRow = (db: Db, tokenId: number, requestId: string) =>
  db.k.selectFrom("main.remote_calls").select(["id", "run_id", "lease_secret_hash"]).where("token_id", "=", tokenId).where("claim_id", "=", requestId).where("state", "=", "leased");

/**
 * The once-per-claim part of a claim: the helper's version, and a lease of a repeated claim the dashboard no longer remembers.
 * Returns a reply when the claim is answered here, else its tries: `attempt` re-reads the cool-off, the accepted models, the
 * repos and the user's max calls at once each time, and gives null when there is nothing to take and no reason to give.
 */
async function prepareClaim(db: Db, caller: Caller, claim: Claim, canWrite: (repo: string) => Promise<boolean>, nowMs: number, o: ClaimOptions):
  Promise<{ reply: ClaimReply } | { attempt: ClaimTry; idle: (nowMs: number) => Promise<void>; empty: (nowMs: number, held: boolean) => Promise<EmptyReply> }> {
  const older = (): HttpError => new HttpError(409, `helper ${claim.helperVersion} is older than ${REQUIRED_HELPER}, the oldest this server accepts; download the current helper from ${ROUTES.helper}`);
  // The server mode's answer comes first, whatever the helper's version.
  if (!o.userLocalOnly && olderVersion(claim.helperVersion, REQUIRED_HELPER)) throw older();
  // One statement reads the first try's single rows with the repeat's orphan lease and the liveness stamp the expiry needs. A repeat
  // the dashboard no longer remembers (it restarted in between): the lease the first claim took cannot be given out again, as only
  // its secret's hash is stored, so it goes back to the queue unused and this claim is answered afresh.
  const row = claimRow(db, caller, nowMs, claim.requestId);
  const served = (r: ClaimRow): boolean => !o.userLocalOnly || r.mode === "user-local";
  // The rest of the first full try's reads run with the expiry's; when the orphan or the expiry wrote, they are read again.
  const firstReads = row.then((r) => (served(r) ? tryReadsOf(db, caller, claim.repos, nowMs, r) : null));
  // Awaited by the first try when used; a failure of reads that are not used is not left unhandled.
  void firstReads.catch(() => {});
  const [first, expiry] = await Promise.all([row, readExpiry(db, nowMs, undefined, row.then((r) => r.alive!))]);
  // In the server mode no call is queued for helpers: nothing to take for a while.
  if (!served(first)) return { reply: { lease: null, retryAfter: 300, reserve: first.reserve } };
  if (olderVersion(claim.helperVersion, REQUIRED_HELPER)) throw older();
  const orphan = first.orphan;
  if (orphan) {
    await unlease(db, { id: Number(orphan.id), runId: orphan.run_id, hash: orphan.lease_secret_hash }, "returned to the queue: the claim that leased it was repeated after a server restart", nowMs);
    await expireLeases(db, nowMs);
  } else await applyExpiry(db, expiry, nowMs);
  let pending: Promise<TryReads | null> | null = orphan || expiry.lost.length || expiry.gone.length ? null : firstReads;
  if (!pending) {
    // The queue those reads cached may predate the writes, under the same count and newest id.
    await firstReads.catch(() => {});
    dropQueueCache(db);
  }
  const fast = claim.fastLane === true, own = claim.ownLane === true, lane = claim.interactiveLane === true;
  const mode: InteractiveMode = lane ? "lane" : olderVersion(claim.helperVersion, INTERACTIVE_HELPER) ? "legacy" : "off";
  const bound: BoundCalls = own ? "only" : claim.withOwnLane === true ? "without" : "with";
  // What the latest full try took, for a quick try's look at the queue.
  let tiers = new Set<Tier>(), repos: ReadonlySet<string> | null = null;
  // The user's reserve as the latest full try read it, and when.
  let last: { at: number; reserve: Reserve } | null = null;
  // Calls the latest try could have taken but for their time limit (Claim.maxTimeoutSeconds): the claim then counts as no
  // idle helper's, so other runners do not pass over those calls for it, and its empty reply says why.
  let tooLong = 0;
  const attempt: ClaimTry = async (now, { quick, live }) => {
    // A quick try with nothing to take changes nothing; the full tries, at least every RETRY_MS, check the credential as well.
    if (quick && !(await claimOrder(db, caller, tiers, repos, claim.sessions ?? [], now, fast, undefined, bound, mode)).length) return null;
    tooLong = 0;
    const x = (now === nowMs && pending ? await pending : null) ?? await tryReads(db, caller, claim.repos, now);
    pending = null;
    last = { at: now, reserve: x.reserve };
    // A held claim outlives the route's credential check: a credential removed, expired or demoted meanwhile ends the hold untaken.
    if (x.role !== caller.role) return { lease: null, retryAfter: CLAIM_RETRY_S, reason: "this Task Runner credential was removed or its user's role changed", reserve: x.reserve };
    const cooled = x.cooled;
    if (cooled) return { lease: null, retryAfter: Math.ceil((cooled.until - now) / 1000), reason: cooled.reason, until: cooled.until, reserve: x.reserve };
    const { accepted, floors } = x;
    tiers = new Set((Object.keys(claim.tiers) as Tier[]).filter((t) => familyOf(claim.tiers[t]!, accepted[t]) !== null && meetsEffort(claim.efforts?.[t], floors[t], claim.harness)));
    if (!tiers.size) throw new HttpError(400, `no tier of the claim has an accepted model at the minimum effort; accepted: ${(Object.keys(accepted) as Tier[]).map((t) => `${t} ${accepted[t].join("/")}${floors[t] ? ` at effort ${floors[t]} or higher` : ""}`).join(", ")}`);
    const can = memoWrite(canWrite), others = idleOthers(db, caller.login, now);
    repos = x.repos;
    const max = x.max;
    // An interactive-lane claim is bounded by the user's Interactive slots alone; Max calls at once and the pipeline slots do not apply to it.
    const slots = lane ? await userInteractiveSlots(db, caller.login, caller.role) : null;
    if (lane && !slots) return { lease: null, retryAfter: CLAIM_RETRY_S, reason: "your Interactive slots are 0 (Connect page, My settings)", reserve: x.reserve };
    const full = !lane && max !== null && x.leased >= max;
    let limited = full && !own;
    for (const r of await claimOrder(db, caller, tiers, repos, claim.sessions ?? [], now, fast, x.order, bound, mode)) {
      // Only follow-ups of the helper's own sessions carry a parent here (claimOrder). The own lane's calls count toward no
      // calls at once: it takes them at the limit too, with no limit of its own. An older helper runs them in a slot, as any call.
      if (full && r.parent_id === null && !own) continue;
      if (!(await eligible(caller, r, can, others))) continue;
      // The limit counts from the claim's arrival: the time it was held is gone from the helper's login too.
      if (claim.maxTimeoutSeconds !== undefined && r.timeoutMs > claim.maxTimeoutSeconds * 1000 - (now - nowMs)) { tooLong++; continue; }
      // The client left, or shutdown answered the claim: nothing is leased to nobody.
      // A credential the try read as busy needs no busy mark.
      const lease = await leaseCall(db, Number(r.id), caller, claim, claim.tiers[r.tier]!, Date.now(), lane || max === null || own ? null : r.parent_id !== null ? max + 1 : max, live, !fast && !own && !lane && x.idle, slots);
      if (lease === "gone") return null;
      if (lease === "limit") {
        limited = true;
        continue;
      }
      if (!lease) continue;
      takeFromQueueCache(db, Number(r.id));
      return { lease, reserve: x.reserve };
    }
    if (limited && lane) return { lease: null, retryAfter: CLAIM_RETRY_S, reason: `your helpers hold ${slots} interactive calls, your Interactive slots (Connect page, My settings)`, reserve: x.reserve };
    if (limited) return { lease: null, retryAfter: CLAIM_RETRY_S, reason: `your helpers run ${max} calls, your limit of calls at once (Connect page, My settings)`, reserve: x.reserve };
    return null;
  };
  return {
    attempt,
    // An idle helper, with what it takes (the user's picks narrowed by the helper's list): an author's claim gives way to it
    // (idleOthers). The fast lane and the own lane say nothing about the helper's other slots.
    idle: async (now) => { if (!fast && !own && !tooLong) await db.run(db.k.updateTable("main.mcp_tokens").set({ idle_claim_at: now, idle_tiers: JSON.stringify([...tiers]), idle_repos: repos ? JSON.stringify([...repos]) : null }).where("id", "=", caller.tokenId)); },
    empty: async (now, held) => ({ lease: null, retryAfter: held ? scaledS(1) : CLAIM_RETRY_S, reserve: last?.at === now ? last.reserve : await userReserve(db, caller.login),
      ...(tooLong && { reason: `${tooLong} queued call${tooLong === 1 ? " needs" : "s need"} more time than the ${Math.max(0, Math.floor((claim.maxTimeoutSeconds! * 1000 - (now - nowMs)) / 60_000))} min this Task Runner's harness login has before its refresh` }) }),
  };
}

// ---- lease routes ------------------------------------------------------------------

/**
 * A queued bundle as one harness reads it: the marked harness phrases of its text, and of the `claude` hints that carry the
 * system prompt, filled in. With the claim's path root (a macOS helper) the marked sandbox paths, the path arguments of the
 * hints and the explorer's prompt name the same paths below it; the mounts keep the fixed paths, which the helper places
 * below its root itself.
 */
export function forHarness<B extends Omit<TaskBundle, "callId">>(b: B, harness: HarnessId, root = ""): B {
  const claude = b.hints.claude;
  return {
    ...b, stdin: fillHarness(b.stdin, harness, root), system: b.system === null ? null : fillHarness(b.system, harness, root),
    hints: { ...b.hints, ...(claude && { claude: { ...claude, args: rootArgs(claude.args.map((a) => fillHarness(a, "claude", root)), root), ...(claude.agents !== undefined && { agents: rootAgents(claude.agents, root) }) } }) },
  };
}

/** Reply or progress text with the claim's path root taken off, so paths read as the fixed sandbox paths the rest of the server expects (`/repo/src/a.rs`). */
const unrooted = (text: string, root: string | null): string => (root ? text.split(root).join("") : text);
/** A JSON value (the reply's tool uses) with the claim's path root taken off every string in it; the root is plain characters, so its JSON form is itself. */
const rootless = (v: unknown, root: string | null): unknown => (root && v !== undefined ? JSON.parse(unrooted(JSON.stringify(v), root)) as unknown : v);

/** The task bundle of a live lease, worded for the harness that claimed it, or null. */
export async function bundleOf(db: Db, secret: string | undefined): Promise<TaskBundle | null> {
  const l = await liveLease(db, secret);
  if (!l) return null;
  const r = await db.get(db.k.selectFrom("main.remote_calls").select(["bundle", "harness"]).where("id", "=", l.id).$narrowType<{ harness: HarnessId | null }>());
  // A claim always records its harness.
  if (!r || r.harness === null) return null;
  return { ...forHarness(JSON.parse(r.bundle) as Omit<TaskBundle, "callId">, r.harness, l.root ?? ""), callId: l.id };
}

/** A plain one-line progress text from the helper: control characters removed, scrubbed, cut. */
const progressLine = (v: unknown): string | null => (typeof v === "string" && v.trim() ? scrub(v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()).slice(0, PROGRESS_MAX) : null);

/** Records a heartbeat; the first `running` one starts the call's time limit. False when the lease is gone (the route answers 410). */
export async function heartbeat(db: Db, secret: string | undefined, raw: unknown, nowMs: number = Date.now()): Promise<boolean> {
  const l = await liveLease(db, secret, nowMs);
  if (!l) return false;
  const h = raw as Partial<Heartbeat> | undefined;
  const line = progressLine(typeof h?.progress === "string" ? unrooted(h.progress, l.root) : h?.progress);
  // Compare and set on the lease liveLease found: a lease that ended meanwhile (and may be leased again) is not touched.
  const up = await db.run(db.k.updateTable("main.remote_calls").set((eb) => ({
    heartbeat_at: nowMs, ...(line !== null && { progress: line }),
    ...(h?.phase === "running" && { started_at: eb.case().when("started_at", "is", null).then(nowMs).else(eb.ref("started_at")).end() }),
  })).where("id", "=", l.id).where("state", "=", "leased").where("lease_secret_hash", "=", sha256hex(secret!)));
  if (Number(up.changes) !== 1) return false;
  if (line && l.runId !== null) await setRunProgress(db, l.runId, line);
  return true;
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
function usageOf(raw: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  return { input: count(u.inputTokens), output: count(u.outputTokens), cacheRead: count(u.cacheReadTokens), cacheWrite: count(u.cacheWriteTokens) };
}

/** Tokens as stored in the `usage` column (usageOf's shape). */
const storedTokens = (v: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number } => {
  const u = (v ?? {}) as Record<string, unknown>;
  return { input: count(u.input), output: count(u.output), cacheRead: count(u.cacheRead), cacheWrite: count(u.cacheWrite) };
};

/**
 * Takes a helper's result; null when the lease is gone (the route answers 410). A repeat of an accepted reply (the first
 * answer was lost) is accepted again. A reply from another model than the claim declared for the tier, and a failed reply
 * (`ok: false`), send the call back to the queue with its next attempt, not offered to that login for a while, and count
 * toward the login's cool-off; the call fails once its attempts are used up.
 */
export async function submitCall(db: Db, secret: string | undefined, raw: unknown, nowMs: number = Date.now()): Promise<SubmitReply | null> {
  const l = await liveLease(db, secret, nowMs);
  const gone = async (): Promise<SubmitReply | null> => {
    const done = secret?.startsWith(LEASE_PREFIX) && await db.get(db.k.selectFrom("main.remote_calls").select((eb) => eb.lit(1).as("one")).where("lease_secret_hash", "=", sha256hex(secret)).where("state", "=", "done"));
    return done ? { accepted: true } : null;
  };
  if (!l) return await gone();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "the body must be a Submit object");
  const s = raw as Submit;
  const usage = usageOf((s as { usage?: unknown }).usage);
  const duration = count((s as { durationMs?: unknown }).durationMs);
  if (s.ok === true) {
    if (typeof s.text !== "string" || s.text.length > REPLY_MAX) throw new HttpError(400, "text must be the reply as a string");
    if (typeof s.model !== "string") throw new HttpError(400, "model must name the model that ran");
    const r = (await rowOf(db, l.id))!;
    const families = (await acceptedModels(db))[r.tier];
    const family = familyOf(r.model ?? "", families);
    if (family === null || familyOf(s.model, families) !== family) {
      if (await requeue(db, r, `the harness reported model ${s.model.slice(0, 100)}, not the ${family ?? r.model} family claimed for the tier`, nowMs, { skipLogin: l.login, summary: "refused" })) await noteFailure(db, l.login, nowMs);
      return { accepted: false, reason: `the claim declared ${r.model} for this tier` };
    }
    const byModel: Record<string, ReturnType<typeof usageOf>> = {};
    const mu = (s as { modelUsage?: unknown }).modelUsage;
    if (mu && typeof mu === "object" && !Array.isArray(mu)) for (const [m, u] of Object.entries(mu).slice(0, 20)) if (m.length <= 100 && usageOf(u)) byModel[m] = usageOf(u);
    const turns = Number.isInteger(s.turns) && s.turns! >= 0 ? s.turns! : null;
    const sessionId = typeof s.sessionId === "string" && s.sessionId.length <= 200 ? s.sessionId : null;
    const costUsd = typeof s.costUsd === "number" && Number.isFinite(s.costUsd) && s.costUsd >= 0 ? s.costUsd : null;
    // The lease can end between the check above and this write (another process expired it): then the reply is not taken.
    const up = await db.run(db.k.updateTable("main.remote_calls").set({
      state: "done", reply: unrooted(s.text, r.root), usage: JSON.stringify({ ...(usage ?? usageOf({})), ...(Object.keys(byModel).length > 0 && { byModel }), ...(costUsd !== null && { costUsd }) }), turns, session_id: sessionId, duration_ms: duration, ended_at: nowMs, progress: null,
    }).where("id", "=", l.id).where("state", "=", "leased").where("lease_secret_hash", "=", sha256hex(secret!)));
    if (Number(up.changes) !== 1) return await gone();
    await noteSuccess(db, l.login);
    // The claim named the model the helper meant to run (often an alias); the reply names the one that ran.
    if (r.run_id !== null) {
      await db.run(db.k.updateTable("main.agent_runs").set({ reported_model: s.model.slice(0, 100) }).where("id", "=", r.run_id));
      try { await db.attempt(async () => await saveRemoteTools(db, r.run_id!, r.id, rootless((s as { tools?: unknown }).tools, r.root))); } catch (e) { console.log(`tool uses of remote call ${r.id} not stored: ${(e as Error).message}`); }
    }
    return { accepted: true };
  }
  if (s.ok !== false || typeof s.error !== "string") throw new HttpError(400, "ok must be true with text and model, or false with error");
  const r = (await rowOf(db, l.id))!;
  if (s.refused === true || SAFETY_REFUSAL.test(s.error)) {
    await refused(db, r, l.login, sha256hex(secret!), await scrubError(`helper: ${unrooted(s.error, l.root)}`), usage, duration, nowMs);
    return { accepted: true };
  }
  if (await requeue(db, r, await scrubError(`helper: ${unrooted(s.error, l.root)}`), nowMs, { skipLogin: l.login, summary: "helper failed" })) {
    await noteFailure(db, l.login, nowMs);
    // The last attempt's tokens stay with the failed call.
    await db.run(db.k.updateTable("main.remote_calls").set({ usage: usage ? JSON.stringify(usage) : null, duration_ms: duration }).where("id", "=", l.id).where("state", "=", "failed"));
  }
  return { accepted: true };
}

/** The harness's text for a request the model's safety filter declined, for helpers that do not say so (Submit.refused). */
export const SAFETY_REFUSAL = /safeguards flagged this message|appears to violate our usage policy/i;
/** Starts the error of a call that ended because the model's safety filter declined it (Outcome.error). */
export const REFUSED_PREFIX = "refused by the model's safety filter";

/**
 * Where a call the model's safety filter declined runs once more: on another runner token for the same tier, else, for a call that does not judge, a tier
 * lower (top to mid, the instance's model for it), else nowhere. A follow-up turn stays with its session and is not retried;
 * neither is a call that was retried already.
 */
async function refusalRetry(db: Db, r: Row, nowMs: number): Promise<{ token: number } | { tier: Tier; model: string } | null> {
  if (r.refusals > 0 || r.parent_id !== null) return null;
  const refs = JSON.parse(r.items) as ItemRef[];
  const c = { prompt_id: r.prompt_id, repos: [...new Set([...refs.map((i) => i.repo), ...(r.repo ? [r.repo] : [])])], step: r.step, refs, forLogin: r.for_login };
  if (r.token_id !== null && await tierTaker(db, { ...c, tier: r.tier }, r.token_id, nowMs)) return { token: r.token_id };
  // A call that judges (gates a merge or a security finding) is never answered by a lower tier: without another runner it fails as refused.
  const lower: Tier | null = r.tier === "top" && !judges(r.prompt_id) && !r.prompt_id.startsWith("security.") ? "mid" : null;
  if (lower === null || !await tierTaker(db, { ...c, tier: lower }, null, nowMs)) return null;
  return { tier: lower, model: (await acceptedModels(db))[lower][0] ?? lower };
}

/**
 * A lease whose model's safety filter declined the request. The call goes back to the queue once, without using an
 * attempt (refusalRetry), and fails as refused when it cannot or when the retry is declined too. Neither counts toward
 * the login's cool-off: the runner did nothing wrong. The agent run says what happened, for the item's history.
 */
async function refused(db: Db, r: Row, login: string, hash: string, error: string, usage: ReturnType<typeof usageOf>, duration: number, nowMs: number): Promise<void> {
  const by = `${r.model ?? r.asked_model} on ${login}'s Task Runner`;
  const to = await refusalRetry(db, r, nowMs);
  const lease = (eb: Eb) => eb.and([eb("id", "=", r.id), eb("state", "=", "leased"), eb("lease_secret_hash", "=", hash)]);
  if (to) {
    const bundle = "tier" in to ? JSON.stringify({ ...JSON.parse(r.bundle) as Omit<TaskBundle, "callId">, tier: to.tier }) : null;
    const up = await db.run(db.k.updateTable("main.remote_calls").set((eb) => ({
      state: "queued", refusals: eb("refusals", "+", 1), lease_secret_hash: null, token_id: null, claim_id: null, started_at: null, queued_since: nowMs, error, progress: null,
      picked_by: null, picked_at: null, pick_until: null,
      // The bundle hash stays: a resumed job adopts the call as it was asked.
      ...("token" in to ? { refused_token: to.token } : { tier: to.tier, asked_model: to.model, bundle: bundle! }),
    })).where(lease));
    if (Number(up.changes) !== 1) return;
    parsedCalls.get(db)?.delete(r.id);
    dropQueueCache(db);
    await bury(db, r.id, hash, nowMs);
    const where = "token" in to ? "another Task Runner" : `the ${to.tier} tier (${to.model})`;
    if (r.run_id !== null) await finishRun(db, r.run_id, { state: "failed", ...(usage && { tokens: usage }), error, summary: `refused by ${by}; retried on ${where}` });
    console.log(`remote call ${r.id} (${r.prompt_id}) refused by ${by}; retried on ${where}`);
    return;
  }
  const why = r.refusals > 0 ? `${REFUSED_PREFIX} again: ${by}, after the retry` : r.parent_id !== null ? `${REFUSED_PREFIX}: ${by}, in a follow-up turn` : `${REFUSED_PREFIX}: ${by}; no other Task Runner or tier could take the call`;
  const up = await db.run(db.k.updateTable("main.remote_calls").set({
    state: "failed", error: why, ended_at: nowMs, lease_secret_hash: null, token_id: null, claim_id: null, progress: null, usage: usage ? JSON.stringify(usage) : null, duration_ms: duration,
  }).where(lease));
  if (Number(up.changes) !== 1) return;
  dropQueueCache(db);
  await bury(db, r.id, hash, nowMs);
  if (r.run_id !== null) await finishRun(db, r.run_id, { state: "failed", ...(usage && { tokens: usage }), error: `${why}. ${error}`, summary: `refused by ${by}` });
  console.log(`remote call ${r.id} (${r.prompt_id}) ${why}`);
}

/** The helper gives the lease back (it could not prepare or start the run): the call returns to the queue without using an attempt and is not offered to that login for a while. False when the lease is gone. */
export async function releaseCall(db: Db, secret: string | undefined, raw: unknown, nowMs: number = Date.now()): Promise<boolean> {
  const l = await liveLease(db, secret, nowMs);
  if (!l) return false;
  const reason = progressLine((raw as Release | undefined)?.reason) ?? "released by the helper";
  await unlease(db, { id: l.id, runId: l.runId, hash: sha256hex(secret!) }, `released by the helper: ${reason}`, nowMs, l.login);
  return true;
}

// ---- the caller's side -------------------------------------------------------------

export type Outcome =
  /** `byModel`: tokens per model id as the helper reported them (subagents included), when it did. `costUsd`: the harness's cost of the whole call, when it reported one. */
  | { state: "done"; text: string; usage: Usage; byModel: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> | null; costUsd: number | null; turns: number | null; sessionId: string | null; runId: number | null }
  | { state: "failed"; error: string; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null; runId: number | null }
  /** A follow-up turn that the session's helper did not take in time (STICKY_MS, STICKY_CAP_MS); it was withdrawn. */
  | { state: "unclaimed" };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Whether the helper that ran the parent call (its agent token, which holds the session) holds a lease that heartbeats: it is alive and busy. */
const runsLiveLease = async (db: Db, parentId: number, nowMs: number): Promise<boolean> =>
  await db.get(db.k.selectFrom(indexedBy(db, "main.remote_calls", "remote_calls_leased", "c")).select((eb) => eb.lit(1).as("one")).where("c.state", "=", literal("leased")).where("c.heartbeat_at", ">=", nowMs - STICKY_LIVE_MS)
    .where("c.token_id", "=", (eb) => eb.selectFrom("main.remote_calls as p").select("p.token_id").where("p.id", "=", parentId)).limit(1)) !== undefined;

/**
 * Waits for the call's result, polling its row like the model queue polls (allocation.pollMs). Each poll ends a lost lease
 * (expireLeases). A queued call is withdrawn when the job is cancelled or the pipeline is switched off (the halt is thrown),
 * after `maxWaitMs` in the queue (WaitLimitError), and, for a follow-up, after STICKY_MS while its session's login runs no live
 * lease, else after STICKY_CAP_MS. A call the dashboard withdrew because no Task Runner could take it (takers.ts) throws a
 * NoTakerError and counts as a skipped item (skipItem), so the planner runs the step again. The helper's progress lines go to `onProgress`.
 * While the call is leased, each poll runs the `check` requests the dashboard relayed for it on `check` (src/remote/check-relay.ts)
 * and the tool calls of the workspace bound to the call (src/build/workspace-relay.ts), which also run as soon as their wake
 * arrives. `workspace` gives the session they run on (default: the process's session on the workspace, jobSession).
 */
export async function awaitCall(db: Db, id: number, opts: AwaitOptions = {}): Promise<Outcome> {
  const ws = await WorkspaceServer.open(db, id, opts.workspace);
  try {
    return await pollCall(db, id, opts, ws);
  } finally {
    // Each cleanup runs even when one before it fails.
    try {
      await endChecks(db, id);
    } finally {
      await ws?.end();
    }
  }
}

type AwaitOptions = { onProgress?: (line: string) => void; maxWaitMs?: number; log?: (line: string) => void; check?: Pick<CheckTool, "run">; workspace?: (db: Db, workspaceId: number) => ToolSession };

async function pollCall(db: Db, id: number, opts: AwaitOptions, ws: WorkspaceServer | null): Promise<Outcome> {
  const log = opts.log ?? console.log;
  let lastProgress: string | null = null, lastLog = 0, lastSeen = 0;
  for (;;) {
    const nowMs = Date.now();
    // The caller's liveness stamp; claims and the room count a call while it is fresher than CALLER_STALE_MS.
    if (nowMs - lastSeen >= SEEN_EVERY_MS) {
      await db.run(db.k.updateTable("main.remote_calls").set({ seen_at: nowMs }).where("id", "=", id));
      lastSeen = nowMs;
    }
    await expireLeases(db, nowMs, id);
    const r = await rowOf(db, id);
    if (!r) return { state: "failed", error: "the call is gone", tokens: null, runId: null };
    if (r.state === "done") {
      const stored = (r.usage ? JSON.parse(r.usage) : {}) as { byModel?: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>; costUsd?: number };
      const costUsd = typeof stored.costUsd === "number" ? stored.costUsd : null;
      // The raw reply is not kept: the agent run stores the scrubbed copy. A read reply can no longer be adopted.
      await db.run(db.k.updateTable("main.remote_calls").set({ reply: null, consumed_at: nowMs }).where("id", "=", id));
      return { state: "done", text: r.reply ?? "", usage: { ...storedTokens(stored), cost: costUsd }, byModel: stored.byModel ?? null, costUsd, turns: r.turns, sessionId: r.session_id, runId: r.run_id };
    }
    if (r.state === "failed" && r.error?.startsWith(NO_TAKER_PREFIX)) {
      const repos = [...new Set([...(JSON.parse(r.items) as ItemRef[]).map((i) => i.repo), ...(r.repo ? [r.repo] : [])])];
      skipItem(`${NO_TAKER_SKIP}${repos.join(",")}`, log, r.error);
      throw new NoTakerError(r.error);
    }
    if (r.state === "failed") return { state: "failed", error: r.error ?? "failed", tokens: r.usage ? storedTokens(JSON.parse(r.usage)) : null, runId: r.run_id };
    if (r.state === "queued") {
      try {
        await throwIfHalted("waiting for a user-local helper");
      } catch (e) {
        if (await withdrawCall(db, id, (e as Error).message, ["queued"])) throw e;
        continue; // claimed meanwhile: the call runs on
      }
      const waited = nowMs - (r.queued_since ?? r.since);
      if (r.parent_id !== null && (waited >= STICKY_CAP_MS || (waited >= STICKY_MS && !await runsLiveLease(db, r.parent_id, nowMs)))) {
        if (await withdrawCall(db, id, "the helper holding the session did not take the follow-up", ["queued"])) return { state: "unclaimed" };
        continue;
      }
      // Only time in the queue counts; a helper running the call is not waiting.
      if (opts.maxWaitMs !== undefined && r.queued_ms + (r.queued_since === null ? 0 : nowMs - r.queued_since) >= opts.maxWaitMs) {
        if (await withdrawCall(db, id, "no helper took the call in time", ["queued"])) throw new WaitLimitError("no user-local helper took the call in time");
        continue;
      }
      if (nowMs - lastLog >= allocation.logEveryMs) {
        lastLog = nowMs;
        log(`waiting for a user-local helper (${r.prompt_id}, ${r.tier} tier)`);
      }
    }
    if (r.state === "leased" && opts.check) await serveChecks(db, id, opts.check);
    if (r.state === "leased" && ws) await ws.serve();
    if (r.progress && r.progress !== lastProgress) {
      lastProgress = r.progress;
      try { opts.onProgress?.(r.progress); } catch { /* progress is best effort */ }
    }
    await sleep(allocation.pollMs);
  }
}

/**
 * For the runner: whether a remote call of the job waits in the queue now for a caller that polls it, and when its latest
 * lease began. The runner sums the time in which any call waited (the union, as calls of one job wait side by side). A call
 * of a resumed job's earlier run that the resumed run has not adopted has no caller and does not count.
 */
export async function jobRemoteQueue(db: Db, jobId: number, nowMs: number = Date.now()): Promise<{ queued: boolean; lastLeaseAt: number | null }> {
  const r = (await db.get(db.k.selectFrom("main.remote_calls").select((eb) => [
    eb.fn.coalesce(eb.fn.max<number | null>(eb.case().when(eb.and([eb("state", "=", "queued"), eb("seen_at", ">=", nowMs - CALLER_STALE_MS)])).then(eb.lit(1)).else(eb.lit(0)).end()), eb.lit(0)).as("queued"),
    eb.fn.max<number | null>("leased_at").as("last"),
  ]).where("job_id", "=", jobId)))!;
  return { queued: Number(r.queued) === 1, lastLeaseAt: r.last === null ? null : Number(r.last) };
}
