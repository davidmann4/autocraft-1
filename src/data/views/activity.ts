// reads: mirror.items, mirror.comments, mirror.item_activity, planner.stages, planner.plan_history, jobs.job_items, jobs.jobs, inference.agent_runs, inference.agent_run_items, inference.agent_run_tools, changes.model_checks, changes.patch_checks, changes.fixups, changes.ci_fixes, changes.conflict_merges, build.build_tasks, control.push_outcomes, control.audit, review.opus_review_history, review.premerge_reviews, review.postmerge_reviews, merge.verifications, merge.merges, workflow.workflow_events, conversations.conversation_turns
// The activity feed's rows: each wanted source's newest rows at or before the cursor's second, across all visible items, as the stored
// columns (the handler builds events from them). Every source is one statement; the sources of a round run in one wave.
import type { Expression, SelectQueryBuilder, SqlBool } from "kysely";
import { GITHUB_ACTIONS } from "../../github/actions.ts";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb, type QueryDb } from "../../db/query-db.ts";
import { privateStepExpr } from "../build/fragments.ts";
import { runFirst, runVisible } from "../inference/fragments.ts";
import { notArchived } from "../workflow/fragments.ts";
import type { Scope, TraceKind } from "./types.ts";

export type ActivityScope = Pick<Scope, "staff" | "operator" | "hidden" | "own"> & { repos: string[] };
export type SourceId = string;
export type ActivityRow = Record<string, any> & { repo: string; number: number };
export type ActivityRows = { bySource: { source: SourceId; rows: ActivityRow[]; floor: string | null }[] };
export type ActivityQuery = { kinds: Set<TraceKind>; only: boolean; repo: string | null; limit: number; before: { at: string; id: string } | null; writeActions: string[] | null };
export type ActivityStampKey = { kinds: Set<TraceKind>; repo: string | null };

type Cond = (eb: kx.Eb) => Expression<SqlBool>;
const EVERY: Cond = (eb) => eb.and([]);
const T = "t";

type Def = {
  id: SourceId; kinds: TraceKind[]; table: string; time: string;
  q: (db: QueryDb, c: Ctx) => SelectQueryBuilder<any, any, any>;
  /** The rows of the table the source reads, for the feed and its stamp. */
  rows?: Cond;
  repoCol?: string | null; tie?: () => kx.Ex; one?: (r: any) => string;
  /** With Only AutoCraft: null skips the source (its events are people's), a condition narrows it to AutoCraft's rows, EVERY means every row is AutoCraft's. */
  only?: (c: Ctx) => Cond | null;
  /** Rows without a repo column (audit targets) name their item here; null drops the row. */
  of?: (r: any, c: Ctx) => { repo: string; number: number } | null;
};
type Ctx = ActivityScope & { db: QueryDb; only: boolean; repo: string | null; limit: number; before: ActivityQuery["before"]; writeActions: string[] | null };

/** The end of the cursor's second as stored times with a second's precision write it. */
const secondOf = (at: string): string => `${at.slice(0, 19)}Z`;

const byOwn = (col: string): Def["only"] => (c) => (c.own.size ? (eb) => kx.inList(c.db, eb.fn("lower", [col]), [...c.own]) : null);

const item = (id: string, time: "created_at" | "merged_at" | "closed_at", where: (eb: any) => Expression<SqlBool>): Def => ({
  id, kinds: ["github"], table: "items", time, only: () => null,
  q: (db) => db.k.selectFrom("items").select(["repo", "number", "kind", "author", "created_at", "closed_at", "merged_at", "merged_by", "head_oid"]).where(where),
});

/** The ids of the newest visible runs matching `where`, at or before the cursor's second. */
const newestRuns = (c: Ctx, where: (eb: kx.Eb) => Expression<SqlBool>, alias: string) =>
  c.db.k.selectFrom(c.db.k.selectFrom("agent_runs as r").select("r.id").where(where as never).where((eb) => runVisible({ hidden: c.hidden }, eb))
    .$if(c.before !== null, (q) => q.where("r.started_at", "<=", secondOf(c.before!.at)))
    .orderBy("r.started_at", "desc").orderBy("r.id", "desc").limit(c.limit).as(alias)).select(`${alias}.id` as never) as unknown as SelectQueryBuilder<any, any, { id: number }>;

export const SOURCES: Def[] = [
  item("opened", "created_at", (eb) => eb("kind", "is not", null)),
  item("merged", "merged_at", (eb) => eb("merged_at", "is not", null)),
  item("closed", "closed_at", (eb) => eb.and([eb("closed_at", "is not", null), eb("merged_at", "is", null)])),
  { id: "comment", kinds: ["github"], table: "comments", time: "created_at", only: byOwn("author"),
    q: (db) => db.k.selectFrom("comments").select((eb) => ["repo", "number", "id", "kind", "author", "created_at", "review_state", "commit_oid", eb.fn<number>("length", [eb.fn.coalesce("body", eb.val(""))]).as("len")]) },
  { id: "activity", kinds: ["github"], table: "item_activity", time: "at", only: byOwn("actor"),
    q: (db) => db.k.selectFrom("item_activity").select(["repo", "number", "id", "kind", "at", "actor", "label", "after_oid", "before_oid"]) },
  { id: "stage", kinds: ["plan"], table: "stages", time: "at", q: (db) => db.k.selectFrom("stages").select(["repo", "number", kx.rowid("stages").as("rowid"), "stage", "at", "actor", "note"]) },
  { id: "plan", kinds: ["plan"], table: "plan_history", time: "at", q: (db) => db.k.selectFrom("plan_history").select(["repo", "number", "id", "head", "old_state", "new_state", "wait", "reasons", "at"]) },
  // A job over many items is one row of the feed, at its newest item.
  { id: "job", kinds: ["job"], table: "job_items", time: "ji.at", repoCol: "ji.repo", tie: () => kx.rowid("job_items", "ji"), one: (r) => String(r.job_id),
    q: (db) => db.k.selectFrom("job_items as ji").leftJoin("jobs as j", "j.id", "ji.job_id").select(["ji.repo as repo", "ji.number as number", "ji.id", "ji.job_id", "ji.outcome", "ji.at", "j.step", "j.state", "j.error"]) },
  // A run over many items is one row too: its first item. Runs that touched a hidden repo are left out whole.
  { id: "run", kinds: ["model-call"], table: "agent_runs", time: "r.started_at", repoCol: null, tie: () => kx.ref("r.id"),
    q: (db, c) => db.k.selectFrom("agent_runs as r")
      .select((eb) => ["r.id", "r.step", "r.prompt_id", "r.model", "r.provider", "r.state", "r.started_at", "r.ended_at", "r.input_tokens", "r.output_tokens", "r.cost_usd", "r.summary", "r.job_id", "r.user_login", "r.harness", "r.reported_model",
        runFirst(eb, "repo").as("repo"), runFirst(eb, "number").as("number"), db.k.selectFrom("agent_run_tools as t").select((e) => e.fn.countAll<number>().as("n")).where("t.run_id", "=", eb.ref("r.id")).as("tools")])
      // Both parts of a repo's runs come in time order from the index on (first_repo, started_at), so each stops at the limit.
      .where((eb) => c.repo === null ? kx.inList(c.db, runFirst(eb, "repo"), c.repos)
        : c.repos.includes(c.repo) ? eb("r.id", "in", newestRuns(c, (r) => r("r.first_repo", "=", c.repo!), "n").unionAll(newestRuns(c, (r) => r.and([r("r.first_repo", "is", null), r(runFirst(r, "repo"), "=", c.repo!)]), "o")))
          : eb.val(false) as unknown as Expression<SqlBool>)
      .where((eb) => runVisible({ hidden: c.hidden }, eb)) },
  { id: "check", kinds: ["check"], table: "model_checks", time: "started_at", q: (db) => db.k.selectFrom("model_checks").select(["repo", "number", "id", "run_id", "step", "head", "command", "crate", "test_name", "task_id", "outcome", "started_at"]) },
  { id: "task", kinds: ["check"], table: "build_tasks", time: "queued_at", q: (db) => db.k.selectFrom("build_tasks").select(["repo", "number", "id", "job_id", "step", "head_sha", "state", "summary", "queued_at"]).where((eb) => eb.not(privateStepExpr(eb, "step"))) },
  { id: "push", kinds: ["check"], table: "push_outcomes", time: "at", q: (db) => db.k.selectFrom("push_outcomes").select(["repo", "number", "id", "at", "stage", "action", "to_oid", "before_res", "after_res", "outcome"]) },
  { id: "patchcheck", kinds: ["check"], table: "patch_checks", time: "created_at", q: (db) => db.k.selectFrom("patch_checks").select(["repo", "number", "id", "kind", "subject", "round", "verdict", "model", "reasons", "created_at"]) },
  { id: "opus", kinds: ["review"], table: "opus_review_history", time: "at",
    q: (db) => db.k.selectFrom("opus_review_history").select(["repo", "number", kx.rowid("opus_review_history").as("rowid"), "head_oid", "at", "model", "mode", "verdict", "sure", "reason", "risks", "fixes", "claims"]) },
  { id: "premerge", kinds: ["review"], table: "premerge_reviews", time: "at", q: (db) => db.k.selectFrom("premerge_reviews").select(["repo", "number", "head_oid", "at", "model", "findings", "error", "searched"]) },
  { id: "postmerge", kinds: ["review"], table: "postmerge_reviews", time: "at", q: (db) => db.k.selectFrom("postmerge_reviews").select(["repo", "number", "merge_sha", "at", "model", "findings", "error"]) },
  { id: "verify", kinds: ["review"], table: "verifications", time: "created_at", q: (db) => db.k.selectFrom("verifications").select(["repo", "number", "head_sha", "kind", "state", "reason", "summary", "note", "created_at", "head_task_id"]) },
  // The answers, starts, holds and resumes of the item's workflow.
  { id: "workflow", kinds: ["decision"], table: "workflow_events", time: "at", only: () => null, rows: (eb) => notArchived(eb, "kind"),
    q: (db) => db.k.selectFrom("workflow_events").select(["repo", "number", "id", "login", "kind", "line", "at"]).where("kind", "in", ["answered", "started", "stopped", "resumed"]) },
  { id: "fixup", kinds: ["step"], table: "fixups", time: "created_at", q: (db) => db.k.selectFrom("fixups").select(["repo", "number", kx.rowid("fixups").as("rowid"), "from_head as head", "to_head", "state", "reason", "files", "attempt", "created_at"]) },
  { id: "cifix", kinds: ["step"], table: "ci_fixes", time: "created_at", q: (db) => db.k.selectFrom("ci_fixes").select(["repo", "number", kx.rowid("ci_fixes").as("rowid"), "head", "to_head", "kind", "state", "reason", "files", "attempt", "task_id", "created_at"]) },
  { id: "conflict", kinds: ["step"], table: "conflict_merges", time: "created_at", q: (db) => db.k.selectFrom("conflict_merges").select(["repo", "number", kx.rowid("conflict_merges").as("rowid"), "from_head as head", "to_head", "state", "reason", "files", "attempt", "created_at"]) },
  { id: "merge", kinds: ["step"], table: "merges", time: "at", q: (db) => db.k.selectFrom("merges").select(["repo", "number", kx.rowid("merges").as("rowid"), "head_oid", "at", "path", "method", "outcome", "reason"]) },
  { id: "turn", kinds: ["conversation"], table: "conversation_turns", time: "at", only: () => (eb) => eb("kind", "in", ["opus", "system"]),
    q: (db) => db.k.selectFrom("conversation_turns").select((eb) => ["repo", "number", "id", "kind", "login", "at", eb.fn<number>("length", ["body"]).as("len"), "status"]) },
  // Audit rows name their item in `target` (`repo#number`); other targets are not items.
  { id: "write", kinds: ["write"], table: "audit", time: "at", repoCol: null,
    q: (db, c) => db.k.selectFrom("audit").select([kx.rowid("audit").as("rowid"), "at", "login", "action", "details", "target"])
      .where((eb) => eb(eb.fn<number>("instr", ["target", eb.val("#")]), ">", eb.lit(0)))
      .$if(!!c.writeActions, (q) => q.where(kx.inList(db, "action", c.writeActions!)))
      .$if(!!c.repo, (q) => q.where((eb) => eb(eb.fn<string>("substr", ["target", eb.lit(1), eb.lit(c.repo!.length + 1)]), "=", `${c.repo}#`))),
    // A write is AutoCraft's when the viewer is not staff (the actor is hidden) or the pipeline recorded a state with it (writeEvent).
    only: (c) => (c.staff
      ? (eb) => eb.and([eb(eb.case().when(kx.jsonValid(c.db, "details")).then(kx.jsonType(c.db, "details", "$.state")).end(), "in", ["text", "object", "array"]), kx.inList(c.db, "action", Object.keys(GITHUB_ACTIONS))])
      : EVERY),
    of: (r, c) => {
      const i = r.target.lastIndexOf("#"), n = Number(r.target.slice(i + 1)), repo = r.target.slice(0, i);
      return Number.isInteger(n) && repo && c.repos.includes(repo) ? { repo, number: n } : null;
    } },
];

/** The sources that serve any of `kinds`. */
export const sourcesOf = (kinds: Set<TraceKind>): Def[] => SOURCES.filter((s) => s.kinds.some((k) => kinds.has(k)));

const iso = (at: unknown): string | null => { const t = typeof at === "string" ? Date.parse(at) : NaN; return Number.isNaN(t) ? null : new Date(t).toISOString(); };

/** Newest `limit` rows of one source at or before the cursor's second (the stored times mix second and millisecond precision). */
async function newest(c: Ctx, s: Def): Promise<{ source: SourceId; rows: ActivityRow[]; floor: string | null }> {
  const repoCol = s.repoCol === undefined ? "repo" : s.repoCol;
  const own = c.only ? s.only?.(c) : undefined;
  if (own === null) return { source: s.id, rows: [], floor: null };
  const before = c.before ? secondOf(c.before.at) : null;
  // Only visible (tracked, readable) repos are read. The function around the column keeps the planner on the time index instead of a repo index plus a sort.
  // No `repoCol`: the repo is not a column (audit targets), so `of` filters it.
  const raw = await c.db.all(s.q(c.db, c).select((eb: kx.Eb) => eb.ref(s.time).as(T)).where(s.time, "is not", null)
    .$if(!!s.rows, (q: any) => q.where(s.rows!))
    .$if(!!own, (q: any) => q.where(own!))
    .$if(before !== null, (q: any) => q.where(s.time, "<=", before))
    .$if(!!(repoCol && c.repo), (q: any) => q.where(repoCol!, "=", c.repo!))
    .$if(!!repoCol, (q: any) => q.where((eb: kx.Eb) => kx.inList(c.db, eb.fn.coalesce(repoCol!, repoCol!), c.repos)))
    .orderBy(s.time, "desc").$if(s.tie !== undefined, (q: any) => q.orderBy(s.tie!(), "desc")).limit(c.limit)) as ActivityRow[];
  const seen = new Set<string>();
  const rows: ActivityRow[] = [];
  for (const r of raw) {
    if (s.one) { const k = s.one(r); if (seen.has(k)) continue; seen.add(k); }
    const at = s.of ? s.of(r, c) : r;
    if (at) rows.push({ ...r, repo: at.repo, number: at.number });
  }
  return { source: s.id, rows, floor: raw.length >= c.limit ? iso(raw[raw.length - 1]![T]) : null };
}

/** One round: every wanted source's newest rows before the cursor, in one wave. */
export async function loadActivityRound(db: Db, scope: ActivityScope, q: ActivityQuery): Promise<ActivityRows> {
  const c: Ctx = { ...scope, db: queryDb(db), only: q.only, repo: q.repo, limit: q.limit, before: q.before, writeActions: q.writeActions };
  return { bySource: await db.together(() => Promise.all(sourcesOf(q.kinds).map((s) => newest(c, s)))) };
}

/** The newest time of each wanted source's table and the counts of running calls, active jobs and active tasks, in one statement. */
export async function loadActivityStamp(db: Db, key: ActivityStampKey): Promise<unknown[]> {
  const { k } = queryDb(db);
  const probes = [
    ...sourcesOf(key.kinds).map((s) => k.selectFrom(s.table as "items").select((eb) => eb.fn.max<string | null>(kx.ref(s.time.replace(/^\w+\./, ""))).as("m")).$if(!!s.rows, (q: any) => q.where(s.rows!))),
    k.selectFrom("agent_runs").select((eb) => eb.fn.countAll<number>().as("n")).where("state", "=", "running"),
    k.selectFrom("jobs").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max<number | null>("id").as("newest")]).where("state", "in", ["queued", "running"]),
    k.selectFrom("build_tasks").select((eb) => eb.fn.countAll<number>().as("n")).where("state", "in", ["queued", "claimed", "running"]),
  ];
  return (await kx.rowValues(db, probes as SelectQueryBuilder<any, any, any>[]));
}
