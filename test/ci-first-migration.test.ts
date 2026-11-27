// Opening a database made before CI-first Verify and batches settles the `tests` verifications of repos with CI,
// cancels their tasks, raises stored batch sizes to the starting size, and does this once.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { sqliteOnly } from "./test-db.ts";

const { connect } = await import("../src/db.ts");

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "ci-first-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("queued tests verifications become ci-enough where the repo has CI, and small batch sizes are raised", { skip: sqliteOnly("SQLite data migration in src/db.ts migrate(); Postgres starts from schema.pg.sql and a copy of a migrated SQLite database") }, async () => {
  const path = join(dir, "m.db");
  const db = await connectDb(path);
  const at = "2026-01-01T00:00:00Z";
  const check = db.prepare("INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, fetched_at) VALUES (?, 1, 'h', 'OPEN', 0, ?, '[]', ?)");
  await check.run("withci", "success", at);
  await check.run("noci", "none", at);
  const task = db.prepare("INSERT INTO build_tasks (step, repo, head_sha, requires, plan, state, queued_at) VALUES ('verify', ?, 'h', '{}', '[]', 'queued', ?) RETURNING id");
  const ver = db.prepare("INSERT INTO verifications (repo, number, head_sha, kind, reason, state, head_task_id, created_at) VALUES (?, ?, 'h', ?, 'r', ?, ?, ?)");
  const ids = new Map<string, number>();
  for (const repo of ["withci", "noci"]) ids.set(repo, Number((await task.get(repo, at) as { id: number }).id));
  await ver.run("withci", 1, "tests", "planned", ids.get("withci")!, at);
  await ver.run("withci", 2, "regression", "planned", null, at);
  await ver.run("noci", 1, "tests", "planned", ids.get("noci")!, at);
  await db.prepare("INSERT INTO settings (key, value) VALUES ('batch_size:app', '3'), ('batch_size:big', '35')").run();
  await db.prepare("DELETE FROM settings WHERE key = 'ci_first_done'").run();
  await db.close();

  for (let i = 0; i < 2; i++) {
    const again = await connectDb(path);
    const state = async (repo: string, n: number) => (await again.prepare("SELECT kind, state, head_task_id FROM verifications WHERE repo = ? AND number = ?").get(repo, n) as { kind: string; state: string; head_task_id: number | null });
    assert.deepEqual({ ...await state("withci", 1) }, { kind: "ci-enough", state: "ci-enough", head_task_id: null });
    assert.equal((await state("withci", 2)).state, "planned");
    assert.equal((await state("noci", 1)).state, "planned");
    const taskState = async (id: number) => (await again.prepare("SELECT state FROM build_tasks WHERE id = ?").get(id) as { state: string }).state;
    assert.equal(await taskState(ids.get("withci")!), "cancelled");
    assert.equal(await taskState(ids.get("noci")!), "queued");
    // A size chosen after the migration (a failed batch halves it) stays.
    // The migration raises the stored `batch_size:<repo>` values; an unset repo starts at 20.
    const batchSizeOf = async (repo: string) => Number((await again.prepare("SELECT value FROM settings WHERE key = ?").get(`batch_size:${repo}`) as { value: string } | undefined)?.value ?? 20);
    assert.deepEqual([await batchSizeOf("app"), await batchSizeOf("big"), await batchSizeOf("unset")], [i === 0 ? 20 : 4, 35, 20]);
    await again.prepare("UPDATE settings SET value = '4' WHERE key = 'batch_size:app'").run();
    await again.close();
  }
});
