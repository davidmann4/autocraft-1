// The discussion on a PR as the review prompts show it: top-level comments, review bodies and unresolved
// inline review threads, all read live from GitHub in one query. Our own posts are left out.
// Also decides when a PR's review is stale because someone else wrote on it after them.
// All text here is written by outsiders and is passed on as untrusted data.
import { createHash } from "node:crypto";
import { audit } from "../dash/audit.ts";
import { isBotCommand, isBotLogin } from "./bots.ts";
import { BLOCKED_EXPIRES_MS, blockersLoader, storedBlockedBy } from "./blockers.ts";
import type { Querier } from "../mirror.ts";
import { FORMAL_REVIEWS, recordGate, recordGateFailure, type ReviewFact } from "../merge/changes-requested.ts";
import { ENTRY_LIMIT, TOTAL_LIMIT, type DiscussionEntry } from "./parse.ts";
import { ownerOf } from "../owners.ts";
import type { Exec } from "../fixup/git.ts";
import { pipelineMe, setPipelineLogin } from "../github/pipeline-account.ts";
import { allOwnLogins, ownLogins } from "../github/identity.ts";
import { setting } from "../settings-read.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

/** Setting that holds the pipeline account's login (also read by src/merge/queue.ts). */
const LOGIN_KEY = "pipeline_login";
/** Prefix of the setting that marks a PR's reviews stale on an operator's request; the value is the time. */
const STALE_KEY = "review_stale:";

/** Discussion-triggered re-reviews of one PR per UTC day; a head change or an operator request is not counted. */
export const MAX_RERUNS_PER_DAY = 3;
const RERUN_KEY = "review_rerun:";

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

/** The logins notOurs excludes. With no login known, '' stands in, so authorless rows stay out as before. */
const ownList = (own: Set<string>): string[] => (own.size ? [...own] : [""]);

/** Condition for "written by someone other than us" (`c` is the comments table alias): not our logins, not our review post, and not a comment the pipeline wrote (its audited text) under an operator's own login. */
const notOurs = (db: Db, eb: kx.Eb, own: Set<string>) => eb.and([
  kx.inList(db, eb.fn.coalesce("c.author", eb.val("")), ownList(own), "text", true),
  eb("c.id", "not in", eb.selectFrom("review_posts as rp").select("rp.review_id").whereRef("rp.repo", "=", "c.repo").whereRef("rp.number", "=", "c.number")),
  eb.not(eb.exists(eb.selectFrom("main.audit as au").select(eb.lit(1).as("one")).where((a) => a.and([
    a("au.target", "=", a(a(a.ref("c.repo"), "||", a.val("#")), "||", kx.exprOf(a, "c.number"))),
    a("c.body", "is not", null),
    a(kx.jsonText(db, "au.details", "$.text"), "=", a.ref("c.body")),
  ])))),
]);

type MirrorRow = { id: string; kind: string | null; author: string | null; created_at: string | null; body: string | null; review_state: string | null; counted: number | null; maint: number };
const mirrorRows = async (db: Db, repo: string, number: number): Promise<MirrorRow[]> => {
  const own = await ownLogins(db, repo);
  return await db.all(db.k.selectFrom("comments as c")
    .select((eb) => ["c.id", "c.kind", "c.author", "c.created_at", "c.body", "c.review_state", "c.counted",
      eb.case().when(eb.and([
        eb.or([
          eb("c.author_association", "in", MAINTAINER_ASSOCIATIONS),
          eb.exists(eb.selectFrom("main.access as a").select(eb.lit(1).as("one"))
            .where((e) => e(e.fn<string>("lower", [e.ref("a.login")]), "=", e.fn<string>("lower", [e.ref("c.author")])))
            .where("a.role", "in", ["operator", "maintainer"])),
        ]),
        eb(eb.fn.coalesce("c.author", eb.val("")), "<>", eb.fn.coalesce(eb.selectFrom("items as i").select("i.author").whereRef("i.repo", "=", "c.repo").whereRef("i.number", "=", "c.number"), eb.val(""))),
      ])).then(1).else(0).end().as("maint")])
    .where("c.repo", "=", repo).where("c.number", "=", number)
    .where((eb) => notOurs(db, eb, own))
    .orderBy("c.created_at", (o) => o.asc().nullsFirst()).orderBy(kx.rowid("comments", "c")));
};

/** Comments and review bodies from the mirror: the fallback for a call that has no GitHub connection. */
async function mirrorDiscussion(db: Db, repo: string, number: number): Promise<{ entries: DiscussionEntry[]; hash: string; maint: Set<number> }> {
  const rows = await mirrorRows(db, repo, number);
  const entries: DiscussionEntry[] = [];
  const maint = new Set<number>();
  for (const r of rows) {
    const body = cleanBody(r.body);
    if (!body) continue;
    if (r.maint === 1) maint.add(entries.length);
    entries.push({ kind: r.kind === "review" ? "review" : "comment", author: r.author, at: r.created_at, ...(r.kind === "review" ? { state: r.review_state } : {}), body: clip(body, ENTRY_LIMIT) });
  }
  return { entries, hash: discussionHash(rows.filter((r) => r.counted === 1)), maint };
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
  const posted = new Set((await db.all(db.k.selectFrom("review_posts").select("review_id").where("repo", "=", repo).where("number", "=", number))).map((r) => r.review_id));
  const mine = (a: Author | undefined, id?: string) => (!!a?.login && own.has(a.login)) || (!!id && posted.has(id));
  const prAuthor: string | null = pr.author?.login ?? null;
  const entries: DiscussionEntry[] = [];
  const counted: { id: string; body: string | null }[] = [];
  let newest: string | null = null, newestMaint: string | null = null;
  const dash = new Set((await db.all(db.k.selectFrom("main.access").select("login").where("role", "in", ["operator", "maintainer"]))).map((r) => r.login.toLowerCase()));
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

const staleKey = (repo: string, number: number) => `${STALE_KEY}${repo}#${number}`;

export type DiscussionState = Map<string, { newest: string; /** The hash of the counted entries, read on first use. */ hash: () => Promise<string>; /** Newest counted entry by a maintainer (OWNER, MEMBER, COLLABORATOR or a dashboard user); "" when none. */ maint: string }>;

const MAINTAINER_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];

// The queue recomputes on every `steps` change, which comment writes don't move. Comments bump `items`, our posts
// bump `reviews`, and the pipeline login is part of the key, so an unchanged signature means unchanged input.
const stateMemo = new WeakMap<Db, Map<string, { sig: string; state: DiscussionState }>>();

/** Newest counted comment or review by someone else, and the hash of those, per PR "repo#n" from the mirror (issues are left out). Callers must not modify the result. */
export async function discussionState(db: Db, repo?: string): Promise<DiscussionState> {
  const seqs = await db.all(db.k.selectFrom("change_seq").select(["topic", "seq"]).where("topic", "in", ["items", "reviews"]).orderBy("topic"));
  const sig = JSON.stringify([seqs, [...await allOwnLogins(db)]]);
  const memo = stateMemo.get(db) ?? new Map<string, { sig: string; state: DiscussionState }>();
  stateMemo.set(db, memo);
  const key = repo ?? "";
  const hit = memo.get(key);
  if (hit && hit.sig === sig && seqs.length === 2) return hit.state;
  const state = await computeDiscussionState(db, repo);
  memo.set(key, { sig, state });
  return state;
}

async function computeDiscussionState(db: Db, repo?: string): Promise<DiscussionState> {
  const own = repo ? await ownLogins(db, repo) : await allOwnLogins(db);
  const rows = await db.all(db.k.selectFrom("comments as c")
    .select((eb) => ["c.repo", "c.number",
      eb.fn.coalesce(eb.fn.max<string | null>("c.created_at"), eb.val("")).as("newest"),
      eb.fn.coalesce(eb.fn.max<string | null>(eb.case().when(eb.or([
        eb("c.author_association", "in", MAINTAINER_ASSOCIATIONS),
        eb.exists(eb.selectFrom("main.access as a").select(eb.lit(1).as("one")).whereRef("a.login", "=", "c.author").where("a.role", "in", ["operator", "maintainer"])),
      ])).then(eb.ref("c.created_at")).end()), eb.val("")).as("maint")])
    .$if(repo !== undefined, (q) => q.where("c.repo", "=", repo!))
    .where("c.counted", "=", 1)
    .where((eb) => notOurs(db, eb, own))
    .where((eb) => eb.not(eb.exists(eb.selectFrom("main.items as i").select(eb.lit(1).as("one")).whereRef("i.repo", "=", "c.repo").whereRef("i.number", "=", "c.number").where("i.kind", "=", "issue"))))
    .groupBy(["c.repo", "c.number"]));
  // The hash needs the comment text; callers ask for it only after a newer entry than a review's snapshot, so it is read on first use (primeHashes reads many in one query).
  const known = new Map<string, string>();
  const texts = async (keys: { repo: string; number: number }[]): Promise<Map<string, { id: string; body: string | null }[]>> => {
    const by = new Map<string, { id: string; body: string | null }[]>(keys.map((k) => [`${k.repo}#${k.number}`, []]));
    for (const c of await db.all(db.k.selectFrom("comments as c")
      .innerJoin(kx.refPairs(db, keys.map((k) => [k.repo, k.number] as const), "j"), (j) => j.onRef("c.repo", "=", "j.repo").onRef("c.number", "=", "j.number"))
      .select(["c.repo", "c.number", "c.id", "c.body"])
      .where("c.counted", "=", 1).where((eb) => notOurs(db, eb, own))))
      by.get(`${c.repo}#${c.number}`)?.push(c);
    return by;
  };
  const prime = async (keys: { repo: string; number: number }[]) => {
    for (const [k, v] of await texts(keys)) known.set(k, discussionHash(v));
  };
  const rowOf = new Map(rows.map((r) => [`${r.repo}#${r.number}`, r]));
  const state: DiscussionState = new Map(rows.map((r) => {
    const k = `${r.repo}#${r.number}`;
    return [k, { newest: r.newest, maint: r.maint, hash: async () => { if (!known.has(k)) await prime([r]); return known.get(k)!; } }];
  }));
  primers.set(state, async (refs) => {
    const keys = [...new Set(refs)].filter((k) => !known.has(k)).flatMap((k) => rowOf.get(k) ?? []);
    if (keys.length) await prime(keys);
  });
  return state;
}

const primers = new WeakMap<DiscussionState, (refs: Iterable<string>) => Promise<void>>();

/** Reads the hashes of the entries of `refs` in one query; an entry not primed reads its own on first use. */
export async function primeHashes(state: DiscussionState, refs: Iterable<string>): Promise<void> {
  await primers.get(state)?.(refs);
}

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

const day = (nowMs: number) => new Date(nowMs).toISOString().slice(0, 10);
export const nextUtcMidnight = (ms: number): number => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); };
const rerunKey = (repo: string, number: number, nowMs: number = Date.now()) => `${RERUN_KEY}${repo}#${number}:${day(nowMs)}`;
/** Today's rerun counters of every PR in one read, by setting key. */
const rerunsToday = async (db: Db, nowMs: number): Promise<Map<string, string>> =>
  new Map((await db.all(db.k.selectFrom("main.settings").select(["key", "value"]).where((eb) => kx.like(db, "key", eb.val(`${kx.likeEscape(RERUN_KEY)}%:${day(nowMs)}`), "\\")))).flatMap((m) => m.value === null ? [] : [[m.key, m.value] as const]));

/** Whether an operator request or the merge-time discussion check marked the PR stale after `since` (such re-reviews are not counted). */
export async function markedStaleSince(db: Db, repo: string, number: number, since: string): Promise<boolean> {
  const v = await setting(db, staleKey(repo, number));
  return !!v && v > since;
}

/** markedStaleSince() for every PR, with the marks read in one query. */
export async function staleMarksSince(db: Db): Promise<(repo: string, number: number, since: string) => boolean> {
  const marks = new Map((await db.all(db.k.selectFrom("main.settings").select(["key", "value"]).where((eb) => kx.like(db, "key", eb.val(`${STALE_KEY}%`))))).map((m) => [m.key, m.value]));
  return (repo, number, since) => { const v = marks.get(staleKey(repo, number)); return !!v && v > since; };
}

/** Counts a same-head re-review against the PR's daily cap and forgets earlier days. */
export async function countRerun(db: Db, repo: string, number: number): Promise<void> {
  await db.run(db.k.deleteFrom("main.settings").where((eb) => kx.like(db, "key", eb.val(`${RERUN_KEY}${repo}#${number}:%`))).where("key", "<>", rerunKey(repo, number)));
  await db.run(db.k.insertInto("main.settings").values({ key: rerunKey(repo, number), value: "1" })
    .onConflict((oc) => oc.column("key").doUpdateSet((eb) => ({ value: eb.cast<string>(eb(eb.cast<number>("main.settings.value", "bigint"), "+", eb.lit(1)), "text") }))));
}

type ReviewedRow = { repo: string; number: number; head_oid: string; at: string; seen_at: string | null; disc_hash: string | null; blocked_by: string | null; rebased: number | null };

// A pass calls staleReviews() several times; the rows change only with the `items`, `reviews` and `repos` topics.
const reviewedMemo = new WeakMap<Db, Map<string, { sig: string; rows: ReviewedRow[] }>>();

async function reviewedRows(db: Db, repo?: string): Promise<ReviewedRow[]> {
  const seqs = await db.all(db.k.selectFrom("change_seq").select(["topic", "seq"]).where("topic", "in", ["items", "reviews", "repos"]).orderBy("topic"));
  const sig = JSON.stringify(seqs);
  const memo = reviewedMemo.get(db) ?? new Map<string, { sig: string; rows: ReviewedRow[] }>();
  reviewedMemo.set(db, memo);
  const hit = memo.get(repo ?? "");
  if (hit && hit.sig === sig && seqs.length === 3) return hit.rows;
  const rows = await db.all(db.k.selectFrom("opus_reviews as r")
    .leftJoin("items as i", (j) => j.onRef("i.repo", "=", "r.repo").onRef("i.number", "=", "r.number"))
    .leftJoin("repos as p", "p.name", "r.repo")
    .select((eb) => ["r.repo", "r.number", "r.head_oid", "r.at", "r.seen_at", "r.disc_hash", "r.blocked_by",
      eb.case().when(eb.and([
        eb("i.base_ref", "is not", null),
        eb(eb.fn.coalesce("r.base_ref", "p.default_branch"), "is not", null),
        eb("i.base_ref", "<>", eb.fn.coalesce("r.base_ref", "p.default_branch")),
      ])).then(1).else(0).end().as("rebased")])
    .where("r.verdict", "is not", null)
    .$if(repo !== undefined, (q) => q.where("r.repo", "=", repo!)));
  memo.set(repo ?? "", { sig, rows });
  return rows;
}

/**
 * PRs, as "repo#n@head", whose Opus review read the discussion before a counted comment or review that it
 * did not read, that an operator marked stale, or whose diff was read against another base branch than the PR has now
 * (a review that recorded none counts as read against the default branch). With `respectCap`, PRs that already had
 * MAX_RERUNS_PER_DAY discussion- or base-triggered re-reviews today are left out (an operator mark is never capped).
 * `now` is the time of the decision (default: the clock); `refresh` is told, per "repo#number", when the answer changes with the clock
 * alone (a blocker list expiring, the daily cap ending at UTC midnight).
 */
export async function staleReviews(db: Db, repo?: string, respectCap = false, opts: { now?: number; refresh?: (ref: string, at: number) => void } = {}): Promise<Set<string>> {
  const now = opts.now ?? Date.now();
  const rows = await reviewedRows(db, repo);
  const state = await discussionState(db, repo);
  await primeHashes(state, rows.filter((r) => maintNewer(state.get(`${r.repo}#${r.number}`), r.seen_at ?? r.at)).map((r) => `${r.repo}#${r.number}`));
  const marks = new Map((await db.all(db.k.selectFrom("main.settings").select(["key", "value"]).where((eb) => kx.like(db, "key", eb.val(`${STALE_KEY}%`))))).map((m) => [m.key.slice(STALE_KEY.length), m.value]));
  const out = new Set<string>();
  let todays: Map<string, string> | undefined;
  const capped = async (r: { repo: string; number: number }) => {
    todays ??= await rerunsToday(db, now);
    return Number(todays.get(rerunKey(r.repo, r.number, now)) ?? 0) >= MAX_RERUNS_PER_DAY;
  };
  let loaded: ReturnType<typeof blockersLoader> | undefined;
  const blockers = () => (loaded ??= blockersLoader(db));
  for (const r of rows) {
    const ref = `${r.repo}#${r.number}`;
    const marked = (marks.get(ref) ?? "") > r.at;
    // On a head that has a review, only a maintainer's words (or an operator's request) make it stale: the PR author's comments feed the next review but do not start one.
    const talked = await maintainerSince(state.get(ref), r.seen_at ?? r.at, r.disc_hash);
    // A hold that waited for other items is reviewed once when none is open any more.
    const blocked = !!r.blocked_by && storedBlockedBy(r.blocked_by).length > 0 ? await blockers().active(ref, r.blocked_by, r.at, now) : null;
    const unblocked = blocked !== null && blocked.length === 0;
    if (blocked?.length) opts.refresh?.(ref, Date.parse(r.at) + BLOCKED_EXPIRES_MS + 1);
    if (!marked && !unblocked && (talked || r.rebased === 1) && respectCap && await capped(r)) opts.refresh?.(ref, nextUtcMidnight(now));
    if (!marked && !unblocked && !((talked || r.rebased === 1) && !(respectCap && await capped(r)))) continue;
    out.add(`${ref}@${r.head_oid}`);
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
 * pipeline reviews it again. `blocked`: a maintainer's changes-requested review stands. Either way the caller must
 * not merge. What the read saw of the formal reviews is stored in review_gates.
 */
export async function liveGate(db: Db, q: Querier, repo: string, number: number, head: string): Promise<{ moved: boolean; blocked: string | null }> {
  const live = await liveDiscussion(q, db, repo, number);
  const blocked = await recordGate(db, repo, number, live.formal, live.reviewDecision);
  const snap = await db.get(db.k.selectFrom("opus_reviews").select((eb) => [eb.fn.coalesce("seen_at", "at").as("seen"), "disc_hash as hash"])
    .where("repo", "=", repo).where("number", "=", number).where("head_oid", "=", head).where("verdict", "is not", null));
  if (!snap || !live.newestMaint || !changedSince({ newest: live.newestMaint, hash: live.snap.hash! }, snap.seen, snap.hash)) return { moved: false, blocked };
  await db.run(db.k.insertInto("main.settings").values({ key: staleKey(repo, number), value: new Date().toISOString() }).onConflict((oc) => oc.column("key").doUpdateSet(kx.excluded(["value"]))));
  return { moved: true, blocked };
}

/** Operator request: its review counts as older than now, so Opus reviews it again. */
export async function markReviewsStale(db: Db, by: string, repo: string, number: number): Promise<void> {
  const at = new Date().toISOString();
  await db.run(db.k.insertInto("main.settings").values({ key: staleKey(repo, number), value: at }).onConflict((oc) => oc.column("key").doUpdateSet(kx.excluded(["value"]))));
  await audit(db, by, "review-again", `${repo}#${number}`, { stale: true });
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
