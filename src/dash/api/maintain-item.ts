// GET /api/maintain/items/:repo/:n: the item page's AutoCraft side. It reads the item's
// workflow (src/workflow/store.ts) and builds every line with src/workflow/status.ts, so the page says what GitHub, Discord and
// the agent say. Around it: the signals (duplicates), security findings of a fix PR, an outside-author
// hold and the breakers that pause the repo. Viewers get no findings; on a quiet pull request (a
// security fix) they get no model text either.
import type { MaintainDuplicate, MaintainEvent, MaintainFinding, MaintainItem, MaintainItemStatus } from "../../../web/src/api/types.ts";
import type { FindingSeverity, FindingState } from "../../../web/src/api/types.ts";
import { mayResumeTrip } from "../../data/control/index.ts";
import { tripKey, tripOf } from "../../core/push-outcome.ts";
import { t } from "../../i18n/index.ts";
import { STUCK_OPTIONS } from "../../implement/stuck.ts";
import { loadMaintainItem } from "../../data/views/maintain-item.ts";
import { loadQuiet } from "../../data/security/index.ts";
import { attributionLines, blockerLabel, listText, recommendationText, recordedStep, stateLine, stepLabel, stepNamesOf, stepsAt, currentStep, weightLabel, type Step, type StepName, type StepState } from "../../workflow/status.ts";
import { openQuestion } from "../../workflow/asked.ts";
import { isLive } from "../../workflow/store.ts";
import type { StoredEvent } from "../../data/workflow/types.ts";
import { openRecommendation, shownWorkflow, type ItemWorkflow } from "../../workflow/types.ts";
import { legWait, notPostedLine } from "../../workflow/waits.ts";
import { mayRunRepo } from "../repo-access.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { canSeeInternals } from "./staff.ts";
import { blankIfHidden, hiddenRepos, needVisible } from "./visible.ts";
import type { Db } from "../../db/index.ts";

/** Events whose line confirms a command that ran. */
const ACCEPTED = new Set(["started", "approved", "answered", "weighted", "set", "backlog", "closed", "stopped", "resumed"]);

/**
 * The item's steps with the current one marked: the step the advance pass recorded on the row. A row with no recorded step yet
 * reads it from what the row and its merge leg (the pre-approval it owns) show: the leg's state for the merge part, the plan's
 * parts for review and fix-up.
 */
export function stepsOf(wf: ItemWorkflow, leg: string | null): Step[] | null {
  if (wf.state === "stopped" || wf.state === "closed" || wf.state === "backlog") return null;
  const names = stepNamesOf(wf);
  // A fix-up fixes what a review found; an implementation's parts and the options of its question are no fix-up.
  const kept = wf.plan.filter((p) => p.state !== "dropped" && p.source !== "implement").map((p) => p.n);
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
  // A stuck implementation that can be tried again: a yes runs the step it stopped at once more.
  if (names[i] === "implement" && openRecommendation(wf)?.answer?.option === STUCK_OPTIONS.tryAgain.key) notes[i] = t("start it again");
  return stepsAt(names, i, now, notes);
}

/** The status block of the item's latest workflow. */
export function statusOf(wf: ItemWorkflow, events: StoredEvent[], leg: string | null, veiled: boolean, wait: string | null, notPosted: string | null = null): MaintainItemStatus {
  const mine = events.filter((e) => e.workflowId === wf.id || (e.workflowId === null && e.at >= wf.startedAt));
  const last = mine[mine.length - 1];
  const answered = [...mine].reverse().find((e) => e.kind === "answered");
  const accepted = [...mine].reverse().find((e) => ACCEPTED.has(e.kind) && e.line);
  const steps = stepsOf(wf, leg);
  const reason = wf.blocker === "other" && typeof wf.blockerParams?.reason === "string" && !veiled ? wf.blockerParams.reason : null;
  const open = openQuestion(wf);
  return {
    headline: stateLine(wf, steps ? currentStep(steps) : undefined, undefined, wait, veiled),
    live: isLive(wf.state),
    held: wf.state === "stopped",
    entry: wf.entry,
    lines: attributionLines(wf, answered ? { by: answered.login, at: answered.at } : null),
    approved: wf.approvedBy !== null,
    weight: weightLabel(wf.weight),
    blocker: wf.state === "blocked" && wf.blocker ? (reason ? `${blockerLabel(wf.blocker)}: ${reason}` : blockerLabel(wf.blocker)) : null,
    steps: steps?.map((s) => ({ label: stepLabel(s), state: s.state })) ?? null,
    parts: wf.plan.map((p) => ({ n: p.n, title: veiled ? "" : p.title, source: p.source, file: veiled ? null : p.file ?? null, major: p.major === true, state: p.state })),
    rec: open && !veiled ? recommendationText(open.rec) : null,
    asked: open ? wf.recAt : null,
    to: open?.to ?? [],
    unclear: last?.kind === "ambiguous" ? { by: last.login, at: last.at, line: last.line ?? "" } : null,
    confirm: accepted?.line ?? null,
    notPosted: veiled ? null : notPosted,
  };
}

export async function item(db: Db, req: Req): Promise<MaintainItem> {
  const repo = req.params.repo!;
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "not an item number");
  await needVisible(db, req, repo);
  const staff = canSeeInternals(req);
  const key = `${repo}#${n}`;
  const [quiet, hidden, may] = await Promise.all([
    staff ? new Set<string>() : loadQuiet(db, [key]), hiddenRepos(db, req), req.user.role === "viewer" ? false : mayRunRepo(req.user, repo),
  ]);
  const facts = await loadMaintainItem(db, { staff, quiet }, { repo, number: n });
  if (!facts) throw new HttpError(404, `${repo}#${n} is not an item AutoCraft has read`);
  const { history, events, hold } = facts;
  const wf = shownWorkflow(history);
  // The breakers that stop a step of this repo: its own, and the instance-wide one of each stage.
  const mineTrips = facts.trips.flatMap((t) => { const k = tripOf(t.stage); return k && (k.repo === null || t.stage === tripKey(k.stage, repo)) ? [t] : []; });
  const breakers = await Promise.all(mineTrips.map(async (t) => ({
    key: t.stage, reason: blankIfHidden(t.reason, hidden), since: t.trippedAt, canResume: may && await mayResumeTrip(db, req.user, t.stage),
  })));
  const shown: MaintainEvent[] = events.map((e) => ({ id: e.id, at: e.at, login: e.login, via: e.via ?? "cli", kind: e.kind, line: e.line ?? "" }));
  const leg = wf && facts.leg?.workflow_id === wf.id ? facts.leg.state : null;
  return {
    repo, number: n, kind: facts.kind, canAct: may,
    status: wf ? statusOf(wf, events, leg, facts.quiet, await legWait(db, wf, Date.now(), { shown: staff }), await notPostedLine(db, wf)) : null,
    events: shown,
    duplicates: facts.duplicates.map((d): MaintainDuplicate => ({ repo, number: d.other, kind: d.shown?.kind === "issue" ? "issue" : "pr", state: d.shown?.state ?? "open", title: d.shown?.title ?? "", canonical: d.canonical }))
      .sort((a, b) => a.number - b.number),
    security: facts.findings.map((r): MaintainFinding => ({ number: r.number, title: r.title, severity: r.severity as FindingSeverity, state: r.state as FindingState })),
    outside: hold && hold.author !== null ? { reason: hold.reason === "surge" ? "surge" : "limit", author: hold.author, canRelease: may } : null,
    breakers,
  };
}
