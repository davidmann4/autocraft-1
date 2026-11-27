// Run reads for pages, the live board, MCP and Discord. Reads that take `vis` apply the hidden-repo test `fragments.runVisible`.
import type { SelectQueryBuilder } from "kysely";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import { filtered, runFirst, runVisible } from "./fragments.ts";
import type { ItemRun, JobCall, PromptSpend, Ref, RefusalCount, ReviewRunKeys, RunDetail, RunFilter, RunRow, RunVisibility, ToolView } from "./types.ts";
import { MAX_ITEM_REFS } from "./types.ts";

type Raw = {
  id: number; job_id: number | null; step: string; stage: number; prompt_id: string; prompt_version: string; provider: string; model: string;
  items: string; item_count: number; first_repo: string | null; first_number: number | null; state: string; started_at: string; ended_at: string | null;
  input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null;
  cost_usd: number | null; summary: string | null; error: string | null; progress: string | null; user_login: string | null; harness: string | null; reported_model: string | null;
  call_id: number | null; refusal: string | null;
};

const RUN_COLS = [
  "id", "job_id", "step", "stage", "prompt_id", "prompt_version", "provider", "model", "items", "item_count", "state", "started_at", "ended_at",
  "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_usd", "summary", "error", "progress", "user_login", "harness", "reported_model", "call_id", "refusal",
] as const;

/** The select list of a `RunRow` over `agent_runs` aliased `alias`. */
const runSelect = (alias = "r") => (eb: kx.Eb) => [...RUN_COLS.map((c) => `${alias}.${c}`), runFirst(eb, "repo", alias).as("first_repo"), runFirst(eb, "number", alias).as("first_number")] as never;

const refsOf = (s: string): { repo: string; number: number }[] => {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? (v as { repo: string; number: number }[]).filter((x) => typeof x?.repo === "string" && Number.isInteger(x?.number)).slice(0, MAX_ITEM_REFS) : [];
  } catch {
    return [];
  }
};
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

const toRun = (r: Raw): RunRow => ({
  id: Number(r.id), jobId: numOrNull(r.job_id), step: r.step, stage: Number(r.stage), promptId: r.prompt_id, promptVersion: r.prompt_version, provider: r.provider === "jev" ? "jev" : "claude", model: r.model,
  items: refsOf(r.items), itemCount: Number(r.item_count), firstRepo: r.first_repo, firstNumber: numOrNull(r.first_number),
  state: r.state as RunRow["state"], startedAt: r.started_at, endedAt: r.ended_at,
  tokens: { input: numOrNull(r.input_tokens), output: numOrNull(r.output_tokens), cacheRead: numOrNull(r.cache_read_tokens), cacheWrite: numOrNull(r.cache_write_tokens) },
  costUsd: numOrNull(r.cost_usd), summary: r.summary, error: r.error, progress: r.progress, userLogin: r.user_login, harness: r.harness, reportedModel: r.reported_model,
  callId: numOrNull(r.call_id), refusal: r.refusal === "retried" || r.refusal === "failed" ? r.refusal : null,
});

const group = <K, V>(rows: V[], key: (v: V) => K): Map<K, V[]> => {
  const out = new Map<K, V[]>();
  for (const r of rows) (out.get(key(r)) ?? out.set(key(r), []).get(key(r))!).push(r);
  return out;
};
const refKey = (repo: string, number: number): Ref => `${repo}#${number}`;
const asKeySource = (keys: ReviewRunKeys): KeySource =>
  Array.isArray(keys) ? (keys as unknown[]).map((k) => {
    if (typeof k !== "string") return k as { repo: string; number: number };
    const i = k.lastIndexOf("#");
    return { repo: k.slice(0, i), number: Number(k.slice(i + 1)) };
  }) : keys;

/** Adds the hidden-repo test of `vis` when a filter applies. */
const visibleOnly = <Q extends SelectQueryBuilder<any, any, any>>(q: Q, vis: RunVisibility, alias = "r"): Q =>
  filtered(vis.hidden) ? (q.where((eb: kx.Eb) => runVisible(vis, eb, alias)) as Q) : q;

const toolCounts = async (db: Db, runIds: number[]): Promise<Map<number, number>> => {
  const q = queryDb(db);
  const out = new Map<number, number>();
  for (const part of kx.chunks(runIds)) {
    for (const r of await q.all(q.k.selectFrom("main.agent_run_tools").select(["run_id", (eb) => eb.fn.countAll<number>().as("n")]).where(kx.inList(db, "run_id", part, "bigint")).groupBy("run_id"))) out.set(Number(r.run_id), Number(r.n));
  }
  return out;
};

const DEFAULT_PAGE = 50;

/**
 * A page of runs for the Agents page, newest first, keyset on id. With a repo filter the statement is driven by the (repo, run_id, number) index
 * and returns one row per run at the run's lowest number in that repo, as before; without one it reads `agent_runs` alone. 1 statement.
 */
export async function listRuns(db: Db, f: RunFilter, vis: RunVisibility): Promise<{ rows: RunRow[]; nextCursor: string | null }> {
  const q = queryDb(db);
  const { k } = q;
  const limit = f.limit ?? DEFAULT_PAGE;
  const cursor = f.cursor !== undefined && /^[0-9]+$/.test(f.cursor) ? Number(f.cursor) : null;
  const conds = (cursorCol: string) => (eb: kx.Eb) => eb.and([
    ...(cursor !== null ? [eb(cursorCol, "<", cursor)] : []),
    ...(f.state && f.state !== "recent" ? [eb("r.state", "=", f.state)] : []),
    ...(f.step ? [eb("r.step", "=", f.step)] : []),
    ...(f.refused ? [eb("r.refusal", "is not", null)] : []),
    ...(f.since ? [eb("r.started_at", ">=", f.since)] : []),
  ]);
  const rows = (f.repo
    ? await q.all(visibleOnly(k.selectFrom("main.agent_run_items as i").innerJoin("main.agent_runs as r", "r.id", "i.run_id").select(runSelect())
      .where("i.repo", "=", f.repo)
      .where((eb) => eb("i.number", "=", eb.selectFrom("main.agent_run_items as j").select((e) => e.fn.min("j.number").as("n")).whereRef("j.run_id", "=", "i.run_id").whereRef("j.repo", "=", "i.repo")))
      .where(conds("i.run_id")), vis).orderBy("i.run_id", "desc").limit(limit + 1))
    : await q.all(visibleOnly(k.selectFrom("main.agent_runs as r").select(runSelect()).where(conds("r.id")), vis).orderBy("r.id", "desc").limit(limit + 1))) as unknown as Raw[];
  const page = rows.slice(0, limit);
  return { rows: page.map(toRun), nextCursor: rows.length > limit ? String(page[page.length - 1]!.id) : null };
}

/**
 * The newest later lease of each refused run's call: what the retry came to (it is the call's last lease, so a retry whose own lease
 * ended and was taken again shows the run that ended it). Runs without a call id or with no later lease are absent. 1 statement per 500 calls.
 */
export async function loadRetries(db: Db, runs: { id: number; callId: number | null }[]): Promise<Map<number, { id: number; state: RunRow["state"] }>> {
  const out = new Map<number, { id: number; state: RunRow["state"] }>();
  const calls = [...new Set(runs.flatMap((r) => (r.callId === null ? [] : [r.callId])))];
  if (calls.length === 0) return out;
  const q = queryDb(db);
  const later = new Map<number, { id: number; state: RunRow["state"] }[]>();
  for (const part of kx.chunks(calls)) {
    for (const r of await q.all(q.k.selectFrom("main.agent_runs").select(["id", "call_id", "state"]).where(kx.inList(db, "call_id", part, "bigint")))) {
      const c = Number(r.call_id);
      (later.get(c) ?? later.set(c, []).get(c)!).push({ id: Number(r.id), state: r.state as RunRow["state"] });
    }
  }
  for (const r of runs) {
    const last = (later.get(r.callId ?? -1) ?? []).filter((x) => x.id > r.id).sort((a, b) => b.id - a.id)[0];
    if (last) out.set(r.id, last);
  }
  return out;
}

/** The newest refused runs counted by `loadRefusalCounts`: refusals are rare, so they are counted here rather than grouped in SQL. */
export const REFUSAL_COUNT_MAX = 5000;

/**
 * Refused runs started at or after `since` (the newest REFUSAL_COUNT_MAX), counted per prompt, first repo, model, Task Runner user and what
 * became of the call. 1 statement on the refused-runs index.
 */
export async function loadRefusalCounts(db: Db, since: string, vis: RunVisibility): Promise<RefusalCount[]> {
  const q = queryDb(db);
  const rows = await q.all(visibleOnly(q.k.selectFrom("main.agent_runs as r")
    .select((eb) => ["r.prompt_id", runFirst(eb, "repo").as("repo"), "r.model", "r.reported_model", "r.user_login", "r.refusal"] as never)
    .where("r.refusal", "is not", null).where("r.started_at", ">=", since), vis)
    .orderBy("r.id", "desc").limit(REFUSAL_COUNT_MAX)) as unknown as { prompt_id: string; repo: string | null; model: string; reported_model: string | null; user_login: string | null; refusal: string }[];
  const out = new Map<string, RefusalCount>();
  for (const r of rows) {
    const c: RefusalCount = { promptId: r.prompt_id, repo: r.repo, model: r.reported_model || r.model, login: r.user_login, refusal: r.refusal === "retried" ? "retried" : "failed", n: 0 };
    const key = JSON.stringify([c.promptId, c.repo, c.model, c.login, c.refusal]);
    (out.get(key) ?? out.set(key, c).get(key)!).n++;
  }
  return [...out.values()];
}

/**
 * Run detail; null when the run is missing or hidden from `vis`. Texts only when `vis.staff`, tool arguments likewise. 3 statements in one wave, the
 * texts (bytes) read `alone` (2 for a viewer who is not staff); the caller joins `changes.loadModelChecksOfRun` to the tools.
 */
export async function loadRun(db: Db, id: number, vis: RunVisibility): Promise<RunDetail | null> {
  const q = queryDb(db);
  const { k } = q;
  const [run, texts, tools] = await db.together(() => Promise.all([
    q.get(visibleOnly(k.selectFrom("main.agent_runs as r").select(runSelect()).where("r.id", "=", id), vis)),
    vis.staff ? q.get(k.selectFrom("main.agent_run_texts").select(["prompt", "output"]).where("run_id", "=", id), { alone: true }) : Promise.resolve(undefined),
    q.all(k.selectFrom("main.agent_run_tools").select(["seq", "tool", "args", "result_bytes", "is_error", "started_at", "ended_at", "check_id"]).where("run_id", "=", id).orderBy("seq")),
  ]));
  if (!run) return null;
  const view = (t: { seq: number; tool: string; args: string; result_bytes: number | null; is_error: number; started_at: string | null; ended_at: string | null; check_id: number | null }): ToolView => ({
    seq: Number(t.seq), tool: t.tool, args: vis.staff ? t.args : null, resultBytes: numOrNull(t.result_bytes), isError: Number(t.is_error) === 1, startedAt: t.started_at, endedAt: t.ended_at, checkId: numOrNull(t.check_id),
  });
  return { run: toRun(run as unknown as Raw), prompt: texts?.prompt ?? null, output: texts?.output ?? null, tools: tools.map(view) };
}

/** Runs by id, with no hidden test (callers hold ids of visible items). 1 statement. */
export async function loadRunsById(db: Db, ids: number[]): Promise<Map<number, RunRow>> {
  const out = new Map<number, RunRow>();
  if (ids.length === 0) return out;
  const q = queryDb(db);
  for (const part of kx.chunks(ids)) {
    for (const r of (await q.all(q.k.selectFrom("main.agent_runs as r").select(runSelect()).where(kx.inList(db, "r.id", part, "bigint")))) as unknown as Raw[]) out.set(Number(r.id), toRun(r));
  }
  return out;
}

/**
 * Runs per item in run id order with tool counts: 1 statement. The tool counts come from a grouped join over the matched runs only. A run
 * that touched several of the refs appears under each.
 */
export async function loadItemRuns(db: Db, refs: Ref[], vis: RunVisibility, o?: { state?: "running" }): Promise<Map<Ref, ItemRun[]>> {
  const out = new Map<Ref, ItemRun[]>();
  if (refs.length === 0) return out;
  const q = queryDb(db);
  const { k } = q;
  const rp = () => kx.refPairs(db, refs, "rp");
  const matched = k.selectFrom("main.agent_run_items as mi").innerJoin(rp(), (j) => j.onRef("rp.repo", "=", "mi.repo").onRef("rp.number", "=", "mi.number")).select("mi.run_id");
  const counts = k.selectFrom("main.agent_run_tools as t").select(["t.run_id", (eb) => eb.fn.countAll<number>().as("n")]).where("t.run_id", "in", matched).groupBy("t.run_id").as("tc");
  const rows = (await q.all(visibleOnly(k.selectFrom("main.agent_run_items as i").innerJoin(rp(), (j) => j.onRef("rp.repo", "=", "i.repo").onRef("rp.number", "=", "i.number"))
    .innerJoin("main.agent_runs as r", "r.id", "i.run_id").leftJoin(counts, "tc.run_id", "r.id")
    .select((eb) => [...(runSelect()(eb) as never as string[]), "i.repo as item_repo", "i.number as item_number", eb.fn.coalesce("tc.n", eb.lit(0)).as("tool_count")] as never)
    .$if(o?.state === "running", (b) => b.where("r.state", "=", "running")), vis).orderBy("i.repo").orderBy("i.number").orderBy("r.id"))) as unknown as (Raw & { item_repo: string; item_number: number; tool_count: number })[];
  for (const r of rows) {
    const key = refKey(r.item_repo, Number(r.item_number));
    (out.get(key) ?? out.set(key, []).get(key)!).push({ ...toRun(r), toolCount: Number(r.tool_count), repo: r.item_repo, number: Number(r.item_number) });
  }
  return out;
}

const CALL_COLS = ["id", "job_id", "step", "provider", "model", "state", "started_at", "ended_at", "user_login"] as const;

/** Calls per job lane of the live board, in run id order. 1 statement. */
export async function loadJobRuns(db: Db, jobIds: number[], vis: RunVisibility): Promise<Map<number, JobCall[]>> {
  const out = new Map<number, JobCall[]>();
  if (jobIds.length === 0) return out;
  const q = queryDb(db);
  for (const part of kx.chunks(jobIds)) {
    const rows = (await q.all(visibleOnly(q.k.selectFrom("main.agent_runs as r").select(CALL_COLS.map((c) => `r.${c}` as const)).where(kx.inList(db, "r.job_id", part, "bigint")), vis).orderBy("r.id"))) as unknown as Pick<Raw, (typeof CALL_COLS)[number]>[];
    for (const [id, g] of group(rows, (r) => Number(r.job_id))) {
      out.set(id, g.map((r): JobCall => ({
        id: Number(r.id), step: r.step, provider: r.provider === "jev" ? "jev" : "claude", model: r.model, state: r.state as JobCall["state"], startedAt: r.started_at, endedAt: r.ended_at, userLogin: r.user_login,
      })));
    }
  }
  return out;
}

/** Running calls with no job, with their first item as a column. 1 statement. */
export async function loadLooseRuns(db: Db, vis: RunVisibility): Promise<RunRow[]> {
  const q = queryDb(db);
  return ((await q.all(visibleOnly(q.k.selectFrom("main.agent_runs as r").select(runSelect()).where("r.state", "=", "running").where("r.job_id", "is", null), vis).orderBy("r.id"))) as unknown as Raw[]).map(toRun);
}

/** The worker view's calls: running, or ended after `sinceIso`; the newest `limit`, oldest first. 1 statement, no subqueries for item data. */
export async function loadWorkerRuns(db: Db, vis: RunVisibility, sinceIso: string, limit: number): Promise<RunRow[]> {
  const q = queryDb(db);
  const rows = (await q.all(visibleOnly(q.k.selectFrom("main.agent_runs as r").select(runSelect())
    .where((eb) => eb.or([eb("r.state", "=", "running"), eb("r.ended_at", ">", sinceIso)])), vis).orderBy("r.id", "desc").limit(limit))) as unknown as Raw[];
  return rows.map(toRun).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/**
 * The `model-call` source of the activity stream: one row per run at its first item (runs with no item are left out), newest first, optionally of
 * one repo (the run's first item is in it) and at or before `before`'s second (stored times mix second and millisecond precision). 2 statements:
 * the page, then the tool counts of its runs.
 */
export async function listRunEvents(db: Db, f: { before?: string; limit: number; vis: RunVisibility; repo?: string }): Promise<(RunRow & { toolCount: number })[]> {
  const q = queryDb(db);
  const before = f.before ? `${f.before.slice(0, 19)}Z` : null;
  const rows = (await q.all(visibleOnly(q.k.selectFrom("main.agent_runs as r").select(runSelect())
    .where((eb) => eb.and([
      eb(runFirst(eb, "repo"), "is not", null),
      ...(f.repo ? [eb(runFirst(eb, "repo"), "=", f.repo)] : []),
      ...(before ? [eb("r.started_at", "<=", before)] : []),
    ])), f.vis).orderBy("r.started_at", "desc").orderBy("r.id", "desc").limit(f.limit))) as unknown as Raw[];
  if (rows.length === 0) return [];
  const counts = await toolCounts(db, rows.map((r) => Number(r.id)));
  return rows.map((r) => ({ ...toRun(r), toolCount: counts.get(Number(r.id)) ?? 0 }));
}

/** Last `samples` done runs per `step:model` (newest first; `running`: of the pairs running now), for the live board's estimates; the caller turns pairs into milliseconds. 1 statement. */
export async function loadCallDurations(db: Db, keys: { step: string; model: string }[] | "running", samples: number): Promise<Map<string, { startedAt: string; endedAt: string }[]>> {
  const out = new Map<string, { startedAt: string; endedAt: string }[]>();
  if (keys.length === 0) return out;
  const q = queryDb(db);
  const { k } = q;
  for (const part of keys === "running" ? [keys] : kx.chunks(keys)) {
    const pairs = part === "running" ? k.selectFrom("main.agent_runs as now").select(["now.step", "now.model"]).distinct().where("now.state", "=", "running").as("p")
      : kx.valuesTable(db, [...new Map(part.map((x) => [`${x.step}:${x.model}`, x])).values()].map((x) => ({ step: x.step, model: x.model })), { step: "text", model: "text" }, "p");
    // In descending order of the index on (step, model, id), so the limit ends each pair's read; a pair with fewer runs is followed by other pairs' rows, dropped outside.
    const newest = (eb: kx.Eb) => k.selectFrom("main.agent_runs as r").select(["r.step", "r.model", "r.id", "r.started_at", "r.ended_at"])
      .where((w) => w(w.refTuple("r.step", "r.model", "r.id"), "<=", w.tuple(eb.ref("p.step"), eb.ref("p.model"), w.lit(Number.MAX_SAFE_INTEGER)) as never))
      .where("r.state", "=", "done").where("r.ended_at", "is not", null).orderBy("r.step", "desc").orderBy("r.model", "desc").orderBy("r.id", "desc").limit(samples).as("t");
    const rows = await q.all((k.selectFrom(pairs as never) as any).select((eb: kx.Eb) => ["p.step", "p.model",
      kx.jsonRows(db, k.selectFrom(newest(eb)).select(["t.started_at", "t.ended_at"]).where("t.step", "=", eb.ref("p.step") as never).where("t.model", "=", eb.ref("p.model") as never).orderBy("t.id", "desc")).as("runs")])) as { step: string; model: string; runs: string }[];
    for (const r of rows) {
      const runs = kx.parseJsonRows<{ started_at: string; ended_at: string }>(r.runs);
      if (runs.length) out.set(`${r.step}:${r.model}`, runs.map((x) => ({ startedAt: x.started_at, endedAt: x.ended_at })));
    }
  }
  return out;
}

/** Last `n` done costs per prompt, newest first. 1 statement. */
export async function loadCostSamples(db: Db, promptIds: string[], n: number): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (promptIds.length === 0) return out;
  const q = queryDb(db);
  const { k } = q;
  for (const part of kx.chunks(promptIds)) {
    const rows = await q.all(k.selectFrom(k.selectFrom("main.agent_runs").select(["prompt_id", "cost_usd", "id",
      (eb) => eb.fn.agg<number>("row_number").over((w) => w.partitionBy("prompt_id").orderBy("id", "desc")).as("rn")])
      .where("state", "=", "done").where("cost_usd", "is not", null).where(kx.inList(db, "prompt_id", part)).as("t"))
      .select(["t.prompt_id", "t.cost_usd"]).where("t.rn", "<=", n).orderBy("t.prompt_id").orderBy("t.id", "desc"));
    for (const r of rows) (out.get(r.prompt_id) ?? out.set(r.prompt_id, []).get(r.prompt_id)!).push(Number(r.cost_usd));
  }
  return out;
}

/** Calls and spend per prompt id starting with `prefix`, for the Discord usage table, summed in SQL over the week. 1 statement. */
export async function loadPromptSpend(db: Db, prefix: string, dayIso: string, weekIso: string): Promise<PromptSpend[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.agent_runs").select((eb) => [
    "prompt_id", eb.fn.countAll<number>().as("week_calls"), eb.fn.coalesce(eb.fn.sum<number>("cost_usd"), eb.lit(0)).as("week_usd"),
    eb.fn.count<number>(eb.case().when("started_at", ">=", dayIso).then(1).end()).as("day_calls"),
    eb.fn.coalesce(eb.fn.sum<number>(eb.case().when("started_at", ">=", dayIso).then(eb.fn.coalesce("cost_usd", eb.lit(0))).end()), eb.lit(0)).as("day_usd"),
  ]).where((eb) => kx.like(db, "prompt_id", eb.val(`${kx.likeEscape(prefix)}%`), "\\")).where("started_at", ">=", weekIso).groupBy("prompt_id").orderBy("prompt_id"));
  return rows.map((r) => ({ prompt: r.prompt_id, dayCalls: Number(r.day_calls), dayUsd: Number(r.day_usd), weekCalls: Number(r.week_calls), weekUsd: Number(r.week_usd) }));
}

/** Cost of runs per step since a time (`sinceIso` may be a UTC day). Steps with no run are absent. 1 statement. */
export async function loadStepSpend(db: Db, steps: string[], sinceIso: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (steps.length === 0) return out;
  const q = queryDb(db);
  for (const r of await q.all(q.k.selectFrom("main.agent_runs").select((eb) => ["step", eb.fn.coalesce(eb.fn.sum<number>("cost_usd"), eb.lit(0)).as("c")])
    .where(kx.inList(db, "step", steps)).where("started_at", ">=", sinceIso).groupBy("step"))) out.set(r.step, Number(r.c));
  return out;
}

/** The highest run id, for the "runs this call made" pattern. */
export async function runWatermark(db: Db): Promise<number> {
  const q = queryDb(db);
  return Number((await q.get(q.k.selectFrom("main.agent_runs").select((eb) => eb.fn.coalesce(eb.fn.max<number | null>("id"), eb.lit(0)).as("n"))))!.n);
}

/** Runs after `after` of the given prompts and/or touching the item, in id order. 1 statement. */
export async function loadRunsAfter(db: Db, after: number, f: { promptIds?: string[]; item?: { repo: string; number: number } }): Promise<{ id: number; summary: string | null; costUsd: number | null }[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.agent_runs as r").select(["r.id", "r.summary", "r.cost_usd"]).where("r.id", ">", after)
    .$if(f.promptIds !== undefined, (b) => b.where(kx.inList(db, "r.prompt_id", f.promptIds!)))
    .$if(f.item !== undefined, (b) => b.where("r.id", "in", q.k.selectFrom("main.agent_run_items as i").select("i.run_id").where("i.repo", "=", f.item!.repo).where("i.number", "=", f.item!.number)))
    .orderBy("r.id"));
  return rows.map((r) => ({ id: Number(r.id), summary: r.summary, costUsd: numOrNull(r.cost_usd) }));
}

/** Newest start and the running count: the activity poll stamp. 1 statement. */
export async function loadRunStamp(db: Db): Promise<{ newestStartedAt: string | null; running: number }> {
  const q = queryDb(db);
  const r = (await q.get(q.k.selectFrom("main.agent_runs").select((eb) => [eb.fn.max<string | null>("started_at").as("newest"), eb.fn.count<number>(eb.case().when("state", "=", "running").then(1).end()).as("running")])))!;
  return { newestStartedAt: r.newest, running: Number(r.running) };
}

/**
 * Opus review runs per PR since `todayIso`, for the review gate: one count per job and PR (the reply-lint fix turn is a follow-up run of the
 * same job); `last` is the newest of those starts. 1 statement. `keys` are refs or a key source.
 */
export async function loadReviewRunCounts(db: Db, keys: ReviewRunKeys, todayIso: string): Promise<Map<Ref, { n: number; last: string | null }>> {
  const out = new Map<Ref, { n: number; last: string | null }>();
  const source = asKeySource(keys);
  if (Array.isArray(source) && source.length === 0) return out;
  const q = queryDb(db);
  const { k } = q;
  const starts = k.selectFrom("main.agent_run_items as i").innerJoin(resolveKeys(db, source, "kk"), (j) => j.onRef("kk.repo", "=", "i.repo").onRef("kk.number", "=", "i.number"))
    .innerJoin("main.agent_runs as r", "r.id", "i.run_id")
    .select((eb) => ["i.repo", "i.number", eb.fn.min<string>("r.started_at").as("s")]).where("r.step", "=", "opus-review")
    .groupBy(["i.repo", "i.number"]).groupBy((eb) => eb.fn.coalesce("r.job_id", eb("r.id", "*", -1))).as("x");
  for (const r of await q.all(k.selectFrom(starts).select((eb) => ["x.repo", "x.number", eb.fn.count<number>(eb.case().when("x.s", ">=", todayIso).then(1).end()).as("n"), eb.fn.max<string | null>("x.s").as("last")])
    .groupBy(["x.repo", "x.number"]))) out.set(refKey(r.repo, Number(r.number)), { n: Number(r.n), last: r.last });
  return out;
}

/** A login's runs since a time (MCP "my runs"), case-insensitive, newest first. 1 statement. */
export async function loadUserRuns(db: Db, login: string, sinceIso: string, limit: number): Promise<RunRow[]> {
  const q = queryDb(db);
  return ((await q.all(q.k.selectFrom("main.agent_runs as r").select(runSelect()).where((eb) => kx.ciEq(db, "r.user_login", eb.val(login))).where("r.started_at", ">=", sinceIso)
    .orderBy("r.id", "desc").limit(limit))) as unknown as Raw[]).map(toRun);
}

/** The summaries of the last `n` finished Jev runs, newest first. 1 statement. */
export async function loadRecentJevSummaries(db: Db, n: number): Promise<(string | null)[]> {
  const q = queryDb(db);
  return (await q.all(q.k.selectFrom("main.agent_runs").select("summary").where("provider", "=", "jev").where("state", "!=", "running").orderBy("id", "desc").limit(n))).map((r) => r.summary);
}

/** Runs per step and time bucket (the leading `prefixLen` characters of the start) for the Rates page. 1 statement. */
export async function loadRunBuckets(db: Db, o: { from: string; to: string; prefixLen: number; vis: RunVisibility }): Promise<{ step: string; bucket: string; runs: number; failed: number }[]> {
  const q = queryDb(db);
  const rows = await q.all(visibleOnly(q.k.selectFrom("main.agent_runs as r").select((eb) => [
    "r.step", eb.fn<string>("substr", ["r.started_at", eb.lit(1), eb.lit(o.prefixLen)]).as("bucket"), eb.fn.countAll<number>().as("runs"),
    eb.fn.coalesce(eb.fn.sum<number>(eb.case().when("r.state", "=", "failed").then(1).else(0).end()), eb.lit(0)).as("failed"),
  ]).where("r.started_at", ">=", o.from).where("r.started_at", "<", o.to), o.vis).groupBy("r.step").groupBy("bucket"));
  return rows.map((r) => ({ step: r.step, bucket: r.bucket, runs: Number(r.runs), failed: Number(r.failed) }));
}
