// PR builds (`pr_builds`) (package merge-b).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { createTasks } from "../build/index.ts";
import { taskStateExpr } from "../build/fragments.ts";
import { itemHead, openItem, checksOverallAt } from "../mirror/fragments.ts";
import { headOf, refOf } from "./read.ts";
import { nowIso, settleByHead, splitHead } from "./settle.ts";
import type { HeadRef, LateDisagreement, NewPrBuild, PendingBuild, PrBuildSettle, PrBuildView, RefKey } from "./types.ts";

/** Below Verify's tasks (0), above the warm build (-10). */
const PR_BUILD_PRIORITY = -5;
const STEP = "pr-build";

type Row = {
  repo: string; number: number; head_sha: string; base_sha: string | null; scope: string; task_id: number | null; retried: number; state: string;
  summary: string | null; ci_overall: string | null; disagree: number; created_at: string; finished_at: string | null;
  task_state: string | null;
};
const COLUMNS = ["repo", "number", "head_sha", "base_sha", "scope", "task_id", "retried", "state", "summary", "ci_overall", "disagree", "created_at", "finished_at"] as const;
const cols = COLUMNS.map((c) => `b.${c}` as const);

const viewOf = (r: Row): PrBuildView => ({
  repo: r.repo, number: r.number, headSha: r.head_sha, baseSha: r.base_sha, scope: r.scope, taskId: r.task_id, retried: r.retried, state: r.state, summary: r.summary,
  ciOverall: r.ci_overall, disagree: Number(r.disagree) === 1, createdAt: r.created_at, finishedAt: r.finished_at,
  taskState: r.task_state,
});

/** The state of a queued row's task; a row that has ended needs none. */
const taskState = (eb: any, row: string) => eb.case().when(`${row}.state`, "=", "queued").then(taskStateExpr(eb, `${row}.task_id`)).end().as("task_state");

/**
 * Per item the build of its head, else its newest build, with the task state of a queued one. Without `head` it is the item's
 * head in the mirror; null means the newest build. 1 statement.
 */
export async function loadPrBuildViews(db: Db, items: { ref: RefKey; head?: string | null }[]): Promise<Map<RefKey, PrBuildView>> {
  if (items.length === 0) return new Map();
  const q = queryDb(db);
  const k = q.k as any;
  const want = items.map((i) => { const at = i.ref.lastIndexOf("#"); return { repo: i.ref.slice(0, at), number: Number(i.ref.slice(at + 1)), head: i.head ?? null, mirrored: i.head === undefined ? 1 : 0 }; });
  const rows = await q.all(k.selectFrom((eb: any) => eb.selectFrom("pr_builds as b")
    .innerJoin(kx.valuesTable(db, want, { repo: "text", number: "bigint", head: "text", mirrored: "bigint" }, "kk"), (j: any) => j.onRef("kk.repo", "=", "b.repo").onRef("kk.number", "=", "b.number"))
    .select((e: any) => [...cols, e.fn.agg("row_number").over((o: any) => o.partitionBy(["b.repo", "b.number"])
      .orderBy(e.case().when("b.head_sha", "=", e.case().when("kk.mirrored", "=", 1).then(itemHead(e, "b.repo", "b.number")).else(e.ref("kk.head")).end()).then(e.lit(0)).else(e.lit(1)).end()).orderBy("b.created_at", "desc")).as("rn")]).as("t"))
    .selectAll("t").select((eb: any) => taskState(eb, "t")).where("rn", "=", 1)) as (Row & { rn: number })[];
  return new Map(rows.map((r) => [refOf(r.repo, r.number), viewOf(r)]));
}

/** Per repo the builds created after `sinceMs` (epoch ms) and the `number@head` set it already has. 2 statements in one wave. */
export async function loadPrBuildStates(db: Db, repos: readonly string[], sinceMs: number): Promise<Map<string, { usedSince: number; have: Set<string> }>> {
  const out = new Map<string, { usedSince: number; have: Set<string> }>(repos.map((r) => [r, { usedSince: 0, have: new Set() }]));
  if (!repos.length) return out;
  const q = queryDb(db);
  const [used, have] = await db.together(() => Promise.all([
    q.all(q.k.selectFrom("pr_builds").select((eb) => ["repo", eb.fn.countAll<number>().as("n")]).where(kx.inList(db, "repo", [...repos])).where("created_at", ">", new Date(sinceMs).toISOString()).groupBy("repo")),
    q.all(q.k.selectFrom("pr_builds").select(["repo", "number", "head_sha"]).where(kx.inList(db, "repo", [...repos]))),
  ]));
  for (const r of used) out.get(r.repo)!.usedSince = Number(r.n);
  for (const r of have) out.get(r.repo)!.have.add(`${r.number}@${r.head_sha}`);
  return out;
}

/** Queued builds (of `repo`, or all) with the item's and the task's state and the item's head, oldest first. 1 statement. */
export async function loadPendingPrBuilds(db: Db, repo?: string): Promise<PendingBuild[]> {
  const q = queryDb(db);
  const rows = await q.all((q.k as any).selectFrom("pr_builds as b")
    .select((eb: any) => [...cols, openItem(eb, "b.repo", "b.number").as("is_open"), itemHead(eb, "b.repo", "b.number").as("item_head"), taskState(eb, "b")])
    .where("b.state", "=", "queued")
    .$if(!!repo, (s: any) => s.where("b.repo", "=", repo!))
    .orderBy("b.created_at").orderBy("b.number")) as (Row & { is_open: unknown; item_head: string | null })[];
  return rows.map((r) => ({ ...viewOf(r), itemState: r.is_open ? "OPEN" as const : "CLOSED" as const, currentHead: r.item_head }));
}

/** Failed builds whose CI turned green at the same head since the build ended and that are not yet flagged. */
export async function loadLateDisagreements(db: Db, repo?: string): Promise<LateDisagreement[]> {
  const q = queryDb(db);
  const rows = await q.all((q.k as any).selectFrom("pr_builds as b").select(["b.repo", "b.number", "b.head_sha", "b.summary"])
    .where("b.state", "=", "failed").where("b.disagree", "=", 0)
    .where((eb: any) => eb(checksOverallAt(eb, "b.repo", "b.number", "b.head_sha"), "=", "success"))
    .$if(!!repo, (s: any) => s.where("b.repo", "=", repo!))
    .orderBy("b.repo").orderBy("b.number")) as { repo: string; number: number; head_sha: string; summary: string | null }[];
  return rows.map((r) => ({ repo: r.repo, number: r.number, head: r.head_sha, summary: r.summary }));
}

/**
 * In one `db.write`: inserts a row per head with no task, creates the build tasks of the rows that were new, and links them.
 * Heads that already have a row are left alone. Returns the task id per head newly queued.
 */
export async function queuePrBuilds(db: Db, rows: NewPrBuild[]): Promise<Map<HeadRef, number>> {
  const out = new Map<HeadRef, number>();
  if (rows.length === 0) return out;
  const q = queryDb(db);
  const byKey = new Map<HeadRef, NewPrBuild>();
  for (const r of rows) byKey.set(headOf(r.repo, r.number, r.head), r);
  const list = [...byKey.values()];
  await db.write(async () => {
    const at = nowIso();
    const fresh: NewPrBuild[] = [];
    for (const values of kx.batches(list.map((r) => ({ repo: r.repo, number: r.number, head_sha: r.head, scope: r.scope, state: "queued", created_at: at })))) {
      const inserted = await q.all(q.k.insertInto("pr_builds").values(values).onConflict((oc) => oc.doNothing()).returning(["repo", "number", "head_sha"]));
      for (const i of inserted) fresh.push(byKey.get(headOf(i.repo, i.number, i.head_sha))!);
    }
    if (fresh.length === 0) return;
    const ids = await createTasks(db, fresh.map((r) => ({
      jobId: r.jobId, step: STEP, repo: r.repo, number: r.number, headSha: r.head, baseSha: r.base, priority: PR_BUILD_PRIORITY, plan: r.plan,
      requires: { os: "linux", toolchains: ["rust-stable"] }, ...(r.warm ? { warm: r.warm } : {}),
    })));
    await kx.updateFrom(db, "pr_builds", ["repo", "number", "head_sha"], fresh.map((r, i) => ({ repo: r.repo, number: r.number, head_sha: r.head, task_id: ids[i]! })));
    fresh.forEach((r, i) => out.set(headOf(r.repo, r.number, r.head), ids[i]!));
  });
  return out;
}

/** Records builds that could not be queued, as `error` rows; a head that has a row keeps it. */
export async function savePrBuildErrors(db: Db, rows: { repo: string; number: number; head: string; scope: string; summary: string }[]): Promise<void> {
  if (rows.length === 0) return;
  const q = queryDb(db);
  const at = nowIso();
  await db.write(async () => {
    const seen = new Map(rows.map((r) => [headOf(r.repo, r.number, r.head), r]));
    for (const values of kx.batches([...seen.values()].map((r) => ({ repo: r.repo, number: r.number, head_sha: r.head, scope: r.scope, state: "error", summary: r.summary, created_at: at, finished_at: at }))))
      await q.run(q.k.insertInto("pr_builds").values(values).onConflict((oc) => oc.doNothing()));
  });
}

/**
 * Compare-and-set settle: a row changes only while its state is `from` (any state when omitted). A `disagree` flag is set once: a row
 * that already has it keeps its state and stays out of the result. Returns the keys changed.
 */
export async function settlePrBuilds(db: Db, rows: PrBuildSettle[]): Promise<Set<HeadRef>> {
  return await settleByHead(db, "pr_builds", { state: "text", summary: "text", ci_overall: "text", disagree: "bigint", finished_at: "text" }, rows.map((r) => ({
    key: r.key, ...(r.from ? { from: [r.from] } : {}), ...(r.set.disagree ? { guard: { disagree: 0 } } : {}),
    set: {
      state: r.set.state,
      ...(r.set.summary !== undefined ? { summary: r.set.summary } : {}),
      ...(r.set.ciOverall !== undefined ? { ci_overall: r.set.ciOverall } : {}),
      ...(r.set.disagree !== undefined ? { disagree: r.set.disagree ? 1 : 0 } : {}),
      ...(r.set.finishedAt !== undefined ? { finished_at: r.set.finishedAt } : {}),
    },
  })));
}

/** Retry: points each build at its new task and adds one to `retried`. */
export async function restartPrBuilds(db: Db, rows: { key: HeadRef; taskId: number }[]): Promise<void> {
  if (rows.length === 0) return;
  const q = queryDb(db);
  const k = q.k as any;
  const byKey = new Map(rows.map((r) => [r.key, r]));
  await db.write(async () => {
    for (const chunk of kx.chunks([...byKey.values()])) {
      const v = kx.valuesTable(db, chunk.map((r) => ({ ...splitHead(r.key), task_id: r.taskId })), { repo: "text", number: "bigint", head: "text", task_id: "bigint" }, "v");
      await q.run(k.updateTable("pr_builds").from(v)
        .set((eb: any) => ({ task_id: eb.ref("v.task_id"), retried: eb("pr_builds.retried", "+", 1) }))
        .where((eb: any) => eb.and([eb("pr_builds.repo", "=", eb.ref("v.repo")), eb("pr_builds.number", "=", eb.ref("v.number")), eb("pr_builds.head_sha", "=", eb.ref("v.head"))])));
    }
  });
}
