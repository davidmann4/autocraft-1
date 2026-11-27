import assert from "node:assert/strict";
import { test } from "node:test";
import { finishRun, getRun, insertRun, pruneRuns, rates, RUN_KEEP_MS, runTools } from "../src/agents/runs.ts";
import { saveTools } from "../src/agents/tools.ts";
import { connectDb, type Db } from "./helpers/raw-db.ts";

const start = async (db: Db) => await insertRun(db, { jobId: null, step: "fixup", stage: 1, promptId: "p", promptVersion: "1", provider: "claude", model: "m", items: [{ repo: "app", number: 1 }], prompt: "the prompt" });
const use = (id: string, name: string, input: unknown) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string, content: unknown, is_error = false) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] } });

test("tool uses of a call are stored with result sizes, scrubbed arguments and the check row they ran", async () => {
  const db = await connectDb(":memory:");
  const run = await start(db);
  const check = (await db.get(db.k.insertInto("model_checks").values({ run_id: run, step: "fixup", repo: "app", number: 1, head: "h", command: "clippy", started_at: "t" }).returning("id")))!.id;
  await saveTools(db, run, [
    use("a", "Read", { file_path: "/repo/x.rs" }), result("a", "héllo"),
    use("b", "mcp__build__check", { command: "fmt", patch: "p" }), result("b", [{ type: "text", text: "refused" }], true),
    use("c", "mcp__build__check", { command: "clippy", patch: "x".repeat(10_000) }), result("c", "0 findings"),
  ]);
  const tools = await runTools(db, run);
  assert.deepEqual(tools.map((t) => [t.seq, t.tool, t.resultBytes, t.isError, t.check?.id ?? null]), [[1, "Read", 6, false, null], [2, "mcp__build__check", 7, true, null], [3, "mcp__build__check", 10, false, check]]);
  assert.ok(tools[2]!.args!.length <= 4000);
  assert.equal(tools[2]!.check?.command, "clippy");
});

test("texts past 14 days are kept compressed and read back; old plain rows still read", async () => {
  const db = await connectDb(":memory:");
  const run = await start(db);
  await finishRun(db, run, { state: "done", output: "the output", costUsd: 0.25 });
  const old = await start(db);
  // Plain rows exist only in SQLite files from before compression (the copy to Postgres compresses them; bytea there).
  const plain = db.dialect === "sqlite";
  if (plain) await db.run(db.k.updateTable("agent_run_texts").set({ prompt: "plain prompt" }).where("run_id", "=", old));
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  await db.run(db.k.updateTable("agent_runs").set({ started_at: ago(20) }));
  await pruneRuns(db);
  const d = await getRun(db, run);
  assert.equal(d.prompt, "the prompt");
  assert.equal(d.output, "the output");
  assert.equal(d.costUsd, 0.25);
  assert.equal((await getRun(db, old)).prompt, plain ? "plain prompt" : "the prompt");
  await db.run(db.k.updateTable("agent_runs").set({ started_at: ago(RUN_KEEP_MS / 86_400_000 + 1) }));
  await pruneRuns(db);
  assert.equal((await db.get(db.k.selectFrom("agent_run_texts").select((eb) => eb.fn.countAll<number>().as("n"))))!.n, 0);
});

test("a check use that wrote no row does not take the row of a later use of the same command", async () => {
  const db = await connectDb(":memory:");
  const run = await start(db);
  const check = (await db.get(db.k.insertInto("model_checks").values({ run_id: run, step: "fixup", repo: "app", number: 1, head: "h", command: "fmt", started_at: "t" }).returning("id")))!.id;
  await saveTools(db, run, [
    use("a", "mcp__build__check", { command: "fmt", patch: "p" }), result("a", "rustfmt: the patch changes no .rs file; nothing to format"),
    use("b", "mcp__build__check", { command: "fmt", patch: "q" }), result("b", "ok"),
  ]);
  assert.deepEqual((await runTools(db, run)).map((t) => t.check?.id ?? null), [null, check]);
});

test("viewers without text access get tools without arguments", async () => {
  const db = await connectDb(":memory:");
  const run = await start(db);
  await saveTools(db, run, [use("a", "Read", { file_path: "/repo/secret.rs" }), result("a", "x")]);
  const t = (await getRun(db, run, { texts: false })).tools;
  assert.deepEqual([t[0]!.tool, t[0]!.args, t[0]!.resultBytes], ["Read", null, 1]);
  assert.match((await getRun(db, run)).tools[0]!.args!, /secret/);
});

test("rates count runs in the UTC hour or day their ISO start time falls in", async () => {
  const db = await connectDb(":memory:");
  const times = ["2026-11-21T14:05:30.123Z", "2026-11-21T00:00:00.000Z", "2026-11-20T23:59:59.999Z", "2026-11-18T07:00:00Z"];
  for (const t of times) await db.run(db.k.updateTable("agent_runs").set({ started_at: t }).where("id", "=", await start(db)));
  const now = Date.parse("2026-11-21T15:30:00Z");
  const counts = async (window: "24h" | "7d") => Object.fromEntries((await rates(db, window, now)).stages.find((s) => s.step === "fixup")!.buckets.filter((b) => b.runs).map((b) => [b.t, b.runs]));
  const hours = { "2026-11-20T23:00:00.000Z": 1, "2026-11-21T00:00:00.000Z": 1, "2026-11-21T14:00:00.000Z": 1 };
  const days = { "2026-11-18T00:00:00.000Z": 1, "2026-11-20T00:00:00.000Z": 1, "2026-11-21T00:00:00.000Z": 2 };
  assert.deepEqual(await counts("24h"), hours);
  assert.deepEqual(await counts("7d"), days);
  if (db.dialect === "sqlite") {
    // The buckets SQLite's strftime gives for the same times.
    const strftime = async (fmt: string, t: string) => (await db.prepare("SELECT strftime(?, ?) AS t").get(fmt, t) as { t: string }).t;
    for (const t of times.slice(0, 3)) assert.ok(await strftime("%Y-%m-%dT%H:00:00.000Z", t) in hours, t);
    for (const t of times) assert.ok(await strftime("%Y-%m-%dT00:00:00.000Z", t) in days, t);
  }
});
