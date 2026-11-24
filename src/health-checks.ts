// Health checks computed from the database: one list read by the dashboard's warnings menu and by GET /healthz/checks.
// Every check reads rows the runner, the sync and the build workers already write; none starts work or wakes the planner.
import type { IncomingMessage, ServerResponse } from "node:http";
import { accountListOrNull } from "./agents/account-actions.ts";
import { deadlineStops } from "./runner/autopilot.ts";
import { stepTitle } from "./dash/api/trace.ts";
import { repoErrors } from "./sync-errors.ts";
import { slugOf } from "./owners.ts";
import { trackedNames } from "./repos.ts";
import { storedLiveness } from "./liveness.ts";
import { coverageSnapshot, githubIdentity } from "./github/identity.ts";
import { readAppSecrets } from "./github/install-token.ts";
import { unackedRemovals } from "./github/allowed-owners.ts";
import { PROBE_HEADERS } from "./health.ts";
import { unboundLogins } from "./author-ids.ts";
import { inferenceMode, type InferenceMode } from "./remote/mode.ts";
import { CALLER_STALE_MS } from "./remote/room.ts";
import { NO_TAKER_MS } from "./remote/takers.ts";
import { INTERACTIVE_SLOTS_KEY, interactiveSlotsOf } from "./remote/interactive-slots.ts";
import { acceptedModels, familyOf } from "./remote/mode.ts";
import { envVar } from "./env.ts";
import { STATUS_FRESH_MS } from "./remote/helpers.ts";
import { manualExpr } from "./remote/manual-only.ts";
import { confidentialReadyAt, privateStepExpr } from "./build/tasks.ts";
import type { Db } from "./db/index.ts";
import * as kx from "./db/kx.ts";
import { setting } from "./settings-read.ts";
import { BEAT_MS, leaderStatus } from "./db/leader.ts";
import { ENDPOINT_KEY, type EndpointStatus } from "./build/worker-endpoint.ts";
import { LEADER_ROLES } from "./db/fence.ts";

/** Thresholds, in one place. */
export const THRESHOLDS = {
  /** The runner writes its heartbeat every few seconds. */
  runnerStaleMs: 2 * 60_000,
  /** The leader of the runner and of the periodic chores writes its status every BEAT_MS; standbys too. */
  leaderStaleMs: 6 * BEAT_MS,
  /** The leader rewrites the worker API's EndpointSlice at its next beat; past this it names another address for real. */
  endpointGraceMs: 3 * BEAT_MS,
  /** A build worker polls at least every few seconds while it runs. */
  workerStaleMs: 5 * 60_000,
  /** A queued build task older than this has had time to be claimed. */
  taskQueuedMs: 10 * 60_000,
  /** The sync timer runs every minute. */
  syncStaleMs: 10 * 60_000,
  /** Consecutive failed sync runs that make a failure of the run itself. */
  syncFailStreak: 3,
  /** GitHub API points left in the hour: warn below `warn`, fail below `fail`. */
  rateWarn: 500,
  rateFail: 100,
  /** In the user-local mode, a call queued this long with no claim by any helper in that time. */
  remoteQueuedMs: 10 * 60_000,
  /** In the user-local mode with a ready helper, the longest a queued call of each tier may wait. */
  /** A Discord (interactive) call is withdrawn after a few seconds without a taker; one queued this long means claims are failing. */
  interactiveWaitMs: 60_000,
  remoteTierWaitMs: { top: 30 * 60_000, mid: 20 * 60_000, small: 5 * 60_000 },
} as const;

export type CheckState = "ok" | "warn" | "fail";
export type Check = {
  /** Stable name: `runner`, `sync`, `worker:<env id>`, `sync-repo:<repo>`, … */
  id: string;
  state: CheckState;
  /** One plain sentence for operators and maintainers. */
  text: string;
  /** The same for viewers: says that something is wrong, not why. */
  brief: string;
  /** When the check turned bad; null when unknown or ok. */
  since: string | null;
  /** The repo a check is about; viewers who cannot see the repo do not see the check. */
  repo?: string;
  /** Checks of one kind that /healthz/checks reports as one entry with counts, so no repo or environment name leaves the server. */
  group?: "workers" | "sync-repos" | "deadlines";
  /** Set on a job stopped for running past its step's limit: the step an operator acknowledges to clear it. */
  ackStep?: string;
  /** Set on a warning an operator clears by acknowledging it (other than deadline stops). */
  ack?: "app-foreign-install";
  /** Items a check counts (the liveness check); reported with `of`. */
  count?: number;
  /** Size of the group the check is counted against (tracked repos for `sync-repos`). */
  of?: number;
  /** Dashboard page that shows the cause. */
  to: string;
};
/** `probe`: the unauthenticated endpoint; it reads stored and cached state only (no account inserts, no GitHub App token work). */
export type CheckCtx = { db: Db; nowMs: number; probe?: boolean; /** The inference mode, read once for every check. */ mode?: InferenceMode };

const ok = (id: string, to: string, extra: Partial<Check> = {}): Check => ({ id, state: "ok", text: "", brief: "", since: null, to, ...extra });
const minutes = (ms: number): string => (ms < 90 * 60_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : `${Math.round(ms / 3_600_000)} h`);
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function runnerCheck({ db, nowMs }: CheckCtx): Promise<Check[]> {
  const hb = (await setting(db, "runner_heartbeat")) ?? null;
  const beat = hb ? Date.parse(hb) : NaN;
  if (!Number.isNaN(beat) && nowMs - beat <= THRESHOLDS.runnerStaleMs) return [ok("runner", "/pipeline")];
  const text = Number.isNaN(beat) ? "The runner has not reported" : `The runner has not reported for ${minutes(nowMs - beat)}`;
  return [{ id: "runner", state: "fail", text, brief: text, since: hb, to: "/pipeline" }];
}

/**
 * Leader election on Postgres (src/db/leader.ts): `runner-leader` and `periodic-leader` are ok while a leader writes its
 * status, with `since` its start and `count` the standbys waiting; a standby is not a problem unless a copy is set to one
 * replica (warn). No row: one process, no check. In Kubernetes `runner-leader` also fails while the worker API's
 * EndpointSlice has named another address than the leader's (or could not be read) for longer than endpointGraceMs.
 */
async function leaderChecks({ db, nowMs }: CheckCtx): Promise<Check[]> {
  const out: Check[] = [];
  for (const role of LEADER_ROLES) {
    const s = await leaderStatus(db, role, THRESHOLDS.leaderStaleMs, nowMs);
    if (!s) continue;
    const id = `${role}-leader`, at = s.leader ? Date.parse(s.leader.at) : NaN;
    const name = role === "runner" ? "runner" : "periodic chores (sync)";
    if (!Number.isNaN(at) && nowMs - at <= THRESHOLDS.leaderStaleMs) {
      if (s.unwatched) {
        const text = `A standby of the ${name} runs while AUTOCRAFT_RUNNER_REPLICAS is 1, so the leader runs without the watchdog two copies need; set it to the number of copies`;
        out.push({ id, state: "warn", text, brief: `The ${name} copies are misconfigured`, since: s.leader!.since, count: s.standbys, to: "/pipeline" });
      } else {
        const wrong = role === "runner" ? await wrongEndpoint(db, nowMs) : null;
        out.push(wrong ? { id, state: "fail", text: wrong.text, brief: "Build workers cannot reach the runner", since: wrong.since, count: s.standbys, to: "/pipeline" }
          : ok(id, "/pipeline", { since: s.leader!.since, count: s.standbys }));
      }
      continue;
    }
    const text = `No copy of the ${name} has reported as leader for ${Number.isNaN(at) ? "a while" : minutes(nowMs - at)}${s.standbys ? `; ${s.standbys} standby waiting` : ""}`;
    out.push({ id, state: "fail", text, brief: text, since: s.leader?.at ?? null, count: s.standbys, to: "/pipeline" });
  }
  return out;
}

/** The leader's latest check of the worker API's EndpointSlice, when it has named something else for too long. */
async function wrongEndpoint(db: Db, nowMs: number): Promise<{ text: string; since: string } | null> {
  const raw = await setting(db, ENDPOINT_KEY);
  let e: EndpointStatus | null = null;
  try { e = raw ? JSON.parse(raw) as EndpointStatus : null; } catch { /* no status */ }
  if (!e?.wrongSince || nowMs - Date.parse(e.at) > THRESHOLDS.leaderStaleMs || nowMs - Date.parse(e.wrongSince) <= THRESHOLDS.endpointGraceMs) return null;
  const names = e.slice === null ? "could not be read" : `names ${e.slice.length ? e.slice.join(", ") : "no address"}`;
  return { text: `The worker API's EndpointSlice ${names} instead of the leading runner (${e.ip}) for ${minutes(nowMs - Date.parse(e.wrongSince))}${e.error ? `: ${e.error}` : ""}`, since: e.wrongSince };
}

type Env = { id: string; label: string; kind: string; last_seen_at: string | null; created_at: string; health: string | null; health_at: string | null };
const enabledEnvs = async (db: Db): Promise<Env[]> => await db.all(db.k.selectFrom("build_envs").select(["id", "label", "kind", "last_seen_at", "created_at", "health", "health_at"]).where("enabled", "=", 1).orderBy("id"));
const seenRecently = (e: Env, nowMs: number): boolean => e.last_seen_at !== null && nowMs - Date.parse(e.last_seen_at) <= THRESHOLDS.workerStaleMs;

/** A kubernetes environment: the runner's pod launcher reports for it each pass (src/build/launcher.ts). */
function kubeCheck(e: Env, nowMs: number): Check {
  const id = `worker:${e.id}`;
  const at = e.health_at ? Date.parse(e.health_at) : NaN;
  if (Number.isNaN(at) || nowMs - at > THRESHOLDS.workerStaleMs) {
    const text = Number.isNaN(at) ? `The runner has not started build pods for ${e.label} yet` : `The runner has not checked the build pods of ${e.label} for ${minutes(nowMs - at)}`;
    return { id, state: "fail", text, brief: "A build environment is not reporting", since: e.health_at ?? e.created_at, to: "/envs", group: "workers" };
  }
  const h = ((): { state?: unknown; text?: unknown; since?: unknown } | null => {
    try {
      return e.health ? (JSON.parse(e.health) as { state?: unknown }) : null;
    } catch {
      return null;
    }
  })();
  if (!h || (h.state !== "warn" && h.state !== "fail") || typeof h.text !== "string") return ok(id, "/envs", { group: "workers" });
  return { id, state: h.state, text: `${e.label}: ${clip(h.text, 300)}`, brief: "A build environment has a problem", since: typeof h.since === "string" ? h.since : null, to: "/envs", group: "workers" };
}

async function workerChecks({ db, nowMs }: CheckCtx): Promise<Check[]> {
  return (await enabledEnvs(db)).map((e) => {
    if (e.kind === "kubernetes") return kubeCheck(e, nowMs);
    const id = `worker:${e.id}`;
    if (seenRecently(e, nowMs)) return ok(id, "/envs", { group: "workers" });
    const text = e.last_seen_at ? `Build worker ${e.label} has not reported for ${minutes(nowMs - Date.parse(e.last_seen_at))}` : `Build worker ${e.label} has never reported`;
    return { id, state: "fail", text, brief: "A build worker is not reporting", since: e.last_seen_at ?? e.created_at, to: "/envs", group: "workers" };
  });
}

async function queueCheck({ db, nowMs }: CheckCtx): Promise<Check[]> {
  const cutoff = new Date(nowMs - THRESHOLDS.taskQueuedMs).toISOString();
  // Private tasks that no confidential environment can take are the confidential-env check's.
  const noConfidential = await confidentialReadyAt(db) === null;
  const r = (await db.get(db.k.selectFrom("build_tasks").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.min<string | null>("queued_at").as("oldest")])
    .where("state", "=", "queued").where("queued_at", "<", cutoff)
    .$if(noConfidential, (q) => q.where((eb) => eb.not(privateStepExpr(eb))))))!;
  if (!r.n) return [ok("build-queue", "/envs")];
  // Workers that are up but busy leave tasks waiting: that is slow, not broken.
  const anyUp = (await enabledEnvs(db)).some((e) => seenRecently(e, nowMs));
  const text = `${r.n} build task${r.n === 1 ? " has" : "s have"} waited over ${minutes(THRESHOLDS.taskQueuedMs)} for a worker or build pod capacity`;
  return [{ id: "build-queue", state: anyUp ? "warn" : "fail", text, brief: text, since: r.oldest, to: "/envs" }];
}

/** Security fixes and scan tests wait, with no other sign, until a confidential build environment has reported. */
async function confidentialCheck({ db }: CheckCtx): Promise<Check[]> {
  if (await confidentialReadyAt(db) !== null) return [ok("confidential-env", "/envs")];
  const t = (await db.get(db.k.selectFrom("build_tasks").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.min<string | null>("queued_at").as("oldest")])
    .where("state", "=", "queued").where((eb) => privateStepExpr(eb))))!;
  const f = (await db.get(db.k.selectFrom("security_findings").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.min<string | null>("env_wait_at").as("oldest")])
    .where("state", "=", "fixing").where("env_wait_at", "is not", null)))!;
  if (!t.n && !f.n) return [ok("confidential-env", "/envs")];
  const parts = [f.n ? `${f.n} security fix${f.n === 1 ? "" : "es"}` : "", t.n ? `${t.n} security build task${t.n === 1 ? "" : "s"}` : ""].filter(Boolean);
  const text = `${parts.join(" and ")} ${t.n + f.n === 1 ? "is" : "are"} waiting for a confidential build environment`;
  const since = [t.oldest, f.oldest].filter((x): x is string => !!x).sort()[0] ?? null;
  return [{ id: "confidential-env", state: "warn", text, brief: "Some builds are waiting for a build environment", since, to: "/envs" }];
}

async function syncCheck({ db, nowMs }: CheckCtx): Promise<Check[]> {
  const runs = (await db.all(db.k.selectFrom("sync_runs").select(["started_at", "ended_at", "error"]).orderBy("started_at", "desc").limit(20)))
    .filter((r) => r.ended_at !== null || r.error !== null);
  const streak = runs.findIndex((r) => r.error === null);
  const failing = streak === -1 ? runs.length : streak;
  if (failing >= THRESHOLDS.syncFailStreak) {
    return [{ id: "sync", state: "fail", text: `Sync is failing: ${clip(runs[0]!.error ?? "", 140)}`, brief: "Sync is failing", since: runs[failing - 1]!.started_at, to: "/pipeline" }];
  }
  const good = runs.find((r) => r.error === null);
  const last = good?.ended_at ? Date.parse(good.ended_at) : NaN;
  if (Number.isNaN(last)) {
    return (await trackedNames(db)).length ? [{ id: "sync", state: "fail", text: "Sync has not succeeded yet", brief: "Sync has not succeeded yet", since: null, to: "/pipeline" }] : [ok("sync", "/pipeline")];
  }
  if (nowMs - last > THRESHOLDS.syncStaleMs) {
    const text = `No successful sync in ${minutes(nowMs - last)}`;
    return [{ id: "sync", state: "fail", text, brief: text, since: good!.ended_at, to: "/pipeline" }];
  }
  return [ok("sync", "/pipeline")];
}

async function syncRepoChecks({ db }: CheckCtx): Promise<Check[]> {
  const errors = await repoErrors(db);
  const total = (await trackedNames(db)).length;
  // When most repos cannot be read the cause is shared (a token that lost access), not one repo: that is a failure.
  const state: CheckState = errors.length * 2 > total ? "fail" : "warn";
  if (!errors.length) return [ok("sync-repos", "/repos", { group: "sync-repos", of: total })];
  return errors.map((e) => {
    const slug = slugOf(e.repo);
    const why = e.kind === "not-found"
      ? `${slug} no longer resolves on GitHub (${e.movedTo ? `moved to ${e.movedTo}` : "moved, renamed or deleted"})`
      : e.kind === "forbidden" ? `${slug} cannot be read: GitHub denied access`
      : e.kind === "transient" ? `${slug} could not be read: GitHub kept failing`
      : `${slug} failed to sync: ${clip(e.message, 120)}`;
    return { id: `sync-repo:${e.repo}`, state, text: why, brief: `${slug} is not syncing`, since: e.since, repo: e.repo, group: "sync-repos", of: total, to: "/repos" } satisfies Check;
  });
}

async function accountsCheck({ db, nowMs, probe }: CheckCtx): Promise<Check[]> {
  const all = await accountListOrNull(db, nowMs, !probe);
  if (!all) return [{ id: "accounts", state: "warn", text: "The runner did not answer, so the Claude accounts are unknown", brief: "Claude accounts unknown: the runner did not answer", since: null, to: "/accounts" }];
  const on = all.filter((a) => a.enabled);
  if (on.length && on.every((a) => a.pausedReason || a.auth.loggedIn === false)) {
    const text = on.length === 1 ? "The Claude account is paused" : "All Claude accounts are paused";
    return [{ id: "accounts", state: "fail", text, brief: text, since: null, to: "/accounts" }];
  }
  return [ok("accounts", "/accounts")];
}

async function rateCheck({ db, nowMs }: CheckCtx): Promise<Check[]> {
  const get = async (k: string) => (await setting(db, k)) ?? null;
  const left = Number(await get("sync_rate_remaining"));
  const reset = Date.parse(await get("sync_rate_reset_at") ?? "");
  // A reading from before the last reset says nothing about the new hour.
  if (await get("sync_rate_remaining") === null || Number.isNaN(left) || Number.isNaN(reset) || reset < nowMs || left >= THRESHOLDS.rateWarn) return [ok("github-rate", "/pipeline")];
  const text = `GitHub rate limit is nearly used up: ${left} points left until ${new Date(reset).toISOString().slice(11, 16)} UTC`;
  return [{ id: "github-rate", state: left < THRESHOLDS.rateFail ? "fail" : "warn", text, brief: "GitHub rate limit is nearly used up", since: null, to: "/pipeline" }];
}

/** One warning per step whose job the runner stopped for running past its limit, until an operator acknowledges it or a later job of the step succeeds. */
async function deadlineChecks({ db }: CheckCtx): Promise<Check[]> {
  return (await deadlineStops(db)).map((d) => ({
    id: `deadline:${d.step}`, state: "warn", group: "deadlines", ackStep: d.step, to: `/pipeline/${d.jobId}`, since: d.endedAt,
    text: `${stepTitle(d.step)} was stopped (job ${d.jobId}: ${d.error})${d.count > 1 ? `, ${d.count} times in a row` : ""}`,
    brief: `${stepTitle(d.step)} was stopped for running too long`,
  }));
}

/** Open items that nothing will move and nobody is asked about (fail), or that have not changed for days (warn). Read from the result the runner stores after planner passes. */
async function livenessCheck({ db }: CheckCtx): Promise<Check[]> {
  const l = await storedLiveness(db);
  if (!l || (l.stuck === 0 && l.long === 0)) return [ok("liveness", "/stuck", { of: l?.open })];
  const oldest = (v: string) => l.items.filter((i) => i.verdict === v).map((i) => i.since).sort()[0] ?? null;
  if (l.stuck > 0) {
    const text = `${l.stuck} open item${l.stuck === 1 ? " is" : "s are"} stuck: nothing is due and nobody is asked${l.long ? `; ${l.long} more unchanged for days` : ""}`;
    return [{ id: "liveness", state: "fail", text, brief: "Some items are stuck", since: oldest("stuck"), count: l.stuck, of: l.open, to: "/stuck" }];
  }
  const text = `${l.long} open item${l.long === 1 ? " has" : "s have"} not changed for days`;
  return [{ id: "liveness", state: "warn", text, brief: "Some items have not moved for days", since: oldest("long"), count: l.long, of: l.open, to: "/stuck" }];
}

/** Under the GitHub App identity: the app's keys must be readable (fail), and every tracked repo should be in its installation (warn). Nothing is listed under the box account. */
async function appIdentityChecks({ db, probe }: CheckCtx): Promise<Check[]> {
  if (await githubIdentity(db) !== "app") return [];
  let keys = false;
  try { keys = readAppSecrets() !== null; } catch { keys = false; }
  if (!keys) {
    const text = "The GitHub identity is the GitHub App, but no app keys are available";
    return [{ id: "app-keys", state: "fail", text, brief: "GitHub sign-in and writes are unavailable", since: null, to: "/admin/github-app" }];
  }
  const { uncovered } = coverageSnapshot(db, !probe);
  if (!uncovered.length) return [ok("app-keys", "/admin/github-app"), ok("app-coverage", "/admin/github-app")];
  const text = `The GitHub App does not cover ${uncovered.length} tracked repo${uncovered.length === 1 ? "" : "s"}: ${clip(uncovered.join(", "), 120)}`;
  return [ok("app-keys", "/admin/github-app"), { id: "app-coverage", state: "warn", text, brief: "The GitHub App does not cover every tracked repo", since: null, count: uncovered.length, to: "/admin/github-app" }];
}

/** The GitHub App was uninstalled from an account that is not an allowed owner (src/github/allowed-owners.ts): a warning for 24 hours, or until an operator acknowledges it. */
async function foreignInstallCheck({ db, nowMs }: CheckCtx): Promise<Check[]> {
  const removed = await unackedRemovals(db, nowMs);
  if (!removed.length) return [ok("app-foreign-install", "/admin/github-app")];
  const gone = [...new Set(removed.filter((r) => !r.refused).map((r) => r.account))];
  const kept = removed.filter((r) => r.refused).map((r) => `${r.account} (covers ${r.refused})`);
  const parts = [
    ...(gone.length ? [`The GitHub App was installed on ${clip(gone.join(", "), 100)}, not ${gone.length === 1 ? "an allowed owner" : "allowed owners"}, and removed`] : []),
    ...(kept.length ? [`The GitHub App's installation on ${clip([...new Set(kept)].join(", "), 120)} is not on the allowed owners list and was kept`] : []),
  ];
  const text = parts.join("; ");
  return [{ id: "app-foreign-install", state: "warn", text, brief: "The GitHub App was installed on an account that may not use it", since: removed[0]!.at, count: removed.length, ack: "app-foreign-install", to: "/admin/github-app" }];
}

/** The last pass that binds contributors' account ids failed: the earlier PRs of the logins it did not bind count toward no tier until a pass succeeds. */
async function authorIdsCheck({ db }: CheckCtx): Promise<Check[]> {
  const err = await setting(db, "author_ids_error");
  const passed = await setting(db, "author_ids_backfilled");
  // A pass that succeeded after the error supersedes it.
  if (!err || (passed && passed >= (err.split(" ")[0] ?? ""))) return [ok("author-ids", "/contributors")];
  const n = (await unboundLogins(db)).length;
  if (!n) return [ok("author-ids", "/contributors")];
  const at = err.split(" ")[0] ?? null;
  return [{ id: "author-ids", state: "warn", count: n, since: at, to: "/contributors",
    text: `Contributor account ids could not be read (${err.slice(at ? at.length + 1 : 0).trim() || "error"}): the earlier PRs of ${n} login${n === 1 ? "" : "s"} count toward no whitelist tier until the next sync reads them`,
    brief: "Some contributors' whitelist history cannot be read" }];
}

/** The outside-author surge breaker (src/outside.ts) while it is tripped; an operator resumes it on the Pipeline page. */
async function outsideSurgeCheck({ db }: CheckCtx): Promise<Check[]> {
  const t = await db.get(db.k.selectFrom("stage_trips").select(["reason", "tripped_at"]).where("stage", "=", "outside-surge").where("active", "=", 1));
  if (!t) return [ok("outside-surge", "/pipeline")];
  const held = (await db.get(db.k.selectFrom("main.outside_holds").select((eb) => eb.fn.countAll<number>().as("n")).where("reason", "=", "surge")))!.n;
  return [{ id: "outside-surge", state: "warn", text: `New items from outside authors are held: ${t.reason}`, brief: "New items from outside authors are held", since: t.tripped_at, count: held, to: "/pipeline" }];
}

/** User-local mode: model calls have waited for a helper and none has claimed anything in that time. */
async function remoteCallsCheck({ db, nowMs, mode }: CheckCtx): Promise<Check[]> {
  if ((mode ?? await inferenceMode(db)) !== "user-local") return [];
  const cutoff = nowMs - THRESHOLDS.remoteQueuedMs;
  // Calls whose caller stopped polling are about to be withdrawn and do not count as waiting.
  const q = (await db.get(db.k.selectFrom("main.remote_calls").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.min<number | null>("queued_since").as("oldest")])
    .where("state", "=", "queued").where("queued_since", "<", cutoff).where("seen_at", ">=", nowMs - CALLER_STALE_MS)))!;
  const last = (await db.get(db.k.selectFrom("main.remote_calls").select((eb) => eb.fn.max<number | null>("leased_at").as("at"))))!.at;
  if (!q.n || (last !== null && last >= cutoff)) return [ok("remote-calls", "/pipeline")];
  const text = `${q.n} model call${q.n === 1 ? " has" : "s have"} waited over ${minutes(THRESHOLDS.remoteQueuedMs)} for a user's helper, and no helper has claimed a call in that time`;
  return [{ id: "remote-calls", state: "warn", text, brief: "Model calls are waiting and no helper is claiming them", since: new Date(q.oldest ?? cutoff).toISOString(), count: q.n, to: "/pipeline" }];
}

/**
 * User-local mode: a helper that takes calls on its own is ready, yet the oldest queued call of a tier has waited past that
 * tier's limit (the helpers' models, reserves or repo choices may not fit it). Manual only helpers (manual-only.ts) do not count.
 */
async function remoteStarvedCheck({ db, nowMs, mode }: CheckCtx): Promise<Check[]> {
  if ((mode ?? await inferenceMode(db)) !== "user-local") return [];
  const ready = (await db.get(db.k.selectFrom("main.mcp_tokens as t").innerJoin("main.remote_helpers as h", "h.token_id", "t.id")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("t.kind", "=", "runner").where("h.readiness", "=", "ready").where("h.reported_at", ">=", nowMs - STATUS_FRESH_MS)
    .where((eb) => eb.not(manualExpr(db, eb, "t.login")))))!.n;
  if (!ready) return [ok("remote-starved", "/pipeline")];
  const out: Check[] = [];
  for (const tier of ["top", "mid", "small"] as const) {
    const limit = THRESHOLDS.remoteTierWaitMs[tier];
    const q = (await db.get(db.k.selectFrom("main.remote_calls").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.min<number | null>("queued_since").as("oldest")])
      .where("state", "=", "queued").where("tier", "=", tier).where("queued_since", "<", nowMs - limit).where("seen_at", ">=", nowMs - CALLER_STALE_MS)))!;
    if (!q.n || q.oldest === null) continue;
    out.push({ id: `remote-starved-${tier}`, state: "warn", count: q.n, since: new Date(q.oldest).toISOString(), to: "/pipeline",
      text: `The oldest queued ${tier}-tier model call has waited ${minutes(nowMs - q.oldest)} (limit ${minutes(limit)}) while ${ready} helper${ready === 1 ? " is" : "s are"} ready`,
      brief: `${tier[0]!.toUpperCase()}${tier.slice(1)}-tier model calls wait although a helper is ready` });
  }
  return out.length ? out : [ok("remote-starved", "/pipeline")];
}

/** User-local mode: calls have waited past remoteQueuedMs while every fresh, ready Task Runner is Manual only: they wait for a person to pick them. */
async function remoteManualCheck({ db, nowMs, mode }: CheckCtx): Promise<Check[]> {
  if ((mode ?? await inferenceMode(db)) !== "user-local") return [];
  const r = (await db.get(db.k.selectFrom("main.mcp_tokens as t").innerJoin("main.remote_helpers as h", "h.token_id", "t.id")
    .select((eb) => [eb.fn.countAll<number>().as("n"),
      eb.fn.coalesce(eb.fn.sum<number>(eb.case().when(manualExpr(db, eb, "t.login")).then(1).else(0).end()), eb.lit(0)).as("manual")])
    .where("t.kind", "=", "runner").where("t.expires_at", ">", new Date(nowMs).toISOString()).where("h.readiness", "=", "ready").where("h.reported_at", ">=", nowMs - STATUS_FRESH_MS)))!;
  if (!r.n || Number(r.manual) < Number(r.n)) return [ok("remote-manual", "/model-queue")];
  const q = (await db.get(db.k.selectFrom("main.remote_calls").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.min<number | null>("queued_since").as("oldest")])
    .where("state", "=", "queued").where("queued_since", "<", nowMs - THRESHOLDS.remoteQueuedMs).where("seen_at", ">=", nowMs - CALLER_STALE_MS)))!;
  if (!q.n || q.oldest === null) return [ok("remote-manual", "/model-queue")];
  return [{ id: "remote-manual", state: "warn", count: q.n, since: new Date(q.oldest).toISOString(), to: "/model-queue",
    text: `${q.n} model call${q.n === 1 ? " has" : "s have"} waited over ${minutes(THRESHOLDS.remoteQueuedMs)} while every ready Task Runner is Manual only`,
    brief: "Model calls wait for a pick: every ready Task Runner is Manual only" }];
}

/**
 * User-local mode: pipeline-on repos that no Task Runner has been able to take calls on for NO_TAKER_MS (src/remote/takers.ts:
 * the dashboard's minute maintenance keeps the marks). Their queued calls are withdrawn and their work waits, often with
 * nothing queued at all, so the check goes by repo.
 */
async function remoteNoTakerCheck({ db, nowMs, mode }: CheckCtx): Promise<Check[]> {
  if ((mode ?? await inferenceMode(db)) !== "user-local") return [];
  const rows = await db.all(db.k.selectFrom("main.remote_no_taker as n")
    .innerJoin("main.tracked_repos as r", (j) => j.onRef("r.name", "=", "n.repo").on("r.pipeline", "=", 1))
    .select(["n.repo", "n.since"]).where("n.since", "<=", nowMs - NO_TAKER_MS).orderBy("n.repo"));
  if (!rows.length) return [ok("remote-no-taker", "/model-queue")];
  const n = rows.length;
  return [{ id: "remote-no-taker", state: "warn", count: n, since: new Date(Math.min(...rows.map((r) => Number(r.since)))).toISOString(), to: "/model-queue",
    text: `No ready Task Runner has been able to take calls on ${clip(rows.map((r) => r.repo).join(", "), 120)} for over ${minutes(NO_TAKER_MS)}: their model work waits`,
    brief: "Some repos have no Task Runner that may take their model calls" }];
}

const READINESS_WORDS: Record<string, string> = { "quota-held": "holding for its reserve", paused: "paused", "cooled-off": "cooling off", "sandbox-failed": "failing its sandbox check", "version-refused": "too old to run calls", "harness-missing": "missing its model tool", failing: "failing", "login-refresh": "waiting for its Claude login to refresh" };

/** Whether a Task Runner can take Discord calls now (user-local mode with Discord configured; `applies` is false otherwise), and when not, why. Shared by interactiveNoTakerCheck and the Discord usage page. */
export async function interactiveTakers(db: Db, nowMs: number, mode?: InferenceMode): Promise<{ applies: boolean; ready: boolean; why: string | null }> {
  if (!envVar("DISCORD_KEY_FILE") || (mode ?? await inferenceMode(db)) !== "user-local") return { applies: false, ready: true, why: null };
  const rows = await db.all(db.k.selectFrom("main.mcp_tokens as t").innerJoin("main.access as a", "a.login", "t.login")
    .leftJoin("main.remote_helpers as h", "h.token_id", "t.id")
    .leftJoin("main.user_settings as us", (j) => j.onRef("us.login", "=", "t.login").on("us.key", "=", INTERACTIVE_SLOTS_KEY))
    .select(["t.id", "t.login", "a.role", "us.value as slots", "h.readiness", "h.until", "h.models", "h.reported_at",
      (eb) => eb.exists(kx.schemaEb(eb).selectFrom("main.remote_cooloffs as co").select(eb.lit(1).as("one")).where("co.login", "=", eb.ref("t.login")).where("co.until", ">", nowMs)).as("cooled")])
    .where("t.kind", "=", "runner").where("t.expires_at", ">", new Date(nowMs).toISOString()).where("a.role", "=", "operator"));
  const accepted = await acceptedModels(db);
  const withSlots = rows.filter((r) => interactiveSlotsOf(r.slots ?? undefined, r.role) > 0);
  const offersSmall = (models: string | null): boolean => {
    try { const m = JSON.parse(models ?? "{}") as Record<string, unknown>; return typeof m.small === "string" && familyOf(m.small, accepted.small) !== null; } catch { return false; }
  };
  const state = (r: (typeof rows)[number]): string => r.reported_at === null || Number(r.reported_at) < nowMs - STATUS_FRESH_MS ? "not connected"
    : r.cooled ? READINESS_WORDS["cooled-off"]! : r.readiness !== "ready" ? (READINESS_WORDS[r.readiness ?? ""] ?? "not ready") + (r.readiness === "quota-held" && r.until ? ` until ${r.until.slice(11, 16)} UTC` : "")
    : !offersSmall(r.models) ? "offering no small-tier model" : "ready";
  const states = withSlots.map(state);
  if (states.includes("ready")) return { applies: true, ready: true, why: null };
  const why = !withSlots.length ? "no operator's Task Runner has Interactive slots"
    : `${withSlots.length} Task Runner${withSlots.length === 1 ? " has" : "s have"} Interactive slots, ${states.length === 1 ? "and it is" : "but they are"} ${[...new Set(states)].join(" / ")}`;
  return { applies: true, ready: false, why };
}

/**
 * User-local mode with Discord configured: Discord calls run only in operators' Interactive slots (src/remote/interactive-slots.ts)
 * on a Task Runner that is ready and offers the small tier. Warns when none can take them now, or when a Discord call has waited
 * past THRESHOLDS.interactiveWaitMs (claims failing although a taker looks ready). The text names no login.
 */
async function interactiveNoTakerCheck({ db, nowMs, mode }: CheckCtx): Promise<Check[]> {
  const id = "interactive-no-taker", to = "/model-queue";
  const t = await interactiveTakers(db, nowMs, mode);
  if (!t.applies) return [ok(id, to)];
  if (!t.ready) return [{ id, state: "warn", to, since: null, text: `No Task Runner takes Discord calls: ${t.why}`, brief: "No Task Runner takes Discord calls" }];
  const q = (await db.get(db.k.selectFrom("main.remote_calls").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.min<number | null>("queued_since").as("oldest")])
    .where("state", "=", "queued").where("prompt_id", "like", "discord.%").where("queued_since", "<", nowMs - THRESHOLDS.interactiveWaitMs).where("seen_at", ">=", nowMs - CALLER_STALE_MS)))!;
  if (!q.n || q.oldest === null) return [ok(id, to)];
  return [{ id, state: "warn", to, count: q.n, since: new Date(q.oldest).toISOString(),
    text: `${q.n} Discord call${q.n === 1 ? " has" : "s have"} waited over ${Math.round(THRESHOLDS.interactiveWaitMs / 1000)} seconds although a Task Runner has a free Interactive slot`,
    brief: "Discord calls wait although a Task Runner looks ready" }];
}

/** Every check, in the order the lists show them. */
const SOURCES: ((ctx: CheckCtx) => Promise<Check[]>)[] = [runnerCheck, leaderChecks, workerChecks, queueCheck, confidentialCheck, syncCheck, syncRepoChecks, accountsCheck, rateCheck, deadlineChecks, livenessCheck, appIdentityChecks, foreignInstallCheck, authorIdsCheck, outsideSurgeCheck, remoteCallsCheck, remoteStarvedCheck, remoteManualCheck, remoteNoTakerCheck, interactiveNoTakerCheck];

export async function computeChecks(db: Db, nowMs: number = Date.now(), probe = false): Promise<Check[]> {
  const mode = await inferenceMode(db);
  // The checks do not depend on each other, so they run together; the list keeps the SOURCES order.
  return (await Promise.all(SOURCES.map((f) => f({ db, nowMs, probe, mode })))).flat();
}

/** The answer of GET /healthz/checks for staff: states, times and counts only; no repo, environment, account or error text. */
export type PublicCheck = { id: string; state: CheckState; since: string | null; count?: number; of?: number };

export function publicChecks(checks: Check[]): { status: CheckState; checks: PublicCheck[] } {
  const out: PublicCheck[] = [];
  const groups = new Map<string, Check[]>();
  for (const c of checks) {
    if (c.group) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
    else out.push({ id: c.id, state: c.state, since: c.since, ...(c.count !== undefined ? { count: c.count } : {}), ...(c.of !== undefined ? { of: c.of } : {}) });
  }
  for (const [id, list] of groups) {
    const bad = list.filter((c) => c.state !== "ok");
    out.push({
      id, state: bad.some((c) => c.state === "fail") ? "fail" : bad.length ? "warn" : "ok",
      since: bad.map((c) => c.since).filter((x): x is string => !!x).sort()[0] ?? null, count: bad.length, of: list[0]!.of ?? list.length,
    });
  }
  const status = out.some((c) => c.state === "fail") ? "fail" : out.some((c) => c.state === "warn") ? "warn" : "ok";
  return { status, checks: out };
}

/** What an anonymous caller (external monitoring) reads: each check's name and state, without counts or times. */
export const anonymousChecks = (body: ReturnType<typeof publicChecks>): { status: CheckState; checks: Pick<PublicCheck, "id" | "state">[] } =>
  ({ status: body.status, checks: body.checks.map(({ id, state }) => ({ id, state })) });

let cached: { db: Db; at: number; full: string; plain: string; fail: boolean } | null = null;

/**
 * Answers GET/HEAD /healthz/checks: 200 when every check is ok or warn, 503 when one fails; returns false for any other request.
 * No auth: anyone gets the names and states (`anonymousChecks`); `staff` (a signed-in operator or maintainer) also gets the times and
 * counts of `publicChecks`. The answer is reused for `ttlMs`, since anyone can call this.
 */
export async function serveChecks(req: IncomingMessage, res: ServerResponse, db: Db, nowMs: number = Date.now(), ttlMs = 5_000, staff: (req: IncomingMessage) => Promise<boolean> = async () => false): Promise<boolean> {
  if ((req.method !== "GET" && req.method !== "HEAD") || (req.url ?? "").split("?")[0] !== "/healthz/checks") return false;
  if (!cached || cached.db !== db || Date.now() - cached.at >= ttlMs) {
    let body: ReturnType<typeof publicChecks>;
    try {
      body = publicChecks(await computeChecks(db, nowMs, true));
    } catch {
      body = { status: "fail", checks: [{ id: "database", state: "fail", since: null }] };
    }
    cached = { db, at: Date.now(), full: JSON.stringify({ ...body, at: new Date(nowMs).toISOString() }), plain: JSON.stringify(anonymousChecks(body)), fail: body.status === "fail" };
  }
  const text = await staff(req) ? cached.full : cached.plain;
  res.writeHead(cached.fail ? 503 : 200, { ...PROBE_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
  res.end(req.method === "HEAD" ? undefined : text);
  return true;
}
