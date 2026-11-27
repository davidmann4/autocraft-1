import { test } from "node:test";
import assert from "node:assert/strict";
import { connectDb } from "./helpers/raw-db.ts";
import { SHADOWED_TABLES } from "../src/repos.ts";

test("a scoped handle sees tracked repos only and writes through main. to every repo", async () => {
  const db = await connectDb(":memory:");
  try {
    await db.run(db.k.insertInto("tracked_repos").values({ name: "app", pipeline: 1 }));
    const item = db.prepare("INSERT INTO main.items (repo, number, kind, state, title, updated_at) VALUES (?, ?, 'issue', 'OPEN', 't', '2026-01-01')");
    await item.run("app", 1);
    await item.run("other", 2);
    const batch = db.prepare("INSERT INTO main.decisions (id, kind, repo, number, items, question, options, asked_at) VALUES (?, 'merge', NULL, NULL, ?, 'q', '[]', '2026-01-01')");
    await batch.run("b-app", JSON.stringify([{ repo: "app", number: 1 }]));
    await batch.run("b-mixed", JSON.stringify([{ repo: "app", number: 1 }, { repo: "other", number: 2 }]));
    await db.scope();

    const repos = async (sql: string) => (await db.prepare(sql).all() as { repo: string }[]).map((r) => r.repo).sort();
    assert.deepEqual(await repos("SELECT repo FROM items"), ["app"]);
    assert.deepEqual(await repos("SELECT repo FROM main.items"), ["app", "other"]);
    assert.deepEqual((await db.prepare("SELECT id FROM decisions ORDER BY id").all()).map((r) => r.id), ["b-app"], "a batch with an untracked item is hidden");

    await item.run("other", 3);
    assert.deepEqual(await repos("SELECT repo FROM main.items WHERE number = 3"), ["other"]);
    assert.deepEqual(await repos("SELECT repo FROM items WHERE number = 3"), []);
    await db.run(db.k.insertInto("main.tracked_repos").values({ name: "other", pipeline: 0 }));
    assert.deepEqual(await repos("SELECT repo FROM items"), ["app", "other", "other"]);

    if (db.dialect === "postgres") {
      const views = (await db.prepare("SELECT table_name AS t FROM information_schema.views WHERE table_schema = 'scoped' ORDER BY 1").all()).map((r) => r.t);
      assert.deepEqual(views, [...SHADOWED_TABLES].sort(), "the Postgres views are the tables SQLite shadows");
    }
  } finally {
    await db.close();
  }
});
