// Workspace tool calls (`workspace_calls`) (package build-b).
// reads: runners.remote_calls (through runners/fragments.ts: callSince, leasedRunOf, leasedRunsOf, runOfCall)
import { createHash } from "node:crypto";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { callSince, leasedRunOf, leasedRunsOf, runOfCall } from "../runners/fragments.ts";
import { patchRows } from "./row-patch.ts";
import type { CallAccounting, NewWorkspaceCall, ToolCallQuery, WorkspaceCallRow } from "./types.ts";

/** Tools whose results carry images. */
export const IMAGE_TOOLS = ["screenshot", "read"];
/** How long after its workspace ended a call keeps its image bytes. */
export const IMAGE_KEEP_MS = 30 * 24 * 3600_000;
const PRUNE_BATCH = 200;
const NUMERIC = ["workspace_id", "n", "run_id"] as const;
const STUCK = { text: "failed: the process running this call ended before it finished, so its outcome is unknown; check the workspace and call it again", isError: true };

/** `created_at` (ISO text) in epoch ms, within float error; compared with a 0.5 ms margin so an equal ms counts as not before. */
const createdMs = (eb: any) => eb(eb.parens(eb.fn("julianday", [eb.ref("created_at")]), "-", eb.lit(2440587.5)), "*", eb.lit(86400000));

/**
 * When the bound call's work started (the first call not in `ownTools` since the call was queued) and the tool and result of each such
 * call. `since` is `runners.fragments.callSince` embedded; a call never queued gives no rows. 2 statements in one wave.
 */
export async function loadWorkspaceCallSince(db: Db, workspaceId: number, callId: number, ownTools: string[]): Promise<{ firstWorkAt: string | null; stats: { tool: string; result: string | null }[] }> {
  const q = queryDb(db);
  const since = (b: any) => b.where("workspace_id", "=", workspaceId).where(kx.inList(db, "tool", ownTools, "text", true))
    .where((eb: any) => eb(createdMs(eb), ">=", eb(callSince(eb, eb.lit(callId)), "-", eb.lit(0.5))));
  const [first, stats] = await db.together(() => Promise.all([
    q.get(since(q.k.selectFrom("main.workspace_calls").select("created_at")).orderBy("id").limit(1)) as Promise<{ created_at: string } | undefined>,
    q.all(since(q.k.selectFrom("main.workspace_calls").select(["tool", "result"])).orderBy("id")) as Promise<{ tool: string; result: string | null }[]>,
  ]));
  return { firstWorkAt: first?.created_at ?? null, stats };
}

/** Batched insert returning ids, in row order. */
export async function addWorkspaceCalls(db: Db, rows: NewWorkspaceCall[]): Promise<number[]> {
  if (!rows.length) return [];
  const q = queryDb(db);
  return await db.write(async () => {
    const ids: number[] = [];
    for (const part of kx.batches(rows)) ids.push(...(await q.all(q.k.insertInto("main.workspace_calls").values(part).returning("id"))).map((r) => Number(r.id)));
    return ids;
  });
}

/** Batched settle, start or refuse by id, with compare-and-set on `where` (the states the row must be in); returns the ids changed. Values are set as given. */
export async function markCalls(db: Db, rows: { id: number; where?: string[]; set: Partial<Omit<WorkspaceCallRow, "id">> }[]): Promise<Set<number>> {
  return await patchRows(db, "workspace_calls", rows.map((r) => ({ id: r.id, from: r.where, set: r.set })), NUMERIC);
}

/**
 * Starts the queued calls of the workspace that belong to the live lease of `callId`: one `UPDATE ... RETURNING`. The arguments
 * returned are the stored ones in full; the caller cuts the row's copy to its record size with `markCalls`.
 */
export async function claimQueuedCalls(db: Db, workspaceId: number, callId: number): Promise<{ id: number; tool: string; args: string }[]> {
  const q = queryDb(db);
  const rows = await db.write(async () => await q.all(q.k.updateTable("main.workspace_calls").set({ state: "running", started_at: new Date().toISOString() })
    .where("workspace_id", "=", workspaceId).where("state", "=", "queued").where("run_id", "=", leasedRunOf(db, callId)).returning(["id", "tool", "args"])));
  return rows.map((r) => ({ id: Number(r.id), tool: r.tool, args: r.args })).sort((a, b) => a.id - b.id);
}

/** The workspaces of `pairs` with a call claimQueuedCalls would claim. 1 statement. */
export async function loadQueuedWorkspaces(db: Db, pairs: { workspaceId: number; callId: number }[]): Promise<Set<number>> {
  if (!pairs.length) return new Set();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.workspace_calls").select("workspace_id").distinct().where(kx.inList(db, "workspace_id", pairs.map((p) => p.workspaceId), "bigint"))
    .where("state", "=", "queued").where((eb) => eb("run_id", "in", leasedRunsOf(db, pairs.map((p) => p.callId)))));
  return new Set(rows.map((r) => Number(r.workspace_id)));
}

/** Refuses the queued calls of the workspace under the last run of `callId` (no live lease needed) with `result`; returns their ids. */
export async function refuseQueuedCalls(db: Db, workspaceId: number, callId: number, result: string): Promise<number[]> {
  const q = queryDb(db);
  const rows = await db.write(async () => await q.all(q.k.updateTable("main.workspace_calls").set({ state: "failed", result, finished_at: new Date().toISOString() })
    .where("workspace_id", "=", workspaceId).where("state", "=", "queued").where("run_id", "=", runOfCall(db, callId)).returning("id")));
  return rows.map((r) => Number(r.id)).sort((a, b) => a - b);
}

/** Calls of the live lease of `callId` still marked running (a dead process left them), for takeover; oldest first. */
export async function loadRunningCalls(db: Db, workspaceId: number, callId: number): Promise<WorkspaceCallRow[]> {
  const q = queryDb(db);
  return await q.all(q.k.selectFrom("main.workspace_calls").selectAll().where("workspace_id", "=", workspaceId).where("state", "=", "running")
    .where("run_id", "=", leasedRunOf(db, callId)).orderBy("id"));
}

/** Fails calls running past their deadline: the process that ran them died. Rows without a deadline are the relay's own. Returns the rows failed. */
export async function failStuckCalls(db: Db, nowIso: string): Promise<number> {
  const q = queryDb(db);
  return (await db.write(async () => await q.all(q.k.updateTable("main.workspace_calls").set({ state: "failed", result: JSON.stringify(STUCK), finished_at: nowIso })
    .where("state", "=", "running").where("deadline_at", "is not", null).where("deadline_at", "<", nowIso).returning("id")))).length;
}

/** The state and result of one call (of the workspace when given), or null; callers wrap it in `db.fresh`. */
export async function loadCallResult(db: Db, id: number, workspaceId?: number): Promise<{ state: string; result: string | null } | null> {
  const q = queryDb(db);
  return (await q.get(q.k.selectFrom("main.workspace_calls").select(["state", "result"]).where("id", "=", id)
    .$if(workspaceId !== undefined, (b) => b.where("workspace_id", "=", workspaceId!)))) ?? null;
}

/** Calls of the workspace for the tool session, oldest first: by id, ids, tool and call number `n` (all given filters apply). */
export async function loadToolCalls(db: Db, workspaceId: number, f: ToolCallQuery): Promise<WorkspaceCallRow[]> {
  if (f.ids && !f.ids.length) return [];
  const q = queryDb(db);
  return await q.all(q.k.selectFrom("main.workspace_calls").selectAll().where("workspace_id", "=", workspaceId)
    .$if(f.id !== undefined, (b) => b.where("id", "=", f.id!))
    .$if(!!f.ids, (b) => b.where(kx.inList(db, "id", f.ids!, "bigint")))
    .$if(f.tool !== undefined, (b) => b.where("tool", "=", f.tool!))
    .$if(f.n !== undefined, (b) => b.where("n", "=", f.n!))
    .orderBy("id"));
}

/** The bookkeeping of the workspace's calls of tools other than `skipTools`, oldest first; whole results are not read. 1 statement. */
export async function loadCallAccounting(db: Db, workspaceId: number, skipTools: readonly string[]): Promise<CallAccounting[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.workspace_calls")
    .select((eb) => {
      const res = eb.case().when(kx.jsonValid(db, "result")).then(eb.ref("result")).end();
      const arg = eb.case().when(kx.jsonValid(db, "args")).then(eb.ref("args")).end();
      const num = (path: string) => kx.jsonNum(db, res, `$.acct.${path}`);
      return ["id", "n", "tool", "state", "started_at", num("ms").as("ms"), num("bytes").as("bytes"), num("bg").as("bg"), num("limit").as("lim"), num("ref").as("ref"),
        num("ended").as("ended"), num("images").as("images"), kx.jsonBool(db, arg, "$.background").as("background"), kx.jsonNum(db, arg, "$.timeout_sec").as("timeout")] as const;
    })
    .where("workspace_id", "=", workspaceId).$if(skipTools.length > 0, (b) => b.where("tool", "not in", [...skipTools])).orderBy("id"));
  const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return rows.map((r) => ({
    id: Number(r.id), n: n(r.n), tool: r.tool, state: r.state, started_at: r.started_at, ms: n(r.ms), bytes: n(r.bytes), bg: n(r.bg), lim: n(r.lim), ref: n(r.ref),
    ended: n(r.ended), images: n(r.images), background: Number(r.background) === 1 ? 1 : 0, timeout: n(r.timeout),
  }));
}

/** Image calls of the run (`runId` null: calls with no run) before call `beforeId` that still keep their image bytes. */
export async function countKeptImages(db: Db, workspaceId: number, runId: number | null, beforeId: number): Promise<number> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("main.workspace_calls").select((eb) => eb.fn.countAll<number>().as("n"))
    .where("workspace_id", "=", workspaceId).where("id", "<", beforeId).where(kx.inList(db, "tool", IMAGE_TOOLS))
    .where((eb) => runId === null ? eb("run_id", "is", null) : eb("run_id", "=", runId))
    .where(kx.jsonType(db, "result", "$.images[0].data"), "=", "text"));
  return Number(r?.n ?? 0);
}

/** A stored result with its images as type, size and hash plus `note`; null when it has no images or is not JSON. */
export function stubbedImages(stored: string, note: string): string | null {
  let o: { images?: { data?: unknown; mimeType?: unknown }[] };
  try { o = JSON.parse(stored) as typeof o; } catch { return null; }
  if (!Array.isArray(o.images)) return null;
  const images = o.images.map((i) => {
    if (typeof i?.data !== "string") return i;
    const bytes = Buffer.from(i.data, "base64");
    return { mimeType: i.mimeType, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), note };
  });
  return JSON.stringify({ ...o, images });
}

/** Replaces stored results with their stubs where the row still holds `stored` (compare-and-set): one statement per 10,000 rows. Returns the rows changed. */
export async function stubImages(db: Db, rows: { id: number; stored: string; stubbed: string }[]): Promise<number> {
  if (!rows.length) return 0;
  const q = queryDb(db);
  return await db.write(async () => {
    let n = 0;
    for (const part of kx.chunks(rows)) {
      const v = kx.valuesTable(db, part, { id: "bigint", stored: "text", stubbed: "text" }, "v");
      n += Number((await q.run(q.k.updateTable("main.workspace_calls").from(v).set((eb) => ({ result: eb.ref("v.stubbed") }))
        .whereRef("main.workspace_calls.id", "=", "v.id").whereRef("main.workspace_calls.result", "=", "v.stored"))).changes);
    }
    return n;
  });
}

/**
 * One batch of the image prune: up to 200 image calls after id `after` in workspaces that ended more than IMAGE_KEEP_MS before `nowMs`
 * and still keep image bytes, stubbed. `rows` is the batch size (0: done), `last` the id to continue after. 2 statements.
 */
export async function pruneWorkspaceImageBatch(db: Db, nowMs: number, after: number): Promise<{ rows: number; last: number }> {
  const before = new Date(nowMs - IMAGE_KEEP_MS).toISOString();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.workspace_calls as c").innerJoin("main.workspaces as w", "w.id", "c.workspace_id").select(["c.id", "c.result"])
    .where("w.ended_at", "is not", null).where("w.ended_at", "<", before).where(kx.inList(db, "c.tool", IMAGE_TOOLS))
    .where("c.id", ">", after).where(kx.jsonType(db, "c.result", "$.images[0].data"), "=", "text").orderBy("c.id").limit(PRUNE_BATCH));
  if (!rows.length) return { rows: 0, last: after };
  const note = `${IMAGE_KEEP_MS / 86_400_000} days after the workspace ended`;
  const stubs = rows.flatMap((r) => {
    const stubbed = r.result === null ? null : stubbedImages(r.result, note);
    return stubbed === null ? [] : [{ id: Number(r.id), stored: r.result!, stubbed }];
  });
  await stubImages(db, stubs);
  return { rows: rows.length, last: Number(rows.at(-1)!.id) };
}
