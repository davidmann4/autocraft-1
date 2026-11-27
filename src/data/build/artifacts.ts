// Artifacts and logs (`build_artifacts`, `build_task_logs`) (package build-a).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { byteLen, idsIn, lastLogSteps } from "./rows.ts";
import type { ArtifactRow, IdSource, LogTail } from "./types.ts";

/** Artifact rows per task by name, optionally only some names or one content type. 1 statement. */
export async function loadArtifacts(db: Db, taskIds: IdSource, opt?: { names?: string[]; contentType?: string }): Promise<Map<number, ArtifactRow[]>> {
  if (Array.isArray(taskIds) && taskIds.length === 0) return new Map();
  if (opt?.names && opt.names.length === 0) return new Map();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("build_artifacts as a").select(["a.task_id", "a.name", "a.bytes", "a.content_type", "a.file"])
    .where((eb) => idsIn(db, eb, "a.task_id", taskIds))
    .$if(!!opt?.names, (s) => s.where(kx.inList(db, "a.name", opt!.names!)))
    .$if(!!opt?.contentType, (s) => s.where("a.content_type", "=", opt!.contentType!))
    .orderBy("a.task_id").orderBy("a.name"), { label: "build.loadArtifacts" });
  const out = new Map<number, ArtifactRow[]>();
  for (const r of rows) (out.get(r.task_id) ?? out.set(r.task_id, []).get(r.task_id)!).push({ taskId: r.task_id, name: r.name, bytes: r.bytes, contentType: r.content_type, file: r.file });
  return out;
}

/** Stored file names per `taskId/name` key. 1 statement. */
export async function loadArtifactFiles(db: Db, keys: { taskId: number; name: string }[]): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const q = queryDb(db);
  const want = kx.valuesTable(db, keys.map((k) => ({ id: k.taskId, name: k.name })), { id: "bigint", name: "text" }, "w");
  const rows = await q.all(q.k.selectFrom("build_artifacts as a").innerJoin(want, (j) => j.onRef("w.id", "=", "a.task_id").onRef("w.name", "=", "a.name")).select(["a.task_id", "a.name", "a.file"]), { label: "build.loadArtifactFiles" });
  return new Map(rows.map((r) => [`${r.task_id}/${r.name}`, r.file]));
}

/**
 * One transaction: the limits are checked against the task's `artifact_bytes`, its artifact count and the row it replaces (one
 * read), then the row is upserted and `artifact_bytes` follows. Sniffing and the file move stay in feature code. 3 statements.
 */
export async function addArtifact(db: Db, a: { taskId: number; name: string; bytes: number; contentType: string; file: string }, limits: { maxCount: number; maxBytes: number }): Promise<{ ok: true } | { refused: "count" | "size" | "missing" }> {
  const q = queryDb(db);
  return await db.write(async () => {
    const t = await q.get(q.k.selectFrom("build_tasks as t").select((eb) => [
      "t.artifact_bytes",
      eb.selectFrom("build_artifacts as c").select((c) => c.fn.countAll<number>().as("n")).whereRef("c.task_id", "=", "t.id").as("count"),
      eb.selectFrom("build_artifacts as o").select("o.bytes").whereRef("o.task_id", "=", "t.id").where("o.name", "=", a.name).as("old"),
    ]).where("t.id", "=", a.taskId));
    if (!t) return { refused: "missing" as const };
    const old = t.old === null || t.old === undefined ? null : Number(t.old);
    if (old === null && Number(t.count) >= limits.maxCount) return { refused: "count" as const };
    if (Number(t.artifact_bytes) - (old ?? 0) + a.bytes > limits.maxBytes) return { refused: "size" as const };
    await q.run(q.k.insertInto("build_artifacts").values({ task_id: a.taskId, name: a.name, bytes: a.bytes, content_type: a.contentType, file: a.file })
      .onConflict((oc) => oc.columns(["task_id", "name"]).doUpdateSet(kx.excluded(["bytes", "content_type", "file"]))));
    await q.run(q.k.updateTable("build_tasks").set((eb) => ({ artifact_bytes: eb(eb("artifact_bytes", "-", old ?? 0), "+", a.bytes) })).where("id", "=", a.taskId));
    return { ok: true as const };
  });
}

/** Deletes the artifact rows of tasks and zeroes `artifact_bytes`; returns the ids so the caller removes the directories after the commit. 2 statements. */
export async function removeArtifactRows(db: Db, taskIds: number[]): Promise<number[]> {
  if (taskIds.length === 0) return [];
  const q = queryDb(db);
  await db.write(async () => {
    await q.run(q.k.deleteFrom("build_artifacts").where(kx.inList(db, "task_id", taskIds, "bigint")));
    await q.run(q.k.updateTable("build_tasks").set({ artifact_bytes: 0 }).where(kx.inList(db, "id", taskIds, "bigint")));
  });
  return [...taskIds];
}

/**
 * The newest chunks of each task's log whose bytes before them are under `maxBytes` (a windowed running sum, so only the tail is
 * read), at most `maxChunks`, of the step named in `tasks` when given; the text is cut to the last `maxBytes` bytes. `bytes` is the
 * whole log's size. 2 statements in one wave.
 */
export async function loadLogTails(db: Db, tasks: { id: number; step?: string }[], o: { maxBytes: number; maxChunks?: number }): Promise<Map<number, LogTail>> {
  if (tasks.length === 0) return new Map();
  const q = queryDb(db);
  const want = kx.valuesTable(db, tasks.map((t) => ({ id: t.id, step: t.step ?? null })), { id: "bigint", step: "text" }, "w");
  const [chunks, sizes] = await db.together(async () => await Promise.all([
    q.all(q.k.selectFrom((eb) => eb.selectFrom("build_task_logs as l").innerJoin(want, (j) => j.onRef("w.id", "=", "l.task_id").on((e) => e.or([e("w.step", "is", null), e("w.step", "=", e.ref("l.step"))])))
      .select((e) => ["l.task_id", "l.seq", "l.chunk", byteLen(db, "l.chunk").as("len"),
        e.fn.sum(byteLen(db, "l.chunk")).over((w) => w.partitionBy("l.task_id").orderBy("l.seq", "desc")).as("cum"),
        e.fn.agg<number>("row_number").over((w) => w.partitionBy("l.task_id").orderBy("l.seq", "desc")).as("rn")]).as("s"))
      .select(["s.task_id", "s.seq", "s.chunk"]).where((e) => e.and([e(e("s.cum", "-", e.ref("s.len")), "<", o.maxBytes), ...(o.maxChunks ? [e("s.rn", "<=", o.maxChunks)] : [])]))
      .orderBy("s.task_id").orderBy("s.seq", "desc"), { label: "build.loadLogTails" }),
    q.all(q.k.selectFrom("build_tasks").select(["id", "log_bytes"]).where(kx.inList(db, "id", tasks.map((t) => t.id), "bigint")), { label: "build.loadLogTails" }),
  ]));
  const parts = new Map<number, string[]>();
  for (const c of chunks) (parts.get(c.task_id) ?? parts.set(c.task_id, []).get(c.task_id)!).push(c.chunk);
  const out = new Map<number, LogTail>();
  for (const s of sizes) {
    const joined = (parts.get(s.id) ?? []).reverse().join("");
    const size = Buffer.byteLength(joined);
    const text = size > o.maxBytes ? Buffer.from(joined).subarray(-o.maxBytes).toString("utf8") : joined;
    out.set(s.id, { text, bytes: s.log_bytes, truncated: s.log_bytes > Buffer.byteLength(text) });
  }
  return out;
}

/** The step each task's newest chunk is on (live board). 1 statement. */
export async function loadLogSteps(db: Db, taskIds: number[]): Promise<Map<number, string>> {
  if (taskIds.length === 0) return new Map();
  return await lastLogSteps(db, taskIds);
}
