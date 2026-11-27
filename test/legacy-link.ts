// The rules that mapped PRs to implement workflows before the stored link (item_workflows.pr_number), as statements and code of their own:
// the oracle that the readers of the link are compared with (test/data/workflow-link.test.ts).
import type { Expression, SqlBool } from "kysely";
import type { IssueAttempt } from "../src/data/implement/types.ts";
import { resolveKeys, type KeySource } from "../src/data/keys.ts";
import type { EndedWorkflow, PrWorkflows, RefKey } from "../src/data/workflow/types.ts";
import { workflowOf, type WorkflowRow } from "../src/data/workflow/rows.ts";
import type { Db } from "../src/db/index.ts";
import * as kx from "../src/db/kx.ts";
import { queryDb } from "../src/db/query-db.ts";
import { ENDED_STATES } from "../src/implement/types.ts";
import type { ItemWorkflow } from "../src/workflow/types.ts";

const LIVE_STATES = ["running", "waiting", "blocked", "recommending"];
const ACTIVE_LEGS = ["fixup", "review", "ci", "queued"];
const ENDED_ATTEMPTS = ["merged", "closed", "failed", "cancelled"];
const one = (eb: kx.AnyEb) => eb.lit(1).as("one");
const refKey = (repo: string, number: number): RefKey => `${repo}#${number}`;

/** R1 in SQL: the attempt not ended, one made in the workflow, or the issue's newest when it ended in it. */
export const attemptOf = (eb: kx.AnyEb, i: string, w: string): Expression<SqlBool> => {
  const started = kx.ref<string>(`${w}.started_at`);
  const newer = kx.schemaEb(eb).selectFrom("main.implementations as ni").select(one(eb))
    .where("ni.repo", "=", kx.ref<string>(`${i}.repo`)).where("ni.number", "=", kx.ref<number>(`${i}.number`)).where("ni.id", ">", kx.ref<number>(`${i}.id`));
  return eb.or([
    eb(`${i}.state`, "not in", ENDED_ATTEMPTS),
    eb(`${i}.created_at`, ">=", started),
    eb.and([eb(`${i}.updated_at`, ">=", started), eb.not(eb.exists(newer))]),
  ]);
};

/** loadEndedWorkflows (endedQuery): how the newest workflow of each item, or of the issue a PR was opened for, ended. */
export async function loadEndedWorkflows(db: Db, keys: KeySource): Promise<Map<RefKey, EndedWorkflow>> {
  const k = queryDb(db).k as any;
  const on = (alias: string, repo: string, number: string) => (j: any) => j.onRef(`${alias}.repo`, "=", repo).onRef(`${alias}.number`, "=", number);
  const own = k.selectFrom("main.item_workflows as w").innerJoin(resolveKeys(db, keys, "ke"), on("ke", "w.repo", "w.number")).select(["w.repo as repo", "w.number as number", "w.state as state", "w.id as id"]);
  const ofPr = k.selectFrom("main.implementations as i").innerJoin(resolveKeys(db, keys, "kf"), on("kf", "i.repo", "i.pr_number"))
    .innerJoin("main.item_workflows as w", on("w", "i.repo", "i.number")).where("w.entry", "=", "implement").where((eb: any) => attemptOf(eb, "i", "w"))
    .where((eb: any) => eb.or([eb("w.state", "<>", "done"), eb.not(eb.exists(
      k.selectFrom("main.implementations as im").innerJoin("main.items as mi", on("mi", "im.repo", "im.pr_number")).select(one(eb))
        .whereRef("im.repo", "=", "w.repo").whereRef("im.number", "=", "w.number").where("mi.state", "=", "MERGED")
        .where((m: any) => m.or([m("mi.closed_at", "is", null), m("mi.closed_at", ">=", m.ref("w.started_at"))]))))]))
    .select(["i.repo as repo", "i.pr_number as number", "w.state as state", "w.id as id"]);
  const ranked = k.selectFrom(own.union(ofPr).as("u"))
    .select((e: any) => ["u.repo", "u.number", "u.state", e.fn.agg("row_number").over((o: any) => o.partitionBy(["u.repo", "u.number"]).orderBy("u.id", "desc")).as("rn")]);
  const q = k.selectFrom(ranked.as("x")).select(["x.repo", "x.number", "x.state"]).where("x.rn", "=", 1).where("x.state", "not in", LIVE_STATES).orderBy("x.repo").orderBy("x.number");
  const rows = await queryDb(db).all(q) as { repo: string; number: number | string; state: string }[];
  return new Map(rows.map((r) => [refKey(r.repo, Number(r.number)), r.state as EndedWorkflow]));
}

/** loadPrWorkflows: the live workflow that works on each PR: its own, its active leg's, or the issue's. */
export async function loadPrWorkflows(db: Db, refs: { repo: string; number: number }[], o: { others?: boolean } = {}): Promise<PrWorkflows> {
  const out: PrWorkflows = new Map();
  if (refs.length === 0) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const onKey = (alias: string, number: string) => (j: any) => j.onRef("kk.repo", "=", `${alias}.repo`).onRef("kk.number", "=", `${alias}.${number}`);
  const own = k.selectFrom("main.item_workflows as o").innerJoin(resolveKeys(db, refs, "kk"), onKey("o", "number"))
    .select((eb: any) => ["o.repo as repo", "o.number as number", "o.id as wid", eb.lit(0).as("rank")]).where("o.state", "in", LIVE_STATES);
  const leg = k.selectFrom("main.preapprovals as p").innerJoin(resolveKeys(db, refs, "kk"), onKey("p", "number"))
    .select((eb: any) => ["p.repo as repo", "p.number as number", "p.workflow_id as wid", eb.lit(1).as("rank")]).where("p.state", "in", ACTIVE_LEGS).where("p.workflow_id", "is not", null);
  const attempt = k.selectFrom("main.implementations as i").innerJoin(resolveKeys(db, refs, "kk"), onKey("i", "pr_number"))
    .innerJoin("main.item_workflows as iw", (j: any) => j.onRef("iw.repo", "=", "i.repo").onRef("iw.number", "=", "i.number"))
    .select((eb: any) => ["i.repo as repo", "i.pr_number as number", "iw.id as wid", eb.lit(2).as("rank")]).where("iw.entry", "=", "implement").where("iw.state", "in", LIVE_STATES)
    .where((eb: any) => attemptOf(eb, "i", "iw"));
  const rows = await q.all(k.selectFrom(own.unionAll(leg).unionAll(attempt).as("h")).innerJoin("main.item_workflows as w", "w.id", "h.wid")
    .selectAll("w").select(["h.number as pr", "h.rank as rank"]).where("w.state", "in", LIVE_STATES)
    .$if(!!o.others, (b: any) => b.whereRef("w.number", "<>", "h.number")).orderBy("h.rank", "desc").orderBy("w.id")) as (WorkflowRow & { pr: number | string; rank: number })[];
  for (const { pr, rank: _rank, ...row } of rows) out.set(refKey(row.repo, Number(pr)), workflowOf(row as WorkflowRow));
  return out;
}

/** The PRs of loadStartedWork: of live implement workflows with an attempt still working. */
export async function loadStartedPrs(db: Db): Promise<{ repo: string; pr: number; startedBy: string; approvedBy: string | null }[]> {
  const q = queryDb(db);
  const k = q.k as any;
  const prs = await q.all(k.selectFrom("main.implementations as i").innerJoin("main.item_workflows as w", (j: any) => j.onRef("w.repo", "=", "i.repo").onRef("w.number", "=", "i.number"))
    .select(["i.repo as repo", "i.pr_number as pr", "w.started_by as started_by", "w.approved_by as approved_by"]).distinct()
    .where("i.pr_number", "is not", null).where("i.state", "not in", ENDED_ATTEMPTS).where("w.entry", "=", "implement").where("w.state", "in", LIVE_STATES)) as
    { repo: string; pr: number | string; started_by: string; approved_by: string | null }[];
  return prs.map((r) => ({ repo: r.repo, pr: Number(r.pr), startedBy: r.started_by, approvedBy: r.approved_by }));
}

/** R2 in JS: the PR of the issue's current attempt, or of one that ended in the workflow. */
export function candidatePr(a: IssueAttempt | null | undefined, w: Pick<ItemWorkflow, "startedAt">): number | null {
  if (!a) return null;
  const { state, prNumber, updatedAt } = a.attempt;
  if (prNumber !== null && (!ENDED_STATES.has(state) || updatedAt >= w.startedAt)) return prNumber;
  return a.prAttempts.find((p) => p.createdAt >= w.startedAt)?.prNumber ?? null;
}

/** The PR was merged or closed before the workflow started. */
export const overBefore = (pr: { state: string; closed_at: string | null } | null | undefined, startedAt: string): boolean =>
  !!pr && pr.state !== "OPEN" && pr.closed_at !== null && pr.closed_at < startedAt;
