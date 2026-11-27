// Which merged PRs still need a post-merge review and which defects still need an issue, from the local tables only.
import { loadQuiet } from "../data/security/index.ts";
import { config, withConfig } from "../data/control/index.ts";
import { listItems } from "../data/mirror/index.ts";
import { loadMergedInfo } from "../data/merge/index.ts";
import { CLI_BY, type By } from "../core/gates.ts";
import { listPostmergeReviewed, loadFilings, loadFollowupFixPrs, loadFollowups, loadPendingDefects, loadPostmerge, loadRecentFiled } from "../data/review/index.ts";
import { planned } from "../core/select.ts";
import type { PlanSet } from "../core/plan-set.ts";
import { filingOutcome, HELD_STUCK_MS } from "../conversations/held.ts";
import type { Finding } from "./parse.ts";
import { RETRY_AFTER_MS } from "../core/rules.ts";
import type { Db } from "../db/index.ts";

/** A review that failed with a `retry:` error is tried again after this long. */
export { RETRY_AFTER_MS };
export const SINCE_KEY = "postmerge_since";

/** `batch`: the PR landed through a merged integration batch. */
export type MergedPr = { repo: string; number: number; head_oid: string; merged_at: string; method: string | null; batch: number };

/** Re-reviews of a PR whose review ended in a `retry:` error stop after this many tries. */
export const MAX_RETRIES = 3;

/** PRs whose Plan holds a `postmerge` action: a pipeline merge that needs a review (src/core/evidence.ts landedWhy) landed since the `postmerge_since` setting and no usable review is stored (a `retry:` error counts as missing an hour after it failed; the third is stored as held). Oldest merge first. */
export async function selectPostmerge(db: Db, repo: string, now = Date.now(), run?: string | null, plans?: PlanSet, by: By = CLI_BY): Promise<MergedPr[]> {
  const rows = await planned(db, "postmerge", { repo, now, by, ...(run !== undefined ? { run } : {}), ...(plans ? { plans } : {}) });
  return [...(await mergedPrs(db, repo, rows.map((p) => p.facts.number))).values()]
    .sort((a, b) => (a.merged_at < b.merged_at ? -1 : a.merged_at > b.merged_at ? 1 : 0) || a.number - b.number);
}

/** The repos with a merged PR to review, from a pass's Plans. */
export async function postmergeRepos(db: Db, plans: PlanSet, now: number, run: string | null): Promise<string[]> {
  const due = await planned(db, "postmerge", { now, run, plans });
  const merged = due.length ? await loadMergedInfo(db, due.map((p) => ({ repo: p.facts.repo, number: p.facts.number }))) : new Map<string, unknown>();
  return [...new Set(due.filter((p) => merged.has(`${p.facts.repo}#${p.facts.number}`)).map((p) => p.facts.repo))];
}

/** The PRs among `numbers` that the pipeline merged, by number. */
async function mergedPrs(db: Db, repo: string, numbers: number[]): Promise<Map<number, MergedPr>> {
  const out = new Map<number, MergedPr>();
  if (!numbers.length) return out;
  for (const [key, m] of await loadMergedInfo(db, numbers.map((number) => ({ repo, number })))) {
    const number = Number(key.slice(key.lastIndexOf("#") + 1));
    out.set(number, { repo, number, head_oid: m.lastHead, merged_at: m.firstAt, method: m.method, batch: m.viaBatch ? 1 : 0 });
  }
  return out;
}

/** The merged PR `repo#number`, whatever its review state, or null when the pipeline did not merge it. */
export async function mergedPr(db: Db, repo: string, number: number): Promise<MergedPr | null> {
  return (await mergedPrs(db, repo, [number])).get(number) ?? null;
}

export type StoredReview = { repo: string; number: number; merge_sha: string; at: string; model: string | null; error: string | null; findings: Finding[] };

export function parseStored(json: string | null): Finding[] {
  try {
    const v = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(v) ? (v as Finding[]) : [];
  } catch { return []; }
}

export async function reviewOf(db: Db, repo: string, number: number): Promise<StoredReview | null> {
  const r = (await loadPostmerge(db, [{ repo, number }])).get(`${repo}#${number}`);
  return r ? { repo: r.repo, number: r.number, merge_sha: r.merge_sha, at: r.at, model: r.model, error: r.error, findings: r.findings as Finding[] } : null;
}

export type FollowupState = "filing" | "filed" | "failed" | "skipped-duplicate" | "skipped-limit" | "skipped-minor" | "skipped-stale" | "skipped-text";
export type Followup = { repo: string; number: number; review_at: string; finding: number; title: string; issue_number: number | null; url: string | null; state: FollowupState; at: string; duplicate_of: number | null; attempts: number; note: string | null };

export async function followupsOf(db: Db, repo: string, number: number): Promise<Followup[]> {
  return (await loadFollowups(db, [{ repo, number }])).get(`${repo}#${number}`) as Followup[] ?? [];
}

/** A failed filing is tried again this long after its attempt (1 h after the first, 6 h after the second); three attempts at most. */
export const FAILED_BACKOFF_MS = [3600_000, 6 * 3600_000];
export const MAX_ATTEMPTS = 3;

export function retryDue(f: Pick<Followup, "state" | "attempts" | "at">, now = Date.now()): boolean {
  if (f.state !== "failed") return false;
  const wait = FAILED_BACKOFF_MS[f.attempts - 1];
  return wait !== undefined && f.attempts < MAX_ATTEMPTS && now - Date.parse(f.at) >= wait;
}

/** The PR is the Fix PR of a follow-up issue this stage filed. */
export async function fixesFollowup(db: Db, repo: string, number: number): Promise<boolean> {
  return (await loadFollowupFixPrs(db, [{ repo, number }])).has(`${repo}#${number}`);
}

/**
 * Why the defects of the review `reviewAt` are never filed automatically: a follow-up of an earlier review of the PR
 * exists (filed, or filing with an unknown outcome), or the PR itself fixes a follow-up issue. The operator files one
 * with `postmerge file`.
 */
export async function heldReason(db: Db, repo: string, number: number, reviewAt: string): Promise<"earlier" | "fix" | null> {
  return await heldBy(await followupsOf(db, repo, number), async () => await fixesFollowup(db, repo, number), reviewAt);
}

async function heldBy(followups: Followup[], fixes: () => Promise<boolean>, reviewAt: string): Promise<"earlier" | "fix" | null> {
  if (followups.some((x) => (x.state === "filed" || x.state === "filing") && x.review_at !== reviewAt)) return "earlier";
  return await fixes() ? "fix" : null;
}

/** The merged PRs whose reviewed defects are filed: those in the pipeline's scope, and those outside it that were reviewed since merges outside it are (`postmerge_unscoped_since`). */
export async function filedFor(db: Db, o: { repo?: string; number?: number } = {}): Promise<{ repo: string; number: number }[]> {
  return await withConfig(db, async () => {
    const [scoped, reviewed] = await db.together(() => Promise.all([
      listItems(db, { kind: "pr", states: ["MERGED"], inScope: true, ...(o.repo !== undefined && { repos: [o.repo] }), ...(o.number !== undefined && { numbers: [o.number] }) }, "ref"),
      listPostmergeReviewed(db, { since: config(db).postmergeUnscopedSince, ...(o.repo !== undefined && { repo: o.repo }) }),
    ]));
    const out = new Map([...scoped, ...reviewed].map((m) => [`${m.repo}#${m.number}`, { repo: m.repo, number: m.number }]));
    return [...out.values()].filter((m) => o.number === undefined || m.number === o.number);
  });
}

export type PendingDefect = { repo: string; number: number; review_at: string; finding: number; f: Finding; model: string | null; attempts: number; /** Its row now. */ was?: Followup | null };

/**
 * Defects of the latest review of each PR that the filing step may still try, oldest review first: no row yet, a
 * skipped-limit row, or a failed row whose backoff has passed. A review held by `heldReason`, and the review of a quiet pull request, has none.
 */
export async function pendingDefects(db: Db, repo?: string, now = Date.now()): Promise<PendingDefect[]> {
  // A security fix gets no public text until its advisory is published: its findings stay on the dashboard.
  const merged = await filedFor(db, { ...(repo !== undefined && { repo }) });
  const quiet = await loadQuiet(db, merged.map((m) => `${m.repo}#${m.number}`));
  const keys = merged.filter((m) => !quiet.has(`${m.repo}#${m.number}`)).map((m) => ({ repo: m.repo, number: m.number }));
  return await loadPendingDefects(db, keys, { now }) as unknown as PendingDefect[];
}

/** The rows a stopped process, or one that could not record its create's outcome, left in `filing` whose audit row settles them, and when the others are old enough for that. */
export async function stuckFilings(db: Db, o: { repo?: string; now: number }): Promise<{ due: { row: Followup; outcome: NonNullable<ReturnType<typeof filingOutcome>> }[]; wakes: number[] }> {
  const rows = await loadFilings(db, { ...(o.repo !== undefined && { repo: o.repo }) });
  return {
    due: rows.flatMap(({ create, ...row }) => {
      const outcome = filingOutcome({ state: "filing", updated_at: row.at, filingAudit: create }, o.now);
      return outcome ? [{ row: row as Followup, outcome }] : [];
    }),
    wakes: rows.map((r) => Date.parse(r.at) + HELD_STUCK_MS).filter((t) => t > o.now),
  };
}

const words = (t: string): Set<string> => new Set(t.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 2));

/** Titles that name mostly the same words, after lower-casing and dropping punctuation and short words. */
export function similarTitles(a: string, b: string): boolean {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return a.trim().toLowerCase() === b.trim().toLowerCase();
  const common = [...x].filter((w) => y.has(w)).length;
  return common / (x.size + y.size - common) >= 0.5;
}

/** The same file, lines within 20 and similar titles: the defect of one cause found in overlapping PRs. */
export const sameDefect = (a: Finding, b: Finding): boolean =>
  a.file !== null && a.file === b.file && a.line !== null && b.line !== null && Math.abs(a.line - b.line) <= 20 && similarTitles(a.title, b.title);

/** Defects this stage filed (or is filing) in the last 30 days, with the finding's file and line from the review they came from. */
export async function recentFiled(db: Db, repo: string, now = Date.now()): Promise<{ number: number; f: Finding }[]> {
  return await loadRecentFiled(db, repo, { now }) as { number: number; f: Finding }[];
}

/**
 * Keeps the first of each group of same defects (list order) and names, for each other, the PR number of the one kept.
 * `seed` are defects filed earlier: a pending one that repeats one of them is a duplicate too.
 */
export function dedupeDefects(list: PendingDefect[], seed: { number: number; f: Finding }[] = []): { keep: PendingDefect[]; dupes: { d: PendingDefect; of: number }[] } {
  const keep: PendingDefect[] = [], dupes: { d: PendingDefect; of: number }[] = [];
  for (const d of list) {
    const k = seed.find((x) => sameDefect(x.f, d.f)) ?? keep.find((x) => sameDefect(x.f, d.f));
    if (k) dupes.push({ d, of: k.number }); else keep.push(d);
  }
  return { keep, dupes };
}
