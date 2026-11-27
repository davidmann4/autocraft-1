// reads: build.build_envs, access.user_tokens, access.access, control.audit
// The inputs of every health check, loaded in one wave. The checks stay pure functions over these facts in src/health-checks.ts.
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import { leaderStatus } from "../../db/leader.ts";
import { LEADER_ROLES } from "../../db/fence.ts";
import * as build from "../build/index.ts";
import * as control from "../control/index.ts";
import * as intake from "../intake/index.ts";
import * as jobs from "../jobs/index.ts";
import * as mirror from "../mirror/index.ts";
import * as planner from "../planner/index.ts";
import * as runners from "../runners/index.ts";
import * as security from "../security/index.ts";
import type { RunnerHealth } from "../runners/types.ts";
import type { HealthThresholds } from "../runners/views.ts";
import type { EndpointStatus } from "../build/types.ts";
import type { DeadlineStop, StepRun } from "../jobs/types.ts";
import type { Liveness } from "../planner/types.ts";
import type { RepoErrorRow, SyncRunRow, SyncState } from "../mirror/types.ts";
import type { TrackedRepo, TripRow } from "../control/types.ts";

export type HealthEnv = { id: string; label: string; kind: string; last_seen_at: string | null; created_at: string; health: string | null; health_at: string | null };
export type LeaderFacts = { role: string; status: { leader: { at: string; since: string } | null; standbys: number; unwatched: boolean } | null };
export type RemovalRow = { at: string; target: string | null; details: string | null };
export type TakerRow = { id: number; login: string; role: string; slots: string | null; readiness: string | null; until: string | null; models: string | null; reported_at: number | string | null; cooled: boolean };

export type HealthFacts = {
  heartbeat: string | null;
  /** A part of the runner's work fails since then (src/runner/runner.ts TickFailure). */
  tickFailure: { since: string; state: "warn" | "fail"; error: string } | null;
  /** The runner's job cap and its parts as JSON (src/runner/capacity.ts JobCapacity), as it stored them last. */
  jobCapacity: string | null;
  /** Live workflows whose check keeps failing (src/workflow/advance.ts), as the runner stored them last. */
  workflowFailures: jobs.WorkflowFailure[];
  leaders: LeaderFacts[];
  endpoint: EndpointStatus | null;
  envs: HealthEnv[];
  /** Queued build tasks older than the window; the private ones are counted apart when no confidential environment has reported. */
  queued: { all: { n: number; oldest: string | null }; withoutPrivate: { n: number; oldest: string | null } };
  confidentialReadyAt: number | null;
  privateQueued: { n: number; oldest: string | null };
  envWaits: { n: number; oldest: string | null };
  syncRuns: SyncRunRow[];
  syncState: SyncState;
  tracked: Map<string, TrackedRepo>;
  repoErrors: RepoErrorRow[];
  deadlines: DeadlineStop[];
  stepRuns: StepRun[];
  liveness: Liveness | null;
  userTokens: { login: string; updated_at: string }[];
  removals: { ack: string | null; rows: RemovalRow[] };
  unboundLogins: number;
  surge: { trip: TripRow | undefined; held: number };
  runner: RunnerHealth | null;
  takers: TakerRow[] | null;
};

export type HealthOptions = {
  thresholds: HealthThresholds; leaderStaleMs: number; taskQueuedMs: number; foreignWarnMs: number;
  /** Whether Discord is configured: the Interactive taker rows are read only then. */
  discord: boolean; stepWindow: number; stepDays: number; stepLast: number;
};

/** Operators' Task Runner tokens with their helper status and Interactive slots, for the Discord taker check. */
export async function loadTakerRows(db: Db, nowMs: number): Promise<TakerRow[]> {
  const q = queryDb(db);
  return (await q.all(q.k.selectFrom("main.mcp_tokens as t").innerJoin("main.access as a", "a.login", "t.login")
    .leftJoin("main.remote_helpers as h", "h.token_id", "t.id")
    .leftJoin("main.user_settings as us", (j) => j.onRef("us.login", "=", "t.login").on("us.key", "=", "interactive_slots"))
    .select(["t.id", "t.login", "a.role", "us.value as slots", "h.readiness", "h.until", "h.models", "h.reported_at",
      (eb) => eb.exists(eb.selectFrom("main.remote_cooloffs as co").select(eb.lit(1).as("one")).whereRef("co.login", "=", "t.login").where("co.until", ">", nowMs)).as("cooled")])
    .where("t.kind", "=", "runner").where("t.expires_at", ">", new Date(nowMs).toISOString()).where("a.role", "=", "operator"))) as unknown as TakerRow[];
}

function failureOf(value: string | undefined): HealthFacts["tickFailure"] {
  try { return value ? JSON.parse(value) as HealthFacts["tickFailure"] : null; } catch { return null; }
}

export async function loadHealthFacts(db: Db, nowMs: number, o: HealthOptions): Promise<HealthFacts> {
  const q = queryDb(db);
  const cutoff = new Date(nowMs - o.taskQueuedMs).toISOString();
  const from = new Date(nowMs - o.foreignWarnMs).toISOString();
  const [lanes, endpoint, envs, queuedAll, queuedPublic, confidentialReadyAt, privateQueued, envWaits, syncRuns, syncState, tracked, repoErrors, deadlines, stepRuns, liveness,
    userTokens, ack, removalRows, trip, held, runner, takers, leaders] = await db.together(() => Promise.all([
    jobs.loadLaneState(db, ["mark"]),
    build.loadEndpointStatus(db),
    q.all(q.k.selectFrom("build_envs").select(["id", "label", "kind", "last_seen_at", "created_at", "health", "health_at"]).where("enabled", "=", 1).orderBy("id")),
    build.loadQueuedStats(db, { olderThan: cutoff }),
    build.loadQueuedStats(db, { olderThan: cutoff, excludePrivate: true }),
    build.loadConfidentialReadyAt(db),
    build.loadQueuedStats(db, { privateOnly: true }),
    security.countEnvWaits(db),
    mirror.loadSyncRuns(db, 20),
    mirror.loadSyncState(db),
    control.loadTrackedRepos(db),
    mirror.loadRepoErrors(db),
    jobs.loadDeadlineStops(db),
    jobs.loadStepRuns(db, { requestedBy: "pipeline", sinceDays: o.stepDays, window: o.stepWindow, last: o.stepLast, nowMs }),
    planner.loadLiveness(db),
    q.all(q.k.selectFrom("user_tokens").innerJoin("access", "access.login", "user_tokens.login")
      .select(["user_tokens.login", "user_tokens.updated_at"]).where("user_tokens.status", "=", "refresh-failed")
      .where("access.role", "in", ["operator", "maintainer"]).orderBy("user_tokens.updated_at")),
    q.get(q.k.selectFrom("audit").select((eb) => eb.fn.max<string | null>("at").as("at")).where("action", "=", "app-foreign-install-ack")),
    q.all(q.k.selectFrom("audit").select(["at", "target", "details"]).where("action", "=", "app-install-removed").where("at", ">=", from).orderBy("at", "desc")),
    control.loadTrip(db, "outside-surge"),
    intake.countHolds(db, { reason: "surge" }),
    runners.loadRunnerHealth(db, nowMs, o.thresholds),
    o.discord ? loadTakerRows(db, nowMs) : Promise.resolve(null),
    Promise.all(LEADER_ROLES.map(async (role): Promise<LeaderFacts> => ({ role, status: await leaderStatus(db, role, o.leaderStaleMs, nowMs) }))),
  ]));
  // Reading the unbound logins costs a scan, so it waits for an error that could make it matter.
  const unbound = syncState.author_ids_error ? new Set((await mirror.loadUnboundLoginPrs(db)).map((r) => r.login)).size : 0;
  const ackAt = ack?.at ?? null;
  return {
    heartbeat: lanes.get("mark|heartbeat|")?.value ?? null, tickFailure: failureOf(lanes.get("mark|tick_failure|")?.value), jobCapacity: lanes.get("mark|job_capacity|")?.value ?? null, workflowFailures: jobs.workflowFailuresOf(lanes.get(`mark|${jobs.WORKFLOW_FAILURES_MARK}|`)?.value),
    leaders, endpoint, envs: envs as HealthEnv[],
    queued: { all: queuedAll, withoutPrivate: queuedPublic }, confidentialReadyAt, privateQueued, envWaits,
    syncRuns, syncState, tracked, repoErrors, deadlines, stepRuns, liveness,
    userTokens, removals: { ack: ackAt, rows: removalRows }, unboundLogins: unbound, surge: { trip, held: held.surge }, runner, takers,
  };
}
