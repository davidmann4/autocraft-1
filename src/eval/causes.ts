// How a run's candidate groups update the stored causes, and which causes the run investigates. Pure.
import type { EvalCause, EvalEvidence } from "../data/eval/index.ts";
import { HOUR, MIN, type Group } from "./detect.ts";

/** Evidence entries a cause keeps (the newest). */
export const EVIDENCE_KEPT = 50;
/** A cause that grew is investigated again at most this often; its issue gets at most one comment in the same time. */
export const REINVESTIGATE_MS = 24 * HOUR;
/** A failed investigation is asked again at the next hourly run, */
export const RETRY_FAILED_MS = 50 * MIN;
/** until this many failed in a row; then only new evidence brings another call. */
export const FAILURES_MAX = 3;
/** Investigation calls one run makes at most; the rest wait for the next run. */
export const INVESTIGATIONS_PER_RUN = 10;

/**
 * Adds the group's evidence to the cause (a new cause when there is none). An entry counts as new when its id is not kept
 * and it is newer than the oldest kept entry of a full list, so evidence that fell off the kept list is not counted twice.
 */
export function mergeGroup(was: EvalCause | undefined, g: Group, nowIso: string): { cause: EvalCause; added: number } {
  const kept = was?.evidence ?? [];
  const ids = new Set(kept.map((e) => e.id));
  const oldest = kept.length >= EVIDENCE_KEPT ? kept.reduce((a, b) => (a.at <= b.at ? a : b)).at : "";
  const fresh = g.evidence.filter((e) => !ids.has(e.id) && e.at > oldest);
  const evidence: EvalEvidence[] = [...kept, ...fresh].sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id)).slice(0, EVIDENCE_KEPT);
  const base: EvalCause = was ?? {
    key: g.key, detector: g.detector, summary: g.summary, state: "new", firstSeen: nowIso, lastSeen: nowIso, evidence: [], seen: 0,
    investigatedAt: null, investigatedSeen: 0, verdict: null, failures: 0, finding: null, model: null, runId: null, issueNumber: null, filedAt: null, reportedSeen: 0, commentedAt: null, attempts: 0, note: null,
  };
  return { cause: { ...base, summary: g.summary, lastSeen: nowIso, evidence, seen: base.seen + fresh.length }, added: fresh.length };
}

/**
 * Whether a cause seen in this run gets an investigation call: never asked, its last call failed an hour ago (fewer than
 * FAILURES_MAX in a row, or new evidence since), or it grew and its last call is a day old.
 */
export function wantsInvestigation(c: EvalCause, nowMs: number): boolean {
  if (c.state === "declined" || c.state === "filing") return false;
  if (c.investigatedAt === null) return true;
  const age = nowMs - Date.parse(c.investigatedAt);
  if (c.verdict === "failed") return age >= RETRY_FAILED_MS && (c.failures < FAILURES_MAX || c.seen > c.investigatedSeen);
  return c.seen > c.investigatedSeen && age >= REINVESTIGATE_MS;
}

/** The causes this run investigates: those that want a call, new ones first, then grown ones, then failed ones; at most INVESTIGATIONS_PER_RUN. */
export function investigationsDue(causes: readonly EvalCause[], nowMs: number): EvalCause[] {
  const rank = (c: EvalCause): number => (c.investigatedAt === null ? 0 : c.verdict === "failed" ? 2 : 1);
  return causes.filter((c) => wantsInvestigation(c, nowMs))
    .sort((a, b) => rank(a) - rank(b) || b.seen - b.investigatedSeen - (a.seen - a.investigatedSeen) || b.lastSeen.localeCompare(a.lastSeen))
    .slice(0, INVESTIGATIONS_PER_RUN);
}
