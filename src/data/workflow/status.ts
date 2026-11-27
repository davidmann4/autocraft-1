// The PR status comment (M11 workflow-b).
// reads: mirror.items
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { workflowOf } from "./rows.ts";
import type { ItemWorkflow, RefKey, StatusRow } from "./types.ts";

const T = "main.pr_status_comments";
/** The line of a comment on a closed item; it is final until the item is open again. */
const CLOSED_LINE = "Closed";

/** Rows not final, by number, leaving out a Closed line on an item that is closed. */
export async function loadStatusComments(db: Db, repos: readonly string[]): Promise<StatusRow[]> {
  if (!repos.length) return [];
  const q = queryDb(db);
  return await q.all(q.k.selectFrom("main.pr_status_comments as c").select(kx.cols(T, "c")).where(kx.inList(db, "c.repo", [...repos])).where("c.final", "=", 0)
    .where((eb) => eb.not(eb.and([eb("c.line", "=", CLOSED_LINE), eb.exists(kx.schemaEb(eb).selectFrom("main.items as ci").select(eb.lit(1).as("one"))
      .where("ci.repo", "=", kx.ref<string>("c.repo")).where("ci.number", "=", kx.ref<number>("c.number")).where("ci.state", "=", "CLOSED"))])))
    .orderBy("c.repo").orderBy("c.number")) as StatusRow[];
}

/** Each started item's latest workflow in the repos, with whether the item is open; none where the automatic merge rule took the PR back from it. */
export async function loadLatestWorkflows(db: Db, repos: readonly string[]): Promise<Map<RefKey, { wf: ItemWorkflow; open: boolean }>> {
  if (!repos.length) return new Map();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.item_workflows as w").innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "w.repo").onRef("i.number", "=", "w.number"))
    .selectAll("w").select("i.state as item_state").where(kx.inList(db, "w.repo", [...repos]))
    .where("w.id", "=", (eb) => kx.schemaEb(eb).selectFrom("main.item_workflows as m").select((e) => e.fn.max("m.id").as("id")).where("m.repo", "=", kx.ref<string>("w.repo")).where("m.number", "=", kx.ref<number>("w.number")))
    .where("w.state", "<>", "superseded")
    .orderBy("w.id"));
  return new Map(rows.map((r) => [`${r.repo}#${r.number}`, { wf: workflowOf(r), open: r.item_state === "OPEN" }]));
}

/** Batched upsert of whole rows, one per item (the last given wins). */
export async function saveStatusComments(db: Db, rows: StatusRow[]): Promise<void> {
  const unique = [...new Map(rows.map((r) => [`${r.repo}#${r.number}`, r])).values()];
  if (!unique.length) return;
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.batches(unique)) {
      await q.run(q.k.insertInto(T).values(part).onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet(kx.excluded(["comment_id", "author", "line", "steps", "final", "failures", "retry_at", "updated_at"]))));
    }
  });
}

/** The earliest end of a failure backoff of each repo's comments after `nowMs`, as epoch milliseconds; a repo without one is absent. */
export async function loadStatusRetriesAt(db: Db, repos: readonly string[], nowMs: number): Promise<Map<string, number>> {
  if (!repos.length) return new Map();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom(T).select((eb) => ["repo", eb.fn.min("retry_at").as("at")]).where(kx.inList(db, "repo", [...repos])).where("final", "=", 0).where("retry_at", ">", new Date(nowMs).toISOString()).groupBy("repo"));
  return new Map(rows.flatMap((r) => (r.at ? [[r.repo, Date.parse(r.at)] as const] : [])));
}

/** Backoffs that have ended, across repos, for the lane fingerprint. */
export async function countStatusRetriesDue(db: Db, nowMs: number): Promise<number> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom(T).select((eb) => eb.fn.countAll().as("n")).where("final", "=", 0).where("retry_at", "<=", new Date(nowMs).toISOString()));
  return Number(r?.n ?? 0);
}

/** The GitHub id of each item's status comment (the number in its #issuecomment- URL), by `repo#number`; an item without a known one is absent. */
export async function loadStatusCommentIds(db: Db, refs: readonly RefKey[]): Promise<Map<RefKey, string>> {
  if (!refs.length) return new Map();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.pr_status_comments as c").select(["c.repo", "c.number", "c.comment_id"]).where(kx.refIn(db, "c", refs)).where("c.comment_id", "is not", null),
    { label: "workflow.loadStatusCommentIds" });
  return new Map(rows.map((r) => [`${r.repo}#${Number(r.number)}` as RefKey, String(r.comment_id)]));
}
