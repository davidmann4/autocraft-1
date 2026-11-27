// The real dependencies of the security scan: the pinned checkout from the bare cache and `claude` in the read-only sandbox.
import { ownerOf } from "../owners.ts";
import { askClaude, saveUsage, type Usage } from "../classify/run.ts";
import { exec, fixupDir, Git } from "../fixup/git.ts";
import { checkoutForCommit } from "../sandbox/index.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { cachedCrates, ghCrates } from "../verify/crates.ts";
import type { ScanDeps } from "./scan.ts";
import { loadRepos } from "../data/mirror/index.ts";
import { loadRunsAfter, runWatermark } from "../data/inference/index.ts";
import type { Db } from "../db/index.ts";

/** The cost and the first run of the agent runs that touched an item after `before` (a watermark from `runWatermark`); the cost is null when none reported one. */
export async function runsSince(db: Db, before: number, item: { repo: string; number: number }): Promise<{ cost: number | null; firstId: number | null }> {
  const runs = await loadRunsAfter(db, before, { item });
  const costs = runs.map((r) => r.costUsd).filter((c): c is number => c !== null);
  return { cost: costs.length ? costs.reduce((a, b) => a + b, 0) : null, firstId: runs[0]?.id ?? null };
}

/** The token_usage run id of a scan: the job registers it with `usageRun`, so the spend shows in the job's usage and on the Cost page. */
export const usageRunId = (scanId: number): string => `security-${scanId}`;

/** `io.resumes`: the job's resume count (src/runner/resuming.ts); a resumed run's agent names differ from its earlier run's, whose usage rows stay. */
export function realDeps(db: Db, scanId: number, io: { cancelled: () => Promise<boolean>; log: (line: string) => void; progress: (line: string) => Promise<void>; resumes?: number }): ScanDeps {
  let dir = "";
  let seq = 0;
  const run = io.resumes ? `r${io.resumes}.` : "";
  // The checkout is read-only in bubblewrap; the CLI keeps its API access, the model gets Read, Grep and Glob and no web tool.
  // The cost is read from the agent runs the call made (a failed call and a fix turn cost money too), so the spend cap sees all of it.
  const send = async (id: "security.model" | "security.area" | "security.verify" | "security.scantest", input: { repo: string; number: number }) => {
    const before = await runWatermark(db);
    const start = new Date().toISOString();
    let text: string | null = null, usage: Usage | null = null;
    try {
      const r = await askClaude(id, "opus", [{ ...input, repo_dir: REPO_PATH }] as never, db, { checkout: dir });
      if (r) { text = r.text; usage = r.usage; }
    } catch (e) {
      io.log(`${id} failed: ${(e as Error).message}`.slice(0, 300));
    }
    const runs = await runsSince(db, before, input);
    const cost = runs.cost ?? usage?.cost ?? null;
    await saveUsage(db, usageRunId(scanId), `${id}#${run}${++seq}`, "security", "opus", 1, usage ? { ...usage, cost } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost }, start, new Date().toISOString());
    return { text, cost, runId: runs.firstId };
  };
  return {
    ...io,
    checkout: async (repo, pin) => {
      const branch = (await loadRepos(db, { names: [repo], all: true })).get(repo)?.default_branch ?? "main";
      const sha = pin ?? await new Git(exec, fixupDir(), repo).fetchBase(ownerOf(repo), repo, branch);
      const d = await checkoutForCommit(repo, branch, sha, io.log);
      if (!d) return null;
      dir = d;
      return { dir: d, sha };
    },
    ask: send as ScanDeps["ask"],
    // Used only while the scan-tests switch is on (the scan checks it).
    writeTest: (input) => send("security.scantest", input),
    crates: (repo, sha) => cachedCrates(repo, sha, ghCrates),
  };
}
