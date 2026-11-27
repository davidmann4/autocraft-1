// Sandboxed tool access for model calls: what a call needs to run claude with
// read-only file tools on a checkout, and the default way to get a checkout of
// a pull request's head commit from the cached bare clone.
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { exec, fixupDir, Git } from "../fixup/git.ts";
import { SHARED_NAME } from "./command.ts";
import { pruneSessionStores } from "./session-store.ts";
import { buildCheckout, checkoutRoot, pruneCheckouts } from "./checkout.ts";

export { REPO_PATH, REPOS_ROOT, AGENTS_PATH, reposPath, sandboxCommand, type SandboxSpec } from "./command.ts";
import { envVar } from "../env.ts";
import { ownerOf } from "../owners.ts";

const MAX_AGE_MS = 24 * 3600_000;

/** The claude binary behind the PATH entry, with symlinks resolved so one file can be bound. AUTOCRAFT_CLAUDE_BIN overrides. */
export function resolveClaudeBin(): string | null {
  const given = envVar("CLAUDE_BIN");
  const candidates = given ? [given] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => join(d, "claude"));
  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK);
      return realpathSync(c);
    } catch { /* next */ }
  }
  return null;
}

/**
 * Whether this process can run a sandboxed local Claude call: bubblewrap and the claude binary are present and
 * AUTOCRAFT_NO_SANDBOX=1 does not say it never does. Model calls run on Task Runners, whose helpers sandbox them on their
 * own machines, so the checkouts and tool mode of those calls do not depend on this.
 */
export function sandboxAvailable(): boolean {
  return envVar("NO_SANDBOX") !== "1" && existsSync("/usr/bin/bwrap") && resolveClaudeBin() !== null;
}

/**
 * A checkout of the head commit of `repo#number` (instruction files left out) for a sandboxed call, or null
 * (with the reason logged) when the repo name is not a plain one, the head moved, the fetch failed or the tree is too
 * large; the caller then asks without tools. It needs only the cached clone, not a local sandbox: the call runs on a
 * Task Runner, which gets the checkout as a mount.
 */
export async function checkoutForPr(repo: string, number: number, sha: string, log: (line: string) => void = () => {}): Promise<string | null> {
  return checkoutOf(repo, sha, `${repo}#${number}`, log, async (g) => {
    const head = await g.fetchPr(ownerOf(repo), repo, number);
    return head === sha ? null : "head moved on";
  });
}

/** A checkout of commit `sha`, which must be reachable from `branch` of the base repository (the commit a fix is based on), or null as for `checkoutForPr`. */
export async function checkoutForCommit(repo: string, branch: string, sha: string, log: (line: string) => void = () => {}): Promise<string | null> {
  return checkoutOf(repo, sha, `${repo}@${sha.slice(0, 7)}`, log, async (g) => ((await g.fetchBranch(ownerOf(repo), repo, branch, sha)) ? null : "commit not found"));
}

async function checkoutOf(repo: string, sha: string, label: string, log: (line: string) => void, fetch: (g: Git) => Promise<string | null>): Promise<string | null> {
  if (!SHARED_NAME.test(repo)) return null;
  try {
    const dest = join(checkoutRoot(), repo, sha);
    pruneCheckouts(checkoutRoot(), MAX_AGE_MS);
    pruneSessionStores(2 * 3600_000);
    const g = new Git(exec, fixupDir(), repo);
    if (!existsSync(dest)) {
      const why = await fetch(g);
      if (why) {
        log(`  ${label}: ${why}; asking without tools`);
        return null;
      }
    }
    const r = await buildCheckout(g.dir, sha, dest);
    if (r.ok) return r.dir;
    log(`  ${label}: no checkout (${r.reason}); asking without tools`);
  } catch (e) {
    log(`  ${label}: no checkout (${String((e as Error).message).slice(0, 150)}); asking without tools`);
  }
  return null;
}
