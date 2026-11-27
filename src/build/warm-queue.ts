// The warm producer's queue: step `warm` tasks build the current default-branch head of each repo in the pipeline scope
// for the warm store (src/build/pods.ts warmPod, src/warm/). Only environments with `warmWriter` take them (tasks.ts claim).
// - Which repos (warmCoverage): every repo in the pipeline scope, once any repo's publish was trimmed (src/warm/trim.ts):
//   until then a publish could grow by a whole target per dependency repin, so only the repos an operator added are built.
//   An operator's `warm_repos` adds a repo before that, and `warm_repos_excluded` leaves one out.
// - The main-CI poll calls warmPass: a repo whose current head (main_ci) has no warm build with the writer's toolchain
//   image gets one queued task, unless one is already queued or running. A new head or a new toolchain image both count.
// - At claim the queued task takes the newest head, so merges that land while it waits share one build (warmClaim).
// - Builds of one repo start at least warm_min_interval_minutes apart (default 15): a burst of merges coalesces into one
//   publish. A head whose warm build failed is not built again under the same AutoCraft version; the next head or a new version is.
// - The warm store's gc runs in the producer pod at most once a day (takeGc, releaseGc).
import type { TaskStep } from "../../web/src/api/types.ts";
import { warmPlan } from "../worker/rust.ts";
import type { Db } from "../db/index.ts";
import { envVar } from "../env.ts";
import {
  loadEnvs, loadTrimmedPublish, loadWarmBytes, loadWarmFacts, QueueFullError, queueWarmTasks, recordTrimmedPublish, releaseWarmGc, saveWarmBytes, takeWarmGc, warmClaimGate, warmGate, WARM_PRIORITY,
} from "../data/build/index.ts";
import type { WarmFacts } from "../data/build/index.ts";
import { addAudit, readConfig, saveSettings } from "../data/control/index.ts";
import { loadLatestMainHeads } from "../data/mirror/index.ts";
import { BuildError, envSettings } from "./envs.ts";
import { currentJobId } from "../agents/call.ts";
import { scopeRepos } from "../runner/scope.ts";
import { toolchainImage, type KubeSettings } from "./pods.ts";

export { recordTrimmedPublish, WARM_PRIORITY };
export const WARM_INTERVAL_KEY = "warm_min_interval_minutes";
export const WARM_INTERVAL_DEFAULT = 15;
const WARM_INTERVAL_MAX = 24 * 60;
const TOOLCHAINS = ["rust-stable"];

export const WARM_REPOS_KEY = "warm_repos";
export const WARM_EXCLUDED_KEY = "warm_repos_excluded";
const CONFIG_KEYS = [WARM_REPOS_KEY, WARM_EXCLUDED_KEY, WARM_INTERVAL_KEY];

/** The repos an operator added to the warm producer, sorted. */
export const warmRepos = async (db: Db): Promise<string[]> => (await readConfig(db, CONFIG_KEYS)).warmRepos;

export type WarmCoverage = {
  /** Since when every pipeline repo is covered (the first trimmed publish), or null while only added repos are. */
  allSince: string | null;
  added: string[]; excluded: string[];
  /** The repos in the pipeline scope the producer builds, and why. */
  repos: { repo: string; why: "pipeline" | "added" }[];
};

export async function warmCoverage(db: Db): Promise<WarmCoverage> {
  const [c, inScope, trimmed] = await Promise.all([readConfig(db, CONFIG_KEYS), scopeRepos(db, { for: "builds" }), loadTrimmedPublish(db)]);
  const added = c.warmRepos, excluded = c.warmReposExcluded;
  const allSince = trimmed ? trimmed.at : null;
  const repos = [...inScope].sort().filter((r) => !excluded.includes(r) && (allSince || added.includes(r)))
    .map((repo) => ({ repo, why: added.includes(repo) ? "added" as const : "pipeline" as const }));
  return { allSince, added, excluded, repos };
}

/**
 * An operator's override for `repo` (as it is tracked): `add` builds it before every pipeline repo is covered, `exclude`
 * never builds it, `remove` takes either back. Returns the coverage after the change.
 */
export async function changeWarmRepos(db: Db, action: "add" | "remove" | "exclude", repo: string, by: string): Promise<WarmCoverage> {
  if (!/^[\w.-]+(\/[\w.-]+)?$/.test(repo)) throw new BuildError(400, "a repo is written as it is tracked, e.g. owner/name");
  const c = await readConfig(db, CONFIG_KEYS);
  const lists: [string, string[], boolean][] = [[WARM_REPOS_KEY, c.warmRepos, action === "add"], [WARM_EXCLUDED_KEY, c.warmReposExcluded, action === "exclude"]];
  const changes = lists.flatMap(([key, was, has]) => {
    const now = (has ? [...new Set([...was, repo])] : was.filter((r) => r !== repo)).sort();
    return now.join() !== was.join() ? [{ key, value: JSON.stringify(now) }] : [];
  });
  if (changes.length) await saveSettings(db, changes, by, { action: "warm-repos", target: "builds", details: { action, repo } });
  return await warmCoverage(db);
}

export const warmMinInterval = async (db: Db): Promise<number> => (await readConfig(db, CONFIG_KEYS)).warmMinIntervalMinutes;

export async function setWarmMinInterval(db: Db, input: string, by: string): Promise<number> {
  const n = /^[0-9]+$/.test(input) ? Number(input) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > WARM_INTERVAL_MAX) throw new BuildError(400, `the minimum minutes between warm builds must be a whole number from 0 to ${WARM_INTERVAL_MAX}`);
  const was = await warmMinInterval(db);
  if (n !== was) await saveSettings(db, [{ key: WARM_INTERVAL_KEY, value: String(n) }], by, { action: "warm-min-interval", target: "builds", details: { minutes: n, was } });
  return n;
}

/**
 * The current default-branch head of `repo`: the head the latest main-CI poll saw. Every poll refreshes `updated_at` of the
 * head it reads, so this stays right after the branch is force-pushed back to a commit older than one stored earlier.
 */
export async function mainHead(db: Db, repo: string): Promise<string | null> {
  return (await loadLatestMainHeads(db, [repo])).get(repo)?.head_sha ?? null;
}

/**
 * The warm producer's revision. Bump it whenever a change to the producer's build, trim or publish (src/warm/trim.ts, the
 * warm plan, the publish path) changes what a published warm version contains, so every repo's current head is built once
 * more: a finished warm build counts for its head only when it was queued under this revision or a later one.
 */
export const WARM_PRODUCER_REV = 2;

/** The AutoCraft version a warm task is queued under: the runner's image. A failure under another version may have been a bug since fixed. */
export const autocraftVersion = (): string => envVar("IMAGE") ?? "unknown";

/** The warm facts of `repos` for the writer's toolchain `image`, under the current AutoCraft version and producer revision. */
export const loadWarm = async (db: Db, repos: string[], image: string): Promise<Map<string, WarmFacts>> =>
  await loadWarmFacts(db, repos, { version: autocraftVersion(), rev: WARM_PRODUCER_REV, image });

/** Queues the warm builds for `repos` whose gate says so, in one call; returns the task id per queued repo. A full queue queues none. */
async function queueWarmFor(db: Db, repos: string[], s: KubeSettings, force: boolean): Promise<Map<string, number>> {
  const image = toolchainImage(s, TOOLCHAINS);
  if (!image || !repos.length) return new Map();
  const facts = await loadWarm(db, repos, image);
  const rows = repos.flatMap((repo) => {
    const f = facts.get(repo);
    return f && warmGate(f, Date.now(), force) === "queue" ? [{ repo, head: f.head!, image, plan: warmPlan({ mirror: !!s.crateMirror }), version: autocraftVersion(), rev: WARM_PRODUCER_REV, force, jobId: currentJobId() }] : [];
  });
  try {
    return await queueWarmTasks(db, rows);
  } catch (e) {
    if (e instanceof QueueFullError) return new Map();
    throw e;
  }
}

/**
 * Queues a warm build of `repo` for the writer `s` when its head needs one; returns the task id, or null. `force` queues
 * one although the head was built already; the claim lets exactly that task through.
 */
export async function queueWarm(db: Db, repo: string, s: KubeSettings, force = false): Promise<number | null> {
  return (await queueWarmFor(db, [repo], s, force)).get(repo) ?? null;
}

/** The enabled warm writers with their settings. */
async function writers(db: Db): Promise<{ id: string; s: KubeSettings }[]> {
  return (await loadEnvs(db, { kind: "kubernetes", enabled: true })).map((r) => ({ id: r.id, s: envSettings(r) })).filter((w) => w.s.warmWriter);
}

/** The warm writer warmPass queues for and the toolchain image its builds run with; null without an enabled writer. */
export async function warmWriter(db: Db): Promise<{ env: string; image: string | null } | null> {
  const w = (await writers(db))[0];
  return w ? { env: w.id, image: toolchainImage(w.s, TOOLCHAINS) } : null;
}

/** The toolchain image a warm task ran with: its environment's, else the one it was queued with. */
export function warmTaskImage(r: { sandbox_env: string | null; warm_image: string | null }): string | null {
  if (!r.sandbox_env) return r.warm_image;
  try {
    return (JSON.parse(r.sandbox_env) as { image?: string }).image ?? r.warm_image;
  } catch {
    return r.warm_image;
  }
}

/** Queues a warm build of `repo`'s current head now, built already or not; throws when the repo is not covered or none can be queued. */
export async function rebuildWarm(db: Db, repo: string, by: string): Promise<number> {
  const w = (await writers(db))[0]?.s;
  if (!w) throw new BuildError(409, "no enabled warm writer environment");
  if (!(await warmCoverage(db)).repos.some((r) => r.repo === repo)) throw new BuildError(400, `${repo} is not tracked in the pipeline scope or not covered by warm builds`);
  const id = await queueWarm(db, repo, w, true);
  if (id === null) throw new BuildError(409, `${repo} has no known head, or a warm build of it is queued or running already`);
  await addAudit(db, [{ login: by, action: "warm-rebuild", target: "builds", details: { repo, task: id } }]);
  return id;
}

/** Queues the warm builds the covered repos need (warmCoverage); returns how many. Nothing without an enabled warm writer. */
export async function warmPass(db: Db): Promise<number> {
  const w = (await writers(db))[0]?.s;
  if (!w) return 0;
  return (await queueWarmFor(db, (await warmCoverage(db)).repos.map((r) => r.repo), w, false)).size;
}

/**
 * At claim, for a writer with settings `s` and the repo's `facts`: the head and plan a queued warm task runs with, or null while
 * it must wait (another warm build of the repo runs, the last one started under the minimum interval ago, or the newest head was
 * already built with this image).
 */
export function warmClaim(facts: WarmFacts | undefined, s: KubeSettings, nowMs: number, taskId: number, minIntervalMinutes: number): { head: string; plan: TaskStep[] } | null {
  if (!facts?.head || !toolchainImage(s, TOOLCHAINS)) return null;
  return warmClaimGate(facts, nowMs, taskId, minIntervalMinutes * 60_000) === "claim" ? { head: facts.head, plan: warmPlan({ mirror: !!s.crateMirror }) } : null;
}

/**
 * Takes the day's gc for one warm pod: true when none ran or was taken in the last day. The time is written in the same
 * statement that decides, so pods created in one pass do not all run gc.
 */
export const takeGc = async (db: Db, nowMs: number): Promise<boolean> => await takeWarmGc(db, nowMs);

/** A gc that failed: the day's gc is due again soon. */
export const releaseGc = async (db: Db, nowMs: number): Promise<void> => await releaseWarmGc(db, nowMs);

/** Bytes of a key's newest published version, from its last publish: what the next build's target is expected to hold. */
export async function warmBytes(db: Db, key: string): Promise<number | null> {
  return (await loadWarmBytes(db, [key])).get(key) ?? null;
}
export const recordWarmBytes = async (db: Db, key: string, bytes: number): Promise<void> => await saveWarmBytes(db, [{ key, bytes }]);
