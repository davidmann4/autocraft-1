// A PR whose mergeable state GitHub keeps reporting as unknown. The checks step reads every waiting PR each minute; when a read still
// shows UNKNOWN after READS_BEFORE_REQUEST reads, the PR is read again (GitHub computes the merge state when a PR is requested), at most
// UNKNOWN_REREADS times. A PR still unknown then is marked stuck for the planner (src/core/decide.ts).
import type { Querier } from "../mirror.ts";
import { refreshChecks, type PrChecks } from "../review/checks.ts";

import { spawn } from "node:child_process";
import { slugOf } from "../owners.ts";
import { UNKNOWN_REREADS } from "../core/rules.ts";
import { readEnvFor } from "../github/read.ts";
import { loadUnknownDue, markUnknownStuck, noteMergeable as saveMergeable, removeMergeState } from "../data/merge/index.ts";
import type { UnknownState } from "../data/merge/types.ts";
import { loadLatestReviews } from "../data/review/index.ts";
import { listWorkflows } from "../data/workflow/index.ts";
import type { Db } from "../db/index.ts";

export type { UnknownState };

/** GraphQL checks reads in a row that still showed an unknown state before GitHub's REST endpoint is asked (a count, not a clock). */
export const READS_BEFORE_REQUEST = 5;

const known = (r: PrChecks): boolean => r.mergeable === "MERGEABLE" || r.mergeable === "CONFLICTING";

/**
 * Follows PRs whose plan waits on GitHub's mergeable state: a take review at the head, or a live merge-queue start, and CI success. Counts the consecutive checks reads
 * that still show an unknown state; a known state forgets the PR.
 */
export async function noteMergeable(db: Db, rows: PrChecks[], at: string): Promise<void> {
  const waiting = rows.filter((r) => !known(r) && r.state === "OPEN" && r.overall === "success");
  const refs = waiting.map((r) => ({ repo: r.repo, number: r.number }));
  const [reviews, started] = await db.together(() => Promise.all([loadLatestReviews(db, refs), listWorkflows(db, { live: true, refs })]));
  const queued = new Set(started.filter((w) => w.entry === "merge").map((w) => `${w.repo}#${w.number}`));
  const taken = new Set<string>();
  for (const r of waiting) {
    const v = reviews.get(`${r.repo}#${r.number}`);
    if (queued.has(`${r.repo}#${r.number}`) || (v && v.head === r.head_oid && (v.verdict === "take" || v.verdict === "take-fix"))) taken.add(`${r.repo}#${r.number}@${r.head_oid}`);
  }
  await saveMergeable(db, rows, at, taken);
}

/** What the planner needs for one open PR at a head, or null when its state is not unknown (or not noted yet). */
export async function unknownOf(db: Db, repo: string, n: number, head: string): Promise<UnknownState | null> {
  const s = (await loadUnknownDue(db, repo)).find((r) => r.number === n)?.state;
  return s && s.head === head ? s : null;
}

/** The mergeable state of a PR as GitHub's REST endpoint reports it (reading it starts GitHub's mergeability job); null while GitHub has not computed it. */
export type RestRead = (repo: string, number: number) => Promise<string | null>;

export const restMergeable: RestRead = async (repo, number) => {
  const args = ["api", `repos/${slugOf(repo)}/pulls/${number}`, "--jq", ".mergeable"];
  const env = await readEnvFor("gh", args);
  return new Promise((resolve, reject) => {
  const p = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"], ...(env ? { env } : {}) });
  let out = "", err = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  p.on("error", reject);
  p.on("close", (code) => (code === 0 ? resolve(out.trim() === "true" ? "MERGEABLE" : out.trim() === "false" ? "CONFLICTING" : null) : reject(new Error(err.trim().slice(0, 200) || `gh exited ${code}`))));
  });
};

/**
 * Requests a PR whose state stayed unknown for READS_BEFORE_REQUEST checks reads from GitHub's REST endpoint, which starts the mergeability job.
 * A null answer marks the PR stuck. No clock: one request per PR and head. A known answer is stored by reading the PR's checks again.
 */
export async function rereadUnknown(db: Db, client: Querier, repo: string, log: (line: string) => void = () => {}, read: RestRead = restMergeable): Promise<number[]> {
  await removeMergeState(db, { repo, closed: true });
  const noted = await loadUnknownDue(db, repo);
  const done: number[] = [], knownNow: number[] = [];
  const stuck: { repo: string; number: number; head: string; reads: number }[] = [];
  for (const { number: n, state: s } of noted) {
    if (s.stuck || s.rereads >= UNKNOWN_REREADS || s.reads < READS_BEFORE_REQUEST) continue;
    let state: string | null;
    try { state = await read(repo, n); } catch (e) { log(`checks: ${repo}#${n}: the REST read failed: ${String((e as Error).message ?? e)}`); continue; }
    done.push(n);
    if (state !== null) { knownNow.push(n); continue; }
    stuck.push({ repo, number: n, head: s.head, reads: s.reads });
  }
  // A row the checks step rewrote meanwhile (a new head, another read) keeps that newer value.
  if (stuck.length) await markUnknownStuck(db, stuck);
  if (knownNow.length) await refreshChecks(db, client, repo, knownNow, log);
  if (done.length) log(`checks: ${repo}: requested ${done.length} PR${done.length === 1 ? "" : "s"} with an unknown mergeable state from GitHub (${done.map((n) => `#${n}`).join(", ")})`);
  return done;
}
