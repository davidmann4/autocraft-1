// Pointers to stored model-call transcripts (agent_run_transcripts); the objects themselves are in the transcript store (src/transcripts).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";

export type TranscriptRow = {
  id: number; runId: number; callId: number | null; attempt: number; outcome: "done" | "failed" | "refused"; store: "local" | "s3"; bucket: string | null;
  objectKey: string; bytes: number; rawBytes: number; sha256: string; lines: number; toolCount: number; lastTool: string | null; createdAt: string;
};
export type NewTranscript = Omit<TranscriptRow, "id">;

type Raw = {
  id: number; run_id: number; call_id: number | null; attempt: number; outcome: string; store: string; bucket: string | null; object_key: string;
  bytes: number; raw_bytes: number; sha256: string; lines: number; tool_count: number; last_tool: string | null; created_at: string;
};
const COLS = ["id", "run_id", "call_id", "attempt", "outcome", "store", "bucket", "object_key", "bytes", "raw_bytes", "sha256", "lines", "tool_count", "last_tool", "created_at"] as const;
const toRow = (r: Raw): TranscriptRow => ({
  id: Number(r.id), runId: Number(r.run_id), callId: r.call_id === null ? null : Number(r.call_id), attempt: Number(r.attempt), outcome: r.outcome as TranscriptRow["outcome"],
  store: r.store === "s3" ? "s3" : "local", bucket: r.bucket, objectKey: r.object_key, bytes: Number(r.bytes), rawBytes: Number(r.raw_bytes), sha256: r.sha256,
  lines: Number(r.lines), toolCount: Number(r.tool_count), lastTool: r.last_tool, createdAt: r.created_at,
});

/** Records one stored transcript: 1 statement. */
export async function insertTranscript(db: Db, t: NewTranscript): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    await q.run(q.k.insertInto("main.agent_run_transcripts").values({
      run_id: t.runId, call_id: t.callId, attempt: t.attempt, outcome: t.outcome, store: t.store, bucket: t.bucket, object_key: t.objectKey, bytes: t.bytes,
      raw_bytes: t.rawBytes, sha256: t.sha256, lines: t.lines, tool_count: t.toolCount, last_tool: t.lastTool, created_at: t.createdAt,
    }));
  });
}

/** The transcripts of a run, oldest first: 1 statement. */
export async function loadRunTranscripts(db: Db, runId: number): Promise<TranscriptRow[]> {
  const q = queryDb(db);
  return (await q.all(q.k.selectFrom("main.agent_run_transcripts").select([...COLS]).where("run_id", "=", runId).orderBy("id"))).map((r) => toRow(r as Raw));
}

/** One transcript of a run, or null: 1 statement. */
export async function loadTranscript(db: Db, runId: number, id: number): Promise<TranscriptRow | null> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("main.agent_run_transcripts").select([...COLS]).where("id", "=", id).where("run_id", "=", runId));
  return r ? toRow(r as Raw) : null;
}

/** A transcript a Task Runner may still send for an attempt it submitted (transcript_waits). */
export type TranscriptWait = { runId: number; callId: number; attempt: number; outcome: "done" | "failed" | "refused"; root: string | null };

/** Records that the attempt behind `secretHash` may send its transcript until `untilMs`, and drops the waits that ran out: 2 statements. */
export async function addTranscriptWait(db: Db, secretHash: string, w: TranscriptWait, untilMs: number, now: number): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    await q.run(q.k.deleteFrom("main.transcript_waits").where("until_ms", "<", now));
    await q.run(q.k.insertInto("main.transcript_waits").values({ secret_hash: secretHash, run_id: w.runId, call_id: w.callId, attempt: w.attempt, outcome: w.outcome, root: w.root, until_ms: untilMs })
      .onConflict((oc) => oc.column("secret_hash").doUpdateSet({ run_id: w.runId, call_id: w.callId, attempt: w.attempt, outcome: w.outcome, root: w.root, until_ms: untilMs })));
  });
}

const waitOf = (r: { run_id: number; call_id: number; attempt: number; outcome: string; root: string | null }): TranscriptWait => ({
  runId: Number(r.run_id), callId: Number(r.call_id), attempt: Number(r.attempt), outcome: r.outcome as TranscriptWait["outcome"], root: r.root,
});

/** Whether a transcript is still awaited for `secretHash`: 1 statement. */
export async function loadTranscriptWait(db: Db, secretHash: string, now: number): Promise<boolean> {
  const q = queryDb(db);
  return (await q.get(q.k.selectFrom("main.transcript_waits").select("run_id").where("secret_hash", "=", secretHash).where("until_ms", ">=", now))) !== undefined;
}

/** Takes the wait of `secretHash` (one upload per attempt), or null when there is none: 1 statement. */
export async function takeTranscriptWait(db: Db, secretHash: string): Promise<TranscriptWait | null> {
  const q = queryDb(db);
  const r = await db.write(async () => await q.get(q.k.deleteFrom("main.transcript_waits").where("secret_hash", "=", secretHash).returning(["run_id", "call_id", "attempt", "outcome", "root"])));
  return r ? waitOf(r) : null;
}
