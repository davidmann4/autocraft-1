// Per-repo sync failures: one repo that cannot be read is skipped for the run and recorded here; the health checks read the table.
import type { Db } from "./db/index.ts";
import * as mirror from "./data/mirror/index.ts";

export type RepoErrorKind = "not-found" | "forbidden" | "transient" | "error";

/** Reads of a repo's error row, newest streak first. */
export type RepoError = { repo: string; kind: RepoErrorKind; message: string; movedTo: string | null; since: string; at: string };

/** The kind of a failed read: GraphQL type or HTTP status for GitHub errors, the class for a transient one. */
export function classifyFailure(e: unknown): RepoErrorKind {
  const err = e as { type?: string | null; status?: number; name?: string; constructor?: { name?: string } };
  if (err?.type === "NOT_FOUND" || err?.status === 404) return "not-found";
  if (err?.type === "FORBIDDEN" || err?.status === 403) return "forbidden";
  if (err?.constructor?.name === "Transient") return "transient";
  return "error";
}

const iso = (d: Date): string => d.toISOString().replace(/\.\d+Z$/, "Z");

/** Records that `repo` failed; the streak's `since` stays from the first failure of the same kind. */
export async function recordRepoFailure(db: Db, repo: string, e: unknown, movedTo: string | null = null, now: Date = new Date()): Promise<RepoErrorKind> {
  const kind = classifyFailure(e);
  const message = String((e as Error)?.message ?? e).slice(0, 300);
  await mirror.recordRepoFailures(db, [{ repo, kind, message, movedTo, at: iso(now) }]);
  return kind;
}

export async function clearRepoFailure(db: Db, repo: string): Promise<void> {
  await mirror.clearRepoFailures(db, [repo]);
}

/** Errors of repos that are still tracked. */
export async function repoErrors(db: Db): Promise<RepoError[]> {
  return (await mirror.loadRepoErrors(db)).map((r) => ({ repo: r.repo, kind: r.kind as RepoErrorKind, message: r.message, movedTo: r.moved_to, since: r.since, at: r.at }));
}
