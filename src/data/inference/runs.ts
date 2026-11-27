// Run records: write and lifecycle (`agent_runs`, `agent_run_items`, `agent_run_texts`, `agent_run_tools`). No writer takes a named lock.
// reads: runners.remote_calls
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { keptRuns } from "../runners/fragments.ts";
import { ERROR_MAX, MAX_ITEM_REFS, RUN_KEEP_MS, TEXT_KEEP_MS, TEXT_MAX, packText, type RunEnd, type RunStart, type ToolRow } from "./types.ts";

const now = (): string => new Date().toISOString();
type Scrub = (s: string) => string;

/** A text in its stored form: bytes as they are, a string scrubbed, cut and compressed. A string with no `scrub` is refused, so no text is stored unscrubbed. */
function stored(text: string | Uint8Array, scrub: Scrub | undefined, what: string): Uint8Array {
  if (typeof text !== "string") return text;
  if (!scrub) throw new Error(`inference: ${what} is a string and no scrub function was given`);
  return packText(scrub(text.slice(0, TEXT_MAX)));
}

/**
 * Inserts running rows with their item rows and prompt texts, in the caller's transaction (`leaseCall` calls it under the login lock), else in one
 * of its own, and returns their ids in order. Statements, for any number of runs (per 500 rows): the runs, their items, their texts, and one more
 * for the runs whose items are of several repos. A run's first item (lowest repo and number by the database's own order) is kept in its columns, so
 * the live board and the activity feed read it there.
 */
export async function openRuns(db: Db, starts: readonly RunStart[], scrub?: Scrub): Promise<number[]> {
  if (!starts.length) return [];
  const q = queryDb(db);
  const { k } = q;
  const at = now();
  const prompts = starts.map((s) => stored(s.prompt, scrub, "the prompt"));
  const rows = starts.map((s) => {
    const repo = s.items.length && s.items.every((r) => r.repo === s.items[0]!.repo) ? s.items[0]!.repo : null;
    return {
      job_id: s.jobId, step: s.step, stage: s.stage, prompt_id: s.promptId, prompt_version: s.promptVersion, provider: s.provider, model: s.model,
      items: JSON.stringify(s.items.slice(0, MAX_ITEM_REFS)), item_count: s.items.length, state: "running" as const, started_at: at,
      first_repo: repo, first_number: repo === null ? null : Math.min(...s.items.map((r) => r.number)),
      user_login: s.remote?.userLogin ?? null, harness: s.remote?.harness ?? null, reported_model: s.remote?.reportedModel ?? null, call_id: s.remote?.callId ?? null,
    };
  });
  const open = async (): Promise<number[]> => {
    const ids: number[] = [];
    for (const part of kx.batches(rows)) for (const r of await q.all(k.insertInto("main.agent_runs").values(part).returning("id"))) ids.push(Number(r.id));
    const items = starts.flatMap((s, i) => s.items.map((r) => ({ run_id: ids[i]!, repo: r.repo, number: r.number })));
    for (const part of kx.batches(items)) await q.run(k.insertInto("main.agent_run_items").values(part).onConflict((oc) => oc.doNothing()));
    for (const part of kx.batches(prompts.map((prompt, i) => ({ run_id: ids[i]!, prompt })))) await q.run(k.insertInto("main.agent_run_texts").values(part));
    const mixed = ids.filter((_, i) => starts[i]!.items.length > 0 && rows[i]!.first_repo === null);
    if (mixed.length) {
      const first = (col: "repo" | "number") => k.selectFrom("main.agent_run_items as ri").select(`ri.${col}`).whereRef("ri.run_id", "=", "agent_runs.id" as never).orderBy("ri.repo").orderBy("ri.number").limit(1);
      await q.run(k.updateTable("main.agent_runs").set({ first_repo: first("repo") as never, first_number: first("number") as never }).where(kx.inList(db, "id", mixed, "bigint")));
    }
    return ids;
  };
  return db.inTransaction("write") ? await open() : await db.write(open);
}

/** One-run wrapper over `openRuns`. */
export async function openRun(db: Db, s: RunStart, scrub?: Scrub): Promise<number> {
  return (await openRuns(db, [s], scrub))[0]!;
}

/**
 * Ends runs with one `UPDATE ... FROM` guarded by `state = 'running'` (per 500 runs), plus one text upsert when any end has output (a text is bytes, so it
 * cannot ride in the JSON values). Returns the runs ended. A run that was no longer running keeps its row, and its output is not written.
 */
export async function finishRuns(db: Db, ends: RunEnd[], scrub?: Scrub): Promise<number> {
  if (ends.length === 0) return 0;
  const q = queryDb(db);
  const at = now();
  const byId = new Map(ends.map((e) => [e.id, e]));
  const rows = [...byId.values()].map((e) => ({
    id: e.id, state: e.state, ended_at: at, input_tokens: e.tokens?.input ?? null, output_tokens: e.tokens?.output ?? null,
    cache_read_tokens: e.tokens?.cacheRead ?? null, cache_write_tokens: e.tokens?.cacheWrite ?? null, cost_usd: e.costUsd ?? null,
    summary: e.summary ?? null, error: e.error ? e.error.slice(0, ERROR_MAX) : null, refusal: e.refusal ?? null,
  }));
  const set = ["state", "ended_at", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_usd", "summary", "error", "refusal"] as const;
  const outputs = new Map<number, Uint8Array>();
  for (const e of byId.values()) if (e.output) outputs.set(e.id, stored(e.output, scrub, "the output"));
  return await db.write(async () => {
    let n = 0;
    for (const chunk of kx.chunks(rows, 500)) {
      const v = kx.valuesTable(db, chunk, {
        id: "bigint", state: "text", ended_at: "text", input_tokens: "bigint", output_tokens: "bigint", cache_read_tokens: "bigint", cache_write_tokens: "bigint",
        cost_usd: "numeric", summary: "text", error: "text", refusal: "text",
      }, "v");
      const done = await q.all((q.k as any).updateTable("agent_runs").from(v)
        .set((eb: kx.Eb) => ({ ...Object.fromEntries(set.map((c) => [c, eb.ref(`v.${c}`)])), progress: null }))
        .where((eb: kx.Eb) => eb.and([eb("agent_runs.id", "=", eb.ref("v.id")), eb("agent_runs.state", "=", "running")]))
        .returning("agent_runs.id as id")) as { id: number }[];
      n += done.length;
      const live = done.filter((d) => outputs.has(Number(d.id)));
      if (live.length) await recordTexts(db, live.map((d) => ({ runId: Number(d.id), output: outputs.get(Number(d.id))! })));
    }
    return n;
  });
}

/** One-line wrapper over `finishRuns`. */
export async function finishRun(db: Db, end: RunEnd, scrub?: Scrub): Promise<number> {
  return await finishRuns(db, [end], scrub);
}

/** Sets the progress line of running runs; 1 statement per 500 rows. */
export async function setRunProgress(db: Db, rows: { id: number; line: string }[]): Promise<number> {
  return await patchRuns(db, rows.map((r) => ({ id: r.id, value: r.line })), "progress", true);
}

/** Sets the model a Task Runner reported; 1 statement per 500 rows. */
export async function setReportedModel(db: Db, rows: { id: number; model: string }[]): Promise<number> {
  return await patchRuns(db, rows.map((r) => ({ id: r.id, value: r.model })), "reported_model", false);
}

async function patchRuns(db: Db, rows: { id: number; value: string }[], col: "progress" | "reported_model", onlyRunning: boolean): Promise<number> {
  if (rows.length === 0) return 0;
  const q = queryDb(db);
  const last = new Map(rows.map((r) => [r.id, r]));
  let n = 0;
  for (const chunk of kx.chunks([...last.values()], 500)) {
    const v = kx.valuesTable(db, chunk, { id: "bigint", value: "text" }, "v");
    n += Number((await q.run((q.k as any).updateTable("agent_runs").from(v).set((eb: kx.Eb) => ({ [col]: eb.ref("v.value") }))
      .where((eb: kx.Eb) => eb.and([eb("agent_runs.id", "=", eb.ref("v.id")), ...(onlyRunning ? [eb("agent_runs.state", "=", "running")] : [])])))).changes);
  }
  return n;
}

/** Fails running runs, except those of adoptable calls of resuming jobs (the runners fragment `keptRuns`). */
export async function failRunning(db: Db, reason: string, scope?: { jobId: number }): Promise<number> {
  const q = queryDb(db);
  const r = await q.run(q.k.updateTable("main.agent_runs").set({ state: "failed", ended_at: now(), error: reason, summary: reason }).where("state", "=", "running")
    .$if(scope !== undefined, (b) => b.where("job_id", "=", scope!.jobId)).where("id", "not in", keptRuns(db)));
  return Number(r.changes);
}

/** Upserts tool rows, 1 statement per 500 rows. */
export async function saveTools(db: Db, rows: ToolRow[]): Promise<void> {
  if (rows.length === 0) return;
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.batches(rows)) {
      await q.run(q.k.insertInto("main.agent_run_tools").values(part.map((t) => ({
        run_id: t.runId, seq: t.seq, tool: t.tool, args: t.args ?? "", result_bytes: t.resultBytes, is_error: t.isError ? 1 : 0, started_at: t.startedAt, ended_at: t.endedAt, check_id: t.checkId,
      }))).onConflict((oc) => oc.columns(["run_id", "seq"]).doUpdateSet(kx.excluded(["tool", "args", "result_bytes", "is_error", "started_at", "ended_at", "check_id"]))));
    }
  });
}

/**
 * Upserts prompt or output texts: one statement per column shape (prompt, output, both) per 500 rows, so at most 3. The last row of a run wins.
 * A string is stored scrubbed and needs `scrub`.
 */
export async function recordTexts(db: Db, rows: { runId: number; prompt?: string | Uint8Array; output?: string | Uint8Array }[], scrub?: Scrub): Promise<void> {
  if (rows.length === 0) return;
  const q = queryDb(db);
  const shapes = new Map<string, Map<number, { run_id: number; prompt?: Uint8Array; output?: Uint8Array }>>();
  for (const r of rows) {
    const shape = `${r.prompt !== undefined ? "p" : ""}${r.output !== undefined ? "o" : ""}`;
    if (!shape) continue;
    const m = shapes.get(shape) ?? shapes.set(shape, new Map()).get(shape)!;
    m.set(r.runId, {
      run_id: r.runId, ...(r.prompt !== undefined && { prompt: stored(r.prompt, scrub, "the prompt") }), ...(r.output !== undefined && { output: stored(r.output, scrub, "the output") }),
    });
  }
  await db.write(async () => {
    for (const [shape, m] of shapes) {
      const cols = [...(shape.includes("p") ? ["prompt"] : []), ...(shape.includes("o") ? ["output"] : [])] as ("prompt" | "output")[];
      for (const part of kx.batches([...m.values()])) {
        await q.run(q.k.insertInto("main.agent_run_texts").values(part).onConflict((oc) => oc.column("run_id").doUpdateSet(kx.excluded(cols))));
      }
    }
  });
}

/** Deletes texts of runs of the given steps, optionally only finished ones. */
export async function removeRunTexts(db: Db, f: { steps: string[]; finishedOnly: boolean }): Promise<number> {
  if (f.steps.length === 0) return 0;
  const q = queryDb(db);
  const runs = q.k.selectFrom("main.agent_runs").select("id").where(kx.inList(db, "step", f.steps)).$if(f.finishedOnly, (b) => b.where("state", "<>", "running"));
  return Number((await q.run(q.k.deleteFrom("main.agent_run_texts").where("run_id", "in", runs))).changes);
}

/**
 * Deletes old runs and texts as separate lone statements so the writer lock is not held across the large deletes. 6 statements: two
 * cutoff reads (by the started_at index) and four deletes by cutoff id.
 */
export async function pruneRuns(db: Db, nowMs: number): Promise<{ texts: number; runs: number }> {
  const q = queryDb(db);
  const maxBefore = async (ms: number): Promise<number> => Number((await q.get(q.k.selectFrom("main.agent_runs").select((eb) => eb.fn.coalesce(eb.fn.max("id"), eb.lit(0)).as("id"))
    .where("started_at", "<", new Date(nowMs - ms).toISOString())))!.id);
  const texts = Number((await q.run(q.k.deleteFrom("main.agent_run_texts").where("run_id", "<=", await maxBefore(TEXT_KEEP_MS)))).changes);
  const old = await maxBefore(RUN_KEEP_MS);
  await q.run(q.k.deleteFrom("main.agent_run_tools").where("run_id", "<=", old));
  await q.run(q.k.deleteFrom("main.agent_run_items").where("run_id", "<=", old));
  const runs = Number((await q.run(q.k.deleteFrom("main.agent_runs").where("id", "<=", old))).changes);
  return { texts, runs };
}
