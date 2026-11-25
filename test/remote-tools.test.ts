// The per-lease tools of the user-local mode through the dashboard: a tool call over the plain HTTP route and over the
// task MCP server (through the helper's stdio proxy), served only to the call whose bundle lists the server; the
// reference passage cap per lease; and a `check` call relayed to the CheckTool of the process waiting for the call.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, before, describe, test } from "node:test";
import { allocation } from "../src/agents/call.ts";
import { addLogin } from "../src/access.ts";
import { apiRoutes } from "../src/dash/api/index.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { loadConfig } from "../src/dash/server/config.ts";
import { startServer } from "../src/dash/server/index.ts";
import { FakeProvider } from "../src/dash/server/provider.ts";
import { RateLimiter } from "../src/dash/server/util.ts";
import type { Embedder } from "../src/embed/model.ts";
import { awaitCall, claimCall, enqueueCall, submitCall, type Caller } from "../src/remote/calls.ts";
import { setInferenceMode } from "../src/remote/mode.ts";
import { PROTOCOL_VERSION, ROUTES, type TaskBundle } from "../src/remote/protocol.ts";
import { buildReferenceIndex } from "../src/reference-search.ts";
import { PASSAGES_PER_LEASE, referenceOptions } from "../src/remote/tools.ts";
import { SCRATCH } from "./scratch.ts";
import { writeTestSnapshot } from "./test-db.ts";
import { connectDb } from "../src/db/open.ts";
import { startWorkerServer } from "../src/build/worker-api.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "remote-tools-"));
const dbFile = join(dir, "t.db");
const permsFile = join(dir, "perms.json");
// The snapshot and the reference folder and index live next to the database.
process.env.AUTOCRAFT_DB = dbFile;
writeFileSync(permsFile, JSON.stringify({ bob: { photocraft: "write" } }));

const fake: Embedder = {
  id: "fake:1", dim: 2,
  async embed(texts) { return texts.map((t) => (t.toLowerCase().includes("layer") ? new Float32Array([1, 0]) : new Float32Array([0, 1]))); },
};

describe("per-lease tools of remote calls", async () => {
  const db = await connectDb(dbFile);
  let base = "", close: () => Promise<void> = async () => {};
  const leases = new Map<string, { id: number; secret: string }>();
  const bundle = (servers: string[]): Omit<TaskBundle, "callId"> => ({ promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", timeoutSeconds: 600, maxTurns: 10, stdin: "x", system: null, mounts: [], mcpServers: servers, keepSession: false, hints: {} });

  before(async () => {
    allocation.pollMs = 10;
    referenceOptions.embedder = fake;
    await setInferenceMode(db, "user-local", "test");
    const now = new Date().toISOString();
    await db.run(db.k.insertInto("repos").values({ name: "photocraft", owner: "storytold", visibility: "public" }));
    await db.run(db.k.insertInto("items").values({ repo: "photocraft", number: 7, kind: "issue", state: "OPEN", title: "Wave filter crashes", body: "b", author: "alice", created_at: now, updated_at: now }));
    await writeTestSnapshot(dbFile);
    const ref = join(dir, "reference", "photocraft");
    mkdirSync(ref, { recursive: true });
    writeFileSync(join(ref, "layers.md"), `# Layers\n\n${Array.from({ length: 10 }, (_, i) => `Layer note ${i}. ${"filler ".repeat(100)}`).join("\n\n")}`);
    await buildReferenceIndex("photocraft", { embedder: fake });
    await addLogin(db, "cli", "bob", "maintainer", null);
    const caller: Caller = { tokenId: (await createToken(db, "bob", "helper", { kind: "runner" })).row.id, login: "bob", role: "maintainer" };
    const items = [{ repo: "photocraft", number: 7 }];
    const common = { promptId: "review.opus", promptVersion: "1", tier: "top" as const, effort: "medium", askedModel: "opus", items, level: 2, maxAttempts: 1 };
    const ids = {
      tools: await enqueueCall(db, { ...common, bundle: bundle(["items", "reference"]), referenceRepo: "photocraft" }),
      race: await enqueueCall(db, { ...common, bundle: bundle(["reference"]), referenceRepo: "photocraft" }),
      build: await enqueueCall(db, { ...common, bundle: bundle(["build"]) }),
      ended: await enqueueCall(db, { ...common, bundle: bundle(["items"]) }),
    };
    for (let i = 0; i < 4; i++) {
      const r = await claimCall(db, caller, { requestId: `test-claim-000${i}`, protocol: PROTOCOL_VERSION, helperVersion: "1.2.0", harness: "claude", harnessVersion: "2", tiers: { top: "opus" } }, async () => true);
      const name = Object.entries(ids).find(([, id]) => id === r.lease?.id)![0];
      leases.set(name, r.lease!);
    }
    await submitCall(db, leases.get("ended")!.secret, { ok: false, error: "x", durationMs: 1 });
    const config = loadConfig({ AUTOCRAFT_DEV_AUTH: "1", AUTOCRAFT_LISTEN: "127.0.0.1:0", AUTOCRAFT_DB: dbFile, AUTOCRAFT_DEV_PERMS: permsFile });
    const limiter = new RateLimiter(60, 3600_000);
    const s = await startServer({ config, db, provider: new FakeProvider(permsFile), feedbackLimiter: limiter, routes: apiRoutes({ limiter }) });
    base = s.url;
    close = s.close;
  });
  after(async () => {
    await close();
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const tool = async (lease: string, server: string, name: string, args: unknown): Promise<{ status: number; body: { content: { type: string; text: string }[]; isError?: boolean; error?: string } }> => {
    const r = await fetch(`${base}${ROUTES.tool}/${server}/${name}`, { method: "POST", headers: { authorization: `Bearer ${leases.get(lease)!.secret}`, "content-type": "application/json" }, body: JSON.stringify(args) });
    return { status: r.status, body: JSON.parse(await r.text()) };
  };

  test("a tool runs over HTTP and through the MCP proxy for its call only", async () => {
    const r = await tool("tools", "items", "search_items", { query: "wave filter" });
    assert.equal(r.status, 200);
    assert.match(r.body.content[0]!.text, /photocraft#7 issue open/);
    assert.equal((await tool("build", "items", "search_items", { query: "wave" })).status, 403, "another call's secret");
    assert.equal((await tool("tools", "build", "check", { patch: "", command: "fmt" })).status, 403, "a server the bundle does not list");
    assert.equal((await tool("ended", "items", "search_items", { query: "wave" })).status, 410, "an ended lease");

    // The helper's stdio proxy against the task MCP server, as a harness that only speaks stdio MCP uses it.
    const proxy = spawn(process.execPath, ["worker/autocraft.mjs", "mcp", "items", "0"], {
      env: { ...process.env, XDG_CONFIG_HOME: join(dir, "cfg"), AUTOCRAFT_RUNNER_LEASE_SECRET: leases.get("tools")!.secret, AUTOCRAFT_RUNNER_SERVER: base },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const lines = createInterface({ input: proxy.stdout })[Symbol.asyncIterator]();
    const rpc = async (id: number, method: string, params: unknown) => {
      proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return JSON.parse((await lines.next()).value as string) as { id: number; result: Record<string, unknown> };
    };
    const init = await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const list = await rpc(2, "tools/list", {});
    assert.deepEqual((list.result.tools as { name: string }[]).map((t) => t.name), ["search_items", "item", "similar_items", "pr_diff"]);
    const got = await rpc(3, "tools/call", { name: "item", arguments: { repo: "photocraft", number: 7 } });
    assert.match((got.result.content as { text: string }[])[0]!.text, /Wave filter crashes/);
    proxy.stdin.end();
    await new Promise((r) => proxy.on("close", r));

    const refused = await fetch(`${base}${ROUTES.mcp}/build`, { method: "POST", headers: { authorization: `Bearer ${leases.get("tools")!.secret}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(refused.status, 403);
  });

  test("a lease reads at most its passage allowance, and every passage is recorded", async () => {
    let served = 0;
    for (;;) {
      const r = await tool("tools", "reference", "reference_search", { query: "layer", limit: 8 });
      assert.equal(r.status, 200);
      if (r.body.isError) {
        assert.match(r.body.content[0]!.text, /used up/);
        break;
      }
      served += r.body.content[0]!.text.match(/^passage \d+:/gm)!.length;
      assert.ok(served <= PASSAGES_PER_LEASE);
    }
    assert.equal(served, PASSAGES_PER_LEASE);
    const rows = (await db.get(db.k.selectFrom("remote_passages").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.min<string | null>("user_login").as("login"), eb.fn.min<string | null>("repo").as("repo")])
      .where("call_id", "=", leases.get("tools")!.id)))!;
    assert.deepEqual({ ...rows }, { n: PASSAGES_PER_LEASE, login: "bob", repo: "photocraft" });
  });

  test("parallel reference searches together stay within the passage allowance", async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, () => tool("race", "reference", "reference_search", { query: "layer", limit: 8 })));
    const served = rs.reduce((n, r) => n + (r.body.isError ? 0 : r.body.content[0]!.text.match(/^passage \d+:/gm)!.length), 0);
    assert.ok(served <= PASSAGES_PER_LEASE);
    const rows = (await db.get(db.k.selectFrom("remote_passages").select((eb) => eb.fn.countAll<number>().as("n")).where("call_id", "=", leases.get("race")!.id)))!;
    assert.equal(Number(rows.n), served);
  });

  test("a check call reaches the CheckTool of the waiting process, under the lease's agent run", async () => {
    const { id, secret } = leases.get("build")!;
    const seen: { input: unknown; runId: number | null | undefined }[] = [];
    const waiting = awaitCall(db, id, { check: { run: async (input, runId) => { seen.push({ input, runId }); return { text: "clippy: 0 findings on the patch's lines, no compile errors" }; } } });
    const r = await tool("build", "build", "check", { patch: "diff", command: "clippy" });
    assert.deepEqual(r.body, { content: [{ type: "text", text: "clippy: 0 findings on the patch's lines, no compile errors" }] });
    const runId = (await db.get(db.k.selectFrom("remote_calls").select("run_id").where("id", "=", id)))!.run_id!;
    assert.deepEqual(seen, [{ input: { patch: "diff", command: "clippy" }, runId }]);
    await submitCall(db, secret, { ok: false, error: "done", durationMs: 1 });
    assert.equal((await waiting).state, "failed");
  });

  test("with AUTOCRAFT_RUNNER_URL the item tools run on the runner's worker API, which checks the lease again", async () => {
    const w = await startWorkerServer({ db, listen: "127.0.0.1:0" });
    const paths: string[] = [];
    w.server.prependListener("request", (req) => paths.push(req.url ?? ""));
    process.env.AUTOCRAFT_RUNNER_URL = w.url;
    try {
      const r = await tool("tools", "items", "search_items", { query: "wave filter" });
      assert.equal(r.status, 200);
      assert.match(r.body.content[0]!.text, /photocraft#7 issue open/);
      assert.deepEqual(paths, ["/remote/tools/items/search_items"]);
      const direct = await fetch(`${w.url}/remote/tools/items/search_items`, { method: "POST", headers: { authorization: `Bearer ${leases.get("ended")!.secret}`, "content-type": "application/json" }, body: "{}" });
      assert.equal(direct.status, 401, "an ended lease");
    } finally {
      delete process.env.AUTOCRAFT_RUNNER_URL;
      await w.close();
    }
  });
});
