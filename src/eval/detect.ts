// The self-evaluation's detectors: deterministic rules over what the records show, each yielding candidate groups keyed by
// the cause (never by an item), with their evidence. Pure: the facts come from src/data/eval, the health checks from the caller.
import { createHash } from "node:crypto";
import type { EvalEvidence, EvalFacts } from "../data/eval/index.ts";

export const MIN = 60_000;
export const HOUR = 60 * MIN;

/** Thresholds of the detectors. */
export const EVAL_LIMITS = {
  stalledMs: 2 * HOUR,
  callQueuedMs: 30 * MIN,
  jobQueuedMs: HOUR,
  callWaitMs: 10 * MIN,
  failuresPerDay: 3,
  idleJobsPerDay: 8,
  blockedUnaskedMs: HOUR,
  churnPerDay: 10,
  answerIdleMs: HOUR,
  writeFailuresPerDay: 3,
  retriesPerDay: 3,
  healthOnMs: HOUR,
  callsPerMergeMin: 15,
  callsPerMergeFactor: 3,
};

export type Detector = "stalled-item" | "queued-call-idle-runner" | "queued-job" | "jobs-wait-on-calls" | "step-failing" | "idle-repeat" | "blocked-unasked"
  | "comment-churn" | "answer-ran-nothing" | "refused-write" | "retries" | "health-stays-on" | "calls-per-merge";

/** What each detector looks for, in one sentence (shown to the model and in the issue). */
export const DETECTOR_RULES: Record<Detector, string> = {
  "stalled-item": "A started item's workflow stays running or waiting for 2 hours or more with no change and no question open to anyone.",
  "queued-call-idle-runner": "A model call stays queued for 30 minutes or more while a ready Task Runner has a free slot.",
  "queued-job": "A job stays queued for an hour or more.",
  "jobs-wait-on-calls": "A job stays queued for an hour or more while every running job waits on a model call queued for 10 minutes or more.",
  "step-failing": "Jobs of one step fail 3 or more times in 24 hours with the same error.",
  "idle-repeat": "One step runs 8 or more jobs in 24 hours on one repo that handle and act on nothing.",
  "blocked-unasked": "A workflow stopped at a blocker for an hour or more with no recommendation written, so nobody is asked.",
  "comment-churn": "One GitHub comment or status action is written 10 or more times on the same item in 24 hours.",
  "answer-ran-nothing": "A person's answer or start is an hour old, its item is still live, and no job has touched the item since.",
  "refused-write": "One kind of GitHub write fails 3 or more times in 24 hours with the same error.",
  "retries": "One item gets 3 or more retry requests in 24 hours.",
  "health-stays-on": "A health check stays in warning or failure for an hour or more.",
  "calls-per-merge": "A pull request merged in the last 7 days took at least 15 model calls and 3 times the median of merged pull requests.",
};

export type Group = { key: string; detector: Detector; summary: string; evidence: EvalEvidence[] };
export type HealthCheck = { id: string; state: "ok" | "warn" | "fail"; brief: string; since: string | null };
export type DetectInput = { facts: EvalFacts; checks: HealthCheck[]; nowMs: number; runnerFreshMs: number };

const iso = (ms: number): string => new Date(ms).toISOString();
const mins = (ms: number): number => Math.floor(ms / MIN);
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;
const hash8 = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 8);
const REF = /^([A-Za-z0-9._-]+)#([1-9][0-9]*)$/;
const refOf = (s: string | null): { repo: string; number: number } | undefined => {
  const m = s ? REF.exec(s) : null;
  return m ? { repo: m[1]!, number: Number(m[2]) } : undefined;
};

/** An error line with what varies between occurrences taken out (numbers, hashes, refs, quoted parts), for grouping. */
export function normalizeError(e: string): string {
  return e.toLowerCase()
    .replace(/[A-Za-z0-9._-]+#\d+/g, "<ref>")
    .replace(/(["'`]).*?\1/g, "<q>")
    .replace(/\b[0-9a-f]{7,64}\b/g, "<sha>")
    .replace(/\d+(?:\.\d+)?/g, "0")
    .replace(/\s+/g, " ").trim().slice(0, 120);
}

/** Adds `e` to the group `key`, making it with `summary` the first time. */
function collect(out: Map<string, Group>, key: string, detector: Detector, e: EvalEvidence): void {
  const g = out.get(key) ?? out.set(key, { key, detector, summary: "", evidence: [] }).get(key)!;
  if (!g.evidence.some((x) => x.id === e.id)) g.evidence.push(e);
}

const groupBy = <T,>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const r of rows) (m.get(key(r)) ?? m.set(key(r), []).get(key(r))!).push(r);
  return m;
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : 0;
};

/** The candidate groups the records show now, each with its evidence and a one-line summary, ordered by key. */
export function detect(x: DetectInput): Group[] {
  const { facts: f, nowMs: now } = x, L = EVAL_LIMITS;
  const out = new Map<string, Group>();
  const day = now - 24 * HOUR;

  for (const w of f.workflows) {
    const age = now - Date.parse(w.updatedAt);
    if ((w.state === "running" || w.state === "waiting") && age >= L.stalledMs) {
      collect(out, `stalled-item:${w.state}:${w.step ?? "none"}`, "stalled-item", { id: `wf:${w.id}`, at: w.updatedAt, note: `${w.state} at step ${w.step ?? "none"} for ${mins(age)} min`, ref: { repo: w.repo, number: w.number } });
    }
    if (w.state === "blocked" && w.rec === null && age >= L.blockedUnaskedMs) {
      collect(out, `blocked-unasked:${w.blocker ?? "none"}`, "blocked-unasked", { id: `wf:${w.id}`, at: w.updatedAt, note: `stopped at blocker ${w.blocker ?? "none"} for ${mins(age)} min with no recommendation`, ref: { repo: w.repo, number: w.number } });
    }
  }

  const idle = f.runners.filter((r) => r.readiness === "ready" && r.reportedAt >= now - x.runnerFreshMs && (r.busy ?? 0) < (r.slots ?? 1));
  const free = idle.reduce((n, r) => n + Math.max(0, (r.slots ?? 1) - (r.busy ?? 0)), 0);
  if (idle.length) {
    for (const c of f.queuedCalls) {
      const age = now - c.queuedSince;
      if (age < L.callQueuedMs) continue;
      const noTaker = c.noTakerSince === null ? "" : `; no Task Runner may take it since ${mins(now - c.noTakerSince)} min`;
      collect(out, `queued-call:${c.step}`, "queued-call-idle-runner", { id: `call:${c.id}`, at: iso(c.queuedSince), note: `${c.promptId} queued ${mins(age)} min while ${plural(idle.length, "ready Task Runner")} had ${plural(free, "free slot")}${noTaker}`, ...(c.refs[0] && { ref: c.refs[0] }) });
    }
  }

  const queued = f.liveJobs.filter((j) => j.state === "queued" && now - Date.parse(j.requestedAt) >= L.jobQueuedMs);
  for (const j of queued) collect(out, `queued-job:${j.step}`, "queued-job", { id: `job:${j.id}`, at: j.requestedAt, note: `${j.step} queued ${mins(now - Date.parse(j.requestedAt))} min` });
  const running = f.liveJobs.filter((j) => j.state === "running");
  const waitOf = new Map<number, { id: number; age: number }>();
  for (const c of f.queuedCalls) if (c.jobId !== null && now - c.queuedSince >= L.callWaitMs && !waitOf.has(c.jobId)) waitOf.set(c.jobId, { id: c.id, age: now - c.queuedSince });
  if (queued.length && running.length && running.every((j) => waitOf.has(j.id))) {
    const key = "running-jobs-wait-on-calls";
    for (const j of running) { const w = waitOf.get(j.id)!; collect(out, key, "jobs-wait-on-calls", { id: `job:${j.id}`, at: j.startedAt ?? j.requestedAt, note: `running ${j.step}, waiting on call ${w.id} queued ${mins(w.age)} min` }); }
    const oldest = queued.reduce((a, b) => (a.requestedAt <= b.requestedAt ? a : b));
    collect(out, key, "jobs-wait-on-calls", { id: `job:${oldest.id}`, at: oldest.requestedAt, note: `${oldest.step} queued ${mins(now - Date.parse(oldest.requestedAt))} min behind them` });
  }

  const failed = f.endedJobs.filter((j) => j.state === "failed" && j.error && Date.parse(j.endedAt) >= day);
  for (const [k, rows] of groupBy(failed, (j) => `${j.step}\u0000${normalizeError(j.error!)}`)) {
    if (rows.length < L.failuresPerDay) continue;
    const [step, norm] = k.split("\u0000") as [string, string];
    for (const j of rows) collect(out, `job-failed:${step}:${hash8(norm)}`, "step-failing", { id: `job:${j.id}`, at: j.endedAt, note: `${step} failed: ${j.error!.slice(0, 200)}` });
  }
  const idleJobs = f.endedJobs.filter((j) => j.state === "done" && j.repo !== null && j.items === 0 && j.acted === 0 && Date.parse(j.endedAt) >= day);
  for (const [, rows] of groupBy(idleJobs, (j) => `${j.step}\u0000${j.repo}`)) {
    if (rows.length < L.idleJobsPerDay) continue;
    for (const j of rows) collect(out, `idle-jobs:${j.step}`, "idle-repeat", { id: `job:${j.id}`, at: j.endedAt, note: `${j.step} job handled and acted on nothing (${rows.length} such jobs on its repo in 24 h)` });
  }

  const audit = f.audit.filter((a) => Date.parse(a.at) >= day);
  const churny = audit.filter((a) => a.target !== null && (/-comment(-edit)?$/.test(a.action) || a.action === "review-edit" || a.action === "labels-apply"));
  for (const [, rows] of groupBy(churny, (a) => `${a.action}\u0000${a.target}`)) {
    if (rows.length < L.churnPerDay) continue;
    for (const a of rows) collect(out, `churn:${a.action}`, "comment-churn", { id: `audit:${a.rowid}`, at: a.at, note: `${a.action} (${rows.length} on this item in 24 h)`, ...(refOf(a.target) && { ref: refOf(a.target)! }) });
  }
  for (const [k, rows] of groupBy(audit.filter((a) => a.error !== null && a.action !== "retry"), (a) => `${a.action}\u0000${normalizeError(a.error!)}`)) {
    if (rows.length < L.writeFailuresPerDay) continue;
    const [action, norm] = k.split("\u0000") as [string, string];
    for (const a of rows) collect(out, `write-failed:${action}:${hash8(norm)}`, "refused-write", { id: `audit:${a.rowid}`, at: a.at, note: `${action} failed: ${a.error!.slice(0, 200)}`, ...(refOf(a.target) && { ref: refOf(a.target)! }) });
  }
  for (const [, rows] of groupBy(audit.filter((a) => a.action === "retry" && a.target !== null), (a) => a.target!)) {
    if (rows.length < L.retriesPerDay) continue;
    for (const a of rows) collect(out, `retries:${a.step ?? "any"}`, "retries", { id: `audit:${a.rowid}`, at: a.at, note: `retry of ${a.step ?? "a step"} (${rows.length} on this item in 24 h)`, ...(refOf(a.target) && { ref: refOf(a.target)! }) });
  }

  for (const e of f.answers) {
    if (!e.live || e.touchedAfter || now - Date.parse(e.at) < L.answerIdleMs) continue;
    collect(out, "answer-ran-nothing", "answer-ran-nothing", { id: `answer:${e.id}`, at: e.at, note: `${e.kind} ${mins(now - Date.parse(e.at))} min ago; no job touched the item since`, ref: { repo: e.repo, number: e.number } });
  }

  for (const c of x.checks) {
    if (c.state === "ok" || !c.since || now - Date.parse(c.since) < L.healthOnMs) continue;
    collect(out, `health:${c.id}`, "health-stays-on", { id: `check:${c.id}:${c.since}`, at: c.since, note: `${c.state} for ${mins(now - Date.parse(c.since))} min: ${c.brief.slice(0, 200)}` });
  }

  const med = median(f.merged.map((m) => m.calls));
  for (const m of f.merged) {
    if (m.calls < Math.max(L.callsPerMergeMin, L.callsPerMergeFactor * med)) continue;
    const parts = Object.entries(m.byPrompt).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} ${n}`).join(", ");
    collect(out, "calls-per-merge", "calls-per-merge", { id: `item:${m.repo}#${m.number}`, at: m.mergedAt, note: `${m.calls} model calls ($${m.costUsd.toFixed(2)}; median ${med}): ${parts}`, ref: { repo: m.repo, number: m.number } });
  }

  for (const g of out.values()) g.summary = `${plural(g.evidence.length, "piece")} of evidence: ${DETECTOR_RULES[g.detector]}`;
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}
