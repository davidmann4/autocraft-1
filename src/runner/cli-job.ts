// Command-line runs of pipeline steps go through the job path: the same checks as a queued job and the planner's
// gate() rules that are not pacing (a job of the step for the same repo is queued or running, the daily limit, a pause), a jobs row
// (requested by `cli`, so counted toward the limits and visible on the Pipeline page), and the runner's exec child, whose
// output is shown here. The writer is an operator (CLI_BY): the guard skips the global switch, the approvals still apply.
// Commands not listed in CLI_STEPS, and runs with options a step has no parameter for, keep their own direct path.
import { copyLogs, JOB_LOG_FLUSH_MS, JobLogCopy } from "./job-log.ts";
import { spawn } from "node:child_process";
import { closeSync, createWriteStream, mkdirSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dbEnv, dbTarget } from "../db/open.ts";
import { cliGate, jobLimit } from "./autopilot.ts";
import { checkRequest, endJob, JobError } from "./jobs.ts";
import { logsDir } from "./runner.ts";
import { loadSteps, type StepDef } from "./steps.ts";
import { claimCliJob, setPids } from "../data/jobs/index.ts";
import type { Db } from "../db/index.ts";

/** How a command maps to a step. `apply`: a job only with --apply (a dry run without it stays read-only); `dry-run`: a job unless --dry-run; `always`: always. */
export type CliStep = { step: string; when: "apply" | "dry-run" | "always" };

export const CLI_STEPS: Record<string, CliStep> = {
  act: { step: "act", when: "apply" }, merge: { step: "merge", when: "apply" }, premerge: { step: "premerge", when: "apply" },
  "review-post": { step: "review-post", when: "apply" }, cifix: { step: "cifix", when: "apply" }, "cifix-rerun": { step: "cifix-rerun", when: "apply" },
  "main-fix": { step: "main-fix", when: "apply" },
  fixup: { step: "fixup", when: "apply" },
  verify: { step: "verify", when: "dry-run" }, "verify-collect": { step: "verify-collect", when: "dry-run" }, "opus-review": { step: "opus-review", when: "dry-run" },
  dupes: { step: "dupes", when: "dry-run" }, "dupe-compare": { step: "dupes-compare", when: "dry-run" },
  prioritize: { step: "prioritize", when: "always" }, rank: { step: "rank", when: "always" }, checks: { step: "checks", when: "always" },
};

export type CliRequest = { step: string; params: Record<string, string | number> };

/** The job a command line stands for, or null when the command runs its own way (dry run, another subcommand, an option the step has no parameter for). */
export function cliRequest(command: string, args: string[], steps: Map<string, StepDef>): CliRequest | null {
  const map = CLI_STEPS[command];
  const step = map && steps.get(map.step);
  if (!map || !step) return null;
  let apply = false;
  const params: Record<string, string | number> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--apply" && map.when === "apply") { apply = true; continue; }
    if (a === "--dry-run" && map.when === "dry-run") return null;
    const p = a.startsWith("--") ? step.params.find((x) => x.name === a.slice(2)) : undefined;
    const v = args[i + 1];
    if (!p || v === undefined || p.name in params) return null;
    params[p.name] = p.kind === "int" ? Number(v) : v;
    i++;
  }
  return map.when === "apply" && !apply ? null : { step: step.name, params };
}

/** Runs the request as an operator job here and returns the exit code. */
export async function runCliJob(db: Db, req: CliRequest): Promise<number> {
  const steps = await loadSteps();
  let job: { id: number; logPath: string };
  try {
    const { step, params } = await checkRequest(db, req.step, req.params);
    // The gate and the insert are one write transaction, so two CLI runs cannot both pass the gate.
    job = await db.write(async () => {
      const why = await cliGate(db, step, steps, params);
      if (why) throw new JobError(409, why);
      const lim = await jobLimit(db, step, Date.now(), typeof params.limit === "number" ? params.limit : undefined);
      if (!lim) throw new JobError(409, `the daily limit of ${step.name} leaves too little for a run`);
      const full: Record<string, unknown> = { ...params, ...lim };
      mkdirSync(logsDir(), { recursive: true });
      const repo = typeof full.repo === "string" ? full.repo : null;
      return await claimCliJob(db, { step: step.name, params: full, repo, logDir: logsDir() });
    });
  } catch (e) {
    if (e instanceof JobError) { console.error(`${req.step}: ${e.message}`); return 1; }
    throw e;
  }
  const { id, logPath } = job;
  closeSync(openSync(logPath, "a"));
  const log = createWriteStream(logPath, { flags: "a" });
  const logCopy = JobLogCopy.open(id, logPath);
  const copying = setInterval(() => void copyLogs(db, [logCopy]).catch(() => { /* the next copy reads the lines again */ }), JOB_LOG_FLUSH_MS);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../cli.ts", import.meta.url)), "runner", "exec", String(id)], {
    stdio: ["ignore", "pipe", "pipe"], env: dbEnv(dbTarget()),
  });
  if (child.pid) await setPids(db, [{ id, pid: child.pid }]);
  child.stdout.on("data", (b: Buffer) => { log.write(b); process.stdout.write(b); });
  child.stderr.on("data", (b: Buffer) => { log.write(b); process.stderr.write(b); });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => child.kill(sig));
  let spawnError: string | null = null;
  child.on("error", (e) => (spawnError = e.message));
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.on("close", (c, s) => resolve([c, s])));
  clearInterval(copying);
  await new Promise<void>((resolve) => log.end(resolve));
  const r = await endJob(db, id, code, signal, spawnError);
  await copyLogs(db, [logCopy], true).catch((e: Error) => console.error(`job ${id}: log not stored: ${e.message}`));
  console.error(`job ${id}: ${r?.state ?? "ended"}${r?.error ? `: ${r.error}` : ""}`);
  return r?.state === "done" ? 0 : 1;
}
