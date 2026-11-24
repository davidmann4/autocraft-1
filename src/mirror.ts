// Mirror of every issue and PR of the tracked owners (storytold and any other owner of a tracked repo) into SQLite, via `gh api graphql`.
import { refreshSnapshot } from "./itemtools/snapshot.ts";
import { isCounted } from "./review/discussion.ts";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { reloadRepoOwners, trackedNames } from "./repos.ts";
import { audit } from "./dash/audit.ts";
import { hashColumns } from "./itemhash.ts";
import { textRefs } from "./core/open-prs.ts";
import { syncActivity } from "./activity.ts";
import { mentionNames, rememberSlug } from "./github/slugs.ts";
import { appSlug } from "./github/identity.ts";
import { envVar } from "./env.ts";
import { AppReadError, ownerOfVariables, readEnv, resolveOwner } from "./github/read.ts";
import { DEFAULT_OWNER, ownerOf, slugOf } from "./owners.ts";
import { classifyFailure, clearRepoFailure, recordRepoFailure } from "./sync-errors.ts";
import { exclusive } from "./async-seq.ts";
import type { Expression, Insertable } from "kysely";
import type { Db } from "./db/index.ts";
import * as kx from "./db/kx.ts";
import type { Comments, Items } from "./db/types.ts";
import { dbLockName, openDb, setDbRole } from "./db/open.ts";

const OVERLAP_MS = 10 * 60 * 1000;
const FULL_PAGE = 30;
const LIGHT_PAGE = 100;
const MIN_PAGE = 10;

const COLUMNS = [
  "repo", "number", "kind", "state", "title", "body", "url", "author", "author_type", "author_id", "author_association",
  "created_at", "updated_at", "closed_at", "merged_at", "merged_by", "state_reason", "is_draft",
  "labels", "assignees", "comments_count", "reactions_count", "additions", "deletions", "changed_files",
  "head_ref", "head_oid", "head_repo", "base_ref", "maintainer_can_modify", "mergeable",
  "review_decision", "ci_state", "closing_issues", "detail_level", "embed_hash", "class_hash", "class_scheme",
] as const;

type ItemRow = Pick<Items, (typeof COLUMNS)[number]>;

type Kind = "issue" | "pr";
type Detail = "full" | "light";
// GraphQL nodes are untyped JSON; fields are read by name.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

export const REPOS_QUERY = `
query($login: String!, $after: String) {
  rateLimit { cost remaining resetAt }
  repositoryOwner(login: $login) {
    repositories(first: 100, after: $after, isArchived: false) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name visibility defaultBranchRef { name }
        pullRequests(states: OPEN) { totalCount }
        issues(states: OPEN) { totalCount }
      }
    }
  }
}`;

export const COMMON = `number title body url author { login __typename ... on User { databaseId } ... on Bot { databaseId } } authorAssociation createdAt updatedAt closedAt state
  labels(first: 10) { nodes { name } } assignees(first: 5) { nodes { login } }
  commentCount: comments { totalCount } reactionCount: reactions { totalCount }`;
export const COMMENTS = "comments(last: 20) { nodes { id author { login __typename } authorAssociation createdAt body url } }";
export const PR_EXTRA = `isDraft mergedAt mergedBy { login } additions deletions changedFiles
  headRefName headRefOid headRepository { nameWithOwner } baseRefName
  closingIssuesReferences(first: 10) { nodes { number repository { nameWithOwner } } }`;
export const PR_FULL = `maintainerCanModify mergeable reviewDecision
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviews(last: 10) { nodes { id author { login __typename } authorAssociation createdAt body url state commit { oid } comments { totalCount } } }`;

export function itemsQuery(kind: Kind, detail: Detail): string {
  const [conn, stateType] = kind === "issue" ? ["issues", "IssueState"] : ["pullRequests", "PullRequestState"];
  let fields = `${COMMON} ${kind === "issue" ? "stateReason" : PR_EXTRA}`;
  if (detail === "full") fields += ` ${COMMENTS}${kind === "pr" ? ` ${PR_FULL}` : ""}`;
  return `
query($owner: String!, $name: String!, $first: Int!, $after: String, $states: [${stateType}!]) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    ${conn}(first: $first, after: $after, states: $states,
            orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { ${fields} }
    }
  }
}`;
}

export class Transient extends Error {}

/** A GitHub call that failed with a structured answer: the HTTP status gh reports (0 when none) and the GraphQL error `type` (FORBIDDEN, NOT_FOUND, …). */
export class GithubError extends Error {
  readonly status: number;
  readonly type: string | null;
  constructor(message: string, status: number, type: string | null) { super(message); this.status = status; this.type = type; }
}
/** The status of gh's own "(HTTP 403)" line. */
export const httpStatusOf = (stderr: string): number => Number(/\(HTTP (\d{3})\)/.exec(stderr)?.[1] ?? 0);


export class Client {
  reserve: number;
  remaining: number | null = null;
  resetAt: Date | null = null;
  spent = 0;

  /** The child's whole environment when set (the app lane's token); otherwise it is the read environment of the current identity. */
  private env: Record<string, string> | undefined;
  /** Rate figures per account: "" for the box account or a fixed env, else the installation's owner. `remaining`/`resetAt` are the current key's. */
  private rates = new Map<string, { remaining: number | null; resetAt: Date | null }>();
  private rateKey = "";

  constructor(reserve: number, env?: Record<string, string>) {
    this.reserve = reserve;
    this.env = env;
  }

  async sleepUntilReset(why: string): Promise<void> {
    const ms = this.resetAt ? Math.max(5_000, this.resetAt.getTime() - Date.now() + 5_000) : 60_000;
    console.log(`  ${why}: sleeping ${Math.round(ms / 1000)}s until rate limit reset`);
    await sleep(ms);
    this.remaining = null;
  }

  /**
   * The environment of the next gh child and the key of its rate figures: the fixed one, else the app's installation
   * token of the owner (under `app`; rate limits belong to the installation) or gh's own login (`box`, key "").
   */
  private async childEnv(owner?: string): Promise<{ env: Record<string, string> | undefined; key: string }> {
    if (this.env) return { env: this.env, key: "" };
    let env: Record<string, string> | undefined;
    try {
      env = await readEnv(owner);
    } catch (e) {
      // A token that cannot be minted now may be minted later; a missing installation is final.
      if (e instanceof AppReadError && !e.notInstalled) throw new Transient(e.message);
      throw e;
    }
    return { env, key: env ? (await resolveOwner(owner)).toLowerCase() : "" };
  }

  /** Makes the rate figures those of `key` (an installation, or the box account). */
  private useRate(key: string): void {
    if (key === this.rateKey) return;
    this.rates.set(this.rateKey, { remaining: this.remaining, resetAt: this.resetAt });
    const r = this.rates.get(key);
    this.remaining = r?.remaining ?? null;
    this.resetAt = r?.resetAt ?? null;
    this.rateKey = key;
  }

  /** Runs gh without blocking the event loop (the runner's tick must keep its heartbeat and cancels). A timeout or spawn error is Transient. */
  private async run(query: string, variables: object, env: Record<string, string> | undefined): Promise<{ data?: Node; errors: Node[]; text: string; failed: boolean; stderr: string }> {
    const p = await new Promise<{ stdout: string; stderr: string; status: number | null }>((resolve, reject) => {
      const child = spawn("gh", ["api", "graphql", "--input", "-"], { stdio: ["pipe", "pipe", "pipe"], ...(env ? { env } : {}) });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      const fail = (): void => { clearTimeout(timer); child.kill("SIGKILL"); reject(new Transient("timeout")); };
      const timer = setTimeout(fail, 120_000);
      child.stdout.on("data", (c: Buffer) => { size += c.length; if (size > (256 << 20)) fail(); else out.push(c); });
      child.stderr.on("data", (c: Buffer) => err.push(c));
      child.on("error", fail);
      child.on("close", (status) => { clearTimeout(timer); resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), status }); });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ query, variables }));
    });
    let json: Node = {};
    try {
      json = JSON.parse(p.stdout);
    } catch {
      // gh prints errors on stderr when there is no JSON body
    }
    const text = `${p.stdout.length < 5000 ? p.stdout : ""}${p.stderr}`.toLowerCase();
    return { data: json.data, errors: json.errors ?? [], text, failed: p.status !== 0, stderr: p.stderr };
  }

  /** The `owner/name` GitHub's REST endpoint redirects a moved repo to, or null when it does not answer with another name. */
  async repoMovedTo(owner: string, name: string): Promise<string | null> {
    const { env } = await this.childEnv(owner);
    const p = spawnSync("gh", ["api", `repos/${owner}/${name}`, "--jq", ".full_name"], { encoding: "utf8", timeout: 30_000, ...(env ? { env } : {}) });
    const full = p.status === 0 ? p.stdout.trim() : "";
    return full && full.toLowerCase() !== `${owner}/${name}`.toLowerCase() ? full : null;
  }

  async query(query: string, variables: object): Promise<Node> {
    const { env, key } = await this.childEnv(ownerOfVariables(variables));
    this.useRate(key);
    if (this.remaining !== null && this.remaining < this.reserve) {
      await this.sleepUntilReset(`${this.remaining} points left, reserve ${this.reserve}`);
    }
    const r = await this.run(query, variables, env);
    if (r.text.includes("secondary rate limit") || r.text.includes("abuse")) {
      console.log("  secondary rate limit: sleeping 90s");
      await sleep(90_000);
      throw new Transient("secondary");
    }
    if (r.errors.some((e: Node) => e.type === "RATE_LIMITED") || (r.failed && r.text.includes("rate limit"))) {
      await this.sleepUntilReset("rate limit exhausted");
      throw new Transient("rate limited");
    }
    // An org search also lists items of repos the app cannot read (one it is not installed on): GitHub nulls those results
    // and reports each beside them. Dropping them keeps the page; a tracked repo without access shows on the app-coverage check.
    const refused = r.data?.search?.nodes ? refusedSearchNodes(r.errors) : null;
    if (refused) {
      for (const i of refused) r.data.search.nodes[i] = null;
      console.warn(`  skipped ${refused.size} search result${refused.size === 1 ? "" : "s"} GitHub refused for lack of access`);
    }
    if (r.errors.length && !r.data?.repository && !r.data?.repositoryOwner && !r.data?.search) {
      if (/node_limit|resource_limits|timeout|something went wrong/.test(r.text)) throw new Transient("query too heavy");
      const typed = r.errors.find((e: Node) => e.type === "FORBIDDEN" || e.type === "NOT_FOUND") ?? r.errors[0];
      throw new GithubError(`graphql error: ${JSON.stringify(r.errors).slice(0, 500)}`, httpStatusOf(r.stderr), typeof typed?.type === "string" ? typed.type : null);
    }
    // A deleted or transferred item is a NOT_FOUND error beside a null field, and gh exits non-zero; with the repository
    // present the answer is that null field, which callers handle.
    const missingOnly = (r.errors.length > 0 && r.errors.every((e: Node) => e.type === "NOT_FOUND") && !!r.data?.repository) || refused !== null;
    if (r.failed && !missingOnly) {
      if (/502|503|504|timeout|eof|connection|unexpected end of json/.test(r.text)) throw new Transient(r.stderr.trim().slice(0, 200));
      throw new GithubError(`gh failed: ${r.stderr.trim().slice(0, 500)}`, httpStatusOf(r.stderr), null);
    }
    const rl = r.data.rateLimit; // absent in mutation responses
    if (rl) {
      this.remaining = rl.remaining;
      this.spent += rl.cost;
      this.resetAt = new Date(rl.resetAt);
    }
    return r.data;
  }
}

// Newest first, lazily: stopping early saves requests. Halves the page size on transient errors.
async function* fetchPages(client: Querier, kind: Kind, detail: Detail, name: string, states: string[]): AsyncGenerator<Node[]> {
  const query = itemsQuery(kind, detail);
  let size = detail === "full" ? FULL_PAGE : LIGHT_PAGE;
  let cursor: string | null = null;
  let failures = 0;
  for (;;) {
    let data: Node;
    try {
      data = await client.query(query, { owner: ownerOf(name), name, first: size, after: cursor, states });
    } catch (e) {
      if (!(e instanceof Transient)) throw e;
      if (size > MIN_PAGE) {
        size = Math.max(MIN_PAGE, size >> 1);
        console.log(`  ${e.message}: page size ${size}`);
      } else if (++failures > 6) {
        throw e;
      } else {
        await sleep(Math.min(30_000 * failures, 300_000));
      }
      continue;
    }
    failures = 0;
    const conn: Node = data.repository[kind === "issue" ? "issues" : "pullRequests"];
    yield conn.nodes;
    if (!conn.pageInfo.hasNextPage) return;
    cursor = conn.pageInfo.endCursor;
  }
}

// Passes pages through, dropping items updated before cutoff and ending at the first such item.
export async function* untilCutoff(pages: AsyncIterable<Node[]>, cutoff: string | null): AsyncGenerator<Node[]> {
  for await (const page of pages) {
    const keep = page.filter((n) => cutoff === null || n.updatedAt >= cutoff);
    if (keep.length) yield keep;
    if (keep.length < page.length) return;
  }
}

const login = (n: Node): string | null => n?.login ?? null;

function toRow(repo: string, kind: Kind, n: Node, detail: Detail): ItemRow {
  const r = baseRow(repo, kind, n, detail);
  return Object.assign(r, hashColumns(r));
}

/** True when `nameWithOwner` is the repo of the item at `url` (https://github.com/<owner>/<repo>/...). */
const sameRepo = (nameWithOwner: unknown, url: unknown): boolean =>
  typeof nameWithOwner === "string" && typeof url === "string" && url.toLowerCase().startsWith(`https://github.com/${nameWithOwner.toLowerCase()}/`);

function baseRow(repo: string, kind: Kind, n: Node, detail: Detail): ItemRow {
  const r = Object.fromEntries(COLUMNS.map((c) => [c, null])) as unknown as ItemRow;
  Object.assign(r, {
    repo, number: n.number, kind, state: n.state, title: n.title, body: n.body, url: n.url,
    author: login(n.author), author_type: n.author?.__typename ?? null, author_id: typeof n.author?.databaseId === "number" ? n.author.databaseId : null, author_association: n.authorAssociation,
    created_at: n.createdAt, updated_at: n.updatedAt, closed_at: n.closedAt,
    labels: JSON.stringify((n.labels?.nodes ?? []).filter(Boolean).map((x: Node) => x.name)),
    assignees: JSON.stringify((n.assignees?.nodes ?? []).filter(Boolean).map((x: Node) => x.login)),
    comments_count: n.commentCount?.totalCount ?? 0, reactions_count: n.reactionCount?.totalCount ?? null, detail_level: detail,
  });
  if (kind === "issue") {
    r.state_reason = n.stateReason;
    return r;
  }
  Object.assign(r, {
    is_draft: Number(n.isDraft), merged_at: n.mergedAt, merged_by: login(n.mergedBy),
    additions: n.additions, deletions: n.deletions, changed_files: n.changedFiles,
    head_ref: n.headRefName, head_oid: n.headRefOid, head_repo: n.headRepository?.nameWithOwner ?? null,
    base_ref: n.baseRefName,
    // Numbers only, so an issue of another repo would read as this repo's: those are left out.
    closing_issues: JSON.stringify((n.closingIssuesReferences?.nodes ?? []).filter((x: Node) => x && (!x.repository || sameRepo(x.repository.nameWithOwner, n.url))).map((x: Node) => x.number)),
  });
  if (detail === "full") {
    Object.assign(r, {
      maintainer_can_modify: Number(n.maintainerCanModify), mergeable: n.mergeable,
      review_decision: n.reviewDecision, ci_state: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
    });
  }
  return r;
}

/** 1 when the body names the pipeline login; the needs page lists such comments through an index. */
const mentions = (body: unknown, names: string[]): number => {
  if (typeof body !== "string") return 0;
  const b = body.toLowerCase();
  return names.some((n) => n && b.includes(`@${n.toLowerCase()}`)) ? 1 : 0;
};

function commentRows(repo: string, kind: Kind, n: Node, own: string[]): Insertable<Comments>[] {
  // `counted`: whether the entry counts as new discussion for the review stage (src/review/discussion.ts).
  const counted = (c: Node) => Number(isCounted({ author: login(c.author), association: c.authorAssociation, bot: c.author?.__typename === "Bot", prAuthor: login(n.author), state: c.state, body: c.body, inline: c.comments?.totalCount }));
  const rows: Insertable<Comments>[] = (n.comments?.nodes ?? []).filter(Boolean).map((c: Node) =>
    ({ repo, number: n.number, id: c.id, kind: "comment", author: login(c.author), created_at: c.createdAt, body: c.body, review_state: null, commit_oid: null, counted: counted(c), author_association: c.authorAssociation ?? null, mentions_pipeline: mentions(c.body, own), url: c.url ?? null }));
  if (kind === "pr") {
    for (const c of (n.reviews?.nodes ?? []).filter(Boolean)) {
      // A review without a body still counts: its inline threads are the discussion, and it makes earlier reviews stale.
      rows.push({ repo, number: n.number, id: c.id, kind: "review", author: login(c.author), created_at: c.createdAt, body: c.body, review_state: c.state, commit_oid: c.commit?.oid ?? null, counted: counted(c), author_association: c.authorAssociation ?? null, mentions_pipeline: mentions(c.body, own), url: c.url ?? null });
    }
  }
  return rows;
}

/** An upsert's mergeable value: GitHub reports UNKNOWN while it recomputes, which must not replace a known value at the same head. */
export const keepKnownMergeableExpr = (eb: kx.AnyEb, table: string): Expression<string | null> =>
  eb.case().when(eb.and([
    eb(eb.ref(`${table}.head_oid`), "is not distinct from", eb.ref("excluded.head_oid")),
    eb(eb.ref(`${table}.mergeable`), "in", ["CONFLICTING", "MERGEABLE"]),
    eb(eb.ref("excluded.mergeable"), "is distinct from", "CONFLICTING"),
    eb(eb.ref("excluded.mergeable"), "is distinct from", "MERGEABLE"),
  ])).then(eb.ref(`${table}.mergeable`)).else(eb.ref("excluded.mergeable")).end();

/** `force` rewrites an item and its comments even when the row is unchanged (a comment edit leaves the item row as it was). */
/**
 * `readAt` is when the read of these nodes started (before its first GitHub request), stored as `item_reads.synced_at`, so a
 * read that began before a change never passes for one made after it (src/github/commands.ts compares it with a comment's time).
 */
async function writePage(db: Db, repo: string, kind: Kind, detail: Detail, nodes: Node[], force = false, readAt: string = iso(new Date())): Promise<void> {
  // Upserts keep each row's rowid, which the full-text index (schema.sql) is keyed on.
  const itemUpsert = COLUMNS.filter((c) => c !== "repo" && c !== "number" && c !== "mergeable");
  const commentUpsert = ["repo", "number", "kind", "author", "created_at", "body", "review_state", "commit_oid", "counted", "author_association", "mentions_pipeline", "url"] as const;
  const live = appSlug();
  if (live) { try { await rememberSlug(db, live); } catch { /* read-only connection */ } }
  const own = await mentionNames(db, live);
  // Rows are built before the write lock, and the lock covers a fixed number of statements per page (multi-row, in
  // batches), not statements per item: on Postgres each one is a network round trip. A number read twice keeps its last read.
  const page = [...new Map(nodes.map((n) => [Number(n.number), n])).values()].map((n) => ({
    n, row: toRow(repo, kind, n, detail), comments: detail === "full" ? commentRows(repo, kind, n, own) : [],
  }));
  if (!page.length) return;
  const numbersOf = (xs: readonly { row: ItemRow }[]) => xs.map((x) => x.row.number);
  await db.write(async () => {
    // A read never replaces what a later-started read stored: the item, its comments and its read time stay the newer read's.
    const reads = new Map<number, string>();
    for (const b of kx.batches(page)) {
      for (const r of await db.all(db.k.selectFrom("main.item_reads").select(["number", "synced_at"]).where("repo", "=", repo).where(kx.inList(db, "number", numbersOf(b), "bigint")))) reads.set(Number(r.number), r.synced_at);
    }
    const current = page.filter((x) => { const last = reads.get(x.row.number); return last === undefined || !(Date.parse(last) > Date.parse(readAt)); });
    if (!current.length) return;
    // A row identical to the stored one (overlapping reads re-fetch many) writes nothing.
    const stored = new Map<number, Record<string, unknown>>();
    for (const b of kx.batches(current)) {
      for (const r of await db.all(db.k.selectFrom("items").select(COLUMNS).where("repo", "=", repo).where(kx.inList(db, "number", numbersOf(b), "bigint")))) stored.set(Number(r.number), r);
    }
    const changed = force ? current : current.filter((x) => { const old = stored.get(x.row.number); return !old || !COLUMNS.every((c) => old[c] === x.row[c]); });
    for (const b of kx.batches(changed)) {
      await db.run(db.k.insertInto("main.items").values(b.map((x) => x.row)).onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet((eb) => ({
        ...kx.excluded(itemUpsert)(eb),
        mergeable: keepKnownMergeableExpr(eb, "items"),
      }))));
      // After the upsert, which clears the stored refs when the text changed (schema trigger items_text_refs_stale).
      if (kind === "pr") {
        const refs = kx.caseOf("number", b.map((x) => [x.row.number, textRefs(x.row.title, x.row.body)] as const));
        await db.run(db.k.updateTable("main.items").set({ text_refs: refs }).where("repo", "=", repo).where(kx.inList(db, "number", numbersOf(b), "bigint")));
      }
    }
    // The account seen under a login string owns its id-less history for the whitelist; a later account with the same login does not inherit it.
    // A login with merged or closed PRs mirrored without an id is left to the backfill, which binds the author of that history, not the login's current holder.
    const ids = new Map<string, number>();
    for (const { row } of changed) if (typeof row.author === "string" && typeof row.author_id === "number" && !ids.has(row.author)) ids.set(row.author, row.author_id);
    if (ids.size) {
      const unbound = new Set((await db.all(db.k.selectFrom("main.items").select("author").distinct().where(kx.inList(db, "author", [...ids.keys()]))
        .where("kind", "=", "pr").where("state", "in", ["MERGED", "CLOSED"]).where("author_id", "is", null))).map((r) => r.author));
      const bind = [...ids].filter(([login]) => !unbound.has(login)).map(([login, id]) => ({ login, id }));
      for (const b of kx.batches(bind)) await db.run(db.k.insertInto("main.author_ids").values(b).onConflict((oc) => oc.doNothing()));
    }
    if (detail === "full" && changed.length) {
      // A forced re-read of an unchanged item upserts in place: an identical comment bumps no topic. Comments past the newest 20 go.
      if (!force) for (const b of kx.batches(changed)) await db.run(db.k.deleteFrom("main.comments").where("repo", "=", repo).where(kx.inList(db, "number", numbersOf(b), "bigint")));
      const comments = [...new Map(changed.flatMap((x) => x.comments).map((c) => [c.id, c])).values()];
      for (const b of kx.batches(comments)) await db.run(db.k.insertInto("main.comments").values(b).onConflict((oc) => oc.column("id").doUpdateSet(kx.excluded(commentUpsert))));
      if (force) for (const x of changed) await db.run(db.k.deleteFrom("main.comments").where("repo", "=", repo).where("number", "=", x.row.number).where(kx.inList(db, "id", x.comments.map((r) => r.id), "text", true)));
    }
    for (const b of kx.batches(current)) {
      await db.run(db.k.insertInto("main.item_reads").values(b.map((x) => ({ repo, number: x.row.number, synced_at: readAt })))
        .onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet(kx.excluded(["synced_at"]))
          .where((eb) => eb(eb.fn<number>("julianday", [eb.ref("excluded.synced_at")]), ">=", eb.fn<number>("julianday", [eb.ref("main.item_reads.synced_at")])))));
    }
  });
}

// `repositoryOwner` serves organizations and users alike.
async function listRepos(client: Querier, login: string): Promise<Node[]> {
  const repos: Node[] = [];
  let after: string | null = null;
  for (;;) {
    const conn: Node = (await client.query(REPOS_QUERY, { login, after })).repositoryOwner.repositories;
    repos.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) return repos;
    after = conn.pageInfo.endCursor;
  }
}

/** False for a node of a repo with the tracked name but another owner (names are unique across tracked repos). */
const ownedBy = (n: Node, name: string): boolean => {
  const login = n.repository?.owner?.login;
  return !login || login.toLowerCase() === ownerOf(name).toLowerCase();
};

const iso = (d: Date): string => d.toISOString().replace(/\.\d+Z$/, "Z");

// Reads a repo's items, newest first, down to `cutoff` (everything when null). Moves no high water.
async function readRepoSince(db: Db, client: Querier, name: string, cutoff: string | null): Promise<{ count: number; newest: string }> {
  // Before the first request: every page of this read counts as read from here on (never later than its own request).
  const startedAt = iso(new Date());
  let newest = "";
  let count = 0;
  for (const kind of ["issue", "pr"] as const) {
    const passes: [Detail, string[]][] = [["full", ["OPEN"]], ["light", kind === "issue" ? ["CLOSED"] : ["CLOSED", "MERGED"]]];
    for (const [detail, states] of passes) {
      for await (const nodes of untilCutoff(fetchPages(client, kind, detail, name, states), cutoff)) {
        await writePage(db, name, kind, detail, nodes, false, startedAt);
        count += nodes.length;
        for (const n of nodes) if (n.updatedAt > newest) newest = n.updatedAt;
      }
    }
  }
  return { count, newest };
}

// high_water is written only when the whole repo finished, so a crash leaves the repo incomplete.
async function syncRepo(db: Db, client: Querier, name: string, full: boolean): Promise<number> {
  // synced_at is the start of the sync: every item the sync read is at least as new as it (the pre-approved merge compares it with a push).
  const startedAt = iso(new Date());
  const row = await db.get(db.k.selectFrom("repos").select("high_water").where("name", "=", name));
  const high = row?.high_water ?? null;
  const cutoff = high && !full ? iso(new Date(new Date(high).getTime() - OVERLAP_MS)) : null;
  const read = await readRepoSince(db, client, name, cutoff);
  const count = read.count;
  const newest = read.newest > (high ?? "") ? read.newest : (high ?? "");
  // max(): an incremental sync may have moved the high water further while a full pass ran.
  const hw = newest || null;
  await db.run(db.k.updateTable("main.repos").set((eb) => ({
    synced_at: startedAt,
    high_water: hw === null ? eb.ref("high_water")
      : eb.case().when(eb.or([eb("high_water", "is", null), eb("high_water", "<", hw)])).then(hw).else(eb.ref("high_water")).end(),
  })).where("name", "=", name));
  return count;
}

// Which repos get their items synced: --repo names (any repo), else every repo
// with --all, else the tracked ones. `listed` is every non-archived org repo.
export function selectSyncRepos(listed: string[], tracked: string[], opts: { only: string[]; all: boolean }): string[] {
  if (opts.only.length) {
    const missing = opts.only.filter((n) => !listed.includes(n));
    if (missing.length) throw new Error(`unknown or archived repos: ${missing.join(", ")}`);
    return listed.filter((n) => opts.only.includes(n));
  }
  return opts.all ? listed : listed.filter((n) => tracked.includes(n));
}

// GitHub's search index can lag several minutes, so every search starts 10 minutes before the high
// water, and once an hour it also re-reads the 6 hours before it.
const SEARCH_OVERLAP_MS = 10 * 60 * 1000;
const CATCHUP_EVERY_MS = 60 * 60 * 1000;
const CATCHUP_SPAN_MS = 6 * 60 * 60 * 1000;
// Each tracked repo's open items are listed and reconciled with the mirror once a day (by the runner: reconcileNext).
export const RECONCILE_EVERY_MS = 24 * 60 * 60 * 1000;
const SEARCH_PAGE = 20;
const SEARCH_CAP = 1000;
// Rate-limit points a full re-sync leaves for the minute sync.
const FULL_KEEP = 2500;
const META_REFRESH_MS = 15 * 60 * 1000;
const LOCK_STALE_MS = 6 * 3600 * 1000;

/** Indexes of search results GitHub refused for lack of access, when every error of the answer is one; else null. */
export function refusedSearchNodes(errors: Node[]): Set<number> | null {
  if (!errors.length) return null;
  const out = new Set<number>();
  for (const e of errors) {
    const p = e.path;
    const refusal = e.type === "FORBIDDEN" || /not accessible by integration/i.test(String(e.message ?? ""));
    if (!refusal || !Array.isArray(p) || p[0] !== "search" || p[1] !== "nodes" || typeof p[2] !== "number") return null;
    out.add(p[2]);
  }
  return out;
}

export const SEARCH_QUERY = `
query($q: String!, $first: Int!, $after: String) {
  rateLimit { cost remaining resetAt }
  search(type: ISSUE, query: $q, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on Issue { repository { name owner { login } } ${COMMON} stateReason ${COMMENTS} }
      ... on PullRequest { repository { name owner { login } } ${COMMON} ${PR_EXTRA} ${COMMENTS} ${PR_FULL} }
    }
  }
}`;

// The index lags, so each query starts before the newest updatedAt stored.
export function searchSince(orgHighWater: string): string {
  return iso(new Date(new Date(orgHighWater).getTime() - SEARCH_OVERLAP_MS));
}

export type Querier = { query(query: string, variables: object): Promise<Node>; spent: number; remaining: number | null; resetAt?: Date | null; repoMovedTo?(owner: string, name: string): string | null | Promise<string | null> };

/** Skips a repo that cannot be read: logs and records why, with the new name when GitHub redirects. The run goes on with the other repos. */
async function failRepo(db: Db, client: Querier, name: string, e: unknown): Promise<void> {
  let moved: string | null = null;
  if ((e as { type?: string })?.type === "NOT_FOUND") {
    try { moved = (await client.repoMovedTo?.(ownerOf(name), name)) ?? null; } catch { /* the plain NOT_FOUND is recorded */ }
  }
  await recordRepoFailure(db, name, e, moved);
  console.warn(`${slugOf(name)}: not synced: ${(e as Error).message}${moved ? ` (moved to ${moved})` : ""}`);
}

const getSetting = async (db: Db, key: string): Promise<string | null> =>
  (await db.get(db.k.selectFrom("settings").select("value").where("key", "=", key)))?.value ?? null;
const setSetting = async (db: Db, key: string, value: string): Promise<void> => {
  await db.run(db.k.insertInto("settings").values({ key, value }).onConflict((oc) => oc.column("key").doUpdateSet(kx.excluded(["value"]))));
};

// Search returns at most SEARCH_CAP results per query. A window with more matches is cut in half
// (`updated:A..B` is inclusive, in whole seconds) until every slice fits. A one-second slice with
// more matches than the cap cannot be read by search; the tracked repos are listed for that
// second instead.
export type SearchResult = { count: number; newest: string | null; slices: number; fallbacks: number };

// Everything updated from `since` to `until`, oldest slice first. `newest` is the largest updatedAt
// returned (tracked repos or not), the next sync's starting point; null when nothing matched.
export async function syncBySearch(db: Db, client: Querier, tracked: string[], since: string, until: string): Promise<SearchResult> {
  const trackedSet = new Set(tracked);
  // Before the first request: the read start every page of this run is stored with (see writePage).
  const startedAt = iso(new Date());
  // Search covers the default org only; repos of other owners are read one by one after it.
  const scope = `org:${DEFAULT_OWNER}`;
  // Applied once every window has been read, so a failed run leaves the repos' high water alone.
  const repoNewest = new Map<string, string>();
  let size = SEARCH_PAGE;
  let failures = 0;
  const out: SearchResult = { count: 0, newest: null, slices: 0, fallbacks: 0 };

  async function page(q: string, cursor: string | null): Promise<Node> {
    for (;;) {
      try {
        return (await client.query(SEARCH_QUERY, { q, first: size, after: cursor })).search;
      } catch (e) {
        if (!(e instanceof Transient)) throw e;
        if (size > MIN_PAGE) size = Math.max(MIN_PAGE, size >> 1);
        else if (++failures > 6) throw e;
        else await sleep(Math.min(30_000 * failures, 300_000));
      }
    }
  }

  async function write(nodes: Node[]): Promise<void> {
    const groups = new Map<string, Node[]>();
    for (const n of nodes) {
      if (n?.updatedAt && n.updatedAt > (out.newest ?? "")) out.newest = n.updatedAt;
      // Untracked repos are dropped here, before anything else is done with the node.
      if (!n?.repository || !trackedSet.has(n.repository.name) || !ownedBy(n, n.repository.name)) continue;
      const kind: Kind = n.__typename === "PullRequest" ? "pr" : "issue";
      const detail: Detail = n.state === "OPEN" ? "full" : "light";
      const key = `${n.repository.name}\t${kind}\t${detail}`;
      groups.set(key, [...(groups.get(key) ?? []), n]);
      if (n.updatedAt > (repoNewest.get(n.repository.name) ?? "")) repoNewest.set(n.repository.name, n.updatedAt);
    }
    for (const [key, group] of groups) {
      const [repo, kind, detail] = key.split("\t");
      await writePage(db, repo, kind as Kind, detail as Detail, group, false, startedAt);
      out.count += group.length;
    }
  }

  async function window(from: Date, to: Date): Promise<void> {
    const q = `${scope} updated:${iso(from)}..${iso(to)}`;
    let conn = await page(q, null);
    const seconds = Math.floor((to.getTime() - from.getTime()) / 1000);
    if (conn.issueCount > SEARCH_CAP && seconds >= 1) {
      const mid = new Date(from.getTime() + Math.floor(seconds / 2) * 1000);
      await window(from, mid);
      await window(new Date(mid.getTime() + 1000), to);
      return;
    }
    if (conn.issueCount > SEARCH_CAP) {
      console.warn(`  warning: ${conn.issueCount} items updated in ${iso(from)}, more than search returns: listing the tracked repos for it`);
      out.fallbacks++;
      for (const name of tracked) {
        try {
          const r = await readRepoSince(db, client, name, iso(from));
          await clearRepoFailure(db, name);
          out.count += r.count;
          if (r.newest > (repoNewest.get(name) ?? "")) repoNewest.set(name, r.newest);
          if (r.newest > (out.newest ?? "")) out.newest = r.newest;
        } catch (e) {
          await failRepo(db, client, name, e);
        }
      }
      return;
    }
    out.slices++;
    for (;;) {
      await write(conn.nodes);
      if (!conn.pageInfo.hasNextPage) return;
      conn = await page(q, conn.pageInfo.endCursor);
    }
  }

  const from = new Date(since);
  await window(from, new Date(Math.max(from.getTime(), new Date(until).getTime())));
  for (const name of tracked.filter((n) => ownerOf(n) !== DEFAULT_OWNER)) {
    try {
      // A repo that failed for a while has its own high water behind the window: read from there.
      const hw = (await db.get(db.k.selectFrom("repos").select("high_water").where("name", "=", name)))?.high_water;
      const own = hw ? new Date(new Date(hw).getTime() - OVERLAP_MS) : null;
      const r = await readRepoSince(db, client, name, iso(own && own < from ? own : from));
      await clearRepoFailure(db, name);
      out.count += r.count;
      if (r.newest > (repoNewest.get(name) ?? "")) repoNewest.set(name, r.newest);
    } catch (e) {
      await failRepo(db, client, name, e);
    }
  }
  for (const [repo, t] of repoNewest) {
    await db.run(db.k.updateTable("main.repos").set({ high_water: t }).where("name", "=", repo)
      .where((eb) => eb.or([eb("high_water", "is", null), eb("high_water", "<", t)])));
  }
  return out;
}

// True when the lock file names a live process and is not stale.
export function lockHeld(path: string): boolean {
  try {
    const pid = Number(readFileSync(path, "utf8"));
    const fresh = Date.now() - statSync(path).mtimeMs < LOCK_STALE_MS;
    if (!(pid > 0 && fresh)) return false;
    // A file naming this very process is left over from an earlier run whose pid was reused (a container's init gives every start the same pid).
    if (pid === process.pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  } catch {
    return false; // vanished or unreadable: treat as stale
  }
}

// A lock file with the owner's pid. Returns a release function, or null when another live run holds it.
export function acquireLock(path: string): (() => void) | null {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(path);
        } catch {
          // already gone
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if (lockHeld(path)) return null;
    try {
      unlinkSync(path);
    } catch {
      // another run removed it first
    }
  }
  return null;
}

function lockDir(): string {
  return envVar("LOCK_DIR") ?? join(homedir(), ".cache/autocraft-logs");
}

// The incremental sync's lock.
export function lockPath(): string {
  return join(lockDir(), `sync-${dbLockName()}.lock`);
}

// A full re-sync has its own lock, so it never blocks the incremental sync.
export function fullLockPath(): string {
  return join(lockDir(), `sync-full-${dbLockName()}.lock`);
}

// Wraps a client for a full re-sync, which runs beside the incremental sync and gives way to it:
// before each request it waits while `busy()` (an incremental sync is running) and, when fewer than
// `minRemaining` rate-limit points are left, sleeps until the limit resets so the incremental
// sync keeps a budget.
export type LowPriorityOpts = {
  busy: () => boolean; minRemaining: number; pollMs?: number;
  wait?: (ms: number) => Promise<void>; pause?: () => Promise<void>;
};
export function lowPriority(inner: Client, o: LowPriorityOpts): Querier {
  const wait = o.wait ?? ((ms: number) => sleep(ms));
  return {
    get spent() { return inner.spent; },
    get remaining() { return inner.remaining; },
    async query(query: string, variables: object): Promise<Node> {
      while (o.busy()) await wait(o.pollMs ?? 2000);
      if (inner.remaining !== null && inner.remaining < o.minRemaining) {
        await (o.pause ?? (() => inner.sleepUntilReset(`${inner.remaining} points left, full re-sync keeps ${o.minRemaining} for the minute sync`)))();
      }
      return inner.query(query, variables);
    },
  };
}

type SyncOpts = { only: string[]; all: boolean; full: boolean; perRepo: boolean };

export const REPO_QUERY = `
query($owner: String!, $name: String!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    name owner { login } visibility defaultBranchRef { name }
    pullRequests(states: OPEN) { totalCount }
    issues(states: OPEN) { totalCount }
  }
}`;

// Lists the default org's repos. Repos of other owners are tracked one by one by name, never listed;
// a failure reading one is logged and leaves the rest of the sync alone.
async function refreshRepoList(db: Db, client: Querier): Promise<string[]> {
  const repos: (Node & { owner: string })[] = [];
  for (const r of await listRepos(client, DEFAULT_OWNER)) repos.push({ ...r, owner: DEFAULT_OWNER });
  for (const name of (await trackedNames(db)).filter((n) => ownerOf(n) !== DEFAULT_OWNER)) {
    const owner = ownerOf(name);
    try {
      const r = (await client.query(REPO_QUERY, { owner, name })).repository;
      if (r && r.owner?.login?.toLowerCase() === owner.toLowerCase()) repos.push({ ...r, owner });
      else await failRepo(db, client, name, new GithubError("graphql error: repository not found under this owner", 0, "NOT_FOUND"));
    } catch (e) {
      await failRepo(db, client, name, e);
    }
  }
  // A tracked repo of the default org missing from the listing is archived, or moved or deleted: only the last two are errors.
  const listedNames = new Set(repos.map((r) => r.name as string));
  for (const name of (await trackedNames(db)).filter((n) => ownerOf(n) === DEFAULT_OWNER && !listedNames.has(n))) {
    try {
      const r = (await client.query(REPO_QUERY, { owner: DEFAULT_OWNER, name })).repository;
      if (!r || r.owner?.login?.toLowerCase() !== DEFAULT_OWNER.toLowerCase()) throw new GithubError("graphql error: repository not found under this owner", 0, "NOT_FOUND");
    } catch (e) {
      if (e instanceof GithubError && e.type === "NOT_FOUND") await failRepo(db, client, name, e);
      else console.warn(`  ${slugOf(name)}: ${(e as Error).message}`);
    }
  }
  // Names are unique across owners: a repo already known under another owner is left alone.
  for (const r of repos) {
    const res = await db.run(db.k.insertInto("main.repos")
      .values({ name: r.name, owner: r.owner, visibility: r.visibility.toLowerCase(), default_branch: r.defaultBranchRef?.name ?? null, open_prs: r.pullRequests.totalCount, open_issues: r.issues.totalCount })
      .onConflict((oc) => oc.column("name").doUpdateSet(kx.excluded(["visibility", "default_branch", "open_prs", "open_issues"]))
        .whereRef("main.repos.owner", "=", "excluded.owner")));
    if (!res.changes) {
      await failRepo(db, client, r.name, new GithubError(`the name is known under another owner than ${r.owner}`, 0, "NOT_FOUND"));
    }
  }
  await reloadRepoOwners(db);
  // A repo the listing shows exists again: its not-found record is stale.
  for (const r of repos) await db.run(db.k.deleteFrom("sync_repo_errors").where("repo", "=", r.name).where("kind", "=", "not-found"));
  await setSetting(db, "repos_refreshed_at", iso(new Date()));
  return [...new Set(repos.map((r: Node) => r.name as string))];
}

/** Repos the last per-repo pass skipped; the org high water waits for them. */
let syncFailures = 0;

async function syncPerRepo(db: Db, client: Querier, opts: SyncOpts): Promise<number> {
  const listed = await refreshRepoList(db, client);
  const tracked = await trackedNames(db);
  const names = selectSyncRepos(listed, tracked, opts);
  const gone = opts.only.length || opts.all ? [] : tracked.filter((n) => !listed.includes(n));
  if (gone.length) console.log(`tracked but not in the org (archived or renamed): ${gone.join(", ")}`);
  // A full re-sync goes through the repos in name order and records the last one finished,
  // so a stopped run continues after it. The cursor belongs to one scope (tracked repos or all).
  const resumable = opts.full && !opts.only.length;
  const scope = opts.all ? "all" : "tracked";
  const saved = resumable ? await getSetting(db, "full_sync_cursor") : null;
  const after = saved?.startsWith(`${scope}|`) ? saved.slice(scope.length + 1) : null;
  const todo = after === null ? names : names.filter((n) => n > after);
  if (after !== null) console.log(`resuming the full re-sync after ${after}: ${todo.length} of ${names.length} repos left`);
  let total = 0;
  let failed = 0;
  let lastError: unknown;
  let transientRun = 0;
  for (const name of todo) {
    const before = client.spent;
    let count: number;
    try {
      count = await syncRepo(db, client, name, opts.full);
    } catch (e) {
      await failRepo(db, client, name, e);
      failed++;
      lastError = e;
      // A GitHub outage or an exhausted rate limit fails every repo after long backoffs: end the run instead.
      transientRun = classifyFailure(e) === "transient" ? transientRun + 1 : 0;
      if (transientRun >= 3 || /rate limit|secondary/i.test((e as Error).message)) throw e;
      continue;
    }
    transientRun = 0;
    await clearRepoFailure(db, name);
    total += count;
    // The cursor stops at the first failure so the next full run redoes that repo.
    if (resumable && !failed) await setSetting(db, "full_sync_cursor", `${scope}|${name}`);
    console.log(`${name}: ${count} items, ${client.spent - before} points used, ${client.remaining} left`);
  }
  if (resumable && !failed) await db.run(db.k.deleteFrom("settings").where("key", "=", "full_sync_cursor"));
  // One broken repo does not fail the run; all of them failing does.
  if (failed > 0 && failed === todo.length) throw lastError;
  syncFailures = failed;
  return total;
}

// One item by number, any state, for the daily reconcile. A deleted or transferred item comes back null.
export const ONE_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue { repository { name owner { login } } ${COMMON} stateReason ${COMMENTS} }
      ... on PullRequest { repository { name owner { login } } ${COMMON} ${PR_EXTRA} ${COMMENTS} ${PR_FULL} }
    }
  }
}`;

/** Writes one item read by number (a webhook re-read) like the sync does. False for a null, deleted or transferred item: the daily reconcile handles those. */
/** `readAt`: when the request for `n` was sent (see writePage); default now. */
export async function writeItemNode(db: Db, repo: string, n: Node | null | undefined, readAt?: Date): Promise<boolean> {
  if (!n || n.repository?.name !== repo || !ownedBy(n, repo)) return false;
  await writePage(db, repo, n.__typename === "PullRequest" ? "pr" : "issue", n.state === "OPEN" ? "full" : "light", [n], true, iso(readAt ?? new Date()));
  return true;
}

// Lists a repo's open issues and PRs and reconciles the mirror with them. Mirror rows that are
// open here but not listed as open on GitHub are read one by one: closed or merged ones are
// updated, deleted or transferred ones (not found, or found in another repo) are marked CLOSED
// (no consumer reads a state other than OPEN, CLOSED and MERGED) and audited.
export async function reconcileRepo(db: Db, client: Querier, name: string, now: Date = new Date()): Promise<{ open: number; updated: number; gone: number }> {
  const listed = new Set<string>();
  const startedAt = iso(new Date());
  for (const kind of ["issue", "pr"] as const) {
    for await (const nodes of fetchPages(client, kind, "full", name, ["OPEN"])) {
      await writePage(db, name, kind, "full", nodes, false, startedAt);
      for (const n of nodes) listed.add(`${kind}\t${n.number}`);
    }
  }
  const stale = (await db.all(db.k.selectFrom("items").select(["kind", "number"]).where("repo", "=", name).where("state", "=", "OPEN")
    .orderBy("number").$narrowType<{ kind: Kind }>()))
    .filter((r) => !listed.has(`${r.kind}\t${r.number}`));
  let updated = 0;
  let gone = 0;
  for (const r of stale) {
    const sentAt = iso(new Date());
    const n: Node = (await client.query(ONE_QUERY, { owner: ownerOf(name), name, number: r.number })).repository?.issueOrPullRequest;
    if (n && n.repository?.name === name && ownedBy(n, name)) {
      await writePage(db, name, n.__typename === "PullRequest" ? "pr" : "issue", n.state === "OPEN" ? "full" : "light", [n], false, sentAt);
      updated++;
    } else {
      await db.run(db.k.updateTable("main.items").set((eb) => ({ state: "CLOSED", closed_at: eb.fn.coalesce("closed_at", eb.val(iso(now))) }))
        .where("repo", "=", name).where("number", "=", r.number).where("state", "=", "OPEN"));
      await audit(db, "sync", "item-gone", `${name}#${r.number}`, { reason: "not found or transferred on GitHub; marked CLOSED" });
      gone++;
    }
  }
  await db.run(db.k.updateTable("main.repos").set({ reconciled_at: iso(now) }).where("name", "=", name));
  return { open: listed.size, updated, gone };
}

// Of the tracked repos the sync has read in full, the one whose last reconcile is oldest, when it is over a day old (never: first).
export async function reconcileDue(db: Db, tracked: string[], now: Date): Promise<string | null> {
  const at = new Map((await db.all(db.k.selectFrom("repos").select(["name", "reconciled_at"]).where("synced_at", "is not", null).where("high_water", "is not", null))).map((r) => [r.name, r.reconciled_at ?? ""]));
  const oldest = [...tracked].filter((n) => at.has(n)).sort((a, b) => at.get(a)!.localeCompare(at.get(b)!))[0];
  if (oldest === undefined) return null;
  const last = at.get(oldest)!;
  return !last || now.getTime() - new Date(last).getTime() >= RECONCILE_EVERY_MS ? oldest : null;
}

/** Reconciles the repo that is due, if any, and returns its name. A failure is recorded and still moves `reconciled_at`, so a failing repo does not keep first place. */
export async function reconcileNext(db: Db, client: Querier, now: Date = new Date(), log: (line: string) => void = console.log): Promise<string | null> {
  const due = await reconcileDue(db, await trackedNames(db), now);
  if (!due) return null;
  try {
    const c = await reconcileRepo(db, client, due, now);
    await clearRepoFailure(db, due);
    log(`reconcile ${due}: ${c.open} open, ${c.updated} re-read, ${c.gone} gone`);
  } catch (e) {
    await failRepo(db, client, due, e);
    await db.run(db.k.updateTable("main.repos").set({ reconciled_at: iso(now) }).where("name", "=", due));
  }
  return due;
}

// Runs one sync. `org_high_water` is the newest updatedAt stored, so the next search starts ten
// minutes before it; it does not move for --repo runs, and a full re-sync leaves an existing one alone.
export async function runSync(db: Db, client: Querier, opts: SyncOpts, now: Date = new Date()): Promise<{ mode: string; items: number }> {
  const started = iso(now);
  const orgHigh = await getSetting(db, "org_high_water");
  const tracked = await trackedNames(db);
  const synced = new Set((await db.all(db.k.selectFrom("repos").select("name").where("synced_at", "is not", null))).map((r) => r.name));
  // A repo that cannot be read has no synced_at and would keep every run per-repo.
  // Only a repo that cannot be read at all (not found, no access) is passed over; others are retried per repo for their first full read.
  const broken = new Set((await db.all(db.k.selectFrom("sync_repo_errors").select("repo").where("kind", "in", ["not-found", "forbidden"]))).map((r) => r.repo));
  const wantsSearch = !opts.only.length && !opts.all && !opts.full && !opts.perRepo && orgHigh !== null
    && tracked.every((n) => synced.has(n) || broken.has(n));
  const spent0 = client.spent;
  let mode = "per-repo";
  let items: number;
  try {
    if (wantsSearch) {
      const r = await syncBySearch(db, client, tracked, searchSince(orgHigh as string), started);
      mode = "search";
      items = r.count;
      const high = r.newest && r.newest > (orgHigh as string) ? r.newest : (orgHigh as string);
      if (high !== orgHigh) await setSetting(db, "org_high_water", high);
      const last = await getSetting(db, "search_catchup_at");
      if (!last || now.getTime() - new Date(last).getTime() >= CATCHUP_EVERY_MS) {
        const c = await syncBySearch(db, client, tracked, iso(new Date(new Date(high).getTime() - CATCHUP_SPAN_MS)), iso(new Date(high)));
        items += c.count;
        await setSetting(db, "search_catchup_at", started);
      }
      // One org-wide search covers every tracked repo, so each counts as synced now.
      // The search read every default-org repo, so errors of earlier runs other than not-found are stale; a failure of this run (at >= started) stays.
      for (const n of tracked.filter((x) => ownerOf(x) === DEFAULT_OWNER)) await db.run(db.k.deleteFrom("sync_repo_errors").where("repo", "=", n).where("kind", "in", ["transient", "error"]).where("at", "<", started));
      // Not the repos that were never read in full (no high water) or that cannot be read.
      for (const n of tracked) {
        await db.run(db.k.updateTable("main.repos").set({ synced_at: started }).where("name", "=", n).where("high_water", "is not", null)
          .where((eb) => eb.not(eb.exists(eb.selectFrom("sync_repo_errors as e").select(eb.lit(1).as("one")).whereRef("e.repo", "=", "main.repos.name")))));
      }
      console.log(`search: ${r.slices} slice${r.slices === 1 ? "" : "s"}${r.fallbacks ? `, ${r.fallbacks} listed per repo` : ""}`);
      const at = await getSetting(db, "repos_refreshed_at");
      if (!at || now.getTime() - new Date(at).getTime() >= META_REFRESH_MS) await refreshRepoList(db, client);
    } else {
      syncFailures = 0;
      items = await syncPerRepo(db, client, opts);
      if (!opts.only.length && !syncFailures && (orgHigh === null || !opts.full)) await setSetting(db, "org_high_water", started);
    }
  } finally {
    // The dashboard can show the rate budget from these.
    const prefix = opts.full ? "sync_full" : "sync";
    await setSetting(db, `${prefix}_points_last_run`, String(client.spent - spent0));
    if (client.remaining !== null) await setSetting(db, "sync_rate_remaining", String(client.remaining));
    if (client.resetAt) await setSetting(db, "sync_rate_reset_at", client.resetAt.toISOString());
  }
  // History written before ids were bound: one batched pass, nothing when every login is bound.
  if (opts.full || (!opts.only.length && await getSetting(db, "author_ids_backfilled") === null)) {
    try {
      const { backfillAuthorIds } = await import("./author-ids.ts");
      const bound = await backfillAuthorIds(db, client);
      if (bound) console.log(`bound ${bound} author account id${bound === 1 ? "" : "s"}`);
      await setSetting(db, "author_ids_backfilled", iso(new Date()));
      await db.run(db.k.deleteFrom("main.settings").where("key", "=", "author_ids_error"));
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 200);
      console.log(`author ids: ${msg}`);
      await setSetting(db, "author_ids_error", `${iso(new Date())} ${(e as { type?: string })?.type ?? ""} ${msg}`);
    }
  }
  // Questions about items this sync found closed or merged no longer apply. Writes decisions only.
  const { withdrawClosedQuestions, setAsideSupersededQuestions } = await import("./merge/withdraw.ts");
  const withdrawn = await withdrawClosedQuestions(db, iso(new Date()));
  if (withdrawn) console.log(`withdrew ${withdrawn} decision${withdrawn === 1 ? "" : "s"} about closed items`);
  const aside = await setAsideSupersededQuestions(db, iso(new Date()));
  if (aside) console.log(`set aside ${aside} superseded decision${aside === 1 ? "" : "s"}`);
  return { mode, items };
}

/** How often a mirror run checks whether the default-branch poll is due (src/mainci POLL_EVERY_MS). */
const MAIN_CI_CHECK_MS = 30_000;

/** The GitHub rate the sync leaves for everything else: it waits for the reset below this many points; the diff re-reads use the same floor. */
export const SYNC_RESERVE = 1000;

async function sync(args: string[]): Promise<void> {
  const opts: SyncOpts = { only: [], all: false, full: false, perRepo: false };
  let reserve = SYNC_RESERVE;
  let keep = FULL_KEEP;
  let restart = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo") opts.only.push(args[++i]);
    else if (args[i] === "--full") opts.full = true;
    else if (args[i] === "--all") opts.all = true;
    else if (args[i] === "--per-repo") opts.perRepo = true;
    else if (args[i] === "--reserve") reserve = Number(args[++i]);
    else if (args[i] === "--restart") restart = true;
    else if (args[i] === "--keep") keep = Number(args[++i]);
    else throw new Error(`unknown argument ${args[i]}\nusage: sync [--repo NAME ...] [--all] [--full] [--per-repo] [--reserve N] [--keep N] [--restart]`);
  }
  const release = acquireLock(opts.full ? fullLockPath() : lockPath());
  if (!release) return;
  try {
    // The periodic container runs this command in a loop.
    setDbRole("periodic");
    const db = await openDb();
    const client = new Client(reserve);
    if (restart) await db.run(db.k.deleteFrom("settings").where("key", "=", "full_sync_cursor"));
    const querier = opts.full ? lowPriority(client, { busy: () => lockHeld(lockPath()), minRemaining: keep }) : client;
    // Each run leaves a row for the Pipeline page; rows older than two days go.
    const row = (await db.get(db.k.insertInto("sync_runs").values({ started_at: iso(new Date()) }).returning(kx.rowid("sync_runs").as("rowid"))))!.rowid;
    await db.run(db.k.deleteFrom("sync_runs").where("started_at", "<", iso(new Date(Date.now() - 2 * 86400_000))));
    // The default-branch poll, and the warm builds it queues, keep their own cadence while a long pass runs. Its own client:
    // a client's rate figures follow one request at a time.
    const mainCi = exclusive(async () => {
      try {
        await (await import("./mainci/index.ts")).pollMainCiIfDue(db, new Client(reserve));
      } catch (e) {
        // A failed read of the default branches must not fail the mirror run; the next check asks again.
        console.log(`main-ci: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      }
    });
    const pollsMainCi = !opts.full && !opts.only.length;
    const mainCiTimer = pollsMainCi ? setInterval(() => void mainCi.skip(), MAIN_CI_CHECK_MS) : undefined;
    mainCiTimer?.unref();
    try {
      const { mode, items } = await runSync(db, querier, opts).finally(() => clearInterval(mainCiTimer));
      await db.run(db.k.updateTable("sync_runs").set({ ended_at: iso(new Date()), mode, items }).where(kx.rowid("sync_runs"), "=", row));
      console.log(`sync: mode=${mode} items=${items} points=${client.spent} left=${client.remaining}`);
      // Sandboxed calls read the item snapshot instead of GitHub. The refresh is incremental and writes nothing when nothing differs; a visibility change alone removes a repository's rows.
      await refreshSnapshot(console.log, db);
      // Files, commits and label events of the items that changed; a failed read leaves them for the next run.
      if (!opts.full && !opts.only.length) {
        try {
          const n = await syncActivity(db, querier);
          if (n) console.log(`activity: ${n} items read, ${client.remaining} points left`);
        } catch (e) {
          console.log(`activity: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
        }
      }
      if (pollsMainCi) await mainCi.run();
      // Release download and star counts for the Downloads report; one failing repo is logged and skipped.
      if (!opts.full && !opts.only.length) {
        try {
          await (await import("./downloads/poll.ts")).pollReleasesIfDue(db, undefined, Date.now(), (l) => console.log(l));
        } catch (e) {
          console.log(`releases: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
        }
      }
      // GitHub App installations on accounts that are not allowed owners.
      if (!opts.full && !opts.only.length) {
        try {
          await (await import("./github/allowed-owners.ts")).sweepInstallationsIfDue(db);
        } catch (e) {
          console.log(`github app: sweep: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
        }
      }
      // Findings whose fix is landing: a merged pull request, or a fix that reached the default branch through an advisory.
      if (!opts.full && !opts.only.length) {
        try {
          const { exec, fixupDir } = await import("./fixup/git.ts");
          await (await import("./security/land.ts")).pollLandingIfDue(db, { exec, root: fixupDir(), log: (l) => console.log(l) });
        } catch (e) {
          console.log(`security: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
        }
      }
    } catch (e) {
      await db.run(db.k.updateTable("sync_runs").set({ ended_at: iso(new Date()), error: String((e as Error)?.message ?? e).slice(0, 300) }).where(kx.rowid("sync_runs"), "=", row));
      throw e;
    }
  } finally {
    release();
  }
}

async function syncStatus(): Promise<void> {
  const db = await openDb();
  const rows = await db.all(db.k.selectFrom("repos as r").select((eb) => [
    "r.name", "r.open_prs", "r.open_issues", "r.synced_at",
    eb.exists(eb.selectFrom("tracked_repos as t").select(eb.lit(1).as("one")).whereRef("t.name", "=", "r.name")).as("tracked"),
    eb.selectFrom("items as i").select(eb.fn.countAll<number>().as("n")).whereRef("i.repo", "=", "r.name").as("n"),
  ]).orderBy("r.name"));
  console.log(`${"repo".padEnd(28)} ${"tracked".padEnd(7)} ${"open PRs".padStart(8)} ${"open iss".padStart(8)} ${"mirrored".padStart(8)}  synced_at`);
  for (const r of rows) {
    console.log(`${r.name.padEnd(28)} ${(r.tracked ? "yes" : "-").padEnd(7)} ${String(r.open_prs).padStart(8)} ${String(r.open_issues).padStart(8)} ${String(r.n).padStart(8)}  ${r.synced_at ?? "-"}`);
  }
}

export const commands = {
  sync: { summary: "mirror issues and PRs of the tracked owners: [--repo NAME ...] [--all] [--full] [--per-repo] [--reserve N] [--keep N] [--restart] (default: org-wide search for changes; --full runs beside it and resumes after the last finished repo)", run: sync },
  "sync-status": { summary: "per repo: open PRs, open issues, mirrored rows, synced_at", run: syncStatus },
};

/** Marks a PR we just merged as merged in the mirror, so counts don't wait for the next sync; the sync later fills in what GitHub reports. */
export async function markMerged(db: Db, repo: string, number: number, at: string): Promise<void> {
  await db.run(db.k.updateTable("main.items").set((eb) => ({ state: "MERGED", merged_at: eb.fn.coalesce("merged_at", eb.val(at)), closed_at: eb.fn.coalesce("closed_at", eb.val(at)) }))
    .where("repo", "=", repo).where("number", "=", number).where("state", "=", "OPEN"));
}
