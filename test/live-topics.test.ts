// Live topics registered per module (src/trigger-sources.ts): every topic has sources on tables the schema has, writes bump the
// topics they should and only those.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { TOPICS, liveTriggers } from "../src/db/live.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { SCRATCH } from "./scratch.ts";
import { sqliteOnly } from "./test-db.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "live-topics-"));

test("every live topic has triggers, and every trigger names a table of the schema", { skip: sqliteOnly("reads the SQLite schema") }, async () => {
  const db = await connectDb(join(dir, "topics.db"));
  const tables = new Set((await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).map((r) => String(r.name)));
  const triggers = liveTriggers();
  for (const t of TOPICS) assert.ok(triggers.some((x) => x.topic === t), `topic ${t} has no trigger`);
  for (const x of triggers) assert.ok(tables.has(x.table), `${x.topic} names ${x.table}, which is not a table`);
});

test("a page setting bumps the settings topic, bookkeeping and the classification run do not; the run moves the planner's topics", { skip: sqliteOnly("reads the SQLite counters") }, async () => {
  const db = await connectDb(join(dir, "bump.db"));
  const moved = async (write: () => Promise<unknown>) => {
    const before = await db.seqs();
    await write();
    const after = await db.seqs();
    return Object.keys(after).filter((t) => after[t] !== before[t]).sort();
  };
  const T = "2026-01-01T00:00:00Z";
  assert.deepEqual(await moved(() => db.run(db.k.insertInto("settings").values({ key: "runner_heartbeat", value: T }))), []);
  assert.deepEqual(await moved(() => db.run(db.k.insertInto("settings").values({ key: "github_identity", value: "app" }))), ["settings"]);
  assert.deepEqual(await moved(() => db.run(db.k.insertInto("repo_step_approvals").values({ repo: "app", step: "merge", by: "op", at: T }))), ["settings"]);
  assert.deepEqual(await moved(() => db.run(db.k.insertInto("classify_state").values({ kind: "current_run", repo: "", number: 0, value: "run-1", at: T }))), ["rank-inputs", "steps"]);
  assert.deepEqual(await moved(() => db.run(db.k.insertInto("classify_state").values({ kind: "jev_failed", repo: "app", number: 1, value: "h", at: T }))), ["plan-inputs"], "it ends the item's prioritize hold; no page reads it");
  const event = { repo: "app", number: 1, login: "op", via: "cli", at: T };
  assert.deepEqual(await moved(() => db.run(db.k.insertInto("workflow_events").values({ ...event, kind: "answered" }))), ["trace", "workflow-events"]);
  assert.deepEqual(await moved(() => db.run(db.k.insertInto("workflow_events").values({ ...event, kind: "archived" }))), [], "the archive is history");
});
