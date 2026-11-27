// The Security list and the finding page. Staff only; everyone else gets 404, as the other security endpoints do. A finding's open
// question and its actions are built here from its state; a press goes to `POST /api/security/findings/:repo/:n`.
import { OPERATOR_ACTIONS } from "./security.ts";
import { mayRunRepo } from "../repo-access.ts";
import type { FindingAction, FindingQuestion, FindingSeverity, FindingState, FindingView } from "../../../web/src/api/types.ts";
import { FIX_ROUNDS } from "../../security/rules.ts";
import { findingDetail, reconcile, type FindingRow as StoredFinding } from "../../security/store.ts";
import { loadFindingBoard, type FindingBoardRow, type LiveRound, type LogRound } from "../../data/security/index.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { canSeeInternals } from "./staff.ts";
import { needVisible, visibleRepos } from "./visible.ts";
import type { Db } from "../../db/index.ts";

export type ItemPhase = "Triage" | "Waiting for a person" | "Review" | "Fixing" | "Verifying" | "In queue" | "Merged" | "Closed" | "Held" | "Out of scope";
export interface ItemStatus { phase: ItemPhase; waiting: string | null; next: string | null; since: string }
export interface FindingRow { repo: string; number: number; title: string; severity: FindingSeverity; state: FindingState; urgent: boolean; area: string; status: ItemStatus; attempts: number; updatedAt: string }
export type SecurityGroup = "Needs a person" | "Fixing" | "Ready to land" | "Landing" | "Landed or published" | "Dismissed or backlog";
export interface SecurityList { groups: { group: SecurityGroup; rows: FindingRow[] }[] }
export interface HistoryEntry { id: string; at: string; step: string; outcome: string; model: string | null; costUsd: number | null; kind: "model" | "write" | "decision" | "event"; calls: { label: string; kind: "model" | "tool"; costUsd: number | null }[]; writeId: string | null }
export interface FixRound { round: number; outcome: "passed" | "failed"; why: string; at: string; costUsd: number }
export interface FindingPageData { finding: FindingView; question: FindingQuestion | null; status: ItemStatus; attempts: number; rounds: FixRound[]; history: HistoryEntry[]; costUsd: number }

const GROUPS: SecurityGroup[] = ["Needs a person", "Fixing", "Ready to land", "Landing", "Landed or published", "Dismissed or backlog"];
const GROUP: Record<FindingState, SecurityGroup> = {
  new: "Needs a person", "awaiting-admin": "Needs a person", ready: "Ready to land", fixing: "Fixing", landing: "Landing",
  landed: "Landed or published", advisory: "Landed or published", published: "Landed or published", dismissed: "Dismissed or backlog", backlog: "Dismissed or backlog",
};
const SEVERITY_RANK: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const NOT_FOUND = "not found";
function needStaff(req: Req): void {
  if (!canSeeInternals(req)) throw new HttpError(404, NOT_FOUND);
}

/** The status line of a finding. `rounds` is the number of rounds the last fix attempt ran, or the round now building. */
export function findingStatus(state: FindingState, note: string | null, attempts: number, lastFailure: string | null, since: string, rounds: number | null = null): ItemStatus {
  const at = (phase: ItemPhase, waiting: string | null, next: string | null): ItemStatus => ({ phase, waiting, next, since });
  switch (state) {
    case "new":
      if (attempts > 0) {
        const why = lastFailure ?? note;
        return at("Waiting for a person", `a decision: fix failed after ${rounds ?? FIX_ROUNDS} rounds${why ? `, ${why}` : ""}`, "Fix again with a note, Backlog or Dismiss");
      }
      return at("Waiting for a person", "a decision to fix", "Fix opens a private fix");
    case "fixing": return at("Fixing", rounds ? `round ${rounds} of ${FIX_ROUNDS} building` : "the fix rounds", "Opus review of the patch");
    case "ready": return at("Waiting for a person", "Land or an advisory", "Land opens a quiet pull request");
    case "landing": return at("In queue", "the pull request's checks", "merge by rule");
    case "awaiting-admin": return at("Waiting for a person", "a repository admin", "publish the advisory");
    case "backlog": return at("Held", null, null);
    default: return at("Closed", null, null);
  }
}

/** The actions a finding offers in its state; an urgent finding lists the advisory route first. */
export function findingActions(f: { state: FindingState; urgent: boolean }): FindingAction[] {
  switch (f.state) {
    case "new": return ["fix", "dismiss", "backlog"];
    case "backlog": return ["fix", "dismiss"];
    case "dismissed": return ["reopen"];
    case "ready": return f.urgent ? ["advisory", "land", "dismiss"] : ["land", "advisory", "dismiss"];
    case "awaiting-admin": return ["advisory", "land", "dismiss"];
    case "landed":
    case "advisory": return ["publish"];
    default: return [];
  }
}

const ACTION: Record<FindingAction, { label: string; does: string; writes?: true }> = {
  fix: { label: "Fix", does: "starts a private fix, up to three rounds" },
  dismiss: { label: "Dismiss", does: "closes the finding with your reason" },
  backlog: { label: "Backlog", does: "keeps it for later" },
  reopen: { label: "Reopen", does: "puts it back to be decided" },
  land: { label: "Land", does: "opens a quiet pull request with the fix", writes: true },
  advisory: { label: "Advisory", does: "opens a private fix in a security advisory" },
  publish: { label: "Publish", does: "publishes the advisory" },
};

/** Rounds the last attempt ran, from the log; null when the log has none. */
function lastAttemptRounds(log: LogRound[]): number | null {
  if (!log.length) return null;
  const last = log[log.length - 1]!.attempt;
  return log.filter((r) => r.attempt === last).length;
}

type Listed = Pick<StoredFinding, "repo" | "number" | "title" | "severity" | "state" | "urgent" | "area" | "note" | "fix_attempts" | "last_failure" | "updated_at">;

function rowOf(r: Listed, rounds: number | null): FindingRow {
  return {
    repo: r.repo, number: r.number, title: r.title, severity: r.severity, state: r.state, urgent: r.urgent === 1, area: r.area,
    status: findingStatus(r.state, r.note, r.fix_attempts, r.last_failure, r.updated_at, rounds), attempts: r.fix_attempts, updatedAt: r.updated_at,
  };
}

/** The rounds a finding's status line names: the round now building, else the rounds of its last attempt. */
const roundsOf = (r: Pick<StoredFinding, "state" | "fix_attempts">, log: LogRound[], live: Pick<LiveRound, "round" | "state">[]): number | null =>
  r.state === "fixing" ? (live.find((l) => l.state === "building")?.round ?? null) : lastAttemptRounds(log.filter((l) => l.attempt === r.fix_attempts));

/** Findings of the repos the reader can see, grouped by what they wait for; most severe first. */
export async function securityFindings(db: Db, req: Req): Promise<SecurityList> {
  needStaff(req);
  const repos = await visibleRepos(db, req);
  if (repos.length) await reconcile(db);
  const board: FindingBoardRow[] = await loadFindingBoard(db, { repos });
  const rows = board.map((r) => rowOf(r as Listed, r.state === "fixing" ? r.building_round : r.last_attempt_rounds || null));
  const byRank = (a: FindingRow, b: FindingRow) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.repo.localeCompare(b.repo) || a.number - b.number;
  return { groups: GROUPS.map((group) => ({ group, rows: rows.filter((r) => GROUP[r.state] === group).sort(byRank) })).filter((g) => g.rows.length) };
}

const STEP: Record<string, string> = { area: "Area scan", verify: "Verification", test: "Scan test", model: "Threat model", fix: "Fix", review: "Fix review", duplicate: "Found again" };

function history(f: FindingView): HistoryEntry[] {
  return f.timeline.map((c, i) => ({
    id: `t${i}`, at: c.at, step: STEP[c.kind] ?? c.kind, outcome: c.kind === "duplicate" ? "seen again" : c.ok ? "done" : "failed",
    model: null, costUsd: c.costUsd, kind: c.kind === "duplicate" ? "event" : "model", calls: [], writeId: null,
  }));
}

/** Rounds of every fix attempt, oldest first. A round's cost is that of the fix and review calls made while it ran. */
function rounds(f: FindingView, log: LogRound[], live: LiveRound[]): FixRound[] {
  const calls = f.timeline.filter((c) => c.kind === "fix" || c.kind === "review");
  const cost = (from: string, to: string | null) => calls.filter((c) => c.at >= from && (to === null || c.at <= to)).reduce((s, c) => s + (c.costUsd ?? 0), 0);
  const out: FixRound[] = log.map((r) => ({
    round: r.round, outcome: r.state === "passed" ? "passed" : "failed", why: r.failure ?? (r.state === "building" ? "cut short" : ""), at: r.ended_at, costUsd: cost(r.created_at, r.ended_at),
  }));
  for (const r of live) if (r.state !== "building") out.push({ round: r.round, outcome: r.state === "passed" ? "passed" : "failed", why: r.failure ?? "", at: r.created_at, costUsd: cost(r.created_at, null) });
  return out;
}

/** What a person can do with the finding now; null when nothing is open to anyone. `operator` false leaves out the operators' actions. */
function questionOf(f: FindingView, row: StoredFinding, rounds: number | null, canAct: boolean, operator: boolean): FindingQuestion | null {
  const actions = findingActions({ state: f.state, urgent: f.urgent }).filter((a) => operator || !OPERATOR_ACTIONS.includes(a));
  if (!actions.length) return null;
  const again = f.state === "new" && row.fix_attempts > 0;
  return {
    text: again ? `The fix gave up after ${rounds ?? FIX_ROUNDS} rounds. What next?` : f.state === "ready" ? "How should the fix land?" : "What should happen to this finding?",
    canAct,
    actions: actions.map((a) => ({
      action: a, label: a === "fix" && again ? "Fix again with a note" : ACTION[a].label, does: ACTION[a].does, writes: ACTION[a].writes === true,
      note: a === "dismiss" ? "required" : "optional",
    })),
  };
}

export async function findingPage(db: Db, req: Req): Promise<FindingPageData> {
  needStaff(req);
  const repo = req.params.repo!;
  await needVisible(db, req, repo);
  await reconcile(db, repo);
  const n = Number(req.params.n);
  const detail = Number.isInteger(n) ? await findingDetail(db, repo, n) : undefined;
  if (!detail) throw new HttpError(404, NOT_FOUND);
  const { view: finding, row: stored, log, rounds: live } = detail;
  const row = rowOf(stored, roundsOf(stored, log, live));
  const question = questionOf(finding, stored, lastAttemptRounds(log.filter((l) => l.attempt === stored.fix_attempts)), await mayRunRepo(req.user, repo), req.user.role === "operator");
  return {
    finding, question, status: row.status, attempts: stored.fix_attempts, rounds: rounds(finding, log, live), history: history(finding),
    costUsd: finding.timeline.reduce((s, c) => s + (c.costUsd ?? 0), 0),
  };
}
