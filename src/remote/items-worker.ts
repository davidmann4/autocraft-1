// Worker thread of the item tools a task's model calls through the runner or the dashboard (src/remote/tools.ts). The
// tools are synchronous node:sqlite queries over the item snapshot, a file of over a gigabyte that a refresh locks for
// writing, during which a read waits in SQLite's busy handler: run here, neither the queries nor that wait hold the
// caller's event loop (on the runner, its lease renewals).
import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { callTool, openDb, type ToolResult } from "../itemtools/server/tools.ts";
import { serveCalls } from "../thread-call.ts";

export type ItemsCall = { file: string; diffs: string; name: string; raw: unknown };

const IDLE_MS = 60_000;
let handle: { file: string; stamp: string; db: DatabaseSync; timer: NodeJS.Timeout } | undefined;

function close(): void {
  if (!handle) return;
  clearTimeout(handle.timer);
  try { handle.db.close(); } catch { /* already closed */ }
  handle = undefined;
}

/** The read-only handle of the snapshot database, kept open between tool calls; reopened when the file is replaced, closed after an idle minute. */
function snapshotDb(file: string): DatabaseSync {
  const st = statSync(file), stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
  if (handle && (handle.file !== file || handle.stamp !== stamp)) close();
  if (!handle) handle = { file, stamp, db: openDb(file), timer: setTimeout(close, IDLE_MS).unref() };
  else handle.timer.refresh();
  return handle.db;
}

serveCalls<ItemsCall, ToolResult>(({ file, diffs, name, raw }) => {
  let db: DatabaseSync;
  try {
    db = snapshotDb(file);
  } catch {
    close();
    return { text: "the item tools are not available right now", isError: true };
  }
  return callTool(db, { db: file, diffs }, name, raw);
});
