// GET /api/maintain/home: the new Home's read (behind each user's `ui_v2` switch). Items come from the live workflow rows
// (src/workflow/store.ts) of the repos the reader may see, narrowed to the picked project. An item needs an answer when its
// recommendation is open or its last answer was unclear; it counts for the reader only where they may act on the repo
// (mayRunRepo: operators on every repo, maintainers where GitHub grants write). Text is built by src/workflow/status.ts.
import type { Expression, SelectQueryBuilder, SqlBool } from "kysely";
import type { MaintainHome, MaintainItemGroup, MaintainItemRow, MaintainItems, MaintainItemsFilter, MaintainItemsShow, MaintainQueueMeta, MaintainRepo, MaintainRow, MaintainRunnerLine, MaintainStats } from "../../../web/src/api/types.ts";
import { t } from "../../i18n/index.ts";
import { listHelpers } from "../../remote/helpers.ts";
import { inferenceMode } from "../../remote/mode.ts";
import { readyRunners } from "../../remote/queue-view.ts";
import { recommendationText, stateLine, weightLabel } from "../../workflow/status.ts";
import { liveWorkflows, repoWorkflows } from "../../workflow/store.ts";
import type { ItemWorkflow, WorkflowEventKind } from "../../workflow/types.ts";
import { mayRunRepo } from "../repo-access.ts";
import type { Req } from "../types.ts";
import { problems } from "./home.ts";
import { stopped } from "./needs.ts";
import { canSeeInternals } from "./staff.ts";
import { allVisibleRepos, blankIfHidden, excludeHiddenExpr, hiddenRepos, visibleRepos } from "./visible.ts";
import { stepTitle } from "./trace.ts";
import { mayResumeTrip } from "../../push-outcomes.ts";
import { parseTripKey } from "../../core/push-outcome.ts";
import type { Db } from "../../db/index.ts";
import { inList, refIn, type AnyEb } from "../../db/kx.ts";
import type { Eb } from "../../db/kx.ts";
import { latestCteExpr, trackedExpr } from "./stats.ts";
import { parseSearch } from "../../db/search.ts";
import { latestRun, settledOnExpr, settledTable } from "../../classify/settled.ts";
import { groupHeldExpr } from "../../dupes/held.ts";
import { quietExprFor } from "../../security/quiet.ts";
import { statusFromItem } from "../../core/item-status.ts";
import type { PlanView } from "../../core/plan-cache.ts";
import { WEIGHT_NORMAL } from "../../workflow/types.ts";
import { HttpError } from "../server/util.ts";
import { itemState } from "./shown.ts";
import { textCond } from "./items.ts";
import { readerOf, statusFor } from "./reader.ts";
import { phaseExpr, type ItemPhase, type ItemStatus } from "./home-types.ts";

/** The kind of each item's latest workflow event, keyed `repo#number`, for items of `repos`. */
async function lastEvents(db: Db, repos: string[]): Promise<Map<string, WorkflowEventKind>> {
  if (!repos.length) return new Map();
  const rows = await db.all(db.k.selectFrom("main.workflow_events as e").select(["e.repo", "e.number", "e.kind"])
    .where("e.id", "in", (eb) => eb.selectFrom("main.workflow_events as m").select((m) => m.fn.max("m.id").as("id")).where(inList(db, "m.repo", repos)).groupBy(["m.repo", "m.number"])));
  return new Map(rows.map((r) => [`${r.repo}#${r.number}`, r.kind as WorkflowEventKind]));
}

async function rowsOf(db: Db, wfs: ItemWorkflow[]): Promise<MaintainRow[]> {
  if (!wfs.length) return [];
  const [last, items] = await Promise.all([
    lastEvents(db, [...new Set(wfs.map((w) => w.repo))]),
    db.all(db.k.selectFrom("main.items as i").select(["i.repo", "i.number", "i.title", "i.author"]).where(refIn(db, "i", wfs.map((w) => [w.repo, w.number] as const)))),
  ]);
  const byRef = new Map(items.map((i) => [`${i.repo}#${i.number}`, i]));
  return wfs.map((w) => {
    const it = byRef.get(`${w.repo}#${w.number}`);
    const isUnclear = last.get(`${w.repo}#${w.number}`) === "ambiguous";
    const open = w.state === "recommending" && w.rec !== null;
    return {
      repo: w.repo, number: w.number, kind: w.kind, title: it?.title ?? `${w.repo}#${w.number}`, author: it?.author ?? null, entry: w.entry,
      line: isUnclear ? t("Waiting for a clear answer") : open ? recommendationText(w.rec!) : stateLine(w),
      waits: open || isUnclear, blocked: w.state === "blocked", weight: weightLabel(w.weight),
      startedBy: w.startedBy, approvedBy: w.approvedBy, stoppedBy: w.stoppedBy, updatedAt: w.updatedAt,
    };
  });
}

async function runnerLine(db: Db, login: string): Promise<MaintainRunnerLine> {
  const now = Date.now();
  const [mine, ready] = await Promise.all([listHelpers(db, login, now), readyRunners(db, now)]);
  const me = login.toLowerCase();
  return {
    mine: mine.map((h) => ({ name: h.label ?? t("Task Runner"), online: h.fresh, running: h.busy ?? 0 })),
    others: ready.filter((r) => r.login.toLowerCase() !== me && !r.manual).length,
  };
}

export async function home(db: Db, req: Req): Promise<MaintainHome> {
  const visible = new Set(await visibleRepos(db, req));
  const live = (await liveWorkflows(db)).filter((w) => visible.has(w.repo));
  const repos = [...new Set(live.map((w) => w.repo))];
  const may = req.user.role === "viewer" ? [] : await Promise.all(repos.map((r) => mayRunRepo(req.user, r)));
  const acting = new Set(repos.filter((_, i) => may[i]));
  const hidden = await hiddenRepos(db, req);
  const staff = canSeeInternals(req);
  const [rows, attention, runner] = await Promise.all([
    rowsOf(db, live),
    stopped(db, hidden, req.user).then((stops) => problems(db, hidden, staff, stops)),
    staff && await inferenceMode(db) === "user-local" ? runnerLine(db, req.user.login) : null,
  ]);
  // Most recently moved first.
  rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  if (req.user.role === "viewer") return { needs: [], mine: [], waiting: rows.filter((r) => r.waits), running: rows.filter((r) => !r.waits), runner: null, attention };
  const needs = rows.filter((r) => r.waits && acting.has(r.repo));
  const me = req.user.login.toLowerCase();
  const byMe = (l: string | null) => l !== null && l.toLowerCase() === me;
  const mine = rows.filter((r) => !needs.includes(r) && (byMe(r.startedBy) || byMe(r.approvedBy) || byMe(r.stoppedBy)));
  return { needs, mine, waiting: [], running: [], runner, attention };
}

/**
 * What the new Work queue page needs beyond the classic reads: the visible repos on the new workflow (their holds go through
 * the workflow controls, the others through the classic routes) and who approved each started item for merge.
 */
export async function queueMeta(db: Db, req: Req): Promise<MaintainQueueMeta> {
  const visible = new Set(await visibleRepos(db, req));
  const newRepos = (await repoWorkflows(db)).filter((r) => r.workflow === "new" && visible.has(r.repo)).map((r) => r.repo);
  const live = (await liveWorkflows(db)).filter((w) => visible.has(w.repo) && w.approvedBy !== null);
  return { newRepos, approvedBy: Object.fromEntries(live.map((w) => [`${w.repo}#${w.number}`, w.approvedBy!])) };
}

const DAY = 86400_000;

/** Headline numbers and merges per day for the last 7 or 30 days (UTC days, today last), over the repos the reader sees. */
export async function stats(db: Db, req: Req): Promise<MaintainStats> {
  const days = req.query.get("period") === "30d" ? 30 : 7;
  const hidden = await hiddenRepos(db, req);
  const today = new Date().toISOString().slice(0, 10);
  const labels = Array.from({ length: days }, (_, i) => new Date(Date.parse(today) - (days - 1 - i) * DAY).toISOString().slice(0, 10));
  const from = labels[0]!;
  const hideItems = (col: string) => excludeHiddenExpr(db, col, hidden);
  const day = (eb: Eb, col: string) => eb.fn<string>("substr", [col, eb.lit(1), eb.lit(10)]);
  const closed = await db.all(latestCteExpr(db).selectFrom("main.items as i")
    .leftJoin("latest as l", (j) => j.onRef("l.repo", "=", "i.repo").onRef("l.number", "=", "i.number"))
    .select((eb) => [day(eb, "i.closed_at").as("d"), "i.state", "l.stage", "i.kind"])
    .where("i.closed_at", ">=", from).where("i.state", "<>", "OPEN")
    .where((eb) => trackedExpr(db, eb, "i.repo")).where((eb) => hideItems("i.repo") ?? eb.lit(true))
    .$narrowType<{ d: string }>());
  const perDay = new Map(labels.map((d) => [d, 0]));
  let merged = 0, implemented = 0, closedN = 0;
  for (const r of closed) {
    closedN++;
    if (r.state === "MERGED") {
      merged++;
      if (perDay.has(r.d)) perDay.set(r.d, perDay.get(r.d)! + 1);
    } else if (r.stage === "fixed-by-us" && r.kind === "issue") implemented++;
  }
  const created = (await db.get(db.k.selectFrom("main.items as i").select((eb) => eb.fn.countAll<number>().as("n"))
    .where("i.created_at", ">=", from).where((eb) => trackedExpr(db, eb, "i.repo")).where((eb) => hideItems("i.repo") ?? eb.lit(true))))!.n;
  const backlog = (await db.get(db.k.selectFrom("main.items as i").select((eb) => eb.fn.countAll<number>().as("n"))
    .where("i.state", "=", "OPEN").where((eb) => trackedExpr(db, eb, "i.repo")).where((eb) => hideItems("i.repo") ?? eb.lit(true))))!.n;
  const reviewed = (await db.all(db.k.selectFrom("main.opus_reviews as o").select(["o.repo", "o.number"]).distinct()
    .where("o.at", ">=", from).where((eb) => hideItems("o.repo") ?? eb.lit(true)))).length;
  const hideUsage = hideItems("repo");
  const spend = (await db.get(db.k.selectFrom("token_usage").select((eb) => eb.fn.coalesce(eb.fn.sum<number>("cost_usd"), eb.lit(0)).as("s"))
    .where((eb) => eb(day(eb, eb.fn.coalesce("ended_at", "started_at") as never), ">=", from))
    .$if(!!hideUsage, (q) => q.where((eb) => eb.or([eb("repo", "is", null), hideUsage!])))))!.s;
  return { period: days === 30 ? "30d" : "7d", merged, implemented, reviewed, backlog, backlogChange: created - closedN, spend: Math.round(spend), perDay: labels.map((d) => ({ day: d, n: perDay.get(d)! })) };
}

// ---- GET /api/maintain/items: the new Items page ------------------------------------------------------------------------
// Open items of the repos the reader may see, in four lists (groupOf), each ordered by priority: the workflow weight, then the
// work rank (src/rank). A started item's line comes from its workflow row; an item nobody started shows the pipeline's status
// line (the plan view), veiled for the reader as on every other list. Grouping runs here over the open items' narrow columns;
// only the rows sent are read in full. Closed items are read newest first, one page at a time.

/** Plan phases in which AutoCraft works an item that nobody started. */
const WORKING_PHASES: ReadonlySet<ItemPhase> = new Set(["Review", "Fixing", "Verifying", "In queue"]);
const SHOWS: readonly MaintainItemsShow[] = ["open", "backlog", "closed"];
const FILTERS: readonly MaintainItemsFilter[] = ["security", "outside", "stuck", "duplicates"];
const STAFF_FILTERS: readonly MaintainItemsFilter[] = ["security", "stuck"];
const GROUPS: readonly MaintainItemGroup[] = ["needs", "started", "automatic", "rest", "backlog", "done"];
const NO_AREA = "none";
const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 500;
const REFS_MAX = 100;

/** Which list an item goes in. An answer awaited comes first, then a live workflow; a Backlog item leaves the active lists. */
export function groupOf(x: { open: boolean; live: boolean; waits: boolean; backlog: boolean; phase: ItemPhase }): MaintainItemGroup {
  if (!x.open) return "done";
  if (x.waits) return "needs";
  if (x.live) return "started";
  if (x.backlog) return "backlog";
  return WORKING_PHASES.has(x.phase) ? "automatic" : "rest";
}

/** Whether an item waits for an answer: its live workflow has an open recommendation, or the last thing said to it was unclear. */
export const waitsForAnswer = (wf: Pick<ItemWorkflow, "state" | "rec"> | null, lastEvent: WorkflowEventKind | undefined): boolean =>
  lastEvent === "ambiguous" || (wf !== null && wf.state === "recommending" && wf.rec !== null);

const listParam = (q: URLSearchParams, key: string): string[] => q.getAll(key).flatMap((v) => v.split(",")).map((s) => s.trim()).filter(Boolean);

type Cond = (eb: AnyEb) => Expression<SqlBool>;
type Base = { repo: string; number: number; kind: string; state: string; title: string | null; author: string | null; updated_at: string | null; merged_at: string | null; closed_at: string | null; score: number | null; phase: ItemPhase; plan_state: string | null; plan_item_state: string | null };
type Placed = Base & { group: MaintainItemGroup; wf: ItemWorkflow | null; unclear: boolean };

const PLAN_BACKLOG = new Set(["backlog", "held-backlog"]);

export async function items(db: Db, req: Req): Promise<MaintainItems> {
  const q = req.query;
  const show = (q.get("show") ?? "open") as MaintainItemsShow;
  if (!SHOWS.includes(show)) throw new HttpError(400, "show must be open, backlog or closed");
  const staff = canSeeInternals(req);
  const filters = listParam(q, "filter") as MaintainItemsFilter[];
  for (const f of filters) {
    if (!FILTERS.includes(f)) throw new HttpError(400, "filter must be security, outside, stuck or duplicates");
    if (!staff && STAFF_FILTERS.includes(f)) throw new HttpError(403, "only operators and maintainers filter by security findings or stuck items");
  }
  const areas = listParam(q, "area");
  const text = (q.get("q") ?? "").trim();
  const fts = text ? parseSearch(text) : null;
  const refs = listParam(q, "refs").slice(0, REFS_MAX);
  const refPairs = refs.map((r) => [r.slice(0, r.lastIndexOf("#")), Number(r.slice(r.lastIndexOf("#") + 1))] as const);
  if (refPairs.some(([repo, n]) => !repo || !Number.isInteger(n))) throw new HttpError(400, "refs must be repo#number");
  const sort = q.get("sort") ?? "priority";
  if (sort !== "priority" && sort !== "updated") throw new HttpError(400, "sort must be priority or updated");
  const limit = Math.min(LIMIT_MAX, Math.max(1, Number(q.get("limit")) || LIMIT_DEFAULT));
  const counts = Object.fromEntries(GROUPS.map((g) => [g, 0])) as Record<MaintainItemGroup, number>;

  const visible = await visibleRepos(db, req);
  if (!visible.length || (q.has("refs") && !refPairs.length)) return { rows: [], counts };
  const run = filters.includes("security") ? await latestRun(db) : null;
  if (run) await settledTable(db, run);

  const conds: Cond[] = [() => inList(db, "i.repo", visible), (eb) => (show === "closed" ? eb("i.state", "<>", "OPEN") : eb("i.state", "=", "OPEN"))];
  if (refPairs.length) conds.push(() => refIn(db, "i", refPairs));
  if (fts) conds.push(textCond(db, fts));
  const same = (eb: AnyEb, t: string) => eb.and([eb(eb.ref(`${t}.repo`), "=", eb.ref("i.repo")), eb(eb.ref(`${t}.number`), "=", eb.ref("i.number"))]);
  for (const f of filters) {
    if (f === "outside") conds.push((eb) => eb.exists(eb.selectFrom("main.outside_holds as oh").select(eb.lit(1).as("one")).where((w) => same(w, "oh"))));
    if (f === "stuck") conds.push((eb) => eb.exists(eb.selectFrom("main.liveness_items as li").select(eb.lit(1).as("one")).where((w) => same(w, "li")).where("li.verdict", "=", "stuck")));
    if (f === "duplicates") conds.push((eb) => groupHeldExpr(db, eb, "i"));
    if (f === "security") conds.push((eb) => eb.and([
      eb.exists(eb.selectFrom("main.item_settled as s").select(eb.lit(1).as("one")).where((w) => settledOnExpr(w, run, "s")).where("s.security", "=", 1)),
      eb.not(quietExprFor(db, eb, "i.repo", "i.number")),
    ]));
  }
  if (areas.length) {
    const named = areas.filter((a) => a !== NO_AREA);
    conds.push((eb) => eb.or([
      ...(named.length ? [eb.exists(eb.selectFrom("main.item_areas as ia").select(eb.lit(1).as("one")).where((w) => same(w, "ia")).where("ia.area", "in", named))] : []),
      ...(areas.includes(NO_AREA) ? [eb.not(eb.exists(eb.selectFrom("main.item_areas as ia").select(eb.lit(1).as("one")).where((w) => same(w, "ia")).where("ia.area", "is not", null)))] : []),
    ]));
  }

  const base = db.k.selectFrom("main.items as i")
    .leftJoin("main.item_plans as p", (j) => j.onRef("p.repo", "=", "i.repo").onRef("p.number", "=", "i.number"))
    .leftJoin("main.item_rank as r", (j) => j.onRef("r.repo", "=", "i.repo").onRef("r.number", "=", "i.number"));
  const where = <QB extends SelectQueryBuilder<any, any, any>>(qb: QB): QB => conds.reduce((acc, c) => acc.where(c) as QB, qb);
  const cols = (qb: typeof base) => qb.select(["i.repo", "i.number", "i.kind", "i.state", "i.title", "i.author", "i.updated_at", "i.merged_at", "i.closed_at", "r.score",
    "p.state as plan_state", "p.item_state as plan_item_state", (eb) => phaseExpr(db, eb).as("phase")]);

  let placed: Placed[];
  if (show === "closed") {
    const [n, got] = await Promise.all([
      db.get(where(base.select((eb) => eb.fn.countAll<number>().as("n")))),
      db.all(where(cols(base)).orderBy((eb) => eb.fn.coalesce("i.updated_at", eb.val("")), "desc").orderBy("i.repo").orderBy("i.number", "desc").limit(refPairs.length ? REFS_MAX : limit)),
    ]);
    counts.done = Number(n?.n ?? 0);
    placed = (got as Base[]).map((b) => ({ ...b, group: "done", wf: null, unclear: false }));
  } else {
    const [got, live, last] = await Promise.all([db.all(where(cols(base))) as Promise<Base[]>, liveWorkflows(db), lastEvents(db, visible)]);
    const wfOf = new Map(live.map((w) => [`${w.repo}#${w.number}`, w]));
    placed = got.map((b) => {
      const key = `${b.repo}#${b.number}`;
      const wf = wfOf.get(key) ?? null;
      const ev = last.get(key);
      const waits = waitsForAnswer(wf, ev);
      const backlog = ev === "backlog" || PLAN_BACKLOG.has(b.plan_state ?? "") || b.plan_item_state === "held-backlog";
      return { ...b, wf, unclear: ev === "ambiguous", group: groupOf({ open: true, live: wf !== null, waits, backlog, phase: b.phase }) };
    }).filter((p) => (show === "backlog" ? p.group === "backlog" : p.group !== "backlog"));
    for (const p of placed) counts[p.group]++;
  }

  // Semantic hits keep their order; otherwise the heaviest first, then the work rank, then the latest change.
  const hitAt = new Map(refs.map((r, i) => [r, i]));
  const updated = (a: Placed, b: Placed) => ((a.updated_at ?? "") < (b.updated_at ?? "") ? 1 : (a.updated_at ?? "") > (b.updated_at ?? "") ? -1 : 0);
  const order = (a: Placed, b: Placed): number => {
    if (hitAt.size) return (hitAt.get(`${a.repo}#${a.number}`) ?? 0) - (hitAt.get(`${b.repo}#${b.number}`) ?? 0);
    if (sort === "updated") return updated(a, b);
    return (b.wf?.weight ?? WEIGHT_NORMAL) - (a.wf?.weight ?? WEIGHT_NORMAL) || (b.score ?? -1) - (a.score ?? -1) || updated(a, b) || a.repo.localeCompare(b.repo) || b.number - a.number;
  };
  const page = GROUPS.flatMap((g) => placed.filter((p) => p.group === g).sort(order).slice(0, limit));
  return { rows: await itemRows(db, req, page, staff), counts };
}

/** The rows sent: status lines, signals and whether the reader may send commands on each repo. */
async function itemRows(db: Db, req: Req, page: Placed[], staff: boolean): Promise<MaintainItemRow[]> {
  if (!page.length) return [];
  const pairs = page.map((p) => [p.repo, p.number] as const);
  const repos = [...new Set(page.map((p) => p.repo))];
  const [views, outside, stuck, dupes, areas, reader, may] = await Promise.all([
    db.all(db.k.selectFrom("main.item_plans as p").select(["p.repo", "p.number", "p.view"]).where(refIn(db, "p", pairs))),
    db.all(db.k.selectFrom("main.outside_holds as o").select(["o.repo", "o.number"]).where(refIn(db, "o", pairs))),
    staff ? db.all(db.k.selectFrom("main.liveness_items as l").select(["l.repo", "l.number"]).where(refIn(db, "l", pairs)).where("l.verdict", "=", "stuck")) : [],
    db.all(db.k.selectFrom("main.items as i").select(["i.repo", "i.number"]).where(refIn(db, "i", pairs)).where((eb) => groupHeldExpr(db, eb, "i"))),
    db.all(db.k.selectFrom("main.item_areas as a").select(["a.repo", "a.number", "a.area"]).where(refIn(db, "a", pairs)).where("a.area", "is not", null)),
    readerOf(db, req),
    req.user.role === "viewer" ? repos.map(() => false) : Promise.all(repos.map((r) => mayRunRepo(req.user, r))),
  ]);
  const key = (r: { repo: string; number: number }) => `${r.repo}#${r.number}`;
  const keys = (rs: { repo: string; number: number }[]) => new Set(rs.map(key));
  const [outsideSet, stuckSet, dupeSet] = [keys(outside), keys(stuck), keys(dupes)];
  const areaOf = new Map(areas.map((a) => [key(a), a.area]));
  const viewOf = new Map(views.map((v) => [key(v), v.view]));
  const mayRepo = new Map(repos.map((r, i) => [r, may[i]!]));
  return page.map((p): MaintainItemRow => {
    const wf = p.wf;
    let status: ItemStatus | null = null;
    if (!wf) {
      let view: PlanView | undefined;
      try { view = viewOf.has(key(p)) ? (JSON.parse(viewOf.get(key(p))!) as PlanView) : undefined; } catch { /* a malformed view counts as none */ }
      status = view?.status ? statusFor(reader, p.repo, p.number, view.status) : statusFromItem(p, p.updated_at ?? "");
    }
    return {
      repo: p.repo, number: p.number, kind: p.kind === "pr" ? "pr" : "issue", state: itemState(p.state), title: p.title ?? `${p.repo}#${p.number}`, author: p.author,
      group: p.group, line: wfLine(wf, p.unclear), status, blocked: wf?.state === "blocked", weight: wf ? weightLabel(wf.weight) : null,
      startedBy: wf?.startedBy ?? null, approvedBy: wf?.approvedBy ?? null, stoppedBy: wf?.stoppedBy ?? null,
      duplicate: dupeSet.has(key(p)), outside: outsideSet.has(key(p)), stuck: stuckSet.has(key(p)), area: areaOf.get(key(p)) ?? null,
      may: mayRepo.get(p.repo) ?? false, updatedAt: p.updated_at ?? "",
    };
  });
}

/** As on Home: an unclear last answer, else a started item's open recommendation or where it stands; null for an unstarted item. */
function wfLine(wf: ItemWorkflow | null, unclear: boolean): string | null {
  if (unclear) return t("Waiting for a clear answer");
  if (!wf) return null;
  return wf.state === "recommending" && wf.rec !== null ? recommendationText(wf.rec) : stateLine(wf);
}

const WEEK_MS = 7 * 24 * 3600 * 1000;

/** GET /api/maintain/repos: the Repos page, for every role. Counts and switches are the reader's visible tracked repos; only who may act differs. */
export async function repos(db: Db, req: Req): Promise<MaintainRepo[]> {
  const names = await allVisibleRepos(db, req);
  if (!names.length) return [];
  const hidden = await hiddenRepos(db, req);
  const since = new Date(Date.now() - WEEK_MS).toISOString();
  const [rows, open, merged, live, trips] = await Promise.all([
    db.all(db.k.selectFrom("main.tracked_repos").select(["name", "pipeline", "workflow"]).where("name", "in", names)),
    db.all(db.k.selectFrom("main.items").select((eb) => ["repo", eb.fn.countAll<number>().as("n")]).where("state", "=", "open").where("repo", "in", names).groupBy("repo")),
    db.all(db.k.selectFrom("main.items").select((eb) => ["repo", eb.fn.countAll<number>().as("n")]).where("merged_at", ">=", since).where("repo", "in", names).groupBy("repo")),
    liveWorkflows(db),
    db.all(db.k.selectFrom("stage_trips").select(["stage", "reason", "tripped_at"]).where("active", "=", 1).orderBy("tripped_at")),
  ]);
  const count = (xs: { repo: string; n: number }[], repo: string) => Number(xs.find((x) => x.repo === repo)?.n ?? 0);
  const out: MaintainRepo[] = [];
  for (const r of rows.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const mine = live.filter((w) => w.repo === r.name);
    const stops: MaintainRepo["trips"] = [];
    for (const t of trips) {
      const k = parseTripKey(t.stage);
      if (k?.repo !== r.name) continue;
      stops.push({ key: t.stage, text: `${stepTitle(k.stage)}: ${blankIfHidden(t.reason, hidden)}`, since: t.tripped_at, canResume: await mayResumeTrip(req.user, t.stage) });
    }
    out.push({
      name: r.name, workflow: r.workflow === "new" ? "new" : "legacy", automatic: !!r.pipeline, canRun: await mayRunRepo(req.user, r.name),
      open: count(open, r.name), started: mine.length, waiting: mine.filter((w) => w.state === "recommending" && w.rec !== null).length, mergedWeek: count(merged, r.name), trips: stops,
    });
  }
  return out;
}
