// Polls GitHub release assets and star counts of the tracked repos and records the increases between polls.
// GitHub keeps only a running count per asset, so a range other than "All" fills in from the first poll onward.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readEnv } from "../github/read.ts";
import { trackedNames } from "../repos.ts";
import { ownerOf } from "../owners.ts";
import { appNameOf, classifyAsset } from "./classify.ts";
import * as mirror from "../data/mirror/index.ts";
import type { ReleaseAssetIn, ReleaseState } from "../data/mirror/index.ts";
import type { Db } from "../db/index.ts";

const run = promisify(execFile);

export const POLL_EVERY_MS = 15 * 60_000;
/** Hour buckets older than this fold into day buckets. */
export const HOUR_KEEP_MS = 48 * 3600_000;
/** The whole poll stops starting repos after this long, so the sync run is not held; repos left over are read next time. */
export const BUDGET_MS = 90_000;
const CALL_TIMEOUT_MS = 30_000;
const CONCURRENCY = 4;
/** A repo last read longer ago than this (it was untracked, or reads failed) starts a new baseline instead of recording the gap as one spike. */
export const STALE_MS = 6 * 3600_000;

export interface GhAsset { id: number; name: string; download_count: number }
export interface GhRelease { id: number; tag_name: string; name: string | null; draft: boolean; prerelease: boolean; published_at: string | null; created_at?: string; assets: GhAsset[] }
export interface RepoReleases { stars: number; releases: GhRelease[] }
export type Fetcher = (owner: string, repo: string) => Promise<RepoReleases>;

/** The real fetcher: `gh api` as the identity that reads the owner's repos. */
export const ghFetcher = (db?: Db): Fetcher => async (owner, repo) => {
  const env = await readEnv(owner, { db });
  const opts = { encoding: "utf8" as const, timeout: CALL_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024, ...(env ? { env } : {}) };
  const [rel, info] = await Promise.all([
    run("gh", ["api", "--paginate", "--slurp", `repos/${owner}/${repo}/releases?per_page=100`], opts),
    run("gh", ["api", `repos/${owner}/${repo}`, "--jq", ".stargazers_count"], opts),
  ]);
  const releases = (JSON.parse(rel.stdout) as GhRelease[][]).flat();
  return { stars: Number(info.stdout.trim()) || 0, releases };
};

/**
 * Stores one repo's reading. A repo never read before, or last read more than STALE_MS ago, gets a baseline: counts are kept,
 * no increase is recorded. An asset GitHub stops listing is marked gone (history stays) and picks up where it was if it returns.
 * `state` is the stored state of at least this repo (`pollReleases` loads it once for all repos).
 */
export async function recordRepo(db: Db, repo: string, data: RepoReleases, now: number, state?: ReleaseState): Promise<void> {
  const at = new Date(now).toISOString();
  const known = state ?? await mirror.loadReleaseState(db, [repo]);
  const mine = [...known.assets].filter(([, r]) => r.repo === repo).map(([id]) => id);
  const lastRead = known.lastRead.get(repo) ?? null;
  const baseline = mine.length === 0 || (lastRead !== null && now - Date.parse(lastRead) > STALE_MS);
  const live = data.releases.filter((r) => !r.draft);
  // One row per asset id (a listing that shifted between pages can repeat one; the last reading wins).
  const latest = new Map<number, { rel: GhRelease; a: GhAsset }>();
  for (const rel of live) for (const a of rel.assets) latest.set(a.id, { rel, a });
  const assets = [...latest.values()].map(({ rel, a }): ReleaseAssetIn => {
    const c = classifyAsset(a.name), count = a.download_count ?? 0, prev = known.assets.get(a.id)?.downloads;
    return {
      asset_id: a.id, repo, release_id: rel.id, tag: rel.tag_name, release_name: rel.name, published_at: rel.published_at ?? rel.created_at ?? null, prerelease: rel.prerelease ? 1 : 0,
      name: a.name, platform: c?.platform ?? null, processor: c?.processor ?? null, format: c?.format ?? null, downloads: count,
      delta: c ? (baseline ? 0 : prev === undefined ? count : count - prev) : 0,
    };
  });
  const counted = live.filter((r) => r.assets.some((a) => classifyAsset(a.name)));
  const newest = [...counted].sort((a, b) => Date.parse(b.published_at ?? b.created_at ?? "") - Date.parse(a.published_at ?? a.created_at ?? ""))[0];
  await mirror.saveReleaseReadings(db, [{
    repo, assets, gone: mine.filter((id) => !latest.has(id)),
    app: newest ? { name: appNameOf(newest.name, repo), stars: data.stars } : null,
  }], at);
}

/** Folds hour buckets older than 48 hours into day buckets. */
export async function foldDeltas(db: Db, now: number): Promise<void> {
  await mirror.foldDeltas(db, new Date(now).toISOString());
}

/**
 * Reads the tracked repos, up to CONCURRENCY at a time, for at most BUDGET_MS, starting at a position that moves on each poll so every repo
 * is read across polls. A repo that fails is logged and skipped. Returns the number of repos read.
 */
export async function pollReleases(db: Db, fetcher: Fetcher = ghFetcher(db), now = Date.now(), log: (line: string) => void = () => {}, budgetMs = BUDGET_MS): Promise<number> {
  const repos = await trackedNames(db);
  const offset = repos.length ? Number((await mirror.loadSyncState(db)).releases_offset ?? 0) % repos.length : 0;
  const order = [...repos.slice(offset), ...repos.slice(0, offset)];
  const state = await mirror.loadReleaseState(db, order);
  const deadline = Date.now() + budgetMs;
  let next = 0;
  let read = 0;
  const worker = async (): Promise<void> => {
    while (next < order.length && Date.now() < deadline) {
      const repo = order[next++]!;
      try {
        await recordRepo(db, repo, await fetcher(ownerOf(repo), repo), now, state);
        read++;
      } catch (e) {
        log(`releases: ${repo}: ${String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 200)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, order.length) }, worker));
  await mirror.saveSyncState(db, { releases_offset: repos.length ? (offset + next) % repos.length : 0, releases_polled_at: new Date(now).toISOString() });
  try {
    await foldDeltas(db, now);
  } catch (e) {
    log(`releases: fold: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
  log(`releases: ${read} of ${repos.length} repos read`);
  return read;
}

/** Polls when the last poll is older than POLL_EVERY_MS; the sync run calls it. */
export async function pollReleasesIfDue(db: Db, fetcher: Fetcher = ghFetcher(db), now = Date.now(), log: (line: string) => void = () => {}): Promise<boolean> {
  const at = (await mirror.loadSyncState(db)).releases_polled_at;
  if (at && now - Date.parse(at) < POLL_EVERY_MS - 5_000) return false;
  await pollReleases(db, fetcher, now, log);
  return true;
}
