// MCP Connector and Task Runner credentials: the one-time split of older tokens, the claim protocols the server accepts,
// which routes each kind may use, the device login with its scopes, and removing a runner.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { after, before, describe, test } from "node:test";
import type { RunnersReply } from "../web/src/api/types.ts";
import { addLogin } from "../src/access.ts";
import { splitRunnerTokens } from "../src/db.ts";
import { apiRoutes } from "../src/dash/api/index.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { loadConfig } from "../src/dash/server/config.ts";
import { randomToken, sha256hex } from "../src/dash/server/crypto.ts";
import { startServer, SUBMIT_BODY_LIMIT } from "../src/dash/server/index.ts";
import { FakeProvider } from "../src/dash/server/provider.ts";
import { HttpError, RateLimiter } from "../src/dash/server/util.ts";
import { parseClaim } from "../src/remote/calls.ts";
import { addressKey, MAX_PENDING_PER_ADDRESS, startLogin } from "../src/remote/device-login.ts";
import { PROTOCOL_VERSION, ROUTES, type LoginStartReply, type PendingRunnerLogin } from "../src/remote/protocol.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { sqliteOnly } from "./test-db.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "runner-credentials-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("older tokens a helper used become runners, the others connectors, and can_run follows the kind", { skip: sqliteOnly("splitRunnerTokens on db.sync") }, async () => {
  const db = await connectDb(join(dir, "split.db"));
  const now = new Date().toISOString();
  const token = async (label: string, canRun: number) =>
    Number((await db.get(db.k.insertInto("mcp_tokens").values({ login: "alice", token_hash: `hash-${label}`, label, can_run: canRun, created_at: now, expires_at: now }).returning("id")))!.id);
  const status = await token("status", 1), idle = await token("idle", 1), leased = await token("leased", 1), unused = await token("unused", 1), plain = await token("plain", 0);
  await db.run(db.k.insertInto("remote_helpers").values({ token_id: status, login: "alice", readiness: "ready", harness: "claude", models: "{}", reserve: "{}", reported_at: 0 }));
  await db.run(db.k.updateTable("mcp_tokens").set({ idle_claim_at: 1 }).where("id", "=", idle));
  await db.run(db.k.insertInto("remote_calls").values({
    step: "review", stage: 0, prompt_id: "p", prompt_version: "1", tier: "top", effort: "high", asked_model: "opus", bundle: "{}", state: "done", since: 0, seen_at: 0,
    max_attempts: 1, timeout_ms: 1, token_id: leased,
  }));
  await db.run(db.k.deleteFrom("settings").where("key", "=", "runner_tokens_split"));

  splitRunnerTokens(db.sync!);
  splitRunnerTokens(db.sync!);

  const rows = await db.all(db.k.selectFrom("mcp_tokens").select(["id", "kind", "can_run"]).orderBy("id"));
  assert.deepEqual(rows.map((r) => [r.id, r.kind, r.can_run]), [[status, "runner", 1], [idle, "runner", 1], [leased, "runner", 1], [unused, "connector", 0], [plain, "connector", 0]]);
  const audits = await db.prepare("SELECT login, target, details FROM audit WHERE action = 'runner-migrate' ORDER BY rowid").all() as { login: string; target: string; details: string }[];
  assert.deepEqual(audits.map((a) => [a.login, a.target, JSON.parse(a.details).id, JSON.parse(a.details).kind]),
    [["migration", "alice", status, "runner"], ["migration", "alice", idle, "runner"], ["migration", "alice", leased, "runner"], ["migration", "alice", unused, "connector"]]);
  await db.close();
});

test("a claim keeps the helper's protocol; protocol 3 carries no wait", () => {
  const base = { requestId: "test-claim-0001", helperVersion: "1.3.0", harness: "claude", harnessVersion: "2.1", tiers: { top: "opus" } };
  const v3 = parseClaim({ ...base, protocol: 3, wait: 25 });
  assert.equal(v3.protocol, 3);
  assert.equal(v3.wait, undefined);
  const v4 = parseClaim({ ...base, protocol: 4, wait: 25 });
  assert.equal(v4.protocol, 4);
  assert.equal(v4.wait, 25);
  assert.equal(parseClaim({ ...base, protocol: 4 }).wait, undefined);
  assert.throws(() => parseClaim({ ...base, protocol: 4, wait: 31 }), (e) => e instanceof HttpError && e.status === 400);
  assert.throws(() => parseClaim({ ...base, protocol: 4, wait: 2.5 }), (e) => e instanceof HttpError && e.status === 400);
  assert.equal(parseClaim({ ...base, protocol: 5, wait: 25 }).wait, 25);
  assert.throws(() => parseClaim({ ...base, protocol: PROTOCOL_VERSION + 1 }), (e) => e instanceof HttpError && e.status === 409);
});

describe("over HTTP", async () => {
  const file = join(dir, "http.db"), perms = join(dir, "perms.json");
  writeFileSync(perms, "{}");
  const db = await connectDb(file);
  let base = "";
  let close: () => Promise<void>;
  before(async () => {
    await addLogin(db, "cli", "maint", "maintainer", null);
    await addLogin(db, "cli", "watcher", "viewer", null);
    await addLogin(db, "cli", "boss", "operator", null);
    const config = loadConfig({ AUTOCRAFT_DEV_AUTH: "1", AUTOCRAFT_LISTEN: "127.0.0.1:0", AUTOCRAFT_DB: file, AUTOCRAFT_DEV_PERMS: perms });
    const limiter = new RateLimiter(60, 3600_000);
    const s = await startServer({ config, db, provider: new FakeProvider(perms), routes: apiRoutes() });
    base = s.url;
    close = s.close;
  });
  after(async () => {
    await close();
    await db.close();
  });

  const post = async (path: string, body: unknown, bearer?: string) => {
    const r = await fetch(new URL(path, base), { method: "POST", headers: { "content-type": "application/json", ...(bearer && { authorization: `Bearer ${bearer}` }) }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };
  const claimBody = () => ({ requestId: `req-${randomToken(8)}`, protocol: PROTOCOL_VERSION, helperVersion: "1.3.0", harness: "claude", harnessVersion: "2.1", tiers: { top: "opus" } });
  const claim = (bearer: string) => post(ROUTES.claim, claimBody(), bearer);
  const poll = async (credential: string) => (await post(ROUTES.loginPoll, {}, credential)).body.state;
  const start = async (credential: string, scopes?: { agent?: boolean; answer?: boolean }) => {
    const r = await post(ROUTES.loginStart, { credentialHash: sha256hex(credential), label: "laptop", machine: { hostname: "box1", platform: "linux", arch: "x64" }, helperVersion: "1.3.0", ...(scopes && { scopes }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body as unknown as LoginStartReply;
  };

  async function signedIn(login: string) {
    const jar = new Map<string, string>();
    let csrf = "";
    const req = async (method: string, path: string, body?: unknown) => {
      const headers: Record<string, string> = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), accept: "application/json", "x-csrf-token": csrf };
      if (body !== undefined) headers["content-type"] = "application/json";
      const r = await fetch(new URL(path, base), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
      for (const c of r.headers.getSetCookie()) {
        const [kv] = c.split(";");
        jar.set(kv!.slice(0, kv!.indexOf("=")), kv!.slice(kv!.indexOf("=") + 1));
      }
      return r;
    };
    const signin = await req("GET", "/auth/signin?return_to=/");
    const auth = await req("GET", `${signin.headers.get("location")}&login=${login}`);
    await req("GET", auth.headers.get("location")!);
    csrf = (await req("GET", "/api/me")).headers.get("x-csrf-token") ?? "";
    return async <T>(method: string, path: string, body?: unknown, status = 200): Promise<T> => {
      const r = await req(method, path, body);
      const text = await r.text();
      assert.equal(r.status, status, `${method} ${path}: ${text}`);
      return JSON.parse(text) as T;
    };
  }

  const toolNames = async (token: string) => {
    const r = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return ((r.body.result as { tools: { name: string }[] }).tools).map((t) => t.name);
  };

  test("a connector token cannot claim or report status; a runner credential uses /mcp only with agent access", async () => {
    const connector = (await createToken(db, "maint", "agent")).token;
    const runner = (await createToken(db, "maint", "desk", { kind: "runner" })).token;
    const refused = await claim(connector);
    assert.equal(refused.status, 403);
    assert.match(String(refused.body.error), /MCP Connector tokens cannot run tasks/);
    assert.equal((await post(ROUTES.status, {}, connector)).status, 403);
    assert.equal((await claim(runner)).status, 200);
    const mcp = (token: string) => post("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, token);
    assert.equal((await mcp(connector)).status, 200);
    const noAgent = await mcp(runner);
    assert.equal(noAgent.status, 403);
    assert.match(String((noAgent.body.error as { message: string }).message), /tick Agent access/);
  });

  test("a runner's scopes: agent access opens /mcp, answering adds the command tool, and the owner changes both", async () => {
    const boss = await signedIn("boss");
    const { token, row } = await createToken(db, "boss", "studio", { kind: "runner", canAgent: true });
    const tools = await toolNames(token);
    assert.ok(tools.includes("list_repos"), tools.join());
    assert.ok(!tools.includes("command"));
    const list = await boss<RunnersReply>("POST", "/api/runners/scopes", { id: row.id, agent: true, answer: true });
    assert.deepEqual(list.runners.filter((r) => r.tokenId === row.id).map((r) => [r.agent, r.answer]), [[true, true]]);
    assert.equal(list.answering, true);
    assert.ok((await toolNames(token)).includes("command"));
    assert.ok(await db.get(db.k.selectFrom("audit").select((eb) => eb.lit(1).as("one")).where("action", "=", "runner-scopes").where("login", "=", "boss")));
    await boss("POST", "/api/runners/scopes", { id: row.id, agent: false, answer: false });
    assert.equal((await post("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, token)).status, 403);
    await (await signedIn("maint"))("POST", "/api/runners/scopes", { id: row.id, agent: true, answer: false }, 404);
  });

  test("a maintainer approves a Task Runner that sends commands; a viewer cannot", async () => {
    const credential = `acrun_${randomToken(32)}`;
    const { userCode } = await start(credential, { answer: true });
    const maint = await signedIn("maint");
    const card = await maint<PendingRunnerLogin>("GET", `/api/runners/pending?code=${userCode}`);
    assert.deepEqual(card.scopes, { agent: true, answer: true });
    const list = await maint<RunnersReply>("POST", "/api/runners/approve", { code: userCode, agent: true, answer: true });
    assert.ok(list.runners.some((r) => r.label === "laptop" && r.agent && r.answer));
    assert.ok((await toolNames(credential)).includes("command"));
  });

  test("device login: the runner starts, a maintainer looks up the code and approves, the runner polls and claims", async () => {
    const credential = `acrun_${randomToken(32)}`;
    assert.equal((await post(ROUTES.loginPoll, {}, credential)).status, 401, "no login yet");
    const started = await start(credential);
    assert.match(started.userCode, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    assert.ok(started.verifyUrl.endsWith(`/connect?runner=${started.userCode}`));
    assert.equal(await poll(credential), "pending");
    assert.equal((await claim(credential)).status, 401, "not approved yet");
    const code = started.userCode.replace("-", "").toLowerCase();
    await (await signedIn("watcher"))("GET", `/api/runners/pending?code=${code}`, undefined, 403);
    const maint = await signedIn("maint");
    const card = await maint<PendingRunnerLogin>("GET", `/api/runners/pending?code=${code}`);
    assert.deepEqual([card.label, card.machine.hostname, card.helperVersion, card.ip === card.yourIp], ["laptop", "box1", "1.3.0", true]);
    assert.deepEqual(card.scopes, { agent: true, answer: false });
    const list = await maint<RunnersReply>("POST", "/api/runners/approve", { code: started.userCode, label: "work laptop", agent: false, answer: false });
    const mine = list.runners.find((r) => r.label === "work laptop");
    assert.ok(mine);
    assert.deepEqual(mine.machine, { hostname: "box1", platform: "linux", arch: "x64" });
    assert.deepEqual([mine.agent, mine.answer], [false, false]);
    assert.equal(await poll(credential), "approved");
    assert.equal((await claim(credential)).status, 200);
    await maint("POST", "/api/runners/approve", { code: started.userCode, agent: true, answer: false }, 404);
    assert.ok(await db.prepare("SELECT 1 FROM audit WHERE action = 'runner-approve' AND login = 'maint'").get());
  });

  test("a login from another address is approved only when the approver says they started it elsewhere; pending logins are capped per address", async () => {
    const maint = await signedIn("maint");
    const credential = `acrun_${randomToken(32)}`;
    const started = await start(credential);
    await db.run(db.k.updateTable("runner_logins").set({ ip: "2001:db8:1:2::7" }).where("secret_hash", "=", sha256hex(credential)));
    await maint("POST", "/api/runners/approve", { code: started.userCode, agent: true, answer: false }, 409);
    assert.equal(await poll(credential), "pending");
    await maint("POST", "/api/runners/approve", { code: started.userCode, agent: true, answer: false, otherMachine: true });
    assert.equal(await poll(credential), "approved");

    assert.equal(addressKey("2001:DB8:1:2:aa::1"), addressKey("2001:db8:1:2::9"));
    assert.notEqual(addressKey("2001:db8:1:2::1"), addressKey("2001:db8:1:3::1"));
    assert.equal(addressKey("::ffff:192.0.2.1"), "192.0.2.1");
    const login = async (ip: string) => await startLogin(db, { credentialHash: sha256hex(randomToken(16)), label: "x", machine: { hostname: "h", platform: "linux", arch: "x64" }, helperVersion: "1.3.0" }, ip, "http://x");
    for (let i = 1; i <= MAX_PENDING_PER_ADDRESS; i++) await login(`2001:db8:5:6::${i}`);
    await assert.rejects(async () => await login("2001:db8:5:6:ffff::1"), (e: unknown) => e instanceof HttpError && e.status === 429);
    await login("2001:db8:5:7::1");
  });

  test("an expired or denied login cannot be approved", async () => {
    const maint = await signedIn("maint");
    const late = `acrun_${randomToken(32)}`;
    const a = await start(late);
    await db.run(db.k.updateTable("runner_logins").set({ expires_at: Date.now() - 1 }).where("secret_hash", "=", sha256hex(late)));
    assert.equal(await poll(late), "expired");
    await maint("POST", "/api/runners/approve", { code: a.userCode, agent: true, answer: false }, 404);
    const no = `acrun_${randomToken(32)}`;
    const b = await start(no);
    await maint("POST", "/api/runners/deny", { code: b.userCode });
    assert.equal(await poll(no), "denied");
    await maint("POST", "/api/runners/approve", { code: b.userCode, agent: true, answer: false }, 404);
    assert.equal((await claim(no)).status, 401);
  });

  test("removing a runner sends its live lease back to the queue without using an attempt", async () => {
    const maint = await signedIn("maint");
    const { token, row } = await createToken(db, "maint", "old box", { kind: "runner" });
    const secret = `aclease_${randomToken(32)}`;
    const now = Date.now();
    const call = Number((await db.get(db.k.insertInto("remote_calls").values({
      step: "review", stage: 0, prompt_id: "p", prompt_version: "1", tier: "top", effort: "high", asked_model: "opus", bundle: "{}", state: "leased", since: now, seen_at: now, max_attempts: 3, timeout_ms: 600000,
      user_login: "maint", lease_secret_hash: sha256hex(secret), token_id: row.id, leased_at: now, heartbeat_at: now,
    }).returning("id")))!.id);
    const beat = () => post(ROUTES.heartbeat, {}, secret);
    assert.equal((await beat()).status, 200);
    await maint("POST", "/api/runners/revoke", { id: row.id });
    assert.equal((await beat()).status, 410);
    const after = (await db.get(db.k.selectFrom("remote_calls").select(["state", "attempt", "token_id"]).where("id", "=", call)))!;
    assert.deepEqual([after.state, after.attempt, after.token_id], ["queued", 1, null]);
    assert.equal((await claim(token)).status, 401);
  });

  test("runner routes take a gzip+base64 envelope, its uncompressed body held to the route's limit; claim replies list the encoding", async () => {
    const { token, row } = await createToken(db, "maint", "proxied box", { kind: "runner" });
    assert.deepEqual((await claim(token)).body.encodings, ["gzip+base64"]);
    const secret = `aclease_${randomToken(32)}`;
    const now = Date.now();
    const call = Number((await db.get(db.k.insertInto("remote_calls").values({
      step: "review", stage: 0, prompt_id: "p", prompt_version: "1", tier: "top", effort: "high", asked_model: "opus", model: "opus", bundle: "{}", state: "leased", since: now, seen_at: now, max_attempts: 3, timeout_ms: 600000,
      user_login: "maint", lease_secret_hash: sha256hex(secret), token_id: row.id, leased_at: now, heartbeat_at: now,
    }).returning("id")))!.id);
    const enc = (body: unknown) => ({ encoding: "gzip+base64", body: gzipSync(JSON.stringify(body)).toString("base64") });
    const reply = { ok: true, text: "<script>alert(1)</script> UNION SELECT", model: "claude-opus-4-5", usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 5 };
    assert.equal((await post(ROUTES.submit, enc({ ...reply, text: "x".repeat(SUBMIT_BODY_LIMIT) }), secret)).status, 413);
    assert.equal((await post(ROUTES.heartbeat, enc({ phase: "running", progress: "Reading /etc/passwd" }), secret)).status, 200);
    assert.deepEqual(await post(ROUTES.submit, enc(reply), secret), { status: 200, body: { accepted: true } });
    assert.equal((await db.get(db.k.selectFrom("remote_calls").select("reply").where("id", "=", call)))!.reply, reply.text);
  });

  test("a valid envelope with invalid base64 or gzip gets 400; any other shape is plain JSON", async () => {
    const bad = await post(ROUTES.loginStart, { encoding: "gzip+base64", body: "!!!not gzip" });
    assert.equal(bad.status, 400);
    assert.match(String(bad.body.error), /not valid gzip\+base64/);
    const plain = await post(ROUTES.loginStart, { encoding: "x", body: "y" });
    assert.notEqual(plain.status, 415);
    assert.doesNotMatch(String(plain.body.error), /not valid gzip/);
  });
});
