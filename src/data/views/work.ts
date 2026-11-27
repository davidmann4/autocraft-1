// reads: mirror.items, triage.item_rank, planner.item_plans, workflow.item_workflows, implement.implementations (through the workflow fragment)
// The ranked work list: open items in work order with the parts of the score and the plan's next step and label.
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import type { Ref } from "../keys.ts";
import { inPlanScope } from "../planner/fragments.ts";
import type { RankBreakdown } from "../triage/types.ts";
import { workScores } from "../workflow/fragments.ts";

export type WorkListRow = {
  repo: string; number: number; kind: "pr" | "issue"; title: string; score: number; breakdown: RankBreakdown; next: string | null; label: string | null; itemState: string | null;
};
/** The listed items that share a next step: how many, and, when the asked item is listed, whether it is one of them and how many come before it. */
export type WorkListStep = { next: string | null; count: number; hasItem: boolean; before: number | null };
export type WorkList = { steps: WorkListStep[]; rows: WorkListRow[] };
export type WorkListFilter = {
  repos: string[];
  /** Only items whose stored plan is in the pipeline's scope. */
  scope: boolean;
  /** Rows read of each next step, at least 1: the first `top` rows of any set of steps are among them. */
  top: number;
  item?: Ref | null;
};

/**
 * The open ranked items in work order (the work score of a started item, else its rank; then the rank, the repo and the number), counted per next
 * step, with the first rows of each step. 1 statement.
 */
export async function loadRankedOpen(db: Db, f: WorkListFilter): Promise<WorkList> {
  if (!f.repos.length) return { steps: [], rows: [] };
  const q = queryDb(db);
  const listed = q.k.selectFrom("main.items as i").innerJoin("main.item_rank as r", (j) => j.onRef("r.repo", "=", "i.repo").onRef("r.number", "=", "i.number"))
    .leftJoin("main.item_plans as p", (j) => j.onRef("p.repo", "=", "i.repo").onRef("p.number", "=", "i.number"))
    .leftJoin(workScores(db).as("ws"), (j) => j.onRef("ws.repo", "=", "i.repo").onRef("ws.number", "=", "i.number"))
    .select((eb) => ["i.repo", "i.number", "r.score", eb.fn.coalesce("ws.s", "r.score").as("s"), kx.jsonText(db, "p.view", "$.next").as("next")])
    .where("i.state", "=", "OPEN").where(kx.inList(db, "i.repo", f.repos)).$if(f.scope, (b) => b.where((eb) => inPlanScope(eb, "p")));
  const order = <B>(o: B, t: string): B => (o as any).orderBy(`${t}.s`, "desc").orderBy(`${t}.score`, "desc").orderBy(`${t}.repo`).orderBy(`${t}.number`);
  const placed = q.k.selectFrom(listed.as("l")).select(["l.repo", "l.number", "l.score", "l.s", "l.next"]).select((eb) => [
    eb.fn.agg<number>("row_number").over((o) => order(o.partitionBy("l.next"), "l")).as("rn"),
    eb.fn.countAll<number>().over((o) => o.partitionBy("l.next")).as("n"),
    (f.item ? eb.fn.agg<number>("row_number").over((o) => order(o, "l")) : eb.lit(0)).as("pos"),
  ]);
  const isItem = (eb: any, t: string) => (f.item ? eb.and([eb(`${t}.repo`, "=", f.item.repo), eb(`${t}.number`, "=", f.item.number)]) : eb.val(false));
  const at = q.k.selectFrom(placed.as("a")).selectAll("a").select((eb) => (f.item ? eb.fn.max<number | null>(eb.case().when(isItem(eb, "a")).then(eb.ref("a.pos")).end()).over() : kx.literal(0)).as("item_pos"));
  const counted = q.k.selectFrom(at.as("c")).selectAll("c").select((eb) => [
    (f.item ? eb.fn.sum<number>(eb.case().when("c.pos", "<", eb.ref("c.item_pos")).then(1).else(0).end()).over((o) => o.partitionBy("c.next")) : eb.lit(0)).as("before"),
    (f.item ? eb.fn.max<number>(eb.case().when(isItem(eb, "c")).then(1).else(0).end()).over((o) => o.partitionBy("c.next")) : eb.lit(0)).as("has_item"),
  ]);
  const rows = await q.all(q.k.selectFrom(counted.as("t")).innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "t.repo").onRef("i.number", "=", "t.number"))
    .innerJoin("main.item_rank as r", (j) => j.onRef("r.repo", "=", "t.repo").onRef("r.number", "=", "t.number"))
    .leftJoin("main.item_plans as p", (j) => j.onRef("p.repo", "=", "t.repo").onRef("p.number", "=", "t.number"))
    .select(["t.repo", "t.number", "t.score", "t.next", "t.rn", "t.n", "t.item_pos", "t.before", "t.has_item", "i.kind", "i.title", "r.breakdown", kx.jsonText(db, "p.view", "$.label").as("label"), "p.item_state"])
    .where("t.rn", "<=", f.top).$call((b) => order(b, "t")), { label: "views.loadRankedOpen" });
  const found = f.item ? (rows[0]?.item_pos ?? null) !== null : false;
  return {
    steps: rows.filter((r) => Number(r.rn) === 1).map((r) => ({ next: r.next, count: Number(r.n), hasItem: found && Number(r.has_item) === 1, before: found ? Number(r.before) : null })),
    rows: rows.map((r) => ({
      repo: r.repo, number: Number(r.number), kind: r.kind === "pr" ? "pr" : "issue", title: r.title ?? "", score: r.score, breakdown: JSON.parse(r.breakdown) as RankBreakdown,
      next: r.next, label: r.label, itemState: r.item_state,
    })),
  };
}
