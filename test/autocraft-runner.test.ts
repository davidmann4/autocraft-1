import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as helper from "../worker/autocraft.mjs";
import type * as H from "../worker/autocraft.mjs";
import * as protocol from "../src/remote/protocol.ts";

// The helper keeps its own copy of the wire format; these fail to compile when the copies drift.
const same = <A, B extends A>(_: (b: B) => A) => true;
void [
  same<protocol.Claim, H.Claim>((b) => b), same<H.Claim, protocol.Claim>((b) => b),
  same<protocol.ClaimReply, H.ClaimReply>((b) => b), same<H.ClaimReply, protocol.ClaimReply>((b) => b),
  same<protocol.TaskBundle, H.TaskBundle>((b) => b), same<H.TaskBundle, protocol.TaskBundle>((b) => b),
  same<protocol.Submit, H.Submit>((b) => b), same<H.Submit, protocol.Submit>((b) => b),
  same<protocol.HelperStatus, H.HelperStatus>((b) => b), same<H.HelperStatus, protocol.HelperStatus>((b) => b),
  same<protocol.StatusReply, H.StatusReply>((b) => b), same<H.StatusReply, protocol.StatusReply>((b) => b),
  same<protocol.Heartbeat, H.Heartbeat>((b) => b), same<H.Heartbeat, protocol.Heartbeat>((b) => b),
  same<protocol.Machine, H.Machine>((b) => b), same<H.Machine, protocol.Machine>((b) => b),
  same<protocol.LoginStart, H.LoginStart>((b) => b), same<H.LoginStart, protocol.LoginStart>((b) => b),
  same<protocol.LoginStartReply, H.LoginStartReply>((b) => b), same<H.LoginStartReply, protocol.LoginStartReply>((b) => b),
  same<protocol.LoginPollReply, H.LoginPollReply>((b) => b), same<H.LoginPollReply, protocol.LoginPollReply>((b) => b),
];

test("the runner speaks the server's protocol version and routes", () => {
  assert.equal(helper.PROTOCOL_VERSION, protocol.PROTOCOL_VERSION);
  assert.deepEqual(helper.ROUTES, protocol.ROUTES);
  assert.deepEqual(helper.ENCODINGS, protocol.ENCODINGS);
  assert.deepEqual([helper.HEARTBEAT_S, helper.PREPARE_MAX_S, helper.CLAIM_ID_TTL_S], [protocol.HEARTBEAT_S, protocol.PREPARE_MAX_S, protocol.CLAIM_ID_TTL_S]);
});

// A sandboxed review call with the explorer subagent, as `claude -p --output-format stream-json --verbose` prints it.
const SAMPLE = [
  { type: "system", subtype: "init", session_id: "6f1c0d2e", model: "claude-opus-4-5-20251101", tools: ["Read", "Grep", "Glob", "Agent"] },
  { type: "assistant", session_id: "6f1c0d2e", parent_tool_use_id: null, message: { id: "msg_1", usage: { input_tokens: 9, output_tokens: 120, cache_read_input_tokens: 15000, cache_creation_input_tokens: 4000 }, content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/repo/src/lib.rs" } }] } },
  { type: "user", session_id: "6f1c0d2e", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "fn main() {}" }] } },
  { type: "assistant", session_id: "6f1c0d2e", parent_tool_use_id: "t2", message: { id: "msg_2", usage: { input_tokens: 400, output_tokens: 30 }, content: [{ type: "tool_use", id: "t3", name: "Grep", input: { pattern: "target", path: "/repos/bundle" } }] } },
  { type: "assistant", session_id: "6f1c0d2e", parent_tool_use_id: null, message: { id: "msg_3", usage: { input_tokens: 3, output_tokens: 800 }, content: [{ type: "text", text: "Looks fine." }] } },
  { type: "result", subtype: "success", is_error: false, result: "Recommendation: merge", session_id: "6f1c0d2e", num_turns: 4, total_cost_usd: 0.41,
    usage: { input_tokens: 12, output_tokens: 920, cache_read_input_tokens: 15000, cache_creation_input_tokens: 4000 },
    modelUsage: {
      "claude-opus-4-5-20251101": { inputTokens: 12, outputTokens: 920, cacheReadInputTokens: 15000, cacheCreationInputTokens: 4000, costUSD: 0.4 },
      "claude-haiku-4-5-20251001": { inputTokens: 400, outputTokens: 30, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 },
    } },
].map((e) => JSON.stringify(e)).join("\n");

test("stream-json output gives the reply, the called model's usage, usage per model, cost, the reported model, session and turns", () => {
  assert.deepEqual(helper.parseClaudeOutput(SAMPLE, "opus"), {
    ok: true, text: "Recommendation: merge", model: "claude-opus-4-5-20251101", sessionId: "6f1c0d2e", turns: 4,
    usage: { inputTokens: 12, outputTokens: 920, cacheReadTokens: 15000, cacheWriteTokens: 4000 }, costUsd: 0.41,
    modelUsage: {
      "claude-opus-4-5-20251101": { inputTokens: 12, outputTokens: 920, cacheReadTokens: 15000, cacheWriteTokens: 4000 },
      "claude-haiku-4-5-20251001": { inputTokens: 400, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  });
  const lines = SAMPLE.split("\n").map(helper.claudeProgress).filter(Boolean);
  assert.deepEqual(lines, ["Reading src/lib.rs", 'Explorer: Searching for "target" in bundle']);
  // Killed before the result: no reply, the tokens seen so far.
  const cut = helper.parseClaudeOutput(SAMPLE.split("\n").slice(0, 3).join("\n"), "opus");
  assert.equal(cut.ok, false);
  assert.deepEqual(cut.usage, { inputTokens: 9, outputTokens: 120, cacheReadTokens: 15000, cacheWriteTokens: 4000 });
  // Tool uses for the run's record, timed by the arrival of their lines; the explorer's included.
  const stamps = SAMPLE.split("\n").map((_, i) => `2026-11-19T10:00:0${i}.000Z`);
  const tools = helper.claudeTools(SAMPLE, stamps);
  assert.deepEqual(tools[0], { name: "Read", args: '{"file_path":"/repo/src/lib.rs"}', resultBytes: 12, isError: false, startedAt: stamps[1], endedAt: stamps[2] });
  assert.deepEqual(tools.map((t) => t.name).slice(0, 2), ["Read", "Grep"]);
});

test("instruction files and .claude directories are removed from a checkout at any depth", () => {
  const root = mkdtempSync(join(tmpdir(), "act-instr-"));
  try {
    for (const f of ["CLAUDE.md", "src/agents.md", "src/lib.rs", "docs/Claude.local.md", ".claude/settings.json", "a/.Claude/x/y.md", "README.md", "claude.mdx"]) {
      mkdirSync(join(root, f, ".."), { recursive: true });
      writeFileSync(join(root, f), "x");
    }
    assert.deepEqual(helper.removeInstructionFiles(root), [".claude", "CLAUDE.md", "a/.Claude", "docs/Claude.local.md", "src/agents.md"]);
    assert.deepEqual(helper.removeInstructionFiles(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Claude login 20 minutes from its end takes short calls and leaves long ones for after its refresh", () => {
  const now = 1_000_000_000_000;
  const creds = (expiresAt: number) => ({ claudeAiOauth: { accessToken: "sk-ant-oat-x", refreshToken: "r", expiresAt } });
  const near = creds(now + 20 * 60_000);
  const room = helper.claudeLoginRoom(near, now)!;
  assert.ok(helper.loginTakesCalls(room), "the runner stays ready");
  // The claim names the room; a call it lets through gets the token when it starts, so nothing claimed is given back.
  for (const t of [120, 300, 600]) {
    assert.ok(t <= room.room, `a ${t} s call is claimed`);
    assert.deepEqual(helper.claudeLoginToken(near, t, now + 60_000), { token: "sk-ant-oat-x" }, `a ${t} s call starts after a minute's preparation`);
  }
  assert.ok(room.room < 900 && room.room < 1200);
  assert.deepEqual(helper.claudeLoginToken(near, 1200, now), { problem: helper.CLAUDE_LOGIN_EXPIRES }, "a 20-minute call waits for the refresh");
  assert.ok(room.refreshAt < now + 20 * 60_000, "calls end before the login's end, when claude refreshes it");
  // Close to the refresh point no call fits; a fresh login has room for the longest calls.
  assert.ok(!helper.loginTakesCalls(helper.claudeLoginRoom(creds(now + 6 * 60_000), now)));
  assert.ok(helper.claudeLoginRoom(creds(now + 8 * 3600_000), now)!.room > 3 * 3600);
  assert.equal(helper.claudeLoginRoom({ claudeAiOauth: { accessToken: "k", expiresAt: Number.MAX_SAFE_INTEGER } }, now), null, "a login without an end sets no limit");
  assert.ok("problem" in helper.claudeLoginToken(null, 900, now));
});

test("the claim's model replaces the hinted one; the token stays out of the sandbox arguments", () => {
  const hinted = ["-p", "--model", "opus", "--effort", "high", "--output-format", "stream-json", "--add-dir", "/repo", "--add-dir", "/repos", "--mcp-config", "/mcp.json", "--resume", "old"];
  const args = helper.withoutResume(helper.withModel(hinted, "claude-opus-4-5"));
  assert.deepEqual(args.slice(0, 3), ["-p", "--model", "claude-opus-4-5"]);
  assert.ok(!args.includes("--resume") && !args.includes("old"));
  assert.deepEqual(helper.withModel(["-p", "--effort", "low"], "haiku"), ["-p", "--model", "haiku", "--effort", "low"]);
  const c = helper.claudeSandbox({ claudeBin: "/bin/claude", oauthToken: "sk-ant-oat01-secret", claudeArgs: args, mounts: [{ host: "/cache/tree", path: "/repo" }], mcpFile: "/task/mcp.json" });
  assert.ok(!c.args.join(" ").includes("secret"));
  assert.equal(c.env.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-secret");
  // `/repos` is named by --add-dir with nothing mounted under it: it exists, empty.
  assert.ok(c.args.join(" ").includes("--dir /repos"));
  assert.throws(() => helper.claudeSandbox({ claudeBin: "/bin/claude", claudeArgs: [], mounts: [{ host: "/x", path: "/home/sandbox/.claude" }] }), /unsafe mount path/);
});

// A sandboxed review call as `codex exec --json` prints it (event shapes from codex-rs/exec/src/exec_events.rs).
const CODEX_SAMPLE = [
  { type: "thread.started", thread_id: "019a8c2e-5b7d-7e31-9a0c-3f4d2b1e6a90" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "**Reading the diff**" } },
  { type: "item.started", item: { id: "item_1", type: "mcp_tool_call", server: "files", tool: "grep", arguments: { pattern: "fn parse", path: "/repo/src" }, result: null, error: null, status: "in_progress" } },
  { type: "item.completed", item: { id: "item_1", type: "mcp_tool_call", server: "files", tool: "grep", arguments: { pattern: "fn parse", path: "/repo/src" }, result: { content: [{ type: "text", text: "/repo/src/a.rs:3:fn parse" }], structured_content: null }, error: null, status: "completed" } },
  { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "{\"verdict\":\"take\"}" } },
  { type: "turn.completed", usage: { input_tokens: 24763, cached_input_tokens: 24448, cache_write_input_tokens: 0, output_tokens: 122, reasoning_output_tokens: 64 } },
].map((e) => JSON.stringify(e)).join("\n");

test("codex --json output gives the last message, uncached and cached input, the thread id, and a rerouted model", () => {
  const r = helper.parseCodexOutput(CODEX_SAMPLE, "gpt-6.2-astra");
  assert.deepEqual(r, { ok: true, text: "{\"verdict\":\"take\"}", model: "gpt-6.2-astra", usage: { inputTokens: 315, outputTokens: 122, cacheReadTokens: 24448, cacheWriteTokens: 0 }, sessionId: "019a8c2e-5b7d-7e31-9a0c-3f4d2b1e6a90", turns: 2 });
  const rerouted = `${JSON.stringify({ type: "item.completed", item: { id: "item_9", type: "error", message: "model rerouted: gpt-6.2-astra -> gpt-6-sol (HighRiskCyberActivity)" } })}\n${CODEX_SAMPLE}`;
  assert.equal(helper.parseCodexOutput(rerouted, "gpt-6.2-astra").model, "gpt-6-sol");
  const failed = [{ type: "thread.started", thread_id: "019a8c2e-5b7d-7e31-9a0c-3f4d2b1e6a90" }, { type: "turn.failed", error: { message: "usage limit reached" } }].map((e) => JSON.stringify(e)).join("\n");
  assert.deepEqual(helper.parseCodexOutput(failed, "m"), { ok: false, text: "", model: "m", usage: undefined, sessionId: "019a8c2e-5b7d-7e31-9a0c-3f4d2b1e6a90", error: "model error usage limit reached" });
  assert.equal(helper.codexProgress(CODEX_SAMPLE.split("\n")[3]!), 'Searching for "fn parse" in src');
});

test("codex runs without a shell or --sandbox, reads through the file tools, and keeps tokens out of its arguments", () => {
  const args = helper.codexArgs({ model: "gpt-6.2-astra", effort: "high", system: null, server: "https://ac.example", servers: ["build", "items"], files: "http://127.0.0.1:4100/mcp", keepSession: false, toolTimeoutSec: 900 });
  const line = args.join(" ");
  assert.deepEqual(args.slice(0, 2), ["exec", "--json"]);
  assert.equal(args.at(-1), "-");
  assert.ok(!args.includes("--ephemeral") && !args.includes("--sandbox") && !args.includes("-s"));
  assert.match(line, /features=\{shell_tool=false, unified_exec=false/);
  assert.match(line, /permissions=\{autocraft=\{extends=":read-only", filesystem=\{"\/codex-home"="deny"\}\}\}/);
  assert.match(line, /files=\{url="http:\/\/127\.0\.0\.1:4100\/mcp", bearer_token_env_var="AUTOCRAFT_RUNNER_FILES_TOKEN"/);
  assert.match(line, /items=\{url="https:\/\/ac\.example\/mcp\/task\/items", bearer_token_env_var="AUTOCRAFT_RUNNER_LEASE_SECRET", default_tools_approval_mode="approve"/);
  const thread = "019a8c2e-5b7d-7e31-9a0c-3f4d2b1e6a90";
  const resumed = helper.codexArgs({ model: "m", effort: "low", system: "Answer as JSON.", server: "https://ac.example", servers: [], files: "http://127.0.0.1:1/mcp", keepSession: true, resumeId: thread, toolTimeoutSec: 60 });
  assert.deepEqual(resumed.slice(-3), ["resume", thread, "-"]);
  assert.ok(resumed.includes('developer_instructions="Answer as JSON."'));
  assert.throws(() => helper.codexArgs({ model: "m", effort: "low", system: null, server: "s", servers: [], files: "f", keepSession: true, resumeId: "last-review", toolTimeoutSec: 60 }), /thread id/);
  const c = helper.codexSandbox({ codexBin: "/bin/codex", codexHome: "/cfg/codex-home", codexArgs: args, mounts: [{ host: "/cache/tree", path: "/repo" }, { host: "/cache/fw", path: "/repos/framework" }], env: { AUTOCRAFT_RUNNER_FILES_TOKEN: "files-secret", AUTOCRAFT_RUNNER_LEASE_SECRET: "aclease_secret" } });
  assert.ok(!c.args.join(" ").includes("secret"));
  assert.equal(c.env.CODEX_HOME, "/codex-home");
  assert.ok(c.args.join(" ").includes("--bind /cfg/codex-home /codex-home") && c.args.join(" ").includes("--dir /repos"));
  assert.throws(() => helper.codexSandbox({ codexBin: "/bin/codex", codexHome: "/h", codexArgs: [], mounts: [{ host: "/x", path: "/codex-home" }] }), /unsafe mount path/);
});

test("the file tools read only inside the mounts: no path outside them, no symlink out of them", () => {
  const root = mkdtempSync(join(tmpdir(), "act-files-"));
  try {
    const repo = join(root, "repo"), secret = join(root, "secret");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(secret);
    writeFileSync(join(repo, "src", "a.rs"), "use x;\nfn parse() {}\n");
    writeFileSync(join(secret, "auth.json"), "{\"refresh_token\":\"rt\"}");
    symlinkSync(join(secret, "auth.json"), join(repo, "src", "link.json"));
    const mounts = [{ host: repo, path: "/repo" }];
    assert.equal(helper.runFileTool(mounts, "read_file", { path: "/repo/src/a.rs", offset: 2 }), "     2\tfn parse() {}\n     3\t\n");
    assert.throws(() => helper.runFileTool(mounts, "read_file", { path: "/repo/src/link.json" }), /outside \/repo/);
    assert.throws(() => helper.runFileTool(mounts, "read_file", { path: "/codex-home/auth.json" }), /no such path/);
    assert.throws(() => helper.runFileTool(mounts, "read_file", { path: "/repo/../secret/auth.json" }), /\.\./);
    assert.equal(helper.runFileTool(mounts, "grep", { pattern: "parse|refresh_token", path: "/repo" }), "/repo/src/a.rs:2:fn parse() {}");
    assert.equal(helper.runFileTool(mounts, "glob", { pattern: "**/*.rs" }), "/repo/src/a.rs");
    const reply = helper.fileToolsMessage(mounts, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "/repo/src/link.json" } } });
    assert.equal((reply as { result?: { isError?: boolean } } | null)?.result?.isError, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Claude run that started without one of the call's MCP servers is stopped", () => {
  const init = (mcp: object[]) => JSON.stringify({ type: "system", subtype: "init", cwd: "/work", session_id: "s", tools: [], mcp_servers: mcp });
  const servers = ["items", "work"];
  assert.equal(helper.claudeMcpProblem(init([{ name: "items", status: "connected" }, { name: "work", status: "pending" }]), servers), null);
  // Claude Code leaves a server it will not load (a reserved name) out of the list, and marks one it could not reach failed.
  assert.match(helper.claudeMcpProblem(init([{ name: "items", status: "connected" }]), servers) ?? "", /no work tools/);
  assert.match(helper.claudeMcpProblem(init([{ name: "items", status: "failed" }, { name: "work", status: "connected" }]), servers) ?? "", /no items tools/);
  assert.equal(helper.claudeMcpProblem(init([]), []), null);
});

test("only audited Codex versions run, and a tool outside the call's MCP servers and view_image fails the call", () => {
  assert.equal(helper.codexUnaudited("0.170.3"), null);
  assert.match(helper.codexUnaudited("0.171.0") ?? "", /not a version this helper has audited \(0\.170\.x\)/);
  assert.match(helper.codexUnaudited("1.0.0-beta") ?? "", /not a version/);
  const servers = ["build", "items"];
  const line = (item: object) => JSON.stringify({ type: "item.started", item: { id: "item_1", ...item } });
  assert.equal(helper.codexStreamProblem(CODEX_SAMPLE.split("\n")[3]!, servers), null);
  assert.equal(helper.codexStreamProblem(line({ type: "mcp_tool_call", server: "items", tool: "item" }), servers), null);
  assert.equal(helper.codexStreamProblem(line({ type: "command_execution", command: "cat /codex-home/auth.json" }), servers), "unexpected tool: command_execution");
  assert.equal(helper.codexStreamProblem(line({ type: "mcp_tool_call", server: "github", tool: "get_file" }), servers), "unexpected tool: MCP server github");
  const rollout = (calls: object[]) => calls.map((payload) => JSON.stringify({ timestamp: "2026-11-19T10:00:00.000Z", type: "response_item", payload })).join("\n");
  const fine = [
    { type: "message", role: "user", content: [] },
    { type: "function_call", name: "read_file", namespace: "mcp__files__", arguments: "{}", call_id: "c1" },
    { type: "function_call", name: "mcp__items__item", arguments: "{}", call_id: "c2" },
    { type: "function_call", name: "view_image", arguments: "{}", call_id: "c3" },
    { type: "function_call_output", call_id: "c1", output: "x" },
  ];
  assert.equal(helper.codexRolloutProblem(rollout(fine), servers), null);
  assert.deepEqual(helper.codexRolloutTools(rollout(fine)).map((t) => [t.name, t.args, t.resultBytes]), [["Read", "{}", 1], ["mcp__items__item", "{}", null], ["view_image", "{}", null]]);
  assert.equal(helper.codexRolloutProblem(rollout([...fine, { type: "function_call", name: "read_file", arguments: "{}", call_id: "c4" }]), servers), "unexpected tool: read_file");
  assert.equal(helper.codexRolloutProblem(rollout([{ type: "function_call", name: "list_dir", namespace: "mcp__reference__", arguments: "{}", call_id: "c5" }]), servers), "unexpected tool: mcp__reference__list_dir");
  assert.equal(helper.codexRolloutProblem(rollout([{ type: "custom_tool_call", name: "exec", input: "", call_id: "c6" }]), servers), "unexpected tool: custom_tool_call");
  assert.equal(helper.codexRolloutProblem(rollout([{ type: "local_shell_call", call_id: "c7", status: "completed", action: {} }]), servers), "unexpected tool: local_shell_call");
});

test("the macOS profile denies by default, names the secrets before the narrow allows, and writes only the temp directory and the given stores", () => {
  const home = "/Users/ann";
  const p = helper.macProfile({ deny: helper.macDenied(home), dirs: [`${home}/.claude/local/node_modules/@anthropic-ai/claude-code`, "/opt/homebrew/Cellar/node/24.1.0"], writes: [`${home}/.cache/autocraft-runner/sessions/store-x`] });
  const lines = p.split("\n");
  assert.deepEqual(lines.slice(0, 2), ["(version 1)", "(deny default)"]);
  const at = (s: string) => { const i = p.indexOf(s); assert.ok(i >= 0, s); return i; };
  // Seatbelt applies the last matching rule: the secrets come before the allows, which re-open only paths below them.
  const deny = at("(deny file-read* file-write*");
  for (const s of [`(subpath "${home}/.ssh")`, `(subpath "${home}/.aws")`, `(subpath "${home}/Library/Keychains")`, `(regex #"^/Users/ann/\\.claude")`, `(subpath "${home}/.codex")`]) assert.ok(at(s) > deny && at(s) < at('(param "ROOT")'), s);
  assert.ok(at(`(subpath "${home}/.claude/local/node_modules/@anthropic-ai/claude-code")`) > deny);
  assert.match(p, /\(allow file-read\* file-test-existence \(subpath \(param "ROOT"\)\)\)/);
  const writable = lines.filter((l) => /\(allow [^)]*file-write\*/.test(l) || /^\(allow file-read\* file-write\* file-test-existence$/.test(l));
  assert.equal(writable.length, 2);
  assert.ok(p.includes('(allow file-read* file-write* file-test-existence (subpath (param "TMP")))') && p.includes(`(subpath "${home}/.cache/autocraft-runner/sessions/store-x")`));
  assert.ok(!p.includes(`(subpath "${home}")`) && !p.includes("(allow file-read*)") && !p.includes('(subpath "/System/Volumes/Data")'));
  assert.ok(p.includes('(allow network-outbound (remote ip "*:*"))') && !p.includes("network-inbound"));
  assert.match(helper.macProfile({ deny: [], files: ['/Applications/A "b"/claude'] }), /\(literal "\/Applications\/A \\"b\\"\/claude"\)/);
  assert.throws(() => helper.macProfile({ deny: [], dirs: ["/x\ny"] }), /unsafe path/);
  assert.throws(() => helper.macProfile({ deny: [], dirs: ["relative"] }), /unsafe path/);
});

test("a slot holds the call's trees as copies, keeps an unchanged tree, and drops what the next call does not use", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slot-"));
  try {
    const tree = (name: string, files: Record<string, string>) => { const d = join(dir, "cache", name); for (const [f, c] of Object.entries(files)) { mkdirSync(join(d, f, ".."), { recursive: true }); writeFileSync(join(d, f), c); } return d; };
    const app = tree("app", { "src/lib.rs": "fn a() {}" }), fw = tree("fw", { "README.md": "fw" }), docs = tree("docs", { "AGENTS.txt": "rules" });
    const root = join(dir, "slot-0");
    const plan = helper.slotPlan(root, [{ host: app, path: "/repo" }, { host: fw, path: "/repos/framework" }], [`${root}/repo`, `${root}/repos`, `${root}/repo-docs`]);
    assert.deepEqual(plan.mounts.map((m) => m.path), [`${root}/repo`, `${root}/repos/framework`]);
    assert.deepEqual(plan.dirs.sort(), [`${root}/repo-docs`, `${root}/repos`]);
    await helper.fillSlot(root, plan, [{ name: "mcp.json", content: "{}" }, { name: "agents.json", content: "{}" }]);
    assert.equal(readFileSync(join(root, "repo/src/lib.rs"), "utf8"), "fn a() {}");
    assert.equal(readFileSync(join(root, "repos/framework/README.md"), "utf8"), "fw");
    assert.ok(existsSync(join(root, "repo-docs")) && existsSync(join(root, "work")) && existsSync(join(root, "tmp/home")));
    assert.equal(statSync(join(root, "mcp.json")).mode & 0o777, 0o600);
    assert.ok(!existsSync(join(root, "slot-0.json")) && existsSync(`${root}.json`), "the record is kept beside the slot, not in it");
    writeFileSync(join(root, "repo/kept"), "same tree, not copied again");
    writeFileSync(join(root, "tmp/home/x"), "per call");
    await helper.fillSlot(root, helper.slotPlan(root, [{ host: app, path: "/repo" }, { host: docs, path: "/repo-docs" }], [`${root}/repo`, `${root}/repo-docs`]), []);
    assert.ok(existsSync(join(root, "repo/kept")));
    assert.ok(!existsSync(join(root, "repos")) && !existsSync(join(root, "mcp.json")) && !existsSync(join(root, "agents.json")) && !existsSync(join(root, "tmp/home/x")));
    assert.equal(readFileSync(join(root, "repo-docs/AGENTS.txt"), "utf8"), "rules");
    await helper.fillSlot(root, helper.slotPlan(root, [{ host: fw, path: "/repo" }], [`${root}/repo`, `${root}/repo-docs`]), []);
    assert.ok(!existsSync(join(root, "repo/kept")) && existsSync(join(root, "repo/README.md")));
    assert.deepEqual(readdirSync(join(root, "repo-docs")), [], "an empty directory of the plan holds no earlier copy");
    assert.throws(() => helper.slotPlan(root, [{ host: app, path: "/tmp" }]), /unsafe mount path/);
    assert.throws(() => helper.slotPlan(root, [], [`${root}/work`]), /unsafe mount path/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("macOS runs: the canary verdict, the command line, Codex's paths in the slot and Claude Code's Keychain item", () => {
  const pass = { readSlot: { ok: true }, writeTmp: { ok: true }, readPlanted: { ok: false, code: "EPERM" }, listHome: { ok: false, code: "EPERM" }, listSsh: { ok: false, code: "EPERM" }, listKeychains: { ok: false, code: "EPERM" }, writeHome: { ok: false, code: "EPERM" }, writeSlot: { ok: false, code: "EPERM" } };
  assert.equal(helper.canaryVerdict(JSON.stringify(pass)).ok, true);
  const leak = helper.canaryVerdict(JSON.stringify({ ...pass, readPlanted: { ok: true } }));
  assert.equal(leak.ok, false);
  assert.ok(leak.lines.some((l) => l.startsWith("FAIL readPlanted")));
  assert.equal(helper.canaryVerdict("").ok, false);
  const root = "/private/var/folders/ab/cd/C/autocraft-runner/slot-0";
  const c = helper.macCommand({ profile: "/tmp/p.sb", root, argv: ["/bin/claude", "-p"], env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } });
  assert.deepEqual(c.args, ["-f", "/tmp/p.sb", "-D", `ROOT=${root}`, "-D", `TMP=${root}/tmp`, "/bin/claude", "-p"]);
  assert.equal(c.cmd, "/usr/bin/sandbox-exec");
  assert.equal(c.cwd, `${root}/work`);
  assert.equal(c.env.HOME, `${root}/tmp/home`);
  assert.equal(c.env.CLAUDE_CODE_TMPDIR, `${root}/tmp/t`);
  const args = helper.codexArgs({ model: "m", effort: "low", system: null, server: "s", servers: [], files: "f", keepSession: false, toolTimeoutSec: 60, paths: { work: `${root}/work`, home: `${root}/tmp/home`, codexHome: "/Users/ann/.config/autocraft-runner/codex-home" } });
  const line = args.join(" ");
  assert.ok(line.includes(`-C ${root}/work`) && line.includes('filesystem={"/Users/ann/.config/autocraft-runner/codex-home"="deny"}') && !line.includes('{"/codex-home"') && !line.includes("/home/sandbox"));
  assert.deepEqual(helper.claudeKeychainItem({ USER: "ann" }), { service: "Claude Code-credentials", account: "ann" });
  assert.match(helper.claudeKeychainItem({ USER: "a b", CLAUDE_CONFIG_DIR: "/Users/ann/.claude-work" }).service, /^Claude Code-credentials-[0-9a-f]{8}$/);
  assert.equal(helper.claudeKeychainItem({ USER: "a b" }).account, "claude-code-user");
});

// Claude Code's /api/oauth/usage reply, trimmed (2.1.323, a Max plan): the named windows and the `limits` list.
const CLAUDE_USAGE = {
  five_hour: { utilization: 4.0, resets_at: "2026-11-20T01:30:00.342009+00:00" }, seven_day: { utilization: 24.0, resets_at: "2026-11-20T00:00:00.342030+00:00" },
  seven_day_opus: null, seven_day_sonnet: null, extra_usage: { is_enabled: false },
  limits: [
    { kind: "session", group: "session", percent: 4, severity: "normal", resets_at: "2026-11-20T01:30:00.342009+00:00", scope: null, is_active: false },
    { kind: "weekly_all", group: "weekly", percent: 24, severity: "normal", resets_at: "2026-11-20T00:00:00.342030+00:00", scope: null, is_active: true },
    { kind: "weekly_scoped", group: "weekly", percent: 97, severity: "normal", resets_at: "2026-11-20T00:00:00+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
  ],
};

test("readiness from plan usage: claims only above the reserve in every window, holds on anything unknown or stale, and a local reserve only raises", () => {
  const now = Date.parse("2026-11-19T20:00:00Z");
  const r20 = { fiveHour: 20, weekly: 20 };
  const claude = helper.parseClaudeUsage(CLAUDE_USAGE, ["opus", "sonnet", "haiku"], now);
  assert.deepEqual(helper.quotaVerdict(claude, r20, now), { ok: true }, "the Fable-only weekly window does not bind an Opus helper");
  const fable = helper.quotaVerdict(helper.parseClaudeUsage(CLAUDE_USAGE, ["fable"], now), r20, now);
  assert.equal(fable.ok, false);
  assert.match(!fable.ok ? fable.reason : "", /weekly window 97% used/);
  assert.equal(!fable.ok && fable.until, Date.parse("2026-11-20T00:00:00Z"));
  assert.deepEqual(helper.usageOfReading(claude), { fiveHour: { usedPercent: 4, resetsAt: "2026-11-20T01:30:00.342Z" }, weekly: { usedPercent: 24, resetsAt: "2026-11-20T00:00:00.342Z" }, at: new Date(now).toISOString() });
  const held = (r: H.QuotaVerdict) => (r.ok ? "" : r.reason);
  assert.match(held(helper.quotaVerdict(claude, { fiveHour: 20, weekly: 76 }, now)), /weekly window 24% used/, "remaining 76 is not above a reserve of 76");
  assert.match(held(helper.quotaVerdict(null, r20, now)), /no usage reading/);
  assert.match(held(helper.quotaVerdict({ at: now, error: "HTTP 403" }, r20, now)), /usage unknown: HTTP 403/);
  assert.match(held(helper.quotaVerdict(claude, r20, now + 6 * 60_000)), /min old/, "stale");
  assert.match(held(helper.quotaVerdict(helper.parseClaudeUsage({ limits: [{ kind: "monthly", group: "monthly", percent: 1, resets_at: null }] }, ["opus"], now), r20, now)), /does not know \(monthly\)/);
  assert.match(held(helper.quotaVerdict(helper.parseClaudeUsage({ five_hour: null }, ["opus"], now), r20, now)), /no plan window/);
  // Codex: the worst window binds; a 300-minute window is the 5-hour one, 10080 the weekly one.
  const codex = { ordinaryUsageAllowed: true, rateLimits: { limitId: "codex", primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 1795651200 }, secondary: { usedPercent: 85, windowDurationMins: 10080, resetsAt: 1796000000 } },
    rateLimitsByLimitId: { other: { limitId: "other", normalModelSlug: "gpt-x", primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1795651200 } } } };
  const cv = helper.quotaVerdict(helper.parseCodexRateLimits(codex, ["gpt-6.2-astra"], now), r20, now);
  assert.match(held(cv), /^weekly window 85% used/, "a bucket of a model the helper does not run is left out");
  assert.equal(!cv.ok && cv.until, 1796000000 * 1000);
  assert.match(held(helper.quotaVerdict(helper.parseCodexRateLimits({ ...codex, ordinaryUsageAllowed: false }, [], now), { fiveHour: 0, weekly: 0 }, now)), /used up/);
  assert.match(held(helper.quotaVerdict(helper.parseCodexRateLimits({ rateLimits: { primary: { usedPercent: 1, windowDurationMins: 60 } } }, [], now), r20, now)), /60-minute/);
  // The local reserve only raises the server's; before the server answers, the default holds.
  assert.deepEqual(helper.effectiveReserve({ fiveHour: 30, weekly: 10 }, { fiveHour: 5, weekly: 40 }), { fiveHour: 30, weekly: 40 });
  assert.deepEqual(helper.effectiveReserve(undefined, { fiveHour: 0, weekly: 0 }), { fiveHour: 20, weekly: 20 });
  // A pause outranks recovered headroom; a park without a trusted time ends with a passing reading taken after it.
  const ok = { ok: true } as const;
  assert.equal(helper.quotaReadiness({ pause: { until: now + 60_000, at: now }, verdict: ok, readingAt: now, now }).readiness, "paused");
  assert.deepEqual(helper.quotaReadiness({ pause: { until: now - 1, at: now - 9 }, verdict: ok, readingAt: now, now }), { readiness: "ready", until: null, dropPause: true });
  const park = { until: null, at: now, reason: "refused" };
  assert.equal(helper.quotaReadiness({ park, verdict: ok, readingAt: now - 1, now }).readiness, "quota-held", "a reading from before the refusal");
  assert.deepEqual(helper.quotaReadiness({ park, verdict: ok, readingAt: now + 1, now }), { readiness: "ready", until: null, dropPark: true });
  assert.equal(helper.quotaReadiness({ park: { ...park, until: now + 1000 }, verdict: ok, readingAt: now + 1, now }).until, now + 1000, "a parsed reset holds until it passes");
});

test("a provider's refusal for its usage limit parks until the reset it names, capped; a clock time without a zone is not trusted", () => {
  const now = Date.parse("2026-11-19T12:00:00Z");
  const grace = 60_000;
  assert.equal(helper.parseRefusal("model error You've hit your 5-hour limit · resets 3pm (Europe/Berlin)", now)?.until, Date.parse("2026-11-19T14:00:00Z") + grace);
  assert.equal(helper.parseRefusal("You\u2019ve hit your weekly limit \u00b7 resets Nov 21, 9:30am (UTC)", now)?.until, Date.parse("2026-11-21T09:30:00Z") + grace);
  assert.equal(helper.parseRefusal("You've hit your limit · resets 11am (UTC)", now)?.until, Date.parse("2026-11-20T11:00:00Z") + grace, "a time already past today is tomorrow's");
  assert.equal(helper.parseRefusal("model error You've hit your usage limit. Upgrade to Pro or try again in 4 days 2 hours 3 minutes.", now)?.until, now + ((4 * 24 + 2) * 60 + 3) * 60_000 + grace);
  assert.equal(helper.parseRefusal("usage limit reached; resets in 4h42m28s", now)?.until, now + (4 * 3600 + 42 * 60 + 28) * 1000 + grace);
  assert.equal(helper.parseRefusal("Claude AI usage limit reached|1795660000", now)?.until, 1795660000 * 1000 + grace);
  assert.equal(helper.parseRefusal("You've hit your usage limit · resets in 999h", now)?.until, now + helper.PARK_CAP_MS);
  assert.equal(helper.parseRefusal("You've hit your usage limit. Try again at 3:45 PM.", now)?.until, null);
  assert.equal(helper.parseRefusal("You've hit your usage limit.", now)?.until, now + 15 * 60_000);
  assert.equal(helper.parseRefusal("model error max turns reached", now), null);
});

test("Codex gets at most its top effort; Claude takes the whole ladder", () => {
  assert.equal(helper.harnessEffort("max", "xhigh"), "xhigh");
  assert.equal(helper.harnessEffort("medium", "xhigh"), "medium");
  assert.equal(helper.harnessEffort("max", "max"), "max");
});
