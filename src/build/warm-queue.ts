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
import { audit } from "../dash/audit.ts";
import { baseScopeRepos } from "../pilot.ts";
import { setting, writeSetting } from "../settings-read.ts";
import { warmPlan } from "../worker/rust.ts";
import type { Db } from "../db/index.ts";
import { envVar } from "../env.ts";
import { BuildError } from "./envs.ts";
import { settingsOf, toolchainImage, type KubeSettings } from "./pods.ts";
import { createTask, warmKeyOf, WARM_STEP } from "./tasks.ts";

export const WARM_INTERVAL_KEY = "warm_min_interval_minutes";
export const WARM_INTERVAL_DEFAULT = 15;
const WARM_INTERVAL_MAX = 24 * 60;
export const WARM_GC_KEY = "warm_gc_at";
export const WARM_GC_EVERY_MS = 24 * 3600_000;
/** Below every PR build; the warm environment takes no other task, so this orders only the Builds list. */
export const WARM_PRIORITY = -10;
const TOOLCHAINS = ["rust-stable"];

export const WARM_REPOS_KEY = "warm_repos";
export const WARM_EXCLUDED_KEY = "warm_repos_excluded";
/** `<repo> <ISO time>` of the first trimmed publish; from then on every pipeline repo is covered. */
export const WARM_TRIMMED_KEY = "warm_trimmed_publish";

async function repoList(db: Db, key: string): Promise<string[]> {
  try {
    const v = JSON.parse((await setting(db, key)) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").sort() : [];
  } catch {
    return [];
  }
}

/** The repos an operator added to the warm producer, sorted. Stored as a JSON array. */
export const warmRepos = (db: Db): Promise<string[]> => repoList(db, WARM_REPOS_KEY);

export type WarmCoverage = {
  /** Since when every pipeline repo is covered (the first trimmed publish), or null while only added repos are. */
  allSince: string | null;
  added: string[]; excluded: string[];
  /** The repos in the pipeline scope the producer builds, and why. */
  repos: { repo: string; why: "pipeline" | "added" }[];
};

export async function warmCoverage(db: Db): Promise<WarmCoverage> {
  const added = await warmRepos(db), excluded = await repoList(db, WARM_EXCLUDED_KEY);
  const trimmed = await setting(db, WARM_TRIMMED_KEY);
  const allSince = trimmed ? trimmed.split(" ")[1] ?? trimmed : null;
  const repos = [...await baseScopeRepos(db)].sort().filter((r) => !excluded.includes(r) && (allSince || added.includes(r)))
    .map((repo) => ({ repo, why: added.includes(repo) ? "added" as const : "pipeline" as const }));
  return { allSince, added, excluded, repos };
}

/** Records the first trimmed publish; later ones change nothing. */
export async function recordTrimmedPublish(db: Db, repo: string, nowMs: number): Promise<void> {
  await db.run(db.k.insertInto("main.settings").values({ key: WARM_TRIMMED_KEY, value: `${repo} ${new Date(nowMs).toISOString()}` }).onConflict((oc) => oc.column("key").doNothing()));
}

/**
 * An operator's override for `repo` (as it is tracked): `add` builds it before every pipeline repo is covered, `exclude`
 * never builds it, `remove` takes either back. Returns the coverage after the change.
 */
export async function changeWarmRepos(db: Db, action: "add" | "remove" | "exclude", repo: string, by: string): Promise<WarmCoverage> {
  if (!/^[\w.-]+(\/[\w.-]+)?$/.test(repo)) throw new BuildError(400, "a repo is written as it is tracked, e.g. owner/name");
  const lists: [string, boolean][] = [[WARM_REPOS_KEY, action === "add"], [WARM_EXCLUDED_KEY, action === "exclude"]];
  let changed = false;
  for (const [key, has] of lists) {
    const was = await repoList(db, key);
    const now = (has ? [...new Set([...was, repo])] : was.filter((r) => r !== repo)).sort();
    if (now.join() !== was.join()) {
      await writeSetting(db, key, JSON.stringify(now));
      changed = true;
    }
  }
  if (changed) await audit(db, by, "warm-repos", "builds", { action, repo });
  return await warmCoverage(db);
}

export async function warmMinInterval(db: Db): Promise<number> {
  const v = await setting(db, WARM_INTERVAL_KEY);
  const n = Number(v);
  return v !== undefined && Number.isInteger(n) && n >= 0 && n <= WARM_INTERVAL_MAX ? n : WARM_INTERVAL_DEFAULT;
}

export async function setWarmMinInterval(db: Db, input: string, by: string): Promise<number> {
  const n = /^[0-9]+$/.test(input) ? Number(input) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > WARM_INTERVAL_MAX) throw new BuildError(400, `the minimum minutes between warm builds must be a whole number from 0 to ${WARM_INTERVAL_MAX}`);
  const was = await warmMinInterval(db);
  await writeSetting(db, WARM_INTERVAL_KEY, String(n));
  if (n !== was) await audit(db, by, "warm-min-interval", "builds", { minutes: n, was });
  return n;
}

/**
 * The current default-branch head of `repo`: the head the latest main-CI poll saw. Every poll refreshes `updated_at` of the
 * head it reads, so this stays right after the branch is force-pushed back to a commit older than one stored earlier.
 */
export async function mainHead(db: Db, repo: string): Promise<string | null> {
  const r = await db.get(db.k.selectFrom("main_ci").select("head_sha").where("repo", "=", repo)
    .orderBy("updated_at", "desc").orderBy("first_seen_at", "desc").limit(1));
  return r?.head_sha ?? null;
}

const warmTasks = (db: Db, repo: string) => db.k.selectFrom("build_tasks").where("repo", "=", repo).where("step", "=", WARM_STEP);

/**
 * The warm producer's revision. Bump it whenever a change to the producer's build, trim or publish (src/warm/trim.ts, the
 * warm plan, the publish path) changes what a published warm version contains, so every repo's current head is built once
 * more: a finished warm build counts for its head only when it was queued under this revision or a later one.
 */
export const WARM_PRODUCER_REV = 2;

/** The AutoCraft version a warm task is queued under: the runner's image. A failure under another version may have been a bug since fixed. */
export const autocraftVersion = (): string => envVar("IMAGE") ?? "unknown";

/**
 * A warm build at `head` with `image` already ended; one that failed before its environment was known counts for the image
 * it was queued with. A finished one counts only when it was queued under
 * WARM_PRODUCER_REV or later (rows without a revision never do). A failed one counts only when it was queued under the current AutoCraft version (rows without a
 * version never do), so each version tries a failing head once.
 */
async function attempted(db: Db, repo: string, head: string, image: string): Promise<boolean> {
  const version = autocraftVersion();
  const rows = await db.all(warmTasks(db, repo).select(["sandbox_env", "warm_image", "warm_version", "warm_rev", "state"]).where("head_sha", "=", head).where("state", "in", ["done", "failed"]));
  return rows.filter((r) => r.state === "done" ? (r.warm_rev ?? 0) >= WARM_PRODUCER_REV : r.warm_version === version).some((r) => {
    if (!r.sandbox_env) return !r.warm_image || r.warm_image === image;
    try {
      return (JSON.parse(r.sandbox_env) as { image?: string }).image === image;
    } catch {
      return true;
    }
  });
}

const open = async (db: Db, repo: string, states: string[]): Promise<boolean> =>
  !!await db.get(warmTasks(db, repo).select("id").where("state", "in", states).limit(1));

const forcedKey = (repo: string) => `warm_rebuild:${repo}`;

/**
 * Queues a warm build of `repo` for the writer `s` when its head needs one; returns the task id, or null. `force` queues
 * one although the head was built already; warmClaim lets exactly that task through.
 */
export async function queueWarm(db: Db, repo: string, s: KubeSettings, force = false): Promise<number | null> {
  const head = await mainHead(db, repo);
  const image = toolchainImage(s, TOOLCHAINS);
  if (!head || !image || await open(db, repo, ["queued", "claimed", "running"]) || (!force && await attempted(db, repo, head, image))) return null;
  try {
    const id = await createTask(db, {
      step: WARM_STEP, repo, headSha: head, baseSha: head, requires: { os: "linux", toolchains: [...TOOLCHAINS] }, priority: WARM_PRIORITY,
      plan: warmPlan({ mirror: !!s.crateMirror }), warm: { key: warmKeyOf(repo), role: "build" }, warmImage: image, warmVersion: autocraftVersion(), warmRev: WARM_PRODUCER_REV,
    });
    if (force) await writeSetting(db, forcedKey(repo), String(id));
    return id;
  } catch (e) {
    if (e instanceof BuildError) return null;
    throw e;
  }
}

/** The enabled warm writers with their settings. */
async function writers(db: Db): Promise<{ id: string; s: KubeSettings }[]> {
  return (await db.all(db.k.selectFrom("build_envs").select(["id", "settings"]).where("kind", "=", "kubernetes").where("enabled", "=", 1).orderBy("id")))
    .map((r) => ({ id: r.id, s: settingsOf(r.settings) })).filter((w) => w.s.warmWriter);
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
  await audit(db, by, "warm-rebuild", "builds", { repo, task: id });
  return id;
}

/** Queues the warm builds the covered repos need (warmCoverage); returns how many. Nothing without an enabled warm writer. */
export async function warmPass(db: Db): Promise<number> {
  const w = (await writers(db))[0]?.s;
  if (!w) return 0;
  let n = 0;
  for (const { repo } of (await warmCoverage(db)).repos) if (await queueWarm(db, repo, w) !== null) n++;
  return n;
}

/**
 * At claim, for a writer with settings `s`: the head and plan a queued warm task of `repo` runs with, or null while it must
 * wait (another warm build of the repo runs, the last one started under the minimum interval ago, or the newest head was
 * already built with this image).
 */
export async function warmClaim(db: Db, repo: string, s: KubeSettings, nowMs: number, taskId?: number): Promise<{ head: string; plan: TaskStep[] } | null> {
  const head = await mainHead(db, repo);
  const image = toolchainImage(s, TOOLCHAINS);
  if (!head || !image || await open(db, repo, ["claimed", "running"])) return null;
  const since = new Date(nowMs - (await warmMinInterval(db)) * 60_000).toISOString();
  if (await db.get(warmTasks(db, repo).select("id").where("claimed_at", ">", since).limit(1))) return null;
  if (!(taskId !== undefined && await setting(db, forcedKey(repo)) === String(taskId)) && await attempted(db, repo, head, image)) return null;
  return { head, plan: warmPlan({ mirror: !!s.crateMirror }) };
}

/** A failed gc is tried again this long after it was taken. */
export const WARM_GC_RETRY_MS = 3 * 3600_000;

/**
 * Takes the day's gc for one warm pod: true when none ran or was taken in the last day. The time is written in the same
 * statement that decides, so pods created in one pass do not all run gc.
 */
export async function takeGc(db: Db, nowMs: number): Promise<boolean> {
  const cur = await db.get(db.k.selectFrom("main.settings").select("value").where("key", "=", WARM_GC_KEY));
  const at = new Date(nowMs).toISOString();
  if (!cur) return (await db.run(db.k.insertInto("main.settings").values({ key: WARM_GC_KEY, value: at }).onConflict((oc) => oc.column("key").doNothing()))).changes > 0;
  if (nowMs - Date.parse(cur.value ?? "") < WARM_GC_EVERY_MS) return false;
  return (await db.run(db.k.updateTable("main.settings").set({ value: at }).where("key", "=", WARM_GC_KEY).where("value", "=", cur.value))).changes > 0;
}

/** A gc that failed: the day's gc is due again after WARM_GC_RETRY_MS. */
export const releaseGc = async (db: Db, nowMs: number): Promise<void> =>
  await writeSetting(db, WARM_GC_KEY, new Date(nowMs - WARM_GC_EVERY_MS + WARM_GC_RETRY_MS).toISOString());

/** Bytes of a key's newest published version, from its last publish: what the next build's target is expected to hold. */
const bytesKey = (key: string) => `warm_bytes:${key}`;
export async function warmBytes(db: Db, key: string): Promise<number | null> {
  const n = Number(await setting(db, bytesKey(key)));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
export const recordWarmBytes = async (db: Db, key: string, bytes: number): Promise<void> => {
  if (Number.isSafeInteger(bytes) && bytes > 0) await writeSetting(db, bytesKey(key), String(bytes));
};
