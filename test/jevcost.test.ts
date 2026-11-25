import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { askJev, runJev, saveUsage, setRunner } from "../src/classify/run.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "../src/db/open.ts";
import { sqliteOnly } from "./test-db.ts";

const answers = {
  type: { choice: "performance", confidence: 0.8, probabilities: { performance: 0.8, bugfix: 0.2 } },
  security: { noul: 0.7 }, needs_decision: { noul: 0.1 },
};
const fresh = async () => await connectDb(join(mkdtempSync(join(SCRATCH, "jevcost-")), "t.db"));
const cost = async (db: Awaited<ReturnType<typeof fresh>>, agent: string) =>
  (await db.get(db.k.selectFrom("token_usage").select("cost_usd as c").where("agent", "=", agent)))!.c;

test("a Jev call is priced by its input tokens", async () => {
  const db = await fresh();
  const restore = setRunner(async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ answers, usage: { input_tokens: 1_000_000, output_tokens: 500 } }) }));
  try {
    const item = { repo: "a", number: 1, kind: "pr" as const, title: "t", body: "b", lines_changed: 1, files_changed: 1, author_association: null };
    await runJev(db, "run1", [item], 1);
  } finally { restore(); }
  assert.ok(Math.abs((await cost(db, "jev-a#1"))! - 0.042) < 1e-9);
});

test("the migration prices unpriced Jev rows and leaves other models alone", { skip: sqliteOnly("SQLite data migration in src/db.ts migrate(); Postgres starts from schema.pg.sql and a copy of a migrated SQLite database") }, async () => {
  const dir = mkdtempSync(join(SCRATCH, "jevcost-"));
  const path = join(dir, "t.db");
  const db = await connectDb(path);
  const u = { input: 2_000_000, output: 5, cacheRead: 0, cacheWrite: 0, cost: null };
  await saveUsage(db, "r", "jev-x", "classify", "jev-latest", 1, u, "s", "e");
  await saveUsage(db, "r", "haiku-x", "classify", "haiku", 1, u, "s", "e");
  await db.close();
  const again = await connectDb(path);
  assert.ok(Math.abs((await cost(again, "jev-x"))! - 0.084) < 1e-9);
  assert.equal(await cost(again, "haiku-x"), null);
});

test("priority and dupes Jev calls are saved under their own stage", async () => {
  const db = await fresh();
  const restore = setRunner(async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ answers: {}, usage: { input_tokens: 500_000, output_tokens: 3 } }) }));
  try {
    const item = { repo: "a", number: 1, kind: "pr" as const, title: "t", body: "b", lines_changed: 1, files_changed: 1, author_association: null };
    await askJev("priority.jev", item, db);
  } finally { restore(); }
  const row = (await db.get(db.k.selectFrom("token_usage").select(["stage", "model", "cost_usd as c"])))!;
  assert.equal(row.stage, "priority");
  assert.equal(row.model, "jev-latest");
  assert.ok(Math.abs(row.c! - 0.021) < 1e-9);
});

test("runJev saves a chunk's verdicts and usage together, with the input hash", async () => {
  const db = await fresh();
  const restore = setRunner(async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ answers, usage: { input_tokens: 10, output_tokens: 1 } }) }));
  try {
    const items = [1, 2, 3].map((number) => ({ repo: "a", number, kind: "pr" as const, title: "t", body: "b", lines_changed: 1, files_changed: 1, author_association: null }));
    const { saved } = await runJev(db, "run1", items, 3, new Map([["a#1", "h1"], ["a#3", "h3"]]));
    assert.deepEqual([...saved].sort(), ["a#1", "a#2", "a#3"]);
  } finally { restore(); }
  const rows = await db.all(db.k.selectFrom("classifications").select(["number", "input_hash"]).orderBy("number"));
  assert.deepEqual(rows.map((r) => r.input_hash), ["h1", null, "h3"]);
  assert.equal((await db.all(db.k.selectFrom("token_usage").select("agent"))).length, 3);
});

test("a classify request that also asks the impact and area questions splits its usage over the three steps", async () => {
  const db = await fresh();
  const bodies: string[] = [];
  const restore = setRunner(async (_cmd: string, _args: string[], stdin: string) => {
    bodies.push(stdin);
    return { code: 0, stderr: "", stdout: JSON.stringify({ answers: { ...answers, impact: { choice: "P2", probabilities: { P2: 0.95 } }, area: { choice: "Export", probabilities: { Export: 0.6 } } }, usage: { input_tokens: 1001, output_tokens: 7 } }) };
  });
  let r: Awaited<ReturnType<typeof runJev>>;
  try {
    const item = { repo: "a", number: 1, kind: "issue" as const, title: "t", body: "b", lines_changed: null, files_changed: null, author_association: null };
    r = await runJev(db, "run1", [item], 1, undefined, new Map([["a#1", { impact: true, areas: [{ name: "Export", description: "Saving files" }] }]]));
  } finally { restore(); }
  assert.equal(bodies.length, 1, "one request for the item");
  assert.equal(r.impact.get("a#1")?.impact, "P2", "the impact answer is returned for priority to settle");
  const rows = await db.all(db.k.selectFrom("token_usage").select(["stage", "input_tokens as i", "output_tokens as o"]));
  assert.deepEqual(rows.map((x) => x.stage).sort(), ["areas", "classify", "priority"]);
  assert.ok(rows.every((x) => (x.i ?? 0) > 0), "every step pays a share");
  assert.equal(rows.reduce((n, x) => n + (x.i ?? 0), 0), 1001, "the shares add up to the call");
  assert.equal(rows.reduce((n, x) => n + (x.o ?? 0), 0), 7);
});
