// Full transcripts of model calls: every event the harness streamed (model text, thinking, tool calls with their
// arguments and full results), one gzip JSONL object per Task Runner attempt. Objects go to the instance's transcript
// store, an S3-compatible bucket (Cloudflare R2); the database keeps a pointer and a summary (agent_run_transcripts).
// Readers go through the server: objects are never public.
//
// Where the store is configured, first match wins:
// 1. the admin setting `transcript_store`: a bucket (kind, endpoint, bucket, prefix, access key id; the secret sealed
//    with the instance's session key), or the local directory `<data dir>/transcripts`, which only an instance with one
//    dashboard replica can use (each replica has its own data directory);
// 2. AUTOCRAFT_TRANSCRIPT_S3_ENDPOINT, _TRANSCRIPT_BUCKET, _TRANSCRIPT_ACCESS_KEY_ID, _TRANSCRIPT_SECRET_ACCESS_KEY
//    (optional _TRANSCRIPT_PREFIX).
// With neither, transcripts are off: bundles do not ask Task Runners for them and nothing is stored.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import type { Db } from "../db/index.ts";
import { dataDir } from "../db.ts";
import { envVar } from "../env.ts";
import type { TokenBox } from "../dash/server/crypto.ts";
import { addTranscriptWait, insertTranscript, loadTranscriptWait, takeTranscriptWait, type TranscriptRow, type TranscriptWait } from "../data/inference/index.ts";
import { saveSettings, setting } from "../data/control/index.ts";
import { ThreadCall } from "../thread-call.ts";
import { RAW_MAX, type PrepareInput, type Prepared } from "./prepare.ts";
import { deleteObject, getObject, putObject, StorageError, type S3Bucket } from "../storage/s3.ts";
import type { AgentRunTranscript, TranscriptEntry, TranscriptStoreStatus, TranscriptView } from "../../web/src/api/types.ts";

const gunzipAsync = promisify(gunzip);

export const SETTING_KEY = "transcript_store";
const SECRET_AAD = "settings:transcript_store";
/** Per entry and per page, what the transcript view returns; the download has everything. */
const ENTRY_TEXT_MAX = 20_000;
const ENTRIES_MAX = 4000;

type Saved = { kind: "local" } | { kind: "s3"; endpoint: string; bucket: string; prefix: string; accessKeyId: string; secret: string | null };
export type ActiveStore =
  | { kind: "local"; dir: string; source: "settings" }
  | { kind: "s3"; bucket: S3Bucket; prefix: string; source: "settings" | "environment" };

let sealer: TokenBox | null = null;
/** The box that seals the stored secret (the dashboard's, from the session key); set at start by the processes that store or read transcripts. */
export function useTranscriptSealer(box: TokenBox | null): void {
  sealer = box;
}

const httpsUrl = (u: string): boolean => { try { const x = new URL(u); return x.protocol === "https:" && !x.search && !x.hash; } catch { return false; } };
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,62}$/;
/** A key prefix: empty, or path segments of safe characters ending in `/`. */
const PREFIX = /^(?:[A-Za-z0-9._-]+\/)*$/;
const normPrefix = (p: string): string => { const t = p.trim().replace(/^\/+/, ""); return t && !t.endsWith("/") ? `${t}/` : t; };

function savedOf(raw: string | undefined): Saved | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (v.kind === "local") return { kind: "local" };
    if (v.kind === "s3" && typeof v.endpoint === "string" && typeof v.bucket === "string" && typeof v.accessKeyId === "string")
      return { kind: "s3", endpoint: v.endpoint, bucket: v.bucket, prefix: typeof v.prefix === "string" ? v.prefix : "", accessKeyId: v.accessKeyId, secret: typeof v.secret === "string" ? v.secret : null };
  } catch { /* an unreadable setting counts as none */ }
  return null;
}

function envBucket(env: NodeJS.ProcessEnv): { bucket: S3Bucket; prefix: string } | null {
  const endpoint = envVar("TRANSCRIPT_S3_ENDPOINT", env), bucket = envVar("TRANSCRIPT_BUCKET", env);
  const accessKeyId = envVar("TRANSCRIPT_ACCESS_KEY_ID", env), secretAccessKey = envVar("TRANSCRIPT_SECRET_ACCESS_KEY", env);
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey || !httpsUrl(endpoint)) return null;
  return { bucket: { endpoint: endpoint.replace(/\/+$/, ""), bucket, accessKeyId, secretAccessKey }, prefix: normPrefix(envVar("TRANSCRIPT_PREFIX", env) ?? "") };
}

export const localDir = (env: NodeJS.ProcessEnv = process.env): string => resolve(join(dataDir(env), "transcripts"));

/** The store transcripts go to now (null: transcripts are off), and why a saved setting could not be used (its secret does not open under this key). */
export async function activeStore(db: Db, env: NodeJS.ProcessEnv = process.env): Promise<{ store: ActiveStore | null; problem: string | null }> {
  const saved = savedOf(await setting(db, SETTING_KEY));
  let problem: string | null = null;
  if (saved?.kind === "local") return { store: { kind: "local", dir: localDir(env), source: "settings" }, problem };
  if (saved?.kind === "s3") {
    const secret = saved.secret && sealer ? sealer.open(saved.secret, SECRET_AAD) : null;
    if (secret) return { store: { kind: "s3", bucket: { endpoint: saved.endpoint, bucket: saved.bucket, accessKeyId: saved.accessKeyId, secretAccessKey: secret }, prefix: saved.prefix, source: "settings" }, problem };
    problem = "The saved bucket's secret could not be read with this instance's key; transcripts use the next configured store.";
  }
  const fromEnv = envBucket(env);
  if (fromEnv) return { store: { kind: "s3", ...fromEnv, source: "environment" }, problem };
  return { store: null, problem };
}

/** Whether this instance stores transcripts: only then do bundles ask Task Runners to send them. */
export const transcriptsOn = async (db: Db): Promise<boolean> => (await activeStore(db)).store !== null;

/** A local path for `key` inside `dir`; null for a key that would leave it. */
function localPath(dir: string, key: string): string | null {
  if (!/^[A-Za-z0-9._/-]+$/.test(key) || key.split("/").some((s) => s === "" || s === "." || s === "..")) return null;
  const p = resolve(dir, key);
  return p.startsWith(dir + sep) ? p : null;
}

async function put(store: ActiveStore, key: string, body: Uint8Array): Promise<void> {
  if (store.kind === "s3") return await putObject(store.bucket, key, body, "application/gzip");
  const p = localPath(store.dir, key);
  if (!p) throw new Error("bad transcript key");
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, p);
}

async function get(store: ActiveStore, key: string): Promise<Uint8Array | null> {
  if (store.kind === "s3") return await getObject(store.bucket, key);
  const p = localPath(store.dir, key);
  if (!p) return null;
  try { return readFileSync(p); } catch (e) { if ((e as { code?: string }).code === "ENOENT") return null; throw e; }
}

async function del(store: ActiveStore, key: string): Promise<void> {
  if (store.kind === "s3") return await deleteObject(store.bucket, key);
  const p = localPath(store.dir, key);
  if (p) rmSync(p, { force: true });
}

// ---- writing --------------------------------------------------------------------

export type CallTranscript = PrepareInput;

/** Transcripts prepared at once, each in its own worker thread; one submitted while all are busy is dropped. */
const STORING_MAX = 2;
const workers = Array.from({ length: STORING_MAX }, () => new ThreadCall<PrepareInput, Prepared>(new URL("./prepare-worker.ts", import.meta.url), "transcript"));
const busy = new Set<number>();
const storing = new Set<Promise<void>>();

/**
 * Stores one submitted transcript: prepares it in a worker thread (prepare.ts), writes the gzip JSONL to the active store
 * and records the pointer. Null when transcripts are off. Throws for a transcript that is not gzip JSONL or is too large.
 */
export async function saveCallTranscript(db: Db, t: CallTranscript, now: Date = new Date(), worker: ThreadCall<PrepareInput, Prepared> = workers[0]!): Promise<TranscriptRow | null> {
  const { store } = await activeStore(db);
  if (!store) return null;
  const p = await worker.call(t);
  const iso = now.toISOString();
  const key = `${store.kind === "s3" ? store.prefix : ""}calls/${iso.slice(0, 4)}/${iso.slice(5, 7)}/run-${t.runId}-call-${t.callId}-${t.attempt}-${randomBytes(6).toString("hex")}.jsonl.gz`;
  await put(store, key, p.body);
  const row = {
    runId: t.runId, callId: t.callId, attempt: t.attempt, outcome: t.outcome, store: store.kind, bucket: store.kind === "s3" ? store.bucket.bucket : null, objectKey: key,
    bytes: p.body.length, rawBytes: p.rawBytes, sha256: p.sha256, lines: p.lines, toolCount: p.toolCount, lastTool: p.lastTool, createdAt: iso,
  } as const;
  await insertTranscript(db, row);
  return { id: 0, ...row };
}

/**
 * Stores a submitted transcript in the background, after the submit has answered; at most STORING_MAX at once, and one
 * that comes while all are busy is dropped with a log line. Failures are logged, never thrown.
 */
export function storeCallTranscript(db: Db, t: CallTranscript): void {
  const slot = [...workers.keys()].find((i) => !busy.has(i));
  if (slot === undefined) { console.log(`transcript of remote call ${t.callId} not stored: ${STORING_MAX} transcripts are being stored already`); return; }
  busy.add(slot);
  const job = (async () => {
    try { await saveCallTranscript(db, t, new Date(), workers[slot]); } catch (e) { console.log(`transcript of remote call ${t.callId} not stored: ${String((e as Error).message ?? e).slice(0, 200)}`); }
  })().finally(() => { busy.delete(slot); storing.delete(job); });
  storing.add(job);
}

const secretHash = (secret: string): string => createHash("sha256").update(secret).digest("hex");

/** After an accepted submit: the attempt's transcript is taken from its lease secret until `untilMs` (ROUTES.transcript), when transcripts are on. */
export async function expectTranscript(db: Db, secret: string, w: TranscriptWait, untilMs: number, now: number): Promise<void> {
  if (await transcriptsOn(db)) await addTranscriptWait(db, secretHash(secret), w, untilMs, now);
}

/** Whether a transcript is awaited from this lease secret now. */
export const transcriptAwaited = async (db: Db, secret: string, now: number): Promise<boolean> => await loadTranscriptWait(db, secretHash(secret), now);

/** Takes the awaited transcript's attempt for this lease secret (one upload each), or null. */
export const takeTranscript = async (db: Db, secret: string): Promise<TranscriptWait | null> => await takeTranscriptWait(db, secretHash(secret));

/** Resolves once the transcripts being stored now are done (for shutdown and tests). */
export async function transcriptsStored(): Promise<void> {
  await Promise.all([...storing]);
}

// ---- reading --------------------------------------------------------------------

export const summaryOf = (r: TranscriptRow): AgentRunTranscript => ({
  id: r.id, attempt: r.attempt, outcome: r.outcome, bytes: r.bytes, rawBytes: r.rawBytes, lines: r.lines, toolCount: r.toolCount, lastTool: r.lastTool, createdAt: r.createdAt,
});

/** The stored object of a transcript, checked against its hash. Throws a plain-words error when it cannot be read. */
export async function transcriptObject(db: Db, r: TranscriptRow): Promise<Buffer> {
  const { store } = await activeStore(db);
  if (!store) throw new Error("Transcripts are off for this instance.");
  if (r.store !== store.kind || (store.kind === "s3" && r.bucket !== store.bucket.bucket)) {
    throw new Error(r.store === "s3" ? `This transcript is in bucket ${r.bucket}, which the current transcript storage does not use.` : "This transcript is in the local directory, which the current transcript storage does not use.");
  }
  let body: Uint8Array | null;
  try { body = await get(store, r.objectKey); } catch (e) { throw new Error(e instanceof StorageError ? `The transcript could not be read: ${e.message}.` : "The transcript could not be read."); }
  if (!body) throw new Error("The transcript object is missing from the store.");
  const buf = Buffer.from(body);
  if (createHash("sha256").update(buf).digest("hex") !== r.sha256) throw new Error("The stored transcript does not match its recorded hash.");
  return buf;
}

const cap = (s: string): { text: string; truncated?: number } => (s.length > ENTRY_TEXT_MAX ? { text: s.slice(0, ENTRY_TEXT_MAX), truncated: s.length - ENTRY_TEXT_MAX } : { text: s });
const asText = (c: unknown): string => {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b: any) => (b?.type === "text" && typeof b.text === "string" ? b.text : b?.type === "image" ? `[image${b.omitted ? `, ${b.omitted}` : ""}]` : JSON.stringify(b))).join("\n");
  return c === undefined || c === null ? "" : JSON.stringify(c, null, 2);
};

/** The readable entries of one stored event: Claude's stream-json events by block, Codex's completed items; anything else as JSON. */
export function entriesOf(at: string | null, ev: any): TranscriptEntry[] {
  const sub = typeof ev?.parent_tool_use_id === "string" ? { sub: true } : {};
  const e = (kind: TranscriptEntry["kind"], text: string, more: Partial<TranscriptEntry> = {}): TranscriptEntry => ({ at, kind, ...cap(text), ...sub, ...more });
  switch (ev?.type) {
    case "system":
      return ev.subtype === "init" ? [e("system", `Session started: ${String(ev.model ?? "model unknown")}, ${Array.isArray(ev.tools) ? ev.tools.length : 0} tools`)] : [];
    case "assistant":
    case "user": {
      const content = ev.message?.content;
      if (typeof content === "string") return [e(ev.type === "user" ? "user" : "text", content)];
      if (!Array.isArray(content)) return [];
      return content.flatMap((b: any): TranscriptEntry[] => {
        if (b?.type === "text") return [e(ev.type === "user" ? "user" : "text", String(b.text ?? ""))];
        if (b?.type === "thinking") return [e("thinking", String(b.thinking ?? ""))];
        if (b?.type === "tool_use") return [e("tool", JSON.stringify(b.input ?? null, null, 2), { name: String(b.name ?? "tool") })];
        if (b?.type === "tool_result") return [e("result", asText(b.content), { ...(b.is_error === true && { isError: true }) })];
        return [];
      });
    }
    case "result":
      return [e("final", [`${String(ev.subtype ?? "result")}${typeof ev.num_turns === "number" ? `, ${ev.num_turns} turns` : ""}`, typeof ev.result === "string" ? ev.result : ""].filter(Boolean).join("\n\n"), { ...(ev.is_error === true && { isError: true }) })];
    case "item.completed": {
      const it = ev.item ?? {};
      if (it.type === "agent_message") return [e("text", String(it.text ?? ""))];
      if (it.type === "reasoning") return [e("thinking", String(it.text ?? ""))];
      if (it.type === "mcp_tool_call") {
        return [e("tool", JSON.stringify(it.arguments ?? null, null, 2), { name: `mcp__${String(it.server ?? "")}__${String(it.tool ?? "")}` }),
          e("result", asText(it.result?.content ?? it.error ?? ""), { ...(it.status === "failed" && { isError: true }) })];
      }
      return [e("event", JSON.stringify(it, null, 2))];
    }
    case "stream_event":
    case "rate_limit_event":
      return [];
    default:
      return ev === undefined ? [] : [e("event", JSON.stringify(ev, null, 2))];
  }
}

/** A transcript as the dashboard shows it: entries in order, each text capped, at most ENTRIES_MAX (`omitted` counts the rest). */
export async function transcriptView(db: Db, r: TranscriptRow): Promise<TranscriptView> {
  const jsonl = (await gunzipAsync(await transcriptObject(db, r), { maxOutputLength: RAW_MAX * 2 })).toString("utf8");
  const entries: TranscriptEntry[] = [];
  let omitted = 0;
  for (const line of jsonl.split("\n").slice(1)) {
    if (!line) continue;
    let v: { at?: string | null; event?: unknown; omitted?: number };
    try { v = JSON.parse(line) as typeof v; } catch { continue; }
    const more = typeof v.omitted === "number" ? [{ at: v.at ?? null, kind: "event" as const, text: `${v.omitted} events left out by the Task Runner (the transcript was too large)` }] : entriesOf(v.at ?? null, v.event);
    for (const x of more) if (entries.length < ENTRIES_MAX) entries.push(x); else omitted++;
  }
  return { runId: r.runId, transcript: summaryOf(r), entries, omitted };
}

// ---- admin ----------------------------------------------------------------------

export async function storeStatus(db: Db, env: NodeJS.ProcessEnv = process.env): Promise<TranscriptStoreStatus> {
  const saved = savedOf(await setting(db, SETTING_KEY));
  const { store, problem } = await activeStore(db, env);
  return {
    active: store === null ? null : store.kind === "s3"
      ? { kind: "s3", source: store.source, dir: null, endpoint: store.bucket.endpoint, bucket: store.bucket.bucket, prefix: store.prefix, accessKeyId: store.bucket.accessKeyId }
      : { kind: "local", source: store.source, dir: store.dir, endpoint: null, bucket: null, prefix: "", accessKeyId: null },
    saved: saved === null ? null : saved.kind === "local" ? { kind: "local", endpoint: "", bucket: "", prefix: "", accessKeyId: "", secretSet: false }
      : { kind: "s3", endpoint: saved.endpoint, bucket: saved.bucket, prefix: saved.prefix, accessKeyId: saved.accessKeyId, secretSet: saved.secret !== null },
    environment: envBucket(env) !== null,
    problem,
  };
}

/** The checked form of an admin input; `secret` null keeps the saved secret. Throws a plain-words error. */
function checkInput(raw: unknown): { kind: "local" } | { kind: "s3"; endpoint: string; bucket: string; prefix: string; accessKeyId: string; secret: string | null } {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (v.kind === "local") return { kind: "local" };
  if (v.kind !== "s3") throw new Error("kind must be local or s3");
  const str = (k: string, max: number): string => { const x = v[k]; if (x !== undefined && typeof x !== "string") throw new Error(`${k} must be text`); const s = (x ?? "").trim(); if (s.length > max) throw new Error(`${k} is too long`); return s; };
  const endpoint = str("endpoint", 300).replace(/\/+$/, ""), bucket = str("bucket", 63), prefix = normPrefix(str("prefix", 200)), accessKeyId = str("accessKeyId", 200), secret = str("secretAccessKey", 500);
  if (!httpsUrl(endpoint)) throw new Error("The endpoint must be an https URL without a query.");
  if (!BUCKET.test(bucket)) throw new Error("The bucket name must be 3 to 63 lowercase letters, digits, dots or hyphens.");
  if (!PREFIX.test(prefix)) throw new Error("The prefix may hold letters, digits, dots, hyphens, underscores and slashes.");
  if (!accessKeyId) throw new Error("The access key id is required.");
  return { kind: "s3", endpoint, bucket, prefix, accessKeyId, secret: secret || null };
}

/** Saves the operator's choice (null removes it: the environment's bucket applies, or transcripts are off). A bucket without a new secret keeps the saved one. */
export async function saveStore(db: Db, raw: unknown | null, by: string): Promise<void> {
  if (raw === null) { await saveSettings(db, [{ key: SETTING_KEY, value: null }], by, { action: "transcript-store", details: { cleared: true } }); return; }
  const c = checkInput(raw);
  let value: string;
  if (c.kind === "local") value = JSON.stringify({ kind: "local" });
  else {
    if (!sealer) throw new Error("This process cannot seal secrets (no session key).");
    const old = savedOf(await setting(db, SETTING_KEY));
    const secret = c.secret ? sealer.seal(c.secret, SECRET_AAD) : old?.kind === "s3" && old.accessKeyId === c.accessKeyId ? old.secret : null;
    if (!secret) throw new Error("Enter the secret access key.");
    value = JSON.stringify({ kind: "s3", endpoint: c.endpoint, bucket: c.bucket, prefix: c.prefix, accessKeyId: c.accessKeyId, secret });
  }
  await saveSettings(db, [{ key: SETTING_KEY, value }], by, { action: "transcript-store", details: c.kind === "local" ? { kind: "local" } : { kind: "s3", endpoint: c.endpoint, bucket: c.bucket, prefix: c.prefix } });
}

/**
 * Writes, reads back and deletes a probe object in the given store settings (the saved secret fills a missing one), or
 * in the active store when `raw` is null.
 */
export async function testStore(db: Db, raw: unknown | null): Promise<{ ok: boolean; detail: string }> {
  let store: ActiveStore;
  try {
    if (raw === null) {
      const active = (await activeStore(db)).store;
      if (!active) return { ok: false, detail: "Transcripts are off: no store is configured." };
      store = active;
    } else {
      const c = checkInput(raw);
      if (c.kind === "local") store = { kind: "local", dir: localDir(), source: "settings" };
      else {
        const old = savedOf(await setting(db, SETTING_KEY));
        const secret = c.secret ?? (old?.kind === "s3" && old.accessKeyId === c.accessKeyId && old.secret && sealer ? sealer.open(old.secret, SECRET_AAD) : null);
        if (!secret) return { ok: false, detail: "Enter the secret access key." };
        store = { kind: "s3", bucket: { endpoint: c.endpoint, bucket: c.bucket, accessKeyId: c.accessKeyId, secretAccessKey: secret }, prefix: c.prefix, source: "settings" };
      }
    }
  } catch (e) { return { ok: false, detail: (e as Error).message }; }
  const key = `${store.kind === "s3" ? store.prefix : ""}probe/${randomBytes(8).toString("hex")}`;
  const probe = randomBytes(32);
  try {
    await put(store, key, probe);
    const back = await get(store, key);
    await del(store, key);
    if (!back || !Buffer.from(back).equals(probe)) return { ok: false, detail: "The probe object was written but did not read back the same." };
    return { ok: true, detail: store.kind === "s3" ? `Wrote, read and deleted a probe object in ${store.bucket.bucket}.` : `Wrote, read and deleted a probe file in ${store.dir}.` };
  } catch (e) {
    return { ok: false, detail: e instanceof StorageError ? `${e.message[0]!.toUpperCase()}${e.message.slice(1)}.` : `The store failed: ${String((e as Error).message ?? e).slice(0, 200)}` };
  }
}
