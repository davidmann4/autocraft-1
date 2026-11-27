import assert from "node:assert/strict";
import { test } from "node:test";
import { connectDb } from "./helpers/raw-db.ts";
import { rankOfItem, runRank } from "../src/rank/index.ts";

test("rank writes every open item past one statement's worth of rows, reads the settled label, drops closed items and rewrites nothing unchanged", async () => {
  const db = await connectDb(":memory:");
  const T0 = "2026-11-01T00:00:00.000Z";
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app" }));
  await db.run(db.k.insertInto("settings").values({ key: "classify_run", value: "r1" }));
  const open = 620;
  const items = Array.from({ length: open }, (_, i) => ({ repo: "app", number: i + 1, kind: "issue", state: "OPEN", title: `t${i + 1}` }));
  for (let i = 0; i < items.length; i += 200) await db.run(db.k.insertInto("items").values(items.slice(i, i + 200)));
  await db.run(db.k.insertInto("items").values({ repo: "app", number: 999, kind: "issue", state: "CLOSED", title: "gone" }));
  await db.run(db.k.insertInto("item_rank").values({ repo: "app", number: 999, score: 1, breakdown: "{}", computed_at: T0 }));
  await db.run(db.k.insertInto("classifications").values({ repo: "app", number: 7, classifier: "jev", run_id: "r1", at: T0, type_label: "bugfix", flags: '["security"]', probs: '{"top":0.95}' }));

  const first = await runRank(db);
  assert.deepEqual(first, { items: open, changed: open, removed: 1 });
  assert.equal(await rankOfItem(db, "app", 999), null);
  const labelled = (await rankOfItem(db, "app", 7))!, plain = (await rankOfItem(db, "app", 8))!;
  assert.equal(labelled.breakdown.type, "bugfix");
  assert.ok(labelled.breakdown.security && !plain.breakdown.security);
  assert.notEqual(labelled.score, plain.score);

  assert.deepEqual(await runRank(db), { items: open, changed: 0, removed: 0 });
});
