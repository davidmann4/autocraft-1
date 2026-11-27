// reads: mirror.items, planner.item_plans, triage.item_rank, workflow.item_workflows, workflow.workflow_events, intake.outside_holds,
//        planner.liveness_items, triage.item_areas, triage.item_settled, triage.dupe_group_items, security.security_findings, merge.merges,
//        merge.merge_batches, merge.merge_batch_prs
// The Items page: one statement for the filtered rows with their workflow and plan signals, and the facts of the rows a page shows.
import type { Expression, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { parseSearch } from "../../db/search.ts";
import { queryDb } from "../../db/query-db.ts";
import * as access from "../access/index.ts";
import { heldExpr } from "../intake/fragments.ts";
import * as intake from "../intake/index.ts";
import { stuckItem } from "../planner/fragments.ts";
import * as planner from "../planner/index.ts";
import { mergedPrs } from "../merge/fragments.ts";
import { quietPrExpr } from "../security/fragments.ts";
import { hasNoArea, inAreas, isDuplicateClose, rankJoin, settledJoin } from "../triage/fragments.ts";
import * as triage from "../triage/index.ts";
import { LIVE_STATES, notArchived } from "../workflow/fragments.ts";
import * as workflow from "../workflow/index.ts";
import type { ItemBase, ItemRowFacts, ItemsBase, ItemsFilter, Scope } from "./types.ts";
import { hiddenRepos } from "../control/fragments.ts";
import { textHit } from "./items.ts";

/** The SQL of an item's phase: its plan's stored phase, else Merged, Closed or Triage from the item. Needs `i` (items) and `p` (item_plans, left joined). */
export const phaseOf = (db: Db, eb: kx.Eb) => eb.fn.coalesce(
  kx.jsonText(db, "p.view", "$.status.phase"),
  eb.case().when("i.merged_at", "is not", null).then("Merged").when("i.closed_at", "is not", null).then("Closed").else("Triage").end(),
);

const NO_AREA = "none";

/** What decides an open item's group, and nothing else of it. */
const PLACE = ["wf_state", "has_rec", "last_event", "plan_state", "plan_item_state", "phase"] as const;

/**
 * The open items of `scope.repos` that pass the filter, or one page of the closed ones or of the pull requests AutoCraft merged (newest merge first),
 * with plan, rank and live workflow columns and the kind of the item's latest workflow event. Open items that agree in what decides their group (workflow
 * state and recommendation, last event, plan state and phase) are placed together: `places` has one of each with its count, and `rows` the first
 * `limit` of each in the asked order. `closedTotal` counts the closed or merged items the filter matches, whatever `limit` cuts.
 */
export async function loadItemsBase(db: Db, scope: Pick<Scope, "repos" | "hidden">, f: ItemsFilter): Promise<ItemsBase> {
  if (!scope.repos.length) return { rows: [], places: [], closedTotal: null };
  // The settled table of the classification run is built (a write) before the read.
  const run = f.filters.includes("security") ? await triage.currentRunReady(db) : null;
  const q = queryDb(db);
  const fts = f.text ? parseSearch(f.text) : null;
  const merged = f.show === "merged", closed = f.show === "closed" || merged;
  const conds = (eb: kx.AnyEb): Expression<SqlBool>[] => {
    const c: Expression<SqlBool>[] = [kx.inList(db, "i.repo", scope.repos), merged ? eb("i.kind", "=", "pr") : closed ? eb("i.state", "<>", "OPEN") : eb("i.state", "=", "OPEN")];
    if (f.refs.length) c.push(kx.refIn(db, "i", f.refs.map((r) => [r.slice(0, r.lastIndexOf("#")), Number(r.slice(r.lastIndexOf("#") + 1))] as const)));
    if (f.mine) c.push(kx.refIn(db, "i", f.mine));
    if (fts) c.push(textHit(eb, db, fts));
    for (const x of f.filters) {
      if (x === "outside") c.push(heldExpr(eb, "i.repo", "i.number"));
      if (x === "stuck") c.push(stuckItem(eb, "i"));
      if (x === "duplicates") c.push(isDuplicateClose(db, eb, "i.repo", "i.number"));
      if (x === "security") c.push(eb.and([
        eb.exists(kx.schemaEb(eb).selectFrom("main.item_settled as s").select(eb.lit(1).as("one")).where((w) => settledJoin(w, run, "s")).where("s.security", "=", 1)),
        eb.not(quietPrExpr(eb, "i.repo", "i.number")),
      ]));
    }
    if (f.areas.length) {
      const named = f.areas.filter((a) => a !== NO_AREA);
      c.push(eb.or([...(named.length ? [inAreas(eb, "i.repo", "i.number", named)] : []), ...(f.areas.includes(NO_AREA) ? [hasNoArea(eb, "i.repo", "i.number")] : [])]));
    }
    c.push(hiddenRepos(db, "i.repo", scope.hidden));
    return c;
  };
  // A live workflow is unique per item. All open items are read, so their newest events come as one set; the closed page probes the few it shows.
  const newestEvents = q.k.selectFrom("main.workflow_events as le").select((e) => ["le.repo", "le.number", e.fn.max<number>("le.id").as("id")]).where((w) => notArchived(w, "le.kind")).groupBy(["le.repo", "le.number"]);
  const joined = () => rankJoin(q.k.selectFrom("main.items as i")
    .leftJoin("main.item_plans as p", (j) => j.onRef("p.repo", "=", "i.repo").onRef("p.number", "=", "i.number")))
    .leftJoin("main.item_workflows as w", (j: any) => j.onRef("w.repo", "=", "i.repo").onRef("w.number", "=", "i.number").on("w.state", "in", LIVE_STATES));
  const base = () => (closed
    ? joined().leftJoin("main.workflow_events as ev", (j: any) => j.onRef("ev.repo", "=", "i.repo").onRef("ev.number", "=", "i.number").on((eb: kx.AnyEb) => notArchived(eb, "ev.kind"))
      .on("ev.id", "=", (eb: kx.AnyEb) => eb.selectFrom("main.workflow_events as le").select((e) => e.fn.max<number>("le.id").as("m"))
        .whereRef("le.repo", "=", "i.repo").whereRef("le.number", "=", "i.number").where((w) => notArchived(w, "le.kind"))))
    : joined().leftJoin(newestEvents.as("ne"), (j: any) => j.onRef("ne.repo", "=", "i.repo").onRef("ne.number", "=", "i.number")).leftJoin("main.workflow_events as ev", "ev.id", "ne.id")) as ReturnType<typeof joined>;
  const ITEM = ["kind", "state", "title", "author", "merged_at", "closed_at"] as const;
  const cols = (b: ReturnType<typeof base>) => b.select((eb: kx.Eb) => [
    "i.repo", "i.number", "i.updated_at", eb.ref("r.score").as("score"),
    "p.state as plan_state", "p.item_state as plan_item_state", kx.bytewise<string>(db, phaseOf(db, eb)).as("phase"),
    "w.weight as weight", "w.state as wf_state", eb.case().when("w.rec", "is", null).then(0).else(1).end().as("has_rec"), "w.started_by", "w.approved_by", "w.stopped_by", "ev.kind as last_event",
  ]);
  const where = <B extends { where: (...a: any[]) => any }>(b: B): B => b.where((eb: kx.AnyEb) => eb.and(conds(eb))) as B;
  // One text to partition by: the sort compares six columns for every pair otherwise.
  const place = (eb: any) => kx.bytewise<string>(db, PLACE.map((c) => (c === "has_rec" ? eb.case().when(`x.${c}`, "=", 1).then("y").else("n").end() : eb.fn.coalesce(`x.${c}`, eb.val("-")))).reduce((a, b) => eb(eb(a, "||", eb.val("|")), "||", b)));
  const keyed = () => q.k.selectFrom(where(cols(base())).as("x") as never).selectAll("x" as never).select((eb: any) => place(eb).as("place"));
  const first = () => (q.k.selectFrom(keyed().as("k") as never) as any).selectAll("k").select((eb: any) => [
    eb.fn.countAll().over((o: any) => o.partitionBy("k.place")).as("n"),
    // `rank`, not `row_number`: items that tie all come, and the caller orders them.
    eb.fn.agg("rank").over((o: any) => {
      const p = o.partitionBy("k.place");
      const b = f.sort === "updated" ? p : p.orderBy(eb.fn.coalesce("k.weight", eb.lit(f.normalWeight)), "desc").orderBy(eb.fn.coalesce("k.score", eb.lit(-1)), "desc");
      return b.orderBy(eb.fn.coalesce("k.updated_at", eb.val("")), "desc");
    }).as("place_rank"),
  ]);
  // The closed or merged items that match: the page is cut from their narrow rows before any is joined. The merged ones start from what AutoCraft merged.
  const ended = (): any => where(merged ? (q.k.selectFrom(mergedPrs(db, scope.repos).as("mg")) as any).innerJoin("main.items as i", (j: any) => j.onRef("i.repo", "=", "mg.repo").onRef("i.number", "=", "mg.number")) : q.k.selectFrom("main.items as i"));
  // A merge GitHub's copy does not show yet has the time of our merge step.
  const shown = ended().select((eb: any) => ["i.repo as repo", "i.number as number", ...(merged ? [eb.fn.coalesce("i.merged_at", "mg.at").as("at"), "mg.own as own_merge", "mg.approved as approved"] : [eb.fn.coalesce("i.updated_at", eb.val("")).as("at")])])
    .orderBy("at", "desc").orderBy("i.repo").orderBy("i.number", "desc").limit(f.limit);
  const [rows, total] = await db.together(() => Promise.all([
    closed
      ? q.all((cols(base()) as any).innerJoin(shown.as("sh"), (j: any) => j.onRef("sh.repo", "=", "i.repo").onRef("sh.number", "=", "i.number")).select(ITEM.map((c) => `i.${c}`))
        .$if(merged, (b: any) => b.select(["sh.at as merge_time", "sh.own_merge", "sh.approved"])).orderBy("sh.at", "desc").orderBy("i.repo").orderBy("i.number", "desc"))
      : q.all((q.k.selectFrom(first().as("y") as never) as any).innerJoin("main.items as i", (j: any) => j.onRef("i.repo", "=", "y.repo").onRef("i.number", "=", "y.number"))
        .selectAll("y").select(ITEM.map((c) => `i.${c}`)).where("y.place_rank", "<=", f.limit)),
    closed ? q.get(ended().select((eb: any) => eb.fn.countAll().as("n"))) : Promise.resolve(null),
  ]));
  const of = (r: Record<string, any>): ItemBase => ({
    repo: r.repo, number: Number(r.number), kind: r.kind === "pr" ? "pr" : "issue", title: r.title ?? "", author: r.author, state: r.state, updatedAt: r.updated_at ?? "",
    mergedAt: r.merged_at, closedAt: r.closed_at, planState: r.plan_state, itemState: r.plan_item_state, phase: r.phase, score: r.score === null ? null : Number(r.score),
    weight: r.weight === null ? null : Number(r.weight), workflowState: r.wf_state, hasRecommendation: Number(r.has_rec) === 1, startedBy: r.started_by, approvedBy: r.approved_by,
    stoppedBy: r.stopped_by, lastEvent: r.last_event,
    ...(merged && { merged: { at: r.merge_time ?? "", how: !Number(r.own_merge) ? "batch" as const : Number(r.approved) ? "approval" as const : "rule" as const } }),
  });
  const places = new Map<string, { item: ItemBase; count: number }>();
  if (!closed) for (const r of rows as Record<string, any>[]) {
    if (!places.has(r.place)) places.set(r.place, { item: of(r), count: Number(r.n) });
  }
  return { rows: (rows as Record<string, any>[]).map(of), places: [...places.values()], closedTotal: total ? Number((total as { n: number }).n) : null };
}

/** Plan views, holds, stuck marks, duplicate closes, areas and live workflows of the page's refs, in one wave. */
export async function loadItemRowFacts(db: Db, scope: Pick<Scope, "staff" | "login">, refs: { repo: string; number: number }[]): Promise<ItemRowFacts> {
  if (!refs.length) return { plans: new Map(), holds: new Map(), stuck: new Set(), duplicateGroups: new Map(), areas: new Map(), workflows: new Map(), permissions: new Map() };
  const keys = refs.map((r) => `${r.repo}#${r.number}`);
  const repos = [...new Set(refs.map((r) => r.repo))];
  const [plans, holds, stuck, dupes, areas, live, perms] = await db.together(() => Promise.all([
    planner.loadPlans(db, refs),
    intake.loadHoldStatus(db, refs),
    scope.staff ? planner.loadStuck(db, keys) : Promise.resolve(new Set<string>()),
    triage.loadDupeSignals(db, refs),
    triage.loadItemAreas(db, refs),
    workflow.listWorkflows(db, { live: true, refs }),
    scope.login ? access.loadPermissionsForRepos(db, scope.login, repos) : Promise.resolve(new Map()),
  ]));
  const wfs = new Map(live.map((w) => [`${w.repo}#${w.number}`, w]));
  const permissions = new Map([...perms].map(([repo, e]) => [repo, (e.permission === "admin" ? "admin" : e.permission === "read" || e.permission === "triage" ? "read" : "write") as "read" | "write" | "admin"]));
  return { plans, holds, stuck, duplicateGroups: dupes, areas, workflows: wfs, permissions };
}
