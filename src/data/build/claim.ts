// The environment claim and launcher pass (package build-a).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { loadTrackedRepos } from "../control/index.ts";
import { loadBatchesByTask } from "../merge/index.ts";
import { loadStartedRefs } from "../workflow/index.ts";
import { ENV_COLUMNS, hasPatchExpr, TASK_COLUMNS, toEnv, toEnvTask, toTask, type EnvDbRow, type RunningRow, type TaskDbRow } from "./rows.ts";
import { loadSizings, loadWarmFacts } from "./sizes.ts";
import { loadWorkerUpdate } from "./build-state.ts";
import type { ClaimInputs, EnvPassState, EnvTask, EnvTasks, NewPodRun, PodRun, PodRunPatch, TaskRecord } from "./types.ts";
import { WARM_STEP } from "./types.ts";

/** The most queued tasks a claim looks at, in `priority desc, id` order. */
export const CLAIM_CANDIDATES = 500;

/**
 * Everything one claim pass reads, in two waves whatever the queue length: wave 1 the environment and its running count, the queued
 * candidates (without patches: `hasPatch` tells, `loadTasks` with `patch` reads the picked ones), the other enabled environments, the
 * tracked repos and the pending worker update; wave 2 what depends on the candidates: sizings, the warm
 * facts of the warm candidates' repos (when `warm` names the writer's image), the refs started in the candidates' repos and the merge
 * batches of the candidate tasks. Feature switches come from `config(db)`. 13 statements at most.
 */
export async function loadClaimInputs(db: Db, envId: string, nowMs: number, warm?: { version: string; rev: number; image: string | null }): Promise<ClaimInputs> {
  const q = queryDb(db);
  const [envRows, running, queued, others, tracked, update] = await db.together(async () => await Promise.all([
    q.all(q.k.selectFrom("build_envs as e").select(ENV_COLUMNS).where("e.id", "=", envId), { label: "build.loadClaimInputs" }),
    q.get(q.k.selectFrom("build_tasks").select((eb) => eb.fn.countAll<number>().as("n")).where("env_id", "=", envId).where("state", "in", ["claimed", "running"]), { label: "build.loadClaimInputs" }),
    q.all(q.k.selectFrom("build_tasks as t").select((eb) => [...TASK_COLUMNS, hasPatchExpr(eb)]).where("t.state", "=", "queued").orderBy("t.priority", "desc").orderBy("t.id").limit(CLAIM_CANDIDATES), { label: "build.loadClaimInputs" }),
    q.all(q.k.selectFrom("build_envs as e").select(ENV_COLUMNS).where("e.enabled", "=", 1).where("e.id", "!=", envId).orderBy("e.created_at").orderBy("e.id"), { label: "build.loadClaimInputs" }),
    loadTrackedRepos(db),
    loadWorkerUpdate(db),
  ]));
  const candidates = (queued as TaskDbRow[]).map(toTask);
  const repos = [...new Set(candidates.map((t) => t.repo))];
  const warmRepos = [...new Set(candidates.filter((t) => t.step === WARM_STEP).map((t) => t.repo))];
  const [sizings, warmFacts, started, batches] = await db.together(async () => await Promise.all([
    repos.length ? loadSizings(db, repos) : Promise.resolve(new Map()),
    warm?.image && warmRepos.length ? loadWarmFacts(db, warmRepos, { version: warm.version, rev: warm.rev, image: warm.image }) : Promise.resolve(new Map()),
    repos.length ? loadStartedRefs(db, { repos, openOnly: true }) : Promise.resolve(new Set<string>()),
    candidates.length ? loadBatchesByTask(db, candidates.map((t) => t.id)) : Promise.resolve(new Map()),
  ]));
  return {
    env: envRows[0] ? toEnv(envRows[0] as EnvDbRow, [], nowMs) : null, running: Number(running?.n ?? 0), candidates, otherEnvs: (others as EnvDbRow[]).map((r) => toEnv(r, [], nowMs)),
    sizings, warm: warmFacts, startedRefs: started, batches, tracked, pendingUpdate: update.pending,
  };
}

/**
 * Every environment of the kind (disabled ones too) with its claimed and running tasks, the pod runs of their tasks and those tasks,
 * and the node reservations of all runs, in one wave of 3 statements. `kubernetes` environments are the pod launcher's; `workspace`
 * reads the same environments with no runs, tasks or reservations (the workspace pass loads its own rows).
 */
export async function loadEnvPass(db: Db, kind: "kubernetes" | "workspace"): Promise<EnvPassState> {
  const q = queryDb(db);
  const nowMs = Date.now();
  const kube = kind === "kubernetes";
  const [envs, runs, tasks] = await db.together(async () => await Promise.all([
    q.all(q.k.selectFrom("build_envs as e").select(ENV_COLUMNS).where("e.kind", "=", "kubernetes").orderBy("e.id"), { label: "build.loadEnvPass" }),
    kube ? q.all(q.k.selectFrom("build_pod_runs").selectAll().orderBy("task_id"), { label: "build.loadEnvPass" }) : Promise.resolve([] as PodRun[]),
    kube ? q.all(q.k.selectFrom("build_tasks as t").select((eb) => [...TASK_COLUMNS, hasPatchExpr(eb)])
      .where((eb) => eb.or([eb("t.id", "in", eb.selectFrom("build_pod_runs").select("task_id")), eb.and([eb("t.state", "in", ["claimed", "running"]), eb("t.env_id", "in", eb.selectFrom("build_envs").select("id").where("kind", "=", "kubernetes") as never)])]))
      .orderBy("t.id"), { label: "build.loadEnvPass" }) : Promise.resolve([] as TaskDbRow[]),
  ]));
  const records = (tasks as TaskDbRow[]).map(toTask);
  const byEnv = new Map<string, EnvTasks>();
  const open = new Map<string, EnvTask[]>();
  for (const e of envs as EnvDbRow[]) byEnv.set(e.id, { runs: [], tasks: [] });
  for (const r of runs as PodRun[]) byEnv.get(r.env_id)?.runs.push(r);
  const taskById = new Map<number, TaskRecord>(records.map((t) => [t.id, t]));
  for (const [, e] of byEnv) e.tasks = e.runs.flatMap((r) => taskById.get(r.task_id) ?? []);
  for (const t of records) {
    if (t.envId && (t.state === "claimed" || t.state === "running")) {
      const row: RunningRow = { id: t.id, env_id: t.envId, step: t.step, repo: t.repo, number: t.number, plan: JSON.stringify(t.plan), results: JSON.stringify(t.results), started_at: t.startedAt, claimed_at: t.claimedAt };
      (open.get(t.envId) ?? open.set(t.envId, []).get(t.envId)!).push(toEnvTask(row));
    }
  }
  const reservations = (runs as PodRun[]).filter((r) => r.node !== null).map((r) => ({ node: r.node!, cpuM: Number(r.reserved_cpu_m ?? 0), memBytes: Number(r.reserved_mem_bytes ?? 0) }));
  return { envs: (envs as EnvDbRow[]).map((e) => toEnv(e, open.get(e.id) ?? [], nowMs)), tasks: byEnv, reservations };
}

/** Inserts a pod run (for callers that do not claim through `claimRun`) and returns it. 1 statement. */
export async function startPodRun(db: Db, row: NewPodRun): Promise<PodRun> {
  const q = queryDb(db);
  return (await q.get(q.k.insertInto("build_pod_runs").values(row as never).returningAll()))!;
}

/**
 * Applies a patch to each task's pod run: one `updateFrom` statement per distinct set of patched columns, or a plain `set` when every
 * row of such a set carries the same values. Returns the rows changed.
 */
export async function savePodRuns(db: Db, rows: { taskId: number; patch: PodRunPatch }[]): Promise<number> {
  if (rows.length === 0) return 0;
  const q = queryDb(db);
  const groups = new Map<string, { taskId: number; patch: Record<string, unknown> }[]>();
  for (const r of rows) {
    const cols = Object.keys(r.patch).sort();
    if (cols.length === 0) continue;
    const k = cols.join(",");
    (groups.get(k) ?? groups.set(k, []).get(k)!).push({ taskId: r.taskId, patch: r.patch as Record<string, unknown> });
  }
  return await db.write(async () => {
    let changed = 0;
    for (const [k, group] of groups) {
      const cols = k.split(",");
      const same = group.every((g) => cols.every((c) => g.patch[c] === group[0]!.patch[c]));
      if (same) changed += (await q.run(q.k.updateTable("build_pod_runs").set(group[0]!.patch as never).where(kx.inList(db, "task_id", group.map((g) => g.taskId), "bigint")))).changes;
      else changed += await kx.updateFrom(db, "build_pod_runs", ["task_id"], group.map((g) => ({ task_id: g.taskId, ...g.patch }) as unknown as Record<string, never>), cols);
    }
    return changed;
  });
}

/** Deletes the pod runs of tasks; returns how many. 1 statement. */
export async function removePodRuns(db: Db, taskIds: number[]): Promise<number> {
  if (taskIds.length === 0) return 0;
  const q = queryDb(db);
  return (await q.run(q.k.deleteFrom("build_pod_runs").where(kx.inList(db, "task_id", taskIds, "bigint")))).changes;
}

/** The environment and key hash of a pod task, for pod-key authentication. 1 statement. */
export async function findPodKey(db: Db, taskId: number): Promise<{ envId: string; keyHash: string; kind: string } | null> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("build_pod_runs as r").innerJoin("build_envs as e", "e.id", "r.env_id").select(["r.env_id", "r.key_hash", "e.kind"]).where("r.task_id", "=", taskId), { label: "build.findPodKey" });
  return r ? { envId: r.env_id, keyHash: r.key_hash, kind: r.kind } : null;
}

/**
 * The pod launcher's pass over a kubernetes environment in one update: capabilities, reported slots (`slots` undefined keeps them),
 * health (`health` undefined keeps it, null clears it; `since` keeps its value while text and state match `priorHealth`), and, when
 * the Kubernetes API answered, `last_seen_at` and the private clock's start.
 */
export async function reportKubeEnv(db: Db, r: { id: string; caps: unknown; slots?: number; health?: { state: string; text: string } | null; priorHealth?: { state: string; text: string; since: string } | null; reachable: boolean; at: string }): Promise<void> {
  const q = queryDb(db);
  const h = r.health;
  const health = h === undefined ? {} : {
    health: h === null ? null : JSON.stringify({ ...h, since: r.priorHealth && r.priorHealth.text === h.text && r.priorHealth.state === h.state ? r.priorHealth.since : r.at }),
    health_at: r.at,
  };
  await q.run(q.k.updateTable("build_envs").set((eb) => ({
    capabilities: JSON.stringify(r.caps), ...(r.slots === undefined ? {} : { reported_slots: r.slots }), ...health,
    ...(r.reachable ? {
      last_seen_at: r.at,
      confidential_online_at: eb.case().when(eb.and([eb("confidential", "=", 1), eb("enabled", "=", 1), eb("confidential_online_at", "is", null)])).then(r.at).else(eb.ref("confidential_online_at")).end(),
    } : {}),
  })).where("id", "=", r.id));
}
