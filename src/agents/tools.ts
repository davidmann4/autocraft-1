// Tool uses of a model call, read from the `claude -p` event stream (or reported by a remote call's helper) and stored per agent run (agent_run_tools).
// Arguments are scrubbed and capped; results are never stored, only their size.
import { scrub } from "../runner/scrub.ts";
import type { Db } from "../db/index.ts";
import { loadModelChecksOfRun } from "../data/changes/index.ts";
import { saveTools as saveToolRows, type ToolRow } from "../data/inference/index.ts";
import { loadRelayedCheckTexts } from "../data/runners/index.ts";

export const TOOL_ARGS_MAX = 4000;
/** The check tool's name as the model sees it (MCP server `build`, tool `check`). */
export const CHECK_TOOL_NAME = "mcp__build__check";

type Block = { type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
type Event = { type?: string; message?: { content?: unknown } };
export type ToolUse = { id: string; name: string; args: string; resultBytes: number | null; isError: boolean; command: string | null; noRow: boolean };
/** Arrival time of a stream line, by tool_use id, for streamed output. */
export type ToolClock = { start: Map<string, string>; end: Map<string, string> };

const sizeOf = (c: unknown): number => {
  if (typeof c === "string") return Buffer.byteLength(c);
  if (Array.isArray(c)) return c.reduce((n: number, b: { text?: unknown }) => n + (typeof b?.text === "string" ? Buffer.byteLength(b.text) : Buffer.byteLength(JSON.stringify(b ?? null))), 0);
  return c === undefined || c === null ? 0 : Buffer.byteLength(JSON.stringify(c));
};

const textOf = (c: unknown): string => (typeof c === "string" ? c : Array.isArray(c) ? c.map((b: { text?: unknown }) => (typeof b?.text === "string" ? b.text : "")).join("") : "");
/** Replies of the check tool that come back before it writes its model_checks row (src/checktool/index.ts). */
const NO_ROW = /^(?:refused: |the model call is over|the patch does not apply|(?:rustfmt|clippy): the patch changes no \.rs file)/;

/** Tool uses in order, paired with their results by id. Accepts the event list of `--output-format json` or the lines of stream-json. */
export function toolUses(events: unknown): ToolUse[] {
  const list = Array.isArray(events) ? events as Event[] : [];
  const byId = new Map<string, ToolUse>();
  for (const e of list) {
    if (!Array.isArray(e?.message?.content)) continue;
    for (const b of e.message!.content as Block[]) {
      if (e.type === "assistant" && b?.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
        const command = b.name === CHECK_TOOL_NAME && typeof (b.input as { command?: unknown } | null)?.command === "string" ? (b.input as { command: string }).command : null;
        byId.set(b.id, { id: b.id, name: b.name, args: scrub(JSON.stringify(b.input ?? null)).slice(0, TOOL_ARGS_MAX), resultBytes: null, isError: false, command, noRow: false });
      } else if (e.type === "user" && b?.type === "tool_result" && typeof b.tool_use_id === "string") {
        const u = byId.get(b.tool_use_id);
        if (u) { u.resultBytes = sizeOf(b.content); u.isError = b.is_error === true; u.noRow = u.command !== null && NO_ROW.test(textOf(b.content)); }
      }
    }
  }
  return [...byId.values()];
}

/** Records the arrival time of tool_use and tool_result blocks in one raw stream-json line. */
export function clockLine(clock: ToolClock, raw: string, at: string = new Date().toISOString()): void {
  if (!raw.startsWith("{") || !raw.includes("tool_")) return;
  try {
    const e = JSON.parse(raw) as Event;
    if (!Array.isArray(e.message?.content)) return;
    for (const b of e.message!.content as Block[]) {
      if (b?.type === "tool_use" && typeof b.id === "string") clock.start.set(b.id, at);
      else if (b?.type === "tool_result" && typeof b.tool_use_id === "string") clock.end.set(b.tool_use_id, at);
    }
  } catch { /* a partial or foreign line */ }
}

/**
 * Stores the tool uses of a finished call. A check-tool use is linked to the next unlinked model_checks row of the
 * run with the same command, skipping uses whose reply shows the tool wrote no row (refusals, nothing to check).
 */
export async function saveTools(db: Db, runId: number, events: unknown, clock?: ToolClock): Promise<void> {
  await saveUses(db, runId, toolUses(events), clock);
}

const MAX_REMOTE_TOOLS = 1000;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const time = (v: unknown): string | null => (typeof v === "string" && ISO.test(v) ? v : null);

/**
 * The rows of the tool uses a remote call's helper reported (src/remote/protocol.ts SubmitTool), ready to store with the reply.
 * The helper's list is the one source: the lease's own tools (items, reference, check) appear in it as MCP tool uses. Whether a
 * check use wrote a model_checks row comes from the relay's reply to it (remote_checks), in request order, not from the helper.
 */
export async function remoteToolRows(db: Db, runId: number, callId: number, raw: unknown): Promise<Omit<ToolRow, "runId">[]> {
  if (!Array.isArray(raw)) return [];
  const [relayed, checks] = await db.together(() => Promise.all([loadRelayedCheckTexts(db, callId, runId), loadModelChecksOfRun(db, runId)]));
  const clock: ToolClock = { start: new Map(), end: new Map() };
  const uses: ToolUse[] = [];
  for (const t of raw.slice(0, MAX_REMOTE_TOOLS) as Record<string, unknown>[]) {
    if (!t || typeof t !== "object" || typeof t.name !== "string" || !t.name || typeof t.args !== "string") continue;
    const id = `#${uses.length}`;
    const args = scrub(t.args).slice(0, TOOL_ARGS_MAX);
    let command: string | null = null;
    if (t.name === CHECK_TOOL_NAME) { try { const c = (JSON.parse(t.args) as { command?: unknown } | null)?.command; command = typeof c === "string" ? c : null; } catch { /* capped or not JSON */ } }
    const noRow = command !== null && NO_ROW.test(relayed.shift() ?? "");
    const bytes = typeof t.resultBytes === "number" && Number.isInteger(t.resultBytes) && t.resultBytes >= 0 ? t.resultBytes : null;
    uses.push({ id, name: t.name.slice(0, 100), args, resultBytes: bytes, isError: t.isError === true, command, noRow });
    const s = time(t.startedAt), e = time(t.endedAt);
    if (s) clock.start.set(id, s);
    if (e) clock.end.set(id, e);
  }
  return rowsOf(uses, checks, clock);
}

/** Tool rows in order; a check-tool use is linked to the next unlinked check row of the run with the same command. Pure. */
function rowsOf(uses: ToolUse[], checks: readonly { id: number; command: string }[], clock?: ToolClock): Omit<ToolRow, "runId">[] {
  const left = [...checks];
  return uses.map((u, i) => {
    const k = u.command === null || u.noRow ? -1 : left.findIndex((c) => c.command === u.command);
    const link = k >= 0 ? left.splice(k, 1)[0]!.id : null;
    return { seq: i + 1, tool: u.name, args: u.args, resultBytes: u.resultBytes, isError: u.isError, startedAt: clock?.start.get(u.id) ?? null, endedAt: clock?.end.get(u.id) ?? null, checkId: link };
  });
}

async function saveUses(db: Db, runId: number, uses: ToolUse[], clock?: ToolClock): Promise<void> {
  if (!uses.length) return;
  const checks = await loadModelChecksOfRun(db, runId);
  await saveToolRows(db, rowsOf(uses, checks, clock).map((r) => ({ ...r, runId })));
}
