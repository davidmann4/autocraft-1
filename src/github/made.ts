// Looks on GitHub for a write whose answer was lost (a crash, a timeout, a dropped connection): the audit row holds the exact text and
// the time the write began, so a comment, issue or review of ours with that text made since then, and not recorded as another write's
// (`taken`), is that write. Read-only. Each throws when GitHub cannot be read: the outcome is then still unknown and the write must not
// be made again.
import { slugOf } from "../owners.ts";
import type { Db } from "../db/index.ts";
import { isOwnLogin, ownLogins } from "./identity.ts";
import type { Querier } from "../mirror.ts";

/** Runs `gh` with these arguments and returns its output; throws when it fails. */
export type GhRead = (args: string[]) => Promise<string>;

/** Allowed difference between this machine's clock and GitHub's. */
const SKEW_MS = 2 * 60_000;
const from = (since: string): string => new Date(Date.parse(since) - SKEW_MS).toISOString();
const text = (s: unknown): string => String(s ?? "").replace(/\r\n/g, "\n").trim();
const rows = <T>(out: string): T[] => out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);

/** Whether the author of what is found is who made the write. */
type Author = (login: string | null | undefined) => boolean;
type Where = { since: string; mine: Author; taken?: ReadonlySet<string> };

/** Passes our own logins, and any login while none of ours is recorded. */
export async function byUs(db: Db): Promise<Author> {
  const own = await ownLogins(db, "");
  return (login) => own.size === 0 || isOwnLogin(own, login);
}

const PAGE = 100;

/** The issue with this title and body opened in the repo since `since`; a person may have edited one of the two since. */
export async function issueMade(read: GhRead, o: Where & { repo: string; title: string; body: string }): Promise<{ number: number; url: string } | null> {
  const since = from(o.since);
  const old = (r: { at: string }): boolean => Date.parse(r.at) < Date.parse(since);
  const found: { number: number; url: string; rank: number }[] = [];
  for (let page = 1; ; page++) {
    const list = rows<{ number: number; url: string; title: string; body: string | null; by?: string | null; pr?: boolean; at: string }>(await read(["api",
      `repos/${slugOf(o.repo)}/issues?state=all&sort=created&direction=desc&per_page=${PAGE}&page=${page}&since=${encodeURIComponent(since)}`,
      "--jq", ".[] | {number, url: .html_url, title, body, by: .user.login, pr: (.pull_request != null), at: .created_at} | tojson"]));
    for (const r of list) {
      const rank = (text(r.body) === text(o.body) ? 2 : 0) + (text(r.title) === text(o.title) ? 1 : 0);
      if (rank && !r.pr && !old(r) && o.mine(r.by) && !o.taken?.has(r.url)) found.push({ number: r.number, url: r.url, rank });
    }
    if (list.length < PAGE || list.some(old)) break;
  }
  const hit = found.sort((a, b) => b.rank - a.rank)[0];
  return hit ? { number: hit.number, url: hit.url } : null;
}

/** The id of the repo's draft security advisory with this summary and description (or its first part: one route adds a section) created since `since`. */
export async function advisoryMade(read: GhRead, o: Omit<Where, "mine"> & { repo: string; summary: string; description: string }): Promise<string | null> {
  const want = text(o.description);
  const same = (d: string): boolean => d === want || (d !== "" && want !== "" && (d.startsWith(want) || want.startsWith(d)));
  const out = await read(["api", "--paginate", `repos/${slugOf(o.repo)}/security-advisories?state=draft&sort=created&direction=desc&per_page=100`,
    "--jq", ".[] | {id: .ghsa_id, summary, description, at: .created_at} | tojson"]);
  return rows<{ id: string; summary: string; description: string | null; at: string }>(out)
    .find((r) => Date.parse(r.at) >= Date.parse(from(o.since)) && text(r.summary) === text(o.summary) && same(text(r.description)) && !o.taken?.has(r.id))?.id ?? null;
}

/** The URL of the comment with this text made on the issue or PR since `since`. */
export async function commentMade(read: GhRead, o: Where & { repo: string; number: number; body: string }): Promise<string | null> {
  const since = from(o.since);
  const out = await read(["api", "--paginate", `repos/${slugOf(o.repo)}/issues/${o.number}/comments?per_page=100&since=${encodeURIComponent(since)}`,
    "--jq", ".[] | {url: .html_url, body, by: .user.login, at: .created_at} | tojson"]);
  return rows<{ url: string; body: string | null; by?: string | null; at: string }>(out).find((r) => Date.parse(r.at) >= Date.parse(since) && text(r.body) === text(o.body) && o.mine(r.by) && !o.taken?.has(r.url))?.url ?? null;
}

const COMMENTS = `query($id: ID!) { node(id: $id) {
  ... on Issue { comments(last: 100) { nodes { url body createdAt author { login } } } }
  ... on PullRequest { comments(last: 100) { nodes { url body createdAt author { login } } } }
} }`;
const REVIEWS = `query($id: ID!) { node(id: $id) { ... on PullRequest { reviews(last: 100) { nodes { id body submittedAt author { login } commit { oid } } } } } }`;

/** `commentMade` by the item's node id. */
export async function nodeCommentMade(q: Pick<Querier, "query">, o: Where & { id: string; body: string }): Promise<string | null> {
  const r = await q.query(COMMENTS, { id: o.id }) as { node?: { comments?: { nodes: { url: string; body: string; createdAt: string; author?: { login: string } | null }[] } } | null };
  return r.node?.comments?.nodes.find((c) => Date.parse(c.createdAt) >= Date.parse(from(o.since)) && text(c.body) === text(o.body) && o.mine(c.author?.login) && !o.taken?.has(c.url))?.url ?? null;
}

const REVIEW_BODY = `query($id: ID!) { node(id: $id) { ... on PullRequestReview { body } } }`;

/** Whether the review already reads this text. */
export async function reviewReads(q: Pick<Querier, "query">, id: string, body: string): Promise<boolean> {
  const r = await q.query(REVIEW_BODY, { id }) as { node?: { body?: string | null } | null };
  return typeof r.node?.body === "string" && text(r.node.body) === text(body);
}

/** The id of the review with this text on the PR's commit, submitted since `since`. */
export async function reviewMade(q: Pick<Querier, "query">, o: Where & { id: string; head: string; body: string }): Promise<string | null> {
  const r = await q.query(REVIEWS, { id: o.id }) as { node?: { reviews?: { nodes: { id: string; body: string; submittedAt: string | null; author?: { login: string } | null; commit: { oid: string } | null }[] } } | null };
  return r.node?.reviews?.nodes.find((v) => v.commit?.oid === o.head && v.submittedAt !== null && Date.parse(v.submittedAt) >= Date.parse(from(o.since)) && text(v.body) === text(o.body) && o.mine(v.author?.login) && !o.taken?.has(v.id))?.id ?? null;
}
