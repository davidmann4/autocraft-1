// GET /api/maintain/items/:repo/:n: the new item page's AutoCraft side (behind each user's `ui_v2` switch). It reads the item's
// workflow (src/workflow/store.ts) and builds every line with src/workflow/status.ts, so the page says what GitHub, Discord and
// the agent say. Around it: the signals (duplicates, questions a flip withdrew), security findings of a fix PR, an outside-author
// hold and the breakers that pause the repo. Viewers get no findings and no withdrawn questions; on a quiet pull request (a
// security fix) they get no model text either.
import type { MaintainDuplicate, MaintainEvent, MaintainFinding, MaintainItem, MaintainItemStatus, MaintainWithdrawn } from "../../../web/src/api/types.ts";
import type { FindingSeverity, FindingState } from "../../../web/src/api/types.ts";
import { activeTripRows, mayResumeTrip } from "../../push-outcomes.ts";
import { tripKey } from "../../core/push-outcome.ts";
import { INTERNAL_FINDING_STATES } from "../../security/store.ts";
import { isQuiet } from "../../security/quiet.ts";
import { attributionLines, blockerLabel, listText, recommendationText, recordedStep, stateLine, stepLabel, stepsAt, stepsFor, currentStep, weightLabel, type Step, type StepName, type StepState } from "../../workflow/status.ts";
import { eventsOf, isLive, repoWorkflow, workflowHistory, type StoredEvent } from "../../workflow/store.ts";
import type { ItemWorkflow } from "../../workflow/types.ts";
import { legWait } from "../../workflow/waits.ts";
import { mayRunRepo } from "../repo-access.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { itemState } from "./shown.ts";
import { canSeeInternals } from "./staff.ts";
import { blankIfHidden, hiddenRepos, needVisible } from "./visible.ts";
import type { Db } from "../../db/index.ts";

/** The id suffix of a question a flip to the maintainer workflow withdrew (src/workflow/flip.ts). */
const FLIP_WITHDRAWN = "~replaced-flip-";

/** Events whose line confirms a command that ran. */
const ACCEPTED = new Set(["started", "approved", "answered", "weighted", "set", "backlog", "closed", "stopped"]);

/**
 * The item's steps with the current one marked: the step the advance pass recorded on the row. A row with no recorded step yet
 * reads it from what the row and its merge leg (the pre-approval it owns) show: the leg's state for the merge part, the plan's
 * parts for review and fix-up.
 */
export function stepsOf(wf: ItemWorkflow, leg: string | null): Step[] | null {
  if (wf.state === "stopped" || wf.state === "closed" || wf.state === "backlog") return null;
  const names = stepsFor(wf.entry, wf.approvedBy !== null);
  const kept = wf.plan.filter((p) => p.state !== "dropped").map((p) => p.n);
  const notes: Record<number, string> = {};
  const fix = names.indexOf("fix-up");
  if (fix >= 0 && kept.length) notes[fix] = listText(kept);
  if (wf.state === "done") return stepsAt(names, names.length, "running", notes);
  const now: StepState = wf.state === "blocked" ? "stopped" : wf.state === "running" ? "running" : "waiting";
  const at = (n: StepName, or = 0) => (names.includes(n) ? names.indexOf(n) : or);
  let i = recordedStep(wf, names);
  if (i < 0) {
    if (wf.state === "recommending" && names.includes("recommend")) i = at("recommend");
    else if (leg === "fixup") i = at("fix-up");
    else if (leg === "review") i = at("review again");
    else if (leg === "ci") i = at("fix CI and conflicts", at("merge"));
    else if (leg === "queued") i = at("batch", at("merge"));
    else if (wf.entry === "merge") i = 0;
    else if (!wf.plan.length) i = wf.entry === "implement" && wf.kind === "issue" ? at("implement") : at("review");
    else if (fix >= 0) i = wf.plan.some((p) => p.state === "planned") ? fix : at("review again");
    else i = names.length - 1;
  }
  return stepsAt(names, i, now, notes);
}

/** The status block of the item's latest workflow. */
function statusOf(wf: ItemWorkflow, events: StoredEvent[], leg: string | null, veiled: boolean, wait: string | null): MaintainItemStatus {
  const mine = events.filter((e) => e.workflowId === wf.id || (e.workflowId === null && e.at >= wf.startedAt));
  const last = mine[mine.length - 1];
  const answered = [...mine].reverse().find((e) => e.kind === "answered");
  const accepted = [...mine].reverse().find((e) => ACCEPTED.has(e.kind) && e.line);
  const steps = stepsOf(wf, leg);
  const reason = wf.blocker === "other" && typeof wf.blockerParams?.reason === "string" && !veiled ? wf.blockerParams.reason : null;
  const open = wf.state === "recommending" && wf.rec !== null;
  return {
    headline: stateLine(wf, steps ? currentStep(steps) : undefined, undefined, wait),
    live: isLive(wf.state),
    entry: wf.entry,
    lines: attributionLines(wf, answered ? { by: answered.login, at: answered.at } : null),
    approved: wf.approvedBy !== null,
    weight: weightLabel(wf.weight),
    blocker: wf.state === "blocked" && wf.blocker ? (reason ? `${blockerLabel(wf.blocker)}: ${reason}` : blockerLabel(wf.blocker)) : null,
    steps: steps?.map((s) => ({ label: stepLabel(s), state: s.state })) ?? null,
    parts: wf.plan.map((p) => ({ n: p.n, title: veiled ? "" : p.title, source: p.source, file: veiled ? null : p.file ?? null, major: p.major === true, state: p.state })),
    rec: open && !veiled ? recommendationText(wf.rec!) : null,
    unclear: last?.kind === "ambiguous" ? { by: last.login, at: last.at, line: last.line ?? "" } : null,
    confirm: accepted?.line ?? null,
  };
}

async function findings(db: Db, repo: string, n: number): Promise<MaintainFinding[]> {
  const rows = await db.all(db.k.selectFrom("security_findings").select(["number", "title", "severity", "state"])
    .where("repo", "=", repo).where("fix_pr", "=", n).where("fork", "is", null).where("state", "not in", INTERNAL_FINDING_STATES).orderBy("number"));
  return rows.map((r) => ({ number: r.number, title: r.title, severity: r.severity as FindingSeverity, state: r.state as FindingState }));
}

async function withdrawnOf(db: Db, repo: string, n: number): Promise<MaintainWithdrawn[]> {
  const rows = await db.all(db.k.selectFrom("main.decisions").select(["id", "kind", "question", "summary", "asked_at"])
    .where("repo", "=", repo).where("number", "=", n).where("id", "like", `%${FLIP_WITHDRAWN}%`).orderBy("asked_at"));
  return rows.map((r) => ({ id: r.id, kind: r.kind, question: r.question, summary: r.summary, at: r.asked_at }));
}

async function duplicatesOf(db: Db, repo: string, n: number): Promise<MaintainDuplicate[]> {
  const pairs = await db.all(db.k.selectFrom("duplicate_pairs").select(["a", "b", "canonical"])
    .where("repo", "=", repo).where("verdict", "=", "duplicate").where((eb) => eb.or([eb("a", "=", n), eb("b", "=", n)])));
  const others = new Map<number, boolean>();
  for (const p of pairs) {
    const other = p.a === n ? p.b : p.a;
    others.set(other, (others.get(other) ?? false) || p.canonical === other);
  }
  if (!others.size) return [];
  const items = await db.all(db.k.selectFrom("main.items").select(["number", "kind", "state", "title"]).where("repo", "=", repo).where("number", "in", [...others.keys()]));
  return items.map((i) => ({ repo, number: i.number, kind: i.kind === "issue" ? "issue" as const : "pr" as const, state: itemState(i.state), title: i.title ?? "", canonical: others.get(i.number) ?? false }))
    .sort((a, b) => a.number - b.number);
}

export async function item(db: Db, req: Req): Promise<MaintainItem> {
  const repo = req.params.repo!;
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "not an item number");
  await needVisible(db, req, repo);
  const it = await db.get(db.k.selectFrom("main.items").select(["kind"]).where("repo", "=", repo).where("number", "=", n));
  if (!it) throw new HttpError(404, `${repo}#${n} is not an item AutoCraft has read`);
  const kind = it.kind === "issue" ? "issue" : "pr";
  const staff = canSeeInternals(req);
  const [workflow, may, history, events, quiet, hidden, trips] = await Promise.all([
    repoWorkflow(db, repo),
    req.user.role === "viewer" ? false : mayRunRepo(req.user, repo),
    workflowHistory(db, repo, n),
    eventsOf(db, repo, n),
    staff ? false : isQuiet(db, repo, n),
    hiddenRepos(db, req),
    activeTripRows(db),
  ]);
  const wf = history[history.length - 1] ?? null;
  const leg = wf ? (await db.get(db.k.selectFrom("main.preapprovals").select("state").where("workflow_id", "=", wf.id).orderBy("id", "desc").limit(1)))?.state ?? null : null;
  const [security, withdrawn, duplicates, held, released] = await Promise.all([
    staff ? findings(db, repo, n) : [],
    staff ? withdrawnOf(db, repo, n) : [],
    duplicatesOf(db, repo, n),
    db.get(db.k.selectFrom("outside_holds").select(["author", "reason"]).where("repo", "=", repo).where("number", "=", n)),
    db.get(db.k.selectFrom("outside_released").select("by").where("repo", "=", repo).where("number", "=", n)),
  ]);
  // The breakers that stop a step of this repo: its own, and the instance-wide one of each stage.
  const mineTrips = trips.filter((t) => t.repo === null ? true : t.stage === tripKey(t.tripStage, repo));
  const breakers = await Promise.all(mineTrips.map(async (t) => ({
    key: t.stage, reason: blankIfHidden(t.reason, hidden), since: t.tripped_at, canResume: may && await mayResumeTrip(req.user, t.stage),
  })));
  const shown: MaintainEvent[] = events.map((e) => ({ id: e.id, at: e.at, login: e.login, via: e.via, kind: e.kind, line: e.line }));
  return {
    repo, number: n, kind, workflowRepo: workflow === "new", canAct: may,
    status: wf ? statusOf(wf, events, leg, quiet, await legWait(db, wf)) : null,
    events: shown, duplicates, withdrawn, security,
    outside: held && !released ? { reason: held.reason === "surge" ? "surge" : "limit", author: held.author, canRelease: may } : null,
    breakers,
  };
}
