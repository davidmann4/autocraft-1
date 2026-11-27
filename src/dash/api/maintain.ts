// GET /api/maintain/home: Home's read. The reader's own items (src/data/chat/mine.ts) of the repos they may see, newest chat entry
// first, each with the conversation's last message and whether its open question is addressed to them (src/workflow/asked.ts);
// viewers get the newest updated items instead. Text is built by src/workflow/status.ts.
import type { MaintainHome, MaintainItemGroup, MaintainItemRow, MaintainItems, MaintainItemsFilter, MaintainItemsShow, MaintainQueueMeta, MaintainRepo, MaintainRow, MaintainRunnerLine, MaintainStats } from "../../../web/src/api/types.ts";
import { t } from "../../i18n/index.ts";
import { recommendationText, stateLine, weightLabel } from "../../workflow/status.ts";
import { LIVE_STATES } from "../../workflow/store.ts";
import { ASKING_STATES, openRecommendation, type ItemWorkflow, type WorkflowEventKind } from "../../workflow/types.ts";
import { mayRunRepo } from "../repo-access.ts";
import type { Req } from "../types.ts";
import { problems, stoppedRows } from "./home.ts";
import { canSeeInternals } from "./staff.ts";
import { allVisibleRepos, blankIfHidden, hiddenRepos, visibleRepos } from "./visible.ts";
import { stepTitle } from "./trace.ts";
import { parseTripKey } from "../../core/push-outcome.ts";
import * as control from "../../data/control/index.ts";
import { healthOptions } from "../../health-checks.ts";
import { mainCiRepos } from "../../mainci/index.ts";
import { DEFAULT_PER_DAY, LIMIT_STEPS } from "../../runner/autopilot.ts";
import { loadLastEntries, loadMineRefs, type LastEntry } from "../../data/chat/index.ts";
import { loadItems, loadRecentRefs } from "../../data/mirror/index.ts";
import { listWorkflows } from "../../data/workflow/index.ts";
import { loadMaintainHome } from "../../data/views/home.ts";
import { loadMaintainRepos, loadQueueMeta } from "../../data/views/maintain.ts";
import { loadQuiet } from "../../data/security/index.ts";
import { loadHeldWorkflows } from "../../data/workflow/index.ts";
import { loadMaintainStats } from "../../data/views/stats.ts";
import { loadItemRowFacts, loadItemsBase } from "../../data/views/maintain-items.ts";
import type { ItemBase } from "../../data/views/types.ts";
import { statusFromItem, type ItemPhase, type ItemStatus } from "../../core/item-status.ts";
import type { PlanView } from "../../core/plan-cache.ts";
import { WEIGHT_NORMAL } from "../../workflow/types.ts";
import { isAsked, openQuestion } from "../../workflow/asked.ts";
import { HttpError } from "../server/util.ts";
import { itemState } from "./shown.ts";
import { readerOf, statusFor } from "./reader.ts";
import type { Db } from "../../db/index.ts";

/** A quiet pull request (the landing fix of a security finding) shows viewers no recommendation text, as on the item page. */
const quietFor = async (db: Db, staff: boolean, asking: (ItemWorkflow | null)[]): Promise<Set<string>> =>
  (staff ? new Set() : await loadQuiet(db, asking.flatMap((w) => (openRecommendation(w) ? [`${w!.repo}#${w!.number}` as const] : []))));

const MINE_ROWS = 8;
const MINE_DONE_DAYS = 7;
const LAST_TEXT = 240;

const refParts = (ref: string): { repo: string; number: number } => ({ repo: ref.slice(0, ref.lastIndexOf("#")), number: Number(ref.slice(ref.lastIndexOf("#") + 1)) });

/** The workflow each item shows on Home: its live one, else its newest. */
async function workflowsOf(db: Db, refs: { repo: string; number: number }[]): Promise<Map<string, ItemWorkflow>> {
  const out = new Map<string, ItemWorkflow>();
  for (const w of await listWorkflows(db, { refs })) {
    const key = `${w.repo}#${w.number}`, was = out.get(key);
    const live = (x: ItemWorkflow) => (LIVE_STATES as readonly string[]).includes(x.state);
    if (!was || (live(w) && !live(was)) || (live(w) === live(was) && w.id > was.id)) out.set(key, w);
  }
  return out;
}

const clip = (text: string): string => (text.length > LAST_TEXT ? `${text.slice(0, LAST_TEXT - 1)}…` : text);

/** Home rows for `refs`, in that order: workflow facts, item title and state, and (with `login`) the newest chat entry. A few set-based reads whatever the count. */
async function homeRows(db: Db, refs: string[], opts: { login: string | null; staff: boolean }): Promise<MaintainRow[]> {
  if (!refs.length) return [];
  const parts = refs.map(refParts);
  const [items, wfs, lasts] = await db.together(() => Promise.all([
    loadItems(db, parts, "card"),
    workflowsOf(db, parts),
    opts.login ? loadLastEntries(db, refs as never[]) : Promise.resolve(new Map<string, LastEntry>()),
  ]));
  const quiet = await quietFor(db, opts.staff, [...wfs.values()]);
  const me = opts.login?.toLowerCase() ?? null;
  return refs.map((ref): MaintainRow => {
    const it = items.get(ref), wf = wfs.get(ref) ?? null, { repo, number } = refParts(ref);
    const open = openQuestion(wf) !== null;
    const last = lasts.get(ref);
    const asked = me !== null && wf !== null && isAsked(wf, me);
    const state = it?.state === "MERGED" ? "merged" : it?.state === "CLOSED" ? "closed" : undefined;
    return {
      repo, number, kind: it?.kind === "pr" ? "pr" : "issue", title: it?.title ?? ref, author: it?.author ?? null, entry: wf?.entry ?? "review",
      line: wf ? wfLine(wf, false, quiet.has(ref))! : "", waits: open, blocked: wf?.state === "blocked", weight: wf ? weightLabel(wf.weight) : null,
      startedBy: wf?.startedBy ?? "", approvedBy: wf?.approvedBy ?? null, stoppedBy: wf?.stoppedBy ?? null, updatedAt: last && last.at > (it?.updated_at ?? "") ? last.at : it?.updated_at ?? wf?.updatedAt ?? "",
      ...(state && { state }), ...(last && { last: { by: last.by, text: clip(last.body), question: asked } }),
    };
  });
}

export async function home(db: Db, req: Req): Promise<MaintainHome> {
  const repos = await visibleRepos(db, req);
  const hidden = await hiddenRepos(db, req);
  const staff = canSeeInternals(req);
  const nowMs = Date.now();
  const viewer = req.user.role === "viewer";
  const [facts, ci] = await Promise.all([
    loadMaintainHome(db, { repos, hidden, staff, login: req.user.login }, { nowMs, withRunner: staff, health: healthOptions(), limits: { steps: LIMIT_STEPS, defaults: DEFAULT_PER_DAY } }),
    mainCiRepos(db, hidden),
  ]);
  const live = new Set([...facts.rows, ...facts.attention.closesFailed].map((w) => w.repo));
  const may = viewer ? [] : await Promise.all([...live].map((r) => mayRunRepo(req.user, r)));
  const acting = new Set([...live].filter((_, i) => may[i]));
  const stops = await stoppedRows(facts.attention.stops, hidden);
  const [attention, runner] = await Promise.all([
    problems(db, { hidden, staff, nowMs, ci, stops, facts: facts.attention, acting }),
    Promise.resolve(facts.runner ? runnerLine(facts.runner, req.user.login) : null),
  ]);
  if (viewer) {
    // The newest updated items of the repos a viewer sees.
    const recent = await loadRecentRefs(db, repos, MINE_ROWS);
    return { mine: [], mineTotal: 0, recent: await homeRows(db, recent.map((r) => `${r.repo}#${r.number}`), { login: null, staff }), runner: null, attention };
  }
  const visible = new Set(repos);
  const mineRefs = (await loadMineRefs(db, req.user.login, { doneDays: MINE_DONE_DAYS, nowMs })).filter((r) => visible.has(refParts(r).repo));
  return { mine: await homeRows(db, mineRefs.slice(0, MINE_ROWS), { login: req.user.login, staff }), mineTotal: mineRefs.length, recent: [], runner, attention };
}

/** The items whose open question is addressed to the reader (askedLogins of the open workflows), in the repos they see, oldest question first. */
async function askedRefs(db: Db, req: Req): Promise<string[]> {
  if (req.user.role === "viewer") return [];
  const me = req.user.login.toLowerCase();
  const visible = new Set(await visibleRepos(db, req));
  const wfs = await listWorkflows(db, { states: [...ASKING_STATES], logins: [req.user.login] });
  return wfs.filter((w) => visible.has(w.repo) && isAsked(w, me)).sort((a, b) => ((a.recAt ?? "") < (b.recAt ?? "") ? -1 : 1)).map((w) => `${w.repo}#${w.number}`);
}

/** GET /api/maintain/asked: how many open questions are addressed to the reader. */
export async function asked(db: Db, req: Req): Promise<{ count: number }> {
  return { count: (await askedRefs(db, req)).length };
}

/** Every item whose open question is addressed to the reader, as Home rows (the agent's my_items). */
export async function askedRows(db: Db, req: Req): Promise<MaintainRow[]> {
  return await homeRows(db, await askedRefs(db, req), { login: req.user.login, staff: canSeeInternals(req) });
}

function runnerLine(r: NonNullable<Awaited<ReturnType<typeof loadMaintainHome>>["runner"]>, login: string): MaintainRunnerLine {
  const me = login.toLowerCase();
  return {
    mine: r.mine.map((h) => ({ name: h.label ?? t("Task Runner"), online: h.fresh, running: h.busy ?? 0 })),
    others: r.ready.filter((x) => x.login.toLowerCase() !== me && !x.manual).length,
  };
}

/**
 * Who approved each started item for merge, for the Work queue.
 */
export async function queueMeta(db: Db, req: Req): Promise<MaintainQueueMeta> {
  const repos = await visibleRepos(db, req);
  const meta = await loadQueueMeta(db, { repos });
  const quiet = await quietFor(db, canSeeInternals(req), meta.held);
  return {
    approvedBy: Object.fromEntries(meta.approvedBy),
    held: meta.held.map((w) => ({
      repo: w.repo, number: w.number, kind: w.kind, title: quiet.has(`${w.repo}#${w.number}`) ? `${w.repo}#${w.number}` : w.title ?? `${w.repo}#${w.number}`, line: stateLine(w),
    })),
  };
}

const DAY = 86400_000;

/** Headline numbers and merges per day for the last 7 or 30 days (UTC days, today last), over the repos the reader sees. */
export async function stats(db: Db, req: Req): Promise<MaintainStats> {
  const days = req.query.get("period") === "30d" ? 30 : 7;
  const today = new Date().toISOString().slice(0, 10);
  const labels = Array.from({ length: days }, (_, i) => new Date(Date.parse(today) - (days - 1 - i) * DAY).toISOString().slice(0, 10));
  const f = await loadMaintainStats(db, { repos: await visibleRepos(db, req), hidden: await hiddenRepos(db, req) }, { days, today });
  const perDay = new Map(labels.map((d) => [d, 0]));
  let merged = 0, implemented = 0, closedN = 0;
  for (const r of f.closed) {
    closedN += r.n;
    if (r.state === "MERGED") {
      merged += r.n;
      if (perDay.has(r.day)) perDay.set(r.day, perDay.get(r.day)! + r.n);
    } else if (r.stage === "fixed-by-us" && r.kind === "issue") implemented += r.n;
  }
  return { period: days === 30 ? "30d" : "7d", merged, implemented, reviewed: f.reviewed, backlog: f.backlog, backlogChange: f.created - closedN, spend: Math.round(f.spendUsd), perDay: labels.map((d) => ({ day: d, n: perDay.get(d)! })) };
}

// ---- GET /api/maintain/items: the Items page ------------------------------------------------------------------------
// Open items of the repos the reader may see, in three lists (groupOf), each ordered by priority: the workflow weight, then the
// work rank (src/rank). A started item's line comes from its workflow row; an item nobody started shows the pipeline's status
// line (the plan view), veiled for the reader as on every other list. Grouping runs here over the open items' narrow columns;
// only the rows sent are read in full. Closed items are read newest first, one page at a time.

/** Plan phases in which AutoCraft works an item that nobody started. */
const WORKING_PHASES: ReadonlySet<ItemPhase> = new Set(["Review", "Fixing", "Verifying", "In queue"]);
const SHOWS: readonly MaintainItemsShow[] = ["open", "backlog", "closed", "merged"];
const FILTERS: readonly MaintainItemsFilter[] = ["security", "outside", "stuck", "duplicates", "mine"];
const STAFF_FILTERS: readonly MaintainItemsFilter[] = ["security", "stuck"];
const GROUPS: readonly MaintainItemGroup[] = ["started", "automatic", "rest", "backlog", "done"];
const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 500;
const REFS_MAX = 100;

/** Which list an item goes in. A live workflow or an awaited answer puts it in Started; a Backlog item leaves the active lists. */
export function groupOf(x: { open: boolean; live: boolean; waits: boolean; backlog: boolean; phase: ItemPhase }): MaintainItemGroup {
  if (!x.open) return "done";
  if (x.live || x.waits) return "started";
  if (x.backlog) return "backlog";
  return WORKING_PHASES.has(x.phase) ? "automatic" : "rest";
}

/** Whether an item waits for an answer: its live workflow has an open recommendation (at a blocker too), or the last thing said to it was unclear. */
export const waitsForAnswer = (wf: Pick<ItemWorkflow, "state" | "rec"> | null, lastEvent: WorkflowEventKind | undefined): boolean =>
  lastEvent === "ambiguous" || openRecommendation(wf) !== null;

const listParam = (q: URLSearchParams, key: string): string[] => q.getAll(key).flatMap((v) => v.split(",")).map((s) => s.trim()).filter(Boolean);

type Placed = ItemBase & { group: MaintainItemGroup; unclear: boolean };

const PLAN_BACKLOG = new Set(["backlog", "held-backlog"]);

export async function items(db: Db, req: Req): Promise<MaintainItems> {
  const q = req.query;
  const show = (q.get("show") ?? "open") as MaintainItemsShow;
  if (!SHOWS.includes(show)) throw new HttpError(400, "show must be open, backlog, closed or merged");
  const staff = canSeeInternals(req);
  const filters = listParam(q, "filter") as MaintainItemsFilter[];
  for (const f of filters) {
    if (!FILTERS.includes(f)) throw new HttpError(400, "filter must be security, outside, stuck, duplicates or mine");
    if (!staff && STAFF_FILTERS.includes(f)) throw new HttpError(403, "only operators and maintainers filter by security findings or stuck items");
  }
  const mine = filters.includes("mine") ? (await loadMineRefs(db, req.user.login, { doneDays: MINE_DONE_DAYS })) : undefined;
  const areas = listParam(q, "area");
  const text = (q.get("q") ?? "").trim();
  const refs = listParam(q, "refs").slice(0, REFS_MAX);
  const refPairs = refs.map((r) => [r.slice(0, r.lastIndexOf("#")), Number(r.slice(r.lastIndexOf("#") + 1))] as const);
  if (refPairs.some(([repo, n]) => !repo || !Number.isInteger(n))) throw new HttpError(400, "refs must be repo#number");
  const sort = q.get("sort") ?? "priority";
  if (sort !== "priority" && sort !== "updated") throw new HttpError(400, "sort must be priority or updated");
  const limit = Math.min(LIMIT_MAX, Math.max(1, Number(q.get("limit")) || LIMIT_DEFAULT));
  const counts = Object.fromEntries(GROUPS.map((g) => [g, 0])) as Record<MaintainItemGroup, number>;

  const visible = await visibleRepos(db, req);
  if (!visible.length || (q.has("refs") && !refPairs.length)) return { rows: [], counts };
  const hidden = await hiddenRepos(db, req);
  const base = await loadItemsBase(db, { repos: visible, hidden }, { show, filters: filters.filter((f) => f !== "mine"), ...(mine && { mine }), areas, text: text || null, refs, limit: refPairs.length ? REFS_MAX : limit, sort, normalWeight: WEIGHT_NORMAL });

  let placed: Placed[];
  if (show === "closed" || show === "merged") {
    counts.done = base.closedTotal ?? 0;
    placed = base.rows.map((b) => ({ ...b, group: "done", unclear: false }));
  } else {
    const place = (b: ItemBase): Placed => {
      const waits = waitsForAnswer(b.workflowState === null ? null : { state: b.workflowState as ItemWorkflow["state"], rec: b.hasRecommendation ? ({} as NonNullable<ItemWorkflow["rec"]>) : null }, b.lastEvent ?? undefined);
      const backlog = b.lastEvent === "backlog" || PLAN_BACKLOG.has(b.planState ?? "") || b.itemState === "held-backlog";
      return { ...b, unclear: b.lastEvent === "ambiguous", group: groupOf({ open: true, live: b.workflowState !== null, waits, backlog, phase: b.phase as ItemPhase }) };
    };
    const shown = (g: MaintainItemGroup): boolean => (show === "backlog") === (g === "backlog");
    placed = base.rows.map(place).filter((p) => shown(p.group));
    for (const p of base.places) {
      const { group } = place(p.item);
      if (shown(group)) counts[group] += p.count;
    }
  }

  // Semantic hits keep their order; otherwise the heaviest first, then the work rank, then the latest change.
  const hitAt = new Map(refs.map((r, i) => [r, i]));
  const updated = (a: Placed, b: Placed) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);
  const order = (a: Placed, b: Placed): number => {
    if (hitAt.size) return (hitAt.get(`${a.repo}#${a.number}`) ?? 0) - (hitAt.get(`${b.repo}#${b.number}`) ?? 0);
    // Read in merge order.
    if (show === "merged") return 0;
    if (sort === "updated") return updated(a, b);
    return (b.weight ?? WEIGHT_NORMAL) - (a.weight ?? WEIGHT_NORMAL) || (b.score ?? -1) - (a.score ?? -1) || updated(a, b) || a.repo.localeCompare(b.repo) || b.number - a.number;
  };
  const page = GROUPS.flatMap((g) => placed.filter((p) => p.group === g).sort(order).slice(0, limit));
  return { rows: await itemRows(db, req, page, staff), counts };
}

/** The rows sent: status lines, signals and whether the reader may send commands on each repo. */
async function itemRows(db: Db, req: Req, page: Placed[], staff: boolean): Promise<MaintainItemRow[]> {
  if (!page.length) return [];
  const repos = [...new Set(page.map((p) => p.repo))];
  const [facts, reader, may] = await Promise.all([
    loadItemRowFacts(db, { staff, login: req.user.login }, page.map((p) => ({ repo: p.repo, number: p.number }))),
    readerOf(db, req),
    req.user.role === "viewer" ? repos.map(() => false) : Promise.all(repos.map((r) => mayRunRepo(req.user, r))),
  ]);
  const key = (r: { repo: string; number: number }) => `${r.repo}#${r.number}`;
  const unstarted = page.filter((p) => !facts.workflows.has(key(p))).map((p) => ({ repo: p.repo, number: p.number }));
  const held = new Map((await loadHeldWorkflows(db, { refs: unstarted })).map((w) => [key(w), w]));
  const quiet = await quietFor(db, staff, [...facts.workflows.values()]);
  const mayRepo = new Map(repos.map((r, i) => [r, may[i]!]));
  return page.map((p): MaintainItemRow => {
    const wf = facts.workflows.get(key(p)) ?? null, on = wf ?? held.get(key(p)) ?? null;
    let status: ItemStatus | null = null;
    if (!on) {
      const view = facts.plans.get(key(p))?.view as PlanView | undefined;
      status = view?.status ? statusFor(reader, p.repo, p.number, view.status) : statusFromItem({ merged_at: p.mergedAt, closed_at: p.closedAt }, p.updatedAt);
    }
    const area = facts.areas.get(key(p)) as { area: string | null } | undefined;
    return {
      repo: p.repo, number: p.number, kind: p.kind, state: itemState(p.state), title: p.title || `${p.repo}#${p.number}`, author: p.author,
      group: p.group, line: wfLine(on, p.unclear, quiet.has(key(p))), status, blocked: wf?.state === "blocked", asked: wf?.rec ? wf.recAt : null, weight: wf ? weightLabel(wf.weight) : null,
      startedBy: wf?.startedBy ?? null, approvedBy: wf?.approvedBy ?? null, stoppedBy: on?.stoppedBy ?? null,
      duplicate: facts.duplicateGroups.get(key(p))?.role === "close", outside: (facts.holds.get(key(p))?.reason ?? null) !== null, stuck: facts.stuck.has(key(p)), area: area?.area ?? null,
      may: mayRepo.get(p.repo) ?? false, updatedAt: p.updatedAt, ...(p.merged && { merged: p.merged }),
    };
  });
}

/** A row's line: an unclear last answer, else a started item's open recommendation or where it stands; null for an unstarted item. */
function wfLine(wf: ItemWorkflow | null, unclear: boolean, veiled: boolean): string | null {
  if (unclear) return t("Waiting for a clear answer");
  if (!wf) return null;
  const rec = veiled ? null : openQuestion(wf)?.rec;
  return rec ? recommendationText(rec) : stateLine(wf, undefined, undefined, null, veiled);
}

/** GET /api/maintain/repos: the Repos page, for every role. Counts and switches are the reader's visible tracked repos; only who may act differs. */
export async function repos(db: Db, req: Req): Promise<MaintainRepo[]> {
  const names = await allVisibleRepos(db, req);
  if (!names.length) return [];
  const hidden = await hiddenRepos(db, req);
  const f = await loadMaintainRepos(db, { allRepos: names }, { nowMs: Date.now() });
  const out: MaintainRepo[] = [];
  for (const r of f.repos) {
    const stops: MaintainRepo["trips"] = [];
    for (const trip of f.trips) {
      const k = parseTripKey(trip.stage);
      if (k?.repo !== r.name) continue;
      stops.push({ key: trip.stage, text: `${stepTitle(k.stage)}: ${blankIfHidden(trip.reason, hidden)}`, since: trip.trippedAt, canResume: await control.mayResumeTrip(db, req.user, trip.stage) });
    }
    const live = f.live.get(r.name);
    out.push({
      name: r.name, automatic: r.pipeline, canRun: await mayRunRepo(req.user, r.name),
      open: f.open.get(r.name) ?? 0, started: live?.started ?? 0, waiting: live?.waiting ?? 0, mergedWeek: f.mergedWeek.get(r.name) ?? 0, trips: stops,
    });
  }
  return out;
}
