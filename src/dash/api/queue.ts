// Merge queue and batch rows as the dashboard shows them; viewers get the queue rows without the review's reason, verification
// text and the plan's quoted reasons (src/dash/api/reader.ts).
import type { BatchState, Mergeable, QueueBatch, QueueRow, QueueState, Tier, TypeLabel } from "../../../web/src/api/types.ts";
import type { CachedEntry } from "../../data/views/merge-queue.ts";
import type { BatchListRow } from "../../data/merge/index.ts";
import { queueTextFor, type Reader } from "./reader.ts";

const TIER: Record<string, Tier> = { whitelisted: "whitelisted", not: "not", allow: "override-allow", deny: "override-deny" };
const MERGEABLE: Record<string, Mergeable> = { MERGEABLE: "clean", CONFLICTING: "conflicts" };
const CI = ["success", "failure", "pending", "none"];

export const toRow = (e: CachedEntry, r: Reader): QueueRow => queueTextFor(r, {
  repo: e.repo, number: e.number, title: e.title, author: e.author ?? "", tier: TIER[e.tier] ?? "not", head: e.head,
  size: (["S", "M", "L"].includes(e.size) ? e.size : "L") as QueueRow["size"], label: e.label as TypeLabel | null,
  verdict: e.verdict, reason: e.reason, fixes: e.fixes,
  ci: (CI.includes(e.ci) ? e.ci : "unknown") as QueueRow["ci"], mergeable: MERGEABLE[e.mergeable] ?? "unknown",
  state: e.state as QueueState, path: e.path, outsideRule: e.outsideRule,
  refusedReason: e.refusedReason, note: e.note, reviewedAt: e.reviewedAt, verify: e.verify,
});

/** A batch row with its member PRs as queue rows. `summary` can hold raw push, PR and gh errors, so only staff get it. */
export function toBatch(b: BatchListRow, reader: Reader, prs: QueueRow[]): QueueBatch {
  return {
    id: b.id, repo: b.repo, branch: b.branch, fork: b.fork, state: b.state as BatchState, baseSha: b.base_sha, size: b.members.length, areas: b.areas, prs,
    prNumber: b.pr_number, prUrl: b.pr_url, summary: reader.staff ? b.summary : null, createdAt: b.created_at, updatedAt: b.updated_at,
  };
}
