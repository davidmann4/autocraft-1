// A classify job asks an item's due priority and area questions in the item's one Jev request, and stores their answers as the
// prioritize step and the area pass would: the item is then no longer due for either. Jev is faked (setRunner).
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setRunner } from "../src/classify/run.ts";
import { classifyNew } from "../src/runner/classify.ts";
import { editAreas } from "../src/areas/store.ts";
import { plannedItems } from "../src/core/select-items.ts";
import type { StepContext } from "../src/runner/steps.ts";
import { world, type World } from "./world-db.ts";

let current: World | null = null;
afterEach(() => current?.close());

const jobCtx = (w: World): StepContext => ({
  db: w.db, job: { id: 1, requestedBy: "pipeline", startedAt: new Date().toISOString(), resumes: 0 }, params: { limit: 50 },
  progress: async () => {}, log: () => {}, usageRun: () => {}, handled: () => {}, acted: () => {},
  cancelled: async () => false, stopping: async () => false, timeUp: async () => false,
});

test("one Jev request per item answers its type, priority and area, and the other steps see them done", async () => {
  const w = (current = await (await world()).repo());
  await w.issue(1);
  await w.db.run(w.db.k.insertInto("items").values({ repo: "app", number: 2, kind: "issue", state: "OPEN", title: "Export drops the alpha channel", body: "Saving a PNG loses transparency.", author: "someone", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z" }));
  await editAreas(w.db, "app", { op: "replace", areas: [{ name: "Export", description: "Saving files" }, { name: "Text", description: "Type tools" }] }, null);
  const bodies: string[] = [];
  const restore = setRunner(async (_cmd, _args, stdin) => {
    bodies.push(stdin);
    const answers = {
      type: { choice: "bugfix", probabilities: { bugfix: 0.97 } }, security: { noul: 0.01 }, needs_decision: { noul: 0.02 },
      impact: { choice: "P1", probabilities: { P1: 0.95 } }, area: { choice: "Export", probabilities: { Export: 0.96 } },
    };
    return { code: 0, stderr: "", stdout: JSON.stringify({ answers, usage: { input_tokens: 900, output_tokens: 3 } }) };
  });
  const ctx = jobCtx(w);
  try { await classifyNew(ctx); } finally { restore(); }
  const asked = bodies.map((b) => JSON.parse(b) as { state: string; questions: Record<string, unknown> }).filter((b) => b.state.includes("app#2"));
  assert.equal(asked.length, 1, "one request for the new item");
  assert.ok("impact" in asked[0]!.questions && "area" in asked[0]!.questions, "it carries the impact and area questions");
  const prio = await w.db.get(w.db.k.selectFrom("item_priority").select(["impact", "model"]).where("number", "=", 2));
  assert.deepEqual(prio, { impact: "P1", model: "jev" });
  const area = await w.db.get(w.db.k.selectFrom("item_areas").select(["area", "source"]).where("number", "=", 2));
  assert.deepEqual(area, { area: "Export", source: "jev" });
  assert.ok(!(await plannedItems(w.db, "prioritize")).some((p) => p.facts.number === 2), "prioritize no longer has the item");
});

test("an item Jev gives no valid verdict for is released to the prioritize step", async () => {
  const w = (current = await (await world()).repo());
  await w.issue(1);
  await w.db.run(w.db.k.insertInto("items").values({ repo: "app", number: 2, kind: "issue", state: "OPEN", title: "Export drops the alpha channel", body: "Saving a PNG loses transparency.", author: "someone", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z" }));
  const held = async () => !(await plannedItems(w.db, "prioritize")).some((p) => p.facts.number === 2);
  assert.ok(await held(), "held while its classify request is due");
  const restore = setRunner(async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ answers: { type: { choice: "not a label" } }, usage: { input_tokens: 9, output_tokens: 0 } }) }));
  try { await classifyNew(jobCtx(w)); } catch { /* no item answered: the job fails */ } finally { restore(); }
  assert.ok(!await held(), "prioritize has the item after the failed request");
});
