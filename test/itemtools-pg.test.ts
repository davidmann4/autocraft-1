// The item snapshot built from a Postgres app database holds the same rows as the one built from an equivalent SQLite
// database, its full-text index finds an item by a word in its body, and a refresh after changes and deletions gives the
// same file content as a fresh build. Needs Postgres (pnpm test:pg).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Db } from "../src/db/index.ts";
import { writeSnapshot, writeSnapshotFromDb } from "../src/itemtools/snapshot.ts";
import { SCRATCH } from "./scratch.ts";
import { needsPg, testDatabase } from "./test-db.ts";

const vec = (...x: number[]) => new Uint8Array(new Float32Array(x).buffer);

async function fill(db: Db): Promise<void> {
  for (const [name, vis] of [["photocraft", "public"], ["secretcraft", "internal"]]) await db.prepare("INSERT INTO repos (name, visibility) VALUES (?,?)").run(name, vis);
  const item = db.prepare("INSERT INTO items (repo, number, kind, state, title, body, author, labels, is_draft, comments_count, additions) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  await item.run("photocraft", 7, "pr", "OPEN", "Fix kerning", "Adjusts glyph spacing with ligatures", "alice", '["bugfix"]', 1, 2, 30);
  await item.run("photocraft", 8, "issue", "OPEN", "Spacing is off", "Letters touch", "bob", "[]", 0, 0, null);
  await item.run("photocraft", 12, "issue", "CLOSED", "Third", "More", "bob", "[]", 0, 0, null);
  await item.run("secretcraft", 1, "issue", "OPEN", "Internal", "ligature roadmap", "bob", "[]", 0, 0, null);
  const c = db.prepare("INSERT INTO comments (repo, number, id, kind, author, created_at, body, review_state) VALUES (?,?,?,?,?,?,?,?)");
  await c.run("photocraft", 7, "c1", "comment", "carol", "2026-01-01T00:00:00Z", "Reminds me of the regression", null);
  await c.run("photocraft", 7, "c2", "review", "dave", "2026-01-02T00:00:00Z", "Draft review", "PENDING");
  await c.run("photocraft", 7, "c3", "review", "dave", "2026-01-03T00:00:00Z", "Looks fine", "APPROVED");
  const e = db.prepare("INSERT INTO item_embeddings (repo, number, model, hash, vec, at) VALUES (?,?,?,?,?,?)");
  await e.run("photocraft", 7, "m", "h", vec(1, 0), "t");
  await e.run("photocraft", 8, "m", "h", vec(0.9, 0.1), "t");
  await db.prepare(`INSERT INTO decisions (id, kind, repo, number, question, options, asked_at, answer, answered_by, answered_at)
    VALUES ('d1', 'scope', 'photocraft', 7, 'Take it?', '[{"key":"take","label":"Take it"}]', 't', 'take', 'op', '2026-02-01T00:00:00Z')`).run();
}

function dump(file: string): Record<string, unknown[]> {
  const s = new DatabaseSync(file, { readOnly: true });
  const q = (sql: string) => s.prepare(sql).all().map((r) => ({ ...r }));
  const out = {
    items: q("SELECT * FROM items ORDER BY repo, number"),
    comments: q("SELECT * FROM comments ORDER BY id"),
    embeddings: q("SELECT repo, number, model, at, hex(vec) AS vec, typeof(vec) AS t FROM item_embeddings ORDER BY repo, number"),
    outcomes: q("SELECT * FROM decision_outcomes ORDER BY repo, number"),
    schema: q("SELECT value FROM meta WHERE key = 'schema'"),
    found: q("SELECT i.repo, i.number FROM items_fts f JOIN items i ON i.rowid = f.rowid WHERE items_fts MATCH 'ligature'"),
  };
  s.close();
  return out;
}

const srcRows = (file: string) => {
  const s = new DatabaseSync(file, { readOnly: true });
  const out = [s.prepare("SELECT * FROM item_src ORDER BY repo, number").all(), s.prepare("SELECT * FROM comment_src ORDER BY id").all()].map((rs) => rs.map((r) => ({ ...r })));
  s.close();
  return out;
};

test("the snapshot built from Postgres has the rows of the one built from SQLite, and a refresh after changes equals a rebuild", { skip: needsPg }, async () => {
  const pg = await testDatabase("", "postgres");
  const lite = await testDatabase("", "sqlite");
  try {
    const [pdb, sdb] = [await pg.open({ app: true }), await lite.open({ app: true })];
    await fill(pdb);
    await fill(sdb);
    mkdirSync(SCRATCH, { recursive: true });
    const dir = mkdtempSync(join(SCRATCH, "itemtools-pg-"));
    const file = join(dir, "pg", "items.db");
    // A page size below the row count exercises the keyset paging.
    const fromPg = await writeSnapshotFromDb(pdb, file, 2);
    assert.equal(fromPg.rebuilt, true);
    await sdb.close();
    writeSnapshot(lite.file!, join(dir, "sqlite", "items.db"));
    const a = dump(file);
    assert.deepEqual(a, dump(join(dir, "sqlite", "items.db")));
    assert.deepEqual(a.found, [{ repo: "photocraft", number: 7 }]);
    assert.equal(a.comments.length, 2, "the pending review is left out");

    // Nothing written since: the file is left alone.
    const marker = () => (new DatabaseSync(file, { readOnly: true }).prepare("SELECT value FROM meta WHERE key = 'refreshed_at'").get() as { value: string }).value;
    const before = marker();
    await new Promise((r) => setTimeout(r, 5));
    const again = await writeSnapshotFromDb(pdb, file, 2);
    assert.equal(again.rebuilt, false);
    assert.equal(marker(), before);

    // An embed run moves no change counter: only the vectors are compared and rewritten.
    await pdb.prepare("UPDATE item_embeddings SET vec = ?, at = 't1' WHERE repo = 'photocraft' AND number = 8").run(vec(0.5, 0.5));
    assert.deepEqual((await writeSnapshotFromDb(pdb, file, 2)).changed, { items: 0, comments: 0, embeddings: 1 });
    // A decision answered alone rewrites the outcomes.
    await pdb.prepare(`INSERT INTO decisions (id, kind, repo, number, question, options, asked_at, answer, answered_by, answered_at)
      VALUES ('d2', 'scope', 'photocraft', 8, 'Take it?', '[{"key":"backlog","label":"Backlog"}]', 't', 'backlog', 'op', '2026-02-02T00:00:00Z')`).run();
    assert.deepEqual((await writeSnapshotFromDb(pdb, file, 2)).changed, { items: 1, comments: 0, embeddings: 0 });
    assert.ok(dump(file).outcomes.some((o) => (o as { number: number }).number === 8));

    // A changed and a deleted item, comment and vector are applied in place, and the file then equals a fresh build.
    await pdb.prepare("UPDATE items SET title = 'Fix kerning now' WHERE repo = 'photocraft' AND number = 7").run();
    await pdb.prepare("DELETE FROM items WHERE repo = 'photocraft' AND number = 12").run();
    await pdb.prepare("UPDATE comments SET body = 'Reminds me of the old regression' WHERE id = 'c1'").run();
    await pdb.prepare("DELETE FROM comments WHERE id = 'c3'").run();
    await pdb.prepare("UPDATE item_embeddings SET vec = ?, at = 't2' WHERE repo = 'photocraft' AND number = 7").run(vec(0, 1));
    await pdb.prepare("DELETE FROM item_embeddings WHERE repo = 'photocraft' AND number = 8").run();
    const after = await writeSnapshotFromDb(pdb, file, 2);
    assert.equal(after.rebuilt, false);
    assert.notEqual(marker(), before);
    assert.ok(after.changed.items > 0 && after.changed.comments > 0 && after.changed.embeddings > 0);
    const fresh = join(dir, "fresh", "items.db");
    assert.equal((await writeSnapshotFromDb(pdb, fresh, 2)).rebuilt, true);
    assert.deepEqual(dump(file), dump(fresh));
    assert.deepEqual(srcRows(file), srcRows(fresh));
  } finally {
    await pg.close();
    await lite.close();
  }
});
