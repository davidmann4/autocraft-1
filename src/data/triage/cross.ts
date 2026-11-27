// reads: mirror.items, control.tracked_repos
// loadTriageFacts reads `items.embed_hash` for its per-item row; listEmbedDiff and pruneEmbeddings join the mirror and the tracked repos;
// the duplicate edge read joins pairs to items on the checked hashes.
// The statements below join the mirror's items or the tracked repos to a triage table in one statement, for correctness or to keep the
// payload small; the other modules' predicates come from their fragments.
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import * as control from "../control/fragments.ts";
import type { HiddenRepos } from "../control/types.ts";
import { notOwnIntegration } from "../merge/fragments.ts";
import { autoEligibleExpr, inScopeExpr, liveWorkflowIn, withLiveLinks } from "../workflow/fragments.ts";
import type { AreaDue, ClassifierPairRow, DupeEdge, DupeMember, EmbedDiffRow, EmbeddingMark, Pair, PairKey, SampleItem, StreamedEmbedding } from "./types.ts";


/** The per-item triage row of `loadTriageFacts`. A stored hash equal to the item's `embed_hash` comes back as '' (the common case sends no copy). */
export type ItemFactRow = {
  repo: string; number: number; embed_hash: string | null; score: number | null; impact: string | null;
  pr_hash: string | null; e_hash: string | null; scan_hash: string | null; jev_failed: string | null;
};

const sameAsText = (eb: kx.AnyEb, col: string) => eb.case().when(eb.ref(col), "=", eb.ref("i.embed_hash")).then(eb.val("")).else(eb.ref(col)).end();

/** Rank score, priority impact and hash, embedding hash for `model`, scan hash and Jev-failed hash (only at the item's current `class_hash`) of each tracked item of `keys`: one statement. */
export async function loadItemFactRows(db: Db, keys: KeySource, model: string): Promise<ItemFactRow[]> {
  if (Array.isArray(keys) && keys.length === 0) return [];
  const q = queryDb(db);
  return await q.all(q.k.selectFrom(resolveKeys(db, keys, "kk"))
    .innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "kk.repo").onRef("i.number", "=", "kk.number"))
    .innerJoin("main.tracked_repos as t", "t.name", "i.repo")
    .leftJoin("main.item_rank as r", (j) => j.onRef("r.repo", "=", "i.repo").onRef("r.number", "=", "i.number"))
    .leftJoin("main.item_priority as p", (j) => j.onRef("p.repo", "=", "i.repo").onRef("p.number", "=", "i.number"))
    .leftJoin("main.item_embeddings as e", (j) => j.onRef("e.repo", "=", "i.repo").onRef("e.number", "=", "i.number").on("e.model", "=", model))
    .leftJoin("main.duplicate_scans as s", (j) => j.onRef("s.repo", "=", "i.repo").onRef("s.number", "=", "i.number"))
    // A failure recorded at another input is no failure: the item changed since, and is asked again.
    .leftJoin("main.classify_state as c", (j) => j.onRef("c.repo", "=", "i.repo").onRef("c.number", "=", "i.number").on("c.kind", "=", "jev_failed").onRef("c.value", "=", "i.class_hash"))
    .select((eb) => ["i.repo", "i.number", "i.embed_hash", "r.score", "p.impact", sameAsText(eb, "p.text_hash").as("pr_hash"), sameAsText(eb, "e.hash").as("e_hash"),
      sameAsText(eb, "s.hash").as("scan_hash"), "c.value as jev_failed"])
    .orderBy("i.repo").orderBy("i.number"), { label: "triage.loadItemFactRows" }) as ItemFactRow[];
}


const kOf = (db: Db): any => queryDb(db).k;
const one = (eb: any) => eb.lit(1).as("one");
const onKey = (alias: string, a: string) => (j: any) => j.onRef(`${alias}.repo`, "=", `${a}.repo`).onRef(`${alias}.number`, "=", `${a}.number`);

// ---- areas ------------------------------------------------------------------------------------------------------------

/**
 * Open items of tracked repos with an area list that need an area answer: never asked, or asked against an older list version and
 * unassigned; with `rescan` also the ones answered "none of these" for the current version. Operator-assigned items are never due.
 * `refs` limits the items, `kind` the kind. Pipeline repos first, then the most recently updated.
 */
export async function areaDueRows(db: Db, o: { repo?: string; refs?: KeySource; rescan?: boolean; kind?: "pr" | "issue" }): Promise<AreaDue[]> {
  if (Array.isArray(o.refs) && !o.refs.length) return [];
  const q = queryDb(db), k = q.k as any;
  return await q.all(k.selectFrom("items as i").innerJoin("tracked_repos as t", "t.name", "i.repo")
    .innerJoin(k.selectFrom("area_lists").select(["repo", (eb: any) => eb.fn.max("version").as("v")]).groupBy("repo").as("l"), (j: any) => j.onRef("l.repo", "=", "i.repo"))
    .leftJoin("item_areas as a", (j: any) => j.onRef("a.repo", "=", "i.repo").onRef("a.number", "=", "i.number"))
    .$if(!!o.refs, (b: any) => b.innerJoin(resolveKeys(db, o.refs!, "kk"), onKey("kk", "i")))
    .select((eb: any) => ["i.repo", "i.number", "i.kind", eb.fn.coalesce("i.title", eb.val("")).as("title"), eb.fn.coalesce("i.body", eb.val("")).as("body"),
      eb("i.additions", "+", eb.ref("i.deletions")).as("lines_changed"), "i.changed_files as files_changed", "i.author_association", "i.head_oid as head", "l.v as version"])
    .where("i.state", "=", "OPEN")
    .where((eb: any) => notOwnIntegration(eb, "i.repo", "i.number")).where((eb: any) => inScopeExpr(db, eb, "i.repo", "i.number"))
    .$if(!!o.repo, (b: any) => b.where("i.repo", "=", o.repo!))
    .$if(!!o.kind, (b: any) => b.where("i.kind", "=", o.kind!))
    .where((eb: any) => eb.or([
      eb("a.number", "is", null),
      eb.and([eb("a.source", "<>", "operator"), eb.or([eb("a.list_version", "<>", eb.ref("l.v")), ...(o.rescan ? [eb("a.area", "is", null)] : [])])]),
    ]))
    .orderBy("t.pipeline", "desc").orderBy("i.updated_at", (ob: any) => ob.desc().nullsLast()).orderBy("i.repo").orderBy("i.number")) as AreaDue[];
}

/** Titles of the repo's open items, most recently updated first. */
export async function openTitleRows(db: Db, repo: string, limit: number): Promise<string[]> {
  const q = queryDb(db), k = q.k as any;
  return ((await q.all(k.selectFrom("items as i").select((eb: any) => eb.fn.coalesce("i.title", eb.val("")).as("title"))
    .where("i.repo", "=", repo).where("i.state", "=", "OPEN").where((eb: any) => notOwnIntegration(eb, "i.repo", "i.number"))
    .orderBy("i.updated_at", (o: any) => o.desc().nullsLast()).limit(limit))) as { title: string }[]).map((r) => r.title);
}

/** Open items the model answered "none of these" for under list `version` (not by an operator), most recently updated first. */
export async function unassignedSampleRows(db: Db, repo: string, version: number, limit: number): Promise<SampleItem[]> {
  const q = queryDb(db), k = q.k as any;
  return await q.all(k.selectFrom("items as i")
    .leftJoin("item_areas as a", (j: any) => j.onRef("a.repo", "=", "i.repo").onRef("a.number", "=", "i.number"))
    .select((eb: any) => ["i.repo", "i.number", eb.fn.coalesce("i.title", eb.val("")).as("title"), eb.fn.coalesce("i.body", eb.val("")).as("body")])
    .where("i.repo", "=", repo).where("i.state", "=", "OPEN").where((eb: any) => notOwnIntegration(eb, "i.repo", "i.number"))
    .where("a.area", "is", null).where("a.source", "<>", "operator").where("a.list_version", "=", version)
    .orderBy("i.updated_at", (o: any) => o.desc().nullsLast()).limit(limit)) as SampleItem[];
}

// ---- embeddings -------------------------------------------------------------------------------------------------------

const embedDiffQuery = (db: Db, all: boolean, model: string) => kOf(db).selectFrom("main.items as i")
  .leftJoin("main.item_embeddings as e", (j: any) => j.onRef("e.repo", "=", "i.repo").onRef("e.number", "=", "i.number"))
  .select(["i.repo", "i.number", "i.embed_hash as hash"])
  .where((eb: any) => eb("i.repo", "in", eb.selectFrom("main.tracked_repos").select("name")))
  .$if(!all, (b: any) => b.where((eb: any) => eb.and([
    eb("i.state", "<>", "OPEN"),
    eb.or([eb("e.model", "is distinct from", model), eb("e.hash", "is distinct from", eb.ref("i.embed_hash"))]),
  ])));

/** Tracked items whose vector is missing, from another model or at another hash and that are closed; every tracked item with `all`. */
export async function embedDiffRows(db: Db, model: string, all: boolean): Promise<EmbedDiffRow[]> {
  return await queryDb(db).all(embedDiffQuery(db, all, model)) as EmbedDiffRow[];
}

/** Whether a closed tracked item has a missing or stale vector. */
export async function embedDiffExists(db: Db, model: string): Promise<boolean> {
  return !!(await queryDb(db).get(embedDiffQuery(db, false, model).limit(1)));
}

/** Deletes the vectors of untracked repos and of items not in the mirror. */
export async function pruneEmbeddingRows(db: Db): Promise<number> {
  const k = kOf(db);
  return Number((await queryDb(db).run(k.deleteFrom("main.item_embeddings").where((eb: any) => eb.or([
    eb("main.item_embeddings.repo", "not in", eb.selectFrom("main.tracked_repos").select("name")),
    eb.not(eb.exists(eb.selectFrom("main.items as i").select(one(eb))
      .whereRef("i.repo", "=", "main.item_embeddings.repo").whereRef("i.number", "=", "main.item_embeddings.number"))),
  ])))).changes);
}

/** Row count, highest rowid and the tracked repo names (comma-joined) of one read. */
export async function embeddingMarkRow(db: Db): Promise<EmbeddingMark> {
  const q = queryDb(db), k = q.k as any;
  const s = (await q.get(k.selectNoFrom((eb: any) => [
    eb.selectFrom("main.item_embeddings").select(eb.fn.countAll().as("n")).as("n"),
    eb.selectFrom("main.item_embeddings").select(eb.fn.max(kx.rowid("main.item_embeddings")).as("m")).as("m"),
    eb.selectFrom("main.tracked_repos").select(kx.groupConcat(db, "name", ",", "name").as("t")).as("t"),
  ]))) as { n: number | string; m: number | string | null; t: string | null };
  return { rows: Number(s.n), maxRowid: s.m === null ? null : Number(s.m), tracked: s.t ?? "" };
}

/** One page of vectors of `model` of tracked repos with rowid above `after`, in rowid order. */
export async function embeddingPage(db: Db, model: string, after: number, limit: number): Promise<StreamedEmbedding[]> {
  const q = queryDb(db), k = q.k as any;
  const rows = await q.all(k.selectFrom("main.item_embeddings")
    .select([kx.rowid("main.item_embeddings").as("rid"), "repo", "number", "vec"])
    .where((eb: any) => eb.and([
      eb(kx.rowid("main.item_embeddings"), ">", after),
      eb("model", "=", model),
      eb("repo", "in", eb.selectFrom("main.tracked_repos").select("name")),
    ]))
    .orderBy(kx.rowid("main.item_embeddings")).limit(limit), { alone: true, label: "triage.streamEmbeddings" }) as StreamedEmbedding[];
  return rows.map((r) => ({ ...r, rid: Number(r.rid) }));
}

// ---- duplicates -------------------------------------------------------------------------------------------------------

type PairScope = { repo?: string; refs?: KeySource };

/**
 * Unchecked pairs whose items still have the hashed text and of which at least one is open, in the pipeline scope. Each item's state is a
 * scalar subquery keyed on (repo, number, embed_hash): Postgres cannot know that the item hash matches the pair's hash, so as a join it
 * estimated one row and planned the second item as a scan of the repo's items per pair; a scalar subquery is one index probe per pair and
 * side. The CTE is materialized so the scope filter applies to its rows, not to every pair.
 */
const uncheckedQuery = (db: Db, scope: PairScope) => kOf(db).with((cte: any) => cte("live").materialized(), (qb: any) => qb.selectFrom("duplicate_pairs as p")
  .select((eb: any) => ["p.repo", "p.a", "p.b", "p.a_hash", "p.b_hash", "p.similarity",
    eb.selectFrom("items as ia").select("ia.state").whereRef("ia.repo", "=", "p.repo").whereRef("ia.number", "=", "p.a").whereRef("ia.embed_hash", "=", "p.a_hash").as("a_state"),
    eb.selectFrom("items as ib").select("ib.state").whereRef("ib.repo", "=", "p.repo").whereRef("ib.number", "=", "p.b").whereRef("ib.embed_hash", "=", "p.b_hash").as("b_state")])
  .where("p.verdict", "is", null)
  .where("p.repo", "in", (eb: any) => eb.selectFrom("tracked_repos").select("name"))
  .$if(!!scope.repo, (b: any) => b.where("p.repo", "=", scope.repo!))
  .$if(!!scope.refs, (b: any) => b.where((eb: any) => eb.or(["a", "b"].map((side) =>
    eb.exists(eb.selectFrom(resolveKeys(db, scope.refs!, `k${side}`)).select(one(eb)).whereRef(`k${side}.repo`, "=", "p.repo").whereRef(`k${side}.number`, "=", `p.${side}`)))))))
  .selectFrom("live as p")
  .select(["p.repo", "p.a", "p.b", "p.a_hash", "p.b_hash", "p.similarity"])
  .where("p.a_state", "is not", null).where("p.b_state", "is not", null)
  .where((eb: any) => eb.or([eb("p.a_state", "=", "OPEN"), eb("p.b_state", "=", "OPEN")]))
  .where((eb: any) => eb.or([inScopeExpr(db, eb, "p.repo", "p.a"), inScopeExpr(db, eb, "p.repo", "p.b")]));

/** Unchecked pairs, most similar first; `limit` undefined means all. */
export async function uncheckedPairRows(db: Db, o: PairScope & { limit?: number }): Promise<PairKey[]> {
  if (Array.isArray(o.refs) && !o.refs.length) return [];
  return await queryDb(db).all(uncheckedQuery(db, o).orderBy("p.similarity", "desc").orderBy("p.repo").orderBy("p.a").orderBy("p.b")
    .$if(o.limit !== undefined, (b: any) => b.limit(o.limit!))) as Pair[];
}

/** The number of unchecked pairs each of `keys` is in. A pair found through one item also names its other one: only items of `keys` count. */
export async function uncheckedCountRows(db: Db, keys: KeySource): Promise<{ repo: string; number: number; n: number }[]> {
  if (Array.isArray(keys) && !keys.length) return [];
  const q = queryDb(db), k = q.k as any;
  const rows = await q.all(k.with("u", () => uncheckedQuery(db, { refs: keys }))
    .selectFrom((eb: any) => eb.selectFrom("u").select(["repo", "a as number"]).unionAll(eb.selectFrom("u").select(["repo", "b as number"])).as("m"))
    .innerJoin(resolveKeys(db, keys, "kk"), onKey("kk", "m"))
    .select((eb: any) => ["m.repo", "m.number", eb.fn.countAll().as("n")]).groupBy(["m.repo", "m.number"])) as { repo: string; number: number | string; n: number | string }[];
  return rows.map((r) => ({ repo: r.repo, number: Number(r.number), n: Number(r.n) }));
}

/** Verdict `duplicate` pairs not ruled by an operator whose items both still have the checked text. */
const edgeQuery = (db: Db, repo?: string) => kOf(db).selectFrom("duplicate_pairs as p")
  .innerJoin("items as ia", (j: any) => j.onRef("ia.repo", "=", "p.repo").onRef("ia.number", "=", "p.a").onRef("ia.embed_hash", "=", "p.a_hash"))
  .innerJoin("items as ib", (j: any) => j.onRef("ib.repo", "=", "p.repo").onRef("ib.number", "=", "p.b").onRef("ib.embed_hash", "=", "p.b_hash"))
  .select(["p.repo", "p.a", "p.b", "p.similarity", "p.jev_p", "p.haiku"])
  .where("p.verdict", "=", "duplicate").where("p.by_operator", "=", 0)
  .$if(!!repo, (b: any) => b.where("p.repo", "=", repo!));

/** Whether the item is on either side of an edge: one index probe per side. Scalar subqueries, since Postgres may answer an EXISTS by reading every edge and its items. */
export const onEdgeExpr = (db: Db, eb: any, repo: string, number: string) => eb.or((["p.a", "p.b"]).map((side) =>
  eb(edgeQuery(db).clearSelect().select((e: any) => e.lit(1).as("one")).whereRef("p.repo", "=", repo).whereRef(side, "=", number).limit(1), "is not", null)));

export async function dupeEdgeRows(db: Db, repo?: string): Promise<DupeEdge[]> {
  return await queryDb(db).all(edgeQuery(db, repo).orderBy("p.repo").orderBy("p.a").orderBy("p.b")) as DupeEdge[];
}

/**
 * The items on either side of an edge, in the same statement as the edge so the members need no second wave. `started` is the first half of
 * `inScopeExpr`: the materialized CTE computes it once, where a flattened subquery would plan its subqueries again for `in_scope`. It reads
 * the links from `live_links`, which the planner pass's workflow rows share in the same wave (withLiveLinks).
 */
export async function dupeMemberRows(db: Db, repo?: string): Promise<DupeMember[]> {
  const q = queryDb(db), k = q.k as any;
  const cols = ["repo", "number", "kind", "state", "title", "head_oid", "embed_hash", "comments_count", "additions", "deletions", "closing_issues", "state_reason"];
  const rows = await q.all(withLiveLinks(db, k).with("e", () => edgeQuery(db, repo))
    .with((cte: any) => cte("s").materialized(), () => k.selectFrom("items as i")
      .innerJoin(k.selectFrom("e").select(["e.repo", "e.a as number"]).union(k.selectFrom("e").select(["e.repo", "e.b as number"])).as("m"), onKey("m", "i"))
      .select((eb: any) => [...cols.map((c) => `i.${c}`), liveWorkflowIn(eb, "i.repo", "i.number").as("started")]))
    .selectFrom("s")
    .select((eb: any) => [...cols.map((c) => `s.${c}`), "s.started", eb.or([eb.ref("s.started"), autoEligibleExpr(eb, "s.repo", "s.number")]).as("in_scope"),
      eb.selectFrom("duplicate_pairs as rp").select(kx.groupConcat(db, "rp.b", ",", "rp.b").as("r"))
        .whereRef("rp.repo", "=", "s.repo").whereRef("rp.a", "=", "s.number").where("rp.by_operator", "=", 1).as("ruled")])
    .orderBy("s.repo").orderBy("s.number")) as (Omit<DupeMember, "in_scope" | "started"> & { in_scope: unknown; started: unknown })[];
  return rows.map((r) => ({ ...r, in_scope: !!r.in_scope, started: !!r.started }));
}

// ---- classifier report ------------------------------------------------------------------------------------------------

/** The items both classifiers `a` and `b` rated in `run`, with each item's kind. */
export async function classifierPairRows(db: Db, run: string, a: string, b: string, hidden: HiddenRepos): Promise<ClassifierPairRow[]> {
  const q = queryDb(db), k = q.k as any;
  return await q.all(k.selectFrom("classifications as x")
    .innerJoin("classifications as y", (j: any) => j.onRef("y.run_id", "=", "x.run_id").onRef("y.repo", "=", "x.repo").onRef("y.number", "=", "x.number").on("y.classifier", "=", b))
    .leftJoin("items as i", (j: any) => j.onRef("i.repo", "=", "x.repo").onRef("i.number", "=", "x.number"))
    .select(["x.repo", "i.kind", "x.type_label as ta", "y.type_label as tb", kx.jsonNum(db, "x.probs", "$.top").as("pa"), "x.flags as fa", "y.flags as fb"])
    .where("x.run_id", "=", run).where("x.classifier", "=", a).where(control.hiddenRepos(db, "x.repo", hidden))) as ClassifierPairRow[];
}
