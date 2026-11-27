// reads: implement.implementations, mirror.items
// The PR an implement workflow works on: `item_workflows.pr_number`, and for a row without it the PR it would be linked to (fragments.ts worksOnPr).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { resolveKeys, type Ref } from "../keys.ts";
import { linkingAttempt, linkRows, LIVE_STATES, prOverBefore } from "./fragments.ts";
import type { WorkflowLink } from "./types.ts";

type Row = { wid: number | string; repo: string; issue: number | string; pr: number | string; live: number | boolean };
const linkOf = (r: Row): WorkflowLink => ({ workflowId: Number(r.wid), repo: r.repo, issue: Number(r.issue), pr: Number(r.pr), live: r.live === true || Number(r.live) === 1 });

/** The PRs that live implement workflows work on (`ended`: the ended ones too), by workflow, by PR or by issue; a workflow without one is absent. Ordered by workflow id. One statement. */
export async function loadLinks(db: Db, f: { workflowIds: number[] } | { prs: Ref[] } | { issues: Ref[] }, o: { ended?: true } = {}): Promise<WorkflowLink[]> {
  const by = "workflowIds" in f ? { ids: f.workflowIds } : f;
  if (Object.values(by).every((x) => x.length === 0)) return [];
  const q = queryDb(db);
  return (await q.all((q.k as any).selectFrom(linkRows(db, o.ended ? null : LIVE_STATES, by).as("l")).selectAll("l").orderBy("l.wid")) as Row[]).map(linkOf);
}

/**
 * Links implement workflows, live and ended, to the PR their issue's attempts opened for them (fragments.ts linkingAttempt): one without a link,
 * and one whose PR is older than the newest. The only writer of `item_workflows.pr_number`, and it never clears it. Runs where an attempt opens
 * its PR and where a workflow starts, and over every workflow on the runner's tick, for rows written without it. `updated_at` stays: a command
 * or pass that read the workflow before still applies. Returns the links written; writes nothing when all are up to date. Joins the caller's
 * `db.write`.
 */
export async function linkWorkflows(db: Db, f: { ids?: number[]; issues?: Ref[] } = {}): Promise<WorkflowLink[]> {
  if (f.ids?.length === 0 || f.issues?.length === 0) return [];
  const q = queryDb(db);
  const k = q.k as any;
  const linked = k.selectFrom("main.implementations as la").select((eb: any) => eb.fn.max("la.id").as("id"))
    .whereRef("la.repo", "=", "w.repo").whereRef("la.number", "=", "w.number").whereRef("la.pr_number", "=", "w.pr_number");
  const due = await q.all(k.selectFrom("main.item_workflows as w").innerJoin("main.implementations as i", (j: any) => j.onRef("i.repo", "=", "w.repo").onRef("i.number", "=", "w.number"))
    .$if(!!f.issues, (b: any) => b.innerJoin(resolveKeys(db, f.issues!, "ki"), (j: any) => j.onRef("ki.repo", "=", "w.repo").onRef("ki.number", "=", "w.number")))
    .$if(!!f.ids, (b: any) => b.where(kx.inList(db, "w.id", f.ids!, "bigint")))
    .where("w.entry", "=", "implement")
    .where((eb: any) => eb.or([eb("w.pr_number", "is", null), eb.and([eb("w.pr_number", "<>", eb.ref("i.pr_number")), eb("i.id", ">", eb.fn.coalesce(linked, eb.lit(0)))])]))
    .where((eb: any) => linkingAttempt(eb, "i", "w")).where((eb: any) => eb.not(prOverBefore(eb, "w", "i.pr_number")))
    .select((eb: any) => ["w.id as wid", "w.repo as repo", "w.number as issue", "i.pr_number as pr", "w.pr_number as was", eb.case().when("w.state", "in", LIVE_STATES).then(eb.lit(1)).else(eb.lit(0)).end().as("live")])
    .orderBy("w.id")) as (Row & { was: number | string | null })[];
  if (due.length === 0) return [];
  // Compare-and-set on the PR it was read with (0: none).
  return await db.write(async () => {
    const done = new Set<number>();
    for (const part of kx.chunks(due)) {
      const v = kx.valuesTable(db, part.map((r) => ({ id: Number(r.wid), pr: Number(r.pr), was: Number(r.was ?? 0) })), { id: "bigint", pr: "bigint", was: "bigint" }, "v");
      const got = await q.all(k.updateTable("main.item_workflows").from(v).set((eb: any) => ({ pr_number: eb.ref("v.pr") }))
        .where((eb: any) => eb.and([eb("item_workflows.id", "=", eb.ref("v.id")), eb(eb.fn.coalesce("item_workflows.pr_number", eb.lit(0)), "=", eb.ref("v.was"))]))
        .returning("item_workflows.id as id")) as { id: number | string }[];
      for (const r of got) done.add(Number(r.id));
    }
    return due.filter((r) => done.has(Number(r.wid))).map(linkOf);
  });
}
