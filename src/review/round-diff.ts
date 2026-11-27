// The PR's own diff at two of its heads, for the review round of the author's new commits (src/review/opus.ts): each head diffed against
// its merge base with the base branch, as GitHub shows a PR's diff. Read from git in the shared repository cache, GitHub's compare when git
// cannot say; never from a cache that a new runner process lacks.
import { BASE_NAME } from "../core/rules.ts";
import { exec, fixupDir, Git } from "../fixup/git.ts";
import { ownerOf, slugOf } from "../owners.ts";
import { SHARED_NAME } from "../sandbox/command.ts";
import { gh, type DiffResult } from "./diff.ts";

/** `before`: the PR's own diff at the earlier head; `after`: at the later one. */
export type OwnDiffs = { ok: true; before: string; after: string } | { ok: false; error: string };
/** The PR's own diffs at `from` and `to`, both against the base branch `baseRef`. */
export type OwnDiffReader = (repo: string, number: number, baseRef: string, from: string, to: string) => Promise<OwnDiffs>;

const SHA = /^[0-9a-f]{40}$/;
const errorOf = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 300);

/**
 * The own diffs of `from` and `to` from commits in the cache: each against its merge base with `baseTip`. A merge of the base branch moves a
 * head's merge base with it, so the base branch's changes stay out of the head's own diff, as they stay out of GitHub's diff of the PR.
 */
export async function ownDiffsAt(git: Git, from: string, to: string, baseTip: string): Promise<OwnDiffs> {
  try {
    const before = await git.diffText((await git.must(["merge-base", from, baseTip])).trim(), from);
    const after = await git.diffText((await git.must(["merge-base", to, baseTip])).trim(), to);
    return { ok: true, before, after };
  } catch (e) { return { ok: false, error: errorOf(e) }; }
}

/**
 * The own diffs from git: the base branch, the PR's head ref and each commit fetched into the shared bare cache (src/fixup/git.ts), which the
 * review's checkout uses too. A head the PR no longer has (a force-push) is fetched by its id. No size limit: the diff is computed locally.
 */
export async function gitOwnDiffs(repo: string, number: number, baseRef: string, from: string, to: string, git = new Git(exec, fixupDir(), repo)): Promise<OwnDiffs> {
  if (!SHARED_NAME.test(repo) || !BASE_NAME.test(baseRef) || !SHA.test(from) || !SHA.test(to)) return { ok: false, error: "unusable repository, branch or commit name" };
  try {
    const org = ownerOf(repo);
    const baseTip = await git.fetchBase(org, repo, baseRef);
    // The head ref brings the PR's history in one fetch; a commit it lacks is fetched by its id below.
    await git.fetchPr(org, repo, number).catch(() => null);
    for (const sha of [from, to]) if (!(await git.fetchCommit(org, repo, sha))) return { ok: false, error: `commit ${sha.slice(0, 7)} could not be fetched` };
    return await ownDiffsAt(git, from, to, baseTip);
  } catch (e) { return { ok: false, error: errorOf(e) }; }
}

/** GitHub's compare of the base branch with `head`: the head's own diff. Fails over GitHub's limits (300 files; a cut diff is refused). */
export async function ghOwnDiff(repo: string, baseRef: string, head: string): Promise<DiffResult> {
  const path = `repos/${slugOf(repo)}/compare/${baseRef}...${head}`;
  const count = await gh(["api", path, "--jq", ".files | length"]);
  if (count.code !== 0) return { ok: false, tooLarge: /too_large|too large|406/i.test(count.err), error: count.err.trim().slice(0, 300) };
  const files = Number(count.out.trim());
  if (!Number.isFinite(files) || files >= 300) return { ok: false, tooLarge: true, error: "the compare is at GitHub's limit of 300 files" };
  const diff = await gh(["api", "-H", "Accept: application/vnd.github.diff", path]);
  if (diff.code !== 0) return { ok: false, tooLarge: /too_large|too large|406/i.test(diff.err), error: diff.err.trim().slice(0, 300) };
  if ((diff.out.match(/^diff --git /gm) ?? []).length < files) return { ok: false, tooLarge: true, error: "the compared diff was cut short" };
  return { ok: true, text: diff.out };
}

/** The own diffs from git, or from GitHub's compare when git cannot read them (both from one source, so their hunks line up). */
export const roundOwnDiffs: OwnDiffReader = async (repo, number, baseRef, from, to) => {
  const g = await gitOwnDiffs(repo, number, baseRef, from, to);
  if (g.ok) return g;
  const [b, a] = await Promise.all([ghOwnDiff(repo, baseRef, from), ghOwnDiff(repo, baseRef, to)]);
  if (b.ok && a.ok) return { ok: true, before: b.text, after: a.text };
  const failed = !b.ok ? b.error : !a.ok ? a.error : "";
  return { ok: false, error: `git: ${g.error}; GitHub: ${failed}` };
};
