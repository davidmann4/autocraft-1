// Commands to the GitHub App in a GitHub comment. Someone who may use Queue items on the repo writes, on a line of its own,
//
//   @<app-slug> merge queue            (also merge-queue, mergequeue, mq; optional weight: `@<app-slug> merge queue 8`;
//                                      optional `bypass`, `bypass checks` or `lgtm` before or after it: queue with bypass
//                                      checks, so `@<app-slug> mq lgtm` queues with bypass checks)
//
// on a pull request or an issue, and the item goes into the merge queue as "Queue items" on the Queue page puts it there
// (queueAdd: a PR is pre-approved and fast-tracked; an issue is fast-tracked and its one closing PR queued). A PR is pre-approved at
// the head it had when the comment was written, never at one pushed later. The app answers in the same thread with the outcome.
// A second command, on a pull request only,
//
//   @<app-slug> autorepin <pull request> [via <branch>]   (also auto-repin; `owner/name#12`, `name#12`, its URL, or `off`)
//
// has the pull request's Cargo dependencies on that pull request's repository repinned to its merge commit once it is merged, or
// with `via`, to the first commit of that branch that holds it (src/repin/index.ts). The answer says it is set; the outcome is a later comment.
//
// The webhook keeps only the fields of github_commands, never the comment's text, and nothing of it reaches a prompt. The runner
// carries the command out: the commenter must have an AutoCraft login with the GitHub id bound to it, the comment must still exist
// with the command in it, and then queueAdd applies the same rule as for Queue items (src/settlers.ts: an operator with write access
// on the repo, or a maintainer who settles decisions there), with the write permission read from GitHub through the app now. A
// commenter without a bound AutoCraft login, or a viewer, gets no answer, so a stranger cannot make the app write. The answer is the
// only write and goes through write.ts.
import { getAccess, LOGIN } from "../access.ts";
import type { Role } from "../dash/types.ts";
import { guardRepo } from "../core/guard.ts";
import { audit } from "../dash/audit.ts";
import { HttpError } from "../dash/server/util.ts";
import { WRITE_PERMISSIONS } from "../dash/server/provider.ts";
import { fastPositions } from "../fasttrack.ts";
import { exec as defaultExec, type Exec } from "../fixup/git.ts";
import type { Querier } from "../mirror.ts";
import { ownerOf, slugOf } from "../owners.ts";
import { parseBranch, parsePrRef, type PrRef } from "../repin/manifest.ts";
import { appPermission, type AppPermission } from "../remote/permission.ts";
import { isQuiet } from "../security/quiet.ts";
import { settleRefusal } from "../settlers.ts";
import { AppError, call, GITHUB_API } from "./app.ts";
import { appSlug } from "./identity.ts";
import { installationToken } from "./install-token.ts";
import { ghComment, WritePacedError } from "./write.ts";
import { filterSeq, someSeq } from "../async-seq.ts";
import type { AliasableExpression, SqlBool } from "kysely";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

/** Comments read for a command: GitHub caps a body at 65536 characters. */
const BODY_MAX = 65_536;
/** A command not carried out before this long has passed is dropped (the runner was down, or GitHub could not be read). */
const EXPIRE_MS = 3600_000;
/** A comment older than this when its delivery arrives is a redelivery of an old comment: no command is queued. */
export const STALE_MS = 5 * 60_000;
/** A command whose GitHub reads could not be settled is tried again after this long. */
const RETRY_MS = 60_000;
/** Settled commands are kept this long. */
const KEEP_MS = 30 * 86400_000;
const AUDIT_LOGIN = "github-command";
const NO_ACCESS_READ = "could not check your access; comment again";
const NOT_QUEUED = "it could not be queued";
const NOT_SET = "it could not be set";

export type Command = { command: "merge-queue"; weight: number | null; /** `bypass` (or `bypass checks`): queue with bypass checks. */ bypass: boolean } | {
  command: "autorepin";
  /** The pull request to wait for; null: `off`. */ ref: PrRef | null;
  /** `via <branch>`: the dependency's branch the pin must come from; null: its default branch. */ branch: string | null;
};

/** A command's pull request as stored in ref_repo: `owner/name` or `name`, as written. */
const refText = (ref: PrRef): string => `${ref.owner ? `${ref.owner}/` : ""}${ref.name}`;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The command in a comment addressed to the app, or null. The command is a line of its own: `@<slug> merge queue`, with an
 * optional weight (`8` or `weight 8`) and an optional `bypass` / `bypass checks` / `lgtm` before or after it; `mq` is short for `merge queue`. Quoted lines (`> ...`), fenced and indented code and HTML comments are skipped, so quoting or
 * hiding a command runs nothing. A fence closes as CommonMark closes it: the opening character, at least as many of it, and nothing
 * after but spaces. `@<slug> autorepin <pull request>` names the pull request as `owner/name#12`, `name#12` or its URL; `off` drops it.
 */
export function parseCommand(body: unknown, slug: string): Command | null {
  if (typeof body !== "string" || !slug) return null;
  const bypass = "(bypass(?:[-\\s]?checks)?|lgtm)";
  const re = new RegExp(`^@${escape(slug)}(?:\\[bot\\])?[\\s,:]+(?:merge[-\\s]?queue|mq)(?:\\s+${bypass})?(?:\\s+(?:weight\\s+)?(\\d{1,2}))?(?:\\s+${bypass})?\\s*[.!]?$`, "i");
  const repin = new RegExp(`^@${escape(slug)}(?:\\[bot\\])?[\\s,:]+auto[-\\s]?repin\\s+(\\S+)(?:\\s+via\\s+(\\S+))?$`, "i");
  let fence: { ch: string; len: number } | null = null;
  let comment = false;
  for (const raw of body.slice(0, BODY_MAX).split(/\r?\n/)) {
    let text = raw;
    if (!fence) {
      if (comment) {
        const end = text.indexOf("-->");
        if (end < 0) continue;
        comment = false;
        text = text.slice(end + 3);
      }
      text = text.replace(/<!--[\s\S]*?-->/g, "");
      const open = text.indexOf("<!--");
      if (open >= 0) { comment = true; text = text.slice(0, open); }
    }
    const line = text.trim();
    const f = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (f && f[0] === fence.ch && f.length >= fence.len && line.slice(f.length).trim() === "") fence = null;
      continue;
    }
    if (f) { fence = { ch: f[0]!, len: f.length }; continue; }
    // Indented code: four columns of leading space, a tab counting up to the next multiple of four.
    if (/^(?: {4}| {0,3}\t)/.test(text)) continue;
    const m = re.exec(line);
    if (m && !(m[1] && m[3])) return { command: "merge-queue", weight: m[2] === undefined ? null : Number(m[2]), bypass: !!(m[1] ?? m[3]) };
    const rm = repin.exec(line);
    const a = rm?.[1];
    if (a === undefined) continue;
    const via = rm![2];
    if (a.toLowerCase() === "off") {
      if (via === undefined) return { command: "autorepin", ref: null, branch: null };
      continue;
    }
    const ref = parsePrRef(a);
    // A branch git would refuse makes the line no command, as a pull request that does not parse does.
    const branch = via === undefined ? null : parseBranch(via);
    if (ref && (via === undefined || branch)) return { command: "autorepin", ref, branch };
  }
  return null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const posInt = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);

/**
 * Queues the command of a new `issue_comment` in a tracked repo (`repo`, as webhooks.ts resolved it). A redelivery of the same
 * comment adds nothing, and a comment written more than STALE_MS before the delivery queues nothing. Comments by bots and apps are
 * left alone. Returns true when a command was queued.
 */
export async function queueCommand(db: Db, repo: string, event: string, payload: unknown, slug: string | null | undefined, now: Date = new Date()): Promise<boolean> {
  if (event !== "issue_comment" || !slug) return false;
  const p = obj(payload);
  if (p.action !== "created") return false;
  const comment = obj(p.comment), user = obj(comment.user), issue = obj(p.issue);
  if (user.type !== "User" || comment.performed_via_github_app) return false;
  const login = typeof user.login === "string" && LOGIN.test(user.login) ? user.login : null;
  const githubId = posInt(user.id), commentId = posInt(comment.id), number = posInt(issue.number);
  const created = typeof comment.created_at === "string" ? Date.parse(comment.created_at) : NaN;
  if (!login || !githubId || !commentId || !number || !Number.isFinite(created)) return false;
  if (now.getTime() - created > STALE_MS) return false;
  const cmd = parseCommand(comment.body, slug);
  if (!cmd) return false;
  const ref = cmd.command === "autorepin" ? cmd.ref : null;
  const branch = cmd.command === "autorepin" ? cmd.branch : null;
  const r = await db.run(db.k.insertInto("main.github_commands").values({
    comment_id: commentId, repo, number, pr: issue.pull_request ? 1 : 0, command: cmd.command, weight: cmd.command === "merge-queue" ? cmd.weight : null,
    bypass: cmd.command === "merge-queue" && cmd.bypass ? 1 : 0, ref_repo: ref ? refText(ref) : null, ref_number: ref ? ref.number : null, ref_branch: branch, login, github_id: githubId,
    created_at: new Date(created).toISOString(), requested_at: now.toISOString(), state: "queued",
  }).onConflict((oc) => oc.doNothing()));
  return r.changes > 0;
}

type Row = { comment_id: number; repo: string; number: number; pr: number; command: string; weight: number | null; bypass: number; ref_repo: string | null; ref_number: number | null; ref_branch: string | null; login: string; github_id: number; created_at: string; requested_at: string; state: string; result: string | null; retries: number; allowed: number | null; reply: string | null };
const COLS = ["comment_id", "repo", "number", "pr", "command", "weight", "bypass", "ref_repo", "ref_number", "ref_branch", "login", "github_id", "created_at", "requested_at", "state", "result", "retries", "allowed", "reply"] as const;

/**
 * What carries out a queued merge-queue command: the Queue page's queueAdd, as the commenter. `canWrite`: GitHub's answer for `repo`,
 * read just before. `heads`: the head each PR may be pre-approved at, null for one opened or pushed to after the comment. Injectable for tests.
 */
export type QueueFn = (db: Db, o: { login: string; role: Role; canWrite: boolean; repo: string; item: string; weight: number | null; bypass: boolean; heads: ReadonlyMap<number, string | null> }) => Promise<string>;

type QueuePage = typeof import("../dash/api/queue-page.ts");

const userOf = (o: { login: string; role: Role; repo: string; canWrite: boolean }) => {
  // The permission read covers the item's repo only; any other repo counts as no access.
  const has = async (repo: string): Promise<boolean> => repo === o.repo && o.canWrite;
  return { login: o.login, role: o.role, canWrite: has, canRead: has };
};

/** queueAdd from a module loaded beforehand, so nothing but the handler's own checks runs between the freshness check and its write. */
const queueVia = ({ queueAdd }: QueuePage): QueueFn => async (db, o) => {
  const req = { method: "POST" as const, path: "/webhooks/github", params: {}, query: new URLSearchParams(), form: new URLSearchParams(), json: { item: o.item, ...(o.weight === null ? {} : { weight: o.weight }), ...(o.bypass ? { bypassChecks: true } : {}) }, user: userOf(o), csrf: "", nonce: "" };
  return (await queueAdd(db, req, "github", (n) => o.heads.get(n) ?? null)).label;
};

/** The comment as GitHub has it now: `gone` when it was deleted. */
export type CommentNow = { kind: "ok"; authorId: number | null; body: string } | { kind: "gone" };

/** A PR as GitHub has it now: its head, when it was opened and whether its head changed after a given time. */
export type PrNow = { head: string; opened: string; changed: boolean };

export type CommandDeps = {
  /** Reads the PRs' heads from GitHub. */
  querier: Querier;
  /** Runs `gh` for the answer. */
  exec?: Exec;
  queue?: QueueFn;
  /** Stands in for `appPermission`, which reads the live permission through the app installation and writes it to repo_permissions. */
  permission?: (db: Db, login: string, repo: string) => Promise<AppPermission>;
  /** Reads the comment again by its id (default: REST through the app installation). Throws when GitHub cannot be read. */
  comment?: (repo: string, id: number) => Promise<CommentNow>;
  /** Reads a PR's head and its changes since a time (default: `prSince`). Null: no such PR. Throws when GitHub cannot be read. */
  pr?: (q: Querier, repo: string, number: number, since: string) => Promise<PrNow | null>;
  /** The app's slug the comment is parsed again with (default: the app's). */
  slug?: string | null;
  now?: () => Date;
  log?: (l: string) => void;
  limit?: number;
};

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 300).replace(/[.\s]+$/, "");
const refOf = (r: { repo: string; number: number }): string => `${r.repo}#${r.number}`;

/** Write access from the app's answer; "transient" when GitHub could not answer or the app cannot ask (the command is tried again until it expires). */
async function liveWrite(db: Db, r: Row, deps: CommandDeps): Promise<"ok" | "no" | "transient"> {
  const p = await (deps.permission ?? ((d, login, repo) => appPermission(d, login, repo)))(db, r.login, r.repo).catch(() => ({ kind: "error" as const }));
  return p.kind === "ok" ? (WRITE_PERMISSIONS.has(p.permission) ? "ok" : "no") : "transient";
}

async function restComment(repo: string, id: number): Promise<CommentNow> {
  const token = await installationToken(ownerOf(repo));
  try {
    const c = obj(await call(GITHUB_API, `/repos/${slugOf(repo)}/issues/comments/${id}`, token));
    return { kind: "ok", authorId: posInt(obj(c.user).id), body: typeof c.body === "string" ? c.body : "" };
  } catch (e) {
    if (e instanceof AppError && (e.status === 404 || e.status === 410)) return { kind: "gone" };
    throw e;
  }
}

const PR_SINCE = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      createdAt headRefOid
      timelineItems(last: 20, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) { nodes { ... on HeadRefForcePushedEvent { createdAt } } }
      commits(last: 100) { nodes { commit { oid committedDate checkSuites(first: 20) { nodes { createdAt } } } } }
    }
  }
}`;

type PrNode = {
  createdAt: string; headRefOid: string;
  timelineItems: { nodes: ({ createdAt?: string } | null)[] };
  commits: { nodes: ({ commit: { oid: string; committedDate: string; checkSuites: { nodes: ({ createdAt: string } | null)[] } | null } } | null)[] };
};

/**
 * A PR's head now and whether it changed after `since` (a comment's creation time). GitHub keeps no push time for a commit, so three
 * signals are read: a force push (HeadRefForcePushedEvent, stamped by GitHub), a commit dated later (the committer date, which the
 * pusher sets, so a back-dated commit passes this one) and the head's first check suite created later (stamped by GitHub when a
 * push starts CI; a merge needs green CI at the head, so the head of a mergeable PR has one). Throws while the head has no check
 * suite and no other signal shows a change: the push time cannot be told yet.
 */
export async function prSince(q: Querier, repo: string, number: number, since: string): Promise<PrNow | null> {
  const data = await q.query(PR_SINCE, { owner: ownerOf(repo), name: repo, number }) as { repository?: { pullRequest?: PrNode | null } | null };
  const pr = data.repository?.pullRequest;
  if (!pr?.headRefOid) return null;
  const t = Date.parse(since);
  const after = (s: string | undefined | null): boolean => !!s && Date.parse(s) > t;
  const commits = pr.commits.nodes.flatMap((n) => (n ? [n.commit] : []));
  const head = commits.find((c) => c.oid === pr.headRefOid);
  const suites = (head?.checkSuites?.nodes ?? []).flatMap((s) => (s ? [Date.parse(s.createdAt)] : []));
  const changed = pr.timelineItems.nodes.some((n) => after(n?.createdAt)) || commits.some((c) => after(c.committedDate));
  if (changed) return { head: pr.headRefOid, opened: pr.createdAt, changed };
  // Without a check suite the head's push time is unknown: a back-dated commit pushed after the comment would pass the other
  // signals, so the command waits (tried again) until CI has registered the head.
  if (!suites.length) throw new Error("the head has no check suite yet");
  return { head: pr.headRefOid, opened: pr.createdAt, changed: Math.min(...suites) > t };
}

/** Settles a command. `reply`: the app answers in the thread; `allowed`: the commenter may queue there, so the answer needs no comment approval. */
async function settle(db: Db, r: Row, state: "done" | "refused" | "ignored" | "expired", result: string | null, at: Date, o: { reply?: boolean; allowed?: boolean } = {}): Promise<void> {
  await db.run(db.k.updateTable("main.github_commands")
    .set({ state, result, done_at: at.toISOString(), reply: o.reply ? null : "none", allowed: o.allowed ? 1 : 0 })
    .where("comment_id", "=", r.comment_id));
  await audit(db, state === "ignored" || state === "expired" ? AUDIT_LOGIN : r.login, "github-command", refOf(r), { comment: r.comment_id, command: r.command, by: r.login, state, ...(result ? { result } : {}) });
}

/** Any of the items the command touches is a quiet pull request (a security fix not yet published): nothing is said there. */
const quietFor = async (db: Db, r: Row, qp: QueuePage): Promise<boolean> =>
  await someSeq([r.number, ...(r.pr ? [] : await qp.openPrsClosing(db, r.repo, r.number))], async (n) => await isQuiet(db, r.repo, n));

/** The access row of `login` while it is bound to the GitHub id `github_id`; a login never bound counts as unknown. */
export async function boundAccess(db: Db, r: { login: string; github_id: number }): Promise<NonNullable<Awaited<ReturnType<typeof getAccess>>> | null> {
  const access = await getAccess(db, r.login);
  const bound = (await db.get(db.k.selectFrom("main.access").select("github_id").where("login", "=", r.login)))?.github_id ?? null;
  return access && bound !== null && Number(bound) === r.github_id ? access : null;
}

/**
 * The commenter's access row, read now, or null after settling the command without an answer: no AutoCraft login, a login never
 * bound to a GitHub account or bound to another one (`ignored`), a viewer, or anyone but an operator on a quiet pull request (`refused`).
 */
async function knownCommenter(db: Db, r: Row, now: Date, qp: QueuePage): Promise<NonNullable<Awaited<ReturnType<typeof getAccess>>> | null> {
  const access = await boundAccess(db, r);
  if (!access) { await settle(db, r, "ignored", null, now); return null; }
  if (access.role !== "operator" && access.role !== "maintainer") { await settle(db, r, "refused", r.command === "autorepin" ? "viewers cannot set autorepin" : "viewers cannot queue items", now); return null; }
  if (access.role !== "operator" && await quietFor(db, r, qp)) { await settle(db, r, "refused", "the pull request is quiet until its fix is published", now); return null; }
  return access;
}

/**
 * Drops a command that ran out of time. One whose GitHub reads kept failing is answered once, so the commenter knows to comment
 * again; one that only waited (the runner was down, the item was not read again) ends silently.
 */
async function expire(db: Db, r: Row, now: Date, qp: QueuePage): Promise<void> {
  const role = (await boundAccess(db, r))?.role;
  const answer = r.retries > 0 && (role === "operator" || role === "maintainer") && !await quietFor(db, r, qp);
  await settle(db, r, "expired", answer ? NO_ACCESS_READ : null, now, { reply: answer });
}

type Outcome = "settled" | "retry" | "wait";

/**
 * Decides one queued command and carries it out. Who may queue is not decided here: queueAdd applies the rule of every person-started write
 * (settleRefusal in src/settlers.ts) to the commenter's current role and the write permission read from GitHub now. This settles what a
 * comment adds: who the commenter is, that the comment still says it, and the head it was written at. "retry" when GitHub could not be
 * read, "wait" when an item needs a newer read: the row stays queued.
 */
async function carryOut(db: Db, r: Row, deps: CommandDeps, now: Date, qp: QueuePage): Promise<Outcome> {
  const clock = deps.now ?? (() => new Date());
  // Before any GitHub read, so a commenter AutoCraft does not know costs no GitHub call.
  if (!await knownCommenter(db, r, now, qp)) return "settled";
  // The comment as it is now: a deleted comment, or one edited so that it no longer holds this command, runs nothing.
  let c: CommentNow;
  try {
    c = await (deps.comment ?? restComment)(r.repo, r.comment_id);
  } catch {
    return "retry";
  }
  const slug = deps.slug === undefined ? appSlug() : deps.slug;
  const cmd = c.kind === "ok" && c.authorId === r.github_id ? parseCommand(c.body, slug ?? "") : null;
  if (!cmd || !sameCommand(cmd, r)) {
    await settle(db, r, "ignored", c.kind === "gone" ? "the comment was deleted" : "the comment no longer holds the command", clock());
    return "settled";
  }
  // A role or setting that refuses whatever GitHub says is answered without the head and permission reads.
  const first = await knownCommenter(db, r, clock(), qp);
  if (!first) return "settled";
  if (cmd.command === "autorepin") return carryOutRepin(db, r, cmd.ref, cmd.branch, deps, clock, qp);
  if (await refusal(db, r, first.role as Role, true, qp)) return refuse(db, r, clock(), first.role as Role, true, qp);
  // The head each PR had when the comment was written: the PR itself, or for an issue its one closing PR, which must also be older
  // than the comment. A PR opened or pushed to later maps to null and is not queued.
  const heads = new Map<number, string | null>();
  const closing = r.pr ? [] : await qp.openPrsClosing(db, r.repo, r.number);
  for (const n of r.pr ? [r.number] : closing.length === 1 ? closing : []) {
    let p: PrNow | null;
    try {
      p = await (deps.pr ?? prSince)(deps.querier, r.repo, n, r.created_at);
    } catch {
      return "retry";
    }
    heads.set(n, !p || p.changed || (!r.pr && !(Date.parse(p.opened) < Date.parse(r.created_at))) ? null : p.head);
  }
  const perm = await liveWrite(db, r, deps);
  if (perm === "transient") return "retry";
  // The reads waited on GitHub: the hour may have run out meanwhile, and the outcome is recorded at this time.
  now = clock();
  if (now.getTime() - Date.parse(r.requested_at) >= EXPIRE_MS) { await expire(db, r, now, qp); return "settled"; }
  // Who the commenter is, read again: the role or the login's binding may have changed while GitHub answered, and the role queueAdd
  // checks is the one read here.
  const access = await knownCommenter(db, r, now, qp);
  if (!access) return "settled";
  const role = access.role as Role;
  // Again after the reads: a read may have been written meanwhile. The mirror never goes back to a read that started earlier
  // (writePage), so an item that passes here keeps a read from after the comment until queueAdd's pre-approval reads it.
  if (await waitsForRead(db, r, now, qp)) return "wait";
  if (await refusal(db, r, role, perm === "ok", qp)) return refuse(db, r, now, role, perm === "ok", qp);
  const quiet = await quietFor(db, r, qp);
  try {
    const label = await (deps.queue ?? queueVia(qp))(db, { login: r.login, role, canWrite: perm === "ok", repo: r.repo, item: refOf(r), weight: r.weight, bypass: r.bypass === 1, heads });
    const f = (await fastPositions(db)).get(refOf(r));
    await settle(db, r, "done", `${oneLine(label)}.${f ? ` Fast-tracked with weight ${f.weight}, ${f.position} of ${f.of}.` : ""}`, now, { reply: !quiet, allowed: true });
  } catch (e) {
    // Only a handler's own refusal is said on GitHub; anything else is logged here and answered with a fixed text.
    if (!(e instanceof HttpError)) deps.log?.(`github command ${refOf(r)}: ${oneLine(String((e as Error)?.message ?? e))}`);
    await settle(db, r, "refused", (e instanceof HttpError ? oneLine(e.message) : "") || NOT_QUEUED, now, { reply: !quiet, allowed: true });
  }
  return "settled";
}

/** The command a comment holds now is the stored one: an edit that names another pull request, weight or bypass runs nothing. */
function sameCommand(cmd: Command, r: Row): boolean {
  if (cmd.command !== r.command) return false;
  if (cmd.command === "merge-queue") return cmd.weight === r.weight && cmd.bypass === (r.bypass === 1);
  if (cmd.branch !== r.ref_branch) return false;
  return cmd.ref === null ? r.ref_repo === null && r.ref_number === null : refText(cmd.ref) === r.ref_repo && cmd.ref.number === r.ref_number;
}

/**
 * Carries out an autorepin command (src/repin/index.ts). Nothing is written at a head here, so no head is pinned and no read since
 * the comment is waited for: the push later reads the pull request live and checks the asker again.
 */
async function carryOutRepin(db: Db, r: Row, ref: PrRef | null, branch: string | null, deps: CommandDeps, clock: () => Date, qp: QueuePage): Promise<Outcome> {
  const perm = await liveWrite(db, r, deps);
  if (perm === "transient") return "retry";
  const now = clock();
  if (now.getTime() - Date.parse(r.requested_at) >= EXPIRE_MS) { await expire(db, r, now, qp); return "settled"; }
  const access = await knownCommenter(db, r, now, qp);
  if (!access) return "settled";
  const role = access.role as Role;
  const what = `sets autorepin on ${r.repo}`;
  const no = await settleRefusal(db, userOf({ login: r.login, role, repo: r.repo, canWrite: perm === "ok" }), [r.repo], what);
  const quiet = await quietFor(db, r, qp);
  if (no) { await settle(db, r, "refused", no, now, { reply: !quiet }); return "settled"; }
  try {
    const { requestRepin } = await import("../repin/index.ts");
    const label = await requestRepin(db, { login: r.login, githubId: r.github_id, role, canWrite: perm === "ok", repo: r.repo, number: r.number, pr: r.pr === 1, ref, branch, querier: deps.querier, at: new Date(r.created_at) });
    await settle(db, r, "done", `${oneLine(label)}.`, now, { reply: !quiet, allowed: true });
  } catch (e) {
    if (!(e instanceof HttpError)) deps.log?.(`github command ${refOf(r)}: ${oneLine(String((e as Error)?.message ?? e))}`);
    await settle(db, r, "refused", (e instanceof HttpError ? oneLine(e.message) : "") || NOT_SET, now, { reply: !quiet, allowed: true });
  }
  return "settled";
}

/** The queue rule's refusal for the commenter with `role` and GitHub's write answer `canWrite`, or null. */
const refusal = (db: Db, r: Row, role: Role, canWrite: boolean, qp: QueuePage): Promise<string | null> =>
  settleRefusal(db, userOf({ login: r.login, role, repo: r.repo, canWrite }), [r.repo], qp.queueWhat(r.repo));

/** Settles a command the queue rule refuses, in the rule's own words; not answered on a quiet PR. The answer needs the repo's comment approval. */
async function refuse(db: Db, r: Row, now: Date, role: Role, canWrite: boolean, qp: QueuePage): Promise<Outcome> {
  await settle(db, r, "refused", await refusal(db, r, role, canWrite, qp), now, { reply: !await quietFor(db, r, qp) });
  return "settled";
}

/**
 * True while an item the command may pre-approve has no read from GitHub since the comment: the item, and for an issue the open PRs
 * that close it (queueAdd queues the sole one). The read is the webhook's re-read, or the poll after a failed one; a request row
 * that is gone proves nothing, since a failed re-read drops it too. It must have started strictly after the comment: `synced_at` is
 * cut to the second, so one in the same instant may have started before it. For each stale item with no read queued it queues one,
 * at most once a minute (tried_at), so the command does not wait for a poll that may never read it again.
 */
async function waitsForRead(db: Db, r: Row, now: Date, qp: QueuePage): Promise<boolean> {
  const stale = await filterSeq([r.number, ...(r.pr ? [] : await qp.openPrsClosing(db, r.repo, r.number))], async (n) => {
    const read = (await db.get(db.k.selectFrom("main.item_reads").select("synced_at").where("repo", "=", r.repo).where("number", "=", n)))?.synced_at;
    return !read || Date.parse(read) <= Date.parse(r.requested_at);
  });
  if (!stale.length) return false;
  const ask = await filterSeq(stale, async (n) => !await db.get(db.k.selectFrom("main.sync_requests").select((eb) => eb.lit(1).as("one")).where("repo", "=", r.repo).where("number", "=", n)));
  for (const n of ask) {
    await db.run(db.k.insertInto("main.sync_requests")
      .values({ repo: r.repo, number: n, event: "issue_comment", requested_at: now.toISOString().replace(/\.\d+Z$/, "Z") })
      .onConflict((oc) => oc.columns(["repo", "number"]).doNothing()));
  }
  if (ask.length) await db.run(db.k.updateTable("main.github_commands").set({ tried_at: now.toISOString() }).where("comment_id", "=", r.comment_id));
  return true;
}

/** The answer posted on GitHub for a carried-out command. */
export function answerText(r: { login: string; state: string; result: string | null; command?: string }): string {
  return r.state === "done" ? `@${r.login} ${r.result}` : `@${r.login} ${r.command === "autorepin" ? "Autorepin not changed" : "Not added to the merge queue"}: ${r.result}.`;
}

/**
 * Posts the answer. An answer to someone who may queue on the repo needs no comment approval there; any other needs it. A paced write
 * leaves it for the next drain; any other failure is recorded (write.ts audits it) and not retried.
 */
async function answer(db: Db, r: Row, deps: CommandDeps): Promise<"posted" | "failed" | "paced"> {
  const g = await guardRepo(db, r.repo, r.allowed ? null : "comment", { operator: r.login }, undefined, r.login);
  let reply: "posted" | "failed";
  if ("refused" in g) {
    deps.log?.(`github command ${refOf(r)}: no answer: ${g.refused}`);
    reply = "failed";
  } else {
    try {
      const out = await ghComment({ db, login: r.login }, g, deps.exec ?? defaultExec, "github-command-reply", { repo: r.repo, number: r.number, pr: r.pr === 1 }, { by: "fixed-operator" }, answerText(r), { comment: r.comment_id, command: r.command });
      reply = out.code === 0 ? "posted" : "failed";
      if (out.code !== 0) deps.log?.(`github command ${refOf(r)}: the answer failed: ${oneLine(out.stderr || out.stdout)}`);
    } catch (e) {
      if (e instanceof WritePacedError) return "paced";
      deps.log?.(`github command ${refOf(r)}: the answer failed: ${oneLine(String((e as Error)?.message ?? e))}`);
      reply = "failed";
    }
  }
  await db.run(db.k.updateTable("main.github_commands").set({ reply }).where("comment_id", "=", r.comment_id));
  return reply;
}

/** SQL condition: rows a drain has work for, queued commands and settled ones whose answer is still to post (index github_commands_state). */
export const COMMAND_WORK_SQL = "(state = 'queued' OR (state <> 'queued' AND reply IS NULL))";
/** `COMMAND_WORK_SQL` as an expression on github_commands. */
export const commandWorkExpr = (eb: kx.Eb): AliasableExpression<SqlBool> => eb.or([eb("state", "=", "queued"), eb.and([eb("state", "<>", "queued"), eb("reply", "is", null)])]);

/**
 * Carries out the queued commands, oldest first, and posts their answers. Run after the webhook's re-reads, so the item is in the
 * mirror at its current head. Returns how many commands were settled.
 */
export async function drainCommands(db: Db, deps: CommandDeps): Promise<number> {
  const clock = deps.now ?? (() => new Date());
  const t0 = clock();
  // Every waiting row is read (an hour's commands at most): rows that wait for a re-read or a retry are passed over without
  // a GitHub call, so they never keep a newer command out. `limit` bounds the rows that call GitHub in one drain. Rows never tried
  // come first, oldest first, then retries by their last try, so due retries cannot fill the limit drain after drain either.
  const retryBefore = new Date(t0.getTime() - RETRY_MS).toISOString();
  const rows: Row[] = await db.all(db.k.selectFrom("main.github_commands").select(COLS)
    .where((eb) => eb.or([
      eb.and([eb("state", "=", "queued"), eb.or([eb("tried_at", "is", null), eb("tried_at", "<=", retryBefore)])]),
      eb.and([eb("state", "<>", "queued"), eb("reply", "is", null)]),
    ]))
    .orderBy((eb) => eb("tried_at", "is not", null))
    .orderBy((eb) => eb.fn.coalesce("tried_at", "requested_at"))
    .orderBy(kx.rowid("main.github_commands")));
  const qp = await import("../dash/api/queue-page.ts");
  let settled = 0, calls = 0;
  for (const r0 of rows) {
    if (calls >= (deps.limit ?? 10)) break;
    const now = clock();
    let r = r0;
    if (r.state === "queued") {
      if (now.getTime() - Date.parse(r.requested_at) >= EXPIRE_MS) await expire(db, r, now, qp);
      else if (r.command !== "merge-queue" && r.command !== "autorepin") await settle(db, r, "ignored", null, now);
      // No GitHub call while an item waits for a read since the comment (see waitsForRead); an autorepin pins no head and does not wait.
      else if (r.command === "merge-queue" && await waitsForRead(db, r, now, qp)) continue;
      else {
        calls++;
        const out = await carryOut(db, r, deps, now, qp);
        if (out === "wait") continue;
        if (out === "retry") {
          // GitHub could not be read: retried after RETRY_MS; the expiry still counts from requested_at.
          await db.run(db.k.updateTable("main.github_commands").set((eb) => ({ tried_at: clock().toISOString(), retries: eb("retries", "+", 1) })).where("comment_id", "=", r.comment_id));
          continue;
        }
      }
      settled++;
      r = (await db.get(db.k.selectFrom("main.github_commands").select(COLS).where("comment_id", "=", r.comment_id)))!;
      if (r.state === "queued" || r.reply !== null) continue;
    } else calls++;
    if ((await answer(db, r, deps)) === "paced") break;
  }
  return settled;
}

/** Deletes settled commands older than KEEP_MS. */
export async function pruneCommands(db: Db, nowMs: number = Date.now()): Promise<number> {
  return Number((await db.run(db.k.deleteFrom("main.github_commands").where("state", "<>", "queued").where("done_at", "<", new Date(nowMs - KEEP_MS).toISOString()))).changes);
}
