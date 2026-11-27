// Reads why a head's CI failed. Read-only: two `gh` calls per failed run, no write wrapper. The text is the
// PR's own CI output, so it is untrusted data wherever it goes next (a prompt frames it as such).
import type { Gh } from "../merge/safe-merge.ts";
import type { CiFailure, FailedCheck, FailedStep } from "./types.ts";
import { slugOf } from "../owners.ts";

/** Characters kept from the end of one failed step's log, per check, and in all. */
export const STEP_TAIL = 4000;
export const CHECK_CAP = 8000;
export const TOTAL_CAP = 16_000;
/** Failed steps kept per check. */
const MAX_STEPS = 3;

const FAILED = new Set(["failure", "timed_out", "cancelled", "startup_failure", "stale"]);
/** Colour codes, raw or in the caret notation (`^[[1m`) some job logs carry them in. */
const ANSI = /(?:\u001b|\^\[)\[[0-9;?]*[A-Za-z]/g;
const STAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
const GATE = /gate/i;

type CheckRuns = { check_runs?: { name?: string; status?: string; conclusion?: string | null; details_url?: string | null; completed_at?: string | null }[] };
type Run = { name: string; conclusion: string; runId: number | null; completedAt: string | null };

/**
 * The failed check runs of a head. The repos' CI calls the suite's gate workflow, so its checks carry "gate" in their
 * name; when some failed check does, only those count (a failing optional check next to a passing gate is not the
 * gate's failure). With no such name every failed check counts. `gatePassed`: gate checks exist and none failed, so
 * whatever fails is not the gate and is left alone. Checks on the repo's optional list are never failures to fix.
 */
export function failedRuns(reply: CheckRuns, optional: string[] = []): { runs: Run[]; gatePassed: boolean } {
  const all = reply.check_runs ?? [];
  const failed = all.filter((c) => c.status === "completed" && FAILED.has(c.conclusion ?? "") && !optional.includes(c.name ?? "?"))
    .map((c) => ({ name: c.name ?? "?", conclusion: c.conclusion ?? "failure", runId: Number(/\/actions\/runs\/(\d+)/.exec(c.details_url ?? "")?.[1]) || null, completedAt: c.completed_at ?? null }));
  const gate = failed.filter((c) => GATE.test(c.name));
  const gatePassed = !gate.length && all.some((c) => GATE.test(c.name ?? ""));
  return { runs: gate.length ? gate : failed, gatePassed };
}

/** The step name `gh` gives every line when it cannot split a job's log into steps: the line's job log is then the whole job's. */
export const UNKNOWN_STEP = "UNKNOWN STEP";
const POST_JOB = /^Post job cleanup\.$/;
const ERROR_LINE = /^##\[error\]/;
/** A step's start: its display name, or failing that the `Run <command>` line of its group. */
const STEP_NAMES = [/^##\[start-action display=([^;\]]+)/, /^##\[group\]Run (.+)$/];
/** Characters of a step name taken from a `Run <command>` line. */
const STEP_NAME = 80;

/**
 * The failed step of a whole job's log: the lines up to its last `##[error]` line before the post-job cleanup (which can run to
 * hundreds of kilobytes after the failure), named after the step that line ends. Without an error line, the lines before the cleanup.
 */
export function failedPart(lines: readonly string[]): { step: string; lines: string[] } {
  const post = lines.findIndex((l) => POST_JOB.test(l));
  const body = post < 0 ? [...lines] : lines.slice(0, post);
  let end = body.length - 1;
  while (end >= 0 && !ERROR_LINE.test(body[end]!)) end--;
  const kept = end < 0 ? body : body.slice(0, end + 1);
  for (const re of STEP_NAMES) {
    for (let i = kept.length - 1; i >= 0; i--) {
      const m = re.exec(kept[i]!);
      if (m) return { step: m[1]!.trim().slice(0, STEP_NAME), lines: kept };
    }
  }
  return { step: UNKNOWN_STEP, lines: kept };
}

/**
 * `gh run view --log-failed` lines are `job<TAB>step<TAB>text`; groups them per job and step, in order. A job whose lines all name
 * no step (`UNKNOWN STEP`) is cut to its failed step (failedPart).
 */
export function parseFailedLog(text: string): FailedStep[] {
  const groups = new Map<string, { job: string; step: string; lines: string[] }>();
  for (const line of text.replace(ANSI, "").split("\n")) {
    const [job, step, ...rest] = line.split("\t");
    if (job === undefined || step === undefined || !rest.length) continue;
    const key = `${job}\t${step}`;
    const g = groups.get(key) ?? { job, step, lines: [] };
    g.lines.push(rest.join("\t").replace(STAMP, "").replace(/\r$/, ""));
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => {
    const { step, lines } = g.step === UNKNOWN_STEP ? failedPart(g.lines) : g;
    const tail = lines.map((l) => `${l}\n`).join("");
    return { job: g.job, step, tail: tail.length > STEP_TAIL ? tail.slice(-STEP_TAIL) : tail };
  });
}

/**
 * `unread`: a failed run's log could not be read yet (the run still goes on, or GitHub has no log for it yet), so no CI fix try is made;
 * `failure` holds every failed check, those without a readable log with no steps.
 */
export type Reading = { kind: "failure"; failure: CiFailure } | { kind: "skip"; why: string } | { kind: "unread"; why: string; failure: CiFailure };

/**
 * Reads the failed checks of `head` and the failed steps' log tails. A head with no failed check run (a commit status
 * or an action_required run failed it), or whose gate checks all passed, is skipped: there is nothing here to fix.
 */
export async function readFailure(gh: Gh, repo: string, head: string, optional: string[] = []): Promise<Reading> {
  const { runs, gatePassed } = failedRuns(JSON.parse(await gh(["api", `repos/${slugOf(repo)}/commits/${head}/check-runs?per_page=100`])) as CheckRuns, optional);
  if (gatePassed) return { kind: "skip", why: "the gate checks passed; only an optional check failed" };
  if (!runs.length) return { kind: "skip", why: "no failed check run at the head (a commit status or a run waiting for approval failed)" };
  const logs = new Map<number, FailedStep[]>();
  const checks: FailedCheck[] = [];
  let total = 0;
  let unread: string | null = null;
  for (const r of runs) {
    let steps: FailedStep[] = [];
    if (r.runId !== null && r.conclusion === "failure") {
      if (!logs.has(r.runId)) {
        // GitHub serves a run's log only once the whole run has ended, so a failed job of a run that goes on has none yet.
        try { logs.set(r.runId, parseFailedLog(await gh(["run", "view", String(r.runId), "--repo", `${slugOf(repo)}`, "--log-failed"]))); }
        catch (e) {
          logs.set(r.runId, []);
          unread ??= `the log of run ${r.runId} could not be read yet: ${String((e as Error).message ?? e).split("\n")[0]!.slice(0, 200)}`;
        }
      }
      // A run holds several checks (jobs); a step belongs to the check whose name ends with its job's name.
      const all = logs.get(r.runId)!;
      steps = all.filter((s) => r.name === s.job || r.name.endsWith(` / ${s.job}`));
      if (!steps.length && runs.filter((x) => x.runId === r.runId).length === 1) steps = all;
      if (!steps.length) unread ??= `the log of run ${r.runId} has no failed step of ${r.name} yet`;
    }
    const kept: FailedStep[] = [];
    let size = 0;
    for (const s of steps.slice(-MAX_STEPS)) {
      const room = Math.min(CHECK_CAP - size, TOTAL_CAP - total);
      if (room <= 0) break;
      const tail = s.tail.length > room ? s.tail.slice(-room) : s.tail;
      kept.push({ ...s, tail });
      size += tail.length;
      total += tail.length;
    }
    checks.push({ name: r.name, conclusion: r.conclusion, runId: r.runId, completedAt: r.completedAt, steps: kept });
  }
  return unread === null ? { kind: "failure", failure: { head, checks } } : { kind: "unread", why: unread, failure: { head, checks } };
}
