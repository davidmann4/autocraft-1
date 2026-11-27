// Issue search for the Discord bot. The question is embedded in memory with the local model and compared with the stored
// vectors of public issues. The closest matches above a cosine floor are the answer, with no model call. The question is
// kept only for the length of the call: it is not stored, logged or sent anywhere.
import type { Embedder } from "../embed/model.ts";
import type { VectorIndex } from "../embed/vectors.ts";
import { DEFAULT_OWNER } from "../owners.ts";
import { isPublicRepo, publicRepoNames } from "../public/status.ts";
import { loadRepos, loadItems } from "../data/mirror/index.ts";
import { loadPublicItems } from "../data/views/public-status.ts";
import type { Db } from "../db/index.ts";

const CLOSED_WINDOW_MS = 180 * 86_400_000;
const MERGED_WINDOW_MS = 7 * 86_400_000;
/** How many nearest vectors are read before the filters (pull requests, private repos and old closed issues are dropped). */
const SCAN = 300;
/** Candidates read from the closest vectors, after the filters. */
const CANDIDATES = 20;
/** Most matches shown. */
export const MAX_MATCHES = 10;
/** Cosine floor of a match. */
export const MIN_SCORE = 0.55;
export const QUESTION_CHARS = 1000;
const USER_LIMIT = { n: 5, ms: 60_000 };
const CHANNEL_LIMIT = { n: 20, ms: 60_000 };

export type Match = { repo: string; number: number; title: string; url: string; closed: boolean; /** A pull request; `merged` when it was merged. */ pr?: boolean; merged?: boolean; reason?: string };
export type Found = { matches: Match[] };

type Candidate = Match & { body: string; score: number; activity: number; updatedAt: string };

/** Open first, then by comments plus reactions (highest first), then by the latest update. */
function byActivity(a: Candidate, b: Candidate): number {
  return Number(a.closed) - Number(b.closed) || b.activity - a.activity || b.updatedAt.localeCompare(a.updatedAt);
}

export type SearchDeps = {
  db: Db; embedder: Embedder; index: VectorIndex; log: (line: string) => void;
  now?: () => number;
};

type Fact = { repo: string; number: number; kind: string; state: string; title: string | null; body: string | null; url: string; state_reason: string | null; closed_at: string | null; merged_at: string | null; updated_at: string | null; comments_count: number | null; reactions_count: number | null };

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The one public tracked repo a question names as a whole word (case-insensitive), with the question minus that word; null when none or several are named. */
export async function namedRepo(db: Db, question: string): Promise<{ repo: string; rest: string } | null> {
  const hits = (await publicRepoNames(db)).filter((r) => new RegExp(`(?<![\\w-])${escapeRe(r)}(?![\\w-])`, "i").test(question));
  const repo = hits.length === 1 ? hits[0]! : null;
  if (!repo) return null;
  const rest = question.replace(new RegExp(`(?<![\\w-])${escapeRe(repo)}(?![\\w-])`, "gi"), " ").replace(/\s+/g, " ").trim();
  return { repo, rest: rest || question };
}

/** Matches for items a message links to or names, in that order: items of public repos the public layer shows, in any state. */
export async function linkedMatches(db: Db, refs: readonly { repo: string; number: number }[]): Promise<Match[]> {
  const isPublic = new Set(await publicRepoNames(db));
  const keep = refs.filter((r) => isPublic.has(r.repo));
  if (!keep.length) return [];
  const [items, visible] = await db.together(() => Promise.all([loadItems(db, keep, "full"), loadPublicItems(db, keep)]));
  return keep.flatMap((r) => {
    const key = `${r.repo}#${r.number}`;
    const x = items.get(key);
    if (!x || !x.url || !visible.has(key) || (x.kind !== "issue" && x.kind !== "pr")) return [];
    const pr = x.kind === "pr", merged = pr && x.merged_at !== null;
    return [{ repo: r.repo, number: r.number, title: x.title ?? "", url: x.url, closed: x.state !== "OPEN", ...(pr && { pr: true }), ...(merged && { merged: true }) }];
  });
}

export class Search {
  #d: SearchDeps;
  #hits = new Map<string, number[]>();

  constructor(deps: SearchDeps) {
    this.#d = deps;
  }

  /** Sliding-window limits per person and per channel (both given as keyed hashes). False when either is used up; a refused try is not counted. */
  allow(userKey: string, channelKey: string): boolean {
    const now = (this.#d.now ?? Date.now)();
    const live = (key: string, lim: { ms: number }): number[] => (this.#hits.get(key) ?? []).filter((t) => now - t < lim.ms);
    const u = live(`u:${userKey}`, USER_LIMIT), c = live(`c:${channelKey}`, CHANNEL_LIMIT);
    const pass = u.length < USER_LIMIT.n && c.length < CHANNEL_LIMIT.n;
    if (pass) {
      this.#hits.set(`u:${userKey}`, [...u, now]);
      this.#hits.set(`c:${channelKey}`, [...c, now]);
    } else {
      this.#hits.set(`u:${userKey}`, u);
      this.#hits.set(`c:${channelKey}`, c);
    }
    for (const [k, v] of this.#hits) if (!v.length) this.#hits.delete(k);
    return pass;
  }

  /** The closest public issues and pull requests: open ones, issues closed as completed and pull requests merged in the last 7 days. */
  async candidates(question: string, repo?: string): Promise<Candidate[]> {
    const { db, embedder, index } = this.#d;
    // An explicit repo wins; otherwise a repo named in the question restricts the search and its word is left out of the embedded text.
    let only = repo && await isPublicRepo(db, repo) ? repo : undefined;
    let text = question;
    if (!only) {
      const n = await namedRepo(db, question);
      if (n) { only = n.repo; text = n.rest; }
    }
    const [vec] = await embedder.embed([text], "query");
    if (!vec) return [];
    await index.ready(db);
    const now = (this.#d.now ?? Date.now)();
    const out: Candidate[] = [];
    const isPublic = new Set(await publicRepoNames(db));
    const hits = (await index.nearest(db, vec, SCAN, undefined, only)).filter((h) => isPublic.has(h.repo));
    if (!hits.length) return out;
    const refs = hits.map((h) => ({ repo: h.repo, number: h.number }));
    const [items, visible, repos] = await db.together(() => Promise.all([
      loadItems(db, refs, "full"), loadPublicItems(db, refs), loadRepos(db, { all: true, names: [...new Set(hits.map((h) => h.repo))] }),
    ]));
    const facts = new Map<string, Fact>();
    for (const [key, x] of items) {
      if ((x.kind !== "issue" && x.kind !== "pr") || !visible.has(key)) continue;
      const owner = repos.get(x.repo)?.owner ?? DEFAULT_OWNER;
      facts.set(key, { ...x, url: x.url ?? `https://github.com/${owner}/${x.repo}/${x.kind === "pr" ? "pull" : "issues"}/${x.number}` });
    }
    for (const h of hits) {
      const r = facts.get(`${h.repo}#${h.number}`);
      if (!r) continue;
      const open = r.state === "OPEN";
      const pr = r.kind === "pr";
      const merged = pr && r.merged_at !== null;
      // Closed issues count when completed, pull requests when merged, issues within 180 days, pull requests within 7; a pull request closed unmerged does not.
      const doneAt = pr ? (merged ? r.merged_at : null) : r.state === "CLOSED" && r.state_reason === "COMPLETED" ? r.closed_at : null;
      if (!open && !(doneAt !== null && now - Date.parse(doneAt) <= (pr ? MERGED_WINDOW_MS : CLOSED_WINDOW_MS))) continue;
      out.push({ repo: h.repo, number: h.number, title: r.title ?? "", body: r.body ?? "", url: r.url, closed: !open, ...(pr && { pr: true }), ...(merged && { merged: true }), score: h.score,
        activity: (r.comments_count ?? 0) + (r.reactions_count ?? 0), updatedAt: r.updated_at ?? "" });
      if (out.length >= CANDIDATES) break;
    }
    return out;
  }

  /** The closest matches by cosine score (at least MIN_SCORE, at most MAX_MATCHES), open first, then by activity. */
  async find(question: string, repo?: string): Promise<Found> {
    const cands = await this.candidates(question.slice(0, QUESTION_CHARS), repo);
    const strip = ({ body: _b, score: _s, activity: _a, updatedAt: _u, ...m }: Candidate): Match => m;
    return { matches: cands.filter((c) => c.score >= MIN_SCORE).slice(0, MAX_MATCHES).sort(byActivity).map(strip) };
  }
}
