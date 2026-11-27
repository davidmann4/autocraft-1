// AutoCraft's GitHub writes on one item, read from the audit table and joined to the comments and commits they made.
// Plain rows only: the item page API maps them to its own shapes.
import { GITHUB_ACTIONS } from "../../github/actions.ts";
import { loadGithubWrites } from "../../data/views/github-writes.ts";
import { isOwnLogin, ownLogins } from "../../github/identity.ts";
import type { Db } from "../../db/index.ts";
import type { WriteLogRow } from "../../data/control/types.ts";

/** A comment written before its URL was recorded matches by time within this window. */
export const MATCH_WINDOW_MS = 120_000;

export type WriteRow = {
  rowid: number;
  at: string;
  action: string;
  /** `started` (outcome unknown), `done` or `failed`. */
  state: string;
  identity: string | null;
  url: string | null;
  review: string | null;
  head: string | null;
  sha: string | null;
  labels: string[];
  jobId: number | null;
  error: string | null;
  /** The mirrored comment or review this write made, when one is found. */
  comment: { id: string; kind: string | null; url: string | null; created_at: string | null; author: string | null } | null;
};

type CommentRow = { id: string; kind: string | null; url: string | null; created_at: string | null; author: string | null };

/** A comment without a creation time never falls inside a window. */
const timeOf = (t: string | null): number => (t === null ? NaN : Date.parse(t));

/** The writes AutoCraft made on `repo#number`, oldest first. */
export async function writesOf(db: Db, repo: string, number: number): Promise<WriteRow[]> {
  const [facts, ours] = await Promise.all([loadGithubWrites(db, [{ repo, number }]), ownLogins(db, repo)]);
  const { writes, comments } = facts.get(`${repo}#${number}`)!;
  return matchWrites(writes.filter((w) => w.action in GITHUB_ACTIONS), comments, ours);
}

/** Joins each write to the comment it made: by URL or review id, else the nearest unclaimed comment of the same kind inside the window. */
export function matchWrites(audit: WriteLogRow[], comments: CommentRow[], ours: Set<string>): WriteRow[] {
  const taken = new Set<string>();
  const byUrl = new Map(comments.filter((c) => c.url).map((c) => [c.url!, c]));
  const byId = new Map(comments.map((c) => [c.id, c]));
  const out: WriteRow[] = audit.map((a) => {
    const row: WriteRow = {
      rowid: a.rowid, at: a.at, action: a.action, state: a.state ?? "started", identity: a.identity, url: a.url, review: a.review,
      head: a.head, sha: a.commit, labels: a.labels, jobId: a.jobId, error: a.error, comment: null,
    };
    const hit = (a.url ? byUrl.get(a.url) : undefined) ?? (a.review ? byId.get(a.review) : undefined);
    if (hit) { row.comment = hit; taken.add(hit.id); }
    return row;
  });
  // Fallback for rows without a URL (crash-time rows, rows from before URLs were recorded): the nearest comment of the same kind
  // inside the window that no write of this item claimed and that the account the write used wrote.
  for (const row of out) {
    if (row.comment || row.state === "failed" || row.action.endsWith("-edit") || !/comment|review-post/.test(row.action)) continue;
    const by = row.identity?.startsWith("user:") ? new Set([row.identity.slice(5).toLowerCase()]) : ours;
    const kind = row.action === "review-post" ? "review" : "comment";
    const t = Date.parse(row.at);
    let best: CommentRow | null = null;
    for (const c of comments) {
      if (taken.has(c.id) || c.kind !== kind || !isOwnLogin(by, c.author)) continue;
      const dt = Math.abs(timeOf(c.created_at) - t);
      if (dt <= MATCH_WINDOW_MS && (!best || dt < Math.abs(timeOf(best.created_at) - t))) best = c;
    }
    if (best) { row.comment = best; taken.add(best.id); }
  }
  return out;
}

/** Whether AutoCraft pushed this commit to the item: a done push row of the write log recorded the oid as its `commit`. */
export async function pushedByAutoCraft(db: Db, repo: string, number: number, oid: string): Promise<boolean> {
  return (await pushedCommits(db, repo, number)).has(oid);
}

/** The commits AutoCraft pushed to the item: the `commit` its done push rows recorded. */
export async function pushedCommits(db: Db, repo: string, number: number): Promise<Set<string>> {
  const { writes } = (await loadGithubWrites(db, [{ repo, number }])).get(`${repo}#${number}`)!;
  return pushedIn(writes);
}

export const pushedIn = (writes: WriteLogRow[]): Set<string> =>
  new Set(writes.filter((w) => /-push$/.test(w.action) && w.state === "done" && w.commit).map((w) => w.commit!));
