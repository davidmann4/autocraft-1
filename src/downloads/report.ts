// The Downloads report: totals, breakdowns and release health over a time range, from the recorded polls (poll.ts) and the item mirror.
import { FORMAT_LABELS, PLATFORM_LABELS, PROCESSOR_LABELS } from "./classify.ts";
import type { Db } from "../db/index.ts";
import { countItemEvents, loadDownloadsReport } from "../data/mirror/index.ts";

export const RANGES = ["all", "today", "yesterday", "7d", "30d", "90d", "12m", "1h", "3h", "6h", "12h"] as const;
export type DownloadsRange = (typeof RANGES)[number];

export interface DownloadsBar { key: string; label: string; count: number }
export interface DownloadsReport {
  range: DownloadsRange; from: string | null; to: string;
  /** First recorded poll; ranges starting earlier only count from here. Null before the first poll. */
  historyFrom: string | null;
  apps: { repo: string; name: string }[];
  totals: { downloads: number; issuesOpened: number; issuesClosed: number; prsMerged: number; stars: number; issuesPer1k: number | null };
  byApp: { repo: string; name: string; downloads: number; stars: number }[];   // stars = gained in range, or total for "all"
  platforms: DownloadsBar[]; processors: DownloadsBar[]; formats: DownloadsBar[];
  versions: DownloadsBar[];   // top 7 releases "<App> v<x>" + "Other versions"
  releases: { repo: string; app: string; tag: string; publishedAt: string; latest: boolean; downloads: number; issues: number; per1k: number | null }[];  // newest 50
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
const DAY = 86400_000;
const HOUR = 3600_000;

/** Start and end of a range. Day ranges are UTC days ending now; hour ranges count the current hour and the ones before it. `to` is exclusive except for "now". */
export function rangeBounds(range: DownloadsRange, now: number): { from: string | null; to: string } {
  const today = now - (now % DAY);
  const hours = /^(\d+)h$/.exec(range);
  if (hours) return { from: iso(now - (now % HOUR) - (Number(hours[1]) - 1) * HOUR), to: iso(now) };
  switch (range) {
    case "all": return { from: null, to: iso(now) };
    case "today": return { from: iso(today), to: iso(now) };
    case "yesterday": return { from: iso(today - DAY), to: iso(today) };
    case "7d": return { from: iso(today - 6 * DAY), to: iso(now) };
    case "30d": return { from: iso(today - 29 * DAY), to: iso(now) };
    case "90d": return { from: iso(today - 89 * DAY), to: iso(now) };
    default: return { from: iso(today - 364 * DAY), to: iso(now) };
  }
}

const bars = (rows: { key: string | null; n: number }[], labels: Record<string, string>): DownloadsBar[] =>
  rows.filter((r) => r.key && r.n > 0).sort((a, b) => b.n - a.n).map((r) => ({ key: r.key!, label: labels[r.key!] ?? r.key!, count: r.n }));

/** `repos` are the visible tracked repos; `app` narrows the figures to one of them. */
export async function downloadsReport(db: Db, repos: string[], range: DownloadsRange, app: string | null, now = Date.now()): Promise<DownloadsReport> {
  const { from, to } = rangeBounds(range, now);
  const lo = from ?? "";
  const hi = rangeEnd(range, to);
  const view = await loadDownloadsReport(db, { repos, from, end: hi, to });
  const appRows = view.apps;
  const scope = app && appRows.some((a) => a.repo === app) ? [app] : appRows.map((a) => a.repo);
  const inScope = new Set(scope);
  const assets = view.assets.filter((a) => inScope.has(a.repo));
  const firstSeen = assets.reduce<string | null>((t, a) => (t === null || a.first_seen < t ? a.first_seen : t), null);
  const historyFrom = firstSeen ? iso(Date.parse(firstSeen)) : null;

  // Downloads per counted asset in range: the running count for "all", the recorded increases otherwise.
  const perAsset = assets.filter((a) => a.format !== null && (from !== null || a.gone_at === null)).map((a) => ({ ...a, n: from === null ? a.downloads : a.delta }));

  const sum = (key: (r: (typeof perAsset)[number]) => string | null): { key: string | null; n: number }[] => {
    const m = new Map<string | null, number>();
    for (const r of perAsset) m.set(key(r), (m.get(key(r)) ?? 0) + r.n);
    return [...m].map(([key, n]) => ({ key, n }));
  };
  const downloads = perAsset.reduce((s, r) => s + r.n, 0);

  // Stars: the total for "all", else what was gained since the range start (against the first reading when history starts later).
  const starsOf = (repo: string): number => {
    const cur = appRows.find((a) => a.repo === repo)?.stars ?? 0;
    if (from === null) return cur;
    const r = view.stars.get(repo);
    const first = r?.atStart ?? r?.first ?? null;
    if (first === null) return 0;
    if (range === "yesterday") return Math.max(0, (r?.atEnd ?? first) - first);
    return Math.max(0, cur - first);
  };

  const byApp = appRows.filter((a) => inScope.has(a.repo)).map((a) => ({
    repo: a.repo, name: a.name, downloads: perAsset.filter((r) => r.repo === a.repo).reduce((s, r) => s + r.n, 0), stars: starsOf(a.repo),
  })).sort((a, b) => b.downloads - a.downloads || a.name.localeCompare(b.name));

  // Releases with counted files, newest first.
  const relMap = new Map<string, { repo: string; tag: string; release_id: number; published: string | null; pre: number; live: number }>();
  for (const a of assets) {
    if (a.format === null) continue;
    const k = `${a.repo}\0${a.release_id}`;
    const r = relMap.get(k);
    if (!r) relMap.set(k, { repo: a.repo, tag: a.tag, release_id: a.release_id, published: a.published_at, pre: a.prerelease, live: a.gone_at === null ? 1 : 0 });
    else {
      if (a.tag > r.tag) r.tag = a.tag;
      if (a.published_at !== null && (r.published === null || a.published_at > r.published)) r.published = a.published_at;
      r.pre = Math.max(r.pre, a.prerelease);
      if (a.gone_at === null) r.live = 1;
    }
  }
  const relAll = [...relMap.values()].sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : a.release_id - b.release_id));
  relAll.sort((a, b) => (b.published ?? "").localeCompare(a.published ?? ""));
  const nameOf = new Map(appRows.map((a) => [a.repo, a.name]));
  const label = (repo: string, tag: string): string => `${nameOf.get(repo) ?? repo} v${/\d/.test(tag) ? tag.replace(/^\D*(?=\d)/, "") : tag}`;
  const perRelease = new Map<number, number>();
  for (const r of perAsset) perRelease.set(r.release_id, (perRelease.get(r.release_id) ?? 0) + r.n);
  // A release GitHub no longer lists stays only where it had downloads in the range.
  const rel = relAll.filter((r) => r.live || (perRelease.get(r.release_id) ?? 0) > 0);

  const versionRows = rel.map((r) => ({ key: `${r.repo}@${r.tag}`, n: perRelease.get(r.release_id) ?? 0, text: label(r.repo, r.tag) })).filter((r) => r.n > 0).sort((a, b) => b.n - a.n);
  const versions: DownloadsBar[] = versionRows.slice(0, 7).map((r) => ({ key: r.key, label: r.text, count: r.n }));
  const other = versionRows.slice(7).reduce((s, r) => s + r.n, 0);
  if (other > 0) versions.push({ key: "other", label: "Other versions", count: other });

  // Issues opened while a release was the newest one of its repo, within the range: one count per release window.
  const newest = new Map<string, string>();
  for (const r of rel) if (!r.pre && !newest.has(r.repo)) newest.set(r.repo, r.tag);
  const byRepo = new Map<string, typeof rel>();
  for (const r of rel) (byRepo.get(r.repo) ?? byRepo.set(r.repo, []).get(r.repo)!).push(r);
  const shown = rel.slice(0, 50);
  const windows: { repo: string; from: string; to: string }[] = [];
  const windowOf = new Map<number, number>();
  for (const r of shown) {
    const mine = byRepo.get(r.repo)!;
    const nextNewer = mine.filter((o) => (o.published ?? "") > (r.published ?? "")).map((o) => o.published!).sort()[0];
    const end = nextNewer ?? "9999";
    const start = (r.published ?? "") > lo ? (r.published ?? "") : lo;
    const upper = end < hi ? end : hi;
    if (start < upper) { windowOf.set(r.release_id, windows.length); windows.push({ repo: r.repo, from: start, to: upper }); }
  }
  const rangeWindows = scope.map((repo) => ({ repo, from: lo, to: hi }));
  const [issueCounts, closedCounts, mergedCounts] = await db.together(() => Promise.all([
    countItemEvents(db, { kind: "issue", col: "created_at", windows: [...windows, ...rangeWindows] }),
    countItemEvents(db, { kind: "issue", col: "closed_at", windows: rangeWindows }),
    countItemEvents(db, { kind: "pr", col: "merged_at", windows: rangeWindows }),
  ]));
  const total = (counts: number[]) => counts.reduce((s, n) => s + n, 0);
  const issuesOpened = total(issueCounts.slice(windows.length));
  const issuesClosed = total(closedCounts);
  const prsMerged = total(mergedCounts);
  const releases: DownloadsReport["releases"] = shown.map((r) => {
    const w = windowOf.get(r.release_id);
    const inRange = w === undefined ? 0 : issueCounts[w] ?? 0;
    const n = perRelease.get(r.release_id) ?? 0;
    return { repo: r.repo, app: nameOf.get(r.repo) ?? r.repo, tag: r.tag, publishedAt: r.published ?? "", latest: newest.get(r.repo) === r.tag, downloads: n, issues: inRange, per1k: n > 0 ? (inRange / n) * 1000 : null };
  });

  return {
    range, from, to, historyFrom,
    apps: appRows.map((a) => ({ repo: a.repo, name: a.name })),
    totals: { downloads, issuesOpened, issuesClosed, prsMerged, stars: byApp.reduce((s, a) => s + a.stars, 0), issuesPer1k: downloads > 0 ? (issuesOpened / downloads) * 1000 : null },
    byApp,
    platforms: bars(sum((r) => r.platform), PLATFORM_LABELS),
    processors: bars(sum((r) => r.processor), PROCESSOR_LABELS),
    formats: bars(sum((r) => r.format), FORMAT_LABELS),
    versions, releases,
  };
}

/** Exclusive end of a range's buckets: "to" for yesterday, a moment after now for the others (a bucket may start at "now"). */
function rangeEnd(range: DownloadsRange, to: string): string {
  return range === "yesterday" ? to : iso(Date.parse(to) + 1000);
}
