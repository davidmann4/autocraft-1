// The check relay (`remote_checks`) (package runners-b).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import type { RelayedCheck } from "./types.ts";

/** Stores a check a call asked its helper to run; `input` is the request as JSON text. */
export async function requestCheck(db: Db, call: { id: number; runId: number | null }, input: string, now: number): Promise<number> {
  const q = queryDb(db);
  return Number((await q.get(q.k.insertInto("main.remote_checks").values({ call_id: call.id, run_id: call.runId, input, state: "requested", requested_at: now }).returning("id")))!.id);
}

/** One check row, read through `db.fresh`: the waiting request polls it until the helper's result lands. */
export async function loadCheckResult(db: Db, id: number): Promise<{ id: number; state: string; result: string | null } | null> {
  const q = queryDb(db);
  const r = await db.fresh(() => q.get(q.k.selectFrom("main.remote_checks").select(["id", "state", "result"]).where("id", "=", id)));
  return r ? { id: Number(r.id), state: r.state, result: r.result } : null;
}

/**
 * The calls with a requested check: one their current lease made, which takeRequestedChecks takes, or with `everyLease` one of any
 * lease, which refuseChecks refuses. 1 statement.
 */
export async function loadRequestedChecks(db: Db, callIds: number[], o: { everyLease?: boolean } = {}): Promise<Set<number>> {
  if (!callIds.length) return new Set();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.remote_checks as k").innerJoin("main.remote_calls as c", "c.id", "k.call_id").select("k.call_id").distinct()
    .where(kx.inList(db, "k.call_id", callIds, "bigint")).where("k.state", "=", "requested")
    .$if(!o.everyLease, (b) => b.where((eb) => eb("k.run_id", "is not distinct from", eb.ref("c.run_id")))));
  return new Set(rows.map((r) => Number(r.call_id)));
}

/**
 * Marks the call's requested checks `running` in one `UPDATE ... RETURNING`, oldest first. Only requests made under the call's
 * current lease run (`run_id`) are taken; one made under an earlier lease is stale and left alone.
 */
export async function takeRequestedChecks(db: Db, callId: number): Promise<RelayedCheck[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.updateTable("main.remote_checks").set({ state: "running" }).where("call_id", "=", callId).where("state", "=", "requested")
    .where((eb) => eb("run_id", "is not distinct from", eb.selectFrom("main.remote_calls").select("run_id").where("id", "=", callId)))
    .returning(["id", "run_id", "input"]));
  return rows.map((r) => ({ id: Number(r.id), runId: r.run_id === null ? null : Number(r.run_id), input: r.input })).sort((a, b) => a.id - b.id);
}

/** Stores results (JSON text) in one statement, compare-and-set on `state != 'done'`: a check already refused keeps its refusal. */
export async function finishChecks(db: Db, rows: { id: number; result: string }[], now: number): Promise<void> {
  if (!rows.length) return;
  const q = queryDb(db);
  await q.run(q.k.updateTable("main.remote_checks").set({ state: "done", result: kx.caseOf("id", rows.map((r) => [r.id, r.result] as const)), ended_at: now })
    .where(kx.inList(db, "id", rows.map((r) => r.id), "bigint")).where("state", "!=", "done"));
}

/** Refuses a call's open (requested) checks, or one check, with a text stored as given (callers write `refused: ...`). */
export async function refuseChecks(db: Db, a: { callId: number } | { id: number }, text: string, now: number): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.updateTable("main.remote_checks").set({ state: "done", result: JSON.stringify({ text, isError: true }), ended_at: now })
    .where("state", "=", "requested").$if("callId" in a, (s) => s.where("call_id", "=", (a as { callId: number }).callId)).$if("id" in a, (s) => s.where("id", "=", (a as { id: number }).id)));
}

const textOf = (c: unknown): string => (typeof c === "string" ? c : Array.isArray(c) ? c.map((b: { text?: unknown }) => (typeof b?.text === "string" ? b.text : "")).join("") : "");

/** The reply text of each check relayed for a call and run, in request order ("" for a check with no readable reply yet). */
export async function loadRelayedCheckTexts(db: Db, callId: number, runId: number | null): Promise<string[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.remote_checks").select("result").where("call_id", "=", callId).where("run_id", "is not distinct from", runId).orderBy("id"));
  return rows.map((r) => { try { return textOf((JSON.parse(r.result ?? "null") as { text?: unknown } | null)?.text); } catch { return ""; } });
}
