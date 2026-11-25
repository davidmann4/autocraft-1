// Rows of the maintainer workflow: item_workflows (one live row per started item), workflow_events (what people did to it)
// and the per-repo switch tracked_repos.workflow. Callers change a row only through the command core; this module only
// reads and writes. Every write moves updated_at, which is bookkeeping for the live topic `workflows` (src/live.ts): a
// write that changes nothing else does not wake the planner.
import type { Selectable } from "kysely";
import type { RepoWorkflow } from "../core/plan.ts";
import type { Db } from "../db/index.ts";
import type { DB } from "../db/types.ts";
import type { Blocker, Entry, ItemKind, ItemWorkflow, Parsed, PlanPart, Recommendation, Surface, WorkflowEventKind, WorkflowState } from "./types.ts";
import { WEIGHT_NORMAL } from "./types.ts";

/** States of a live row; the unique index item_workflows_live allows one per item. */
export const LIVE_STATES = ["running", "waiting", "blocked", "recommending"] as const satisfies readonly WorkflowState[];
export const isLive = (s: WorkflowState): boolean => (LIVE_STATES as readonly string[]).includes(s);

/** Which model a tracked repo runs: `legacy` (the decision pipeline) or `new` (the maintainer workflow). */
export type { RepoWorkflow };

type Row = Selectable<DB["main.item_workflows"]>;

const json = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export function workflowOf(r: Row): ItemWorkflow {
  return {
    id: r.id, repo: r.repo, number: r.number, kind: r.kind as ItemKind, entry: r.entry as Entry, weight: r.weight, state: r.state as WorkflowState,
    startedBy: r.started_by, startedAt: r.started_at, startedVia: r.started_via as Surface, baseHead: r.base_head,
    approvedBy: r.approved_by, approvedAt: r.approved_at, approvedVia: r.approved_via as Surface | null,
    stoppedBy: r.stopped_by, stoppedAt: r.stopped_at,
    blocker: r.blocker as Blocker | null, blockerParams: json<Record<string, unknown> | null>(r.blocker_params, null),
    rec: json<Recommendation | null>(r.rec, null), recAt: r.rec_at, recHead: r.rec_head,
    plan: json<PlanPart[]>(r.plan, []), step: r.step, legacyPreapprovalId: r.legacy_preapproval_id, updatedAt: r.updated_at,
  };
}

const rows = (db: Db) => db.k.selectFrom("main.item_workflows").selectAll();

/** The item's live workflow, if it has one. */
export async function liveWorkflow(db: Db, repo: string, number: number): Promise<ItemWorkflow | null> {
  const r = await db.get(rows(db).where("repo", "=", repo).where("number", "=", number).where("state", "in", LIVE_STATES));
  return r ? workflowOf(r) : null;
}

/** Live workflows, of one repo when given, oldest first. */
export async function liveWorkflows(db: Db, repo?: string): Promise<ItemWorkflow[]> {
  let q = rows(db).where("state", "in", LIVE_STATES);
  if (repo !== undefined) q = q.where("repo", "=", repo);
  return (await db.all(q.orderBy("id"))).map(workflowOf);
}

/** Every workflow the item has had, oldest first. */
export async function workflowHistory(db: Db, repo: string, number: number): Promise<ItemWorkflow[]> {
  return (await db.all(rows(db).where("repo", "=", repo).where("number", "=", number).orderBy("id"))).map(workflowOf);
}

export type NewWorkflow = Pick<ItemWorkflow, "repo" | "number" | "kind" | "entry" | "state" | "startedBy" | "startedAt" | "startedVia">
  & Partial<Omit<ItemWorkflow, "id" | "updatedAt" | "repo" | "number" | "kind" | "entry" | "state" | "startedBy" | "startedAt" | "startedVia">>;

/** Inserts a workflow and returns its id. The unique index refuses a second live row for the item. */
export async function insertWorkflow(db: Db, w: NewWorkflow, at = new Date().toISOString()): Promise<number> {
  const r = await db.get(db.k.insertInto("main.item_workflows").values({
    repo: w.repo, number: w.number, kind: w.kind, entry: w.entry, weight: w.weight ?? WEIGHT_NORMAL, state: w.state,
    started_by: w.startedBy, started_at: w.startedAt, started_via: w.startedVia, base_head: w.baseHead ?? null,
    approved_by: w.approvedBy ?? null, approved_at: w.approvedAt ?? null, approved_via: w.approvedVia ?? null,
    stopped_by: w.stoppedBy ?? null, stopped_at: w.stoppedAt ?? null,
    blocker: w.blocker ?? null, blocker_params: w.blockerParams ? JSON.stringify(w.blockerParams) : null,
    rec: w.rec ? JSON.stringify(w.rec) : null, rec_at: w.recAt ?? null, rec_head: w.recHead ?? null,
    plan: JSON.stringify(w.plan ?? []), step: w.step ?? null, legacy_preapproval_id: w.legacyPreapprovalId ?? null, updated_at: at,
  }).returning("id"));
  return r!.id;
}

export type WorkflowPatch = Partial<Omit<ItemWorkflow, "id" | "repo" | "number" | "kind" | "startedBy" | "startedAt" | "startedVia" | "updatedAt">>;

/** Writes the given fields of a workflow; returns false when no row has the id. */
export async function updateWorkflow(db: Db, id: number, p: WorkflowPatch, at = new Date().toISOString()): Promise<boolean> {
  const set: Partial<Row> = { updated_at: at };
  if (p.entry !== undefined) set.entry = p.entry;
  if (p.weight !== undefined) set.weight = p.weight;
  if (p.state !== undefined) set.state = p.state;
  if (p.baseHead !== undefined) set.base_head = p.baseHead;
  if (p.approvedBy !== undefined) set.approved_by = p.approvedBy;
  if (p.approvedAt !== undefined) set.approved_at = p.approvedAt;
  if (p.approvedVia !== undefined) set.approved_via = p.approvedVia;
  if (p.stoppedBy !== undefined) set.stopped_by = p.stoppedBy;
  if (p.stoppedAt !== undefined) set.stopped_at = p.stoppedAt;
  if (p.blocker !== undefined) set.blocker = p.blocker;
  if (p.blockerParams !== undefined) set.blocker_params = p.blockerParams ? JSON.stringify(p.blockerParams) : null;
  if (p.rec !== undefined) set.rec = p.rec ? JSON.stringify(p.rec) : null;
  if (p.recAt !== undefined) set.rec_at = p.recAt;
  if (p.recHead !== undefined) set.rec_head = p.recHead;
  if (p.plan !== undefined) set.plan = JSON.stringify(p.plan);
  if (p.step !== undefined) set.step = p.step;
  if (p.legacyPreapprovalId !== undefined) set.legacy_preapproval_id = p.legacyPreapprovalId;
  return (await db.run(db.k.updateTable("main.item_workflows").set(set).where("id", "=", id))).changes === 1;
}

export type WorkflowEvent = {
  workflowId: number | null; repo: string; number: number; login: string; via: Surface; kind: WorkflowEventKind;
  parsed?: Parsed | null; line?: string | null; at?: string;
};

export async function addEvent(db: Db, e: WorkflowEvent): Promise<void> {
  await db.run(db.k.insertInto("main.workflow_events").values({
    workflow_id: e.workflowId, repo: e.repo, number: e.number, login: e.login, via: e.via, kind: e.kind,
    parsed: e.parsed ? JSON.stringify(e.parsed) : null, line: e.line ?? null, at: e.at ?? new Date().toISOString(),
  }));
}

export type StoredEvent = Required<Omit<WorkflowEvent, "parsed">> & { id: number; parsed: Parsed | null };

/** The item's events, oldest first. */
export async function eventsOf(db: Db, repo: string, number: number): Promise<StoredEvent[]> {
  const rs = await db.all(db.k.selectFrom("main.workflow_events").selectAll().where("repo", "=", repo).where("number", "=", number).orderBy("id"));
  return rs.map((r) => ({
    id: r.id, workflowId: r.workflow_id, repo: r.repo, number: r.number, login: r.login, via: r.via as Surface, kind: r.kind as WorkflowEventKind,
    parsed: json<Parsed | null>(r.parsed, null), line: r.line, at: r.at,
  }));
}

/** The repo's model; an untracked repo reads as legacy. */
export async function repoWorkflow(db: Db, repo: string): Promise<RepoWorkflow> {
  const r = await db.get(db.k.selectFrom("main.tracked_repos").select("workflow").where("name", "=", repo));
  return r?.workflow === "new" ? "new" : "legacy";
}

/** Every tracked repo with its model, by name. */
export async function repoWorkflows(db: Db): Promise<{ repo: string; workflow: RepoWorkflow }[]> {
  const rs = await db.all(db.k.selectFrom("main.tracked_repos").select(["name", "workflow"]).orderBy("name"));
  return rs.map((r) => ({ repo: r.name, workflow: r.workflow === "new" ? "new" : "legacy" }));
}

/** When the login was last sent a "link your account" reply, if ever. */
export async function lastNudge(db: Db, login: string): Promise<string | null> {
  return (await db.get(db.k.selectFrom("main.github_link_nudges").select("at").where("login", "=", login)))?.at ?? null;
}

export async function recordNudge(db: Db, login: string, at = new Date().toISOString()): Promise<void> {
  await db.run(db.k.insertInto("main.github_link_nudges").values({ login, at }).onConflict((oc) => oc.column("login").doUpdateSet({ at })));
}

/** What a pre-approved merge needs to know of the maintainer workflow it is the merge leg of. */
export type LegContext = {
  workflowId: number;
  entry: Entry;
  /** When a person last started the workflow or answered its recommendation: what they had seen by then, they chose to go on with. */
  since: string;
};

/**
 * The events that say a person chose to go on with what the workflow showed them: its start, and an answer to its recommendation
 * (also one that approves the merge). A plain approval with no recommendation open is not one: it does not accept a review nobody
 * was shown.
 */
export const GO_ON_EVENTS = ["started", "answered"] as const satisfies readonly WorkflowEventKind[];

/** When a person last started the workflow or answered its recommendation; its start when no such event is recorded. */
export async function goOnAt(db: Db, w: Pick<ItemWorkflow, "id" | "startedAt">): Promise<string> {
  const r = await db.get(db.k.selectFrom("main.workflow_events").select((eb) => eb.fn.max("at").as("at")).where("workflow_id", "=", w.id).where("kind", "in", GO_ON_EVENTS));
  const at = r?.at ?? null;
  return at !== null && at > w.startedAt ? at : w.startedAt;
}

/**
 * What a pre-approved merge in a repo on the maintainer workflow is: the merge leg of a live workflow; `ended`, the leg of a workflow
 * that stopped, finished, closed or went to the backlog (it must not go on as a legacy pre-approval); or `unlinked`, a row no workflow
 * owns (it never acts as a legacy one either). Null in a repo on the decision pipeline.
 */
export async function legContext(db: Db, preapprovalId: number): Promise<LegContext | "ended" | "unlinked" | null> {
  const p = await db.get(db.k.selectFrom("main.preapprovals as p").innerJoin("main.tracked_repos as t", "t.name", "p.repo")
    .select(["p.repo", "p.number", "p.workflow_id", "t.workflow"]).where("p.id", "=", preapprovalId));
  if (!p || p.workflow !== "new") return null;
  let id = p.workflow_id;
  if (id === null) {
    // A start writes its pre-approval just before the workflow row that owns it: adopt it once that row exists.
    const own = await liveWorkflow(db, p.repo, p.number);
    if (!own) return "unlinked";
    await db.run(db.k.updateTable("main.preapprovals").set({ workflow_id: own.id }).where("id", "=", preapprovalId).where("workflow_id", "is", null));
    id = own.id;
  }
  const w = await db.get(db.k.selectFrom("main.item_workflows").select(["id", "entry", "started_at", "state"]).where("id", "=", id));
  if (!w || !isLive(w.state as WorkflowState)) return "ended";
  return { workflowId: w.id, entry: w.entry as Entry, since: await goOnAt(db, { id: w.id, startedAt: w.started_at }) };
}
