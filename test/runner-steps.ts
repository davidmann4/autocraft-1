// Fake pipeline steps for the runner and API tests (AUTOCRAFT_EXTRA_STEPS).
// They call no model and touch nothing outside the test database.
import { setTimeout as sleep } from "node:timers/promises";
import { queryDb } from "../src/db/query-db.ts";
import type { StepDef } from "../src/runner/steps.ts";

export const FAKE_TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

export const steps: StepDef[] = [
  {
    name: "test-echo",
    title: "Echo",
    description: "Test step: records one fake model call and echoes its number.",
    stage: 2,
    requires: "operator",
    exclusive: "test-a",
    params: [
      { name: "n", label: "Number", kind: "int", min: 0, max: 100, default: 1 },
      { name: "mode", label: "Mode", kind: "enum", options: ["ok", "fail"], default: "ok" },
      { name: "repo", label: "Repo", kind: "repo" },
      { name: "run", label: "Run", kind: "run-id" },
    ],
    run: async (ctx) => {
      ctx.log(`token in the log: ${FAKE_TOKEN}`);
      if (ctx.params.mode === "fail") throw new Error("echo failed on purpose");
      ctx.usageRun("test-run");
      const t = new Date().toISOString();
      await queryDb(ctx.db).prepare(`INSERT INTO token_usage (run_id, agent, stage, model, items, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, started_at, ended_at, cost_usd)
        VALUES ('test-run', ?, 'test', 'fake', 1, 100, 10, 0, 0, ?, ?, 0.01)`).run(`echo-${ctx.job.id}`, t, t);
      return `echo ${ctx.params.n}`;
    },
  },
  {
    name: "test-sleep",
    title: "Sleep",
    description: "Test step: sleeps, reporting progress.",
    stage: 2,
    requires: "operator",
    exclusive: "test-a",
    params: [{ name: "ms", label: "Milliseconds", kind: "int", min: 0, max: 600000, default: 200 }],
    run: async (ctx) => {
      const ms = Number(ctx.params.ms);
      for (let t = 0; t < ms; t += 50) {
        await ctx.progress(`slept ${t} ms`);
        await sleep(50);
      }
      return `slept ${ms} ms`;
    },
  },
  {
    name: "test-notes",
    title: "Notes",
    description: "Test step: records an item, counts and progress side by side, then sleeps.",
    stage: 2,
    requires: "operator",
    params: [],
    run: async (ctx) => {
      const { jobItem } = await import("../src/runner/job-items.ts");
      await ctx.handled(1);
      await sleep(300);
      // The first count was written at once; these wait in memory.
      await ctx.handled(3);
      await ctx.acted(2);
      await jobItem(ctx.db, "app", 3, "handled before the stop", ctx.log);
      await sleep(600_000);
      return "slept";
    },
  },
  {
    name: "test-slices",
    title: "Slices",
    description: "Test step: works through a backlog in 50 ms units until its time slice is used.",
    stage: 2,
    requires: "operator",
    params: [{ name: "units", label: "Units", kind: "int", min: 0, max: 100000, default: 10 }],
    run: async (ctx) => {
      const units = Number(ctx.params.units);
      let done = 0;
      while (done < units && !await ctx.timeUp()) {
        await sleep(50);
        await ctx.handled(++done);
      }
      return `${done} of ${units} units, ${units - done} left`;
    },
  },
  {
    name: "test-other",
    title: "Other group",
    description: "Test step in a second concurrency group.",
    stage: 4,
    requires: "operator",
    params: [{ name: "ms", label: "Milliseconds", kind: "int", min: 0, max: 600000, default: 200 }],
    run: async (ctx) => {
      await sleep(Number(ctx.params.ms));
      return "other done";
    },
  },
  {
    name: "test-repo",
    title: "Repo work",
    description: "Test step: sleeps for one repo.",
    stage: 6,
    requires: "operator",
    params: [{ name: "repo", label: "Repo", kind: "repo", required: true }, { name: "ms", label: "Milliseconds", kind: "int", min: 0, max: 600000, default: 300 }],
    run: async (ctx) => { await sleep(Number(ctx.params.ms)); return "repo done"; },
  },
  {
    name: "test-urgent",
    title: "Urgent repo work",
    description: "Test step in the security class.",
    stage: 6,
    requires: "operator",
    priority: 2,
    params: [{ name: "repo", label: "Repo", kind: "repo", required: true }, { name: "ms", label: "Milliseconds", kind: "int", min: 0, max: 600000, default: 300 }],
    run: async (ctx) => { await sleep(Number(ctx.params.ms)); return "urgent done"; },
  },
  {
    name: "test-lane",
    title: "Lane repo work",
    description: "Test step with per-item lanes: a job per pull request, approved or item, and a job without a lane per repo.",
    stage: 6,
    requires: "operator",
    params: [
      { name: "repo", label: "Repo", kind: "repo", required: true }, { name: "ms", label: "Milliseconds", kind: "int", min: 0, max: 600000, default: 300 },
      { name: "lane", label: "Lane", kind: "enum", options: ["approved", "item"] }, { name: "number", label: "Pull request", kind: "int", min: 1, max: 1_000_000_000 },
    ],
    run: async (ctx) => { await sleep(Number(ctx.params.ms)); return "lane done"; },
  },
  {
    name: "test-model",
    title: "Model repo work",
    description: "Test step that declares a Claude model (it calls none): user-local jobs of it wait for a Task Runner of the repo.",
    stage: 6,
    requires: "operator",
    models: ["sonnet"],
    params: [{ name: "repo", label: "Repo", kind: "repo", required: true }, { name: "limit", label: "At most", kind: "int", min: 1, max: 50, default: 5 }],
    run: async () => "model repo done",
  },
  {
    name: "test-remote",
    title: "Remote call",
    description: "Test step: asks one user-local model call (a Task Runner answers it) and returns the reply.",
    stage: 2,
    requires: "operator",
    params: [],
    run: async (ctx) => {
      const { allocation } = await import("../src/agents/call.ts");
      const { askClaude } = await import("../src/classify/run.ts");
      const { SAMPLE_OPUS_PRS } = await import("../src/prompts/samples.ts");
      allocation.pollMs = 50;
      const r = await askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, ctx.db);
      return `reply: ${r?.text ?? "none"}`;
    },
  },
  {
    name: "test-writes",
    title: "Writes",
    description: "Test step: posts one slow comment per item, two items at a time, and, like the pipeline's steps, records an item whose write fails and goes on.",
    stage: 2,
    requires: "operator",
    params: [{ name: "n", label: "Items", kind: "int", min: 1, max: 100, default: 5 }],
    run: async (ctx) => {
      const { ghComment } = await import("../src/github/write.ts");
      // A job with model usage records it when it stops, as the pipeline's steps do.
      ctx.usageRun(`writes-${ctx.job.id}`);
      const g = { scope: "item", action: { kind: "act" }, repo: "app", number: 3, as: "app" } as never;
      const exec = async () => { await sleep(300); return { code: 0, stdout: "https://github.com/storytold/app/issues/3#issuecomment-1\n", stderr: "" }; };
      let failed = 0;
      // Two items at a time, the second starting a little later: a stop during the first's write comes before the second's.
      const post = async (k: number, after: number): Promise<void> => {
        await sleep(after);
        try {
          await ghComment({ db: ctx.db, login: "act" }, g, exec, "act-comment", { repo: "app", number: 3, pr: false }, { by: "fixed" } as never, `item ${k}`);
        } catch (e) {
          failed++;
          ctx.log(`item ${k} failed: ${(e as Error).message}`);
        }
      };
      for (let k = 1; k <= Number(ctx.params.n); k += 2) await Promise.all([post(k, 0), post(k + 1, 150)]);
      return `${failed} failed`;
    },
  },
];
