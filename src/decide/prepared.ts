// When an open decision counts as prepared. Only items in scope (pipeline on for the repo, not our own integration PR) are prepared.
import { pilotExpr } from "../pilot.ts";
import { notOwnIntegrationExpr } from "../dupes/held.ts";
import { OWN_NOTE_PREFIXES } from "../conversations/store.ts";
import { RECOMMEND_MAX_FAILURES, RECOMMEND_RETRY_MS } from "../core/item-rules.ts";
import type { Db } from "../db/index.ts";
import { distinctFrom, inList, jsonEach, jsonText, jsonValid, like, notDistinctFrom } from "../db/portable.ts";
import * as kx from "../db/kx.ts";
import type { AliasableExpression, Expression, SqlBool } from "kysely";

/** The columns of a decision that say what its prepare step did. */
export type PrepareColumns = {
  prepared_at: string | null; prepared_head: string | null;
  recommend_failures: number | null; recommend_failed_at: string | null; prepare_failed_head: string | null;
  /** Without `kind` a prepare is tied to the head, as a Merge? decision's is. */
  kind?: string; id?: string;
  /** The newest counted comment now (`discussionKeySql`), and the one the prepare read ('' none; null: prepared before this was stored, taken as unchanged). */
  discussion_key?: string | null; prepared_discussion?: string | null;
  /** When the newest Opus review at the item's current head was stored (`reviewedAtSql`). */
  reviewed_at?: string | null;
  /** JSON {d: drafts, a: added cores} of the current choices when they were written for another head than the PR's current one (`staleChoicesSql`), else null. */
  stale_choices?: string | null;
  /** Set by an operator's Re-prepare; such a prepare is exempt from the daily cap. */
  prepare_requested_at?: string | null;
  /** Automatic prepares of this decision since UTC midnight (`preparesTodaySql`). */
  prepares_today?: number;
  /** 1 when the item's Plan holds a review or carry action at the PR's current head (`reviewQueuedSql`): a review is about to start. */
  review_queued?: number;
};

/** Automatic prepares per decision per UTC day; an operator's Re-prepare is exempt. */
export const PREPARE_DAILY_CAP = 3;

/** A new comment re-prepares a decision only while it has fewer automatic prepares than this today: a first prepare and one re-prepare for the discussion. Later comments wait for a new head, a new review or an operator's Re-prepare. */
export const DISCUSSION_PREPARES_PER_DAY = 2;

/** The item's Plan holds a review or carry action for the PR's current head, so a review starts soon. A review that is stale but held (daily cap, CI, a blocking item, paused) has no such action. Alias `d`: a decision row. */
export const reviewQueuedSql = (db: Db, d: string): string => `EXISTS (SELECT 1 FROM item_plans qp JOIN items qi ON qi.repo = qp.repo AND qi.number = qp.number, ${jsonEach(db, `CASE WHEN ${jsonValid(db, "qp.actions")} THEN qp.actions ELSE '[]' END`, "qa")}
  WHERE qp.repo = ${d}.repo AND qp.number = ${d}.number AND ${jsonText(db, "qa.value", "$.kind")} IN ('review', 'carry') AND ${notDistinctFrom(db, jsonText(db, "qa.value", "$.head"), "qi.head_oid")})`;

/** The newest comment the item's discussion counts (src/review/discussion.ts isCounted, stored as `comments.counted`), without our own posts (app accounts, note lines). Alias `d`: a decision row. */
export const discussionKeySql = (db: Db, d: string): string => `(SELECT c.id FROM comments c WHERE c.repo = ${d}.repo AND c.number = ${d}.number AND c.counted = 1
  AND ${inList(db, "COALESCE(c.author, '')", `CASE WHEN ${jsonValid(db, APP_SLUGS)} THEN ${APP_SLUGS} ELSE '[]' END`, "text", true)}
  AND NOT (${OWN_NOTE_PREFIXES.map((x) => like(db, "ltrim(COALESCE(c.body, ''))", `'${x.replace(/_/g, "\\_")}%'`, "\\")).join(" OR ")})
  ORDER BY c.created_at DESC, c.id DESC LIMIT 1)`;

const APP_SLUGS = "(SELECT value FROM main.settings WHERE key = 'app_slugs')";

/** When the newest finished Opus review at the item's current head was stored. */
export const reviewedAtSql = (_db: Db, d: string): string => `(SELECT max(r.at) FROM opus_reviews r JOIN items ri ON ri.repo = r.repo AND ri.number = r.number AND ri.head_oid = r.head_oid
  WHERE r.repo = ${d}.repo AND r.number = ${d}.number AND r.verdict IS NOT NULL)`;

/** The current choices of decision alias `d` when they were written for another PR head than the item's current one. */
export const staleChoicesSql = (db: Db, d: string): string => `(SELECT ${db.dialect === "postgres" ? "json_build_object('d', c.drafts::json, 'a', c.added::json)::text" : "json_object('d', json(c.drafts), 'a', json(c.added))"} FROM decision_choices c JOIN items si ON si.repo = c.repo AND si.number = c.number
  WHERE c.decision_id = ${d}.id AND c.state = 'current' AND si.kind = 'pr' AND ${distinctFrom(db, jsonText(db, "c.seen", "$.head"), "si.head_oid")} LIMIT 1)`;

/** Whether choices (the `stale_choices` JSON) hold a core whose effect rests on the code: a push, a drafted comment or issue, or a model-written reason. */
export function choicesDependOnCode(json: string | null | undefined): boolean {
  if (!json) return false;
  let v: { d?: Record<string, { params?: { reason?: string; instructions?: string }; extras?: { kind?: string }[] }>; a?: string[] };
  try { v = JSON.parse(json); } catch { return false; }
  const keys = [...Object.keys(v.d ?? {}), ...(v.a ?? [])];
  if (keys.some((k) => k === "x:fixup" || k === "fixup-merge")) return true;
  return Object.values(v.d ?? {}).some((c) => !!c.params?.reason?.trim() || !!c.params?.instructions?.trim() || (c.extras ?? []).some((e) => e.kind === "comment" || e.kind === "open_issue"));
}

/** Automatic prepares of decision alias `d` since the UTC day start bound to `?`. */
export const preparesTodaySql = (_db: Db, d: string): string => `(SELECT count(*) FROM decision_prepares p WHERE p.decision_id = ${d}.id AND p.manual = 0 AND p.at >= ?)`;

/** The select list for the columns above, for open decisions only; binds one `?` (the UTC day start). */
export const prepareStateSql = (db: Db, d: string): string => `CASE WHEN ${d}.answer IS NULL THEN ${discussionKeySql(db, d)} END AS discussion_key,
  CASE WHEN ${d}.answer IS NULL THEN ${reviewedAtSql(db, d)} END AS reviewed_at, CASE WHEN ${d}.answer IS NULL THEN ${preparesTodaySql(db, d)} END AS prepares_today,
  CASE WHEN ${d}.answer IS NULL THEN ${staleChoicesSql(db, d)} END AS stale_choices, CASE WHEN ${d}.answer IS NULL THEN ${reviewQueuedSql(db, d)} END AS review_queued`;

// Typed twins of the SQL fragments above, for queries built with `db.k`; `d` names the decisions row in the caller's query.

/** `reviewQueuedSql` as an expression. */
export function reviewQueuedExpr(db: Db, eb: kx.AnyEb, d: string): AliasableExpression<SqlBool> {
  const actions = eb.case().when(kx.jsonValid(db, "qp.actions")).then(eb.ref("qp.actions")).else(eb.val("[]")).end();
  return eb.exists(kx.schemaEb(eb).selectFrom("item_plans as qp").innerJoin("items as qi", (j) => j.onRef("qi.repo", "=", "qp.repo").onRef("qi.number", "=", "qp.number"))
    .crossJoin(kx.jsonEach(db, actions, "qa")).select(eb.lit(1).as("one"))
    .where("qp.repo", "=", eb.ref(`${d}.repo`)).where("qp.number", "=", eb.ref(`${d}.number`))
    .where(kx.jsonText(db, "qa.value", "$.kind"), "in", ["review", "carry"]).where(kx.jsonText(db, "qa.value", "$.head"), "is not distinct from", eb.ref("qi.head_oid")));
}

/** `discussionKeySql` as an expression. */
export function discussionKeyExpr(db: Db, eb: kx.AnyEb, d: string): AliasableExpression<string | null> {
  const t = kx.schemaEb(eb);
  const appSlugs = t.selectFrom("main.settings").select("value").where("key", "=", "app_slugs");
  const slugs = eb.case().when(kx.jsonValid(db, appSlugs)).then(appSlugs).else(eb.val("[]")).end();
  const body = eb.fn<string>("ltrim", [eb.fn.coalesce("c.body", eb.val(""))]);
  return t.selectFrom("comments as c").select("c.id").where("c.repo", "=", eb.ref(`${d}.repo`)).where("c.number", "=", eb.ref(`${d}.number`)).where("c.counted", "=", 1)
    .where(eb.fn.coalesce("c.author", eb.val("")), "not in", t.selectFrom(kx.jsonEach(db, slugs, "s")).select("s.value"))
    .where(eb.not(eb.or(OWN_NOTE_PREFIXES.map((p) => kx.like(db, body, eb.val(`${kx.likeEscape(p)}%`), "\\")))))
    .orderBy("c.created_at", (o) => o.desc().nullsLast()).orderBy("c.id", "desc").limit(1).$asScalar();
}

/** `reviewedAtSql` as an expression. */
export function reviewedAtExpr(_db: Db, eb: kx.AnyEb, d: string): AliasableExpression<string | null> {
  return kx.schemaEb(eb).selectFrom("opus_reviews as r")
    .innerJoin("items as ri", (j) => j.onRef("ri.repo", "=", "r.repo").onRef("ri.number", "=", "r.number").onRef("ri.head_oid", "=", "r.head_oid"))
    .select((s) => s.fn.max("r.at").as("at")).where("r.repo", "=", eb.ref(`${d}.repo`)).where("r.number", "=", eb.ref(`${d}.number`)).where("r.verdict", "is not", null).$asScalar();
}

/** `staleChoicesSql` as an expression. */
export function staleChoicesExpr(db: Db, eb: kx.AnyEb, d: string): AliasableExpression<string | null> {
  return kx.schemaEb(eb).selectFrom("decision_choices as c").innerJoin("items as si", (j) => j.onRef("si.repo", "=", "c.repo").onRef("si.number", "=", "c.number"))
    .select(kx.jsonObject(db, { d: "c.drafts", a: "c.added" }).as("choices"))
    .where("c.decision_id", "=", eb.ref(`${d}.id`)).where("c.state", "=", "current").where("si.kind", "=", "pr")
    .where(kx.jsonText(db, "c.seen", "$.head"), "is distinct from", eb.ref("si.head_oid")).limit(1).$asScalar();
}

/** `preparesTodaySql` as an expression; `since` is the value the text version binds (the UTC day start). */
export function preparesTodayExpr(_db: Db, eb: kx.AnyEb, d: string, since: string): AliasableExpression<number> {
  return kx.schemaEb(eb).selectFrom("decision_prepares as p").select((s) => s.fn.countAll<number>().as("n"))
    .where("p.decision_id", "=", eb.ref(`${d}.id`)).where("p.manual", "=", 0).where("p.at", ">=", since).$asScalar();
}

/** `prepareStateSql` as a select list: `.select((eb) => prepareStateExpr(db, eb, "d", utcDayStart(now)))`. */
export function prepareStateExpr(db: Db, eb: kx.AnyEb, d: string, since: string) {
  const open = <T>(e: Expression<T>) => eb.case().when(eb.ref(`${d}.answer`), "is", null).then(e).end();
  return [
    open(discussionKeyExpr(db, eb, d)).as("discussion_key"),
    open(reviewedAtExpr(db, eb, d)).as("reviewed_at"),
    open(preparesTodayExpr(db, eb, d, since)).as("prepares_today"),
    open(staleChoicesExpr(db, eb, d)).as("stale_choices"),
    open(reviewQueuedExpr(db, eb, d)).as("review_queued"),
  ];
}

export const utcDayStart = (nowMs: number): string => `${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00.000Z`;

/** A Merge? or Close? decision is made for one head commit: its id ends in `@<sha>`. */
const idHead = (d: PrepareColumns): string | null => {
  const m = d.id === undefined || (d.kind !== "merge" && d.kind !== "close" && d.kind !== "hold") ? null : /:(?:merge|close|hold)@(.+)$/.exec(d.id);
  return m ? m[1]! : null;
};

/**
 * A prepare covers the decision's current state. A Merge? decision (or one of unknown kind) is tied to the PR head it was prepared for.
 * Any other kind stays prepared across head pushes until the discussion changes (a new counted comment), a new Opus review
 * is stored at the current head, or the decision itself changes or an operator asks again (both clear `prepared_at`).
 */
export const isPrepared = (d: PrepareColumns, head: string | null): boolean => {
  if (d.prepared_at === null) return false;
  if (d.kind === undefined || d.kind === "merge") return (d.prepared_head ?? null) === (head ?? null);
  // A Hold question is kept through a new hold review at its head: that review's time makes the prepare stale.
  if (d.kind === "hold") return (d.prepared_head ?? null) === (head ?? null) && !(d.reviewed_at && d.reviewed_at > d.prepared_at);
  if (d.prepared_discussion != null && (d.discussion_key ?? "") !== d.prepared_discussion && ((d.prepares_today ?? 0) < DISCUSSION_PREPARES_PER_DAY || !!d.prepare_requested_at)) return false;
  if (choicesDependOnCode(d.stale_choices)) return false;
  return !(d.reviewed_at && d.reviewed_at > d.prepared_at);
};

/** Why an automatic prepare is not due: the decision is for an older head or a review of its head is queued (the review's result withdraws a Merge? or Close? question and asks it again), or it used its prepares of the day. An operator's Re-prepare lifts the cap and the review hold. */
export const prepareHeld = (d: PrepareColumns, head: string | null): "old-head" | "review-queued" | "capped" | null => {
  const h = idHead(d);
  if (h !== null && h !== head) return "old-head";
  if (h !== null && d.review_queued && !d.prepare_requested_at) return "review-queued";
  if (!d.prepare_requested_at && (d.prepares_today ?? 0) >= PREPARE_DAILY_CAP) return "capped";
  return null;
};

/** Failed tries at the current head; a new head starts again. */
const triesAt = (d: PrepareColumns, head: string | null): number => ((d.prepare_failed_head ?? null) === (head ?? null) ? d.recommend_failures ?? 0 : 0);

/** The decision is open, has no prepare for its current state, has tries left and is not held. */
export const isPreparing = (d: PrepareColumns, head: string | null): boolean => !isPrepared(d, head) && triesAt(d, head) < RECOMMEND_MAX_FAILURES && prepareHeld(d, head) === null;

/** Preparing, and the wait after the last failed try is over. */
export const prepareDue = (d: PrepareColumns, head: string | null, nowMs: number): boolean =>
  isPreparing(d, head) && (triesAt(d, head) === 0 || d.recommend_failed_at === null || Date.parse(d.recommend_failed_at) < nowMs - RECOMMEND_RETRY_MS);

/** Whether the decision is open and waits for its prepare (the dashboard's `preparing`). */
/**
 * The decision is still about something open: its item, or for a duplicate group (whose item is the kept one, often
 * already closed or merged) any member it would close.
 */
export const openSubjectSql = (d: string, i: string): string => `(${i}.state = 'OPEN' OR (${d}.id LIKE '%:dupegroup:%' AND EXISTS (SELECT 1 FROM dupe_group_items gi
  JOIN items m ON m.repo = ${d}.repo AND m.number = gi.number WHERE gi.decision_id = ${d}.id AND gi.role = 'close' AND m.state = 'OPEN')))`;

/** `openSubjectSql` as an expression; `i` names the decision's items row. */
export function openSubjectExpr(db: Db, eb: kx.AnyEb, d: string, i: string): AliasableExpression<SqlBool> {
  return eb.or([eb(eb.ref(`${i}.state`), "=", "OPEN"), eb.and([kx.like(db, `${d}.id`, eb.val("%:dupegroup:%")),
    eb.exists(kx.schemaEb(eb).selectFrom("dupe_group_items as gi").innerJoin("items as m", (j) => j.on("m.repo", "=", eb.ref(`${d}.repo`)).onRef("m.number", "=", "gi.number"))
      .select(eb.lit(1).as("one")).where("gi.decision_id", "=", eb.ref(`${d}.id`)).where("gi.role", "=", "close").where("m.state", "=", "OPEN"))])]);
}

type Subject = { dkind: string; kind: string; head_oid: string | null; prepares_today: number | null; review_queued: SqlBool | null } & Pick<PrepareColumns, "discussion_key" | "reviewed_at" | "stale_choices">;

type Open = Partial<PrepareColumns> & { id: string; answer: string | null; repo: string | null; number: number | null };

const subjects = (db: Db) => db.k.selectFrom("decisions as d").innerJoin("items as i", (j) => j.onRef("i.repo", "=", "d.repo").onRef("i.number", "=", "d.number"))
  .select((eb) => ["d.id as did", "i.kind", "i.head_oid", "d.kind as dkind", ...prepareStateExpr(db, eb, "d", utcDayStart(Date.now()))])
  .where((eb) => eb.and([openSubjectExpr(db, eb, "d", "i"), pilotExpr(db, eb, "i"), notOwnIntegrationExpr(db, eb, "i")]));

function columnsFrom(d: Open, it: Subject | undefined): { cols: PrepareColumns; head: string | null; open: true } | null {
  if (!it) return null;
  const cols: PrepareColumns = { id: d.id, kind: it.dkind, prepared_at: d.prepared_at ?? null, prepared_head: d.prepared_head ?? null, prepare_failed_head: d.prepare_failed_head ?? null, recommend_failures: d.recommend_failures ?? null, recommend_failed_at: d.recommend_failed_at ?? null,
    prepared_discussion: d.prepared_discussion ?? null, discussion_key: it.discussion_key ?? null, reviewed_at: it.reviewed_at ?? null, prepare_requested_at: d.prepare_requested_at ?? null, prepares_today: Number(it.prepares_today ?? 0), stale_choices: it.stale_choices ?? null, review_queued: Number(it.review_queued ?? 0) };
  return { cols, head: it.kind === "pr" ? it.head_oid : null, open: true };
}

async function columnsOf(db: Db, d: Open): Promise<{ cols: PrepareColumns; head: string | null; open: true } | null> {
  if (d.answer !== null || d.number === null) return null;
  return columnsFrom(d, await db.get(subjects(db).where("d.id", "=", d.id)));
}

export type PrepareState = { preparing: boolean; preparedEarlier: boolean };

/** `preparing` and `preparedEarlier` of every open single-item decision in `ds` from one statement, for a page of rows. */
export async function prepareStates(db: Db, ds: Open[]): Promise<Map<string, PrepareState>> {
  const open = ds.filter((d) => d.answer === null && d.number !== null);
  const out = new Map<string, PrepareState>();
  if (!open.length) return out;
  const rows = await db.all(subjects(db).where(kx.inList(db, "d.id", open.map((d) => d.id))));
  const by = new Map(rows.map((r) => [r.did, r]));
  for (const d of open) {
    const x = columnsFrom(d, by.get(d.id));
    out.set(d.id, x ? { preparing: isPreparing(x.cols, x.head), preparedEarlier: stateEarlier(x) } : { preparing: false, preparedEarlier: false });
  }
  return out;
}

const stateEarlier = (x: { cols: PrepareColumns; head: string | null }): boolean =>
  (x.cols.prepared_at !== null || x.cols.stale_choices != null) && !isPrepared(x.cols, x.head) && prepareHeld(x.cols, x.head) === "capped";

export async function preparing(db: Db, d: Open): Promise<boolean> {
  const x = await columnsOf(db, d);
  return !!x && isPreparing(x.cols, x.head);
}

/** The decision keeps choices from an earlier prepare because its prepares of the day are used up; an operator's Re-prepare updates them. */
export async function preparedEarlier(db: Db, d: Open): Promise<boolean> {
  const x = await columnsOf(db, d);
  return !!x && stateEarlier(x);
}
