// The discussion on a PR as the review prompts show it: top-level comments, review bodies and unresolved
// inline review threads, all read live from GitHub in one query. Our own posts are left out.
// Also decides when a PR's review is stale because someone else wrote on it after them.
// All text here is written by outsiders and is passed on as untrusted data.
import { createHash } from "node:crypto";
import { isBotCommand, isBotLogin } from "./bots.ts";
import { BLOCKED_EXPIRES_MS, activeFrom, loadBlockerReads, type BlockerReads } from "./blockers.ts";
import type { Querier } from "../mirror.ts";
import { FORMAL_REVIEWS, recordGate, recordGateFailure, type ReviewFact } from "../merge/changes-requested.ts";
import { ENTRY_LIMIT, TOTAL_LIMIT, type DiscussionEntry } from "./parse.ts";
import { ownerOf } from "../owners.ts";
import type { Exec } from "../fixup/git.ts";
import { pipelineMe, setPipelineLogin } from "../github/pipeline-account.ts";
import { isOwnLogin, ownLogins } from "../github/identity.ts";
import { mergeApprovedIn, mergeApprovedOf } from "../core/author-round.ts";
import type { Db } from "../db/index.ts";
import { loginsWithRole } from "../data/access/index.ts";
import { setting } from "../data/control/index.ts";
import { loadItems, loadRepos, openItemKeys } from "../data/mirror/index.ts";
import { loadDiscussionEntries, loadPosts, loadReviewFacts, loadReviewsAt, markStale, type ReviewFacts } from "../data/review/index.ts";

/** Setting that holds the pipeline account's login (also read by src/merge/queue.ts). */
const LOGIN_KEY = "pipeline_login";
/** Discussion-triggered re-reviews of one PR per UTC day; a head change or an operator request is not counted. */
export const MAX_RERUNS_PER_DAY = 3;

/** Sections whose text is tool output or instructions for other tools, not a claim about the change. */
const NOISE_SUMMARY = /prompt for|analysis chain|scripts? executed|fingerprint|committable|additional context|learnings|ai agents|review info|walkthrough|sequence diagram|related pull requests|suggested labels/i;

/** Markup removed, noisy collapsible sections dropped, the rest kept as plain text. */
export function cleanBody(s: string | null | undefined): string {
  let t = (s ?? "").replace(/<!--[\s\S]*?-->/g, "");
  const inner = /<details[^>]*>((?:(?!<details)[\s\S])*?)<\/details>/i;
  for (let m = inner.exec(t); m; m = inner.exec(t)) {
    const summary = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(m[1]!)?.[1] ?? "";
    const rest = m[1]!.replace(/<summary[^>]*>[\s\S]*?<\/summary>/i, "");
    const text = NOISE_SUMMARY.test(summary) ? "" : `${summary.replace(/<[^>]+>/g, "").trim()}\n${rest}`;
    t = t.slice(0, m.index) + text + t.slice(m.index + m[0].length);
  }
  return t.replace(/<\/?(?:details|summary|sub|sup|br|p|div|picture|source|img|a|b|i|strong|em|blockquote)\b[^>]*>/gi, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)} [cut]` : s);
const sec = (t: string): string => t.slice(0, 19);

export async function pipelineLogin(db: Db): Promise<string> {
  return await setting(db, LOGIN_KEY) ?? "";
}

/** Authors whose words trigger a new review: the PR's author and people tied to the repository. Bot accounts never do. */
const COUNTED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR"];

type Written = { author: string | null; association?: string | null; bot?: boolean; prAuthor?: string | null; state?: string | null; body: string | null; inline?: number };

/**
 * Whether a comment or review counts as new discussion: empty bodies and bare approvals never do, and neither do strangers' or bots'.
 * A review with no body but inline comments counts (the findings are in the threads).
 */
export function isCounted(w: Written): boolean {
  const body = cleanBody(w.body);
  const inline = w.inline ?? 0;
  if (!body && !inline) return false;
  if (w.state === "APPROVED" && !inline && body.length < 40) return false;
  const login = w.author ?? "";
  if (!login || w.bot || isBotLogin(login)) return false;
  if (!inline && isBotCommand(body)) return false;
  return login === w.prAuthor || COUNTED_ASSOCIATIONS.includes(w.association ?? "");
}

/**
 * Cleaned text per comment id. The queue and the Decisions page recompute discussion state on every change, and
 * cleaning every body dominated that cost. An entry is used only while its raw body is unchanged, so an edit is seen.
 */
const cleanMemo = new Map<string, { raw: string; clean: string }>();
const CLEAN_MEMO_MAX = 100_000;

function cleanedOf(id: string, body: string | null): string {
  const raw = body ?? "";
  const hit = cleanMemo.get(id);
  if (hit && hit.raw === raw) return hit.clean;
  const clean = cleanBody(raw);
  if (cleanMemo.size >= CLEAN_MEMO_MAX) cleanMemo.clear();
  cleanMemo.set(id, { raw, clean });
  return clean;
}

/** A hash of the counted entries (id and cleaned text): two snapshots with the same hash read the same discussion. */
export function discussionHash(xs: { id: string; body: string | null }[]): string {
  return createHash("sha256").update(JSON.stringify(xs.map((x) => [x.id, cleanedOf(x.id, x.body)]).sort())).digest("hex").slice(0, 16);
}

/** What a review read: when, and a hash of the counted entries. */
export type Snapshot = { seen: string; hash: string | null };

/** Comments and review bodies from the mirror: the fallback for a call that has no GitHub connection. */
async function mirrorDiscussion(db: Db, repo: string, number: number): Promise<{ entries: DiscussionEntry[]; hash: string; maint: Set<number> }> {
  const rows = (await loadDiscussionEntries(db, [{ repo, number }])).get(`${repo}#${number}`) ?? [];
  const entries: DiscussionEntry[] = [];
  const maint = new Set<number>();
  for (const r of rows) {
    const body = cleanBody(r.body);
    if (!body) continue;
    if (r.maint) maint.add(entries.length);
    entries.push({ kind: r.kind === "review" ? "review" : "comment", author: r.author, at: r.created_at, ...(r.kind === "review" ? { state: r.review_state } : {}), body: clip(body, ENTRY_LIMIT) });
  }
  return { entries, hash: discussionHash(rows.filter((r) => r.counted)), maint };
}

export const DISCUSSION_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      author { login } reviewDecision
      comments(last: 100) { nodes { id author { login __typename } authorAssociation createdAt body } }
      reviews(last: 100) { nodes { id author { login __typename } authorAssociation createdAt body state comments { totalCount } } }
      formal: ${FORMAL_REVIEWS}
      reviewThreads(last: 100) { nodes { isResolved isOutdated path line originalLine
        head: comments(first: 1) { nodes { id author { login __typename } authorAssociation createdAt body } }
        tail: comments(last: 3) { nodes { id author { login } authorAssociation body } } } }
    }
  }
}`;

type Author = { login?: string; __typename?: string } | null;
type Node = { id?: string; author?: Author; authorAssociation?: string; createdAt?: string; submittedAt?: string; body?: string; state?: string; comments?: { totalCount?: number } };
type ThreadNode = {
  isResolved?: boolean; isOutdated?: boolean; path?: string; line?: number | null; originalLine?: number | null;
  head?: { nodes?: Node[] }; tail?: { nodes?: Node[] };
};

export type LiveDiscussion = { entries: DiscussionEntry[]; snap: Snapshot; newest: string | null; /** Latest formal review of each reviewer with write access, for the changes-requested rule. */ formal: ReviewFact[]; reviewDecision: string | null;
  /** Newest counted entry written by a maintainer or dashboard user; the merge-time check goes by this, as stale reviews do. */ newestMaint: string | null;
  /** Indexes of the entries a maintainer or dashboard user other than the PR author wrote, and of threads one replied to: they are kept first within the prompt's budget. */ maint?: Set<number>;
  /** Of those, the entries the maintainer wrote (a comment, a review body, a thread they started). */ wrote?: Set<number> };

/**
 * Everything others wrote on the PR, read from GitHub (a read, never a write) in one query: comments, review
 * bodies and unresolved threads, ours excluded. `snap.seen` is the time just before the read.
 */
export async function liveDiscussion(q: Querier, db: Db, repo: string, number: number): Promise<LiveDiscussion> {
  const seen = new Date().toISOString();
  const res = await q.query(DISCUSSION_QUERY, { owner: ownerOf(repo), name: repo, number });
  const pr = res?.repository?.pullRequest;
  if (!pr) throw new Error(`${repo}#${number} not found on GitHub`);
  const own = await ownLogins(db, repo);
  const posted = new Set([...(await loadPosts(db, [{ repo, number }])).values()].map((r) => r.review_id));
  const mine = (a: Author | undefined, id?: string) => isOwnLogin(own, a?.login) || (!!id && posted.has(id));
  const prAuthor: string | null = pr.author?.login ?? null;
  const entries: DiscussionEntry[] = [];
  const counted: { id: string; body: string | null }[] = [];
  let newest: string | null = null, newestMaint: string | null = null;
  const dash = new Set((await loginsWithRole(db, ["operator", "maintainer"])).map((r) => r.toLowerCase()));
  const isMaint = (login: string | null | undefined, assoc: string | undefined) => MAINTAINER_ASSOCIATIONS.includes(assoc ?? "") || (!!login && dash.has(login.toLowerCase()));
  // The PR author's own words never rank as a maintainer's, whatever their association.
  const otherMaint = (login: string | null | undefined, assoc: string | undefined) => isMaint(login, assoc) && login !== prAuthor;
  const maint = new Set<number>(), wrote = new Set<number>();
  const take = (kind: "comment" | "review", n: Node) => {
    if (mine(n.author, n.id)) return;
    const body = cleanBody(n.body);
    if (body && otherMaint(n.author?.login, n.authorAssociation)) { maint.add(entries.length); wrote.add(entries.length); }
    if (body) entries.push({ kind, author: n.author?.login ?? null, at: n.createdAt ?? null, ...(kind === "review" ? { state: n.state ?? null } : {}), body: clip(body, ENTRY_LIMIT) });
    if (isCounted({ author: n.author?.login ?? null, association: n.authorAssociation, bot: n.author?.__typename === "Bot", prAuthor, state: n.state, body: n.body ?? null, inline: n.comments?.totalCount })) {
      counted.push({ id: n.id ?? "", body: n.body ?? null });
      if (n.createdAt && (!newest || n.createdAt > newest)) newest = n.createdAt;
      if (n.createdAt && isMaint(n.author?.login, n.authorAssociation) && (!newestMaint || n.createdAt > newestMaint)) newestMaint = n.createdAt;
    }
  };
  for (const n of (pr.comments?.nodes ?? []) as Node[]) take("comment", n);
  for (const n of (pr.reviews?.nodes ?? []) as Node[]) take("review", n);
  for (const t of (pr.reviewThreads?.nodes ?? []) as ThreadNode[]) {
    const c = t.head?.nodes?.[0];
    if (!c || t.isResolved || mine(c.author, c.id)) continue;
    const body = cleanBody(c.body);
    if (!body) continue;
    if (isCounted({ author: c.author?.login ?? null, association: c.authorAssociation, bot: c.author?.__typename === "Bot", prAuthor, body: c.body ?? null })) {
      counted.push({ id: c.id ?? "", body: c.body ?? null });
      if (c.createdAt && (!newest || c.createdAt > newest)) newest = c.createdAt;
      if (c.createdAt && isMaint(c.author?.login, c.authorAssociation) && (!newestMaint || c.createdAt > newestMaint)) newestMaint = c.createdAt;
    }
    const tail = (t.tail?.nodes ?? []).filter((r) => r.id !== c.id && !mine(r.author, r.id))
      .map((r) => ({ author: r.author?.login ?? null, body: clip(cleanBody(r.body), ENTRY_LIMIT / 2), maint: otherMaint(r.author?.login, r.authorAssociation) })).filter((r) => r.body);
    const replies = tail.map(({ author, body }) => ({ author, body }));
    // A maintainer's reply in someone else's thread ranks the thread as the maintainer's own entry would.
    if (otherMaint(c.author?.login, c.authorAssociation)) wrote.add(entries.length);
    if (otherMaint(c.author?.login, c.authorAssociation) || tail.some((r) => r.maint)) maint.add(entries.length);
    entries.push({ kind: "thread", author: c.author?.login ?? null, at: c.createdAt ?? null, path: t.path, line: t.line ?? t.originalLine ?? null, ...(t.isOutdated ? { outdated: true } : {}), body: clip(body, ENTRY_LIMIT), ...(replies.length ? { replies } : {}) });
  }
  const formal = ((pr.formal?.nodes ?? []) as Node[])
    .map((n) => ({ id: n.id ?? null, author: n.author?.login ?? null, association: n.authorAssociation ?? null, state: n.state ?? null, at: n.submittedAt ?? n.createdAt ?? null }));
  return { entries, snap: { seen, hash: discussionHash(counted) }, newest, newestMaint, formal, reviewDecision: pr.reviewDecision ?? null, maint, wrote };
}

/** Retries a read a few times: a failed read must not silently drop what reviewers wrote. */
export async function withRetry<T>(f: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await f(); } catch (e) { if (i >= tries) throw e; }
  }
}

/**
 * Entries kept within the total budget: a maintainer's or dashboard user's entries and threads they replied to (`first`, by index) before anyone else's,
 * then threads, reviews and comments (newest first within each), so neither a noisy bot nor the PR author can push out
 * the findings or a maintainer's word. The `must` entries (by index) have a budget of the same size of their own, taken first.
 * The kept entries are returned oldest first.
 */
export function fitBudget(entries: DiscussionEntry[], total = TOTAL_LIMIT, first: ReadonlySet<number> = new Set(), must: ReadonlySet<number> = new Set()): DiscussionEntry[] {
  const rank = { thread: 0, review: 1, comment: 2, note: 3 } as const;
  const order = entries.map((e, i) => ({ e, i })).sort((a, b) => Number(first.has(b.i)) - Number(first.has(a.i)) || rank[a.e.kind] - rank[b.e.kind] || b.i - a.i);
  const kept = new Set<number>();
  const fill = (part: { e: DiscussionEntry; i: number }[]) => {
    let used = 0;
    for (const { e, i } of part) {
      const n = e.body.length + (e.path?.length ?? 0) + (e.replies?.reduce((t, r) => t + r.body.length, 0) ?? 0) + 40;
      if (used + n > total) continue;
      used += n;
      kept.add(i);
    }
  };
  fill(order.filter((x) => must.has(x.i)));
  fill(order.filter((x) => !must.has(x.i)));
  const out = entries.filter((_, i) => kept.has(i));
  const dropped = entries.length - out.length;
  if (dropped) out.push({ kind: "note", body: `${dropped} more entries left out for length` });
  return out;
}

/**
 * The discussion of a PR for a review prompt and the snapshot it came from: `live` when read from GitHub, else the mirror's.
 * A maintainer's entry the model must see is a comment or review newer than `since` (the PR's previous review read the rest)
 * or an unresolved thread they started that is not outdated; these have a budget of their own.
 * `maintDropped`: such an entry still did not fit, so the snapshot covers words the model was not shown.
 */
export async function discussionOf(db: Db, repo: string, number: number, live?: LiveDiscussion, since = ""): Promise<{ entries: DiscussionEntry[]; snap: Snapshot; maintDropped: boolean }> {
  const fit = (all: DiscussionEntry[], maint: Set<number>, wrote: Set<number>, snap: Snapshot) => {
    const must = new Set([...wrote].filter((i) => (all[i]!.kind === "thread" ? !all[i]!.outdated : (all[i]!.at ?? "") > since)));
    const entries = fitBudget(all, TOTAL_LIMIT, maint, must);
    const kept = new Set(entries);
    return { entries, snap, maintDropped: [...must].some((i) => !kept.has(all[i]!)) };
  };
  if (live) return fit(live.entries, live.maint ?? new Set(), live.wrote ?? new Set(), live.snap);
  const seen = new Date().toISOString();
  const m = await mirrorDiscussion(db, repo, number);
  return fit(m.entries, m.maint, m.maint, { seen, hash: m.hash });
}

export type DiscussionState = Map<string, { newest: string; /** The hash of the counted entries. */ hash: () => Promise<string>; /** Newest counted entry by a maintainer (OWNER, MEMBER, COLLABORATOR or a dashboard user); "" when none. */ maint: string }>;

export const discussionStateOf = (facts: ReviewFacts): DiscussionState => new Map([...facts.discussion].map(([ref, d]) => [ref, { newest: d.newest, maint: d.maint, hash: async () => discussionHash(d.counted ?? []) }]));

/** The open PRs of `repo` (every repo without one) as a key source. */
const prKeys = (repo?: string) => openItemKeys({ ...(repo !== undefined ? { repos: [repo] } : {}), kind: "pr" });

/** Newest counted comment or review by someone else, and the hash of those, per open PR "repo#n" from the mirror. */
export async function discussionState(db: Db, repo?: string): Promise<DiscussionState> {
  return discussionStateOf(await loadReviewFacts(db, prKeys(repo), { now: Date.now() }));
}

/** Reads the hashes of the entries of `refs`: the loaded state carries them already. */
export async function primeHashes(_state: DiscussionState, _refs: Iterable<string>): Promise<void> {}

/** Whether the newest maintainer entry is newer than `seen`: maintainerSince() then needs the hash. */
const maintNewer = (state: { maint: string } | undefined, seen: string): boolean => !!state && !!state.maint && sec(state.maint) > sec(seen);

/** A maintainer's counted entry newer than a review's snapshot that the review did not read; PR author comments do not count. */
export async function maintainerSince(state: { newest: string; hash: () => Promise<string>; maint: string } | undefined, seen: string, hash: string | null): Promise<boolean> {
  return maintNewer(state, seen) && (await state!.hash()) !== hash;
}

/**
 * Whether a maintainer or an operator asked for a new review of the PR after `since` (the latest review's time): "Review again",
 * a merge-time check that found new discussion, or a maintainer's comment. Such a request skips the blocker, CI and daily-cap waits.
 */
export async function reviewRequestedSince(db: Db, repo: string, number: number, since: string, seen: string | null, hash: string | null, state?: DiscussionState): Promise<boolean> {
  if (state === undefined) state = await discussionState(db, repo);
  return await markedStaleSince(db, repo, number, since) || await maintainerSince(state.get(`${repo}#${number}`), seen ?? since, hash);
}

/** True when the discussion has a counted entry newer than a review's snapshot and differs from what that review read (no hash: any newer entry). */
export function changedSince(state: { newest: string; hash: string } | undefined, seen: string, hash: string | null): boolean {
  return !!state && sec(state.newest) > sec(seen) && state.hash !== hash;
}

const MAINTAINER_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];

const day = (nowMs: number) => new Date(nowMs).toISOString().slice(0, 10);
export const nextUtcMidnight = (ms: number): number => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); };

/** Whether an operator request or the merge-time discussion check marked the PR stale after `since` (such re-reviews are not counted). */
export async function markedStaleSince(db: Db, repo: string, number: number, since: string): Promise<boolean> {
  const m = (await loadReviewFacts(db, [{ repo, number }], { now: Date.now() })).marks.get(`${repo}#${number}`);
  return !!m?.staleAt && m.staleAt > since;
}

/** markedStaleSince() for the marks of a loaded set of PRs. */
export const staleMarksOf = (facts: ReviewFacts): ((repo: string, number: number, since: string) => boolean) =>
  (repo, number, since) => { const v = facts.marks.get(`${repo}#${number}`)?.staleAt; return !!v && v > since; };

/** The daily cap of discussion- and base-triggered re-reviews counts today's counter of the PR. */
const cappedToday = (facts: ReviewFacts, ref: string, now: number): boolean => {
  const m = facts.marks.get(ref);
  return !!m && m.rerunDay === day(now) && m.rerunCount >= MAX_RERUNS_PER_DAY;
};

/**
 * PRs, as "repo#n@head", whose latest Opus review read the discussion before a counted comment or review that it
 * did not read (not on a PR a person approved for merge: there only the `review` command asks for a new review, and the next
 * review reads the comment anyway), that an operator marked stale, or whose diff was read against another base branch than the PR has now
 * (a review that recorded none counts as read against the default branch). With `respectCap`, PRs that already had
 * MAX_RERUNS_PER_DAY discussion- or base-triggered re-reviews today are left out (an operator mark is never capped).
 * `now` is the time of the decision (default: the clock); `refresh` is told, per "repo#number", when the answer changes with the clock
 * alone (a blocker list expiring, the daily cap ending at UTC midnight). Open PRs only.
 */
export async function staleReviews(db: Db, repo?: string, respectCap = false, opts: StaleOpts = {}): Promise<Set<string>> {
  const keys = prKeys(repo);
  const [facts, items, repos] = await db.together(() => Promise.all([
    loadReviewFacts(db, keys, { now: opts.now ?? Date.now() }), loadItems(db, keys, "pr"), loadRepos(db, repo !== undefined ? { names: [repo] } : { all: true }),
  ]));
  const [reads, approved] = await db.together(() => Promise.all([
    loadBlockerReads(db, [...facts.latest.values()].flatMap((r) => r.blocked_by)), mergeApprovedIn(db, [...facts.latest.values()].map((r) => ({ repo: r.repo, number: r.number }))),
  ]));
  return await staleFrom({ facts, items, repos, reads, approved: (ref) => approved.has(ref) }, respectCap, opts);
}

type StaleOpts = { now?: number; refresh?: (ref: string, at: number) => void };

/** staleReviews() from its loads: `items` are the open PRs to judge, `reads` the blockers their latest reviews name, `approved` whether a person approved a PR for merge. */
export async function staleFrom(
  d: { facts: ReviewFacts; items: ReadonlyMap<string, { base_ref: string | null }>; repos: ReadonlyMap<string, { default_branch: string | null }>; reads: BlockerReads; approved: (ref: string) => boolean },
  respectCap: boolean, opts: StaleOpts = {},
): Promise<Set<string>> {
  const { facts, items, repos, reads, approved } = d;
  const now = opts.now ?? Date.now();
  const state = discussionStateOf(facts);
  const marked = staleMarksOf(facts);
  const out = new Set<string>();
  for (const [ref, r] of facts.latest) {
    const it = items.get(ref);
    if (!it) continue;
    const reviewedBase = r.base_ref ?? repos.get(r.repo)?.default_branch ?? null;
    const rebased = !!it.base_ref && !!reviewedBase && it.base_ref !== reviewedBase;
    const isMarked = marked(r.repo, r.number, r.at);
    // On a head that has a review, only a maintainer's words (or an operator's request) make it stale: the PR author's comments feed the next review but do not start one.
    // On a PR approved for merge a maintainer's words do not either: a maintainer who wants a new review says `review`.
    const talked = !approved(ref) && await maintainerSince(state.get(ref), r.seen_at ?? r.at, r.disc_hash);
    // A hold that waited for other items is reviewed once when none is open any more.
    const blocked = r.blocked_by.length > 0 ? activeFrom(reads, ref, r.blocked_by, r.at, now) : null;
    const unblocked = blocked !== null && blocked.length === 0;
    if (blocked?.length) opts.refresh?.(ref, Date.parse(r.at) + BLOCKED_EXPIRES_MS + 1);
    const capped = (talked || rebased) && respectCap && cappedToday(facts, ref, now);
    if (!isMarked && !unblocked && capped) opts.refresh?.(ref, nextUtcMidnight(now));
    if (!isMarked && !unblocked && !((talked || rebased) && !capped)) continue;
    out.add(`${ref}@${r.head}`);
  }
  return out;
}

/** Records the login that posts for us (the token's viewer) when no stage has yet, so our posts can be told from others'. */
export async function ensurePipelineLogin(db: Db, _q: Querier, run?: Exec): Promise<void> {
  if (await pipelineLogin(db)) return;
  // Never the querier's viewer: under the app identity that is the bot.
  const me = await pipelineMe(() => {}, run);
  if (me) await setPipelineLogin(db, me.login, false);
}

/**
 * Just before a merge: reads the PR's discussion and reviews live in one query. `moved`: a counted entry newer than
 * the final review's snapshot (and different from what it read) was written by a maintainer or operator (the PR author's comments are read by the next review without stopping the merge); the PR's reviews are then marked stale so the
 * pipeline reviews it again. Not on a PR a person approved for merge, which a comment that is no command does not hold back. `blocked`: a maintainer's changes-requested review stands. Either way the caller must
 * not merge. What the read saw of the formal reviews is stored in review_gates.
 */
export async function liveGate(db: Db, q: Querier, repo: string, number: number, head: string): Promise<{ moved: boolean; blocked: string | null }> {
  const live = await liveDiscussion(q, db, repo, number);
  const blocked = await recordGate(db, repo, number, live.formal, live.reviewDecision);
  const snap = (await loadReviewsAt(db, [{ repo, number, head }])).get(`${repo}#${number}@${head}`);
  if (!snap || !live.newestMaint || !changedSince({ newest: live.newestMaint, hash: live.snap.hash! }, snap.seen_at ?? snap.at, snap.disc_hash)) return { moved: false, blocked };
  if (await mergeApprovedOf(db, { repo, number })) return { moved: false, blocked };
  await markStale(db, [{ repo, number }], null);
  return { moved: true, blocked };
}

/** Operator request: its review counts as older than now, so Opus reviews it again. */
export async function markReviewsStale(db: Db, by: string, repo: string, number: number): Promise<void> {
  await markStale(db, [{ repo, number }], by);
}

/** liveGate with retries; null when the read still fails, so the caller skips the PR this run instead of merging blind. */
export async function liveGateChecked(db: Db, q: Querier, repo: string, number: number, head: string, log: (line: string) => void): Promise<{ moved: boolean; blocked: string | null } | null> {
  try {
    return await withRetry(() => liveGate(db, q, repo, number, head));
  } catch (e) {
    await recordGateFailure(db, repo, number);
    log(`  ${repo}#${number}: could not read its discussion and reviews (${String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 200)}); skipped this run`);
    return null;
  }
}
