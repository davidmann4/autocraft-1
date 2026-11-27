// A call shows the progress lines its Task Runner reports while it runs, and the wording of the lines for a tool use.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fakeTaskRunner } from "./fake-runner.ts";
import { SCRATCH } from "./scratch.ts";
import { askClaude, setWorkspace } from "../src/classify/run.ts";
import { eventLines } from "../src/classify/progress.ts";
import { connectDb, type Db } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "stream-"));
process.env.AUTOCRAFT_CHECKOUT_DIR = join(dir, "checkouts");
setWorkspace(async () => []);

async function fresh(): Promise<Db> {
  return await connectDb(join(mkdtempSync(join(dir, "db-")), "t.db"));
}

const tool = (name: string, input: unknown, parent: string | null = null) =>
  JSON.stringify({ type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "tool_use", name, input }] } });
const result = (text: string, usage: number, models?: Record<string, unknown>) =>
  JSON.stringify({ type: "result", subtype: "success", result: text, num_turns: 3, usage: { input_tokens: usage, output_tokens: 1 }, total_cost_usd: 0.5, ...(models && { modelUsage: models }) });

const EVENTS = [
  JSON.stringify({ type: "system", subtype: "init" }),
  tool("Read", { file_path: "/repos/craft-i18n/packs/hu/menu.ftl" }),
  tool("Agent", { description: "Find the Hungarian pack", subagent_type: "explorer", prompt: "secret prompt text" }),
  tool("Grep", { pattern: "spellcheck", path: "/repo/src" }, "toolu_1"),
  tool("mcp__items__item", { repo: "photocraft", number: 1562 }),
  tool("mcp__items__search_items", { query: "hungarian dictionary" }),
  tool("mcp__items__pr_diff", { repo: "photocraft", number: 1562 }),
  tool("Glob", { pattern: "**/*.ftl" }),
  result("first", 1),
  result("[]", 7, { "claude-opus-4": { inputTokens: 7, outputTokens: 1, costUSD: 0.4 }, "claude-haiku-4": { inputTokens: 100, outputTokens: 5, costUSD: 0.1 } }),
];

describe("a call's progress", () => {
  const ask = (db: Db) => askClaude("conversation.turn", "opus", [{ ref: "app#1", item: "{}", turns: "" }], db, { checkout: dir });

  test("the run shows the helper's latest progress line until the call ends, and the answer is its reply", async () => {
    const db = await fresh();
    const lines = EVENTS.flatMap((e) => eventLines(JSON.parse(e)));
    let running: string | null | undefined;
    const runner = await fakeTaskRunner(db, async (_c, beat) => {
      for (const l of lines) { await beat(l); await new Promise((r) => setTimeout(r, 40)); }
      running = (await db.prepare("SELECT progress FROM agent_runs WHERE state = 'running'").get() as { progress: string } | undefined)?.progress;
      return { text: "[]", turns: 3, usage: { inputTokens: 7, outputTokens: 1 } };
    });
    try {
      const r = await ask(db);
      assert.equal(r?.text, "[]");
      assert.equal(r?.usage.input, 7);
    } finally {
      await runner.stop();
    }
    assert.equal(running, lines.at(-1));
    const row = await db.prepare("SELECT state, progress FROM agent_runs").get() as { state: string; progress: string | null };
    assert.equal(row.state, "done");
    assert.equal(row.progress, null);
  });
});


describe("progress lines", () => {
  test("wording, the explorer prefix, cap and plain text", () => {
    const lines = EVENTS.flatMap((e) => eventLines(JSON.parse(e)));
    assert.deepEqual(lines, [
      "Reading craft-i18n/packs/hu/menu.ftl",
      "Asking the explorer: Find the Hungarian pack",
      'Explorer: Searching for "spellcheck" in src',
      "Looking up photocraft#1562",
      'Searching items for "hungarian dictionary"',
      "Reading the diff of photocraft#1562",
      "Listing **/*.ftl",
    ]);
    const [long] = eventLines(JSON.parse(tool("Agent", { description: `x\n\u0007${"y".repeat(500)}` })));
    assert.ok(long!.length <= 120 && !/[\n\u0007]/.test(long!));
    assert.deepEqual(eventLines(JSON.parse(tool("Write", { file_path: "/x", content: "file contents" }))), []);
  });


});
