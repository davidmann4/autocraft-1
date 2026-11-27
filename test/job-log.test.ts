// Job logs stored in the database: the copy keeps the end of a long log within the cap, and the job page reads it when
// the log file is not on this disk (a dashboard that does not share the runner's).
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { copyLogs, JOB_LOG_KEEP_BYTES, JOB_LOG_KEEP_MS, JobLogCopy, pruneJobLogs } from "../src/runner/job-log.ts";
import { jobDetail } from "../src/runner/jobs.ts";

test("a long job log keeps its end within the cap, and the job page reads it without the file", async () => {
  const dir = mkdtempSync(join(SCRATCH, "job-log-"));
  const db = await connectDb(join(dir, "jobs.db"));
  try {
    const path = join(dir, "job.log");
    const t = new Date().toISOString();
    const id = Number((await db.get(db.k.insertInto("jobs").values({ step: "test-echo", params: "{}", requested_by: "boss", requested_at: t, state: "running", started_at: t, log_path: path })
      .returning("id")))!.id);
    const copy = JobLogCopy.open(id, path);
    const line = (i: number) => `line ${i} ${"x".repeat(1000)}\n`;
    let n = 0;
    for (let batch = 0; batch < 20; batch++) {
      for (let i = 0; i < 30; i++) appendFileSync(path, line(n++));
      await copyLogs(db, [copy], true);
    }
    appendFileSync(path, "the last line, unfinished");
    await copyLogs(db, [copy], true);

    const chunks = await db.all(db.k.selectFrom("job_log_chunks").select("chunk").where("job_id", "=", id));
    const stored = chunks.reduce((a, c) => a + Buffer.byteLength(c.chunk), 0);
    assert.ok(n * 1000 > 2 * JOB_LOG_KEEP_BYTES, "the log is longer than the cap");
    assert.ok(stored < 2 * JOB_LOG_KEEP_BYTES, `kept ${stored} bytes`);

    rmSync(path);
    const j = await jobDetail(db, id);
    assert.ok(j.log!.endsWith("the last line, unfinished"), j.log!.slice(-80));
    assert.ok(j.log!.includes(`line ${n - 1} `));
    assert.match(j.log!, /^line \d+ /, "the shown text starts at a whole line");
    assert.equal(j.logTruncated, true);
    // Stored chunks go after 90 days, while the job row stays.
    assert.equal(await pruneJobLogs(db, Date.now()), 0);
    assert.equal(await pruneJobLogs(db, Date.now() + JOB_LOG_KEEP_MS + 60_000), chunks.length);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a log chunk with a NUL byte is copied without it, and the next chunk still starts at the right offset", async () => {
  const dir = mkdtempSync(join(SCRATCH, "job-log-"));
  const db = await connectDb(join(dir, "jobs.db"));
  try {
    const path = join(dir, "job.log");
    const t = new Date().toISOString();
    const id = Number((await db.get(db.k.insertInto("jobs").values({ step: "test-echo", params: "{}", requested_by: "boss", requested_at: t, state: "running", started_at: t, log_path: path })
      .returning("id")))!.id);
    const copy = JobLogCopy.open(id, path);
    appendFileSync(path, "a\u0000b\u0007c\td\n");
    await copyLogs(db, [copy], true);
    appendFileSync(path, "second\n");
    await copyLogs(db, [copy], true);
    const rows = await db.all(db.k.selectFrom("job_log_chunks").select(["chunk", "start", "next_start"]).where("job_id", "=", id).orderBy("seq"));
    assert.equal(rows[0]!.chunk, "abc\td\n");
    assert.equal(Number(rows[1]!.start), Number(rows[0]!.next_start));
    assert.equal(rows[1]!.chunk, "second\n");
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
