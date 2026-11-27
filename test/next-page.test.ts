// The Next page lists a step's items in the order the autopilot's selection takes them, and says why a step cannot run.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { plannedItems } from "../src/core/select-items.ts";
import { nextPage } from "../src/dash/api/next.ts";
import { detectAutopilot, INPUT_TOPICS, LANE_KINDS, LANES, NO_ITEM_LANES, setEnabled, setLimit } from "../src/runner/autopilot.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { excluded } from "../src/db/kx.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "next-page-"));
const T0 = "2026-01-01T00:00:00Z";

describe("Next page", async () => {
  const db = await connectDb(join(dir, "t.db"));
  await db.run(db.k.insertInto("tracked_repos").values([{ name: "app", pipeline: 1 }, { name: "secret", pipeline: 1 }]));
  const add = (repo: string, number: number, title: string) => db.run(db.k.insertInto("items").values({ repo, number, kind: "issue", state: "OPEN", title, body: "b", is_draft: 0, created_at: T0, updated_at: T0 }));
  for (const n of [3, 1, 2]) await add("app", n, `issue ${n}`);
  await add("secret", 9, "hidden");
  await setEnabled(db, true, "op");

  test("a lane lists its items in the planner's order, without hidden repos", async () => {
    await detectAutopilot(db);
    const want = (await plannedItems(db, "embed")).filter((p) => p.facts.repo === "app").map((p) => p.facts.number);
    assert.equal(want.length, 3);
    const page = await nextPage(db, ["app"]);
    const embed = page.steps.find((s) => s.lane === "embed")!;
    assert.deepEqual(embed.items.map((i) => i.number), want);
    assert.deepEqual([embed.canRun, embed.kind], [true, "ok"]);
    assert.equal(embed.items[0]!.title, `issue ${want[0]}`);
  });

  test("a step with a zero daily limit says so", async () => {
    await setLimit(db, "embed", { perDay: 0 }, "op");
    const embed = (await nextPage(db, ["app"])).steps.find((s) => s.lane === "embed")!;
    assert.deepEqual([embed.canRun, embed.kind], [false, "limit"]);
    assert.equal(embed.why, "The daily limit is 0");
  });

  test("storing the lists is not planner input", async () => {
    const seqs = async () => await db.all(db.k.selectFrom("change_seq").select(["topic", "seq"]));
    const before = await seqs();
    await db.run(db.k.insertInto("lane_next").values({ lane: "x", total: 0, items: "[]", at: "now" })
      .onConflict((oc) => oc.column("lane").doUpdateSet(excluded(["total", "items", "at"]))));
    await db.run(db.k.deleteFrom("lane_next").where("lane", "=", "x"));
    const moved = (await seqs()).filter((s) => s.seq !== (before.find((b) => b.topic === s.topic)?.seq ?? 0)).map((s) => s.topic);
    assert.deepEqual(moved.filter((t) => INPUT_TOPICS.includes(t as never)), [], "lane_next must sit under an excluded topic");
    assert.ok(moved.includes("plans"));
  });

  test("every lane lists its items or is declared without any", () => {
    const missing = LANES.map((l) => l.name).filter((n) => !LANE_KINDS[n] && !NO_ITEM_LANES.includes(n));
    assert.deepEqual(missing, [], "add the lane to LANE_KINDS or NO_ITEM_LANES");
    assert.deepEqual(NO_ITEM_LANES.filter((n) => LANE_KINDS[n] || !LANES.some((l) => l.name === n)), []);
  });
});
