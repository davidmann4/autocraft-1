import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPg } from "../src/db/open.ts";
import { LOCK_TIMEOUT_MS, planDdl, withMigrationLock } from "../src/db/pg-migrate.ts";
import { migratePg, pgStamp } from "../src/db/pg-triggers.ts";
import { needsPg, testDatabase } from "./test-db.ts";

function fakeClient() {
  const log: string[] = [];
  return {
    log,
    query: async (text: string) => {
      log.push(text.split(/[ (;]/)[0]!);
      return { rows: /pg_try_advisory_lock/.test(text) ? [{ ok: true }] : [] };
    },
  };
}
const pgError = (code: string) => Object.assign(new Error("pg"), { code });

test("a lock timeout rolls the step back and retries it until it commits; other errors throw at once", async () => {
  const c = fakeClient();
  const lines: string[] = [];
  let calls = 0;
  await withMigrationLock(c, (m) => m.step({ label: "triggers: items", table: "items", run: async () => {
    if (++calls < 3) throw pgError("55P03");
  } }), { sleep: async () => {}, log: (l) => void lines.push(l) });
  assert.equal(calls, 3);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /lock on items/);
  assert.ok(c.log.indexOf("ROLLBACK") < c.log.lastIndexOf("COMMIT"));
  calls = 0;
  await assert.rejects(withMigrationLock(c, (m) => m.step({ label: "x", run: async () => { calls++; throw pgError("42P01"); } }), { sleep: async () => {} }), { code: "42P01" });
  assert.equal(calls, 1);
});

test("lock retries stop once the migration window has passed", async () => {
  let t = 0;
  let calls = 0;
  await assert.rejects(withMigrationLock(fakeClient(), (m) => m.step({ label: "x", run: async () => { calls++; throw pgError("55P03"); } }), {
    sleep: async (ms) => void (t += ms), now: () => t, windowMs: 60_000, log: () => {},
  }), /within the window/);
  assert.ok(calls > 5);
  assert.ok(t >= 60_000);
});

test("statements that would change nothing are skipped, and a new index on a serving table is built concurrently", () => {
  const sql = `-- a comment with an apostrophe: it's
CREATE TABLE IF NOT EXISTS items (repo text, body text DEFAULT 'a;b');
ALTER TABLE items ADD COLUMN IF NOT EXISTS body text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS added text;
CREATE INDEX IF NOT EXISTS items_repo ON items(repo);
CREATE INDEX IF NOT EXISTS items_added ON items(added);
CREATE OR REPLACE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
CREATE OR REPLACE TRIGGER t AFTER INSERT ON items FOR EACH ROW EXECUTE FUNCTION f();
CREATE TABLE IF NOT EXISTS fresh (x text);
CREATE INDEX IF NOT EXISTS fresh_x ON fresh(x);`;
  const cat = { tables: new Set(["items"]), columns: new Set(["items.repo", "items.body"]), indexes: new Map([["items_repo", true]]) };
  const steps = planDdl(sql, cat, new Set(["items"]), "schema");
  assert.ok(!/CREATE TABLE IF NOT EXISTS items|COLUMN IF NOT EXISTS body|items_repo/.test(JSON.stringify(steps)));
  assert.ok(steps.some((s) => "create" in s && /CONCURRENTLY/.test(s.create) && s.index === "items_added"));
  // The trigger joins the function's step; the new table and its index (no rows yet, so not concurrent) make another.
  const fresh = steps.find((s) => "sql" in s && s.sql?.some((q) => /fresh_x/.test(q)));
  assert.ok(fresh && "sql" in fresh && fresh.table === "fresh" && !fresh.sql!.some((q) => /ON items/.test(q)));
  assert.ok(steps.some((s) => "sql" in s && s.table === "items" && s.sql!.some((q) => /search_path/.test(q))));
});

test("a migration that must drop a trigger under a long read holds other writers back only briefly, and finishes after the read", { skip: needsPg, timeout: 60_000 }, async () => {
  const t = await testDatabase();
  const pg = await loadPg();
  const client = async (app: string) => {
    const c = new pg.Client({ connectionString: t.target, application_name: app });
    await c.connect();
    return c;
  };
  const [reader, writer, migrator] = [await client("test-reader"), await client("test-writer"), await client("test-migrate")];
  try {
    await t.open({ app: true });
    // A stale stamp and a trigger whose registry entry is gone: the migration needs ACCESS EXCLUSIVE on items to drop it.
    await writer.query("UPDATE settings SET value = 'stale' WHERE key = 'schema_stamp'");
    await writer.query("CREATE TRIGGER ac_items_gone AFTER INSERT ON items FOR EACH ROW EXECUTE FUNCTION ac_trg_items_i()");
    await reader.query("BEGIN");
    await reader.query("SELECT count(*) FROM items");
    const lines: string[] = [];
    let done = false;
    const migration = migratePg(migrator, { log: (l) => void lines.push(l) }).finally(() => (done = true));
    let worst = 0;
    for (const end = Date.now() + 5000; Date.now() < end;) {
      const at = Date.now();
      await writer.query("UPDATE items SET title = title WHERE false");
      worst = Math.max(worst, Date.now() - at);
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(!done, "the migration waits for the read");
    assert.ok(worst < LOCK_TIMEOUT_MS + 1000, `a write waited ${worst} ms`);
    assert.ok(lines.some((l) => /lock on items/.test(l) && /test-reader/.test(l)), lines.join("\n"));
    await reader.query("COMMIT");
    await migration;
    const gone = await writer.query("SELECT 1 FROM pg_trigger WHERE tgname = 'ac_items_gone'");
    assert.equal(gone.rows.length, 0);
    assert.equal((await writer.query("SELECT value FROM settings WHERE key = 'schema_stamp'")).rows[0]?.value, pgStamp());
  } finally {
    await Promise.all([reader.end(), writer.end(), migrator.end()]);
    await t.close();
  }
});
