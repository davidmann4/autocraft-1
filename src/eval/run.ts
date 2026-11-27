// The hourly self-evaluation (step `eval`): the detectors over the records, the causes they update, one Opus investigation
// per new or grown cause on a Task Runner with a read-only checkout of the eval repo, then the filing on that repo.
// Nothing here implements a fix: the issues wait for a maintainer's command like any other issue.
import { createHash } from "node:crypto";
import { isHalt, poolRoom } from "../agents/call.ts";
import { runModelStep } from "../agents/step.ts";
import { EVAL_INVESTIGATE } from "../agents/steps.ts";
import { pool } from "../classify/run.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { checkoutForCommit } from "../sandbox/index.ts";
import type { By } from "../core/gates.ts";
import type { Db } from "../db/index.ts";
import { loadEvalCauses, loadEvalFacts, saveEvalCauses, type EvalCause } from "../data/eval/index.ts";
import { loadRepos } from "../data/mirror/index.ts";
import { investigationsDue, mergeGroup, wantsInvestigation } from "./causes.ts";
import { DETECTOR_RULES, detect, HOUR, type Detector, type HealthCheck } from "./detect.ts";
import { evalRepo } from "./schedule.ts";
import { commentDraft, draftCtx, filedIssues, filingPlan, issueDraft, runEvalFiling, type FileDeps, type FileSummary } from "./file.ts";
import { loadScrubber, type Scrub } from "./public.ts";
import { EVAL_INPUT_EVIDENCE, type EvalFinding, type EvalInput } from "./prompt.ts";

const PROMPT = CLAUDE_PROMPTS["eval.investigate"];

export type EvalParams = { repo: string; by: By; onHandled?: (n: number) => void; stopping?: () => Promise<boolean> };
export type EvalDeps = {
  now: () => number;
  checks: (db: Db, nowMs: number) => Promise<HealthCheck[]>;
  runnerFreshMs: number;
  /** A read-only checkout of the repo's default branch head, or null. */
  checkout: (db: Db, repo: string) => Promise<string | null>;
  /** The investigation call; absent: the real model call. */
  ask?: (input: EvalInput) => Promise<{ value: EvalFinding; model: string } | null>;
  file?: FileDeps;
};
export type EvalSummary = { runId: string; groups: number; added: number; investigated: number; defects: number; waiting: number; filing: FileSummary | null; note: string | null };

export async function defaultEvalDeps(): Promise<EvalDeps> {
  const { STATUS_FRESH_MS } = await import("../remote/helpers.ts");
  return {
    now: Date.now, runnerFreshMs: STATUS_FRESH_MS,
    checks: async (db, nowMs) => {
      const { computeChecks } = await import("../health-checks.ts");
      return (await computeChecks(db, nowMs, true)).map((c) => ({ id: c.group ?? c.id, state: c.state, brief: c.text, since: c.since }));
    },
    checkout: async (db, repo) => {
      const branch = (await loadRepos(db, { names: [repo], all: true })).get(repo)?.default_branch ?? "main";
      const { mainHeadOf } = await import("../github/fork.ts");
      const sha = await mainHeadOf(repo, branch);
      return sha ? checkoutForCommit(repo, branch, sha, console.log) : null;
    },
  };
}

/** Private repository names replaced by stable aliases (`private-repo-1`), so neither the prompt nor the reply carries them. */
function masker(repos: Map<string, { visibility: string | null }>): { repo: (r: string) => string; text: (t: string) => string } {
  const priv = [...repos].filter(([, r]) => r.visibility !== "public").map(([n]) => n).sort();
  const alias = new Map(priv.map((n, i) => [n, `private-repo-${i + 1}`]));
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = priv.length ? new RegExp(`(?<![A-Za-z0-9._-])(?:[A-Za-z0-9-]+/)?(${[...priv].sort((a, b) => b.length - a.length).map(esc).join("|")})(?![A-Za-z0-9_-])`, "g") : null;
  return { repo: (r) => alias.get(r) ?? r, text: (t) => (re ? t.replace(re, (_m, n: string) => alias.get(n) ?? n) : t) };
}

function inputOf(c: EvalCause, mask: ReturnType<typeof masker>, scrub: Scrub, repoDir: string | undefined): EvalInput {
  const earlier = c.verdict === "defect" || c.verdict === "not-defect" ? { verdict: c.verdict, cause: String((c.finding as { cause?: unknown } | null)?.cause ?? "") } : null;
  return {
    key: c.key, detector: c.detector, rule: DETECTOR_RULES[c.detector as Detector] ?? "", summary: c.summary, first_seen: c.firstSeen, last_seen: c.lastSeen, seen: c.seen,
    evidence: c.evidence.slice(0, EVAL_INPUT_EVIDENCE).map((e) => ({ id: mask.text(e.id), at: e.at, note: scrub(mask.text(e.note)), ...(e.ref && { ref: `${mask.repo(e.ref.repo)}#${e.ref.number}` }) })),
    earlier: earlier && { ...earlier, cause: scrub(earlier.cause) }, ...(repoDir && { repo_dir: repoDir }),
  };
}

/** The candidate groups the records show at `nowMs`, merged into the stored causes (not saved). */
async function detectCauses(db: Db, d: EvalDeps, nowMs: number, log: (l: string) => void): Promise<{ groups: number; added: number; merged: EvalCause[] }> {
  const nowIso = new Date(nowMs).toISOString();
  const [facts, checks] = await Promise.all([
    loadEvalFacts(db, { sinceMs: nowMs - 24 * HOUR, mergedSinceMs: nowMs - 7 * 24 * HOUR }),
    d.checks(db, nowMs).catch((e: unknown) => { log(`eval: health checks not read: ${String((e as Error).message ?? e).slice(0, 200)}`); return [] as HealthCheck[]; }),
  ]);
  const groups = detect({ facts, checks, nowMs, runnerFreshMs: d.runnerFreshMs });
  const stored = await loadEvalCauses(db, groups.map((g) => g.key));
  let added = 0;
  const merged = groups.map((g) => { const m = mergeGroup(stored.get(g.key), g, nowIso); added += m.added; return m.cause; });
  return { groups: groups.length, added, merged };
}

type Investigated = { cause: EvalCause; got: { value: EvalFinding; model: string } | null };

/**
 * One investigation call per cause in `due` on `repo`'s Task Runners, with a read-only checkout of the repo; `record` gets
 * each answer (null: no valid reply). Returns how many waited (no checkout, no Task Runner, or stopping).
 */
async function investigate(db: Db, due: EvalCause[], o: { repo: string; runId: string; stopping?: () => Promise<boolean>; onHandled?: (n: number) => void }, d: EvalDeps, log: (l: string) => void, record: (r: Investigated) => Promise<void>): Promise<number> {
  if (!due.length) return 0;
  const dir = d.ask ? undefined : await d.checkout(db, o.repo);
  if (!d.ask && !dir) { log(`eval: no checkout of ${o.repo}; ${due.length} investigations wait for the next run`); return due.length; }
  const [mask, scrub] = [masker(await loadRepos(db, { all: true })), await loadScrubber(db)];
  let handled = 0, waiting = 0;
  await pool(due.map((c) => async () => {
    if (await o.stopping?.()) { waiting++; return; }
    const input = inputOf(c, mask, scrub, dir ? REPO_PATH : undefined);
    let got: Investigated["got"];
    try {
      if (d.ask) got = await d.ask(input);
      else {
        const r = await runModelStep(db, EVAL_INVESTIGATE, input, {
          model: PROMPT.models[0]!, checkout: dir!,
          usage: { run: o.runId, agent: `eval-${createHash("sha1").update(c.key).digest("hex").slice(0, 10)}`, stage: "eval", items: (ok) => (ok ? 1 : 0) },
          onReply: (reply) => { if (reply.fixTurn) log(`  ${c.key}: reply lint: ${reply.problems?.length ? `${reply.problems.length} problems left after the fix turn` : "fixed by one fix turn"}`); },
        });
        got = r.ok ? { value: r.value, model: r.model || PROMPT.models[0]! } : null;
      }
    } catch (e) {
      if (!isHalt(e)) throw e;
      waiting++;
      log(`  ${c.key}: no Task Runner took the investigation; it waits for the next run`);
      return;
    }
    o.onHandled?.(++handled);
    await record({ cause: c, got });
    log(`  ${c.key}: ${got ? (got.value.real_defect ? `real defect (${got.value.severity})` : "not a defect") : "no valid investigation"}`);
  }), d.ask ? due.length : poolRoom(db, () => [o.repo], () => []), { skipped: () => { waiting++; } });
  return waiting;
}

/** The cause after an investigation answered at `nowIso`. */
const afterInvestigation = (was: EvalCause, r: Investigated, runId: string, nowIso: string): EvalCause => r.got
  ? { ...was, investigatedAt: nowIso, investigatedSeen: r.cause.seen, verdict: r.got.value.real_defect ? "defect" : "not-defect", failures: 0, finding: r.got.value, model: r.got.model, runId, state: was.state === "new" ? "investigated" : was.state }
  : { ...was, investigatedAt: nowIso, investigatedSeen: r.cause.seen, verdict: "failed", failures: was.failures + 1, runId, state: was.state === "new" ? "investigated" : was.state };

/** One evaluation: detect, store, investigate what is new or grew, file. */
export async function runEval(db: Db, p: EvalParams, log: (l: string) => void = console.log, deps?: EvalDeps): Promise<EvalSummary> {
  const d = deps ?? await defaultEvalDeps();
  const nowMs = d.now(), nowIso = new Date(nowMs).toISOString();
  const runId = `eval-${nowIso.replace(/[-:]/g, "").slice(0, 15)}`;
  const s: EvalSummary = { runId, groups: 0, added: 0, investigated: 0, defects: 0, waiting: 0, filing: null, note: null };
  if (await evalRepo(db) !== p.repo) { s.note = `${p.repo} is not the eval repo`; log(`eval: ${s.note}; nothing done`); return s; }

  const { groups, added, merged } = await detectCauses(db, d, nowMs, log);
  s.groups = groups; s.added = added;
  await saveEvalCauses(db, merged);
  for (const c of merged) log(`  ${c.key}: ${c.evidence.length} kept, ${c.seen} seen, ${c.state}${c.issueNumber ? ` (issue ${c.issueNumber})` : ""}`);

  const due = investigationsDue(merged, nowMs);
  const over = merged.filter((c) => wantsInvestigation(c, nowMs)).length - due.length;
  if (over > 0) log(`eval: ${over} more causes want an investigation; they wait for the next run`);
  s.waiting = over + await investigate(db, due, { repo: p.repo, runId, stopping: p.stopping, onHandled: p.onHandled }, d, log, async (r) => {
    s.investigated++;
    if (r.got?.value.real_defect) s.defects++;
    await saveEvalCauses(db, [afterInvestigation((await loadEvalCauses(db, [r.cause.key])).get(r.cause.key) ?? r.cause, r, runId, nowIso)]);
  });

  s.filing = await runEvalFiling(db, { repo: p.repo, by: p.by }, log, d.file);
  log(`eval ${p.repo}: ${s.groups} candidate groups, ${s.added} new pieces of evidence, ${s.investigated} investigated (${s.defects} defects), ${s.waiting} waiting`);
  return s;
}

/**
 * What an evaluation would do now, written to `log`: the candidate groups with their newest evidence, which causes would be
 * investigated, and what would be filed or commented on `repo` (with `text`, the posted text itself). Posts nothing and
 * leaves `eval_causes` as it is. Without `investigate` it writes nothing at all; with it (and a repo) it fetches the
 * repo's checkout and makes the investigation calls, which leave their usual rows (the queued call, the agent run and
 * its token usage).
 */
export async function dryRunEval(db: Db, o: { repo: string | null; investigate: boolean; text: boolean }, log: (l: string) => void = console.log, deps?: EvalDeps): Promise<void> {
  const d = deps ?? await defaultEvalDeps();
  const nowMs = d.now(), nowIso = new Date(nowMs).toISOString();
  const runId = `eval-dry-${nowIso.replace(/[-:]/g, "").slice(0, 15)}`;
  const { groups, added, merged } = await detectCauses(db, d, nowMs, log);
  const due = new Set(investigationsDue(merged, nowMs).map((c) => c.key));
  const over = merged.filter((c) => wantsInvestigation(c, nowMs)).length - due.size;
  log(`${groups} candidate groups, ${added} new pieces of evidence${o.repo ? `; eval repo ${o.repo}` : "; no eval repo set"}${over > 0 ? `; ${over} more causes want an investigation than one run makes` : ""}`);
  for (const c of merged) {
    log(`\n${c.key}  ${c.state}${c.verdict ? ` ${c.verdict}` : ""}${c.issueNumber ? ` issue ${c.issueNumber}` : ""}  seen ${c.seen}${due.has(c.key) ? "  (would be investigated)" : ""}`);
    log(`  ${c.summary}`);
    for (const e of c.evidence.slice(0, 5)) log(`  - ${e.id} ${e.at.slice(0, 16)} ${e.note}${e.ref ? ` (${e.ref.repo}#${e.ref.number})` : ""}`);
    if (c.evidence.length > 5) log(`  - and ${c.evidence.length - 5} more kept`);
  }

  const now = new Map((await loadEvalCauses(db)).entries());
  for (const c of merged) now.set(c.key, c);
  if (o.investigate && due.size) {
    if (!o.repo) log("\nno eval repo is set: nothing is investigated");
    else {
      log(`\ninvestigating ${due.size} causes on ${o.repo}`);
      await investigate(db, merged.filter((c) => due.has(c.key)), { repo: o.repo, runId }, d, log, async (r) => {
        now.set(r.cause.key, afterInvestigation(now.get(r.cause.key) ?? r.cause, r, runId, nowIso));
      });
    }
  }
  if (!o.repo) return;
  const causes = [...now.values()];
  const plan = filingPlan(causes, await filedIssues(db, o.repo, causes), nowMs);
  const ctx = await draftCtx(db);
  log(plan.length ? `\non ${o.repo} the filing would:` : `\nnothing to file or comment on ${o.repo}`);
  for (const step of plan) {
    const c = step.cause;
    if (step.kind === "decline") log(`- ${c.key}: stop (issue ${c.issueNumber} was closed as not planned or a duplicate)`);
    else if (step.kind === "reopen") log(`- ${c.key}: report again (its issue was closed before the cause came back)`);
    else if (step.kind === "comment") {
      log(`- ${c.key}: comment on issue ${c.issueNumber}`);
      if (o.text) log(indent(commentDraft(c, ctx)));
    } else {
      const draft = issueDraft(c, step.finding, ctx, step.previous);
      log(`- ${c.key}: file "${draft.title}" (${step.finding.severity})`);
      if (o.text) log(indent(draft.body));
    }
  }
}

const indent = (t: string): string => t.trimEnd().split("\n").map((l) => `    ${l}`).join("\n");
