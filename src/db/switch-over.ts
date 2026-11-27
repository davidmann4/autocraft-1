// The switch to the maintainer workflow, once: what older processes wrote after the state copy is carried over, people's answers,
// the open questions and the results of the decision system become `archived` workflow events, an implementation that waits for a
// maintainer keeps its question in its own rounds, every tracked repo runs the maintainer workflow, and each open fast-track row and
// each pre-approved merge in progress becomes a started workflow.
//
// When. The runner runs it after it won its lease and before it starts work (src/runner/index.ts), on both engines. By then
// the older runner and its jobs are fenced, so their last writes are in place; older dashboards may serve for some minutes
// more. Nothing is dropped or locked as a whole: reads are paged by primary key, every page is a short write transaction, and
// what older processes still write to the old places afterwards is not read again.
//
// Idempotent. The archive skips rows it has written (unique index workflow_events_archived), the carry-over compares values,
// and the rest commits in one transaction with the marker SWITCH_KEY, so a run cut short is completed by the next one and a
// second run does nothing. The marker names the older runner's last heartbeat: when an older release ran again in between (a
// rollback), the heartbeat moved and the switch runs again for what that release wrote.
//
// Which side wins, per copied place (`old` is what older processes write, `new` the module's table):
// - lane_state, dupe_drops, merge_state, liveness_state, classify_state `jev_failed`, the review_state counters: only the
//   runner writes them, and the older one wrote last, so old wins, rows it removed included.
// - merge_repo_state, build_state, classify_state `current_run`: people change them too, so on the first run a new row written
//   after the copy stays; otherwise old wins.
// - review_state.stale_at, stage_limits.reset_at and a Task Runner's idle claim: the later time wins.
// - repo_step_approvals: a person's later grant or revocation wins, whichever side it was made on, and both sides are equal
//   afterwards. It decides nothing itself.
// - sync_state: the side with the later org_high_water wins whole (the periodic copy changes hands on its own).
// - stage_limits: one table; a limit an older process stored on a row that only recorded a reset counts as set.
// - agent_runs first item, remote_call_items, merge_batch_prs.repo, merge_batches.fork, discord_alert_msgs workflow key,
//   duplicate group ids, a Task Runner's machine: filled where empty.
// - discord_filed, plan_pass_stats and every other table: one place for both, nothing to carry.
import { decideAct, isWrite, loadActFacts, permKey, type ActIdentity } from "../data/access/index.ts";
import { cancelUnopened, loadImplementFacts } from "../data/implement/index.ts";
import { withdrawItemCalls } from "../data/runners/index.ts";
import { attemptOf } from "../data/workflow/fragments.ts";
import { endWorkspace } from "../build/workspaces.ts";
import { LIMIT_IMPLEMENT, type QuestionOption } from "../implement/questions.ts";
import { MAX_ATTEMPTS_PER_TEXT, STUCK_CAUSES, STUCK_OPTIONS } from "../implement/stuck.ts";
import { ENDED_STATES } from "../implement/types.ts";
import { openQuestionOf, viewOf } from "../workflow/question.ts";
import { WEIGHT_NORMAL, type Parsed, type PlanPart } from "../workflow/types.ts";
import type { Db, Statement } from "./index.ts";
import * as kx from "./kx.ts";
import { queryDb } from "./query-db.ts";
import { ACTIVE_LEG_STATES, backfills, boundsSql, settingsState, spans, STATE_COPY_DONE, type StateRows, type Task, type Value } from "./state-copy.ts";

export const SWITCH_KEY = "workflow_switch";
const ACTOR = "pipeline";
const LIVE = ["running", "waiting", "blocked", "recommending"];
const WITHDRAWN = "withdrawn";
const PIPELINE_ANSWERS = [WITHDRAWN, "superseded"];
const BACKLOG = "backlog";
const PAGE = 500;
const DAY_MS = 86_400_000;
/** Longest question or reason kept on an archived line, and how many refs a list of the report holds. */
const LINE_CHARS = 300;
const LISTED = 200;

export interface SwitchReport {
  at: string;
  archived: { answered: number; withdrawn: number; actions: number; withoutItem: number };
  /** Copied state that differed and was carried over, rows per table. */
  carried: Record<string, number>;
  /** Stopped pre-approvals ended. */
  legsEnded: number;
  /** Pre-approved merges in progress that no workflow owned, the person whose approval it is and the workflow it goes on in. */
  legs: { item: string; by: string; head: string; workflow: number }[];
  /** Those the pre-approval pass ends. */
  legsSkipped: { item: string; why: string }[];
  /** Implementations that wait for a maintainer, whose question was carried into their rounds. */
  questions: string[];
  /** Answers nothing had acted on yet. */
  unapplied: string[];
  repos: number;
  fastTrack: { item: string; entry: string; by: string; weight: number; workflow: number }[];
  fastTrackSkipped: { item: string; why: string }[];
  backlog: number;
}

export interface SwitchOptions {
  now?: string;
  log?: (line: string) => void;
  /** Daily limits per step, for a reset of a step that has no limit row. */
  perDay?: Record<string, number | null>;
}

/** Runs the switch when it is due; null when there is nothing to do. */
export async function switchOver(db: Db, o: SwitchOptions = {}): Promise<SwitchReport | null> {
  const now = o.now ?? new Date().toISOString();
  const marker = await markerOf(db);
  const heartbeat = await setting(db, "runner_heartbeat");
  if (marker && marker.heartbeat === heartbeat) return null;
  const copied = await setting(db, STATE_COPY_DONE);
  // Both sides were equal at this time: at the last switch, else at the state copy (a copy without a time: now).
  const since = marker?.at ?? (copied !== null && /^\d{4}-/.test(copied) ? copied : now);
  const r: SwitchReport = {
    at: now, archived: { answered: 0, withdrawn: 0, actions: 0, withoutItem: 0 }, carried: {}, legsEnded: 0, legs: [], legsSkipped: [],
    questions: [], unapplied: [], repos: 0, fastTrack: [], fastTrackSkipped: [], backlog: 0,
  };
  await carryState(db, r, { now, since, keepAfter: marker ? null : since, perDay: o.perDay });
  await carryColumns(db, r, since);
  await archiveDecisions(db, r, now, true, new Set((await askingAttempts(db)).flatMap((x) => (x.a.decision === null ? [] : [x.a.decision as string]))));
  await archiveActions(db, r);
  await db.write(async () => {
    await endAskedLegs(db, r);
    await carryQuestions(db, r, now);
    await carryDrafts(db, now);
    await keepRecommendations(db, now);
    r.repos = (await run(db, q(db).updateTable("main.tracked_repos").set({ workflow: "new" }).where("workflow", "<>", "new"))).changes;
    await startWorkflows(db, r, now);
    r.unapplied = (await all(db, q(db).selectFrom("main.decisions as d").select("d.id").where("d.answer", "is not", null).where("d.answer", "not in", [WITHDRAWN, BACKLOG]).where("d.applied_at", "is", null)
      .where((eb: any) => eb.not(eb.exists(eb.selectFrom("main.implementations as im").innerJoin("main.implementation_rounds as ir", "ir.implementation_id", "im.id").select(eb.lit(1).as("one"))
        .whereRef("im.decision_id", "=", "d.id").where("ir.kind", "=", "answer").whereRef("ir.at", "=", "d.answered_at"))))
      .orderBy("d.id").limit(LISTED)))
      .map((d) => d.id as string);
    await run(db, q(db).insertInto("main.audit").values({ at: now, login: ACTOR, action: "workflow-switch", target: null, details: JSON.stringify(r) }));
    await run(db, q(db).insertInto("main.settings").values({ key: SWITCH_KEY, value: JSON.stringify({ at: now, heartbeat }) })
      .onConflict((oc: any) => oc.column("key").doUpdateSet(kx.excluded(["value"]))));
  });
  for (const line of reportLines(r)) o.log?.(line);
  return r;
}

/** The report as log lines. */
export function reportLines(r: SwitchReport): string[] {
  const a = r.archived;
  const carried = Object.entries(r.carried).filter(([, n]) => n).map(([t, n]) => `${t} ${n}`).join(", ");
  return [
    `switch to the maintainer workflow: ${a.answered} answered and ${a.withdrawn} open questions and ${a.actions} actions archived (${a.withoutItem} questions without an item in the audit log)`,
    `  ${r.repos} repos moved, ${r.legsEnded} stopped pre-approvals ended, ${r.backlog} items kept in the backlog; carried over: ${carried || "nothing"}`,
    ...r.fastTrack.map((f) => `  fast track: ${f.item} starts ${f.entry} for ${f.by} at weight ${f.weight} (workflow ${f.workflow})`),
    ...r.fastTrackSkipped.map((f) => `  fast track: ${f.item} not started: ${f.why}`),
    ...r.legs.map((l) => `  pre-approved merge: ${l.item} goes on at ${l.head.slice(0, 7)}, approved by ${l.by} (workflow ${l.workflow})`),
    ...r.legsSkipped.map((l) => `  pre-approved merge: ${l.item} ends: ${l.why}`),
    ...(r.questions.length ? [`  implementations that wait for a maintainer: ${r.questions.join(", ")}`] : []),
    ...(r.unapplied.length ? [`  answers nothing had acted on: ${r.unapplied.join(", ")}`] : []),
  ];
}

// ---- helpers -------------------------------------------------------------------------------------------------------

type Row = Record<string, any>;
/** Read at each use: the builder of the open transaction. */
const q = (db: Db): any => queryDb(db).k;
const all = (db: Db, x: any): Promise<Row[]> => queryDb(db).all(x) as Promise<Row[]>;
const get = (db: Db, x: any): Promise<Row | undefined> => queryDb(db).get(x) as Promise<Row | undefined>;
const run = (db: Db, x: any): Promise<{ changes: number }> => queryDb(db).run(x);
const prepare = (db: Db, text: string): Statement => queryDb(db).prepare(text);
const key = (r: { repo: string; number: number | string }): string => `${r.repo}#${r.number}`;

const setting = async (db: Db, name: string): Promise<string | null> =>
  ((await get(db, q(db).selectFrom("main.settings").select("value").where("key", "=", name)))?.value as string | undefined) ?? null;

async function markerOf(db: Db): Promise<{ at: string; heartbeat: string | null } | null> {
  const v = parse(await setting(db, SWITCH_KEY)) as { at?: unknown; heartbeat?: unknown } | null;
  return v && typeof v.at === "string" ? { at: v.at, heartbeat: typeof v.heartbeat === "string" ? v.heartbeat : null } : null;
}

function parse(text: unknown): unknown {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** One line of at most LINE_CHARS characters. */
const oneLine = (text: string): string => {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > LINE_CHARS ? `${s.slice(0, LINE_CHARS - 1)}…` : s;
};

// ---- state copied out of settings ----------------------------------------------------------------------------------

type CarryOptions = { now: string; since: string; keepAfter: string | null; perDay?: Record<string, number | null> };

async function carryState(db: Db, r: SwitchReport, o: CarryOptions): Promise<void> {
  const rows = await all(db, q(db).selectFrom("main.settings").select(["key", "value"]).where("value", "is not", null));
  const s = settingsState(rows, o.now);
  const t = s.tables;
  const replace = async (st: StateRows, keys: string[], x: ReplaceOptions = {}): Promise<void> => {
    r.carried[st.table] = (r.carried[st.table] ?? 0) + await db.write(() => replaceState(db, st, keys, x));
  };
  await replace(t.lane_state, ["kind", "step", "repo"], { stamp: "at" });
  await replace(t.dupe_drops, ["repo", "key"]);
  await replace(t.merge_state, ["repo", "number"]);
  await replace(t.liveness_state, ["id"]);
  await replace(t.merge_repo_state, ["repo"], { stamp: "updated_at", keepAfter: o.keepAfter });
  await replace(t.build_state, ["key"], { stamp: "updated_at", keepAfter: o.keepAfter });
  await replace(t.classify_state, ["kind", "repo", "number"], { stamp: "at", keepAfter: o.keepAfter, only: ["kind", "current_run"] });
  await replace(t.review_state, ["repo", "number"], { latest: "stale_at" });
  r.carried.sync_state = await db.write(() => carrySync(db, t.sync_state));
  r.carried.repo_step_approvals = await db.write(() => carryApprovals(db, rows, t.repo_step_approvals, o.since));
  r.carried.stage_limits = await db.write(() => carryLimits(db, s.resets, o.perDay));
  r.carried.jev_failed = await db.write(() => carryJevFailed(db, o));
}

type ReplaceOptions = {
  /** The column that says when the row was written: not compared, since the settings rows carry no time for it. */
  stamp?: string;
  /** A stored row whose stamp is later stays, whatever the settings say. */
  keepAfter?: string | null;
  /** [column, value]: only the stored rows that have it are compared. */
  only?: [string, string];
  /** A time column the later value of which wins; a stored row that has one is never removed. */
  latest?: string;
};

/** Makes the stored rows of `s.table` those of `s`, by `keys`; returns how many it changed. */
async function replaceState(db: Db, s: StateRows, keys: string[], o: ReplaceOptions): Promise<number> {
  const name = `main.${s.table}`;
  const id = (x: Row): string => JSON.stringify(keys.map((c) => x[c]));
  const num = (c: string): boolean => c === "number" || c === "id";
  const norm = (x: Row): Row => Object.fromEntries(s.cols.map((c) => [c, num(c) && x[c] !== null ? Number(x[c]) : x[c]]));
  let stored = q(db).selectFrom(name).select(s.cols);
  if (o.only) stored = stored.where(o.only[0], "=", o.only[1]);
  const have = new Map((await all(db, stored)).map(norm).map((x) => [id(x), x]));
  const want = new Map(s.rows.map((v) => norm(Object.fromEntries(s.cols.map((c, i) => [c, v[i]])))).map((x) => [id(x), x]));
  const later = (x: Row): boolean => !!o.stamp && !!o.keepAfter && String(x[o.stamp] ?? "") > o.keepAfter;
  const put: Row[] = [];
  const gone: Row[] = [];
  for (const [k, w] of want) {
    const h = have.get(k);
    if (h && later(h)) continue;
    const next = h && o.latest && String(h[o.latest] ?? "") > String(w[o.latest] ?? "") ? { ...w, [o.latest]: h[o.latest] } : w;
    if (!h || s.cols.some((c) => c !== o.stamp && !same(h[c], next[c]))) put.push(next);
  }
  for (const [k, h] of have) if (!want.has(k) && !later(h) && !(o.latest && h[o.latest])) gone.push(h);
  for (const part of kx.batches(gone)) {
    await run(db, q(db).deleteFrom(name).where(kx.tupleIn(db, keys, part.map((h) => keys.map((c) => h[c])), keys.map((c) => (num(c) ? "bigint" : "text")))));
  }
  const set = s.cols.filter((c) => !keys.includes(c));
  for (const part of kx.batches(put)) await run(db, q(db).insertInto(name).values(part).onConflict((oc: any) => oc.columns(keys).doUpdateSet(kx.excluded(set))));
  return put.length + gone.length;
}

const same = (a: unknown, b: unknown): boolean => (a ?? null) === (b ?? null) || (a !== null && b !== null && a !== undefined && b !== undefined && String(a) === String(b));

async function carrySync(db: Db, s: StateRows): Promise<number> {
  if (!s.rows.length) return 0;
  const old = Object.fromEntries(s.cols.map((c, i) => [c, s.rows[0]![i]])) as Row;
  const have = await get(db, q(db).selectFrom("main.sync_state").selectAll().where("id", "=", 1));
  if (have && String(have.org_high_water ?? "") >= String(old.org_high_water ?? "")) return 0;
  if (have) await run(db, q(db).deleteFrom("main.sync_state").where("id", "=", 1));
  await run(db, q(db).insertInto("main.sync_state").values(old));
  return 1;
}

async function carryApprovals(db: Db, settings: Row[], s: StateRows, since: string): Promise<number> {
  const keyOf = (x: { repo: string; step: string }): string => `${x.step}_approved:${x.repo}`;
  type Approval = { repo: string; step: string; by: string; at: string };
  // An approval stored without a time is as old as the copy.
  const timed = new Set(settings.filter((x) => typeof (parse(x.value) as Row | null)?.at === "string").map((x) => x.key as string));
  const old = new Map(s.rows.map(([repo, step, by, at]) => ({ repo, step, by, at }) as Approval).map((a) => [keyOf(a), timed.has(keyOf(a)) ? a : { ...a, at: "" }]));
  const have = new Map((await all(db, q(db).selectFrom("main.repo_step_approvals").select(["repo", "step", "by", "at"]))).map((a) => [keyOf(a as Approval), a as Approval]));
  let n = 0;
  const store = async (a: Approval): Promise<void> => {
    n++;
    await run(db, q(db).insertInto("main.repo_step_approvals").values(a).onConflict((oc: any) => oc.columns(["repo", "step"]).doUpdateSet(kx.excluded(["by", "at"]))));
  };
  const write = async (k: string, a: Approval | null): Promise<void> => {
    if (!a) return void await run(db, q(db).deleteFrom("main.settings").where("key", "=", k));
    await run(db, q(db).insertInto("main.settings").values({ key: k, value: JSON.stringify({ by: a.by, at: a.at }) }).onConflict((oc: any) => oc.column("key").doUpdateSet(kx.excluded(["value"]))));
  };
  for (const [k, a] of old) {
    const h = have.get(k);
    if (h ? a.at > h.at : a.at > since) await store(a);
    else if (!h) await write(k, null);
    else if (h.at > a.at) await write(k, h);
  }
  for (const [k, h] of have) {
    if (old.has(k)) continue;
    if (h.at > since) await write(k, h);
    else {
      n++;
      await run(db, q(db).deleteFrom("main.repo_step_approvals").where("repo", "=", h.repo).where("step", "=", h.step));
    }
  }
  return n;
}

async function carryLimits(db: Db, resets: [string, string][], perDay: Record<string, number | null> | undefined): Promise<number> {
  let n = (await run(db, q(db).updateTable("main.stage_limits").set({ limit_set: 1 }).where("limit_set", "=", 0).where("updated_at", "is not", null))).changes;
  for (const [step, at] of resets) {
    n += (await run(db, q(db).updateTable("main.stage_limits").set({ reset_at: at }).where("step", "=", step).where((eb: any) => eb.or([eb("reset_at", "is", null), eb("reset_at", "<", at)])))).changes;
    if (perDay) n += (await run(db, q(db).insertInto("main.stage_limits").values({ step, per_day: perDay[step] ?? null, reset_at: at, limit_set: 0 }).onConflict((oc: any) => oc.doNothing()))).changes;
  }
  return n;
}

async function carryJevFailed(db: Db, o: CarryOptions): Promise<number> {
  const gone = await prepare(db, `DELETE FROM main.classify_state WHERE kind = 'jev_failed' AND (CAST(? AS TEXT) IS NULL OR at <= ?)
    AND NOT EXISTS (SELECT 1 FROM main.items i WHERE i.repo = classify_state.repo AND i.number = classify_state.number AND i.jev_failed_hash = classify_state.value)`).run(o.keepAfter, o.keepAfter);
  const put = await prepare(db, `INSERT INTO main.classify_state (kind, repo, number, value, at)
    SELECT 'jev_failed', repo, number, jev_failed_hash, CAST(? AS TEXT) FROM main.items WHERE jev_failed_hash IS NOT NULL
    ON CONFLICT (kind, repo, number) DO UPDATE SET value = excluded.value, at = excluded.at WHERE classify_state.value <> excluded.value`).run(o.now);
  return Number(gone.changes) + Number(put.changes);
}

// ---- columns older processes leave empty ----------------------------------------------------------------------------

async function carryColumns(db: Db, r: SwitchReport, since: string): Promise<void> {
  const t = backfills("main.");
  // A run older than a day before the copy had its items then; started_at is indexed.
  const from = new Date(Date.parse(since) - DAY_MS).toISOString();
  await backfill(db, t.agentRuns, (await get(db, q(db).selectFrom("main.agent_runs").select((eb: any) => [eb.fn.min("id").as("lo"), eb.fn.max("id").as("hi")]).where("started_at", ">=", from))));
  for (const task of [t.callItems, t.batchPrs, t.batchForks, t.alerts, t.groups, t.groupItems]) await backfill(db, task);
  const idle = (col: string): string => `(SELECT t.${col} FROM main.mcp_tokens t WHERE t.id = remote_helpers.token_id)`;
  r.carried.remote_helpers = await db.write(async () => Number((await prepare(db, `UPDATE main.remote_helpers
      SET idle_claim_at = ${idle("idle_claim_at")}, idle_tiers = ${idle("idle_tiers")}, idle_repos = ${idle("idle_repos")}
      WHERE ${idle("idle_claim_at")} > COALESCE(idle_claim_at, 0)`).run()).changes)
    + Number((await prepare(db, `UPDATE main.remote_helpers SET machine = ${idle("machine")} WHERE machine IS NULL AND ${idle("machine")} IS NOT NULL`).run()).changes));
}

/** Runs a backfill of the state copy again, one write transaction per unit. */
async function backfill(db: Db, t: Task, bounds?: Row): Promise<void> {
  const b = t.range ? bounds ?? await prepare(db, boundsSql(t, "main.")).get() : undefined;
  for (const [lo, hi] of spans(t, b)) {
    await db.write(async () => {
      const read = t.read?.(lo, hi);
      const rows = read ? await prepare(db, read.sql).all(...read.params as Value[]) : [];
      for (const w of t.writes(rows, lo, hi)) await prepare(db, w.sql).run(...w.params as Value[]);
    });
  }
}

// ---- archive --------------------------------------------------------------------------------------------------------

type Archived = { repo: string; number: number; login: string; legacy: string; line: string; at: string };

/** Writes archived events; a row already archived (same item and `legacy`) is skipped. Returns how many it wrote. */
async function addArchived(db: Db, rows: Archived[]): Promise<number> {
  let n = 0;
  for (const part of kx.batches(rows)) {
    n += (await run(db, q(db).insertInto("main.workflow_events").values(part.map((e) => ({
      workflow_id: null, repo: e.repo, number: e.number, login: e.login, via: "cli", kind: "archived",
      parsed: JSON.stringify({ kind: "archived", legacy: e.legacy }), line: e.line, at: e.at,
    }))).onConflict((oc: any) => oc.doNothing()))).changes;
  }
  return n;
}

type ItemAnswer = { repo: string; number: number; answer?: string };

/** The items of a decision: its own, or those its `items` JSON names. */
function itemsOf(d: Row): ItemAnswer[] {
  if (d.number !== null && d.repo !== null) return [{ repo: d.repo as string, number: Number(d.number) }];
  const list = (text: unknown): ItemAnswer[] => {
    const v = parse(text);
    return (Array.isArray(v) ? v : []).filter((x): x is ItemAnswer => typeof x?.repo === "string" && Number.isInteger(x?.number));
  };
  const other = new Map(list(d.exceptions).map((x) => [key(x), x.answer]));
  return list(d.items).map((x) => ({ repo: x.repo, number: x.number, answer: other.get(key(x)) }));
}

/** The label of an answer among the decision's options, else its key. */
function labelOf(d: Row, answer: string): string {
  const options = parse(d.options);
  const label = (Array.isArray(options) ? options : []).find((x) => x?.key === answer)?.label as unknown;
  return typeof label === "string" && label ? label : answer;
}

/**
 * Archives every decision a person answered, at the time of the answer, and, with `open`, every unanswered one as withdrawn:
 * one event per item it names (open questions with the same text on one item make one), or an audit row for a decision that
 * names none. What the pipeline withdrew or replaced by itself is left out. A question in `kept` is one an implementation still asks.
 * Paged by id, a transaction per page.
 */
export async function archiveDecisions(db: Db, r: Pick<SwitchReport, "archived">, now: string, open: boolean, kept: ReadonlySet<string> = new Set()): Promise<void> {
  const listed = new Set((await all(db, q(db).selectFrom("main.audit").select("target").where("action", "=", "decision-archived"))).map((x) => x.target as string));
  for (let last = ""; ;) {
    const page = await all(db, q(db).selectFrom("main.decisions").select(["id", "kind", "repo", "number", "items", "question", "options", "exceptions", "answer", "answered_by", "answered_at", "asked_at"])
      .where("id", ">", last).where((eb: any) => eb.or([...(open ? [eb("answer", "is", null)] : []), answeredByPerson(eb)])).orderBy("id").limit(PAGE));
    if (!page.length) return;
    last = page.at(-1)!.id as string;
    const answered: Archived[] = [];
    const withdrawn: Archived[] = [];
    const stays: Archived[] = [];
    const audits: Row[] = [];
    for (const d of page) {
      const done = d.answer !== null;
      const items = itemsOf(d);
      const line = (answer: string | null): string => (answer === null ? `${oneLine(d.question)} ${kept.has(d.id) ? "The implementation still asks it." : "Withdrawn at the switch to the maintainer workflow."}`
        : `${oneLine(d.question)} Answer: ${oneLine(labelOf(d, answer))}.`);
      const login = (d.answered_by as string | null) ?? ACTOR;
      const at = (done ? (d.answered_at ?? d.asked_at) as string : now);
      const id = `decision:${d.id}${done ? "" : ":open"}`;
      const legacy = done ? id : `open:${oneLine(d.question)}`;
      for (const i of items) (done ? answered : kept.has(d.id) ? stays : withdrawn).push({ repo: i.repo, number: i.number, login, legacy, line: line(done ? i.answer ?? d.answer as string : null), at });
      if (!items.length && !listed.has(id)) audits.push({ at, login, action: "decision-archived", target: id, details: JSON.stringify({ repo: d.repo, kind: d.kind, line: line(d.answer as string | null) }) });
    }
    await db.write(async () => {
      r.archived.answered += await addArchived(db, answered);
      await addArchived(db, stays);
      r.archived.withdrawn += await addArchived(db, withdrawn);
      if (audits.length) await run(db, q(db).insertInto("main.audit").values(audits));
    });
    r.archived.withoutItem += audits.length;
  }
}

/** A person's answer (an early one names nobody): not one the pipeline gave to close a question that no longer applied. */
const answeredByPerson = (eb: any): any => eb.and([eb("answer", "is not", null), eb("answer", "not in", PIPELINE_ANSWERS), eb(eb.fn.coalesce("answered_by", eb.val("")), "<>", ACTOR)]);

const ACTION_WORDS: Record<string, string> = { "comment-close": "Comment and close" };

/** Archives every row of `actions`, once per state it was seen in. */
export async function archiveActions(db: Db, r: Pick<SwitchReport, "archived">): Promise<void> {
  for (let last = 0; ;) {
    const page = await all(db, q(db).selectFrom("main.actions as a").leftJoin("main.decisions as d", "d.id", "a.decision_id")
      .select(["a.id", "a.repo", "a.number", "a.kind", "a.state", "a.comment_url", "a.reason", "a.created_at", "d.answered_by"]).where("a.id", ">", last).orderBy("a.id").limit(PAGE));
    if (!page.length) return;
    last = Number(page.at(-1)!.id);
    const rows = page.map((a): Archived => ({
      repo: a.repo, number: Number(a.number), login: a.answered_by ?? ACTOR, legacy: `action:${a.id}:${a.state}`, at: a.created_at,
      line: oneLine(`${ACTION_WORDS[a.kind as string] ?? a.kind}: ${a.state}${a.reason ? ` (${a.reason})` : ""}${a.comment_url ? ` ${a.comment_url}` : ""}`),
    }));
    r.archived.actions += await db.write(() => addArchived(db, rows));
  }
}

// ---- pre-approvals --------------------------------------------------------------------------------------------------

/** Characters of a review's or a fix-up's reason that the decision system kept in a leg's reason, after ": ". */
const QUOTE_CHARS = [160, 120];

/** A leg's reason whose quote was cut at its kept length ends at a word, with "…". */
function markCut(reason: string): string {
  const from = reason.indexOf(": ") + 2;
  const quote = reason.slice(from);
  return from < 2 || !QUOTE_CHARS.includes(quote.length) || /[.!?…]$/.test(quote) ? reason : `${reason.slice(0, from)}${quote.replace(/[\s,;:(–-]+\S*$/, "")}…`;
}

/**
 * Ends the pre-approvals that stopped for a Merge? question. The advance pass, which runs before the runner plans or merges anything,
 * reads an ended leg of a running workflow as it read the stopped one: with no answer since, the workflow comes back with a recommendation.
 */
async function endAskedLegs(db: Db, r: SwitchReport): Promise<void> {
  // updated_at stays: it says when the leg stopped, and a stop older than the workflow's last answer is no new one. So does the reason, which the recommendation
  // names; a quote in it that was cut with no mark gets one.
  for (const leg of await all(db, q(db).selectFrom("main.preapprovals").select(["id", "reason"]).where("state", "=", "asked").where("reason", "is not", null))) {
    const reason = markCut(leg.reason as string);
    if (reason !== leg.reason) await run(db, q(db).updateTable("main.preapprovals").set({ reason }).where("id", "=", leg.id as number));
  }
  r.legsEnded = (await run(db, q(db).updateTable("main.preapprovals").set({ state: "cancelled" }).where("state", "=", "asked"))).changes;
}

// ---- questions of implementations ----------------------------------------------------------------------------------

/** Options of the decision system that are commands of their own, or words. */
const NOT_OPTIONS = new Set([BACKLOG, "answer", "close", "close-issue", "close-pr"]);

/** `exec_state` of an answer nobody may act on: someone disputed it, or it waits for its person's sign-in or access. */
const HELD_ANSWERS = ["disputed", "waiting-token", "waiting-permission"];

type Asking = { a: Row; rounds: Row[]; questions: { id: number; at: string; result: Row }[] };

/** The attempts in `states` with their decision and their rounds. */
async function attemptsIn(db: Db, states: string[]): Promise<Asking[]> {
  const attempts = await all(db, q(db).selectFrom("main.implementations as im").leftJoin("main.decisions as d", "d.id", "im.decision_id")
    .select(["im.id", "im.repo", "im.number", "im.state", "im.text_hash", "im.pr_number", "im.reason", "d.id as decision", "d.question", "d.options", "d.recommended", "d.facts", "d.answer", "d.answer_note", "d.answered_by", "d.answered_at", "d.applied_at", "d.exec_state"])
    .where("im.state", "in", states).orderBy("im.id"));
  const out: Asking[] = [];
  for (const a of attempts) {
    const rounds = await all(db, q(db).selectFrom("main.implementation_rounds").select(["id", "kind", "result", "at"]).where("implementation_id", "=", a.id).orderBy("id"));
    out.push({ a, rounds, questions: rounds.filter((x) => x.kind === "question").map((x) => ({ id: Number(x.id), at: x.at as string, result: (parse(x.result) ?? {}) as Row })) });
  }
  return out;
}

/** The attempts that wait for a maintainer. */
async function askingAttempts(db: Db): Promise<Asking[]> {
  return (await attemptsIn(db, ["asked", "stuck"])).filter(({ a, questions }) => {
    const last = questions.at(-1)?.result;
    return a.state === "stuck" || (last?.audience === "maintainer" && (last.options !== undefined || a.decision !== null));
  });
}

/** The newest question when it is the stuck question of the attempt as it is now: nothing but answers came after it. */
function stuckRound({ rounds, questions }: Asking): Asking["questions"][number] | null {
  const last = questions.at(-1);
  return last?.result.stuck === true && !rounds.some((x) => Number(x.id) > last.id && x.kind !== "answer" && x.kind !== "guidance") ? last : null;
}

const decisionOptions = (a: Row): QuestionOption[] => ((parse(a.options) ?? []) as Row[]).filter((o) => typeof o?.key === "string" && typeof o.label === "string" && !NOT_OPTIONS.has(o.key))
  .map((o) => ({ key: o.key, label: o.label, hint: typeof o.hint === "string" ? o.hint : "" }));

async function addQuestion(db: Db, a: Row, options: QuestionOption[], now: string): Promise<number> {
  const reason = (a.reason as string | null) ?? "the reason was not recorded";
  const cause = Object.entries(STUCK_CAUSES).find(([, line]) => reason.startsWith(line))?.[0];
  const result = {
    audience: "maintainer", text: `The implementation is stuck: ${reason}.`, options, recommended: options.some((o) => o.key === STUCK_OPTIONS.tryAgain.key) ? STUCK_OPTIONS.tryAgain.key : null,
    stuck: true, ...(cause && { cause }), facts: (parse(a.facts) ?? []) as unknown[],
  };
  const [added] = await all(db, q(db).insertInto("main.implementation_rounds").values({ implementation_id: a.id, kind: "question", call_id: null, result: JSON.stringify(result), at: now }).returning("id"));
  return Number(added!.id);
}

async function addAnswer(db: Db, a: Row, question: number, option: string | undefined): Promise<void> {
  const words = (a.answer_note as string | null)?.trim() || undefined;
  const answer = { by: a.answered_by, via: "cli", at: a.answered_at, question, ...(option !== undefined && { option }), ...(words && { text: words }) };
  await run(db, q(db).insertInto("main.implementation_rounds").values({ implementation_id: a.id, kind: "answer", call_id: null, result: JSON.stringify(answer), at: a.answered_at }));
}

/**
 * An attempt that is stuck, or that asked the maintainers, shows its question through its newest `question` round. An older release kept
 * the options, the recommended one and the answer in a decision, and wrote no round for a stuck attempt: the round gets them here, and an
 * answer nothing had acted on yet becomes the attempt's answer, also one given to a question carried before (an older release ran again).
 */
async function carryQuestions(db: Db, r: SwitchReport, now: string): Promise<void> {
  const identity: ActIdentity = await setting(db, "github_identity") === "app" ? "app" : "box";
  for (const x of await askingAttempts(db)) {
    const { a, questions } = x;
    const last = questions.at(-1);
    let options = decisionOptions(a);
    let round: { id: number; at: string };
    let carried = false;
    if (a.state === "stuck") {
      const have = stuckRound(x);
      if (have) {
        options = (have.result.options ?? []) as QuestionOption[];
        round = have;
      } else {
        if (a.decision === null) options = await stuckOptions(db, a);
        round = { id: await addQuestion(db, a, options, now), at: "" };
        carried = true;
      }
    } else if (last!.result.options !== undefined) {
      options = last!.result.options as QuestionOption[];
      round = last!;
    } else {
      const limit = /:implement-limit-\d+$/.test(a.decision);
      const named = limit ? LIMIT_IMPLEMENT.key : a.recommended;
      // The decision's options belong to its first question, which is the newest round's here; the other one changes places with it.
      const first = questions.find((y) => y.result.decisionId === a.decision) ?? last!;
      if (first !== last) await setResult(db, first.id, { ...first.result, text: last!.result.text });
      await setResult(db, last!.id, { ...last!.result, text: a.question, options, recommended: options.some((o) => o.key === named) ? named : null, ...(limit && { limit: true }) });
      round = last!;
      carried = true;
    }
    const answered = a.answer !== null && !PIPELINE_ANSWERS.includes(a.answer) && a.applied_at === null && (a.answered_at ?? "") > round.at
      && !x.rounds.some((y) => y.kind === "answer" && Number(y.id) > round.id) && !HELD_ANSWERS.includes(a.exec_state) && await mayAct(db, a.answered_by, a.repo, identity);
    if (answered && a.answer === BACKLOG) {
      const moved = await toBacklog(db, a, now);
      r.backlog += moved ?? 0;
      if (moved !== null) continue;
    }
    if (carried) r.questions.push(`${key(a as never)} ${a.state}`);
    const option = options.find((o) => o.key === a.answer)?.key;
    if (answered && (option !== undefined || (a.answer === "answer" && (a.answer_note as string | null)?.trim()))) await addAnswer(db, a, round.id, option);
  }
}

/** Whether the person passes the act rule on the repo, by what GitHub last answered: nothing is asked of GitHub here. */
async function mayAct(db: Db, login: string | null, repo: string, identity: ActIdentity): Promise<boolean> {
  if (login === null) return false;
  const facts = (await loadActFacts(db, [{ login, repo }])).get(permKey(login, repo));
  return !!facts && decideAct(facts, isWrite(facts.perm?.permission) ? "cached" : "no", identity).ok;
}

/**
 * A Backlog answer to the question of an issue does what the backlog command does: the attempt that opened no PR ends with its question, its
 * workspace and its queued calls, and so does the issue's workflow (its merge legs end on its state). Returns the workflows ended; null when a
 * workflow of the issue started later: that start stands.
 */
async function toBacklog(db: Db, a: Row, now: string): Promise<number | null> {
  const of = (b: any): any => b.where("repo", "=", a.repo).where("number", "=", a.number).where("kind", "=", "issue");
  if (await get(db, of(q(db).selectFrom("main.item_workflows").select("id")).where("started_at", ">=", a.answered_at).limit(1))) return null;
  const moved = (await run(db, of(q(db).updateTable("main.item_workflows").set((eb: any) => ({ state: BACKLOG, rec: null, rec_at: null, rec_head: null, blocker: null, blocker_params: null, version: eb("version", "+", 1), updated_at: now })))
    .where("state", "in", LIVE))).changes;
  const item = { repo: a.repo as string, number: Number(a.number) };
  const reason = `moved to the backlog by ${a.answered_by}`;
  for (const w of await cancelUnopened(db, [{ ...item, reason }], a.answered_by, now)) if (w.workspaceId !== null) await endWorkspace(db, w.workspaceId);
  await withdrawItemCalls(db, key(item), reason);
  return moved;
}

/** An attempt the Open as draft PR answer handed to the PR step (or to the undo turn that step asked for) opens a draft when its rounds hold that answer. */
async function carryDrafts(db: Db, now: string): Promise<void> {
  for (const x of await attemptsIn(db, ["checking", "fixing", "opening"])) {
    const { a, rounds, questions } = x;
    const draft = STUCK_OPTIONS.draft.key;
    const last = questions.at(-1);
    if (a.answer !== draft || (last?.result.stuck === true && rounds.some((y) => y.kind === "answer" && Number(y.id) > last.id && (parse(y.result) as Row | null)?.option === draft))) continue;
    await addAnswer(db, { ...a, answered_at: a.answered_at ?? now }, stuckRound(x)?.id ?? await addQuestion(db, a, decisionOptions(a), now), draft);
  }
}

/**
 * A started issue that came back with the question of its implementation names the question by its decision: its recommendation and
 * its parts become those of the carried question, at the time the person was told of it, so it does not come back a second time.
 */
async function keepRecommendations(db: Db, now: string): Promise<void> {
  const back = (await all(db, q(db).selectFrom("main.item_workflows").select(["id", "repo", "number", "state", "rec", "plan", "approved_by", "blocker_params"])
    .where("kind", "=", "issue").where("state", "in", ["blocked", "recommending"]).orderBy("id"))).filter((w) => typeof (parse(w.rec) as Row | null)?.question === "string");
  if (!back.length) return;
  const facts = (await loadImplementFacts(db, back.map((w) => ({ repo: w.repo as string, number: Number(w.number) })), { withPlans: true })).byIssue;
  for (const w of back) {
    const attempt = facts.get(`${w.repo}#${Number(w.number)}`);
    const question = openQuestionOf(attempt);
    // Another question than the one it came back with is news.
    const same = attempt && question && (await get(db, q(db).selectFrom("main.implementations").select("decision_id").where("id", "=", attempt.attempt.id)))?.decision_id === (parse(w.rec) as Row).question;
    if (!same) continue;
    const { plan, rec } = viewOf(attempt, question, (parse(w.plan) ?? []) as PlanPart[], w.approved_by !== null);
    await run(db, q(db).updateTable("main.item_workflows").set((eb: any) => ({ plan: JSON.stringify(plan), rec: JSON.stringify(rec), ...(w.state === "blocked" && { blocker_params: JSON.stringify({ step: "implement" }) }), version: eb("version", "+", 1), updated_at: now })).where("id", "=", w.id));
  }
}

const setResult = async (db: Db, id: number, result: Row): Promise<void> =>
  void await run(db, q(db).updateTable("main.implementation_rounds").set({ result: JSON.stringify(result) }).where("id", "=", id));

/** What a stuck attempt without its decision may do: its revision again, or a new attempt while the issue text has tries left. */
async function stuckOptions(db: Db, a: Row): Promise<QuestionOption[]> {
  if (a.pr_number !== null) return [STUCK_OPTIONS.reviseAgain];
  const tries = Number((await get(db, q(db).selectFrom("main.implementations").select((eb: any) => eb.fn.countAll().as("n"))
    .where("repo", "=", a.repo).where("number", "=", a.number).where("text_hash", "=", a.text_hash)))?.n ?? 0);
  return tries < MAX_ATTEMPTS_PER_TEXT ? [STUCK_OPTIONS.tryAgain] : [];
}

// ---- starts and backlog --------------------------------------------------------------------------------------------------

/** The items a Backlog answer holds (its own, a batch's, a duplicate group's members), with the latest such answer. */
async function backlogAnswers(db: Db): Promise<Map<string, { by: string; at: string }>> {
  const out = new Map<string, { by: string; at: string }>();
  const add = (item: string, d: Row): void => {
    const x = { by: (d.answered_by as string | null) ?? ACTOR, at: (d.answered_at ?? d.asked_at) as string };
    if ((out.get(item)?.at ?? "") < x.at) out.set(item, x);
  };
  const rows = await all(db, q(db).selectFrom("main.decisions").select(["id", "repo", "number", "items", "exceptions", "answered_by", "answered_at", "asked_at"]).where("answer", "=", BACKLOG));
  for (const d of rows) for (const i of itemsOf(d)) add(key(i), d);
  const members = await all(db, q(db).selectFrom("main.dupe_group_items as g").innerJoin("main.decisions as d", "d.id", "g.decision_id")
    .select(["g.repo", "g.number", "d.answered_by", "d.answered_at", "d.asked_at"]).where("d.answer", "=", BACKLOG));
  for (const m of members) add(key(m as { repo: string; number: number }), m);
  return out;
}

/** What the starts of one run share. */
interface Starts {
  backlog: Map<string, { by: string; at: string }>;
  /** Every workflow per item, and the items with a live one. */
  of: Map<string, Row[]>;
  live: Set<string>;
  /** The live implement workflow per issue. */
  implementing: Map<string, { id: number; number: number; approved: boolean }>;
  fast: Row[];
  /** The issue a PR implements. */
  issueOf: Map<string, string>;
}

/**
 * Starts a workflow for the open fast-track rows of issues, the pre-approved merges in progress and the open fast-track rows of
 * PRs, in this order: the PR of an issue that starts goes with the issue, and a pre-approved PR goes on with its approval. Then
 * records each remaining open item a Backlog answer holds as a workflow in the backlog, which the automatic path leaves alone.
 */
async function startWorkflows(db: Db, r: SwitchReport, now: string): Promise<void> {
  const workflows = await all(db, q(db).selectFrom("main.item_workflows").select(["id", "repo", "number", "state", "entry", "started_at", "stopped_at", "approved_by"]).orderBy("id"));
  const of = new Map<string, Row[]>();
  for (const w of workflows) (of.get(key(w as never)) ?? of.set(key(w as never), []).get(key(w as never))!).push(w);
  const live = workflows.filter((w) => LIVE.includes(w.state as string));
  const fast = await all(db, q(db).selectFrom("main.fast_track as f").innerJoin("main.tracked_repos as t", "t.name", "f.repo")
    .innerJoin("main.items as i", (j: any) => j.onRef("i.repo", "=", "f.repo").onRef("i.number", "=", "f.number"))
    .select(["f.id", "f.repo", "f.number", "f.added_by", "f.added_at", "f.weight", "i.kind", "i.head_oid"]).where("i.state", "=", "OPEN").orderBy("f.id"));
  const legs = await all(db, q(db).selectFrom("main.preapprovals as p").leftJoin("main.tracked_repos as t", "t.name", "p.repo")
    .leftJoin("main.items as i", (j: any) => j.onRef("i.repo", "=", "p.repo").onRef("i.number", "=", "p.number"))
    .select(["p.id", "p.repo", "p.number", "p.by", "p.at", "p.from_head", "p.head", "t.name as tracked", "i.state as item_state", "i.head_oid"])
    .where("p.state", "in", [...ACTIVE_LEG_STATES]).where("p.workflow_id", "is", null).orderBy("p.id"));
  const issueOf = new Map<string, string>();
  for (const part of kx.batches([...fast.filter((f) => f.kind === "pr"), ...legs])) {
    // Those of the live workflow's own attempts: a PR of an earlier attempt, reopened say, is no work of that workflow.
    const ims = await all(db, q(db).selectFrom("main.implementations as im").select(["im.repo", "im.number", "im.pr_number"])
      .where(kx.tupleIn(db, ["im.repo", "im.pr_number"], part.map((x) => [x.repo, Number(x.number)]), ["text", "bigint"]))
      .where((eb: any) => eb.or([eb("im.state", "not in", [...ENDED_STATES]), eb.exists(eb.selectFrom("main.item_workflows as w").select(eb.lit(1).as("one")).whereRef("w.repo", "=", "im.repo").whereRef("w.number", "=", "im.number")
        .where("w.entry", "=", "implement").where("w.state", "in", LIVE).where((x: any) => attemptOf(x, "im", "w")))])));
    for (const im of ims) issueOf.set(`${im.repo}#${im.pr_number}`, key(im as never));
  }
  const s: Starts = {
    backlog: await backlogAnswers(db), of, live: new Set(live.map((w) => key(w as never))), fast, issueOf,
    implementing: new Map(live.filter((w) => w.entry === "implement").map((w) => [key(w as never), { id: Number(w.id), number: Number(w.number), approved: w.approved_by !== null }])),
  };
  await startFastTracked(db, r, s, "issue", now);
  await startLegs(db, r, s, legs, now);
  await startFastTracked(db, r, s, "pr", now);
  await keepBacklog(db, r, s, now);
}

type Word = "implement" | "review" | "merge";
type Start = { repo: string; number: number; kind: "issue" | "pr"; entry: Word; weight: number; by: string; head: string | null; approvedAt: string | null; event: "started" | "approved"; line: string };

/** Starts one workflow with its event; null when the item has a live one. */
async function startOne(db: Db, s: Starts, w: Start, now: string): Promise<number | null> {
  const got = await all(db, q(db).insertInto("main.item_workflows").values({
    repo: w.repo, number: w.number, kind: w.kind, entry: w.entry, weight: w.weight, state: "running", started_by: w.by, started_at: now, started_via: "cli",
    base_head: w.head, approved_by: w.approvedAt === null ? null : w.by, approved_at: w.approvedAt, approved_via: w.approvedAt === null ? null : "cli", plan: "[]", updated_at: now,
  }).onConflict((oc: any) => oc.doNothing()).returning("id"));
  if (!got.length) return null;
  const id = Number(got[0]!.id);
  s.live.add(key(w));
  if (w.entry === "implement") s.implementing.set(key(w), { id, number: w.number, approved: false });
  await addEvent(db, { id, repo: w.repo, number: w.number, by: w.by, kind: w.event, word: w.entry, weight: w.weight, line: w.line }, now);
  return id;
}

async function addEvent(db: Db, e: { id: number; repo: string; number: number; by: string; kind: string; word: Word; weight?: number; line: string }, now: string): Promise<void> {
  const parsed: Parsed = { kind: "commands", items: [], parts: [{ word: e.word }, ...(e.weight === undefined ? [] : [{ word: "weight" as const, weight: e.weight }])] };
  await run(db, q(db).insertInto("main.workflow_events").values({
    workflow_id: e.id, repo: e.repo, number: e.number, login: e.by, via: "cli", kind: e.kind, parsed: JSON.stringify(parsed), line: e.line, at: now,
  }));
}

/** Why a person's later act on the item overrides what was asked at `at`; null when nothing does. */
function overridden(s: Starts, item: string, at: string): string | null {
  return s.of.get(item)?.some((w) => w.started_at >= at || (w.stopped_at ?? "") >= at) ? "a workflow of it started or stopped later"
    : (s.backlog.get(item)?.at ?? "") > at ? "it was moved to the backlog later" : null;
}

/**
 * Starts a workflow for each open fast-track row of `kind`: an issue's `implement`, a PR's `review`, for the person who
 * fast-tracked it at its weight, in the order added (the workflow id orders equal weights). Not when the item has a live
 * workflow, its own or the one whose implementation PR it is, or when a workflow of it started or a person sent it away after
 * the row was added.
 */
async function startFastTracked(db: Db, r: SwitchReport, s: Starts, kind: "issue" | "pr", now: string): Promise<void> {
  const entry = kind === "issue" ? "implement" : "review";
  for (const f of s.fast.filter((x) => (x.kind === "pr") === (kind === "pr"))) {
    const item = key(f as never);
    const weight = Number(f.weight);
    const why = s.live.has(item) ? "it has a live workflow"
      : s.issueOf.has(item) && s.implementing.has(s.issueOf.get(item)!) ? `it is the implementation of ${s.issueOf.get(item)}`
      : overridden(s, item, f.added_at);
    const id = why ? null : await startOne(db, s, {
      repo: f.repo, number: Number(f.number), kind, entry, weight, by: f.added_by, head: kind === "pr" ? f.head_oid : null, approvedAt: null,
      event: "started", line: `Started from the fast track at weight ${weight}.`,
    }, now);
    if (id === null) r.fastTrackSkipped.push({ item, why: why ?? "it has a live workflow" });
    else r.fastTrack.push({ item, entry, by: f.added_by, weight, workflow: id });
  }
}

/**
 * Makes each pre-approved merge in progress that no workflow owns the merge leg of a workflow with the entry `merge`, started and
 * approved by the person who pre-approved it when they did, at the head the leg works and at the weight of its fast-track row.
 * The leg of an implementation PR goes on in the issue's live workflow, which takes the approval. The legs of an item with a live
 * workflow of its own are the workflow's to adopt.
 */
async function startLegs(db: Db, r: SwitchReport, s: Starts, legs: Row[], now: string): Promise<void> {
  for (const p of legs) {
    const item = key(p as never);
    if (s.live.has(item)) continue;
    const why = p.tracked === null ? "its repo is not tracked" : p.item_state !== "OPEN" ? "the pull request is not open" : overridden(s, item, p.at);
    if (why) {
      r.legsSkipped.push({ item, why });
      continue;
    }
    // A pushed head the mirror does not show yet is reached from the one it shows along our own push.
    const head = (p.head_oid === p.from_head ? p.from_head : p.head ?? p.from_head) as string;
    const line = `${p.by} approved the merge at ${p.at}; it goes on.`;
    const issue = s.implementing.get(s.issueOf.get(item) ?? "");
    let id = issue?.id ?? null;
    if (issue && !issue.approved) {
      await run(db, q(db).updateTable("main.item_workflows").set((eb: any) => ({ approved_by: p.by, approved_at: p.at, approved_via: "cli", base_head: eb.fn.coalesce("base_head", eb.val(head)), version: eb("version", "+", 1), updated_at: now })).where("id", "=", issue.id));
      issue.approved = true;
      await addEvent(db, { id: issue.id, repo: p.repo, number: issue.number, by: p.by, kind: "approved", word: "merge", line }, now);
    } else if (!issue) {
      const weight = Number(s.fast.find((f) => key(f as never) === item)?.weight ?? WEIGHT_NORMAL);
      id = await startOne(db, s, { repo: p.repo, number: Number(p.number), kind: "pr", entry: "merge", weight, by: p.by, head, approvedAt: p.at, event: "approved", line }, now);
    }
    if (id === null) continue;
    await run(db, q(db).updateTable("main.preapprovals").set({ workflow_id: id }).where("id", "=", p.id));
    r.legs.push({ item, by: p.by, head, workflow: id });
  }
}

async function keepBacklog(db: Db, r: SwitchReport, s: Starts, now: string): Promise<void> {
  const held = [...s.backlog].filter(([item, b]) => !s.live.has(item) && !s.of.get(item)?.some((w) => w.state === "stopped" || w.state === BACKLOG || w.started_at >= b.at));
  for (const part of kx.batches(held)) {
    const open = await all(db, q(db).selectFrom("main.items as i").innerJoin("main.tracked_repos as t", "t.name", "i.repo").select(["i.repo", "i.number", "i.kind"])
      .where("i.state", "=", "OPEN").where(kx.refIn(db, "i", part.map(([item]) => item))));
    if (!open.length) continue;
    const at = (i: Row): { by: string; at: string } => s.backlog.get(key(i as never))!;
    await run(db, q(db).insertInto("main.item_workflows").values(open.map((i) => ({
      repo: i.repo, number: Number(i.number), kind: i.kind, entry: i.kind === "pr" ? "review" : "implement", state: BACKLOG, started_by: at(i).by, started_at: at(i).at, started_via: "cli",
      plan: "[]", updated_at: now,
    }))));
    r.backlog += open.length;
  }
}
