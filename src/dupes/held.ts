// Items held back from the later stages while a duplicate decision about them
// is open or was answered "close as duplicate", or any decision about them was
// answered Backlog. An answer of "not a duplicate"
// or "keep both" releases them. No Node imports besides the type and the app-slug lookup.
import { pilotExpr } from "../pilot.ts";
import { appSlug } from "../github/identity.ts";
import type { Db } from "../db/index.ts";
import { jsonEach, jsonNum, jsonText, jsonValid } from "../db/portable.ts";
import * as kx from "../db/kx.ts";
import type { AliasableExpression, SqlBool } from "kysely";

/** The fact line that names the original; the act step reads it. */
export const DUP_FACT = "duplicate of ";

/** Option keys of a group decision: use the compared answer, keep another member instead (`keep:<number>`), or not duplicates. */
export const GROUP_OPTIONS = {
  accept: { key: "accept", label: "Use this answer", hint: "Posts the comments shown under it and closes the others as duplicates." },
  distinct: { key: "distinct", label: "Not duplicates", hint: "They are different; do not ask about this group again." },
} as const;
export const keepKey = (n: number): string => `keep:${n}`;
/** The member an answer keeps instead, or null. */
export const keptOf = (answer: string): number | null => {
  const m = /^keep:(\d+)$/.exec(answer);
  return m ? Number(m[1]) : null;
};
/** The id of the group decision whose lowest member is `lowest`. */
export const groupId = (repo: string, lowest: number): string => `${repo}:dupegroup:${lowest}`;

/** SQL condition, true when the item `alias` is named by a decision answered Backlog: the decision's own item, an item of a batch, or a member of a duplicate group. */
export const backlogHeldSql = (db: Db, alias: string): string =>
  `EXISTS (SELECT 1 FROM decisions db WHERE db.answer = 'backlog' AND (
    (db.repo = ${alias}.repo AND db.number = ${alias}.number)
    OR EXISTS (SELECT 1 FROM ${jsonEach(db, `CASE WHEN ${jsonValid(db, "db.items")} THEN db.items ELSE '[]' END`, "bj")}
      WHERE ${jsonText(db, "bj.value", "$.repo")} = ${alias}.repo AND ${jsonNum(db, "bj.value", "$.number")} = ${alias}.number)
    OR EXISTS (SELECT 1 FROM dupe_group_items bg WHERE bg.decision_id = db.id AND bg.repo = ${alias}.repo AND bg.number = ${alias}.number)))`;

// Conditions for queries built with `db.k`; `alias` names the items row in the caller's query.

/** Condition, true when the item `alias` is a member a group decision closes and the group is still open or was answered other than "not duplicates". */
export function groupHeldExpr(db: Db, eb: kx.AnyEb, alias: string): AliasableExpression<SqlBool> {
  return eb.exists(kx.schemaEb(eb).selectFrom("dupe_group_items as gi").innerJoin("decisions as dg", "dg.id", "gi.decision_id").select(eb.lit(1).as("one"))
    .where("gi.repo", "=", eb.ref(`${alias}.repo`)).where("gi.number", "=", eb.ref(`${alias}.number`)).where("gi.role", "=", "close").where("dg.kind", "=", "duplicate")
    .where((w) => w.or([w("dg.answer", "is", null), w("dg.answer", "=", "accept"), kx.like(db, "dg.answer", w.val("keep:%"))])));
}

/** Condition, true when the item `alias` is named by a decision answered Backlog: the decision's own item, an item of a batch, or a member of a duplicate group. */
export function backlogHeldExpr(db: Db, eb: kx.AnyEb, alias: string): AliasableExpression<SqlBool> {
  const t = kx.schemaEb(eb), repo = eb.ref(`${alias}.repo`), number = eb.ref(`${alias}.number`);
  const items = eb.case().when(kx.jsonValid(db, "db.items")).then(eb.ref("db.items")).else(eb.val("[]")).end();
  return eb.exists(t.selectFrom("decisions as db").select(eb.lit(1).as("one")).where("db.answer", "=", "backlog").where((w) => w.or([
    w.and([w("db.repo", "=", repo), w("db.number", "=", number)]),
    w.exists(t.selectFrom(kx.jsonEach(db, items, "bj")).select(eb.lit(1).as("one"))
      .where(kx.jsonText(db, "bj.value", "$.repo"), "=", repo).where(kx.jsonNum(db, "bj.value", "$.number"), "=", number)),
    w.exists(t.selectFrom("dupe_group_items as bg").select(eb.lit(1).as("one")).where("bg.decision_id", "=", eb.ref("db.id")).where("bg.repo", "=", repo).where("bg.number", "=", number)),
  ])));
}

/** Condition, true when the item `alias` (a row of items) is not an integration batch PR the pipeline opened itself (see src/merge/batch.ts). Such PRs only carry reviewed PRs and never enter the pipeline as contributor PRs. */
export function notOwnIntegrationExpr(db: Db, eb: kx.AnyEb, alias: string): AliasableExpression<SqlBool> {
  const t = kx.schemaEb(eb), author = eb.ref(`${alias}.author`);
  const appSlugs = t.selectFrom("main.settings").select("value").where("key", "=", "app_slugs");
  const stored = eb.case().when(kx.jsonValid(db, appSlugs)).then(appSlugs).else(eb.val("[]")).end();
  const slugs = t.selectFrom(kx.jsonEach(db, kx.json([appSlug()].filter(Boolean)), "ls")).select("ls.value as slug")
    .union(t.selectFrom(kx.jsonEach(db, stored, "ps")).select("ps.value as slug")).as("slugs");
  return eb.not(eb.exists(t.selectFrom("main.merge_batches as mb").select(eb.lit(1).as("one"))
    .where("mb.repo", "=", eb.ref(`${alias}.repo`)).where("mb.pr_number", "=", eb.ref(`${alias}.number`))
    .where((w) => w.or([
      w(author, "=", t.selectFrom("main.settings").select("value").where("key", "=", "pipeline_login")),
      w.exists(t.selectFrom(slugs).select(eb.lit(1).as("one")).where((v) => v.or([v(author, "=", v.ref("slugs.slug")), v(author, "=", eb(eb.ref("slugs.slug"), "||", eb.val("[bot]")))]))),
    ]))));
}

/** Condition, true when the item `alias` (a row of items) is not held by a duplicate decision, is not one of our integration PRs and is in the pilot (when one is set). For WHERE clauses of candidate queries. */
export function notHeldExpr(db: Db, eb: kx.AnyEb, alias: string): AliasableExpression<SqlBool> {
  return eb.and([
    notOwnIntegrationExpr(db, eb, alias),
    pilotExpr(db, eb, alias),
    eb.not(eb.exists(kx.schemaEb(eb).selectFrom("decisions as dh").select(eb.lit(1).as("one")).where("dh.kind", "=", "duplicate")
      .where((w) => w.not(kx.like(db, "dh.id", w.val("%:dupegroup:%")))).where("dh.repo", "=", eb.ref(`${alias}.repo`)).where("dh.number", "=", eb.ref(`${alias}.number`))
      .where((w) => w.or([w("dh.answer", "is", null), w("dh.answer", "=", "close")])))),
    eb.not(groupHeldExpr(db, eb, alias)),
    eb.not(backlogHeldExpr(db, eb, alias)),
  ]);
}

/** True when a Backlog answer holds the item. */
export async function backlogHeld(db: Db, repo: string, number: number): Promise<boolean> {
  return !!await db.get(db.k.selectFrom("items as i").select((eb) => eb.lit(1).as("one")).where("i.repo", "=", repo).where("i.number", "=", number)
    .where((eb) => backlogHeldExpr(db, eb, "i")));
}

/** The items queued with bypass checks as `repo#number`, of one repo or every repo: fast-tracked with it (src/fasttrack.ts), or with a pre-approved merge in progress that has it (removing the item from the list leaves that row). Duplicate checks never close one. */
export async function bypassQueued(db: Db, repo?: string): Promise<Set<string>> {
  const fast = await db.all(db.k.selectFrom("fast_track").select(["repo", "number"]).where("bypass", "=", 1).$if(!!repo, (q) => q.where("repo", "=", repo!)));
  const pre = await db.all(db.k.selectFrom("preapprovals").select(["repo", "number"]).where("bypass", "=", 1).where("state", "in", ["fixup", "review", "ci", "queued"])
    .$if(!!repo, (q) => q.where("repo", "=", repo!)));
  return new Set([...fast, ...pre].map((r) => `${r.repo}#${r.number}`));
}

export async function duplicateHeld(db: Db, repo: string, number: number): Promise<boolean> {
  return !!await db.get(db.k.selectFrom("decisions").select((eb) => eb.lit(1).as("one")).where("kind", "=", "duplicate").where((eb) => eb.not(kx.like(db, "id", eb.val("%:dupegroup:%"))))
      .where("repo", "=", repo).where("number", "=", number).where((eb) => eb.or([eb("answer", "is", null), eb("answer", "=", "close")])).limit(1))
    || !!await db.get(db.k.selectFrom("items as i").select((eb) => eb.lit(1).as("one")).where("i.repo", "=", repo).where("i.number", "=", number)
      .where((eb) => eb.or([groupHeldExpr(db, eb, "i"), backlogHeldExpr(db, eb, "i")])));
}

/** Open duplicates pointing at the canonical item: items held by a decision that names it as the original. */
export async function duplicateCount(db: Db, repo: string, canonical: number): Promise<number> {
  const pairs = (await db.get(db.k.selectFrom("decisions").select((eb) => eb.fn.countAll<number>().as("n")).where("kind", "=", "duplicate")
    .where((eb) => eb.not(kx.like(db, "id", eb.val("%:dupegroup:%")))).where("repo", "=", repo).where((eb) => eb.or([eb("answer", "is", null), eb("answer", "=", "close")]))
    .where((eb) => eb.exists(eb.selectFrom(kx.jsonEach(db, "decisions.facts", "fj")).select(eb.lit(1).as("one")).where("fj.value", "=", `${DUP_FACT}${repo}#${canonical}`)))))!.n;
  const groups = (await db.get(db.k.selectFrom("dupe_group_items as gi").innerJoin("decisions as dg", "dg.id", "gi.decision_id").select((eb) => eb.fn.countAll<number>().as("n"))
    .where("gi.repo", "=", repo).where("gi.target", "=", canonical).where("gi.role", "=", "close")
    .where((eb) => eb.or([eb("dg.answer", "is", null), eb("dg.answer", "=", "accept"), kx.like(db, "dg.answer", eb.val("keep:%"))]))))!.n;
  return pairs + groups;
}
