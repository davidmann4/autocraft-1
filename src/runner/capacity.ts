// How many job processes the runner keeps at once: what the Task Runners and the build environments can serve, plus a few for
// work that needs neither, between a floor and the ceiling the database connections allow (RunnerOptions.maxJobs).
import { loadEnvs, type EnvRecord } from "../data/build/index.ts";
import { envSettings } from "../build/envs.ts";
import type { RoomState } from "../remote/room.ts";
import type { Db } from "../db/index.ts";

/** Jobs that use neither a Task Runner nor a pod: sync, classification with Jev, labels, merges, status comments. */
export const JOBS_OTHER = 6;
/** The fewest job processes, whatever the capacity reads: work that needs neither keeps running while no Task Runner is connected. */
export const JOBS_FLOOR = 8;
/** How long one reading of the capacity serves. */
export const CAPACITY_EVERY_MS = 15_000;

export type JobCapacity = {
  /** Job processes at once. */
  max: number;
  /** Slots of the fresh, ready Task Runners. */
  inference: number;
  /** Build pod or worker slots of the enabled, online, unpaused build environments, plus their workspace slots. */
  pods: number;
  other: number;
  floor: number;
  ceiling: number;
};

/** The cap from a room reading (its fresh, ready Task Runners, Manual only included: their users' started work runs there) and the build environments. */
export function jobCapacity(st: Pick<RoomState, "fresh">, envs: readonly EnvRecord[], ceiling: number): JobCapacity {
  const inference = st.fresh.reduce((n, h) => n + Math.max(0, h.slots ?? 1), 0);
  let pods = 0;
  for (const e of envs) {
    if (!e.enabled || !e.online || e.pausedReason) continue;
    pods += Math.max(0, e.slots) + (e.kind === "kubernetes" ? envSettings(e).workspaceSlots : 0);
  }
  const max = Math.min(ceiling, Math.max(JOBS_FLOOR, JOBS_OTHER + inference + pods));
  return { max, inference, pods, other: JOBS_OTHER, floor: JOBS_FLOOR, ceiling };
}

/** jobCapacity over the build environments read now. */
export async function readJobCapacity(db: Db, st: Pick<RoomState, "fresh">, ceiling: number, nowMs: number = Date.now()): Promise<JobCapacity> {
  return jobCapacity(st, await loadEnvs(db, { enabled: true, nowMs }), ceiling);
}

/** One sentence for the runner's status: the cap and where it comes from. */
export function capacityText(c: JobCapacity): string {
  const bound = c.max === c.ceiling && c.other + c.inference + c.pods > c.ceiling ? `, held at the ceiling of ${c.ceiling}` : c.max === c.floor && c.other + c.inference + c.pods < c.floor ? `, raised to the floor of ${c.floor}` : "";
  return `Up to ${c.max} jobs at once: ${c.inference} Task Runner slots, ${c.pods} build and workspace slots and ${c.other} for other work${bound}`;
}

/** The stored mark (JSON JobCapacity), or null. */
export function capacityOf(value: string | null | undefined): JobCapacity | null {
  if (!value) return null;
  try {
    const c = JSON.parse(value) as JobCapacity;
    return typeof c.max === "number" ? c : null;
  } catch { return null; }
}
