// Predicates other modules embed in their statements (src/data/** only) and the mirror's named key sources.
import type { AliasableExpression, Expression, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { registerKeySource } from "../keys.ts";
import { queryDb } from "../../db/query-db.ts";
import type { OpenItemsArgs, RepoItemsArgs } from "./types.ts";

const one = (eb: kx.AnyEb) => eb.lit(1).as("one");

/** The item `repo#number` is open in the mirror; `kind` narrows it, `tracked` limits it to tracked repos. */
export function openItem(eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex, o: { kind?: "pr" | "issue"; tracked?: boolean } = {}): AliasableExpression<SqlBool> {
  const t = kx.schemaEb(eb), r = kx.exprOf(eb, repo), n = kx.exprOf(eb, number);
  const q = t.selectFrom("main.items as oi").select(one(eb)).where("oi.repo", "=", r).where("oi.number", "=", n).where("oi.state", "=", "OPEN")
    .$if(!!o.kind, (b) => b.where("oi.kind", "=", o.kind!))
    .$if(!!o.tracked, (b) => b.where((w) => w.exists(kx.schemaEb(w).selectFrom("main.tracked_repos as ot").select(one(w)).where("ot.name", "=", kx.ref<string>("oi.repo")))));
  return eb.exists(q);
}

/** The mirror holds no row of the item `repo#number` (one just opened, before the sync read it). */
export function itemNotMirrored(eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex): AliasableExpression<SqlBool> {
  const q = kx.schemaEb(eb).selectFrom("main.items as nm").select(one(eb)).where("nm.repo", "=", kx.exprOf(eb, repo)).where("nm.number", "=", kx.exprOf(eb, number));
  return eb.not(eb.exists(q));
}

/** The item is open (`alias` names a row of items). */
export const itemIsOpen = (eb: kx.AnyEb, alias: string): AliasableExpression<SqlBool> => eb(kx.exprOf(eb, `${alias}.state`), "=", "OPEN");

/** The head commit of the item, or null. */
export function itemHead(eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex): AliasableExpression<string | null> {
  return kx.schemaEb(eb).selectFrom("main.items as ih").select("ih.head_oid").where("ih.repo", "=", kx.exprOf(eb, repo)).where("ih.number", "=", kx.exprOf(eb, number)) as unknown as AliasableExpression<string | null>;
}

/** `pr_checks.overall` of the PR when the stored checks are at `head`, else null. */
export function checksOverallAt(eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex, head: kx.Ex): Expression<string | null> {
  return kx.schemaEb(eb).selectFrom("main.pr_checks as pc").select("pc.overall").where("pc.repo", "=", kx.exprOf(eb, repo)).where("pc.number", "=", kx.exprOf(eb, number))
    .where("pc.head_oid", "=", kx.exprOf(eb, head)) as unknown as Expression<string | null>;
}

/** The stored main-branch heads of a repo, as a subquery (`main_ci` rows). */
export function mainHeadsOf(eb: kx.AnyEb, repo: kx.Ex) {
  return kx.schemaEb(eb).selectFrom("main.main_ci as mh").selectAll("mh").where("mh.repo", "=", kx.exprOf(eb, repo));
}

/** Items of `repos` (all items when omitted). */
export function itemsOfRepos(db: Db, repos?: readonly string[]) {
  return queryDb(db).k.selectFrom("main.items as ir").select(["ir.repo", "ir.number"]).$if(!!repos, (b) => b.where(kx.inList(db, "ir.repo", repos!)));
}

/** Open PRs of `repos`. */
export const openPrsExpr = (db: Db, repos: readonly string[]) => itemsOfRepos(db, repos).where("ir.kind", "=", "pr").where("ir.state", "=", "OPEN");

/** PRs of `repos` in one of `states` (OPEN, MERGED, CLOSED). */
export const prsInStatesExpr = (db: Db, repos: readonly string[], states: readonly string[]) => itemsOfRepos(db, repos).where("ir.kind", "=", "pr").where(kx.inList(db, "ir.state", states));

/**
 * An upsert's `mergeable` value: GitHub reports UNKNOWN while it recomputes, which must not replace a known value stored for the same
 * head. `table` is the table of the upsert (`items`, `pr_checks`); the incoming row is `excluded`.
 */
export const keepKnownMergeableExpr = (eb: kx.AnyEb, table: string): Expression<string | null> =>
  eb.case().when(eb.and([
    eb(eb.ref(`${table}.head_oid`), "is not distinct from", eb.ref("excluded.head_oid")),
    eb(eb.ref(`${table}.mergeable`), "in", ["CONFLICTING", "MERGEABLE"]),
    eb(eb.ref("excluded.mergeable"), "is distinct from", "CONFLICTING"),
    eb(eb.ref("excluded.mergeable"), "is distinct from", "MERGEABLE"),
  ])).then(eb.ref(`${table}.mergeable`)).else(eb.ref("excluded.mergeable")).end();

const openItemsKeys = (db: Db, o: OpenItemsArgs) =>
  queryDb(db).k.selectFrom("main.items as ki").select(["ki.repo", "ki.number"]).where("ki.state", "=", "OPEN")
    .$if(!!o.kind, (b) => b.where("ki.kind", "=", o.kind!))
    .$if(!!o.repos, (b) => b.where(kx.inList(db, "ki.repo", o.repos!)))
    .$if(!!o.tracked, (b) => b.where((w) => w.exists(kx.schemaEb(w).selectFrom("main.tracked_repos as kt").select(one(w)).where("kt.name", "=", kx.ref<string>("ki.repo")))));

registerKeySource<OpenItemsArgs>("mirror.openItems", (db, o) => openItemsKeys(db, o));
registerKeySource<{ from: string }>("mirror.itemsSince", (db, { from }) =>
  queryDb(db).k.selectFrom("main.items as ks").select(["ks.repo", "ks.number"]).where("ks.created_at", ">=", from));
registerKeySource<RepoItemsArgs>("mirror.repoItems", (db, o) => itemsOfRepos(db, o.repos).$if(!!o.kind, (b) => b.where("ir.kind", "=", o.kind!)));
