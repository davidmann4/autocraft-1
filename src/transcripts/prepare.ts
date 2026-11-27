// The CPU part of storing a submitted transcript, run in a worker thread (prepare-worker.ts): inflate, check and clean
// each line, then gzip again. Imports nothing that opens the database.
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { scrub } from "../runner/scrub.ts";

/** The largest JSONL a submitted transcript may inflate to. */
export const RAW_MAX = 64 * 1024 * 1024;

export type PrepareInput = { runId: number; callId: number; attempt: number; outcome: "done" | "failed" | "refused"; root: string | null; gzipBase64: string };
export type Prepared = { body: Uint8Array; rawBytes: number; sha256: string; lines: number; toolCount: number; lastTool: string | null };

/** Tool names of one harness event: Claude's assistant tool_use blocks, Codex's completed MCP tool calls. */
function toolNames(ev: any): string[] {
  if (ev?.type === "assistant" && Array.isArray(ev.message?.content)) return ev.message.content.filter((b: any) => b?.type === "tool_use" && typeof b.name === "string").map((b: any) => b.name as string);
  if (ev?.type === "item.completed" && ev.item?.type === "mcp_tool_call") return [`mcp__${String(ev.item.server ?? "")}__${String(ev.item.tool ?? "")}`];
  return [];
}

/** Image data in tool results is replaced by its size: screenshots are kept with the workspace, not in transcripts. */
function dropImages(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dropImages);
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (o.type === "image") {
    const src = o.source as Record<string, unknown> | undefined;
    const data = typeof src?.data === "string" ? src.data : typeof o.data === "string" ? o.data : null;
    if (data !== null) return { type: "image", omitted: `${Math.round(data.length * 0.75)} bytes` };
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) out[k] = dropImages(x);
  return out;
}

/** `v` with `root` taken out of every string in it: parsed values, so escaped forms in the JSON text (a Windows path's doubled backslashes) are covered. */
function unrooted(v: unknown, root: string): unknown {
  if (typeof v === "string") return v.includes(root) ? v.split(root).join("") : v;
  if (Array.isArray(v)) return v.map((x) => unrooted(x, root));
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = unrooted(x, root);
  return out;
}

/**
 * The stored form of a submitted transcript: a header line, then one `{at, event}` or `{at, omitted}` line per event,
 * with the claim's path root taken off, image data dropped and credentials hidden, as gzip JSONL. Throws for a transcript
 * that is not gzip, inflates past RAW_MAX or has no events.
 */
export function prepareTranscript(t: PrepareInput): Prepared {
  let raw: Buffer;
  try { raw = gunzipSync(Buffer.from(t.gzipBase64, "base64"), { maxOutputLength: RAW_MAX }); } catch (e) {
    throw new Error((e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" ? `the transcript inflates past ${RAW_MAX / 1024 / 1024} MiB` : "the transcript is not gzip");
  }
  const lines: string[] = [JSON.stringify({ transcript: 1, runId: t.runId, callId: t.callId, attempt: t.attempt, outcome: t.outcome })];
  let tools = 0, lastTool: string | null = null, events = 0;
  for (const line of raw.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let v: { at?: unknown; event?: unknown; omitted?: unknown };
    try { v = JSON.parse(line) as typeof v; } catch { continue; }
    if (!v || typeof v !== "object") continue;
    const at = typeof v.at === "string" ? v.at.slice(0, 40) : null;
    const entry = typeof v.omitted === "number" ? { at, omitted: v.omitted } : { at, event: dropImages(t.root ? unrooted(v.event, t.root) : v.event) };
    const names = toolNames((entry as { event?: unknown }).event);
    if (names.length) { tools += names.length; lastTool = names.at(-1)!.slice(0, 200); }
    lines.push(scrub(JSON.stringify(entry)));
    events++;
  }
  if (events === 0) throw new Error("the transcript has no events");
  const jsonl = Buffer.from(`${lines.join("\n")}\n`, "utf8");
  const body = gzipSync(jsonl);
  return { body, rawBytes: jsonl.length, sha256: createHash("sha256").update(body).digest("hex"), lines: events, toolCount: tools, lastTool };
}
