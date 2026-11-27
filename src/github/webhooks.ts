// GitHub App webhooks. A delivery is verified, reduced to the repo and item number it names, and queued; the
// runner re-reads those items from GitHub. Every verified delivery also marks the webhooks as working (sync_state.webhook_at), which
// lets the sync poll only as a backstop (src/mirror.ts pollReason). A push or completed check suite on a default branch makes the
// default-branch CI poll due. A new comment addressed to the app with a command (src/github/commands.ts) also
// queues that command, with the commenter and the comment's id. An installation delivery is checked against the allowed
// owners (src/github/allowed-owners.ts). Nothing else in the payload is stored, and none of it reaches a prompt.
import { createHmac } from "node:crypto";
import { installationEvent } from "./allowed-owners.ts";
import { queueCommand } from "./commands.ts";
import { ONE_QUERY, Transient, writeItemNode, type Querier } from "../mirror.ts";
import { ownerOf } from "../owners.ts";
import type { Db } from "../db/index.ts";
import { listItems, loadSyncRequests, queueSyncRequests, removeSyncRequests, saveSyncState } from "../data/mirror/index.ts";
import { loadTrackedRepos } from "../data/control/index.ts";

export const WEBHOOK_PATH = "/webhooks/github";
export const WEBHOOK_BODY_LIMIT = 1024 * 1024;

export function signatureOf(secret: string, raw: Buffer | string): string {
  return `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
}

export type ItemRefOnly = { repo: string; number: number };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

/** The tracked repo name for a payload's `owner/name`, or null when AutoCraft does not track it. */
async function trackedName(db: Db, payload: Obj): Promise<string | null> {
  const full = obj(payload.repository).full_name;
  if (typeof full !== "string") return null;
  const i = full.indexOf("/");
  if (i < 1) return null;
  const owner = full.slice(0, i);
  const name = full.slice(i + 1);
  if (!(await loadTrackedRepos(db, [name])).has(name)) return null;
  return ownerOf(name).toLowerCase() === owner.toLowerCase() ? name : null;
}

/**
 * The item numbers an event names. A completed check suite counts and names the pull requests of its head;
 * GitHub lists none for a fork's pull request, so the head commit is matched to this repository's open pull requests.
 */
export async function itemNumbers(db: Db, repo: string, event: string, payload: Obj): Promise<number[]> {
  const one = (v: unknown): number[] => [num(v)].filter((n): n is number => n !== null);
  switch (event) {
    case "issues":
    case "issue_comment": return one(obj(payload.issue).number);
    case "pull_request":
    case "pull_request_review":
    case "pull_request_review_comment": return one(obj(payload.pull_request).number);
    case "status": {
      // A commit status (CI outside GitHub Actions) names a commit: the open pull requests at it. Pending states change nothing settled.
      const sha = payload.sha;
      if (payload.state === "pending" || typeof sha !== "string" || !sha) return [];
      return (await listItems(db, { repos: [repo], kind: "pr", states: ["OPEN"], headOid: sha }, "ref")).map((r) => r.number);
    }
    case "check_suite": {
      const body = obj(payload.check_suite);
      if (payload.action !== "completed") return [];
      const repoId = obj(payload.repository).id;
      const listed = Array.isArray(body.pull_requests) ? body.pull_requests : [];
      const own = listed.filter((p) => repoId !== undefined && obj(obj(obj(p).base).repo).id === repoId).flatMap((p) => one(obj(p).number));
      if (own.length || listed.length) return own;
      const sha = body.head_sha;
      if (typeof sha !== "string" || !sha) return [];
      return (await listItems(db, { repos: [repo], kind: "pr", states: ["OPEN"], headOid: sha }, "ref")).map((r) => r.number);
    }
    default: return [];
  }
}

/** A push to the default branch, or a completed check suite on it: the default branch's CI state may have changed. */
export function touchesDefaultBranch(event: string, payload: Obj): boolean {
  const branch = obj(payload.repository).default_branch;
  if (typeof branch !== "string" || !branch) return false;
  if (event === "push") return payload.ref === `refs/heads/${branch}`;
  if (event === "check_suite") return payload.action === "completed" && obj(payload.check_suite).head_branch === branch;
  return false;
}

/** Start of this process: a receiver that started after the last poll may have missed deliveries while it was down. */
const RECEIVER_STARTED = new Date();
/** How often one process records that deliveries arrive. */
const NOTE_EVERY_MS = 30_000;
let notedAt: number | null = null;

/**
 * Records that a verified delivery arrived, at most every 30 seconds per process; the first record of a process also names its
 * start. A failed write is logged and never fails the delivery.
 */
export async function noteDelivery(db: Db, now: Date = new Date(), started: Date = RECEIVER_STARTED): Promise<void> {
  if (notedAt !== null && now.getTime() - notedAt < NOTE_EVERY_MS) return;
  const first = notedAt === null;
  notedAt = now.getTime();
  try {
    await saveSyncState(db, { webhook_at: isoS(now), ...(first && { webhook_started_at: isoS(started) }) });
  } catch (e) {
    notedAt = null;
    console.log(`webhook note: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
}

/** Forgets this process's last record, as a new process would (tests). */
export function resetDeliveryNote(): void {
  notedAt = null;
}

const isoS = (d: Date): string => d.toISOString().replace(/\.\d+Z$/, "Z");

/** Queues the items one delivery names, one row per item, and a command to the app (`appSlug`) in a new comment. Returns how many items were queued. */
export async function queueDelivery(db: Db, event: string, payload: unknown, now: Date = new Date(), appSlug?: string | null): Promise<number> {
  const p = obj(payload);
  const repo = await trackedName(db, p);
  if (!repo) return 0;
  // A command that cannot be stored never keeps the delivery's re-read from being queued.
  try {
    await queueCommand(db, repo, event, p, appSlug, now);
  } catch (e) {
    console.log(`webhook command in ${repo}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
  if (touchesDefaultBranch(event, p)) await saveSyncState(db, { main_ci_polled_at: null });
  const numbers = await itemNumbers(db, repo, event, p);
  if (!numbers.length) return 0;
  const at = isoS(now);
  await queueSyncRequests(db, numbers.map((n) => ({ repo, number: n, event, requestedAt: at })), { replace: true });
  return numbers.length;
}

export type Verdict = { status: number; queued?: number };

/** One delivery: verifies the signature over the raw body, then queues. `appSlug` is the app's slug, which comments address commands to. Never throws on bad input. */
export async function handleDelivery(db: Db, secret: string | null, headers: { signature?: string; event?: string }, raw: Buffer, safeEqual: (a: string, b: string) => boolean, appSlug?: string | null): Promise<Verdict> {
  if (!secret) return { status: 401 };
  if (!headers.signature || !safeEqual(headers.signature, signatureOf(secret, raw))) return { status: 401 };
  const event = headers.event ?? "";
  await noteDelivery(db);
  if (event === "ping") return { status: 200 };
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return { status: 400 };
  }
  // An installation on an account that is not an allowed owner is removed right after the answer; the sweep is the backup.
  if (event === "installation" || event === "installation_repositories") {
    void installationEvent(db, event, payload).catch((e: unknown) => console.log(`webhook ${event}: ${String((e as Error)?.message ?? e).slice(0, 200)}`));
    return { status: 202, queued: 0 };
  }
  return { status: 202, queued: await queueDelivery(db, event, payload, new Date(), appSlug) };
}

/** Requests older than this are dropped: the poll has read the item since. */
const ABANDON_MS = 6 * 3600_000;

/**
 * Re-reads the queued items from GitHub, oldest request first, with the writer the sync uses. A failed
 * read leaves the request for the next drain until it is old; the regular poll covers it either way.
 * Stops at the first rate-limit or transport failure.
 */
export async function drainSyncRequests(db: Db, client: Querier, opts: { limit?: number; reserve?: number; now?: Date; log?: (l: string) => void } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const rows = await loadSyncRequests(db, opts.limit ?? 20);
  let done = 0;
  for (const r of rows) {
    // Arrived after this row was read: left for the next drain.
    const gone = async (): Promise<void> => await removeSyncRequests(db, [{ repo: r.repo, number: r.number, requestedAt: r.requested_at }]);
    if (now.getTime() - Date.parse(r.requested_at) > ABANDON_MS) { await gone(); continue; }
    // Never wait out a rate limit here; the poll has its own handling.
    if (client.remaining !== null && client.remaining < (opts.reserve ?? 1000)) break;
    try {
      const sentAt = new Date();
      const data = await client.query(ONE_QUERY, { owner: ownerOf(r.repo), name: r.repo, number: r.number });
      if (!await writeItemNode(db, r.repo, data.repository?.issueOrPullRequest, sentAt)) { await gone(); continue; }
      await gone();
      done++;
    } catch (e) {
      opts.log?.(`webhook re-read ${r.repo}#${r.number}: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
      // A read that fails for another reason would stay first in line and starve the rest; the poll covers it.
      if (e instanceof Transient) break;
      await gone();
    }
  }
  return done;
}
