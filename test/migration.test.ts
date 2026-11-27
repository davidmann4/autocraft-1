// A database made by the first release (test/fixtures/oldest-schema.sql) opens with the current code: tables and columns
// added since appear, dropped columns go, stored rows survive, and opening it again changes nothing.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { tmpdir } from "./world-db.ts";
import { connectDb, type Db } from "./helpers/raw-db.ts";
import { sqliteOnly } from "./test-db.ts";

const cols = async (db: Db, table: string): Promise<string[]> => (await db.prepare(`PRAGMA main.table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

test("the first release's database migrates in place and keeps its rows", { skip: sqliteOnly("migrates a first-release SQLite file") }, async () => {
  const path = join(tmpdir("migration"), "old.db");
  const old = new DatabaseSync(path);
  old.exec(readFileSync(new URL("./fixtures/oldest-schema.sql", import.meta.url), "utf8"));
  old.prepare("INSERT INTO items (repo, number, kind, state, title, body, author, created_at, updated_at) VALUES ('app', 1, 'pr', 'OPEN', 'Fix the crash', 'a body about wombats', 'alice', 'a', 'a')").run();
  old.prepare("INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, topics, area, flags) VALUES ('app', 1, 'haiku', 'r', 'a', 'bugfix', '1', 'ui', '[]')").run();
  old.prepare("INSERT INTO comments (repo, number, id, kind, author, created_at, body) VALUES ('app', 1, 'c1', 'comment', 'bob', 'a', 'looks good')").run();
  old.close();

  const db = await connectDb(path);
  assert.ok((await cols(db, "items")).includes("head_oid"), "items gained the head column");
  assert.ok((await cols(db, "comments")).includes("author_association"));
  assert.ok(!(await cols(db, "classifications")).includes("topics") && !(await cols(db, "classifications")).includes("area"), "dropped columns are gone");
  assert.ok((await cols(db, "tracked_repos")).includes("pipeline"));
  for (const t of ["decisions", "opus_reviews", "verifications", "build_tasks", "jobs"]) assert.ok((await cols(db, t)).length > 0, `${t} exists`);
  assert.equal((await db.prepare("SELECT title FROM items WHERE repo = 'app' AND number = 1").get() as { title: string }).title, "Fix the crash");
  assert.equal((await db.prepare("SELECT type_label FROM classifications WHERE number = 1").get() as { type_label: string }).type_label, "bugfix");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM comments").get() as { n: number }).n, 1);
  const stamp = await db.prepare("SELECT value FROM settings WHERE key = 'schema_stamp'").get();
  assert.ok(stamp, "the migration is stamped");
  await db.close();

  const again = await connectDb(path);
  assert.deepEqual(await again.prepare("SELECT value FROM settings WHERE key = 'schema_stamp'").get(), stamp);
  assert.equal((await again.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n, 1);
  await again.close();
});
