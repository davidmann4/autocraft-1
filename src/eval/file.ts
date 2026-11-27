// Filing the self-evaluation's causes on the eval repo: one issue per cause the investigation found a real defect, a comment
// with the new evidence at most once a day while it is open, a new issue when a cause comes back after its issue was closed
// as completed, and nothing more once it was closed as not planned or a duplicate. Writes only through src/github/write.ts.
// Every title, body and comment is built by issueDraft or commentDraft, which end with the public-text pass of src/eval/public.ts.
//
// A cause is `filing` before the create and `filed` after it. A create that sent nothing puts it back; one whose outcome is
// unknown stays `filing` until its audit row settles it (settleStuck).
import { HELD_STUCK_MS } from "../conversations/held.ts";
import type { By } from "../core/gates.ts";
import { guardRepo, type GuardedRepo } from "../core/guard.ts";
import { exec as realExec, type Exec } from "../fixup/git.ts";
import { createIssue, ensureLabel, ghComment, IssueError, unclearWrite, type Writer } from "../github/write.ts";
import type { Db } from "../db/index.ts";
import { listAudit } from "../data/control/index.ts";
import { claimEvalFiling, loadEvalCauses, saveEvalCauses, type EvalCause } from "../data/eval/index.ts";
import { loadItems, loadRepos } from "../data/mirror/index.ts";
import { REINVESTIGATE_MS } from "./causes.ts";
import { findingOf, type EvalFinding } from "./prompt.ts";
import { loadScrubber, scrubFinding, type Scrub } from "./public.ts";
import { ISSUE_TITLE_MAX } from "../postmerge/template.ts";
import { EVAL_LABEL, evalComment, evalIssueBody, evalIssueTitle } from "./template.ts";

export const ACTOR = "eval";
/** Failed creates of one cause before it is left for an operator. */
export const FILE_MAX_ATTEMPTS = 3;

export type FileDeps = { exec: Exec; now: () => Date };
export type FileSummary = { filed: number[]; commented: number[]; declined: number; failed: string[]; unknown: string[]; note: string | null; later?: string };

export const defaultFileDeps = (): FileDeps => ({ exec: realExec, now: () => new Date() });
const target = (repo: string): string => `${repo}:eval`;
const oneLine = (e: unknown): string => String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 300);
const previousOf = (note: string | null): number | null => { const m = /^previous:(\d+)$/.exec(note ?? ""); return m ? Number(m[1]) : null; };

/** Settles causes a stopped process left in `filing` from their audit rows: filed, back to be filed, or left with a note while unknown. */
async function settleStuck(db: Db, repo: string, causes: EvalCause[], now: Date, log: (l: string) => void): Promise<EvalCause[]> {
  const stuck = causes.filter((c) => c.state === "filing");
  if (!stuck.length) return [];
  const rows = await listAudit(db, { actions: ["eval-issue"], targets: [target(repo)], since: new Date(now.getTime() - 7 * 24 * 3_600_000).toISOString(), order: "desc" });
  const out: EvalCause[] = [];
  for (const c of stuck) {
    const mine = rows.filter((a) => a.details?.cause === c.key);
    const done = mine.find((a) => a.details?.state === "done" && /\/issues\/\d+$/.test(String(a.details.url ?? "")));
    if (done) {
      out.push({ ...c, state: "filed", issueNumber: Number(/\/issues\/(\d+)$/.exec(String(done.details!.url))![1]), filedAt: done.at, reportedSeen: c.seen, note: null });
      log(`  ${c.key}: was filed as issue ${out[out.length - 1]!.issueNumber}`);
    } else if (!mine.some((a) => unclearWrite(a.details)) && (mine.length || now.getTime() - Date.parse(c.filedAt ?? c.lastSeen) >= HELD_STUCK_MS)) {
      out.push({ ...c, state: "investigated", filedAt: null });
      log(`  ${c.key}: a stopped filing sent nothing`);
    } else if (c.note !== "outcome unknown; check GitHub") out.push({ ...c, note: "outcome unknown; check GitHub" });
  }
  return out;
}

/** What an issue's mirror row tells the filing. */
export type IssueState = { state: string; state_reason: string | null; closed_at: string | null };
/** One thing the filing does: end a cause whose issue was declined, open a cause again whose issue was closed before it came back, comment, or file. */
export type FilingStep =
  | { kind: "decline"; cause: EvalCause }
  | { kind: "reopen"; cause: EvalCause }
  | { kind: "comment"; cause: EvalCause }
  | { kind: "file"; cause: EvalCause; finding: EvalFinding; previous: number | null };

/** What the filing would do now with the stored causes, given the mirror rows of their issues (by number). Pure. */
export function filingPlan(causes: readonly EvalCause[], issues: ReadonlyMap<number, IssueState>, nowMs: number): FilingStep[] {
  const out: FilingStep[] = [];
  const files: FilingStep[] = [];
  const fileIfDue = (c: EvalCause, previous: number | null) => {
    if (c.verdict !== "defect" || c.attempts >= FILE_MAX_ATTEMPTS) return;
    const f = findingOf(c.finding);
    if (f) files.push({ kind: "file", cause: c, finding: f, previous });
  };
  for (const c of causes) {
    if (c.state === "investigated" && c.issueNumber === null) { fileIfDue(c, previousOf(c.note)); continue; }
    if (c.state !== "filed" || c.issueNumber === null) continue;
    const it = issues.get(c.issueNumber);
    if (it && it.state !== "OPEN") {
      if (it.state_reason === "NOT_PLANNED" || it.state_reason === "DUPLICATE") out.push({ kind: "decline", cause: c });
      else if (it.closed_at && c.evidence.some((e) => e.at > it.closed_at!)) {
        const again: EvalCause = { ...c, state: "investigated", issueNumber: null, filedAt: null, commentedAt: null, reportedSeen: 0, attempts: 0, note: `previous:${c.issueNumber}` };
        out.push({ kind: "reopen", cause: again });
        fileIfDue(again, c.issueNumber);
      }
      continue;
    }
    const last = c.commentedAt ?? c.filedAt;
    if (c.seen > c.reportedSeen && !(last && nowMs - Date.parse(last) < REINVESTIGATE_MS)) out.push({ kind: "comment", cause: c });
  }
  return [...out, ...files];
}

/** How posted text is made public: which repos may be named, and the last pass (src/eval/public.ts). */
export type DraftCtx = { isPublic: (repo: string) => boolean; scrub: Scrub };

/** The issue exactly as it is posted: the template over the scrubbed finding, and the whole title and body scrubbed again. */
export function issueDraft(c: EvalCause, f: EvalFinding, ctx: DraftCtx, previous: number | null): { title: string; body: string } {
  const g = scrubFinding(f, ctx.scrub);
  return { title: ctx.scrub(evalIssueTitle(g)).slice(0, ISSUE_TITLE_MAX), body: ctx.scrub(evalIssueBody(c, g, ctx.isPublic, previous)) };
}

/** The new-evidence comment exactly as it is posted. */
export function commentDraft(c: EvalCause, ctx: DraftCtx): string {
  return ctx.scrub(evalComment(c, ctx.isPublic));
}

/** The draft context of now: the repos' visibility and the names the scrub takes out. */
export async function draftCtx(db: Db): Promise<DraftCtx> {
  const [repos, scrub] = await Promise.all([loadRepos(db, { all: true }), loadScrubber(db)]);
  return { isPublic: (r) => repos.get(r)?.visibility === "public", scrub };
}

/** The mirror rows of the issues filed for `causes` on `repo`, by number. */
export async function filedIssues(db: Db, repo: string, causes: readonly EvalCause[]): Promise<Map<number, IssueState>> {
  const filed = causes.filter((c) => c.state === "filed" && c.issueNumber !== null);
  const rows = await loadItems(db, filed.map((c) => ({ repo, number: c.issueNumber! })), "full");
  return new Map(filed.flatMap((c) => { const it = rows.get(`${repo}#${c.issueNumber}`); return it ? [[c.issueNumber!, { state: it.state, state_reason: it.state_reason, closed_at: it.closed_at }] as const] : []; }));
}

/** Files, comments and declines on the eval repo `repo` for every stored cause that is due. */
export async function runEvalFiling(db: Db, o: { repo: string; by: By }, log: (l: string) => void = console.log, deps: FileDeps = defaultFileDeps()): Promise<FileSummary> {
  const s: FileSummary = { filed: [], commented: [], declined: 0, failed: [], unknown: [], note: null };
  const g = await guardRepo(db, o.repo, null, o.by);
  if ("refused" in g) { s.note = g.refused; log(`eval filing: ${s.note}; nothing posted`); return s; }
  const now = deps.now(), nowIso = now.toISOString();
  let causes = [...(await loadEvalCauses(db)).values()];
  const settled = await settleStuck(db, o.repo, causes, now, log);
  if (settled.length) { await saveEvalCauses(db, settled); causes = [...(await loadEvalCauses(db)).values()]; }
  const ctx = await draftCtx(db);
  const w: Writer = { db, login: ACTOR };

  const plan = filingPlan(causes, await filedIssues(db, o.repo, causes), now.getTime());
  for (const step of plan) {
    const c = step.cause;
    if (step.kind === "decline") { await saveEvalCauses(db, [{ ...c, state: "declined" }]); s.declined++; continue; }
    if (step.kind === "reopen") { await saveEvalCauses(db, [c]); continue; }
    if (step.kind !== "comment") continue;
    try {
      const r = await ghComment(w, g, deps.exec, "eval-comment", { repo: o.repo, number: c.issueNumber!, pr: false }, { by: "fixed" }, commentDraft(c, ctx), { cause: c.key });
      if (r.code !== 0) throw new Error(oneLine(r.stderr || r.stdout) || `exit code ${r.code}`);
      await saveEvalCauses(db, [{ ...c, commentedAt: nowIso, reportedSeen: c.seen }]);
      s.commented.push(c.issueNumber!);
      log(`  ${c.key}: new evidence added to issue ${c.issueNumber}`);
    } catch (e) {
      s.failed.push(c.key);
      log(`  ${c.key}: comment on issue ${c.issueNumber} failed: ${oneLine(e)}`);
    }
  }

  // New issues, each from the cause as stored now (another process may have moved it).
  let labelled = false;
  for (const step of plan) {
    if (step.kind !== "file") continue;
    const c = (await loadEvalCauses(db, [step.cause.key])).get(step.cause.key);
    if (!c || c.state !== "investigated" || c.issueNumber !== null) continue;
    const r = await fileOne(db, w, g, deps, o.repo, c, issueDraft(c, step.finding, ctx, step.previous), step.finding.severity, nowIso, labelled, log);
    labelled ||= r.labelled;
    if (r.kind === "filed") s.filed.push(r.issue);
    else if (r.kind === "failed") s.failed.push(c.key);
    else if (r.kind === "unknown") { s.unknown.push(c.key); break; }
    else if (r.kind === "later") { s.later = r.reason; break; }
  }
  log(`eval filing on ${o.repo}: ${s.filed.length} filed, ${s.commented.length} comments, ${s.declined} declined, ${s.failed.length} failed, ${s.unknown.length} unknown`);
  return s;
}

type One = { labelled: boolean } & ({ kind: "filed"; issue: number } | { kind: "skipped" } | { kind: "failed" | "unknown" | "later"; reason: string });

async function fileOne(db: Db, w: Writer, g: GuardedRepo, deps: FileDeps, repo: string, c: EvalCause, draft: { title: string; body: string }, severity: string, nowIso: string, labelled: boolean, log: (l: string) => void): Promise<One> {
  if (!labelled) {
    try { await ensureLabel(w, g, deps.exec, { repo, ...EVAL_LABEL }); } catch (e) { log(`  label ${EVAL_LABEL.name}: ${oneLine(e)}`); return { labelled: false, kind: "later", reason: `label ${EVAL_LABEL.name} could not be made: ${oneLine(e)}` }; }
  }
  const attempts = c.attempts + 1;
  if (!await claimEvalFiling(db, c.key, "investigated", attempts, nowIso)) return { labelled: true, kind: "skipped" };
  let made: { number: number; url: string };
  try {
    made = await createIssue(w, g, deps.exec, { repo, target: target(repo), title: draft.title, body: draft.body, action: "eval-issue", labels: [EVAL_LABEL.name] },
      { by: "model", kind: "issue", model: c.model }, { cause: c.key, severity });
  } catch (e) {
    const reason = oneLine(e);
    if (e instanceof IssueError && (e.later || e.unsettled)) {
      await saveEvalCauses(db, [{ ...c, state: "investigated", filedAt: null }]);
      return { labelled: true, kind: "later", reason };
    }
    if (!(e instanceof IssueError) || !e.clear) { log(`  ${c.key}: outcome unknown, check GitHub: ${reason}`); return { labelled: true, kind: "unknown", reason }; }
    await saveEvalCauses(db, [{ ...c, state: "investigated", filedAt: null, attempts, note: reason }]);
    log(`  ${c.key}: not filed: ${reason}`);
    return { labelled: true, kind: "failed", reason };
  }
  await saveEvalCauses(db, [{ ...c, state: "filed", attempts, issueNumber: made.number, filedAt: nowIso, reportedSeen: c.seen, commentedAt: null, note: null }]);
  log(`  ${c.key}: filed ${made.url}`);
  return { labelled: true, kind: "filed", issue: made.number };
}
