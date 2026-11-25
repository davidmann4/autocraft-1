// The PR of an implementation: the checked diff is applied on the base commit in a hardened clone of ours (no working
// tree; nothing of the repository runs), committed as the pipeline's identity, pushed to its own branch and opened as a
// PR, all through src/github/write.ts. The queuer's pre-approval then sends it through Review, Verify and the merge queue.
// A run that stops part way is picked up by the next one: an open PR of ours on the branch (or the one stored on the row)
// is adopted and the remaining steps run.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/index.ts";
import { diffStat } from "../build/workspaces.ts";
import { guardItem, guardRepo, type GuardedItem, type ItemWant } from "../core/guard.ts";
import type { By } from "../core/gates.ts";
import { addFastTrack } from "../fasttrack.ts";
import { branchOf, forkOf } from "../github/fork.ts";
import { hasOpenPr } from "../core/open-prs.ts";
import { EMPTY_TREE, exec as realExec, fixupDir, Git, type Exec } from "../fixup/git.ts";
import { buildScriptsAt, type BuildScripts } from "../fixup/patch.ts";
import { ownPrSelect } from "../github/adopt.ts";
import { commitIdentity, githubIdentity } from "../github/identity.ts";
import { pipelineAccount, setPipelineLogin } from "../github/pipeline-account.ts";
import { ghComment, ghOpenPr, pushOwnBranch, type Writer } from "../github/write.ts";
import { Client, ONE_QUERY, writeItemNode, type Querier } from "../mirror.ts";
import { ownerOf, slugOf } from "../owners.ts";
import { liveWorkflow, repoWorkflow } from "../workflow/store.ts";
import { preapproveMerge, PreapprovalRefused } from "../preapproval/index.ts";
import {
  MAX_BINARY_BYTES, MAX_IMPLEMENTATION_LINES, validateImplementation,
  type ChangedFile, type CompileTimeChange, type ImplementationCheck, type ManifestTexts,
} from "./diff.ts";
import { moveImplementationIf } from "./store.ts";
import { implBranch, implCommentText, implCommitMessage, implPrBody, implTitle, type CheckLine } from "./template.ts";
import type { Implementation } from "./types.ts";

/** The audit login of the stage's writes. */
const ACTOR = "implement";

export type PrDeps = {
  /** Every git and gh command. */
  exec: Exec;
  /** Directory holding one bare cache repository per repo. */
  root: string;
  /** GitHub GraphQL, to read the new PR into the mirror. Absent: the PR waits for the sync, and the run ends as `retry`. */
  querier?: Querier;
  log: (line: string) => void;
};

export const defaultPrDeps = (): PrDeps => ({ exec: realExec, root: fixupDir(), querier: new Client(100), log: console.log });

export type OpenPrInput = {
  implementation: Implementation;
  /** The workspace diff (workspaceDiff). */
  diff: string;
  /** The commit the diff is against (the workspace's base commit): it must be `implementation.baseSha`. */
  base: string;
  /** The model that wrote the change, for the PR's note and body. */
  model: string;
  checks: CheckLine[];
  /** The job's actor: the pipeline, or an operator at the command line. */
  by: By;
  draft?: boolean;
  /** The Plan action the writes are guarded under; default `implement` in the build bucket. */
  want?: ItemWant;
  /** The job's run id, for the audit rows. */
  run?: string;
};

export type OpenPrResult =
  | {
    ok: true; url: string; number: number; branch: string; adopted: boolean; draft: boolean;
    /** Why the PR was not pre-approved, or null when it was. */ notPreapproved: string | null;
    /** Our PR is merged already (a run after the merge): the row is `merged`. */ merged?: true;
  }
  | {
    ok: false; reason: string;
    /** True when a later run may succeed as it is (a guard, a push, a comment or the mirror); false when the attempt cannot open a PR (the caller decides what follows). */
    retry: boolean;
    /** The diff check's problems, when the diff was refused. */
    problems?: string[];
    /** The row left `opening` meanwhile (a cancel or a stuck decision): nothing more was written, and the caller writes nothing either. */
    stale?: true;
  };

const refOf = (i: { repo: string; number: number }): string => `${i.repo}#${i.number}`;
const oneLine = (s: string, max = 200): string => s.replace(/\s+/g, " ").trim().slice(0, max);
const urlOk = (url: string, repo: string): boolean => new RegExp(`^https://github\\.com/${slugOf(repo)}/pull/\\d+$`).test(url);
const prNumberOf = (url: string): number => Number(/\/pull\/(\d+)$/.exec(url)![1]);

/** Forks being looked up or created, per repo: two implementations of one repo must not both create the fork. */
const forkLocks = new Map<string, Promise<unknown>>();
export function forkOnce<T>(repo: string, work: () => Promise<T>): Promise<T> {
  const run = (forkLocks.get(repo) ?? Promise.resolve()).then(work, work);
  const tail = run.catch(() => {}).finally(() => { if (forkLocks.get(repo) === tail) forkLocks.delete(repo); });
  forkLocks.set(repo, tail);
  return run;
}

/** The issue's or PR's state on GitHub now (a merged PR is MERGED, not CLOSED); null when the read fails, in which case the mirror's state stands. */
export async function liveState(exec: Exec, repo: string, path: string): Promise<"OPEN" | "CLOSED" | "MERGED" | null> {
  const r = await exec("gh", ["api", `repos/${slugOf(repo)}/${path}`, "--jq", `if .merged == true then "merged" else .state end`]);
  const v = r.code === 0 ? r.stdout.trim().toLowerCase() : "";
  return v === "open" ? "OPEN" : v === "closed" ? "CLOSED" : v === "merged" ? "MERGED" : null;
}

/** True when the issue is closed on GitHub; the mirror row is brought up to date. */
async function issueClosedLive(db: Db, d: PrDeps, repo: string, number: number): Promise<boolean> {
  if (await liveState(d.exec, repo, `issues/${number}`) !== "CLOSED") return false;
  await db.run(db.k.updateTable("main.items").set({ state: "CLOSED" }).where("repo", "=", repo).where("number", "=", number).where("state", "=", "OPEN"));
  return true;
}

/**
 * Checks the diff against the build scripts both before and after it (a manifest change can name a new build script),
 * applies it on `base`, reads the changed Cargo.toml files for compile-time changes, and checks the commit's changes,
 * line count and binary sizes against the checked file list. Returns the commit.
 */
export async function commitDiff(git: Git, root: string, base: string, diff: string, message: (c: Extract<ImplementationCheck, { ok: true }>) => string, who: { name: string; email: string }):
  Promise<{ ok: true; commit: string; check: Extract<ImplementationCheck, { ok: true }> } | { ok: false; reason: string; problems?: string[] }> {
  const check = validateImplementation(diff, await buildScriptsAt(git, base));
  if (!check.ok) return check;
  mkdirSync(root, { recursive: true });
  const scratch = mkdtempSync(join(root, ".index-"));
  let tree: string;
  try {
    const applied = await git.applyToTree(base, diff, join(scratch, "index"));
    if (!applied.ok) return { ok: false, reason: applied.reason };
    tree = applied.tree;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const after: BuildScripts = await buildScriptsAt(git, tree);
  const again = validateImplementation(diff, after, await manifestTexts(git, base, tree, check.files));
  if (!again.ok) return again;
  const big = await oversized(git, tree, check.files.filter((f) => f.binary && f.status !== "D"));
  if (big.length) return { ok: false, reason: `binary files over ${MAX_BINARY_BYTES / 1024 ** 2} MiB: ${big.join(", ")}`, problems: big.map((p) => `${p}: a binary file over ${MAX_BINARY_BYTES / 1024 ** 2} MiB`) };
  const commit = await git.commit(tree, base, message(check), who);
  if (!sameChanges(await git.rawChanges(base, commit), check.files)) return { ok: false, reason: "the commit would change files or modes outside the checked diff" };
  const counted = await committedProblems(git, base, commit);
  if (counted.length) return { ok: false, reason: counted.slice(0, 5).join("; "), problems: counted };
  return { ok: true, commit, check: again };
}

/** Each changed Cargo.toml at the base and in the tree; a manifest that cannot be read is left out (validateImplementation flags it). */
async function manifestTexts(git: Git, base: string, tree: string, files: ChangedFile[]): Promise<ManifestTexts> {
  const out: ManifestTexts = new Map();
  const read = async (at: string, path: string): Promise<string | undefined> => { const r = await git.file(at, path); return r.ok ? r.content : undefined; };
  for (const f of files.filter((x) => /(^|\/)Cargo\.toml$/.test(x.path))) {
    const before = f.status === "A" ? null : await read(base, f.path);
    const after = f.status === "D" ? null : await read(tree, f.path);
    if (before !== undefined && after !== undefined) out.set(f.path, { before, after });
  }
  return out;
}

/** `git diff --numstat -z` rows: changed lines per path, null counts for a binary file. */
function numstat(out: string): { path: string; lines: number | null }[] {
  return out.split("\0").filter(Boolean).flatMap((row) => {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(row);
    return m ? [{ path: m[3]!, lines: m[1] === "-" ? null : Number(m[1]) + Number(m[2]) }] : [];
  });
}

/**
 * The commit's changes as git counts them, whatever the diff's sections claimed: at most MAX_IMPLEMENTATION_LINES changed
 * text lines, and no file that is text at the base made binary (its lines would not be counted).
 */
async function committedProblems(git: Git, base: string, commit: string): Promise<string[]> {
  const flags = ["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv"];
  const literal = { env: { GIT_LITERAL_PATHSPECS: "1" } };
  const rows = numstat(await git.must([...flags, base, commit]));
  const problems: string[] = [];
  const binary = rows.filter((r) => r.lines === null).map((r) => r.path);
  if (binary.length) {
    const textAtBase = new Set(numstat(await git.must([...flags, EMPTY_TREE, base, "--", ...binary], literal)).filter((r) => r.lines !== null).map((r) => r.path));
    for (const p of binary) if (textAtBase.has(p)) problems.push(`${p}: a text file of the base made binary`);
  }
  const changed = rows.reduce((n, r) => n + (r.lines ?? 0), 0);
  if (changed > MAX_IMPLEMENTATION_LINES) problems.push(`${changed} lines changed; at most ${MAX_IMPLEMENTATION_LINES}`);
  return problems;
}

/** The last push this implementation made to `branch` that is known done: its commit, and the compile-time changes it was flagged for. */
export async function lastPush(db: Db, im: Implementation, branch: string): Promise<{ commit: string; compileTime: CompileTimeChange[] } | null> {
  const rows = await db.all(db.k.selectFrom("audit").select("details").where("action", "=", "implement-push").where("target", "=", refOf(im)).orderBy("at", "desc"));
  for (const r of rows) {
    let x: { impl?: unknown; branch?: unknown; commit?: unknown; state?: unknown; compileTime?: unknown };
    try { x = JSON.parse(r.details ?? "{}"); } catch { continue; }
    if (x.impl !== im.id || x.branch !== branch || x.state !== "done" || typeof x.commit !== "string") continue;
    return { commit: x.commit, compileTime: Array.isArray(x.compileTime) ? x.compileTime as CompileTimeChange[] : [] };
  }
  return null;
}

/** Binary files of the tree over MAX_BINARY_BYTES (a delta's result size is only known once applied). */
async function oversized(git: Git, tree: string, files: ChangedFile[]): Promise<string[]> {
  if (!files.length) return [];
  const out = await git.must(["ls-tree", "-r", "-l", "-z", tree, "--", ...files.map((f) => f.path)]);
  return out.split("\0").filter(Boolean).flatMap((row) => {
    const m = /^\d+ blob [0-9a-f]+ +(\d+)\t(.*)$/s.exec(row);
    return m && Number(m[1]) > MAX_BINARY_BYTES ? [m[2]!] : [];
  });
}

/** The commit's `diff-tree --raw` rows are exactly the checked files, with their status and modes. */
function sameChanges(rows: string[][], files: ChangedFile[]): boolean {
  if (rows.length !== files.length) return false;
  const want = new Map(files.map((f) => [f.path, f]));
  return rows.every(([from, to, status, path]) => {
    const f = want.get(path!);
    if (!f || f.status !== status) return false;
    if (f.status === "A") return from === "000000" && to === "100644";
    if (f.status === "D") return from === f.mode && to === "000000";
    return from === f.mode && to === f.mode;
  });
}

/**
 * Comments on the issue once per PR: a row of an earlier comment on this PR (done, or begun with an unknown outcome) stops it.
 * Returns why the comment failed, or null.
 */
async function commentOnce(db: Db, d: PrDeps, g: GuardedItem, im: Implementation, pr: { number: number; url: string; draft: boolean }, run?: string): Promise<string | null> {
  const ref = refOf(im);
  const rows = await db.all(db.k.selectFrom("audit").select("details").where("action", "=", "implement-comment").where("target", "=", ref));
  if (rows.some((r) => { try { const x = JSON.parse(r.details ?? "{}") as { pr?: unknown; state?: unknown }; return x.pr === pr.number && x.state !== "failed"; } catch { return false; } })) return null;
  const cm = await ghComment({ db, login: ACTOR }, g, d.exec, "implement-comment", { repo: im.repo, number: im.number, pr: false }, { by: "fixed" }, implCommentText(pr.url, pr.draft), { pr: pr.number, ...(run && { run }) });
  if (cm.code === 0) return null;
  d.log(`  ${ref}: comment failed: ${oneLine(cm.stderr)}`);
  return oneLine(cm.stderr || cm.stdout) || `exit code ${cm.code}`;
}

/** Reads the PR into the mirror, so the pre-approval and the planner see it now. True when the mirror has it with its head. */
async function mirrorPr(db: Db, d: PrDeps, repo: string, number: number): Promise<boolean> {
  const has = async () => !!(await db.get(db.k.selectFrom("main.items").select("head_oid").where("repo", "=", repo).where("number", "=", number).where("kind", "=", "pr")))?.head_oid;
  if (await has()) return true;
  if (!d.querier) return false;
  try {
    const sentAt = new Date();
    const data = await d.querier.query(ONE_QUERY, { owner: ownerOf(repo), name: repo, number }) as { repository?: { issueOrPullRequest?: Parameters<typeof writeItemNode>[2] } };
    await writeItemNode(db, repo, data.repository?.issueOrPullRequest, sentAt);
  } catch (e) {
    d.log(`  ${repo}#${number}: the PR could not be read into the mirror: ${oneLine(String((e as Error).message ?? e))}`);
  }
  return await has();
}

/**
 * Opens the implementation's PR, or adopts the one an earlier run opened, then pre-approves its merge as the queuer at the
 * commit this implementation pushed (not for a draft), fast-tracks it with the issue's weight and comments on the issue
 * once. A change with compile-time manifest changes opens only as a draft. Every write of the row is made only while it is
 * `opening`: it moves there at the start, keeps the branch before the push and the PR number and URL as soon as the PR
 * exists, and moves to `pr-opened` when every step is done (or to `merged` on a run after our PR merged). A failure leaves
 * the state to the caller: `retry` says whether the same input may succeed later.
 */
export async function openImplementationPr(db: Db, input: OpenPrInput, d: PrDeps = defaultPrDeps()): Promise<OpenPrResult> {
  const im = input.implementation;
  const { repo, number } = im;
  const ref = refOf(im);
  const w: Writer = { db, login: ACTOR };
  const run = input.run ? { run: input.run } : {};
  const fail = (reason: string, retry: boolean, problems?: string[]): OpenPrResult => { d.log(`  ${ref}: PR not opened: ${reason}`); return { ok: false, reason, retry, ...(problems && { problems }) }; };
  const stale = (): OpenPrResult => { d.log(`  ${ref}: the implementation left opening meanwhile; nothing more is written`); return { ok: false, reason: "the implementation left opening meanwhile", retry: true, stale: true }; };
  const write = (patch: Parameters<typeof moveImplementationIf>[4], to: "pr-opened" | null = null) => moveImplementationIf(db, im.id, ["opening"], to, patch);
  try {
    if (!im.baseSha) return fail("the implementation has no base commit", false);
    if (input.base !== im.baseSha) return fail(`the workspace diff is against ${input.base.slice(0, 12)}, not the implementation's base commit ${im.baseSha.slice(0, 12)}`, false);
    // A run after our PR merged: the work is done.
    const stored = im.prNumber !== null && im.prUrl ? await liveState(d.exec, repo, `pulls/${im.prNumber}`) : null;
    if (stored === "MERGED") {
      if (!await moveImplementationIf(db, im.id, [im.state], "merged")) return stale();
      d.log(`  ${ref}: our PR ${im.prUrl} is merged`);
      return { ok: true, url: im.prUrl!, number: im.prNumber!, branch: im.branch ?? "", adopted: true, draft: false, notPreapproved: null, merged: true };
    }
    if (stored === "CLOSED") return fail(`our PR #${im.prNumber} was closed`, false);
    const issue = await db.get(db.k.selectFrom("main.items").select(["state", "title"]).where("repo", "=", repo).where("number", "=", number));
    if (!issue || issue.state !== "OPEN" || await issueClosedLive(db, d, repo, number)) return fail("the issue is closed", false);
    if (!await moveImplementationIf(db, im.id, [im.state], "opening")) return stale();
    const guard = async (): Promise<GuardedItem | string> => {
      const g = await guardItem(db, { repo, number }, input.want ?? { kind: "implement", bucket: "build" }, input.by);
      return "refused" in g ? g.refused : g;
    };
    const who = await pipelineAccount(d.exec);
    await setPipelineLogin(db, who.login);
    const base = await branchOf(db, repo);
    const branch = im.branch ?? implBranch(number, issue.title ?? "", who.login);
    const title = implTitle(im.plan?.kind ?? "change", issue.title ?? "");

    // A PR an earlier run opened: the stored one, else an open PR of ours on the branch.
    let url: string | null = null;
    if (im.prNumber !== null && im.prUrl) url = im.prUrl;
    else {
      const headOwners = [who.login, ...(await githubIdentity(db) === "app" ? [ownerOf(repo)] : [])];
      const sel = await ownPrSelect(db, repo, headOwners, base);
      const found = await d.exec("gh", ["pr", "list", "--repo", slugOf(repo), "--state", "open", "--head", branch, "--json", sel.json, "--jq", sel.jq]);
      if (found.code !== 0) return fail(`the open PRs could not be listed: ${oneLine(found.stderr)}`, true);
      const existing = found.stdout.trim().split("\n")[0] ?? "";
      if (existing && urlOk(existing, repo)) url = existing;
    }
    const adopted = url !== null;
    let g: GuardedItem | null = null;
    // The commit this implementation pushed, and its compile-time manifest changes.
    let pushed: { commit: string; compileTime: CompileTimeChange[] };

    if (url === null) {
      if (await hasOpenPr(db, repo, number)) return fail("another pull request already covers the issue", false);
      const git = new Git(d.exec, d.root, repo);
      if (!await git.fetchBranch(ownerOf(repo), repo, base, im.baseSha)) return fail("the base commit is no longer in the repository", false);
      const author = await commitIdentity(db, repo, async () => who);
      const made = await commitDiff(git, d.root, im.baseSha, input.diff, (c) => implCommitMessage(title, number, c.files.map((f) => f.path)), { name: author.name, email: author.email });
      if (!made.ok) return fail(made.reason, false, made.problems);
      pushed = { commit: made.commit, compileTime: made.check.compileTime };
      const gi = await guard();
      if (typeof gi === "string") return fail(gi, true);
      g = gi;
      const rg = await guardRepo(db, repo, "fix-issue", input.by);
      if ("refused" in rg) return fail(rg.refused, true);
      const fork = await forkOnce(repo, () => forkOf(w, rg, d.exec, who.login, repo, run));
      // Kept before the push: a rerun pushes to the same branch and finds the PR on it, whatever the issue's title is by then.
      if (im.branch !== branch && !await write({ branch })) return stale();
      const push = await pushOwnBranch(w, g, git, "implement-push", { repo, number, remote: fork, branch, sha: made.commit },
        { ...run, fork, base: im.baseSha, impl: im.id, ...(pushed.compileTime.length && { compileTime: pushed.compileTime }) });
      if (push.code !== 0) return fail(`the push failed: ${oneLine(push.stderr)}`, true);
      if (await issueClosedLive(db, d, repo, number)) return fail("the issue is closed", false);
      const draft = input.draft === true || pushed.compileTime.length > 0;
      const body = implPrBody({ number, summary: im.report?.summary ?? im.plan?.summary ?? "", checks: input.checks, plan: im.planMd ?? im.plan?.plan ?? null, model: input.model,
        manifests: made.check.manifests, compileTime: pushed.compileTime, draft });
      const pr = await ghOpenPr(w, g, d.exec, "implement-pr", { repo, target: ref, base, head: `${fork.split("/")[0]}:${branch}`, title, body, draft },
        { by: "model", kind: "pull request", model: input.model }, { ...run, branch });
      const out = pr.stdout.trim().split("\n").pop() ?? "";
      if (pr.code !== 0 || !urlOk(out, repo)) return fail(`gh pr create: ${oneLine(pr.stderr || pr.stdout)}`, true);
      url = out;
      const bytes = Buffer.from(input.diff);
      if (!await write({ branch, prNumber: prNumberOf(url), prUrl: url, diffHash: createHash("sha256").update(bytes).digest("hex"), diffStat: diffStat(bytes) })) return stale();
      d.log(`  ${ref}: opened ${url}`);
    } else {
      const last = await lastPush(db, im, branch);
      if (!last) return fail(`${url} was not pushed by this implementation`, false);
      pushed = last;
      if (im.prUrl !== url) {
        if (!await write({ branch, prNumber: prNumberOf(url), prUrl: url })) return stale();
        d.log(`  ${ref}: adopted ${url}`);
      }
    }
    const prNumber = prNumberOf(url);

    if (!g) {
      const gi = await guard();
      if (typeof gi === "string") return fail(gi, true);
      g = gi;
    }
    if (!await mirrorPr(db, d, repo, prNumber)) return fail(`#${prNumber} is not in the mirror yet`, true);
    const row = await db.get(db.k.selectFrom("main.items").select(["is_draft", "head_oid"]).where("repo", "=", repo).where("number", "=", prNumber));
    if (row?.head_oid !== pushed.commit) return fail(`#${prNumber}'s head ${(row?.head_oid ?? "").slice(0, 12)} is not the commit this implementation pushed (${pushed.commit.slice(0, 12)})`, false);
    const isDraft = input.draft === true || pushed.compileTime.length > 0 || !!row?.is_draft;
    let notPreapproved: string | null = null;
    if (pushed.compileTime.length) notPreapproved = `a maintainer decides on its compile-time changes: ${pushed.compileTime.map((c) => `${c.path} ${c.what}`).join("; ")}`;
    else if (isDraft) notPreapproved = "a draft is not pre-approved";
    else if (await repoWorkflow(db, repo) === "new" && !(await liveWorkflow(db, repo, number))?.approvedBy) {
      // On the maintainer workflow the PR merges only when its issue's workflow is approved; otherwise its review ends in a recommendation.
      notPreapproved = "the merge is not approved: the review ends in a recommendation";
    } else {
      // On the maintainer workflow the approver's merge leg belongs to the issue's workflow (src/workflow/advance.ts).
      const wf = await repoWorkflow(db, repo) === "new" ? await liveWorkflow(db, repo, number) : null;
      try {
        await preapproveMerge(db, { repo, number: prNumber, by: wf?.approvedBy ?? im.queuedBy, via: "implement", head: pushed.commit, ...(wf ? { workflowId: wf.id } : {}) });
      } catch (e) {
        const why = oneLine(String((e as Error).message ?? e));
        if (!(e instanceof PreapprovalRefused)) return fail(`#${prNumber} could not be pre-approved: ${why}`, true);
        if (!e.active) { notPreapproved = why; d.log(`  ${ref}: #${prNumber} not pre-approved: ${why}`); }
      }
    }
    try {
      const weight = (await db.get(db.k.selectFrom("main.fast_track").select("weight").where("repo", "=", repo).where("number", "=", number)))?.weight;
      await addFastTrack(db, im.queuedBy, `${repo}#${prNumber}`, weight ?? undefined, "implement");
    } catch (e) {
      d.log(`  ${ref}: #${prNumber} not fast-tracked: ${oneLine(String((e as Error).message ?? e))}`);
    }
    const commented = await commentOnce(db, d, g, im, { number: prNumber, url, draft: isDraft }, input.run);
    if (commented !== null) return fail(`the issue comment failed: ${commented}`, true);
    if (!await write({ branch, prNumber, prUrl: url, reason: notPreapproved }, "pr-opened")) return stale();
    return { ok: true, url, number: prNumber, branch, adopted, draft: isDraft, notPreapproved };
  } catch (e) {
    return fail(oneLine(String((e as Error).message ?? e)), true);
  }
}
