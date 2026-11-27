// Per-item GitHub detail for the item trace and the item page: a PR's changed files and commits, and the label and
// force-push events of issues and PRs. One query per item, read when the item's head or update time differs from
// the last read; the item list sync and the checks poll do not carry it.
import type { Querier } from "./mirror.ts";
import { ownerOf } from "./owners.ts";
import type { Db } from "./db/index.ts";
import { listActivityDue, saveActivity, type ActivityAttempt, type ActivityRead } from "./data/mirror/index.ts";
// Local, as in mirror.ts: importing it from review/checks.ts closes an import cycle through mirror.ts.

/** Items read per sync pass; a backlog drains over several passes. */
export const ACTIVITY_PER_PASS = 20;
/** Each read is a blocking call under the sync lock, so a pass stops starting reads after this long. */
export const ACTIVITY_PASS_MS = 15_000;
/** An item whose read failed is not read again before this long. */
const RETRY_AFTER_MS = 3_600_000;
/** Closed and merged items older than this are not read. */
export const ACTIVITY_WINDOW_MS = 14 * 86_400_000;
/** The sync leaves this many points for its other work. */
const ACTIVITY_MIN_REMAINING = 2000;
/** Files and commits per query; the same cap the other per-PR reads use. */

export const ACTIVITY_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue {
        issueTimeline: timelineItems(last: 100, itemTypes: [LABELED_EVENT, UNLABELED_EVENT]) { nodes { __typename ... on LabeledEvent { id createdAt actor { login } label { name } } ... on UnlabeledEvent { id createdAt actor { login } label { name } } } }
      }
      ... on PullRequest {
        headRefOid
        files(first: 100) { nodes { path additions deletions changeType } }
        commits(last: 100) { nodes { commit { oid messageHeadline committedDate author { user { login } } authors(first: 10) { nodes { email user { login } } } } } }
        prTimeline: timelineItems(last: 100, itemTypes: [LABELED_EVENT, UNLABELED_EVENT, HEAD_REF_FORCE_PUSHED_EVENT]) {
          nodes { __typename ... on LabeledEvent { id createdAt actor { login } label { name } } ... on UnlabeledEvent { id createdAt actor { login } label { name } } ... on HeadRefForcePushedEvent { id createdAt actor { login } beforeCommit { oid } afterCommit { oid } } }
        }
      }
    }
  }
}`;

type Node = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The logins of a commit's authors (the git author and its Co-authored-by trailers): the account GitHub matched, or the login in a users.noreply.github.com address (`<id>+<login>@` or `<login>@`). */
export function commitLogins(authors: Node[]): string[] {
  const out = new Set<string>();
  for (const a of authors) {
    const login = a?.user?.login ?? /^(?:\d+\+)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))@users\.noreply\.github\.com$/i.exec(String(a?.email ?? ""))?.[1];
    if (typeof login === "string" && login) out.add(login);
  }
  return [...out].sort();
}

/** The read of one item from its GraphQL node: events, and for a PR its files and commits. */
export function activityRead(repo: string, number: number, node: Node, item: { head: string | null; updated_at: string | null }, at: string): ActivityRead {
  const events: ActivityRead["events"] = [];
  for (const e of ((node.prTimeline ?? node.issueTimeline)?.nodes ?? []) as Node[]) {
    if (!e?.id) continue;
    const kind = e.__typename === "LabeledEvent" ? "labeled" : e.__typename === "UnlabeledEvent" ? "unlabeled" : e.__typename === "HeadRefForcePushedEvent" ? "force-push" : null;
    if (!kind) continue;
    events.push({ id: e.id, kind, at: e.createdAt, actor: e.actor?.login ?? null, label: e.label?.name ?? null, before_oid: e.beforeCommit?.oid ?? null, after_oid: e.afterCommit?.oid ?? null });
  }
  const read: ActivityRead = { repo, number, head: item.head, updatedAt: item.updated_at, readAt: at, events };
  if (node.__typename === "PullRequest") {
    const files = ((node.files?.nodes ?? []) as Node[]).filter((f) => f?.path)
      .map((f) => ({ path: f.path as string, additions: f.additions ?? 0, deletions: f.deletions ?? 0, change_type: f.changeType ?? "CHANGED" }));
    const commits = ((node.commits?.nodes ?? []) as Node[]).filter((c) => c?.commit?.oid).map((c) => {
      const authors = c.commit.authors?.nodes as Node[] | undefined;
      return { oid: c.commit.oid as string, committed_at: c.commit.committedDate as string, author: c.commit.author?.user?.login ?? null, message: c.commit.messageHeadline ?? null, co_authors: authors ? JSON.stringify(commitLogins(authors)) : null };
    });
    read.pr = { head: node.headRefOid as string, files, commits };
  }
  return read;
}

/** Items stored in one write. */
const STORE_EVERY = 20;

/**
 * Reads the items whose head or update time moved since their last read, newest update first, and the ones whose read failed once their
 * retry time passed. A failed or missing item does not stop the pass. Returns how many it read.
 */
export async function syncActivity(db: Db, client: Querier, now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - ACTIVITY_WINDOW_MS).toISOString();
  const due = await listActivityDue(db, { since, now: now.toISOString(), limit: ACTIVITY_PER_PASS });
  const started = Date.now();
  const at = now.toISOString();
  let reads: ActivityRead[] = [], attempts: ActivityAttempt[] = [];
  const retryAt = new Date(now.getTime() + RETRY_AFTER_MS).toISOString();
  // What was read is stored as the pass goes. When a write fails its items are stored one by one, so an item the database rejects is
  // recorded as a failed attempt and the rest of the pass is kept.
  const store = async (): Promise<void> => {
    const part = { reads, attempts };
    reads = []; attempts = [];
    try { await saveActivity(db, part); } catch (e) {
      if (part.reads.length === 0) throw e;
      await saveActivity(db, { reads: [], attempts: part.attempts });
      for (const r of part.reads) {
        try { await saveActivity(db, { reads: [r], attempts: [] }); } catch (one) {
          await saveActivity(db, { reads: [], attempts: [{ repo: r.repo, number: r.number, head: r.head, updatedAt: r.updatedAt, at, error: String((one as Error)?.message ?? one).slice(0, 200), retryAt }] });
        }
      }
    }
  };
  let read = 0;
  let limited: unknown = null;
  for (const it of due) {
    if (client.remaining !== null && client.remaining < ACTIVITY_MIN_REMAINING) break;
    if (read > 0 && Date.now() - started > ACTIVITY_PASS_MS) break;
    const base = { repo: it.repo, number: it.number, head: it.head, updatedAt: it.updated_at };
    try {
      const node = ((await client.query(ACTIVITY_QUERY, { owner: ownerOf(it.repo), name: it.repo, number: it.number })) as Node).repository?.issueOrPullRequest;
      // A deleted or transferred item has no node; the attempt is still recorded.
      if (node) reads.push(activityRead(it.repo, it.number, node, { head: it.head, updated_at: it.updated_at }, at));
      else attempts.push({ ...base, at });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      // The limit applies to every item; the caller logs it and the next pass starts again.
      if (/rate limit/i.test(msg)) { limited = e; break; }
      attempts.push({ ...base, at, error: msg.slice(0, 200), retryAt });
    }
    read++;
    if (reads.length + attempts.length >= STORE_EVERY) await store();
  }
  await store();
  if (limited) throw limited;
  return read;
}
