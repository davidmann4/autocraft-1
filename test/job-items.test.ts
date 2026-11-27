// Records that attach to an item: the items a job handled, and the job that queued a build task.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { setCallContext } from "../src/agents/call.ts";
import { createTask } from "../src/build/tasks.ts";
import { itemJobs, jobItem } from "../src/runner/job-items.ts";
import { flushJobItems } from "../src/data/jobs/index.ts";
import { JOB_KEEP_MS, pruneJobs } from "../src/runner/jobs.ts";
import { SCRATCH } from "./scratch.ts";
import { world } from "./world-db.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });
const db = await connectDb(join(mkdtempSync(join(SCRATCH, "job-items-")), "t.db"));
after(() => setCallContext(null));

test("a job records the items it handled, tags their log lines, and stamps the build tasks it queues", async () => {
  const job = (await db.get(db.k.insertInto("jobs").values({ step: "fixup", params: "{}", requested_by: "cli", requested_at: "t", state: "done", ended_at: "2020-01-01T00:00:00Z" }).returning("id")))!.id;
  const lines: string[] = [];
  await jobItem(db, "o/app", 7, "outside a job", (l) => lines.push(l));
  assert.deepEqual(await itemJobs(db, "o/app", 7), [], "nothing is stored outside a job");

  setCallContext({ jobId: job, step: "fixup", stage: 6, cancelled: async () => false });
  await jobItem(db, "o/app", 7, "pushed\nabc", (l) => lines.push(l));
  await jobItem(db, "o/app", 8, "held", (l) => lines.push(l));
  assert.deepEqual(lines, ["[o/app#7] outside a job", "[o/app#7] pushed abc", "[o/app#8] held"]);
  await flushJobItems(db, job);
  assert.deepEqual((await itemJobs(db, "o/app", 7)).map((r) => [r.jobId, r.outcome]), [[job, "pushed abc"]]);

  const sha = "a".repeat(40);
  const id = await createTask(db, { step: "verify", repo: "app", number: 7, headSha: sha, plan: [{ name: "t", cmd: ["true"], network: "none", timeoutSec: 10 }] });
  assert.equal((await db.get(db.k.selectFrom("build_tasks").select("job_id").where("id", "=", id)))!.job_id, job);

  await pruneJobs(db, Date.parse("2020-01-02T00:00:00Z") + JOB_KEEP_MS);
  assert.deepEqual(await itemJobs(db, "o/app", 7), [], "a pruned job takes its item rows");
});
