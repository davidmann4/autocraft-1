// `db copy` between SQLite and Postgres: a round trip keeps every row, rowid, counter and packed text, and verify catches
// a changed row. Runs only against a server (AUTOCRAFT_TEST_PG_URL; `pnpm test:pg` starts one).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { connect } from "../src/db.ts";
import { copyDatabase, RUNTIME_TABLES, verifyDatabases } from "../src/db/copy.ts";
import { SCRATCH } from "./scratch.ts";
import { needsPg, testDatabase } from "./test-db.ts";

const quiet = (l: string) => void (process.env.COPY_LOG && console.log(l));

test("a SQLite database copied to Postgres and back verifies equal; a changed row fails verify", { skip: needsPg }, async () => {
  const file = join(SCRATCH, "copy-src.db");
  const s = connect(file);
  s.exec(`INSERT INTO items (repo, number, kind, state, title, body) VALUES ('a/b', 1, 'pr', 'OPEN', 'Fix the parser', 'It crashed on "quotes"'), ('a/b', 2, 'issue', 'CLOSED', 'Crash', NULL);
    INSERT INTO stages (repo, number, stage, at) VALUES ('a/b', 1, 'reviewed', '2026-01-01T00:00:00Z'), ('a/b', 1, 'take', '2026-01-02T00:00:00Z');
    DELETE FROM stages WHERE stage = 'reviewed';
    INSERT INTO decisions (id, kind, items, question, options, asked_at) VALUES ('d1', 'merge', '[{"repo":"a/b","number":1},{"repo":"a/b","number":2}]', 'Merge?', '[]', '2026-01-03T00:00:00Z');
    INSERT INTO jobs (step, params, requested_by, requested_at, state, repo) VALUES ('sync', '{}', 'cli', 'x', 'done', 'c/d');
    DELETE FROM ever_tracked_repos WHERE name = 'c/d';
    INSERT INTO agent_runs (id, step, stage, prompt_id, prompt_version, provider, model, state, started_at) VALUES (7, 's', 1, 'p', '1', 'claude', 'm', 'done', 'x'), (9, 's', 1, 'p', '1', 'claude', 'm', 'done', 'x');
    DELETE FROM agent_runs WHERE id = 9;
    CREATE TABLE retired_feature (x INTEGER);
    -- The stamp row written last, its old rowid taken by another setting (as in a database migrated many times): the
    -- target's own stamp row must not collide with the copied rowids.
    CREATE TEMP TABLE old_stamp AS SELECT rowid AS r, value FROM settings WHERE key = 'schema_stamp';
    DELETE FROM settings WHERE key = 'schema_stamp';
    INSERT INTO settings (rowid, key, value) SELECT r, 'in_old_stamp_slot', '1' FROM old_stamp;
    INSERT INTO settings (key, value) SELECT 'schema_stamp', value FROM old_stamp;`);
  // A prompt stored as plain text (before texts were gzipped) and one already packed.
  s.prepare("INSERT INTO agent_run_texts (run_id, prompt, output) VALUES (7, ?, ?)").run("plain prompt", gzipSync("packed output"));
  s.prepare("INSERT INTO item_embeddings (repo, number, model, hash, vec, at) VALUES ('a/b', 1, 'm', 'h', ?, 'x')").run(new Uint8Array([1, 2, 3, 255]));
  s.close();

  const pg = await testDatabase("", "postgres", { empty: true });
  const back = join(SCRATCH, "copy-back.db");
  try {
    // A table of a retired feature that SQLite kept: refused unless left out on purpose.
    await assert.rejects(copyDatabase({ from: file, to: pg.target, log: quiet }), /schemas differ/);
    const there = await copyDatabase({ from: file, to: pg.target, verify: true, skipExtra: true, batch: 1, log: quiet });
    assert.ok(there.verify?.ok, "SQLite → Postgres verifies");
    await assert.rejects(copyDatabase({ from: file, to: pg.target, skipExtra: true, log: quiet }), /not empty/);

    const home = await copyDatabase({ from: pg.target, to: back, verify: true, log: quiet });
    assert.ok(home.verify?.ok, "Postgres → SQLite verifies");
    // Postgres has no runtime tables yet (change log, live counters), so only those may differ after the round trip.
    const round = await verifyDatabases(file, back, { skipExtra: true, log: quiet });
    assert.deepEqual(round.tables.filter((t) => !t.ok && !RUNTIME_TABLES.has(t.table)), [], "the round trip equals the original");
    assert.deepEqual(round.sequences.filter((t) => !RUNTIME_TABLES.has(t.table)), []);
    // The SQLite target keeps its own schema stamp (the copy never carries one over), so opening it migrates nothing.
    const stamp = (f: string) => { const d = new DatabaseSync(f, { readOnly: true }); try { return d.prepare("SELECT value FROM settings WHERE key = 'schema_stamp'").get()?.value; } finally { d.close(); } };
    assert.equal(stamp(back), stamp(file));
    const b = connect(back);
    const hits = b.prepare("SELECT count(*) AS n FROM items_fts WHERE items_fts MATCH 'parser'").get() as { n: number };
    b.close();
    assert.equal(hits.n, 1, "the search index was rebuilt");

    const db = await pg.open();
    // Copied rows fired no triggers (verify saw ever_tracked_repos without c/d); the triggers work after the copy.
    await db.prepare("INSERT INTO decisions (id, kind, items, question, options, asked_at) VALUES ('d2', 'merge', '[{\"repo\":\"e/f\",\"number\":3}]', 'Merge?', '[]', 'x')").run();
    assert.ok(await db.prepare("SELECT 1 FROM decision_items WHERE decision_id = 'd2'").get());
    await db.prepare("DELETE FROM decisions WHERE id = 'd2'").run();
    // Keys continue past the source's counter, not just past the copied rows.
    const next = (await db.prepare("INSERT INTO agent_runs (step, stage, prompt_id, prompt_version, provider, model, state, started_at) VALUES ('s', 1, 'p', '1', 'claude', 'm', 'done', 'x') RETURNING id").get()) as { id: number };
    assert.ok(next.id > 9, `next agent_runs id ${next.id} is past the deleted 9`);
    await db.prepare("DELETE FROM agent_runs WHERE id = ?").run(next.id);

    await db.prepare("UPDATE items SET body = 'changed' WHERE number = 1").run();
    const after = await verifyDatabases(file, pg.target, { skipExtra: true, log: quiet });
    assert.equal(after.ok, false);
    // The writes above also moved the live counters and the change log, which the runtime triggers keep on Postgres.
    assert.deepEqual(after.tables.filter((t) => !t.ok && !RUNTIME_TABLES.has(t.table)).map((t) => t.table), ["items"]);
  } finally {
    await pg.close();
  }
});
