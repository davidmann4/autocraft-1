// Operators' own builds through the MCP server: only operators get the tools, a build starts only from a default-branch
// commit AutoCraft recorded, no confidential or signing environment takes one, and the status reads each line's own exit code.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { storeArtifact, tempPath } from "../src/build/artifacts.ts";
import { createEnv, hello } from "../src/build/envs.ts";
import { claim, createTask, finishTask, getTask, startTask } from "../src/build/tasks.ts";
import { handleMcp, type McpEnv } from "../src/dash/mcp/index.ts";
import { RateLimiter } from "../src/dash/server/util.ts";
import type { Role } from "../src/dash/types.ts";
import { SCRATCH } from "./scratch.ts";
import { OPERATOR, world, type World } from "./world-db.ts";

process.env.AUTOCRAFT_ARTIFACT_DIR = join(SCRATCH, "artifacts");

const MAIN = "a".repeat(40);
const OLD = "b".repeat(40);
let current: World | null = null;
afterEach(() => current?.close());

async function fresh(): Promise<World> {
  const w = current = await (await world()).repo();
  for (const [sha, at] of [[OLD, "2026-01-01T00:00:00Z"], [MAIN, "2026-01-02T00:00:00Z"]] as const) {
    await w.db.run(w.db.k.insertInto("main_ci").values({ repo: "app", head_sha: sha, branch: "main", state: "green", failing: "[]", checks: "[]", committed_at: at, first_seen_at: at, state_changed_at: at, updated_at: at }));
  }
  return w;
}

const envOf = (w: World, role: Role): McpEnv => ({
  db: w.db, baseUrl: null, limiter: new RateLimiter(60, 3600_000), canAnswer: false, expensive: () => 0,
  user: async () => ({ login: role === "operator" ? OPERATOR : "someone", role, canWrite: async () => true, canRead: async () => true }),
});

let id = 0;
const rpc = async (env: McpEnv, method: string, params?: Record<string, unknown>): Promise<any> => (await handleMcp(env, { jsonrpc: "2.0", id: ++id, method, ...(params ? { params } : {}) }))!.result;
async function call(env: McpEnv, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const r = await rpc(env, "tools/call", { name, arguments: args });
  return { text: r.content[0].text as string, isError: r.isError === true };
}
const buildId = (text: string): number => Number(/Queued build (\d+)/.exec(text)![1]);
const CAPS = { os: "linux", arch: "x86_64", cpus: 8, memGb: 32, diskGb: 200, display: false, gpu: false, toolchains: ["rust-stable"] };

test("only operators are offered and allowed the build tools", async () => {
  const w = await fresh();
  const tools = ["build_base", "start_build", "build_status", "cancel_build"];
  const listed = async (env: McpEnv) => (await rpc(env, "tools/list")).tools.map((t: { name: string }) => t.name).filter((n: string) => tools.includes(n));
  assert.deepEqual(await listed(envOf(w, "operator")), tools);
  for (const role of ["maintainer", "viewer"] as const) {
    const env = envOf(w, role);
    assert.deepEqual(await listed(env), [], role);
    const r = await call(env, "start_build", { repo: "app", base: MAIN, steps: ["cargo test"] });
    assert.equal(r.isError, true, role);
    assert.match(r.text, /only operators/);
  }
  assert.equal((await w.db.prepare("SELECT COUNT(*) AS n FROM build_tasks").get() as { n: number }).n, 0);
});

test("a build starts from a recorded default-branch commit only", async () => {
  const w = await fresh();
  const op = envOf(w, "operator");
  assert.match((await call(op, "build_base", { repo: "app" })).text, new RegExp(MAIN));
  const stranger = await call(op, "start_build", { repo: "app", base: "c".repeat(40), steps: ["cargo test"] });
  assert.equal(stranger.isError, true);
  assert.match(stranger.text, new RegExp(`the current one is ${MAIN}`));
  for (const base of [MAIN, OLD]) {
    const r = await call(op, "start_build", { repo: "app", base, patch: "diff --git a/x b/x\n", steps: ["cargo test"] });
    assert.equal(r.isError, false, r.text);
    const t = (await getTask(w.db, buildId(r.text)))!;
    assert.equal(t.headSha, base);
    assert.equal(t.baseSha, base, "the CI gate is read at the default-branch commit, never at the caller's tree");
  }
});

test("no confidential or warm-signing environment takes a build; a plain one does, also for a repo out of the pipeline's scope", async () => {
  const w = await fresh();
  await w.db.prepare("UPDATE tracked_repos SET pipeline = 0 WHERE name = 'app'").run();
  for (const e of ["vault", "signer", "plain"]) await createEnv(w.db, { id: e, label: e, kind: "local-sandbox", slots: 2, ...(e === "vault" && { confidential: true }) }, OPERATOR);
  await hello(w.db, "vault", { version: "1", capabilities: CAPS, slots: 2 });
  await hello(w.db, "signer", { version: "1", capabilities: { ...CAPS, warmSigner: true }, slots: 2 });
  await hello(w.db, "plain", { version: "1", capabilities: CAPS, slots: 2 });
  const r = await call(envOf(w, "operator"), "start_build", { repo: "app", base: MAIN, steps: ["cargo test"] });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual((await claim(w.db, "vault", 2)).tasks, []);
  assert.deepEqual((await claim(w.db, "signer", 2)).tasks, []);
  assert.deepEqual((await claim(w.db, "plain", 2)).tasks.map((t) => t.id), [buildId(r.text)]);
});

test("the status reports a failed line from its own exit code, though the task's steps all succeeded", async () => {
  const w = await fresh();
  const op = envOf(w, "operator");
  await createEnv(w.db, { id: "plain", label: "plain", kind: "local-sandbox", slots: 2 }, OPERATOR);
  await hello(w.db, "plain", { version: "1", capabilities: CAPS, slots: 2 });
  const id = buildId((await call(op, "start_build", { repo: "app", base: MAIN, steps: ["cargo test -p a", "cargo clippy"] })).text);
  await claim(w.db, "plain", 2);
  await startTask(w.db, "plain", id);
  assert.match((await call(op, "build_status", { id })).text, /still running/);
  for (const [name, code] of [["step-1.exit", "0\n"], ["step-2.exit", "101\n"]] as const) {
    const tmp = tempPath(id);
    writeFileSync(tmp, code);
    await storeArtifact(w.db, id, name, tmp);
  }
  const ok = { exitCode: 0, durationMs: 1000, timedOut: false };
  await finishTask(w.db, "plain", id, { results: [{ step: "fetch deps", ...ok }, { step: "step 1", ...ok }, { step: "step 2", ...ok }], summary: "" });
  const s = await call(op, "build_status", { id });
  assert.match(s.text, /did not pass/);
  assert.match(s.text, /1\. ok \(exit 0\)/);
  assert.match(s.text, /2\. failed \(exit 101\)/);
});

test("the build tools reach no other build task", async () => {
  const w = await fresh();
  const op = envOf(w, "operator");
  const other = await createTask(w.db, { step: "nightly", repo: "app", headSha: MAIN, baseSha: MAIN, plan: [{ name: "x", cmd: ["true"], network: "none", timeoutSec: 60 }] });
  for (const name of ["build_status", "cancel_build"]) {
    const r = await call(op, name, { id: other });
    assert.equal(r.isError, true, name);
  }
  assert.equal((await getTask(w.db, other))!.state, "queued");
});
