// A Postgres database an earlier release made and wrote, upgraded as the runner does at its start: the schema migration with the
// state copy, then the switch to the maintainer workflow. The earlier schema is test/fixtures/pg-upgrade.sql.gz
// (scripts/gen-pg-upgrade-fixture.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { Db } from "./helpers/raw-db.ts";
import { loadPg } from "../src/db/open.ts";
import { PG_SCHEMA_GENERATION } from "../src/db/pg-generation.ts";
import { STATE_COPY_DONE } from "../src/db/state-copy.ts";
import { switchOver } from "../src/db/switch-over.ts";
import { DEFAULT_PER_DAY } from "../src/runner/autopilot.ts";
import { needsPg, testDatabase } from "./test-db.ts";

const AT = "2026-11-20T00:00:00.000Z", LATER = "2026-11-20T01:00:00.000Z";
type Cell = string | number | null;

/** Rows an earlier release wrote, by table. */
const SEED: [table: string, rows: Record<string, Cell>[]][] = [
  ["tracked_repos", [{ name: "demo", workflow: "legacy" }, { name: "pilot", workflow: "new" }]],
  ["items", ([[1, "issue"], [2, "pr"], [3, "pr"], [4, "pr"], [5, "issue"], [6, "pr"]] as const).map(([number, kind]) => ({
    repo: "demo", number, kind, state: "OPEN", title: `t${number}`, head_oid: kind === "pr" ? `h${number}` : null, updated_at: AT, jev_failed_hash: number === 5 ? "j" : null,
  }))],
  ["decisions", [
    { id: "merge:2", kind: "merge", repo: "demo", number: 2, question: "Merge?", options: '[{"key":"take","label":"Take it"}]', asked_at: AT, answer: "take", answered_by: "alice", answered_at: LATER },
    { id: "hold:3", kind: "hold", repo: "demo", number: 3, question: "Hold?", options: "[]", asked_at: AT },
    { id: "scope:5", kind: "scope", repo: "demo", number: 5, question: "Scope?", options: "[]", asked_at: AT, answer: "backlog", answered_by: "carol", answered_at: LATER },
  ]],
  ["actions", [{ decision_id: "merge:2", repo: "demo", number: 2, kind: "comment-close", state: "done", created_at: LATER }]],
  ["fast_track", [{ repo: "demo", number: 1, added_by: "dave", added_at: AT, weight: 8 }, { repo: "demo", number: 4, added_by: "dave", added_at: AT, weight: 5 }]],
  // Two active legs of PR 2, which the earlier schema allowed, and a stopped one of PR 6's running workflow.
  ["preapprovals", [
    { id: 1, repo: "demo", number: 2, by: "bob", at: AT, instructions: "", state: "review", from_head: "h2", head: "h2", updated_at: AT },
    { id: 2, repo: "demo", number: 2, by: "erin", at: LATER, instructions: "", state: "queued", from_head: "h2", head: "h2", updated_at: LATER },
    { id: 3, repo: "demo", number: 6, by: "erin", at: AT, instructions: "", state: "asked", from_head: "h6", head: "h6", reason: "CI failed", updated_at: LATER, workflow_id: 7 },
  ]],
  ["item_workflows", [{ id: 7, repo: "demo", number: 6, kind: "pr", entry: "review", state: "running", started_by: "erin", started_at: AT, started_via: "github", approved_by: "erin", approved_at: AT, updated_at: AT }]],
  ["agent_runs", [{ id: 1, step: "review", stage: 1, prompt_id: "p", prompt_version: "1", provider: "claude", model: "m", state: "done", started_at: AT }]],
  ["agent_run_items", [{ run_id: 1, repo: "demo", number: 3 }]],
  ["dupe_groups", [{ decision_id: "demo:dupegroup:3", repo: "demo", source: "model" }]],
  ["dupe_group_items", [{ decision_id: "demo:dupegroup:3", repo: "demo", number: 3, kind: "pr", role: "keep", base_role: "keep" }]],
  ["discord_alert_msgs", [{ decision_id: `wf:7:${AT}`, user_hash: "u", sent_at: AT }]],
  ["merge_batches", [{ id: 1, repo: "demo", branch: "b", state: "done", base_sha: "s", commit_sha: "c", created_at: AT, updated_at: AT }]],
  ["merge_batch_prs", [{ batch_id: 1, number: 3, head_oid: "h3", position: 0 }]],
  ["mcp_tokens", [{ id: 1, login: "alice", token_hash: "x", label: "l", created_at: AT, expires_at: LATER, idle_claim_at: 5, machine: "box" }]],
  ["remote_helpers", [{ token_id: 1, login: "alice", readiness: "ready", harness: "h", models: "[]", reserve: "{}", reported_at: 1 }]],
  ["remote_calls", [{ step: "review", stage: 1, prompt_id: "p", prompt_version: "1", tier: "opus", effort: "medium", asked_model: "m", bundle: "{}", state: "queued", items: '[{"repo":"demo","number":4}]', since: 1, seen_at: 1, max_attempts: 1, timeout_ms: 1 }]],
  ["user_settings", [{ login: "alice", key: "task_items", value: "fast", updated_at: AT }]],
  ["settings", [
    { key: "runner_heartbeat", value: LATER }, { key: "pipeline_fp:review|demo", value: '{"fp":"f","job":3}' }, { key: "merge_approved:demo", value: JSON.stringify({ by: "op", at: AT }) },
    { key: "limit_reset_at:merge", value: AT }, { key: "review_stale:demo#3", value: AT }, { key: "batch_size:demo", value: "4" }, { key: "org_high_water", value: AT },
  ]],
];

/** Everything the migration makes, one line per object. */
const CATALOG = `SELECT 'column ' || table_schema || '.' || table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' || COALESCE(collation_name, '') AS o
    FROM information_schema.columns WHERE table_schema IN ('public', 'scoped')
  UNION ALL SELECT 'index ' || indexdef FROM pg_indexes WHERE schemaname = 'public'
  UNION ALL SELECT 'trigger ' || pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal
  UNION ALL SELECT 'function ' || oid::regprocedure || ' ' || md5(prosrc) || ' ' || COALESCE(array_to_string(proconfig, ','), '') FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'ac\\_%'`;
const catalog = async (db: Db): Promise<string[]> => (await db.prepare(CATALOG).all()).map((r) => r.o as string).sort();

const TABLES = [...SEED.map(([t]) => t), "workflow_events", "repo_step_approvals", "lane_state", "review_state", "classify_state", "stage_limits", "merge_repo_state", "sync_state", "remote_call_items", "audit", "item_plans"];
const snapshot = async (db: Db): Promise<Record<string, string[]>> => {
  const out: Record<string, string[]> = {};
  for (const t of TABLES) out[t] = (await db.prepare(`SELECT * FROM main.${t}`).all()).map((r) => JSON.stringify(r)).sort();
  return out;
};

test("a database of an earlier release comes to the current schema and switches once", { skip: needsPg }, async () => {
  const t = await testDatabase("", "postgres", { empty: true });
  const fresh = await testDatabase("", "postgres", { empty: true });
  try {
    const pg = new (await loadPg()).Client({ connectionString: t.target });
    await pg.connect();
    try {
      await pg.query(gunzipSync(readFileSync(new URL("fixtures/pg-upgrade.sql.gz", import.meta.url))).toString());
      assert.ok(Number((await pg.query("SELECT value FROM settings WHERE key = 'schema_generation'")).rows[0].value) < PG_SCHEMA_GENERATION.generation);
      await pg.query("DELETE FROM tracked_repos");
      for (const [table, rows] of SEED) {
        for (const r of rows) {
          await pg.query(`INSERT INTO ${table} (${Object.keys(r).join(", ")}) VALUES (${Object.keys(r).map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(r));
        }
        // Rows given an id leave the identity behind it, as none of the release's own writes did.
        if (rows.some((r) => "id" in r && typeof r.id === "number")) await pg.query(`SELECT setval(pg_get_serial_sequence($1, 'id'), 100)`, [table]);
      }
    } finally {
      await pg.end();
    }

    const db = await t.open({ app: true });
    const have = new Set(await catalog(db));
    const want = new Set(await catalog(await fresh.open({ app: true })));
    assert.deepEqual([...want].filter((o) => !have.has(o)), [], "everything a new database has");
    assert.deepEqual([...have].filter((o) => o.startsWith("trigger ") && !want.has(o)), [], "no trigger of the earlier release");
    const r = (await switchOver(db, { perDay: DEFAULT_PER_DAY }))!;

    const rows = async (text: string): Promise<Record<string, unknown>[]> => (await db.prepare(text).all()).map((x) => ({ ...x }));
    const one = async (text: string): Promise<unknown> => Object.values((await rows(text))[0] ?? {})[0];
    assert.equal(Number(await one("SELECT value FROM main.settings WHERE key = 'schema_generation'")), PG_SCHEMA_GENERATION.generation);
    assert.ok(await one(`SELECT value FROM main.settings WHERE key = '${STATE_COPY_DONE}'`));
    // The state copy and the columns it fills.
    assert.deepEqual(await rows("SELECT step, repo, value, job_id FROM main.lane_state WHERE kind = 'fp'"), [{ step: "review", repo: "demo", value: "f", job_id: 3 }]);
    assert.deepEqual(await rows("SELECT repo, step, by FROM main.repo_step_approvals"), [{ repo: "demo", step: "merge", by: "op" }]);
    assert.equal(await one("SELECT reset_at FROM main.stage_limits WHERE step = 'merge'"), AT);
    assert.equal(await one("SELECT stale_at FROM main.review_state WHERE number = 3"), AT);
    assert.equal(await one("SELECT batch_size FROM main.merge_repo_state WHERE repo = 'demo'"), 4);
    assert.equal(await one("SELECT org_high_water FROM main.sync_state"), AT);
    assert.equal(await one("SELECT value FROM main.classify_state WHERE kind = 'jev_failed' AND number = 5"), "j");
    assert.equal(await one("SELECT first_number FROM main.agent_runs WHERE id = 1"), 3);
    assert.equal(await one("SELECT group_id FROM main.dupe_group_items"), "demo:dupegroup:3");
    assert.equal(await one("SELECT workflow_id FROM main.discord_alert_msgs"), 7);
    assert.equal(await one("SELECT repo FROM main.merge_batch_prs"), "demo");
    assert.equal(await one("SELECT machine FROM main.remote_helpers"), "box");
    assert.equal(await one("SELECT number FROM main.remote_call_items"), 4);
    // The switch.
    assert.deepEqual(r.archived, { answered: 2, withdrawn: 1, actions: 1, withoutItem: 0 });
    assert.deepEqual(await rows("SELECT DISTINCT workflow FROM main.tracked_repos"), [{ workflow: "new" }]);
    assert.deepEqual(await rows("SELECT number, kind, entry, weight, state, started_by, approved_by FROM main.item_workflows ORDER BY number"), [
      { number: 1, kind: "issue", entry: "implement", weight: 8, state: "running", started_by: "dave", approved_by: null },
      { number: 2, kind: "pr", entry: "merge", weight: 5, state: "running", started_by: "erin", approved_by: "erin" },
      { number: 4, kind: "pr", entry: "review", weight: 5, state: "running", started_by: "dave", approved_by: null },
      { number: 5, kind: "issue", entry: "implement", weight: 5, state: "backlog", started_by: "carol", approved_by: null },
      { number: 6, kind: "pr", entry: "review", weight: 5, state: "running", started_by: "erin", approved_by: "erin" },
    ]);
    assert.deepEqual(await rows("SELECT id, state FROM main.preapprovals ORDER BY id"), [{ id: 1, state: "cancelled" }, { id: 2, state: "queued" }, { id: 3, state: "cancelled" }], "the newest active leg goes on");

    // A second start: nothing to migrate, nothing to switch.
    const after = await snapshot(db);
    const again = await t.open({ app: true });
    assert.equal(await switchOver(again, { perDay: DEFAULT_PER_DAY }), null);
    assert.deepEqual(await snapshot(again), after);
    assert.deepEqual(new Set(await catalog(again)), have);
  } finally {
    await t.close();
    await fresh.close();
  }
});
