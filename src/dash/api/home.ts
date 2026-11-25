// Home: what needs a person, what is wrong, where items are, and what just got done, in one read.
// Viewers get counts and short texts; the lists of needs name items only for staff.
import { isHiddenRepo, type HiddenRepos } from "../../hidden-sql.ts";
import type { NeedsPage, NeedsStoppedRow, Progress } from "../../../web/src/api/types.ts";
import { decisionPath, itemPath } from "../../../web/src/lib/links.ts";
import { optionsOf, type DecisionRow } from "../../decisions.ts";
import type { Req } from "../types.ts";
import { needingExpr, withoutHiddenExpr } from "./decisions.ts";
import { healthOf } from "./now.ts";
import { needs as needsPage } from "./needs.ts";
import { canSeeInternals } from "./staff.ts";
import { excludeHiddenExpr, hiddenRepos } from "./visible.ts";
import { ITEM_PHASES, phaseExpr, type Home, type HomeDone, type HomeNeed, type HomeProblem, type ItemPhase, type NeedKind } from "./home-types.ts";
import type { NotNull } from "kysely";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";

const OLDEST = 5;
const DONE = 10;
const DONE_CHUNK = 40;

type Deps = { progress: (hidden: string[]) => Promise<Progress> };

const itemKindOf = (k: string | undefined): "pr" | "issue" | null => (k === undefined ? null : k === "pr" ? "pr" : "issue");

async function phases(db: Db, hidden: string[]): Promise<Record<ItemPhase, number>> {
  const hide = excludeHiddenExpr(db, "i.repo", hidden);
  const out = Object.fromEntries(ITEM_PHASES.map((x) => [x, 0])) as Record<ItemPhase, number>;
  // Home's Merged and Closed tiles are today's (UTC), not every item ever closed.
  const day = new Date().toISOString().slice(0, 10);
  const [byPhase, today] = await Promise.all([db.all(db.k.selectFrom("items as i").leftJoin("main.item_plans as p", (j) => j.onRef("p.repo", "=", "i.repo").onRef("p.number", "=", "i.number"))
    .select((eb) => [phaseExpr(db, eb).as("phase"), eb.fn.countAll<number>().as("n")])
    .$if(!!hide, (q) => q.where(hide!)).groupBy("phase")), db.get(db.k.selectFrom("items as i")
    .select((eb) => [
      eb.fn.sum<number | null>(eb.case().when("i.merged_at", ">=", day).then(eb.lit(1)).else(eb.lit(0)).end()).as("merged"),
      eb.fn.sum<number | null>(eb.case().when(eb.and([eb("i.merged_at", "is", null), eb("i.closed_at", ">=", day)])).then(eb.lit(1)).else(eb.lit(0)).end()).as("closed"),
    ])
    .where((eb) => eb.or([eb("i.merged_at", ">=", day), eb("i.closed_at", ">=", day)]))
    .$if(!!hide, (q) => q.where(hide!)))]);
  for (const r of byPhase) if (r.phase in out) out[r.phase] += r.n;
  const t = today!;
  out.Merged = t.merged ?? 0;
  out.Closed = t.closed ?? 0;
  return out;
}

/** `total` is the nav badge's number: decisions, unanswered feedback and stopped items. `oldest` lists decisions and, for staff, high or critical findings still new (not in the total). */
async function needs(db: Db, req: Req, hidden: HiddenRepos, staff: boolean, page: NeedsPage): Promise<Home["needs"]> {
  const where = (eb: kx.Eb) => {
    const hide = withoutHiddenExpr(db, eb, hidden);
    const needing = needingExpr(db, eb, req);
    return hide ? eb.and([needing, hide]) : needing;
  };
  const byKind: Partial<Record<NeedKind, number>> = {};
  for (const r of await db.all(db.k.selectFrom("decisions").select(["kind", (eb) => eb.fn.countAll<number>().as("n")]).$narrowType<{ kind: NeedKind }>().where(where).groupBy("kind"))) byKind[r.kind] = r.n;
  // The Needs page's own counts, so the total is the nav badge's number for this user.
  const { counts } = page;
  const total = counts.decisions + counts.feedback + counts.stopped;
  if (counts.feedback) byKind.feedback = counts.feedback;
  if (counts.stopped) byKind.stopped = counts.stopped;
  if (!staff) return { total, byKind, oldest: [] };

  const fhide = excludeHiddenExpr(db, "repo", hidden);
  const findings = () => db.k.selectFrom("security_findings").where("state", "=", "new").where("severity", "in", ["high", "critical"]).$if(!!fhide, (q) => q.where(fhide!));
  const [oldest, fcRow, foundRows] = await Promise.all([
    db.all(db.k.selectFrom("decisions").select(kx.cols("decisions")).$narrowType<{ kind: DecisionRow["kind"] }>().where(where).orderBy("asked_at").orderBy("id").limit(OLDEST)),
    db.get(findings().select((eb) => eb.fn.countAll<number>().as("n"))),
    db.all(findings().select(["repo", "number", "title", "created_at"]).orderBy("created_at").orderBy("number").limit(OLDEST)),
  ]);
  const items = await itemsByRef(db, oldest.flatMap((d) => (d.number !== null && d.repo ? [[d.repo, d.number] as [string, number]] : [])));
  const asked: HomeNeed[] = oldest.map((d) => {
    const it = d.number !== null && d.repo ? items.get(`${d.repo}#${d.number}`) : undefined;
    return {
      id: d.id, kind: d.kind as NeedKind, repo: d.repo ?? "", number: d.number, title: d.number === null ? d.question : (it?.title ?? `${d.repo}#${d.number}`),
      recommendation: optionsOf(d).find((o) => o.key === d.recommended)?.label ?? null, askedAt: d.asked_at, itemKind: itemKindOf(it?.kind),
      to: decisionPath({ id: d.id, repo: d.repo ?? "", number: d.number }),
    };
  });

  const fc = fcRow!.n;
  const found: HomeNeed[] = foundRows
    .map((f) => ({ id: `finding:${f.repo}:${f.number}`, kind: "security" as const, repo: f.repo, number: f.number, title: f.title, recommendation: null, askedAt: f.created_at, itemKind: null, to: `/security/${f.repo}/${f.number}` }));
  if (fc) byKind.security = fc;
  return { total, byKind, oldest: [...asked, ...found].sort((a, b) => a.askedAt.localeCompare(b.askedAt)).slice(0, OLDEST) };
}

export async function problems(db: Db, hidden: string[], staff: boolean, stops: NeedsStoppedRow[]): Promise<HomeProblem[]> {
  const out: HomeProblem[] = [];
  for (const s of stops) out.push({ kind: "stopped", title: s.repo ? `${s.title} in ${s.repo}` : s.title, detail: staff ? s.reason : "", to: "/needs/stopped" });
  const seen = new Set(stops.map((s) => s.id));
  // The health list repeats breakers, limits and paused accounts; those are the stopped rows above.
  const fhide = excludeHiddenExpr(db, "repo", hidden);
  const ihide = excludeHiddenExpr(db, "i.repo", hidden);
  const [health, gaveUp, cifixFailed] = await Promise.all([
    healthOf(db, hidden, staff, Date.now()),
    staff ? db.all(db.k.selectFrom("security_findings").select(["repo", "number", "fix_attempts", "last_failure"]).$narrowType<{ last_failure: NotNull }>()
      .where("state", "=", "new").where("last_failure", "is not", null).$if(!!fhide, (q) => q.where(fhide!)).orderBy("updated_at", "desc")) : [],
    staff ? db.all(db.k.selectFrom("item_plans as p").innerJoin("items as i", (j) => j.onRef("i.repo", "=", "p.repo").onRef("i.number", "=", "p.number"))
      .select(["p.repo", "p.number", "i.title"]).where("i.state", "=", "OPEN").where((eb) => eb(kx.jsonText(db, "p.view", "$.cifix"), "=", "cifix-failed"))
      .$if(!!ihide, (q) => q.where(ihide!)).orderBy("p.planned_at", "desc").limit(20)) : [],
  ]);
  for (const p of health.problems)
    if (!seen.has(p.id)) out.push({ kind: p.area === "deadline" ? "stuck" : "health", title: p.text, detail: "", to: p.to });
  for (const f of gaveUp)
    out.push({ kind: "gave-up", title: `${f.repo} finding ${f.number}: fix gave up after ${f.fix_attempts} round${f.fix_attempts === 1 ? "" : "s"}`, detail: f.last_failure, to: `/security/${f.repo}/${f.number}` });
  for (const r of cifixFailed)
    out.push({ kind: "gave-up", title: `${r.repo}#${r.number}: CI fix gave up`, detail: r.title ?? "", to: itemPath(r.repo, r.number) });
  return out;
}

/** Title and kind of items by `repo#number`, in one read. */
async function itemsByRef(db: Db, refs: [string, number][]): Promise<Map<string, { title: string | null; kind: string }>> {
  if (!refs.length) return new Map();
  const rows = await db.all(db.k.selectFrom("items").select(["repo", "number", "title", "kind"]).where(kx.refIn(db, "items", refs)));
  return new Map(rows.map((r) => [`${r.repo}#${r.number}`, r]));
}

async function done(db: Db, hidden: string[]): Promise<HomeDone[]> {
  const what = { merge: "merged", "act-close": "closed", "review-post": "review posted" } as const;
  const out: HomeDone[] = [];
  // Newest first by time, so the scan stops at the tenth row that belongs to a visible item; items are read for a chunk of rows at a time.
  type Row = { at: string; action: keyof typeof what; repo: string; number: number };
  let chunk: Row[] = [];
  const flush = async (): Promise<boolean> => {
    const items = await itemsByRef(db, chunk.map((r) => [r.repo, r.number]));
    for (const r of chunk) {
      const it = items.get(`${r.repo}#${r.number}`);
      if (!it) continue;
      out.push({ at: r.at, what: what[r.action], repo: r.repo, number: r.number, title: it.title ?? "", kind: it.kind === "pr" ? "pr" : "issue" });
      if (out.length === DONE) return true;
    }
    chunk = [];
    return false;
  };
  for (const a of await db.all(db.k.selectFrom("audit").select(["at", "action", "target"]).$narrowType<{ action: keyof typeof what }>()
    .where("action", "in", ["merge", "act-close", "review-post"]).where((eb) => eb(kx.jsonText(db, "details", "$.state"), "=", "done"))
    .orderBy("at", "desc"))) {
    const m = /^(.+)#(\d+)$/.exec(a.target ?? "");
    if (!m || isHiddenRepo(hidden, m[1]!)) continue;
    chunk.push({ at: a.at, action: a.action, repo: m[1]!, number: Number(m[2]) });
    if (chunk.length === DONE_CHUNK && await flush()) return out;
  }
  await flush();
  return out;
}

async function running(db: Db, hidden: string[]): Promise<string> {
  const hide = excludeHiddenExpr(db, "repo", hidden);
  const bhide = excludeHiddenExpr(db, "repo", hidden);
  const [jobRow, batchRows] = await Promise.all([
    db.get(db.k.selectFrom("jobs").select((eb) => eb.fn.countAll<number>().as("n")).where("state", "=", "running")
      .$if(!!hide, (q) => q.where((eb) => eb.or([eb("repo", "is", null), hide!])))),
    db.all(db.k.selectFrom("merge_batches").select("id").where("state", "=", "checking").$if(!!bhide, (q) => q.where(bhide!)).orderBy("id")),
  ]);
  const jobs = jobRow!.n;
  const batches = batchRows.map((b) => `#${b.id}`);
  const parts = [jobs ? `${jobs} job${jobs === 1 ? "" : "s"} running` : "", batches.length ? `batch${batches.length === 1 ? "" : "es"} ${batches.join(", ")} checking` : ""].filter(Boolean);
  return parts.length ? parts.join(", ") : "Nothing running";
}

async function spendToday(db: Db, hidden: string[]): Promise<number> {
  const day = new Date().toISOString().slice(0, 10);
  const hide = excludeHiddenExpr(db, "repo", hidden);
  return (await db.get(db.k.selectFrom("token_usage").select((eb) => eb.fn.coalesce(eb.fn.sum<number>("cost_usd"), eb.lit(0)).as("s"))
    .where((eb) => eb(eb.fn<string>("substr", [eb.fn.coalesce("ended_at", "started_at"), eb.lit(1), eb.lit(10)]), "=", day))
    .$if(!!hide, (q) => q.where((eb) => eb.or([eb("repo", "is", null), hide!])))))!.s;
}

/** Share of the PRs merged since `since` that AutoCraft merged itself or carried in a merged batch. */
async function byAutoCraftPct(db: Db, hidden: string[], since: string): Promise<number> {
  const hide = excludeHiddenExpr(db, "i.repo", hidden);
  const r = (await db.get(db.k.selectFrom("items as i")
    .select((eb) => [
      eb.fn.countAll<number>().as("n"),
      eb.fn.sum<number | null>(eb.case().when(eb.exists(eb.selectFrom("main.merges as m").select(eb.lit(1).as("one")).whereRef("m.repo", "=", "i.repo").whereRef("m.number", "=", "i.number").where("m.outcome", "=", "merged"))).then(eb.lit(1)).else(eb.lit(0)).end()).as("ours"),
    ])
    .where("i.kind", "=", "pr").where("i.merged_at", ">=", since).$if(!!hide, (q) => q.where(hide!))))!;
  return r.n ? Math.round(((r.ours ?? 0) / r.n) * 100) : 0;
}

/** With a project scope (`req.scope`), every part is that repo's only, as if it were the only one the requester could see. */
export async function home(db: Db, req: Req, deps: Deps): Promise<Home> {
  const hidden = await hiddenRepos(db, req);
  const staff = canSeeInternals(req);
  // The parts read independently, so they run together.
  const [pg, page, phasesNow, runningNow, spend, doneNow] = await Promise.all([
    deps.progress(hidden),
    // The Needs page's stopped rows are the problems list's first rows.
    needsPage(db, req),
    phases(db, hidden), running(db, hidden), spendToday(db, hidden), done(db, hidden),
  ]);
  const start = pg.repos.reduce((s, r) => s + (r.openTrend[0] ?? 0), 0);
  const [needsNow, problemsNow, pct] = await Promise.all([needs(db, req, hidden, staff, page), problems(db, hidden, staff, page.stopped), byAutoCraftPct(db, hidden, pg.trackingSince)]);
  return {
    needs: needsNow,
    problems: problemsNow,
    phases: phasesNow,
    running: runningNow,
    progress: { openNow: pg.funnel.open, openAtStart: start, done24h: pg.perHour.reduce((a, b) => a + b, 0), byAutoCraftPct: pct, perHour: pg.perHour, spendTodayUsd: spend },
    done: doneNow,
  };
}
