// Switches for the build features. A repo-scoped feature has one switch per repo, `build_feature:<f>:<repo>`; scan-tests
// has one instance-wide switch, `build_feature:scan-tests`. A missing row means off. The pipeline switch stops them all,
// since every feature step runs in a pipeline job.
import { cancelTasks } from "../data/build/index.ts";
import { listSettings, readConfig, saveSettings } from "../data/control/index.ts";
import { skipQueuedFeatureRuns } from "../data/merge/index.ts";
import { listEnvs } from "./envs.ts";
import { NIGHTLY_CHECKS } from "../nightly/checks.ts";
import type { Db } from "../db/index.ts";

export const BUILD_FEATURES = ["screenshots", "push-tests", "batch-build", "scan-tests", "nightly", "pr-builds", "implement"] as const;
export type BuildFeature = (typeof BUILD_FEATURES)[number];

/** Features switched per repo; the rest have one instance-wide switch. */
export const REPO_SCOPED: Record<BuildFeature, boolean> = {
  screenshots: true, "push-tests": true, "batch-build": true, "scan-tests": false, nightly: true, "pr-builds": true, implement: true,
};

/** Features whose switches the dashboard always shows: their builds run on the cluster's build pods. */
const ALWAYS_SHOWN: readonly BuildFeature[] = ["push-tests", "batch-build", "implement"];
/** The toolchains the nightly checks run in; a check whose toolchain no environment has is skipped. */
const NIGHTLY_TOOLCHAINS = new Set(NIGHTLY_CHECKS.map((c) => c.toolchain));

/**
 * The features whose switches the dashboard shows, in BUILD_FEATURES order: those always shown, Screenshots while an enabled
 * environment reports a display, and Nightly checks while one reports a nightly check's toolchain. The others (PR builds wait
 * while CI stays in GitHub Actions; scan tests need a confidential environment) keep their code and stored state.
 */
export async function shownFeatures(db: Db): Promise<BuildFeature[]> {
  const caps = (await listEnvs(db)).filter((e) => e.enabled).map((e) => e.capabilities).filter((c) => c !== null);
  const display = caps.some((c) => c.display);
  const nightly = caps.some((c) => c.toolchains.some((t) => NIGHTLY_TOOLCHAINS.has(t)));
  return BUILD_FEATURES.filter((f) => ALWAYS_SHOWN.includes(f) || (f === "screenshots" && display) || (f === "nightly" && nightly));
}

export const isFeature = (s: unknown): s is BuildFeature => typeof s === "string" && (BUILD_FEATURES as readonly string[]).includes(s);

const featureKey = (f: BuildFeature, repo?: string): string => (repo ? `build_feature:${f}:${repo}` : `build_feature:${f}`);
const readOn = async (db: Db, f: BuildFeature, repo?: string): Promise<boolean> => {
  const c = await readConfig(db, [featureKey(f, repo)]);
  return repo === undefined ? c.scanTestsEnabled : c.repo(repo).buildFeature(f);
};

/** A repo-scoped feature reads the repo's switch (off without a repo); scan-tests reads its instance-wide switch. */
export async function featureOn(db: Db, f: BuildFeature, repo?: string): Promise<boolean> {
  if (!REPO_SCOPED[f]) return await readOn(db, f);
  return repo !== undefined && await readOn(db, f, repo);
}

/** Every feature switch in one read: whether feature `f` is on for `repo`. */
export async function repoSwitches(db: Db): Promise<(f: BuildFeature, repo: string) => boolean> {
  const [rows, scanTests] = await Promise.all([listSettings(db, { scope: "repo" }), readOn(db, "scan-tests")]);
  const on = new Set(rows.filter((r) => r.value === "on").map((r) => r.key));
  return (f, repo) => REPO_SCOPED[f] ? on.has(featureKey(f, repo)) : scanTests;
}

/** The repos a repo-scoped feature is on for, sorted. */
export async function featureRepos(db: Db, f: BuildFeature): Promise<string[]> {
  if (!REPO_SCOPED[f]) return [];
  const prefix = `build_feature:${f}:`;
  return (await listSettings(db, { scope: "repo" })).filter((r) => r.key.startsWith(prefix) && r.value === "on").map((r) => r.key.slice(prefix.length)).sort();
}

/** A repo-scoped feature needs `repo`; scan-tests takes none. */
export async function setFeature(db: Db, f: BuildFeature, on: boolean, by: string, repo?: string): Promise<void> {
  if (REPO_SCOPED[f] && repo === undefined) throw new Error(`${f} is switched per repo`);
  const scoped = REPO_SCOPED[f] ? repo : undefined;
  await db.write(async () => {
    await saveSettings(db, [scoped === undefined ? { key: featureKey(f), value: on ? "on" : "off" } : { key: "build_feature", repo: `${f}:${scoped}`, value: on ? "on" : "off" }], by,
      { action: "build-feature", target: f, details: { feature: f, on, repo: scoped ?? null } });
    if (!on) await stopQueuedTasks(db, f, by, scoped);
  });
}

/** Build tasks of the features whose untrusted work is queued by the pipeline; a switch turned off stops them. */
const FEATURE_STEP: Partial<Record<BuildFeature, string>> = { "pr-builds": "pr-build", nightly: "nightly", screenshots: "screenshot" };

/** Cancels the queued and running tasks of a feature that was switched off (for one repo, or every repo), and marks the PR builds stale. */
async function stopQueuedTasks(db: Db, f: BuildFeature, by: string, repo?: string): Promise<void> {
  const step = FEATURE_STEP[f];
  if (!step) return;
  await cancelTasks(db, { step, repo }, by);
  if (f === "screenshots" || f === "pr-builds") await skipQueuedFeatureRuns(db, f, repo);
}

export async function featureStates(db: Db): Promise<{ feature: BuildFeature; on: boolean; repos: string[] }[]> {
  const rows = await listSettings(db, { scope: "repo" });
  const reposOf = (f: BuildFeature): string[] => {
    const prefix = `build_feature:${f}:`;
    return REPO_SCOPED[f] ? rows.filter((r) => r.key.startsWith(prefix) && r.value === "on").map((r) => r.key.slice(prefix.length)).sort() : [];
  };
  const instance = !REPO_SCOPED["scan-tests"] && await featureOn(db, "scan-tests");
  return BUILD_FEATURES.map((feature) => ({ feature, on: REPO_SCOPED[feature] ? false : instance, repos: reposOf(feature) }));
}
