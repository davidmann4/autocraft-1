// The scope of the pipeline. A repo takes part only while its pipeline flag (tracked_repos.pipeline) is on; off means sync only.
// The pilot is an operator setting that narrows the enabled repos further to a list of items ("repo#number").
// Empty or absent means no pilot. A Fix PR the pipeline opened for a pilot issue, a follow-up issue it filed for a pilot PR, and a Fix PR it opened for such a follow-up issue count as pilot items.
// A fast-tracked item (src/fasttrack.ts) is in scope whatever its repo's flag and the pilot say, and so is, in a repo on the
// maintainer workflow (src/workflow), an item with a live workflow and the PR of an issue's live implement workflow.
// No Node imports besides the type, so candidate queries can use the SQL fragments.
import { quietExprFor, quietSqlFor } from "./security/quiet.ts";
import { audit } from "./dash/audit.ts";
import { setting } from "./settings-read.ts";
import type { Db } from "./db/index.ts";
import { jsonArrayLength, jsonEach, jsonValid } from "./db/portable.ts";
import * as kx from "./db/kx.ts";
import type { AliasableExpression, Expression, SqlBool } from "kysely";

export const PILOT_KEY = "pilot_items";

export class PilotError extends Error {
  status = 400;
}

const REF = /^([A-Za-z0-9._-]+)(?:#([1-9][0-9]*))?$/;
const NAME = /^[A-Za-z0-9._-]+$/;

/** The stored list; an unreadable value counts as no pilot. */
export async function pilotItems(db: Db): Promise<string[]> {
  const value = await setting(db, PILOT_KEY);
  if (value === undefined) return [];
  try {
    const v = JSON.parse(value) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Tracked repos whose pipeline flag is on. */
export async function pipelineRepos(db: Db): Promise<Set<string>> {
  return new Set((await db.all(db.k.selectFrom("main.tracked_repos").select("name").where("pipeline", "=", 1))).map((r) => r.name));
}

export const pipelineOn = async (db: Db, repo: string): Promise<boolean> =>
  await db.get(db.k.selectFrom("main.tracked_repos").select("name").where("name", "=", repo).where("pipeline", "=", 1)) !== undefined;

/** Sets a tracked repo's pipeline flag. Returns false when nothing changed. */
export async function setRepoPipeline(db: Db, by: string, repo: string, on: boolean): Promise<boolean> {
  if (!NAME.test(repo) || !await db.get(db.k.selectFrom("main.tracked_repos").select("name").where("name", "=", repo))) throw new PilotError(`${repo} is not tracked`);
  const changed = (await db.run(db.k.updateTable("main.tracked_repos").set({ pipeline: on ? 1 : 0 }).where("name", "=", repo).where("pipeline", "<>", on ? 1 : 0))).changes > 0;
  if (changed) await audit(db, by, "repo-pipeline", repo, { on });
  return changed;
}

/** The repos in scope without fast track: pipeline flag on, and, with a pilot set, named by one of its items. */
export async function baseScopeRepos(db: Db): Promise<Set<string>> {
  const on = await pipelineRepos(db);
  const items = await pilotItems(db);
  return items.length ? new Set([...on].filter((r) => new Set(items.map((i) => i.split("#")[0]!)).has(r))) : on;
}

/** Live states of item_workflows (src/workflow/store.ts LIVE_STATES), spelled out here so the SQL needs no import of the store. */
const WF_LIVE = "('running', 'waiting', 'blocked', 'recommending')";
const WF_LIVE_LIST = ["running", "waiting", "blocked", "recommending"];

/** The repos that take part: those of `baseScopeRepos` and those with a fast-tracked open item or a live workflow. */
export async function scopeRepos(db: Db): Promise<Set<string>> {
  const out = await baseScopeRepos(db);
  // A repo with a fast-tracked open item takes part for that item alone (see pilotSqlFor).
  for (const r of await db.all(db.k.selectFrom("main.fast_track as f").innerJoin("main.tracked_repos as t", "t.name", "f.repo")
    .innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "f.repo").onRef("i.number", "=", "f.number").on("i.state", "=", "OPEN"))
    .select("f.repo").distinct())) out.add(r.repo);
  for (const r of await db.all(db.k.selectFrom("main.item_workflows as w").innerJoin("main.tracked_repos as t", "t.name", "w.repo")
    .where("t.workflow", "=", "new").where("w.state", "in", WF_LIVE_LIST).select("w.repo").distinct())) out.add(r.repo);
  return out;
}

/** Parses refs (repo#number) separated by whitespace or commas; throws on a malformed one, a whole-repo entry or an untracked repo. */
export async function parsePilotRefs(db: Db, input: unknown): Promise<string[]> {
  const parts = Array.isArray(input) ? input : typeof input === "string" ? input.split(/[\s,]+/).filter(Boolean) : null;
  if (!parts || parts.some((p) => typeof p !== "string")) throw new PilotError("items must be a list of repo#number");
  const tracked = new Set((await db.all(db.k.selectFrom("main.tracked_repos").select("name"))).map((r) => r.name));
  const out: string[] = [];
  for (const p of parts as string[]) {
    const m = REF.exec(p);
    if (!m) throw new PilotError(`not a repo#number: ${p}`);
    if (!m[2]) throw new PilotError(`${p} is a whole repo; switch it on or off with the Pipeline toggle on the Repos page`);
    if (!tracked.has(m[1]!)) throw new PilotError(`${m[1]} is not tracked`);
    if (!out.includes(p)) out.push(p);
  }
  if (out.length > 200) throw new PilotError("at most 200 items");
  return out;
}

/** Replaces the list; an empty list clears the pilot. Returns the stored list. */
export async function setPilot(db: Db, by: string, input: unknown): Promise<string[]> {
  const refs = await parsePilotRefs(db, input);
  if (refs.length) await db.run(db.k.insertInto("main.settings").values({ key: PILOT_KEY, value: JSON.stringify(refs) }).onConflict((oc) => oc.column("key").doUpdateSet(kx.excluded(["value"]))));
  else await db.run(db.k.deleteFrom("main.settings").where("key", "=", PILOT_KEY));
  await audit(db, by, refs.length ? "pilot-set" : "pilot-clear", PILOT_KEY, { items: refs });
  return refs;
}

const list = (db: Db): string => `(SELECT CASE WHEN ${jsonValid(db, "ps.value")} THEN ps.value ELSE '[]' END FROM main.settings ps WHERE ps.key = '${PILOT_KEY}')`;

/** SQL condition on an item given by its repo and number expressions: it is fast-tracked, it has a live workflow (or is the PR of an issue's live implement workflow) in a repo on the maintainer workflow, or its repo's pipeline flag is on, an outside-author hold (src/outside.ts) does not keep it back and, with a pilot set, it is a pilot item, the Fix PR of a pilot issue, a follow-up issue of a pilot PR or the Fix PR of such an issue. */
export const pilotSqlFor = (db: Db, repo: string, number: string): string => {
  const LIST = list(db);
  return `(EXISTS (SELECT 1 FROM main.fast_track pft WHERE pft.repo = ${repo} AND pft.number = ${number})
    OR EXISTS (SELECT 1 FROM main.item_workflows pw JOIN main.tracked_repos pwt ON pwt.name = pw.repo AND pwt.workflow = 'new'
      WHERE pw.repo = ${repo} AND pw.state IN ${WF_LIVE} AND (pw.number = ${number}
        OR (pw.entry = 'implement' AND EXISTS (SELECT 1 FROM main.implementations pwi WHERE pwi.repo = pw.repo AND pwi.number = pw.number AND pwi.pr_number = ${number}))))
    OR (EXISTS (SELECT 1 FROM main.tracked_repos pt WHERE pt.name = ${repo} AND pt.pipeline = 1)
    AND NOT EXISTS (SELECT 1 FROM main.outside_holds oh WHERE oh.repo = ${repo} AND oh.number = ${number})
    AND (COALESCE(${jsonArrayLength(db, LIST)}, 0) = 0
      OR EXISTS (SELECT 1 FROM ${jsonEach(db, LIST, "pj")} WHERE pj.value = ${repo} || '#' || ${number})
      OR ${quietSqlFor(repo, number)}
      OR EXISTS (SELECT 1 FROM main.fix_attempts pf, ${jsonEach(db, LIST, "pj")} WHERE pf.repo = ${repo} AND pf.pr_url LIKE '%/pull/' || ${number}
        AND pj.value = pf.repo || '#' || pf.number)
      OR EXISTS (SELECT 1 FROM main.fix_attempts pf2 JOIN main.postmerge_followups pm2 ON pm2.repo = pf2.repo AND pm2.issue_number = pf2.number, ${jsonEach(db, LIST, "pj")}
        WHERE pf2.repo = ${repo} AND pf2.pr_url LIKE '%/pull/' || ${number} AND pj.value = pm2.repo || '#' || pm2.number)
      OR EXISTS (SELECT 1 FROM main.postmerge_followups pm, ${jsonEach(db, LIST, "pj")} WHERE pm.repo = ${repo} AND pm.issue_number = ${number}
        AND pj.value = pm.repo || '#' || pm.number)))
    OR EXISTS (SELECT 1 FROM main.fix_attempts pg JOIN main.fast_track pgt ON pgt.repo = pg.repo AND pgt.number = pg.number
      WHERE pg.repo = ${repo} AND pg.pr_url LIKE '%/pull/' || ${number}))`;
};

/** The same for a row `alias` of items. */
export const pilotSql = (db: Db, alias: string): string => pilotSqlFor(db, `${alias}.repo`, `${alias}.number`);

/**
 * Condition: a maintainer started work on the item, in a repo on the maintainer workflow: the item has a live workflow, or it
 * is the PR of an issue's live implement workflow. Such an item is in scope (pilotExprFor), and steps take it first.
 */
export function startedExprFor(eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex): AliasableExpression<SqlBool> {
  const t = kx.schemaEb(eb), r = kx.exprOf(eb, repo), n = kx.exprOf(eb, number);
  return eb.exists(t.selectFrom("main.item_workflows as pw").innerJoin("main.tracked_repos as pwt", (j) => j.onRef("pwt.name", "=", "pw.repo").on("pwt.workflow", "=", "new"))
    .select(eb.lit(1).as("one")).where("pw.repo", "=", r).where("pw.state", "in", WF_LIVE_LIST)
    .where((w) => w.or([
      w("pw.number", "=", n),
      w.and([w("pw.entry", "=", "implement"), w.exists(t.selectFrom("main.implementations as pwi").select(eb.lit(1).as("one"))
        .where("pwi.repo", "=", w.ref("pw.repo")).where("pwi.number", "=", w.ref("pw.number")).where("pwi.pr_number", "=", n))]),
    ])));
}

/** `pilotSqlFor` as an expression; `repo` and `number` are column references or expressions of the item. */
export function pilotExprFor(db: Db, eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex): AliasableExpression<SqlBool> {
  const t = kx.schemaEb(eb), r = kx.exprOf(eb, repo), n = kx.exprOf(eb, number);
  const list = t.selectFrom("main.settings as ps").select((s) => s.case().when(kx.jsonValid(db, "ps.value")).then(s.ref("ps.value")).else(s.val("[]")).end().as("v"))
    .where("ps.key", "=", PILOT_KEY);
  const pj = kx.jsonEach(db, list, "pj");
  const ref = (rp: kx.Ex, np: kx.Ex) => eb(eb(kx.exprOf(eb, rp), "||", eb.val("#")), "||", kx.exprOf(eb, np));
  const prOf = (url: string) => kx.like(db, url, eb(eb.val("%/pull/"), "||", n));
  return eb.or([
    eb.exists(t.selectFrom("main.fast_track as pft").select(eb.lit(1).as("one")).where("pft.repo", "=", r).where("pft.number", "=", n)),
    startedExprFor(eb, repo, number),
    eb.and([
      eb.exists(t.selectFrom("main.tracked_repos as pt").select(eb.lit(1).as("one")).where("pt.name", "=", r).where("pt.pipeline", "=", 1)),
      eb.not(eb.exists(t.selectFrom("main.outside_holds as oh").select(eb.lit(1).as("one")).where("oh.repo", "=", r).where("oh.number", "=", n))),
      eb.or([
        eb(eb.fn.coalesce(kx.jsonArrayLength(db, list), eb.lit(0)), "=", 0),
        eb.exists(t.selectFrom(pj).select(eb.lit(1).as("one")).where("pj.value", "=", ref(r, n))),
        quietExprFor(db, eb, r, n),
        eb.exists(t.selectFrom(["main.fix_attempts as pf", pj]).select(eb.lit(1).as("one")).where("pf.repo", "=", r).where(prOf("pf.pr_url"))
          .where("pj.value", "=", ref("pf.repo", "pf.number"))),
        eb.exists(t.selectFrom("main.fix_attempts as pf2").innerJoin("main.postmerge_followups as pm2", (j) => j.onRef("pm2.repo", "=", "pf2.repo").onRef("pm2.issue_number", "=", "pf2.number"))
          .crossJoin(pj).select(eb.lit(1).as("one")).where("pf2.repo", "=", r).where(prOf("pf2.pr_url")).where("pj.value", "=", ref("pm2.repo", "pm2.number"))),
        eb.exists(t.selectFrom(["main.postmerge_followups as pm", pj]).select(eb.lit(1).as("one")).where("pm.repo", "=", r).where("pm.issue_number", "=", n)
          .where("pj.value", "=", ref("pm.repo", "pm.number"))),
      ]),
    ]),
    eb.exists(t.selectFrom("main.fix_attempts as pg").innerJoin("main.fast_track as pgt", (j) => j.onRef("pgt.repo", "=", "pg.repo").onRef("pgt.number", "=", "pg.number"))
      .select(eb.lit(1).as("one")).where("pg.repo", "=", r).where(prOf("pg.pr_url"))),
  ]);
}

/** `pilotSql` as an expression, for a row `alias` of items. */
export const pilotExpr = (db: Db, eb: kx.AnyEb, alias: string): AliasableExpression<SqlBool> => pilotExprFor(db, eb, `${alias}.repo`, `${alias}.number`);

/** True when the item is in scope. */
export async function inPilot(db: Db, repo: string, number: number): Promise<boolean> {
  return !!await db.get(db.k.selectNoFrom((eb) => eb.lit(1).as("one")).where((eb) => pilotExprFor(db, eb, eb.val(repo), eb.cast<number>(eb.val(number), "bigint"))));
}

/** The items of `refs` a maintainer started work on (startedExprFor), as "repo#number": one query. */
export async function startedRefs(db: Db, refs: readonly { repo: string; number: number }[]): Promise<Set<string>> {
  if (!refs.length) return new Set();
  const rows = await db.all(db.k.selectFrom(kx.refPairs(db, refs.map((x) => [x.repo, x.number] as const), "j"))
    .select((eb) => eb(eb(eb.ref("j.repo"), "||", eb.val("#")), "||", kx.exprOf(eb, "j.number")).as("ref"))
    .where((eb) => startedExprFor(eb, "j.repo", "j.number")));
  return new Set(rows.map((r) => r.ref));
}
