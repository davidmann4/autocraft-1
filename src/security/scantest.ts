// The scan test of a finding (feature scan-tests): the model writes a Rust test from the test Verify proposed, the build
// worker runs it on the pinned commit, and the outcome marks the finding. The scan job writes and queues; a later tick of
// the runner reads the task, so no job waits on a build and the read is database work only. Nothing here changes a finding's
// state or severity except a note on one whose test passed; only a person decides what that means.
import { createHash } from "node:crypto";
import { freshConfig, withConfig } from "../data/control/index.ts";
import { cancelTasks, loadConfidentialReadyAt, loadTasks, TERMINAL } from "../data/build/index.ts";
import * as sec from "../data/security/index.ts";
import { BuildError } from "../build/envs.ts";
import { cloneTasks, createTask } from "../build/tasks.ts";
import { tasksFor } from "../build/fix-tasks.ts";
import { outcomeOf } from "../verify/results.ts";
import { patchFor, patchProblem, regressionPath } from "../verify/plan.ts";
import { regressionName } from "../verify/types.ts";
import type { CratesResult } from "../verify/crates.ts";
import type { ScanTestState } from "../../web/src/api/types.ts";
import { ROUND_BUILD_LIMIT_MS } from "./actions.ts";
import { crateOf } from "./fix.ts";
import type { SecurityScanTestInput } from "./rules.ts";
import type { Db } from "../db/index.ts";

/** Build tasks of scan tests queue behind the work that waits for a person. */
export const SCAN_TEST_PRIORITY = -5;
export const NOT_SHOWN_NOTE = "The proposed test passes on the current code.";

const now = (): string => new Date().toISOString();
const oneLine = (s: string, max = 300): string => s.replace(/\s+/g, " ").trim().slice(0, max);

/** The scan test's file name: derived from the repo and finding, and different from the name of the fix's regression test. */
export const scanTestName = (repo: string, n: number): string => regressionName(createHash("sha256").update(`scan:${repo}#${n}`).digest("hex").slice(0, 10));

export type WriteOpts = {
  repo: string;
  number: number;
  sha: string;
  finding: SecurityScanTestInput["finding"];
  proposedTest: string;
  crates: CratesResult;
  /** The model call (through the scan's cost and timeline bookkeeping): the test file, or null when none could be read. */
  write: (input: Omit<SecurityScanTestInput, "repo" | "number" | "project" | "commit">) => Promise<{ value: string } | null>;
  log: (line: string) => void;
};

/**
 * Writes the finding's test and queues its build task. Returns true when a task was queued (the row is `building`), false
 * when the finding has none: the sink is not in a Rust crate, the model gave no test, or the test failed the patch check.
 */
export async function writeAndQueue(db: Db, o: WriteOpts): Promise<boolean> {
  const { repo, number: n } = o;
  if (!o.crates.ok || !o.crates.rust) return false;
  const crate = crateOf(o.crates.crates, o.finding.refs[0]?.path ?? "");
  if (!crate || !/^[A-Za-z0-9_./-]+$/.test(crate.dir) || crate.dir.split("/").includes("..")) { o.log(`${repo} finding ${n}: no scan test: the sink is not in a Rust crate`); return false; }
  const name = scanTestName(repo, n);
  const path = regressionPath(crate.dir, name);
  const written = await o.write({ finding: o.finding, crate: { name: crate.name, dir: crate.dir }, test_path: path, proposed_test: o.proposedTest });
  if (!written) { o.log(`${repo} finding ${n}: no scan test: the model gave no readable test`); return false; }
  const patch = patchFor(crate.dir, name, written.value);
  const problem = patchProblem(patch, path);
  if (problem) { o.log(`${repo} finding ${n}: no scan test: ${problem}`); return false; }
  let id: number;
  try {
    const base = tasksFor({ repo, number: null, main_sha: o.sha, crate: crate.name, test: name }, patch, patch, "scan-test")[1]!;
    id = await createTask(db, { ...base, priority: SCAN_TEST_PRIORITY });
  } catch (e) {
    if (!(e instanceof BuildError)) throw e;
    o.log(`${repo} finding ${n}: no scan test: the build task was not queued: ${e.message}`);
    return false;
  }
  // Every column is written: a new test replaces the earlier one's detail and end time.
  await sec.saveScanTest(db, { repo, number: n, test_path: path, crate: crate.name, test_patch: patch, test_source: written.value, task_id: id, retried: 0, state: "building", detail: null, created_at: now(), ended_at: null });
  o.log(`${repo} finding ${n}: scan test queued for build`);
  return true;
}

export type ScanTestWork = { enabled: boolean; rows: sec.BuildingTest[] };

/** The `building` scan tests and whether scan tests are on, in one wave. */
export async function loadScanTestWork(db: Db): Promise<ScanTestWork> {
  const [cfg, rows] = await db.together(() => Promise.all([freshConfig(db, ["build_feature:scan-tests"]), sec.listBuildingScanTests(db)]));
  return { enabled: cfg.scanTestsEnabled, rows };
}

/**
 * Reads the build task of each `building` scan test: a failure at the test step is `confirmed`, a pass is `not-shown`, a build
 * failure, a timeout or a second environment error is `could-not-build` (a first environment error queues the task again).
 * A task still running after ROUND_BUILD_LIMIT_MS is cancelled. Returns the tests that ended.
 */
export async function advanceScanTests(db: Db, work?: ScanTestWork): Promise<{ repo: string; number: number; state: ScanTestState }[]> {
  const { enabled, rows } = work ?? await loadScanTestWork(db);
  if (!enabled || !rows.length) return [];
  return await withConfig(db, async () => {
    const [tasks, ready] = await db.together(() => Promise.all([loadTasks(db, rows.map((r) => r.task_id)), loadConfidentialReadyAt(db)]));
    const ended: { repo: string; number: number; state: ScanTestState; detail: string }[] = [];
    const retry: sec.BuildingTest[] = [];
    const cancel: number[] = [];
    const reasons = new Map<number, string>();
    const end = (r: sec.BuildingTest, state: Exclude<ScanTestState, "building">, detail: string): void => { ended.push({ repo: r.repo, number: r.number, state, detail }); };
    for (const r of rows) {
      const task = tasks.get(r.task_id);
      if (!task) { end(r, "could-not-build", "the build task no longer exists"); continue; }
      if (!TERMINAL.includes(task.state)) {
        // The private clock starts when the test was queued, or when a confidential environment could first take it.
        const since = ready === null ? null : Math.max(Date.parse(r.created_at), ready);
        if (since === null || Date.now() - since <= ROUND_BUILD_LIMIT_MS) continue;
        cancel.push(r.task_id);
        end(r, "could-not-build", "the build did not finish in time");
        continue;
      }
      const o = outcomeOf(task);
      if (o.kind === "pass") { end(r, "not-shown", NOT_SHOWN_NOTE); continue; }
      if (o.kind === "fail") {
        if (o.step === "test" && !o.timedOut) end(r, "confirmed", "The test failed on the pinned commit.");
        else end(r, "could-not-build", o.timedOut ? `the ${o.step} step timed out` : `the ${o.step} step failed before the test ran`);
        continue;
      }
      if (r.retried === 0) { retry.push(r); reasons.set(r.task_id, o.reason); continue; }
      end(r, "could-not-build", `build environment error: ${oneLine(o.reason, 200)}`);
    }
    if (cancel.length) await cancelTasks(db, { ids: cancel }, "security-scan");
    const cloned = new Map<number, number>();
    if (retry.length) {
      try {
        for (const [from, to] of await cloneTasks(db, retry.map((r) => r.task_id))) cloned.set(from, to);
      } catch (e) {
        if (!(e instanceof BuildError)) throw e;
        for (const r of retry) {
          try { cloned.set(r.task_id, (await cloneTasks(db, [r.task_id])).get(r.task_id)!); } catch (e2) { if (!(e2 instanceof BuildError)) throw e2; }
        }
      }
    }
    for (const r of retry) {
      if (!cloned.has(r.task_id)) end(r, "could-not-build", `build environment error: ${oneLine(reasons.get(r.task_id) ?? "", 200)}`);
    }
    await db.write(async () => {
      await sec.finishScanTests(db, ended);
      await sec.retryScanTests(db, retry.filter((r) => cloned.has(r.task_id)).map((r) => ({ repo: r.repo, number: r.number, task_id: cloned.get(r.task_id)! })));
    });
    return ended.map(({ repo, number, state }) => ({ repo, number, state }));
  });
}
