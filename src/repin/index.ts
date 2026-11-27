// Autorepin: a pull request that depends on an unmerged pull request of another tracked repository (a craft-libs change,
// say) pins that repository's crates to a commit of its branch. Someone who may queue items on the repo comments
//
//   @<app-slug> autorepin storytold/craft-libs#12        (also `craft-libs#12`, the pull request's URL, or `off`)
//   @<app-slug> autorepin storytold/craft-libs#12 via next
//
// and once that pull request is merged into its default branch, this one gets a commit that sets the `rev` of every Cargo
// git dependency on that repository to the merge commit, with Cargo.lock updated to match. With `via <branch>` the pin is
// instead the first commit of that branch's first-parent history that holds the merge (the merge into the branch, or the
// pull request's merge itself when it was merged into the branch directly), so nothing else of the branch comes along; until
// the merge reaches the branch the autorepin waits, looking again every 15 minutes, for at most 7 days. No model is involved:
//  - the manifests are rewritten here (src/repin/manifest.ts): only `rev` strings change;
//  - Cargo.lock is written by `cargo update --workspace` in a build environment, never on this host, and is accepted only
//    if it adds nothing but crates.io packages and the dependency at the merge commit;
//  - the commit is pushed with a lease on the head it was made on (pushRepin in src/github/write.ts), under the repo's
//    Pushes approval, after the access of the person who asked is read again.
// The outcome (pushed, failed with the reason, or dropped because the dependency's pull request closed unmerged) is a
// comment on the pull request, unless the pull request is quiet. Only reasons written here reach the comment; any other
// error is logged and the comment gives a fixed reason.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { absolute } from "../build/artifacts.ts";
import { cancelTask, createTask, getTask, TERMINAL } from "../build/tasks.ts";
import { guardRepo } from "../core/guard.ts";
import { taskInScope } from "../core/scope.ts";
import { WRITE_PERMISSIONS } from "../dash/server/provider.ts";
import { HttpError } from "../dash/server/util.ts";
import { ensureAuthorWrites, type PermissionReader } from "../fixup/author-permission.ts";
import { exec as defaultExec, fixupDir, Git, type Exec } from "../fixup/git.ts";
import { longLivedOf, pushable } from "../fixup/pushable.ts";
import { boundAccess } from "../github/commands.ts";
import { commitIdentity } from "../github/identity.ts";
import { pipelineAccount } from "../github/pipeline-account.ts";
import { ghComment, pushRepin, WritePacedError, type Writer } from "../github/write.ts";
import type { Querier } from "../mirror.ts";
import { ownerOf, slugOf } from "../owners.ts";
import { appPermission } from "../remote/permission.ts";
import { loadQuiet } from "../data/security/index.ts";
import { actRefusal } from "../github/identity.ts";
import { fetchScript } from "../worker/rust.ts";
import { BRANCH_MAX_MS, BRANCH_POLL_MS, LOCK_MAX_MS, RETRY_MS, repinsDue, type RepinRow } from "./due.ts";
import { lockRefusal, repinManifest, safePath, type PrRef } from "./manifest.ts";
import { addAudit, loadTrackedRepos } from "../data/control/index.ts";
import { loadItems } from "../data/mirror/index.ts";
import { loadArtifactFiles } from "../data/build/index.ts";
import { loadRepinOffs, loadRepins, loadStartedRefs, requestRepin as writeRepin, saveRepins, type RepinKey, type RepinPatch } from "../data/workflow/index.ts";
import type { Db } from "../db/index.ts";

/** Attempts that may end unfinished (GitHub unreadable, the head moved, the lockfile task failed) before the repin is given up. */
export const MAX_TRIES = 5;
/** Cargo.toml files read in one pull request. */
const MAX_MANIFESTS = 500;
const LOCK = "Cargo.lock";
const AUDIT_LOGIN = "autorepin";
/** The reason given on GitHub for an attempt that ended on an error this module did not word. */
const UNEXPECTED = "an unexpected error stopped it (the AutoCraft log has the details)";

/**
 * The lockfile step: the manifests arrive repinned (the task's patch), Cargo brings Cargo.lock in line with them, changing
 * nothing else it does not have to (`--workspace`), and the result is the task's artifact. The environment is the fetch
 * step's (src/worker/rust.ts): no repository cargo config, no toolchain file, and nothing of the repository runs.
 */
export const LOCK_SCRIPT = fetchScript(["/usr/local/cargo/bin/cargo update --workspace", `/bin/cp ${LOCK} /out/${LOCK}`]);

const MERGE_QUERY = `query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    pullRequest(number: $n) { state baseRefName mergedAt mergeCommit { oid } }
  }
}`;
const BRANCH_QUERY = `query($owner: String!, $name: String!, $ref: String!) {
  repository(owner: $owner, name: $name) { ref(qualifiedName: $ref) { name } }
}`;
const PR_QUERY = `query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $n) {
      state headRefOid headRefName maintainerCanModify
      headRepository { nameWithOwner }
      headRef { branchProtectionRule { id } }
    }
  }
}`;
type MergeRead = { repository?: { defaultBranchRef?: { name: string } | null; pullRequest?: { state: string; baseRefName: string; mergedAt?: string | null; mergeCommit?: { oid: string } | null } | null } | null };
type PrRead = { repository?: { pullRequest?: { state: string; headRefOid: string; headRefName: string; maintainerCanModify: boolean; headRepository: { nameWithOwner: string } | null; headRef?: { branchProtectionRule?: { id: string } | null } | null } | null } | null };

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 300).replace(/[.\s]+$/, "");
const short = (sha: string): string => sha.slice(0, 12);
const refOf = (r: { repo: string; number: number }): string => `${r.repo}#${r.number}`;
const depRefOf = (r: { ref_repo: string; ref_number: number }): string => `${slugOf(r.ref_repo)}#${r.ref_number}`;
type Item = { kind: string; state: string };
/** The mirror's kind and state of each pull request asked for, keyed `repo#number`. */
const itemsOf = async (db: Db, refs: { repo: string; number: number }[]): Promise<Map<string, Item>> =>
  await loadItems(db, refs, "ref");

// ---- the command ---------------------------------------------------------------

/** Why no build worker would take the pull request's lockfile task (taskInScope), or null. */
async function outOfBuildScope(db: Db, repo: string, number: number): Promise<string | null> {
  const [tracked, started] = await db.together(() => Promise.all([loadTrackedRepos(db, [repo]), loadStartedRefs(db, { refs: [{ repo, number }] })]));
  return taskInScope(tracked.get(repo), [`${repo}#${number}`], started) ? null : `AutoCraft's pipeline is off for ${slugOf(repo)}, so no build worker would write its lockfile`;
}

/** Cancels a lockfile task that is no longer wanted; one that already ended is left as it is. */
async function stopTask(db: Db, id: number | null): Promise<void> {
  if (id === null) return;
  try { await cancelTask(db, id, AUDIT_LOGIN); } catch { /* already ended, or gone */ }
}

/** Why `login` may not do `what` on `repo` by the act rule (actRefusal), or null. `canWrite`: the person's write access on `repo`, read by the caller. */
async function actRefusalText(db: Db, login: string, canWrite: boolean, repo: string, what: string): Promise<string | null> {
  const no = await actRefusal(db, { login, canWrite: async (r) => r === repo && canWrite }, repo);
  return no === null ? null : `only an operator, or a maintainer with write access where the app acts for them, ${what}`;
}

/** A refusal worded for the answer on GitHub. */
const refused = (why: string): HttpError => new HttpError(409, why);

/**
 * Sets (or with `ref` null, drops) the autorepin of a pull request for the commenter of a command. Who may is the rule of
 * every write a person starts (actRefusal). Returns what the answer says; throws an HttpError with the
 * reason when refused. `at` orders the commands of a pull request: a command older than an `off` or than the command that set
 * the row sets nothing.
 */
export async function requestRepin(db: Db, o: { login: string; githubId: number; role: string; canWrite: boolean; /** The caller applied its own rule of who may act (the maintainer workflow's actRefusal). */ authorized?: boolean; repo: string; number: number; pr: boolean; ref: PrRef | null; /** Reads the `via` branch when the command is accepted; without it, or when the read fails, the branch is not checked. */ querier?: Querier; /** `via <branch>`, validated by the parser (parseBranch). */ branch?: string | null; /** When the command was given (the comment's time). */ at?: Date }): Promise<string> {
  if (!o.pr) throw refused("autorepin is for pull requests");
  const refusal = o.authorized ? null : await actRefusalText(db, o.login, o.canWrite, o.repo, `sets autorepin on ${o.repo}`);
  if (refusal) throw refused(refusal);
  const at = (o.at ?? new Date()).toISOString();
  const ref = o.ref;
  const [items, tracked, offs] = await db.together(() => Promise.all([
    itemsOf(db, [{ repo: o.repo, number: o.number }]), loadTrackedRepos(db), ref ? loadRepinOffs(db, [{ repo: o.repo, number: o.number }]) : Promise.resolve(new Map<string, string>()),
  ]));
  const me = items.get(refOf(o));
  if (me?.kind !== "pr" || me.state !== "OPEN") throw refused("this pull request is not open");
  if (!ref) {
    // The off marker is kept even when nothing waits, so an older `autorepin` command still to be carried out (a retry) does not set it again.
    const r = await db.write(async () => {
      const r = await writeRepin(db, { repo: o.repo, number: o.number, refRepo: "", refNumber: 0, refBranch: null, login: o.login, githubId: o.githubId, off: true, at });
      await addAudit(db, [{ login: o.login, action: "autorepin-off", target: refOf(o), details: { cancelled: r.cancelled } }]);
      return r;
    });
    for (const t of r.cancelledTasks) await stopTask(db, t);
    return r.cancelled ? "Autorepin is off for this pull request" : "No autorepin was waiting on this pull request; it stays off";
  }
  const off = offs.get(refOf(o));
  if (off !== undefined && off > at) throw refused("a later autorepin off on this pull request stands");
  const want = ref.name.toLowerCase();
  const dep = [...tracked.keys()].find((n) => n.toLowerCase() === want);
  if (!dep || (ref.owner !== null && ref.owner.toLowerCase() !== ownerOf(dep).toLowerCase())) throw refused(`${ref.owner ? `${ref.owner}/` : ""}${ref.name} is not a repository AutoCraft tracks`);
  const depRef = `${slugOf(dep)}#${ref.number}`;
  if (dep === o.repo) throw refused("the pull request to wait for must be in another repository");
  const other = (await itemsOf(db, [{ repo: dep, number: ref.number }])).get(`${dep}#${ref.number}`);
  if (other?.kind !== "pr") throw refused(`${depRef} is not a pull request AutoCraft has read`);
  if (other.state === "CLOSED") throw refused(`${depRef} was closed without merging`);
  const g = await guardRepo(db, o.repo, "push", { operator: o.login }, o.login);
  if ("refused" in g) throw refused(g.refused);
  const scope = await outOfBuildScope(db, o.repo, o.number);
  if (scope) throw refused(scope);
  if (o.branch && o.querier) {
    const here = await o.querier.query(BRANCH_QUERY, { owner: ownerOf(dep), name: dep, ref: `refs/heads/${o.branch}` }).then((x) => (x as { repository?: { ref?: unknown } | null }).repository, () => undefined);
    if (here && here.ref == null) throw refused(`${slugOf(dep)} has no branch ${o.branch}`);
  }
  // Only over a row of an earlier command: a later `off`, or a later command for the same repository, stands.
  const branch = o.branch ?? null;
  try {
    await db.write(async () => {
      await writeRepin(db, { repo: o.repo, number: o.number, refRepo: dep, refNumber: ref.number, refBranch: branch, login: o.login, githubId: o.githubId, at });
      await addAudit(db, [{ login: o.login, action: "autorepin-set", target: refOf(o), details: { on: depRef, ...(branch ? { via: branch } : {}) } }]);
    });
  } catch (e) {
    const m = (e as Error).message;
    if (m.includes("later autorepin off")) throw refused("a later autorepin off on this pull request stands");
    if (m.includes("later autorepin command")) throw refused(`a later autorepin command for ${slugOf(dep)} on this pull request stands`);
    throw e;
  }
  if (branch) {
    const to = `the first \`${branch}\` commit that contains it`;
    return other.state === "MERGED"
      ? `Autorepin set: ${depRef} is already merged, so ${slugOf(dep)} is repinned here to ${to} once \`${branch}\` has it`
      : `Autorepin set: once ${depRef} is merged and on \`${branch}\`, ${slugOf(dep)} is repinned here to ${to}, in a commit pushed to this branch`;
  }
  return other.state === "MERGED"
    ? `Autorepin set: ${depRef} is already merged, so ${slugOf(dep)} is repinned to its merge commit here now`
    : `Autorepin set: once ${depRef} is merged, ${slugOf(dep)} is repinned to its merge commit here, in a commit pushed to this branch`;
}

// ---- the work ------------------------------------------------------------------

export type RepinDeps = {
  querier: Querier;
  /** Runs git and gh. */
  exec?: Exec;
  /** Directory holding one bare cache repository per repo (default: the fix-ups'). */
  root?: string;
  /** Reads the asker's live write permission (default: through the app installation, as comment commands read it). */
  permission?: (q: Querier, repo: string, login: string) => Promise<"ok" | "no" | "transient">;
  /** Reads a same-repo PR author's permission (default: gh). */
  authorPermission?: PermissionReader;
  now?: () => Date;
  log?: (l: string) => void;
  /** Replaces the installation-token minter of the app identity (tests). */
  mint?: Writer["mint"];
  /** Autorepins that call GitHub in one drain. */
  limit?: number;
};

/** The step ended for good; `notice` "none": nothing is said on GitHub (the pull request itself is closed). */
class Ended extends Error {
  readonly state: "failed" | "cancelled" | "pushed";
  readonly notice: "none" | null;
  readonly toHead: string | null;
  constructor(state: "failed" | "cancelled" | "pushed", result: string | null, o: { notice?: "none"; toHead?: string } = {}) {
    super(result ?? "");
    this.state = state;
    this.notice = o.notice ?? null;
    this.toHead = o.toHead ?? null;
  }
}
/** `why` is worded here and safe to post. */
const failed = (why: string): Ended => new Ended("failed", oneLine(why));
/** The attempt did not finish and is tried again; the reason is worded here and is the outcome's when the tries run out. */
class Retry extends Error {}
/** The merge is not on the `via` branch yet: looked for again after BRANCH_POLL_MS, without counting a try. */
class Wait extends Error {}
/** The row no longer holds the request the step started on (an `off`, or a newer command, came meanwhile): nothing of the step is written. */
class Superseded extends Error {}

/** True while the row still holds the request `r` was read with: an `off` and a new command both move requested_at, and an end moves the state. */
const still = async (db: Db, r: RepinRow): Promise<boolean> => !!await reread(db, r, { state: r.state, requestedAt: r.requested_at });

/** The stored row of `r`'s pull request and dependency (optionally only while it holds `state` and `requestedAt`), or null. */
async function reread(db: Db, r: RepinRow, o: { state?: string; requestedAt?: string } = {}): Promise<RepinRow | null> {
  const row = (await loadRepins(db, [{ repo: r.repo, number: r.number }])).get(refOf(r))?.find((x) => x.ref_repo === r.ref_repo);
  if (!row || (o.state !== undefined && row.state !== o.state) || (o.requestedAt !== undefined && row.requested_at !== o.requestedAt)) return null;
  return row as RepinRow;
}

/** The row's key; its pair, dependency and asker as read. */
const keyOf = (r: RepinRow): RepinKey => ({ repo: r.repo, number: r.number, refRepo: r.ref_repo, refNumber: r.ref_number, login: r.login });
const patchRow = async (db: Db, r: RepinRow, patch: RepinPatch): Promise<void> => void await saveRepins(db, [{ key: keyOf(r), patch }]);

async function finish(db: Db, r: RepinRow, e: Ended, at: Date): Promise<void> {
  await stopTask(db, r.task_id);
  await db.write(async () => {
    await patchRow(db, r, { state: e.state, result: e.message || null, done_at: at.toISOString(), to_head: e.toHead, notice: e.notice });
    await addAudit(db, [{ login: AUDIT_LOGIN, action: "autorepin", target: refOf(r), details: { on: depRefOf(r), by: r.login, state: e.state, ...(e.message ? { result: e.message } : {}), ...(e.toHead ? { commit: e.toHead } : {}) } }]);
  });
}

/** One step of an autorepin: from `waiting` it queues the lockfile task (or pushes, without a lockfile); from `locking` it takes the task's lockfile and pushes. Throws `Ended` when it is over, anything else to try again. */
async function step(db: Db, r: RepinRow, d: RepinDeps): Promise<void> {
  const q = d.querier, run = d.exec ?? defaultExec;
  const dep = slugOf(r.ref_repo), depRef = depRefOf(r);
  if (r.state === "locking" && r.task_id !== null) {
    // A task no build worker finished in time ends the autorepin instead of holding it.
    const t = await getTask(db, r.task_id);
    if (t && !TERMINAL.includes(t.state) && (d.now ?? (() => new Date()))().getTime() - Date.parse(t.queuedAt) > LOCK_MAX_MS) {
      try { await cancelTask(db, t.id, AUDIT_LOGIN); } catch { /* it ended meanwhile */ }
      throw failed("the lockfile task did not end within 3 hours");
    }
  }
  const items = await itemsOf(db, [{ repo: r.repo, number: r.number }, { repo: r.ref_repo, number: r.ref_number }]);
  const me = items.get(refOf(r));
  if (me?.kind !== "pr" || me.state !== "OPEN") throw new Ended("cancelled", null, { notice: "none" });
  const other = items.get(`${r.ref_repo}#${r.ref_number}`);
  if (!other) throw failed(`AutoCraft no longer has ${depRef}`);
  if (other.state === "CLOSED") throw new Ended("cancelled", `${depRef} was closed without merging, so nothing was repinned`);

  // The merge commit, from GitHub: it must be on the default branch, where the dependency's revs are to come from, or with
  // `via` on the default branch or the named one.
  const m = await q.query(MERGE_QUERY, { owner: ownerOf(r.ref_repo), name: r.ref_repo, n: r.ref_number }) as MergeRead;
  const merged = m.repository?.pullRequest;
  if (!merged) throw new Retry(`GitHub returned no ${depRef}`);
  if (merged.state === "CLOSED") throw new Ended("cancelled", `${depRef} was closed without merging, so nothing was repinned`);
  if (merged.state !== "MERGED") throw new Retry(`${depRef} is not merged on GitHub yet`);
  const main = m.repository?.defaultBranchRef?.name;
  if (!main) throw new Retry(`GitHub returned no default branch for ${dep}`);
  const via = r.ref_branch;
  if (merged.baseRefName !== main && merged.baseRefName !== via) {
    throw failed(`${depRef} was merged into ${merged.baseRefName}, not into ${dep}'s default branch ${main}${via ? ` or ${via}` : ""}`);
  }
  const sha = merged.mergeCommit?.oid ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Retry(`GitHub returned no merge commit for ${depRef}`);
  // The branch as it is now: a branch rewritten since the merge may no longer hold the commit.
  const root = d.root ?? fixupDir();
  mkdirSync(root, { recursive: true });
  const depGit = new Git(run, root, r.ref_repo);
  const onBranch = async (branch: string): Promise<{ tip: string; on: boolean }> => {
    const tip = await depGit.fetchBase(ownerOf(r.ref_repo), r.ref_repo, branch, `refs/repin/branch/${createHash("sha256").update(branch).digest("hex")}`).catch((e: unknown) => {
      d.log?.(`autorepin ${refOf(r)}: fetching ${dep} ${branch}: ${oneLine(String((e as Error)?.message ?? e))}`);
      throw new Retry(`${dep}'s branch ${branch} could not be fetched`);
    });
    // The fetch brought every commit the branch holds: one that is not here is not on it.
    const have = (await depGit.git(["cat-file", "-e", `${sha}^{commit}`])).code === 0;
    const on = have ? await depGit.git(["merge-base", "--is-ancestor", sha, tip]) : { code: 1, stderr: "" };
    if (on.code !== 0 && on.code !== 1) throw new Error(`the merge commit of ${depRef} could not be looked up on ${dep}'s ${branch}: ${oneLine(on.stderr)}`);
    return { tip, on: on.code === 0 };
  };
  // The commit pinned to, and how the comment and the commit name it.
  let target = sha, what = `the merge of ${depRef}`;
  if (merged.baseRefName === main && !(await onBranch(main)).on) throw failed(`the merge commit of ${depRef} is no longer on ${dep}'s default branch ${main}`);
  if (via) {
    const b = await onBranch(via);
    if (!b.on) {
      if (merged.baseRefName === via) throw failed(`the merge commit of ${depRef} is no longer on ${dep}'s ${via}`);
      // Merged into the default branch and not brought into `via` yet.
      const mergedAt = Date.parse(merged.mergedAt ?? "");
      const since = Number.isFinite(mergedAt) ? mergedAt : Date.parse(r.requested_at);
      const now = (d.now ?? (() => new Date()))();
      if (now.getTime() - since > BRANCH_MAX_MS) throw failed(`${depRef} has not reached ${dep}'s ${via} within ${BRANCH_MAX_MS / 86_400_000} days of its merge`);
      throw new Wait(`${depRef} is merged but not on ${dep}'s ${via} yet`);
    }
    target = await firstHolding(depGit, sha, b.tip);
    what = target === sha ? `the merge of ${depRef}, on ${via}` : `the first ${via} commit that contains ${depRef}`;
  }
  // The pin found again while the lockfile was written must be the one the task was given.
  if (r.state === "locking" && r.sha !== null && r.sha !== target) throw new Retry(`the commit of ${dep}'s ${via ?? main} to pin to changed while the lockfile was written`);

  // Whoever asked must still be allowed to, with the login still bound to the GitHub account that asked, and the repo must
  // still approve pushes.
  const permission = d.permission ?? (async (_q: Querier, repo: string, login: string) => {
    const a = await appPermission(db, login, repo);
    return a.kind === "ok" ? (WRITE_PERMISSIONS.has(a.permission) ? "ok" as const : "no" as const) : "transient" as const;
  });
  const p = await permission(q, r.repo, r.login).catch(() => "transient" as const);
  if (p === "transient") throw new Retry(`GitHub could not tell ${r.login}'s access to ${slugOf(r.repo)}`);
  const access = await boundAccess(db, r);
  if (!access) throw failed(`${r.login} no longer has an AutoCraft login bound to the GitHub account that asked`);
  if (access.role !== "operator" && (await loadQuiet(db, [`${r.repo}#${r.number}`])).size > 0) throw failed("the pull request is quiet until its fix is published");
  const refusal = await actRefusalText(db, r.login, p === "ok", r.repo, `repins on ${r.repo}`);
  if (refusal) throw failed(refusal);
  const g = await guardRepo(db, r.repo, "push", { operator: r.login }, r.login);
  if ("refused" in g) throw failed(g.refused);

  const l = await q.query(PR_QUERY, { owner: ownerOf(r.repo), name: r.repo, n: r.number }) as PrRead;
  const pr = l.repository?.pullRequest;
  if (!pr) throw new Retry(`GitHub returned no ${refOf(r)}`);
  if (pr.state !== "OPEN") throw new Ended("cancelled", null, { notice: "none" });
  const head = pr.headRefOid;
  if (r.state === "locking" && r.head !== head) throw new Retry("the head moved while the lockfile was written");
  const headRepo = pr.headRepository?.nameWithOwner;
  const writes = headRepo ? await ensureAuthorWrites(db, r.repo, r.number, headRepo, d.authorPermission) : "no";
  if (writes === "unknown") throw new Retry("the author's permission could not be read yet");
  if (!headRepo || !pushable(headRepo, r.repo, pr.maintainerCanModify, pr.headRefName, await longLivedOf(db, r.repo), !!pr.headRef?.branchProtectionRule, writes === "yes")) {
    throw failed("AutoCraft cannot push to this pull request's branch (a fork that does not allow maintainer edits, or a protected or shared branch)");
  }

  const git = new Git(run, root, r.repo);
  const fetched = await git.fetchPr(ownerOf(r.repo), r.repo, r.number);
  if (fetched !== head) throw new Retry(`the fetched head ${short(fetched)} is not the head GitHub reports`);
  const paths = (await git.must(["ls-tree", "-r", "--name-only", "-z", head])).split("\0").filter(Boolean);
  const manifests = paths.filter((p) => /(^|\/)Cargo\.toml$/.test(p));
  if (manifests.length > MAX_MANIFESTS) throw failed(`the pull request has more than ${MAX_MANIFESTS} Cargo.toml files`);
  // Only the root Cargo.lock is written by the task; a workspace below the root with its own lockfile would keep a stale one.
  const nested = paths.find((x) => x !== LOCK && /\/Cargo\.lock$/.test(x));
  if (nested) throw failed(`${safePath(nested, "a Cargo.lock")} is a lockfile below the repository root, which autorepin does not update`);
  const name = r.ref_repo.toLowerCase();
  const files: { path: string; mode: string; content: string }[] = [];
  let pinned = 0, unpinned = 0;
  for (const path of manifests) {
    const f = await git.file(head, path);
    // Every manifest is read: one that cannot be (a failed read, a link, too large) ends the try, so a repin never covers only some of them.
    if (!f.ok) {
      d.log?.(`autorepin ${refOf(r)}: ${path}: ${oneLine(f.reason)}`);
      throw new Retry(`${safePath(path, "a Cargo.toml")} could not be read`);
    }
    // A manifest that never names the repository (a test fixture, say) is not read as TOML at all.
    if (!f.content.toLowerCase().includes(name)) continue;
    const out = repinManifest(f.content, dep, target);
    if (!out.ok) {
      d.log?.(`autorepin ${refOf(r)}: ${path}: ${out.reason}${out.detail ? `: ${oneLine(out.detail)}` : ""}`);
      throw failed(`${safePath(path, "a Cargo.toml")}: ${out.reason}`);
    }
    pinned += out.pinned;
    unpinned += out.unpinned;
    if (out.from.length) files.push({ path, mode: f.mode, content: out.text });
  }
  if (!pinned) throw failed(`no Cargo.toml of this pull request pins ${dep} by rev${unpinned ? ` (${unpinned} use a branch, a tag or no rev, which autorepin leaves alone)` : ""}`);
  if (!files.length) {
    // The head is the commit an earlier try pushed (the outcome was not recorded): keep it, so a merge pre-approved at the old head carries on (ownPush in src/preapproval).
    if (r.to_head !== null && r.to_head === head) throw new Ended("pushed", `Repinned ${dep} to ${short(target)}, ${what}, in ${short(head)}`, { toHead: head });
    throw new Ended("pushed", `${dep} is already pinned to ${short(target)}, ${what}; nothing to change`);
  }

  const scratch = mkdtempSync(join(root, ".index-"));
  try {
    let tree = await git.withFiles(head, files, join(scratch, "index"));
    const changed = files.map((f) => f.path);
    if (paths.includes(LOCK)) {
      const lock = await git.file(head, LOCK);
      if (!lock.ok) {
        d.log?.(`autorepin ${refOf(r)}: ${LOCK}: ${oneLine(lock.reason)}`);
        throw failed(`${LOCK} could not be read`);
      }
      if (r.state !== "locking") {
        const scope = await outOfBuildScope(db, r.repo, r.number);
        if (scope) throw failed(scope);
        const patch = await git.diffText(head, tree);
        // From here to the row's update nothing awaits, so the task is queued only for a request that still stands.
        if (!await still(db, r)) throw new Superseded("the request changed during the try");
        const id = await createTask(db, {
          step: "autorepin", repo: r.repo, number: r.number, headSha: head, requires: { os: "linux", toolchains: ["rust-stable"] }, patch,
          plan: [{ name: "lock", cmd: ["sh", "-c", LOCK_SCRIPT], network: "fetch", timeoutSec: 900, artifacts: [LOCK] }],
        });
        await patchRow(db, r, { state: "locking", sha: target, head, to_head: null, task_id: id });
        d.log?.(`autorepin ${refOf(r)}: lockfile task ${id} queued for ${dep} at ${short(target)}`);
        return;
      }
      const t = r.task_id === null ? null : await getTask(db, r.task_id);
      if (!t || t.state !== "done") throw new Retry(`the lockfile task ${t ? t.state : "is gone"}`);
      const art = (await loadArtifactFiles(db, [{ taskId: t.id, name: LOCK }])).get(`${t.id}/${LOCK}`);
      const file = art ? absolute(art) : null;
      if (!file) throw new Retry("the lockfile task returned no Cargo.lock");
      const after = readFileSync(file, "utf8");
      const no = lockRefusal(lock.content, after, dep, target);
      if (no) throw failed(no);
      if (after !== lock.content) {
        tree = await git.withFiles(tree, [{ path: LOCK, mode: lock.mode, content: after }], join(scratch, "index"));
        changed.push(LOCK);
      }
    }
    const who = await commitIdentity(db, r.repo, () => pipelineAccount(run));
    const commit = await git.commit(tree, head, `Repin ${r.ref_repo} to ${short(target)}\n\n${what[0]!.toUpperCase()}${what.slice(1)}.\n`, { name: who.name, email: who.email });
    // The commit is exactly the rewritten manifests and the lockfile: contents of files that exist, nothing added, removed or re-moded.
    const changes = await git.rawChanges(head, commit);
    if (changes.some((x) => x[2] !== "M" || x[0] !== x[1]) || changes.map((x) => x[3]!).sort().join("\n") !== [...changed].sort().join("\n")) throw failed("the commit would change more than the revs and the lockfile");
    if (!await still(db, r)) throw new Superseded("the request changed before the push");
    // Written before the push, so a head that reaches the mirror before the outcome is recorded is already known as this commit (ownPush in src/preapproval).
    await patchRow(db, r, { head, to_head: commit });
    const push = await pushRepin({ db, login: AUDIT_LOGIN, mint: d.mint }, g, git, { repo: r.repo, number: r.number, remote: headRepo, branch: pr.headRefName, head, sha: commit }, { on: depRef, rev: target, files: changed, by: r.login });
    if (push.code !== 0) {
      const err = oneLine(push.stderr);
      if (/stale info|rejected|fetch first/i.test(err)) throw new Retry("the branch moved before the push");
      if (/denied|403|permission|not allowed|protected branch|declined|GH013/i.test(err)) throw failed("GitHub refused the push to this pull request's branch");
      throw new Error(`the push failed: ${err}`);
    }
    throw new Ended("pushed", `Repinned ${dep} to ${short(target)}, ${what}, in ${short(commit)} (${changed.join(", ")})`, { toHead: commit });
  } finally {
    // A scratch folder that cannot be removed must not replace the outcome (a push that was made, a task that was queued).
    try { rmSync(scratch, { recursive: true, force: true }); } catch (e) { d.log?.(`autorepin ${refOf(r)}: scratch folder not removed: ${oneLine(String((e as Error)?.message ?? e))}`); }
  }
}

/**
 * The oldest commit of `tip`'s first-parent history that holds `sha` (an ancestor of `tip`): `sha` itself when that history
 * passes through it (a fast-forward, a squash or a merge straight into the branch), else the merge that brought it in. Along
 * that history, once a commit holds it every later one does, so the history is searched by halves.
 */
async function firstHolding(git: Git, sha: string, tip: string): Promise<string> {
  // The history down to the first commit that `sha` itself holds (excluded); newest first, so the tip comes first.
  const chain = (await git.must(["rev-list", "--first-parent", tip, `^${sha}`])).split("\n").map((x) => x.trim()).filter(Boolean);
  if (!chain.length) return sha;
  const holds = async (c: string): Promise<boolean> => {
    const r = await git.git(["merge-base", "--is-ancestor", sha, c]);
    if (r.code !== 0 && r.code !== 1) throw new Error(`git merge-base failed: ${oneLine(r.stderr)}`);
    return r.code === 0;
  };
  // chain[0], the tip, holds it: find the highest index (the oldest commit) that does.
  let lo = 0, hi = chain.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (await holds(chain[mid]!)) lo = mid;
    else hi = mid - 1;
  }
  const first = chain[lo]!;
  const parent = (await git.git(["rev-parse", "--verify", "--quiet", `${first}^1`])).stdout.trim();
  return parent === sha ? sha : first;
}

/** The comment that tells the outcome on the pull request. */
export function noticeText(r: Pick<RepinRow, "login" | "state" | "result" | "ref_repo">): string {
  if (r.state === "pushed") return `@${r.login} ${r.result}.`;
  return r.state === "cancelled" ? `@${r.login} Autorepin is off: ${r.result}.` : `@${r.login} Autorepin of ${slugOf(r.ref_repo)} failed: ${r.result}.`;
}

/** Posts the outcome. A paced write leaves it for the next drain; any other failure is logged and not retried. Nothing is posted on a quiet pull request. */
async function notify(db: Db, r: RepinRow, d: RepinDeps): Promise<"posted" | "failed" | "paced" | "none"> {
  // A quiet pull request (a security fix not yet published) gets no comment.
  if ((await loadQuiet(db, [`${r.repo}#${r.number}`])).size > 0) {
    await patchRow(db, r, { notice: "none" });
    return "none";
  }
  const g = await guardRepo(db, r.repo, null, { operator: r.login }, r.login);
  let notice: "posted" | "failed" = "failed";
  if ("refused" in g) d.log?.(`autorepin ${refOf(r)}: no comment: ${g.refused}`);
  else {
    try {
      const out = await ghComment({ db, login: AUDIT_LOGIN, mint: d.mint }, g, d.exec ?? defaultExec, "autorepin-comment", { repo: r.repo, number: r.number, pr: true }, { by: "fixed-operator" }, noticeText(r), { on: depRefOf(r), state: r.state, repin: r.requested_at });
      if (out.code === 0) notice = "posted";
      else d.log?.(`autorepin ${refOf(r)}: the comment failed: ${oneLine(out.stderr || out.stdout)}`);
    } catch (e) {
      if (e instanceof WritePacedError) return "paced";
      d.log?.(`autorepin ${refOf(r)}: the comment failed: ${oneLine(String((e as Error)?.message ?? e))}`);
    }
  }
  await patchRow(db, r, { notice });
  return notice;
}

/** Takes the next step of every autorepin that has one (src/repin/due.ts) and posts the outcomes. Returns how many ended. */
export async function drainRepins(db: Db, deps: RepinDeps): Promise<number> {
  const clock = deps.now ?? (() => new Date());
  let ended = 0, calls = 0;
  for (const r0 of await repinsDue(db, clock())) {
    if (calls++ >= (deps.limit ?? 5)) break;
    let r = r0;
    if (r.state === "waiting" || r.state === "locking") {
      try {
        await step(db, r, deps);
        continue;
      } catch (e) {
        if (e instanceof WritePacedError) break;
        // An `off` or a newer command came while the step awaited GitHub or git: the row is theirs now, so nothing of this
        // step is written (a Wait or a try would make an `off` row due again). A push that already went out was audited by pushRepin.
        if (!await still(db, r)) {
          if (!(e instanceof Ended && e.state === "pushed")) await stopTask(db, r.task_id);
          deps.log?.(`autorepin ${refOf(r)}: the request changed during the try; its outcome is not recorded: ${oneLine(String((e as Error)?.message ?? e))}`);
          continue;
        }
        if (e instanceof Ended) await finish(db, r, e, clock());
        else if (e instanceof Wait) {
          // Not a try, and it clears the count, so MAX_TRIES counts consecutive failures only: tried_at is set ahead, so the row is due again (repinsDue: a minute after tried_at) in BRANCH_POLL_MS.
          await stopTask(db, r.task_id);
          await patchRow(db, r, { state: "waiting", task_id: null, tries: 0, tried_at: new Date(clock().getTime() + BRANCH_POLL_MS - RETRY_MS).toISOString() });
          deps.log?.(`autorepin ${refOf(r)}: ${e.message}`);
          continue;
        } else {
          // Not finished: from the start again after a minute, and given up with the reason after MAX_TRIES. Only a reason
          // worded here (Retry) is posted. head and to_head stay: a push that went out before the error is still known as ours.
          const raw = oneLine(String((e as Error)?.message ?? e));
          deps.log?.(`autorepin ${refOf(r)}: try ${r.tries + 1} of ${MAX_TRIES}: ${raw}`);
          if (r.tries + 1 >= MAX_TRIES) await finish(db, r, failed(e instanceof Retry ? raw : UNEXPECTED), clock());
          else {
            await stopTask(db, r.task_id);
            await patchRow(db, r, { state: "waiting", task_id: null, tries: r.tries + 1, tried_at: clock().toISOString() });
            continue;
          }
        }
      }
      ended++;
      r = (await reread(db, r))!;
      deps.log?.(`autorepin ${refOf(r)}: ${r.state}${r.result ? `: ${r.result}` : ""}`);
    }
    if (r.notice === null && (await notify(db, r, deps)) === "paced") break;
  }
  return ended;
}
