// A user-local call's prompt is rendered with marked harness phrases (src/prompts/harness.ts). Filled for `claude`
// it must be the server's text byte for byte, apart from the reference sentence, which names the reference tools
// instead of the /reference mount; filled for `codex` it must not name a Claude tool.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fillHarness } from "../src/prompts/harness.ts";
import { CLAUDE_PROMPTS, EXAMPLES, REFERENCE_NOTE, REFERENCE_TOOLS_NOTE, TASK_BUDGET_CLAUDE, claudeArgs, claudeParts, joinParts, withoutRepoDir, type ClaudePromptId } from "../src/prompts/index.ts";
import { forHarness } from "../src/remote/calls.ts";
import { agentsDefinition, MCP_PATH } from "../src/sandbox/agents.ts";
import type { TaskBundle } from "../src/remote/protocol.ts";

const BUNDLE: Omit<TaskBundle, "callId"> = { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "high", timeoutSeconds: 60, maxTurns: 20, stdin: "", system: null, mounts: [], mcpServers: [], keepSession: false, hints: {} };

/** Every way a call of each prompt is rendered: without a checkout, and sandboxed with the reference and docs flags. */
function cases(): { name: string; id: ClaudePromptId; input: never; sandboxed: boolean; reference: boolean }[] {
  const out: ReturnType<typeof cases> = [];
  for (const id of Object.keys(CLAUDE_PROMPTS) as ClaudePromptId[]) {
    const p = CLAUDE_PROMPTS[id], base = EXAMPLES[id].input as unknown as object[];
    out.push({ name: `${id} without tools`, id, input: withoutRepoDir(base) as never, sandboxed: false, reference: false });
    if (!p.sandbox) continue;
    for (const reference of p.sandbox.reference ? [false, true] : [false])
      for (const docs of p.sandbox.docs ? [false, true] : [false])
        out.push({ name: `${id} sandboxed${reference ? ", reference" : ""}${docs ? ", docs" : ""}`, id, sandboxed: true, reference, input: base.map((x) => ({ ...x, ...(reference && { reference: true }), ...(docs && { repo_docs: true }) })) as never });
  }
  return out;
}

test("user-local prompts read as the server's for claude and name no Claude tool for codex", () => {
  let referenced = 0;
  for (const c of cases()) {
    const server = joinParts(claudeParts(c.id, c.input, c.sandboxed));
    const remote = claudeParts(c.id, c.input, c.sandboxed, true);
    const claude = joinParts({ system: remote.system === null ? null : fillHarness(remote.system, "claude"), stdin: fillHarness(remote.stdin, "claude") });
    if (c.reference) {
      assert.ok(server.includes(REFERENCE_NOTE), c.name);
      referenced++;
    }
    assert.equal(claude, c.reference ? server.replace(REFERENCE_NOTE, REFERENCE_TOOLS_NOTE) : server, c.name);
    const codex = fillHarness(joinParts(remote), "codex");
    assert.doesNotMatch(codex, /\bGrep\b|\bGlob\b|with Read\b|workspace-search|subagent_type|\u0001/, c.name);
  }
  assert.ok(referenced > 0);
});

test("a helper's path root moves only the marked sandbox paths and the path arguments; item data and other arguments stay", () => {
  const root = "/private/var/folders/ab/c_d0/C/autocraft-runner/slot-1";
  const planted = "/repo/PLANTED and /repos/x and /mcp.json";
  let paths = 0, seen = 0;
  for (const c of cases()) {
    const input = (c.input as unknown as Record<string, unknown>[]).map((x) => ("title" in x ? { ...x, title: planted } : x)) as never;
    const remote = claudeParts(c.id, input, c.sandboxed, true);
    const bundle = { ...BUNDLE, stdin: remote.stdin, system: remote.system };
    const plain = forHarness(bundle, "claude"), rooted = forHarness(bundle, "claude", root);
    assert.deepEqual(forHarness(bundle, "claude", ""), plain, c.name);
    // Taking the root back out gives the root-less text: the root was only inserted, and only before a fixed path.
    const all = joinParts(rooted);
    assert.equal(all.split(root).join(""), joinParts(plain), c.name);
    assert.ok(all.split(root).slice(1).every((x) => /^\/(repo-docs|repos|repo|agents\.json|mcp\.json)(?![\w-])/.test(x)), c.name);
    if (all.includes("PLANTED")) { assert.ok(all.includes(planted), `${c.name}: item data unchanged`); seen++; }
    paths += all.split(root).length - 1;
  }
  assert.ok(paths > 0 && seen > 0);

  const args = claudeArgs("review.opus", "opus", true, { config: MCP_PATH, servers: ["items"] }, null, false, true, true);
  const agents = JSON.stringify(agentsDefinition(["items"]));
  const b = { ...BUNDLE, hints: { claude: { args, agents } } };
  // A Claude Code that takes every flag the arguments carry (the task budget included).
  assert.deepEqual(forHarness(b, "claude", "", TASK_BUDGET_CLAUDE), b);
  const h = forHarness(b, "claude", root, TASK_BUDGET_CLAUDE).hints.claude!;
  const value = (flag: string) => h.args.flatMap((a, i) => (h.args[i - 1] === flag ? [a] : []));
  assert.deepEqual(value("--add-dir"), [`${root}/repo`, `${root}/repos`, `${root}/repo-docs`]);
  assert.deepEqual(value("--mcp-config"), [`${root}/mcp.json`]);
  assert.deepEqual(value("--agents"), [`${root}/agents.json`]);
  assert.deepEqual(value("--allowedTools")[0]!.split(",").filter((t) => t.startsWith("Read(")), [`Read(/${root}/repo/**)`, `Read(/${root}/repos/**)`, `Read(/${root}/repo-docs/**)`]);
  assert.deepEqual(value("--disallowedTools"), args.flatMap((a, i) => (args[i - 1] === "--disallowedTools" ? [a] : [])));
  assert.equal(h.args.filter((a, i) => a !== args[i]).length, 6);
  assert.ok(h.agents!.includes(`Search ${root}/repo (`) && h.agents!.includes(`${root}/repos/*`));
  assert.equal(h.agents!.split(root).join(""), agents);
});
