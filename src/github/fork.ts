// The pipeline account's fork of a repo, a repo's default branch and its head commit.
import { githubIdentity, identityFor } from "./identity.ts";
import { ghApi } from "../verify/crates.ts";
import { ghFork, type Writer } from "./write.ts";
import type { Exec } from "../fixup/git.ts";
import type { GuardedRepo } from "../core/guard.ts";
import { slugOf } from "../owners.ts";
import type { Db } from "../db/index.ts";
import { loadRepos } from "../data/mirror/index.ts";

const oneLine = (s: string, max = 200) => s.replace(/\s+/g, " ").trim().slice(0, max);
const SHA = /^[0-9a-f]{40}$/;

export const branchOf = async (db: Db, repo: string): Promise<string> =>
  (await loadRepos(db, { names: [repo] })).get(repo)?.default_branch ?? "main";

/** The pipeline account's fork of the repo as owner/name, created when missing; the base repo itself for a repo on the app identity. */
export async function forkOf(w: Writer, g: GuardedRepo, run: Exec, login: string, repo: string, details: Record<string, unknown> = {}): Promise<string> {
  // The GitHub App has no account to own a fork: its autocraft/* branches live in the base repository.
  if (identityFor(g) === "app" && await githubIdentity(w.db) === "app") return slugOf(repo);
  const find = async (): Promise<string | null> => {
    const r = await run("gh", ["api", `repos/${slugOf(repo)}/forks?per_page=100`, "--jq", `.[] | select(.owner.login == "${login}") | .full_name`]);
    return r.code === 0 ? r.stdout.trim().split("\n")[0] || null : null;
  };
  const same = await run("gh", ["api", `repos/${login}/${repo}`, "--jq", ".parent.full_name"]);
  if (same.code === 0 && same.stdout.trim() === `${slugOf(repo)}`) return `${login}/${repo}`;
  const known = await find();
  if (known) return known;
  const f = await ghFork(w, g, run, repo, details);
  if (f.code !== 0) throw new Error(`could not fork ${repo}: ${oneLine(f.stderr)}`);
  const made = await find();
  if (!made) throw new Error(`the fork of ${repo} is not visible yet`);
  return made;
}

/** The head commit of a repo's default branch, or null. */
export async function mainHeadOf(repo: string, branch: string): Promise<string | null> {
  try {
    const s = (await ghApi(`repos/${slugOf(repo)}/commits/${encodeURIComponent(branch)}`, ".sha")).trim();
    return SHA.test(s) ? s : null;
  } catch { return null; }
}
