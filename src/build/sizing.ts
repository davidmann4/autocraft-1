// Memory and warm target of build step pods per repository. Both are automatic; a row in build_sizes holds what an
// operator set instead, or what an OOM kill taught.
//
// Memory, first match wins:
//   operator  an operator's size (`tasks sizes set --memory`): used as it is.
//   history   with AUTO_MIN_BUILDS measured builds in the last AUTO_DAYS days (the step pods' peak anonymous memory, as
//             TaskResult.peakMemBytes): the request is the median build's peak, the limit the highest peak with headroom.
//   oom       a step the kernel OOM-killed raised the memory the repository had then by OOM_RAISE (raiseAfterOom). The
//             raise is kept as a floor under the history size, so the next builds do not fall back below it.
//   environment  neither: the environment's memoryRequest and memoryLimit.
// Pods cap every size at maxPodMemory (pods.ts stepMemory).
//
// Warm target (src/build/warm-mount.ts): an operator's choice, or automatic from the size of the repository's last
// published warm version: in memory (`tmpfs`) when its memory-backed target needs at most AUTO_TMPFS_MAX_BYTES, on the
// task's volume (`pvc`) when larger, and `none` until a version is published.
import type { Db } from "../db/index.ts";
import { loadSizings, setSizes } from "../data/build/index.ts";
import { BuildError } from "./envs.ts";
import { quantity, type KubeSettings, type StepMemory } from "./pods.ts";
import { WARM_TARGETS, type WarmTarget } from "./warm-mount.ts";

export { AUTO_BUILDS, AUTO_DAYS, AUTO_LIMIT_FACTOR, AUTO_LIMIT_ROOM_BYTES, AUTO_MIN_BUILDS, AUTO_TMPFS_MAX_BYTES, autoWarmTarget } from "../data/build/index.ts";
export type { MemorySource, RepoSizing, WarmSource } from "../data/build/index.ts";
import type { RepoSizing } from "../data/build/index.ts";

/** An OOM kill raises the request and the limit by this factor. */
export const OOM_RAISE = 1.5;
const MiB = 1024 ** 2;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

const isTarget = (v: string | null | undefined): v is WarmTarget => (WARM_TARGETS as readonly string[]).includes(v ?? "");
const roundUp = (bytes: number): number => Math.ceil(bytes / MiB) * MiB;

/** What `repo`'s step pods get and why. */
export async function repoSizing(db: Db, repo: string): Promise<RepoSizing> {
  return (await loadSizings(db, [repo])).get(repo)!;
}

/** Every repository with a row, plus `repos`, sorted. */
export async function listSizings(db: Db, repos: Iterable<string> = []): Promise<RepoSizing[]> {
  const all = await loadSizings(db, "all");
  const extra = [...repos].filter((r) => !all.has(r));
  const more = extra.length ? await loadSizings(db, extra) : new Map<string, RepoSizing>();
  return [...all.values(), ...more.values()].sort((a, b) => a.repo.localeCompare(b.repo));
}

/** The repository's step memory: its sizing's, or the environment's. Pods cap it at maxPodMemory (pods.ts stepMemory). */
export async function repoMemory(db: Db, repo: string, s: KubeSettings): Promise<StepMemory> {
  return memoryOf(await repoSizing(db, repo), s);
}

/** The sizing's step memory, or the environment's when it has none. */
export const memoryOf = (sizing: RepoSizing, s: KubeSettings): StepMemory => sizing.memory ?? { requestBytes: quantity(s.memoryRequest), limitBytes: quantity(s.memoryLimit) };

/** Where the repository's build pods put a warm target. */
export async function repoWarmTarget(db: Db, repo: string): Promise<WarmTarget> {
  return (await repoSizing(db, repo)).warmTarget;
}

/** Sets the repository's warm target; `auto` returns it to the automatic choice. */
export async function setWarmTarget(db: Db, repo: string, target: string, by: string): Promise<void> {
  if (!REPO_RE.test(repo)) throw new BuildError(400, "repo is not valid");
  if (target !== "auto" && !isTarget(target)) throw new BuildError(400, `the warm target must be one of ${[...WARM_TARGETS, "auto"].join(", ")}`);
  await setSizes(db, [{ repo, warmTarget: target === "auto" ? null : target }], by);
}

/**
 * After a step of `repo` was OOM-killed: the memory it has now grows by OOM_RAISE, each at most the environment's
 * maxPodMemory and `nodeMaxBytes` (the largest node's allocatable memory, when known), and is kept as the repository's
 * floor. `raised` is false when the limit was already there, so a rerun would get no more memory.
 */
export async function raiseAfterOom(db: Db, repo: string, s: KubeSettings, nodeMaxBytes: number | null = null): Promise<{ memory: StepMemory; raised: boolean }> {
  const max = Math.min(quantity(s.maxPodMemory), nodeMaxBytes ?? Infinity);
  const before = await repoMemory(db, repo, s);
  const limit = Math.min(roundUp(before.limitBytes * OOM_RAISE), max);
  const memory = { requestBytes: Math.min(roundUp(before.requestBytes * OOM_RAISE), limit), limitBytes: limit };
  if (memory.limitBytes <= before.limitBytes && memory.requestBytes <= before.requestBytes) return { memory: before, raised: false };
  await setSizes(db, [{ repo, memory, memorySource: "oom", reason: `a step was OOM-killed at a ${gib(before.limitBytes)} limit` }], "runner");
  return { memory, raised: true };
}

export const gib = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(2).replace(/\.?0+$/, "")} GiB`;

/** An operator's size for `repo`; the limit defaults to twice the request, the environments' ratio. */
export async function setBuildSize(db: Db, repo: string, requestBytes: number, limitBytes: number | null, by: string): Promise<StepMemory> {
  if (!REPO_RE.test(repo)) throw new BuildError(400, "repo is not valid");
  const limit = limitBytes ?? requestBytes * 2;
  if (!(requestBytes > 0) || !Number.isFinite(limit) || limit < requestBytes) throw new BuildError(400, "the memory request must be above 0 and at most the limit");
  const memory = { requestBytes: Math.ceil(requestBytes), limitBytes: Math.ceil(limit) };
  await setSizes(db, [{ repo, memory }], by);
  return memory;
}

/** Returns `repo`'s memory to automatic (an operator's size and an OOM floor both go); false when it had neither. */
export async function autoBuildSize(db: Db, repo: string, by: string): Promise<boolean> {
  return (await setSizes(db, [{ repo, reset: true }], by)).get(repo) === true;
}

/** Removes `repo`'s row, so memory and warm target are both automatic again; false when it had none. */
export async function clearBuildSize(db: Db, repo: string, by: string): Promise<boolean> {
  return (await setSizes(db, [{ repo, clear: true }], by)).get(repo) === true;
}
