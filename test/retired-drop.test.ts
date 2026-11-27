// The removal of the retired tables, columns and settings rows (off in this release): on a database an older release wrote and
// the switch moved, it archives what is left, drops everything and leaves a database that works.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connectDb, type Db } from "./helpers/raw-db.ts";
import { dropRetired } from "../src/db/retired.ts";
import { DROP_RETIRED, RETIRED_COLUMNS, RETIRED_TABLES } from "../src/db/retired-names.ts";
import { switchOver } from "../src/db/switch-over.ts";
import { TEST_PG_URL } from "./test-db.ts";

const columns = async (db: Db, table: string): Promise<string[]> => (await db.prepare(db.dialect === "postgres"
  ? "SELECT attname AS name FROM pg_attribute WHERE attrelid = to_regclass(CAST(? AS TEXT)) AND attnum > 0 AND NOT attisdropped"
  : "SELECT name FROM pragma_table_info(?)").all(table)).map((r) => r.name as string);

/** The database's URL on Postgres: the migration opens a connection of its own. */
async function targetOf(db: Db): Promise<string | undefined> {
  if (db.dialect !== "postgres") return undefined;
  const u = new URL(TEST_PG_URL!);
  u.pathname = `/${(await db.prepare("SELECT current_database() AS d").get())!.d as string}`;
  return u.toString();
}

test("the removal is off in this release, and drops everything retired once it is on", async () => {
  const db = await connectDb(":memory:");
  const target = await targetOf(db);
  assert.equal(DROP_RETIRED, false);
  await db.prepare("INSERT INTO main.decisions (id, kind, repo, number, question, options, asked_at, answer, answered_at) VALUES ('d', 'merge', 'photocraft', 1, 'Q?', '[]', 'a', 'take', 'b')").run();
  await db.prepare("INSERT INTO main.dupe_groups (decision_id, id, repo, source) VALUES ('g', 'g', 'photocraft', 'model')").run();
  await db.prepare("INSERT INTO main.dupe_group_items (decision_id, group_id, repo, number, kind, role, base_role) VALUES ('g', 'g', 'photocraft', 1, 'pr', 'keep', 'keep')").run();
  await db.prepare("INSERT INTO main.discord_alert_msgs (decision_id, user_hash, sent_at) VALUES ('old', 'u', 'x')").run();
  await db.prepare("INSERT INTO main.settings (key, value) VALUES ('merge_approved:photocraft', '{}'), ('maintainer_writes', 'on'), ('pipeline_login', 'me')").run();
  await db.prepare("INSERT INTO main.user_settings (login, key, value, updated_at) VALUES ('a', 'task_items', 'fast', 'x')").run();

  assert.deepEqual(await dropRetired(db, { target }), [], "off");
  assert.deepEqual(await dropRetired(db, { target, force: true }), [], "not before the switch");
  await switchOver(db);
  // An answer an older dashboard stored after the switch.
  await db.prepare("INSERT INTO main.decisions (id, kind, repo, number, question, options, asked_at, answer, answered_at) VALUES ('e', 'merge', 'photocraft', 1, 'Late?', '[]', 'a', 'take', 'b')").run();
  const dropped = new Set(await dropRetired(db, { target, force: true }));

  for (const t of RETIRED_TABLES) {
    assert.ok(dropped.has(t), t);
    assert.deepEqual(await columns(db, t), [], t);
  }
  for (const [t, c] of RETIRED_COLUMNS) {
    const have = await columns(db, t);
    assert.ok(have.length && !have.includes(c), `${t}.${c}`);
  }
  assert.deepEqual((await db.prepare("SELECT line FROM main.workflow_events WHERE kind = 'archived' ORDER BY line").all()).map((r) => r.line), ["Late? Answer: take.", "Q? Answer: take."]);
  assert.deepEqual((await db.prepare("SELECT key FROM main.settings WHERE key IN ('merge_approved:photocraft', 'maintainer_writes', 'pipeline_login')").all()).map((r) => r.key), ["pipeline_login"]);

  assert.equal((await db.prepare("SELECT value FROM main.user_settings WHERE key = 'task_items'").get())!.value, "started");

  // The surviving tables keep their rows and take writes, their triggers included, under their new keys.
  assert.equal((await db.prepare("SELECT count(*) AS n FROM main.dupe_group_items WHERE group_id = 'g'").get())!.n, 1);
  await db.prepare("INSERT INTO main.dupe_groups (id, repo, source) VALUES ('h', 'photocraft', 'model')").run();
  await db.prepare("INSERT INTO main.discord_alert_msgs (user_hash, workflow_id, rec_at, sent_at) VALUES ('u', 1, 'r', 'x')").run();
  await db.prepare("INSERT INTO main.items (repo, number, kind, state) VALUES ('photocraft', 5, 'pr', 'OPEN')").run();
  await db.prepare("UPDATE main.items SET state = 'CLOSED' WHERE repo = 'photocraft' AND number = 5").run();
  await db.prepare("UPDATE main.tracked_repos SET pipeline = 1 WHERE name = 'photocraft'").run();
  await db.prepare("INSERT INTO main.mcp_tokens (login, token_hash, label, created_at, expires_at) VALUES ('a', 'h', 'l', 'x', 'y')").run();

  assert.deepEqual(await dropRetired(db, { target, force: true }), [], "nothing is left");
  assert.equal(await switchOver(db), null, "the switch stays done");
  await db.close();
});
