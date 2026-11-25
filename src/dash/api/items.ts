// The Items browser (`GET /api/items`) and the top-bar search (`GET /api/search`),
// both over the full-text search of items and comments (src/db/search.ts).
import { canSeeInternals } from "./staff.ts";
import type { AliasableExpression, Compilable, Expression, JoinBuilder, OrderByItemBuilder, SelectQueryBuilder, SqlBool } from "kysely";
import type {
  ItemChecks, ItemPeek, ItemList, ItemListRow, ItemSort, SearchHit, SettledStatus, Snippet, Stage,
} from "../../../web/src/api/types.ts";
import { quietFixPrs, quietExprFor } from "../../security/quiet.ts";
import { fromRow, unflagged, latestRun, settledOnExpr, settledTable, type SettledRow } from "../../classify/settled.ts";
import { LABELS } from "../../classify/rules.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { itemState } from "./decisions.ts";
import { flowMembers } from "./flow.ts";
import { queueSlots } from "../../rank/position.ts";
import { excludeHiddenExpr, hiddenRepos, needVisible, visibleRepos } from "./visible.ts";
import { readerOf, statusFor, type Reader } from "./reader.ts";
import { toRow } from "./queue.ts";
import { prBuildView } from "../../prbuild/view.ts";
import type { PlanView } from "../../core/plan-cache.ts";
import type { CachedEntry } from "../../core/plan-read.ts";
import { statusFromItem } from "../../core/item-status.ts";
import { ITEM_PHASES, phaseExpr, type ItemPhase, type ItemStatus, type ItemStatusList, type ItemStatusRow } from "./home-types.ts";
import { mapSeq } from "../../async-seq.ts";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { parseSearch, type Search } from "../../db/search.ts";

// A condition of a query that names the items as `i`, built where its expression builder is at hand.
type Cond = (eb: kx.AnyEb) => Expression<SqlBool>;
type Q = SelectQueryBuilder<any, any, any>;

const restrict = <QB extends Q>(q: QB, conds: readonly Cond[]): QB => conds.reduce((acc, c) => acc.where(c) as QB, q);

// Rowids of the items matching the query in their title, body or any comment.
const hitRids = (db: Db, fts: Search) => db.k.selectFrom(kx.itemHits(db, fts, {}, "h")).select("h.rid")
  .union(db.k.selectFrom(kx.commentHits(db, fts, {}, "c"))
    .innerJoin("main.items as it", (j) => j.onRef("it.repo", "=", "c.repo").onRef("it.number", "=", "c.number"))
    .select(kx.rowid("main.items", "it").as("rid")));

// The same with the best score (lower is better): a title match weighs most,
// a comment match half as much as one in the body.
const hitsScored = (db: Db, fts: Search) => db.k.selectFrom(
  db.k.selectFrom(kx.itemHits(db, fts, { score: true }, "h")).select(["h.rid", "h.score"])
    .unionAll(db.k.selectFrom(kx.commentHits(db, fts, { score: true, weight: 0.5 }, "c"))
      .innerJoin("main.items as it", (j) => j.onRef("it.repo", "=", "c.repo").onRef("it.number", "=", "c.number"))
      .select([kx.rowid("main.items", "it").as("rid"), "c.score"]))
    .as("m"))
  .select(["m.rid", (eb) => eb.fn.min<number>("m.score").as("score")]).groupBy("m.rid");

export const textCond = (db: Db, fts: Search): Cond => (eb) => eb(kx.rowid("items", "i"), "in", hitRids(db, fts));

const STATUSES: SettledStatus[] = ["settled", "waiting", "disagree", "unclassified"];
const STATES: Record<string, string> = { open: "OPEN", closed: "CLOSED", merged: "MERGED" };
const SORTS: ItemSort[] = ["relevance", "updated", "created", "number", "merged", "discord"];
const BY_US = "merged-by-us";
// The newest merge AutoCraft made of the item (merges_item), else the time GitHub recorded for a batch member.
const mergedAtOf = (db: Db, eb: kx.AnyEb): AliasableExpression<string | null> => eb.fn.coalesce(
  db.k.selectFrom("main.merges as m").select((e) => e.fn.max<string | null>("m.at").as("at"))
    .where("m.repo", "=", kx.ref<string>("i.repo")).where("m.number", "=", kx.ref<number>("i.number")).where("m.outcome", "=", "merged"),
  eb.ref("i.merged_at"));
const mergedByUs = (db: Db, eb: kx.AnyEb): Expression<SqlBool> => eb.exists(db.k.selectFrom("main.merges as m").select(eb.lit(1).as("one"))
  .where("m.repo", "=", kx.ref<string>("i.repo")).where("m.number", "=", kx.ref<number>("i.number")).where("m.outcome", "=", "merged"));
const inMergedBatch = (db: Db, eb: kx.AnyEb): Expression<SqlBool> => eb.exists(db.k.selectFrom("main.merge_batch_prs as bp")
  .innerJoin("main.merge_batches as bb", "bb.id", "bp.batch_id").select(eb.lit(1).as("one"))
  .where("bp.number", "=", kx.ref<number>("i.number")).where("bb.repo", "=", kx.ref<string>("i.repo")).where("bb.state", "=", "merged"));
const mentioned = (db: Db, eb: kx.AnyEb): Expression<SqlBool> => eb.exists(db.k.selectFrom("main.discord_mentions as d").select(eb.lit(1).as("one"))
  .where("d.repo", "=", kx.ref<string>("i.repo")).where("d.number", "=", kx.ref<number>("i.number")));
const FLAGS = ["security", "needs decision"];
// `area=none` lists the items without an area: never asked, none of the list fitted, or unassigned by a removed area.
const NO_AREA = "none";
const areaOf = (db: Db) => db.k.selectFrom("main.item_areas as ia").where("ia.repo", "=", kx.ref<string>("i.repo")).where("ia.number", "=", kx.ref<number>("i.number"));
const areaCond = (db: Db, eb: kx.AnyEb, areas: string[]): Expression<SqlBool> => {
  const named = areas.filter((a) => a !== NO_AREA);
  return eb.or([
    ...(named.length ? [eb.exists(areaOf(db).select(eb.lit(1).as("one")).where(kx.inList(db, "ia.area", named)))] : []),
    ...(areas.includes(NO_AREA) ? [eb.not(eb.exists(areaOf(db).select(eb.lit(1).as("one")).where("ia.area", "is not", null)))] : []),
  ]);
};
const areaExpr = (db: Db) => areaOf(db).select("ia.area");

const list = (req: Req, key: string): string[] =>
  req.query.getAll(key).flatMap((v) => v.split(",")).map((s) => s.trim()).filter(Boolean);

type Built = { where: Cond[]; statusWhere: Cond | null; statuses: SettledStatus[]; fts: Search | null; byState: boolean; group: "area" | null };

async function build(db: Db, req: Req, hidden: string[]): Promise<Built & { sort: ItemSort; desc: boolean; run: string | null }> {
  const q = req.query;
  const mode = q.get("mode") ?? "text";
  if (mode !== "text") throw new HttpError(400, "mode must be text");
  const run = q.get("run") || await latestRun(db);
  const where: Cond[] = [];
  const fts = parseSearch(q.get("q") ?? "");
  const hide = excludeHiddenExpr(db, "i.repo", hidden);
  if (hide) where.push(() => hide);
  const repos = list(req, "repo");
  if (repos.length) where.push(() => kx.inList(db, "i.repo", repos));
  const kind = q.get("kind");
  if (kind) {
    if (kind !== "pr" && kind !== "issue") throw new HttpError(400, "kind must be pr or issue");
    where.push((eb) => eb("i.kind", "=", kind));
  }
  const state = q.get("state") ?? "open";
  let byState = false;
  if (state === BY_US) {
    where.push((eb) => eb("i.kind", "=", "pr"), (eb) => eb.or([mergedByUs(db, eb), inMergedBatch(db, eb)]));
  } else if (state !== "all") {
    if (!STATES[state]) throw new HttpError(400, "state must be open, closed, merged, merged-by-us or all");
    where.push((eb) => eb("i.state", "=", STATES[state]!));
    byState = true;
  }
  const label = q.get("label");
  if (label) {
    if (!(LABELS as readonly string[]).includes(label)) throw new HttpError(400, "unknown label");
    where.push((eb) => eb("s.label", "=", label));
  }
  list(req, "flag").forEach((f) => {
    if (!FLAGS.includes(f)) throw new HttpError(400, "flag must be security or needs decision");
    where.push(f === "security" ? (eb) => eb.and([eb("s.security", "=", 1), eb.not(quietExprFor(db, eb, "i.repo", "i.number"))]) : (eb) => eb("s.needs_decision", "=", 1));
  });
  const author = q.get("author")?.trim();
  if (author) where.push((eb) => kx.ciEq(db, "i.author", eb.val(author)));
  const since = q.get("since");
  if (since) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new HttpError(400, "since must be YYYY-MM-DD");
    where.push((eb) => eb("i.updated_at", ">=", since));
  }
  if (q.get("discord") === "1") where.push((eb) => mentioned(db, eb));
  const areas = list(req, "area");
  if (areas.length) where.push((eb) => areaCond(db, eb, areas));
  const group = q.get("group") || null;
  if (group && group !== "area") throw new HttpError(400, "group must be area");
  const flow = q.get("flow");
  if (flow) {
    const refs = await flowMembers(db, flow);
    if (!refs) throw new HttpError(400, "flow must name a flowchart branch with its own items");
    where.push(() => kx.refIn(db, "i", refs));
  }
  let statusWhere: Cond | null = null;
  const st = new Set(list(req, "status").flatMap((s) => (s === "unsettled" ? ["waiting", "disagree"] : [s])));
  if (st.size) {
    for (const s of st) if (!STATUSES.includes(s as SettledStatus)) throw new HttpError(400, "status must be settled, waiting, disagree, unsettled or unclassified");
    const named = [...st].filter((s) => s !== "unclassified");
    statusWhere = (eb) => eb.or([...(named.length ? [eb("s.status", "in", named)] : []), ...(st.has("unclassified") ? [eb("s.status", "is", null)] : [])]);
  }
  const sortQ = q.get("sort") as ItemSort | null;
  if (sortQ && !SORTS.includes(sortQ)) throw new HttpError(400, "sort must be relevance, updated, created, number, merged or discord");
  let sort: ItemSort = sortQ ?? (fts ? "relevance" : state === BY_US ? "merged" : "updated");
  if (sort === "relevance" && !fts) sort = "updated";
  const desc = q.get("desc") !== "0";
  // Last, after every parameter check (a no-op inside listItems' read, which refreshes the run first).
  await settledTable(db, run);
  return { where, statusWhere, statuses: [...st] as SettledStatus[], fts, byState, group: group as Built["group"], sort, desc, run };
}

// The sort term, then the ties by repo and newest number. A nullable term keeps SQLite's NULL order: first ascending, last descending.
// Grouped by area, the areas come first by name and the items without one last; the sort orders each group.
function pageOrder<QB extends Q>(db: Db, q: QB, sort: ItemSort, desc: boolean, group: Built["group"] = null): QB {
  const nulls = (o: OrderByItemBuilder) => (desc ? o.desc().nullsLast() : o.asc().nullsFirst());
  let r: Q = group === "area" ? q.orderBy(() => areaExpr(db), (o) => o.asc().nullsLast()) : q;
  if (sort === "relevance") r = r.orderBy("h.score", desc ? "asc" : "desc");  // bm25 is lower for better matches, so "most relevant first" sorts it ascending.
  else if (sort === "updated") r = r.orderBy("i.updated_at", nulls);
  else if (sort === "created") r = r.orderBy("i.created_at", nulls);
  else if (sort === "number") r = r.orderBy("i.number", desc ? "desc" : "asc");
  else if (sort === "merged") r = r.orderBy((eb: kx.AnyEb) => mergedAtOf(db, eb), nulls);
  else r = r.orderBy((eb: kx.AnyEb) => eb.selectFrom("main.discord_mentions as d").select((e) => e.fn.countAll<number>().as("n"))
    .where("d.repo", "=", kx.ref<string>("i.repo")).where("d.number", "=", kx.ref<number>("i.number")), desc ? "desc" : "asc");
  return r.orderBy("i.repo").orderBy("i.number", "desc") as QB;
}

type Row = SettledRow & {
  rid: number; repo: string; number: number; kind: string; state: string; title: string | null; author: string | null;
  created_at: string | null; updated_at: string | null; comments_count: number | null; merged_by_us_at?: string | null;
};

const OPEN = "\u0002", CLOSE = "\u0003";

async function snippets(db: Db, fts: Search, rows: Row[]): Promise<Map<number, Snippet>> {
  const out = new Map<number, Snippet>();
  if (!rows.length) return out;
  const marks = { open: OPEN, close: CLOSE, words: 24 };
  const own = await db.all(db.k.selectFrom(kx.itemHits(db, fts, { snippets: marks }, "h"))
    .select(["h.rid", "h.title_snippet", "h.body_snippet"]).where(kx.inList(db, "h.rid", rows.map((r) => r.rid), "bigint")));
  for (const r of own) {
    if (r.body_snippet?.includes(OPEN)) out.set(r.rid, { field: "body", author: null, text: r.body_snippet });
    else if (r.title_snippet?.includes(OPEN)) out.set(r.rid, { field: "title", author: null, text: r.title_snippet });
  }
  const rest = rows.filter((r) => !out.has(r.rid));
  if (!rest.length) return out;
  const cm = await db.all(db.k.selectFrom(kx.commentHits(db, fts, { score: true, snippet: marks }, "c"))
    .select(["c.repo", "c.number", "c.author", "c.snippet"]).where(kx.refIn(db, "c", rest.map((r) => [r.repo, r.number] as const))).orderBy("c.score"));
  const byRef = new Map(rest.map((r) => [`${r.repo}#${r.number}`, r.rid]));
  for (const c of cm) {
    const rid = byRef.get(`${c.repo}#${c.number}`);
    if (rid !== undefined && !out.has(rid)) out.set(rid, { field: "comment", author: c.author, text: c.snippet ?? "" });
  }
  return out;
}

// Status counts cost a scan of every matching item, so they are kept per filter
// until a sync, a classification or a tracked-repo change, or for COUNTS_TTL at most.
const COUNTS_TTL = 45_000;
const COUNTS_MAX = 100;
const countsCache = new WeakMap<Db, { sig: string; at: number; byKey: Map<string, Record<SettledStatus, number>> }>();

async function statusCounts(db: Db, b: Built & { run: string | null }, query: Compilable<{ status: string | null; n: number }>, flow: string | null): Promise<Record<SettledStatus, number>> {
  const sig = JSON.stringify(await db.get(db.k.selectNoFrom((eb) => [
    eb.selectFrom("main.settings").select("value").where("key", "=", "org_high_water").as("hw"),
    eb.selectFrom("main.classifications").select((e) => e.fn.max<number | null>(kx.rowid("main.classifications")).as("m")).as("cl"),
    eb.selectFrom("main.tracked_repos").select(kx.groupConcat(db, "name", ",", "name").as("g")).as("tr"),
    eb.selectFrom("main.change_seq").select("seq").where("topic", "=", "discord").as("dm"),
  ])));
  const now = Date.now();
  let c = countsCache.get(db);
  if (!c || c.sig !== sig || now - c.at >= COUNTS_TTL) {
    c = { sig, at: now, byKey: new Map() };
    countsCache.set(db, c);
  }
  const compiled = query.compile();
  const key = JSON.stringify([compiled.sql, compiled.parameters, b.run, flow]);
  const hit = c.byKey.get(key);
  if (hit) return { ...hit };
  const counts = await db.all(query);
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<SettledStatus, number>;
  for (const r of counts) byStatus[(r.status ?? "unclassified") as SettledStatus] += r.n;
  if (c.byKey.size >= COUNTS_MAX) c.byKey.clear();
  c.byKey.set(key, byStatus);
  return { ...byStatus };
}

export async function listItems(db: Db, req: Req): Promise<ItemList> {
  const hidden = await hiddenRepos(db, req);
  // The counts and the page join item_settled inside the read below, where it is not refreshed: the run's rows, and for
  // a flow filter the current run's (the flowchart counts in it), are brought up to date first.
  const latest = await latestRun(db);
  const run = req.query.get("run") || latest;
  await settledTable(db, run);
  if (req.query.get("flow") && run !== latest) await settledTable(db, latest);
  // All of it runs in one snapshot.
  const { b, total, byStatus, rows, byArea } = await db.read(async () => {
    const b = await build(db, req, hidden);
    const limit = Math.min(100, Math.max(1, Number(req.query.get("limit")) || 50));
    const offset = Math.max(0, Number(req.query.get("offset")) || 0);
    const settledJoin = (j: JoinBuilder<any, any>) => j.on((eb: kx.AnyEb) => settledOnExpr(eb, b.run, "s"));
    const text = b.fts ? [textCond(db, b.fts)] : [];

    // Counts per status under every filter but the status one; the total follows from them.
    const byStatus = await statusCounts(db, b, restrict(db.k.selectFrom("items as i").leftJoin("item_settled as s", settledJoin)
      .select(["s.status", (eb) => eb.fn.countAll<number>().as("n")]).groupBy("s.status"), [...b.where, ...text]), req.query.get("flow"));
    const total = (b.statuses.length ? b.statuses : STATUSES).reduce((a, s) => a + byStatus[s], 0);

    // The page as rowids first, so only its rows are read in full.
    const where = [...b.where, ...(b.statusWhere ? [b.statusWhere] : [])];
    // Newest first within a state: main.items with its index named, because through the scoping view the planner walks the repo index and sorts every open item.
    const byUpdated = !b.fts && b.sort === "updated" && b.byState && !b.group;
    const rid = kx.rowid("items", "i").as("rid");
    const idsQuery: Compilable<{ rid: number }> = b.fts && b.sort === "relevance"
      ? pageOrder(db, restrict(db.k.selectFrom(hitsScored(db, b.fts).as("h")).innerJoin("items as i", (j) => j.on(kx.rowid("items", "i"), "=", (eb) => eb.ref("h.rid")))
        .leftJoin("item_settled as s", settledJoin).select(rid), where), b.sort, b.desc, b.group).limit(limit).offset(offset)
      : byUpdated
        ? pageOrder(db, restrict(db.k.selectFrom(kx.indexedBy(db, "main.items", "items_state_updated", "i")).leftJoin("item_settled as s", settledJoin).select(rid)
          .where("i.repo", "in", (eb) => eb.selectFrom("main.tracked_repos").select("name")), where), b.sort, b.desc, b.group).limit(limit).offset(offset)
        : pageOrder(db, restrict(db.k.selectFrom("items as i").leftJoin("item_settled as s", settledJoin).select(rid), [...where, ...text]), b.sort, b.desc, b.group).limit(limit).offset(offset);
    const ids = (await db.all(idsQuery)).map((r) => r.rid);
    const byId = new Map((ids.length ? await db.all(db.k.selectFrom("items as i").leftJoin("item_settled as s", settledJoin)
      .select([rid, "i.repo", "i.number", "i.kind", "i.state", "i.title", "i.author", "i.created_at", "i.updated_at", "i.comments_count", "s.status", "s.label", "s.source", "s.top",
        "s.jev_label", "s.haiku_label", "s.flags", "s.referee_label", "s.referee_sure", "s.referee_reason", (eb) => mergedAtOf(db, eb).as("merged_by_us_at")])
      .where(kx.inList(db, kx.rowid("items", "i"), ids, "bigint"))) : [])
      .map((r): [number, Row] => [r.rid, r]));
    const rows = ids.map((id) => byId.get(id)).filter((r): r is Row => !!r);
    // Grouped, each group's heading counts its items under every filter.
    const byArea = b.group === "area"
      ? (await db.all(restrict(db.k.selectFrom("items as i").leftJoin("item_settled as s", settledJoin)
        .leftJoin("main.item_areas as ia", (j) => j.onRef("ia.repo", "=", "i.repo").onRef("ia.number", "=", "i.number"))
        .select(["ia.area", (eb) => eb.fn.countAll<number>().as("n")]).groupBy("ia.area"), [...where, ...text])))
        .map((r) => ({ area: r.area ?? null, items: Number(r.n) }))
      : undefined;
    return { b, total, byStatus, rows, byArea };
  });

  const stages = await stagesOf(db, rows);
  const snips = b.fts ? await snippets(db, b.fts, rows) : new Map<number, Snippet>();
  const how = await mergedHow(db, rows);
  const mentions = await discordCounts(db, rows);
  const areas = await areasOf(db, rows);
  const quiet = await quietFixPrs(db);
  const slots = await queueSlots(db, await visibleRepos(db, req));
  return {
    total, byStatus, run: b.run, ...(byArea ? { byArea } : {}),
    rows: rows.map((r): ItemListRow => ({
      repo: r.repo, number: r.number, kind: r.kind === "pr" ? "pr" : "issue", state: itemState(r.state),
      title: r.title ?? "", author: r.author ?? "", createdAt: r.created_at ?? "", updatedAt: r.updated_at ?? "",
      comments: r.comments_count ?? 0, discord: mentions.get(`${r.repo}#${r.number}`) ?? 0, settled: unflagged(fromRow(r), quiet.has(`${r.repo}#${r.number}`), canSeeInternals(req)) as ItemListRow["settled"],
      stage: (stages.get(`${r.repo}#${r.number}`) ?? null) as Stage | null, snippet: snips.get(r.rid) ?? null,
      queue: slots.get(`${r.repo}#${r.number}`) ?? null, area: areas.get(`${r.repo}#${r.number}`) ?? null,
      mergedHow: how.get(`${r.repo}#${r.number}`) ?? null, mergedAt: how.has(`${r.repo}#${r.number}`) ? r.merged_by_us_at ?? null : null,
    })),
  };
}

async function discordCounts(db: Db, rows: { repo: string; number: number }[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!rows.length) return out;
  for (const m of await db.all(db.k.selectFrom("main.discord_mentions as d").select(["d.repo", "d.number", (eb) => eb.fn.countAll<number>().as("n")])
    .where(kx.refIn(db, "d", rows.map((r) => [r.repo, r.number] as const))).groupBy(["d.repo", "d.number"]))) out.set(`${m.repo}#${m.number}`, m.n);
  return out;
}

async function areasOf(db: Db, rows: { repo: string; number: number }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!rows.length) return out;
  for (const a of await db.all(db.k.selectFrom("main.item_areas as a").select(["a.repo", "a.number", "a.area"])
    .where(kx.refIn(db, "a", rows.map((r) => [r.repo, r.number] as const))).where("a.area", "is not", null))) out.set(`${a.repo}#${a.number}`, a.area!);
  return out;
}

// How AutoCraft merged each listed PR: its merge step's path (rule or operator), or batch when only a merged batch carried it.
async function mergedHow(db: Db, rows: { repo: string; number: number; kind: string }[]): Promise<Map<string, "rule" | "operator" | "batch">> {
  const out = new Map<string, "rule" | "operator" | "batch">();
  const prs = rows.filter((r) => r.kind === "pr");
  if (!prs.length) return out;
  const refs = prs.map((r) => [r.repo, r.number] as const);
  for (const m of await db.all(db.k.selectFrom("main.merges as m").select(["m.repo", "m.number", "m.path"]).where("m.outcome", "=", "merged").where(kx.refIn(db, "m", refs)).orderBy("m.at")))
    out.set(`${m.repo}#${m.number}`, m.path === "operator" ? "operator" : "rule");
  for (const b of await db.all(db.k.selectFrom("main.merge_batch_prs as bp").innerJoin("main.merge_batches as bb", "bb.id", "bp.batch_id")
    .innerJoin(kx.refPairs(db, refs, "rp"), (j) => j.onRef("rp.repo", "=", "bb.repo").onRef("rp.number", "=", "bp.number"))
    .select(["bb.repo", "bp.number"]).distinct().where("bb.state", "=", "merged")))
    if (!out.has(`${b.repo}#${b.number}`)) out.set(`${b.repo}#${b.number}`, "batch");
  return out;
}

// Latest stage of each listed item.
async function stagesOf(db: Db, rows: { repo: string; number: number }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!rows.length) return out;
  const got = await db.all(db.k.selectFrom("main.item_stage as st").select(["st.repo", "st.number", "st.stage"]).where(kx.refIn(db, "st", rows.map((r) => [r.repo, r.number] as const))));
  for (const g of got) out.set(`${g.repo}#${g.number}`, g.stage);
  return out;
}

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Top-bar search: `repo#n`, `#n` and bare numbers jump by number; a word may be an author's login; text goes through the full-text index. */
type Hit = { repo: string; number: number; kind: string; title: string | null; author: string | null; state: string };
const hitOf = (r: Hit): SearchHit => ({ repo: r.repo, number: r.number, kind: r.kind === "pr" ? "pr" : "issue", title: r.title ?? "", author: r.author ?? "", state: itemState(r.state) });

export async function quickSearch(db: Db, req: Req): Promise<SearchHit[]> {
  const q = (req.query.get("q") ?? "").trim().slice(0, 200);
  if (!q) return [];
  const ref = /^([A-Za-z0-9._-]+)?#(\d{1,9})$/.exec(q) ?? /^()(\d{1,9})$/.exec(q);
  const hidden = await hiddenRepos(db, req);
  const hide = excludeHiddenExpr(db, "repo", hidden);
  let rows: Hit[];
  if (ref) {
    const where: Cond[] = [(eb) => kx.like(db, eb.cast<string>("number", "text"), eb.val(`${ref[2]}%`))];
    if (hide) where.push(() => hide);
    if (ref[1]) where.push((eb) => kx.like(db, "repo", eb.val(`${likeEscape(ref[1]!)}%`), "\\"));
    rows = await db.all(restrict(db.k.selectFrom("items").select(["repo", "number", "kind", "title", "author", "state"]), where)
      .orderBy((eb) => eb.fn<number>("length", [eb.cast<string>("number", "text")])).orderBy("repo").orderBy("number").limit(20));
  } else {
    rows = [];
    // A single word may be a login: that author's latest items first.
    if (/^[A-Za-z0-9-]{2,39}$/.test(q)) {
      // main.items with the index named: through the scoping view the planner picks the repo index.
      rows = await db.all(db.k.selectFrom(kx.indexedBy(db, "main.items", "items_author_nocase", "a")).select(["repo", "number", "kind", "title", "author", "state"])
        .where((eb) => kx.like(db, "author", eb.val(`${q}%`))).where("repo", "in", (eb) => eb.selectFrom("main.tracked_repos").select("name"))
        .$if(!!hide, (qb) => qb.where(hide!))
        .orderBy((eb) => eb("state", "<>", "OPEN")).orderBy("updated_at", (o) => o.desc().nullsLast()).limit(5));
    }
    const fts = parseSearch(q, true);
    if (!fts) return rows.map(hitOf);
    const have = new Set(rows.map((r) => `${r.repo}#${r.number}`));
    // The newest 100 matches by title, then by body when titles give too few, open ones first.
    // Ordered by rowid, where the search can stop early; ranking every match is too slow for common words.
    const hideItems = excludeHiddenExpr(db, "i.repo", hidden);
    const look = (titleOnly: boolean) => db.all(db.k
      .with("hits", (qb) => qb.selectFrom(kx.itemHits(db, fts, { titleOnly }, "x")).select("x.rid").orderBy("x.rid", "desc").limit(100))
      .selectFrom("hits as h").innerJoin("items as i", (j) => j.on(kx.rowid("items", "i"), "=", (eb) => eb.ref("h.rid")))
      .select(["i.repo", "i.number", "i.kind", "i.title", "i.author", "i.state"])
      .$if(!!hideItems, (qb) => qb.where(hideItems!))
      .orderBy((eb) => eb("i.state", "<>", "OPEN")).orderBy("i.updated_at", (o) => o.desc().nullsLast()).limit(20));
    let text: Hit[] = await look(true);
    if (text.length < 20) {
      const seenT = new Set(text.map((r) => `${r.repo}#${r.number}`));
      text = [...text, ...(await look(false)).filter((r) => !seenT.has(`${r.repo}#${r.number}`))];
    }
    rows = [...rows, ...text.filter((r) => !have.has(`${r.repo}#${r.number}`))].slice(0, 20);
  }
  return rows.map(hitOf);
}

// ---- the Items status list ----------------------------------------------------

type StatusRowRaw = { repo: string; number: number; kind: string; state: string; title: string | null; author: string | null; updated_at: string | null; merged_at: string | null; closed_at: string | null; view: string | null; plan_state: string | null; reasons: string | null; closing_issues: string | null };

/** The issue numbers in an item's stored closing list; a malformed list counts as none. */
export function closesOf(json: string | null): number[] {
  if (!json) return [];
  try { return (JSON.parse(json) as unknown[]).filter((x): x is number => typeof x === "number"); } catch { return []; }
}

/** The merge queue's checks for a PR the plan holds a queue view for, with the same veiling as the queue (toRow); null otherwise. */
async function checksOf(db: Db, r: StatusRowRaw, view: PlanView | undefined, reader: Reader, internals: boolean): Promise<ItemChecks | null> {
  if (!view?.queue || !r.plan_state) return null;
  let outsideRule: string[] = [];
  try { outsideRule = JSON.parse(r.reasons ?? "[]") as string[]; } catch { /* none */ }
  const q = toRow({ ...view.queue, repo: r.repo, number: r.number, title: r.title ?? "", state: r.plan_state as CachedEntry["state"], outsideRule, note: null, gh: view.gh ?? "OPEN" }, reader);
  return { verdict: q.verdict, ci: q.ci, mergeable: q.mergeable, verify: q.verify, size: q.size, prBuild: await prBuildView(db, r.repo, r.number, q.head, internals) };
}

/** `GET /api/items/status`: every item with its status line, newest update first. Filters: q, repo, kind (as /api/items), phase, discord=1 (mentioned in a watched Discord channel, asked about or not), cursor, limit. `byPhase` and `total` count every match except the phase filter. */
export async function statusList(db: Db, req: Req): Promise<ItemStatusList> {
  const phase = req.query.get("phase");
  if (phase && !(ITEM_PHASES as readonly string[]).includes(phase)) throw new HttpError(400, "unknown phase");
  const only = new URLSearchParams();
  for (const k of ["q", "kind"]) if (req.query.get(k)) only.set(k, req.query.get(k)!);
  for (const r of list(req, "repo")) only.append("repo", r);
  for (const a of list(req, "area")) only.append("area", a);
  only.set("state", "all");
  const reader = await readerOf(db, req);
  const b = await build(db, { ...req, query: only }, reader.hidden);
  const internals = canSeeInternals(req);
  const limit = Math.min(100, Math.max(1, Number(req.query.get("limit")) || 50));
  const items = () => db.k.selectFrom("items as i").leftJoin("main.item_plans as p", (j) => j.onRef("p.repo", "=", "i.repo").onRef("p.number", "=", "i.number"));
  // Items mentioned on Discord (display only; src/discord/store.ts).
  const base: Cond[] = [...b.where, ...(b.fts ? [textCond(db, b.fts)] : []), ...(req.query.get("discord") === "1" ? [(eb: kx.AnyEb) => mentioned(db, eb)] : [])];

  const byPhase = Object.fromEntries(ITEM_PHASES.map((x) => [x, 0])) as Record<ItemPhase, number>;
  for (const r of await db.all(restrict(items().select([(eb) => phaseExpr(db, eb).as("phase"), (eb) => eb.fn.countAll<number>().as("n")]).groupBy("phase"), base)))
    if (r.phase in byPhase) byPhase[r.phase] += r.n;
  const total = ITEM_PHASES.reduce((a, x) => a + byPhase[x], 0);

  const where = [...base];
  if (phase) where.push((eb) => eb(phaseExpr(db, eb), "=", phase as ItemPhase));
  const cursor = req.query.get("cursor");
  if (cursor) {
    const m = /^(.*)\|(.+)\|(\d+)$/.exec(cursor);
    if (!m) throw new HttpError(400, "bad cursor");
    const [cu, cr, cn] = [m[1]!, m[2]!, Number(m[3])];
    where.push((eb) => {
      const updated = eb.fn.coalesce("i.updated_at", eb.val(""));
      return eb.or([eb(updated, "<", cu), eb.and([eb(updated, "=", cu), eb.or([eb("i.repo", ">", cr), eb.and([eb("i.repo", "=", cr), eb("i.number", "<", cn)])])])]);
    });
  }
  const got = await db.all(restrict(items().select(["i.repo", "i.number", "i.kind", "i.state", "i.title", "i.author", "i.updated_at", "i.merged_at", "i.closed_at", "p.view", "p.state as plan_state", "p.reasons", "i.closing_issues"]), where)
    .orderBy((eb) => eb.fn.coalesce("i.updated_at", eb.val("")), "desc").orderBy("i.repo").orderBy("i.number", "desc").limit(limit + 1));
  const page = got.slice(0, limit);
  const last = page[page.length - 1];
  return {
    total, byPhase,
    rows: await mapSeq(page, async (r): Promise<ItemStatusRow> => {
      let view: PlanView | undefined;
      try { view = r.view ? (JSON.parse(r.view) as PlanView) : undefined; } catch { /* a malformed view counts as none */ }
      const status = view?.status;
      return {
        repo: r.repo, number: r.number, kind: r.kind === "pr" ? "pr" : "issue", state: itemState(r.state), title: r.title ?? "", author: r.author ?? null,
        status: status ? statusFor(reader, r.repo, r.number, status) : statusFromItem(r, r.updated_at ?? ""), updatedAt: r.updated_at ?? "",
        closes: r.kind === "pr" ? closesOf(r.closing_issues) : [], checks: r.kind === "pr" ? await checksOf(db, r, view, reader, internals) : null,
      };
    }),
    nextCursor: got.length > limit && last ? `${last.updated_at ?? ""}|${last.repo}|${last.number}` : null,
  };
}

/** `GET /api/items/:repo/:n/peek`: the item in brief for the hover card on its number; the status text is veiled as in the lists. */
export async function peek(db: Db, req: Req): Promise<ItemPeek> {
  const repo = req.params.repo!;
  const n = Number(req.params.n);
  if (!Number.isInteger(n)) throw new HttpError(400, "not an item number");
  await needVisible(db, req, repo);
  const r = await db.get(db.k.selectFrom("items as i").leftJoin("main.item_plans as p", (j) => j.onRef("p.repo", "=", "i.repo").onRef("p.number", "=", "i.number"))
    .select(["i.repo", "i.number", "i.kind", "i.state", "i.title", "i.author", "i.labels", "i.created_at", "i.updated_at", "i.merged_at", "i.closed_at", "i.closing_issues", "p.view"])
    .where("i.repo", "=", repo).where("i.number", "=", n));
  if (!r) throw new HttpError(404, `no item ${repo}#${n} in the mirror`);
  const reader = await readerOf(db, req);
  let status: ItemStatus | undefined;
  try { status = r.view ? (JSON.parse(r.view) as PlanView).status : undefined; } catch { /* a malformed view counts as none */ }
  let labels: string[] = [];
  try { labels = (JSON.parse(r.labels ?? "[]") as unknown[]).filter((x): x is string => typeof x === "string"); } catch { /* none */ }
  return {
    repo: r.repo, number: r.number, kind: r.kind === "pr" ? "pr" : "issue", state: itemState(r.state), title: r.title ?? "", author: r.author ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at, labels,
    status: status ? statusFor(reader, r.repo, r.number, status) : statusFromItem(r, r.updated_at ?? ""),
    closes: r.kind === "pr" ? closesOf(r.closing_issues) : [],
  };
}
