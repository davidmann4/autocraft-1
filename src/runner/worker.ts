// Worker thread of the runner (see offthread.ts): runs the planner's detection on its own database
// connection, so the runner's loop keeps its heartbeat, cancels and job starts whatever it costs.
import { parentPort, workerData } from "node:worker_threads";
import { detectAutopilot } from "./autopilot.ts";
import { connectDb } from "../db/open.ts";
import { openAppKeys } from "../github/app-keys.ts";

export type WorkerTask = { id: number; task: "plan"; nowMs?: number };
export type WorkerReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

const db = await connectDb((workerData as { dbTarget: string }).dbTarget, { role: "planner" });
// The planner reads the app's slug; a thread has its own module state, so it opens its own store.
await openAppKeys(db).catch((e: Error) => console.error(`planner: GitHub App keys not read: ${e.message}`));

parentPort!.on("message", async (m: WorkerTask) => {
  try {
    const result = await detectAutopilot(db, { incremental: true, ...(m.nowMs === undefined ? {} : { nowMs: m.nowMs }) });
    parentPort!.postMessage({ id: m.id, ok: true, result } satisfies WorkerReply);
  } catch (e) {
    parentPort!.postMessage({ id: m.id, ok: false, error: (e as Error).stack ?? String(e) } satisfies WorkerReply);
  }
});
