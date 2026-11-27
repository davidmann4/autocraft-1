// Bundles ask a Task Runner for its full session only once a transcript store is configured. The helper sends it once,
// after its submit was accepted; it is stored as gzip JSONL in the store (here the local directory an operator picked)
// and read back through the server by maintainers; viewers get neither the list nor the transcript.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { after, before, test } from "node:test";
import { addLogin } from "../src/access.ts";
import { apiRoutes } from "../src/dash/api/index.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { loadConfig } from "../src/dash/server/config.ts";
import { startServer } from "../src/dash/server/index.ts";
import { FakeProvider } from "../src/dash/server/provider.ts";
import { bundleOf, claimCall, enqueueCall, submitCall, type Caller } from "../src/remote/calls.ts";
import { saveStore, transcriptsStored } from "../src/transcripts/index.ts";
import { prepareTranscript } from "../src/transcripts/prepare.ts";
import { PROTOCOL_VERSION, ROUTES, type TaskBundle } from "../src/remote/protocol.ts";
import type { AgentRunDetail, TranscriptView } from "../web/src/api/types.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "transcripts-"));
const dbFile = join(dir, "t.db");
const permsFile = join(dir, "perms.json");
const store = join(dir, "transcripts");
process.env.AUTOCRAFT_DB = dbFile;
writeFileSync(permsFile, JSON.stringify({ bob: { photocraft: "write" }, carol: { photocraft: "read" } }));

const db = await connectDb(dbFile);
let base = "", close: () => Promise<void> = async () => {};

async function signIn(login: string) {
  const jar = new Map<string, string>();
  const send = async (path: string) => {
    const r = await fetch(new URL(path, base), { headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), accept: "application/json" }, redirect: "manual" });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(";"); jar.set(kv!.slice(0, kv!.indexOf("=")), kv!.slice(kv!.indexOf("=") + 1)); }
    return r;
  };
  const start = await send("/auth/signin?return_to=/");
  const auth = await send(`${start.headers.get("location")}&login=${login}`);
  await send(auth.headers.get("location")!);
  return send;
}

let runId = 0;
before(async () => {
  const now = new Date().toISOString();
  await db.run(db.k.insertInto("repos").values({ name: "photocraft", owner: "storytold", visibility: "public" }));
  await db.run(db.k.insertInto("items").values({ repo: "photocraft", number: 7, kind: "issue", state: "OPEN", title: "Export loses quality", body: "b", author: "alice", created_at: now, updated_at: now }));
  await addLogin(db, "cli", "bob", "maintainer", null);
  await addLogin(db, "cli", "carol", "viewer", null);
  const caller: Caller = { tokenId: (await createToken(db, "bob", "helper", { kind: "runner" })).row.id, login: "bob", role: "maintainer" };
  const bundle: Omit<TaskBundle, "callId"> = { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", timeoutSeconds: 600, maxTurns: 10, stdin: "x", system: null, mounts: [], mcpServers: [], keepSession: false, hints: {} };
  await enqueueCall(db, { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", askedModel: "opus", items: [{ repo: "photocraft", number: 7 }], level: 2, maxAttempts: 1, bundle });
  const { lease } = await claimCall(db, caller, { requestId: "transcript-claim-1", protocol: PROTOCOL_VERSION, helperVersion: "1.5.0", harness: "claude", harnessVersion: "2", tiers: { top: "opus" } }, async () => true);
  assert.equal((await bundleOf(db, lease!.secret))?.transcriptAfter, undefined);
  await saveStore(db, { kind: "local" }, "operator");
  assert.equal((await bundleOf(db, lease!.secret))?.transcriptAfter, true);
  const at = new Date().toISOString();
  const events = [
    { type: "assistant", message: { content: [{ type: "text", text: "Reading the encoder." }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "crates/export/src/webp.rs" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "pub fn encode() { /* the whole file, not just its size */ }" }] } },
    { type: "result", subtype: "success", num_turns: 2, result: "{\"verdict\": \"ok\"}" },
  ];
  const transcript = gzipSync(events.map((event) => JSON.stringify({ at, event })).join("\n")).toString("base64");
  const config = loadConfig({ AUTOCRAFT_DEV_AUTH: "1", AUTOCRAFT_LISTEN: "127.0.0.1:0", AUTOCRAFT_DB: dbFile, AUTOCRAFT_DEV_PERMS: permsFile });
  const s = await startServer({ config, db, provider: new FakeProvider(permsFile), routes: apiRoutes() });
  base = s.url;
  close = s.close;
  const upload = async () => (await fetch(new URL(ROUTES.transcript, base), { method: "POST", headers: { authorization: `Bearer ${lease!.secret}`, "content-type": "application/json" }, body: JSON.stringify({ transcript }) })).status;
  assert.equal(await upload(), 410, "nothing is awaited before the submit");
  assert.deepEqual(await submitCall(db, lease!.secret, { ok: true, text: "{\"verdict\": \"ok\"}", model: "claude-opus-4", usage: { inputTokens: 10, outputTokens: 5 }, durationMs: 1000 }), { accepted: true });
  assert.equal(await upload(), 200);
  assert.equal(await upload(), 410, "one transcript per attempt");
  await transcriptsStored();
  runId = Number((await db.get(db.k.selectFrom("remote_calls").select("run_id").where("id", "=", lease!.id)))!.run_id);
});
after(async () => {
  await close();
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a submitted transcript is stored and read back whole by maintainers, never by viewers", async () => {
  assert.equal(readdirSync(store, { recursive: true }).some((f) => String(f).endsWith(".jsonl.gz")), true);
  const bob = await signIn("bob");
  const run = (await (await bob(`/api/agents/${runId}`)).json()) as AgentRunDetail;
  assert.equal(run.transcripts?.length, 1);
  assert.equal(run.transcripts![0]!.toolCount, 1);
  const view = (await (await bob(`/api/agents/${runId}/transcripts/${run.transcripts![0]!.id}`)).json()) as TranscriptView;
  assert.ok(view.entries.some((e) => e.kind === "result" && e.text.includes("the whole file, not just its size")));
  assert.ok(view.entries.some((e) => e.kind === "tool" && e.name === "Read"));

  const carol = await signIn("carol");
  assert.equal(((await (await carol(`/api/agents/${runId}`)).json()) as AgentRunDetail).transcripts, undefined);
  assert.equal((await carol(`/api/agents/${runId}/transcripts/${run.transcripts![0]!.id}`)).status, 403);
  assert.equal((await carol(`/api/agents/${runId}/transcripts/${run.transcripts![0]!.id}/download`)).status, 403);
});

test("the claim root goes from string values also where the JSON text escapes it", () => {
  const root = "C:\\Users\\bob\\slot-1";
  const event = { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: `${root}\\repo\\src\\lib.rs` } }] } };
  const gzipBase64 = gzipSync(JSON.stringify({ at: "2026-11-26T00:00:00Z", event })).toString("base64");
  const stored = gunzipSync(prepareTranscript({ runId: 1, callId: 1, attempt: 0, outcome: "done", root, gzipBase64 }).body).toString("utf8");
  assert.ok(stored.includes("repo\\\\src"), "the path below the root is kept");
  assert.ok(!stored.includes("Users"), "the root is gone");
});
