// Landing a finding's private fix: the quiet pull request (default), the advisory route with a private fork, publishing,
// and detecting the merge. Every GitHub write goes through src/github/write.ts. Nothing about a finding reaches GitHub
// before an operator presses Land or Advisory.
import { ownPrSelect } from "../github/adopt.ts";
import { guardRepo } from "../core/guard.ts";
import type { By } from "../core/gates.ts";
import { Git, type Exec } from "../fixup/git.ts";
import { branchOf, forkOf } from "../github/fork.ts";
import { slugOf, ownerOf } from "../owners.ts";
import { githubIdentity } from "../github/identity.ts";
import {
  ghAdvisoryCreate, ghAdvisoryCve, ghAdvisoryRange, ghAdvisoryFork, ghAdvisoryPr, ghAdvisoryPublish, ghAdvisoryPush, ghLandPr, ghLandPush, httpStatus,
  type Writer,
} from "../github/write.ts";
import { crateOf } from "./fix.ts";
import { cachedCratesOf } from "../verify/crates.ts";
import { scanRow } from "./store.ts";
import { findingKey, advance, rawFinding, type FindingRow } from "./store.ts";
import { giveaway, landBody, nameGiveaway } from "./rules.ts";
import type { ExecResult } from "../fixup/git.ts";
import { addAudit } from "../data/control/index.ts";
import { claimMark } from "../data/jobs/index.ts";
import { listMerges } from "../data/merge/index.ts";
import { loadItems, type ItemOf } from "../data/mirror/index.ts";
import * as sec from "../data/security/index.ts";
import type { Db } from "../db/index.ts";

const ACTOR = "security";
const auditAs = (db: Db, action: string, target: string, details: Record<string, unknown>): Promise<void> => addAudit(db, [{ login: ACTOR, action, target, details }]);
const oneLine = (s: string, max = 300): string => s.replace(/\s+/g, " ").trim().slice(0, max);

export type LandDeps = {
  exec: Exec;
  root: string;
  /** The pipeline account's login and noreply email. */
  who: () => Promise<{ login: string }>;
  log: (line: string) => void;
  /** Pause between polls for a new fork; defaults to a timer. */
  sleep?: (ms: number) => Promise<void>;
};

const PR_URL = /https:\/\/github\.com\/(\S+?)\/pull\/(\d+)/;
/** The number of the pull request at `url` when it is in `slug`, else null. */
const prNumber = (url: string, slug: string): number | null => {
  const m = PR_URL.exec(url);
  return m && m[1]!.toLowerCase() === slug.toLowerCase() ? Number(m[2]) : null;
};
/** The giveaway word in text bound for GitHub: the title, the body and the branch. */
const wordedIn = (...texts: string[]): string | null => texts.map((t) => giveaway(t) ?? nameGiveaway(t)).find((w) => w) ?? null;

/** Back to `ready` with the reason, after a failure that leaves the fix intact. */
async function back(db: Db, repo: string, n: number, why: string, log: (l: string) => void, set: Record<string, string | number | null> = {}): Promise<string> {
  await advance(db, repo, n, ["landing"], "ready", { ...set, note: oneLine(why, 400) });
  log(`${repo} finding ${n}: not landed: ${oneLine(why, 200)}`);
  return `finding ${n}: not landed: ${oneLine(why, 120)}`;
}

/** The fix commit, when the bare cache still has it. */
async function haveCommit(git: Git, row: FindingRow): Promise<boolean> {
  return !!row.fix_commit && (await git.git(["cat-file", "-e", `${row.fix_commit}^{commit}`])).code === 0;
}

/**
 * The quiet landing: the commit goes to the pipeline's fork under a neutral branch and a plain pull request is opened.
 * The finding stays `landing` with `fix_pr` set; `pollLanding` moves it to `landed` when the pull request merges.
 */
export async function runLand(db: Db, repo: string, n: number, by: By, d: LandDeps): Promise<string> {
  const row = await rawFinding(db, repo, n);
  if (!row || row.state !== "landing") return `finding ${n}: not landing`;
  const key = findingKey(repo, n);
  const w: Writer = { db, login: ACTOR };
  try {
    if (!row.fix_commit || !row.fix_title || !row.fix_summary || !row.fix_branch) return await back(db, repo, n, "the finding has no fix to land", d.log);
    const git = new Git(d.exec, d.root, repo);
    if (!(await haveCommit(git, row))) return await back(db, repo, n, "the fix commit is gone from the local cache; write the fix again", d.log);
    const g = await guardRepo(db, repo, "security", by);
    if ("refused" in g) return await back(db, repo, n, g.refused, d.log);
    const who = await d.who();
    const base = await branchOf(db, repo);
    const body = landBody(row.fix_summary);
    // Nothing is pushed or opened before the whole public text has passed the wording guard.
    const worded = wordedIn(row.fix_title, body, row.fix_branch);
    if (worded) return await back(db, repo, n, `the text for GitHub says "${worded}"; write the fix again`, d.log);
    // On an app repo the branch lives in the base repository, so its head owner is the org.
    const headOwners = [who.login, ...(await githubIdentity(db) === "app" ? [ownerOf(repo)] : [])];
    const sel = await ownPrSelect(db, repo, headOwners, base);
    const found = await d.exec("gh", ["pr", "list", "--repo", slugOf(repo), "--state", "open", "--head", row.fix_branch, "--json", sel.json, "--jq", sel.jq]);
    let url = found.code === 0 ? found.stdout.trim().split("\n")[0] ?? "" : "";
    let number = prNumber(url, slugOf(repo));
    if (number === null) {
      const fork = await forkOf(w, g, d.exec, who.login, repo, { finding: key });
      const push = await ghLandPush(w, g, git, { repo, fork, branch: row.fix_branch, sha: row.fix_commit, base: row.fix_commit, key });
      if (push.code !== 0) return await back(db, repo, n, `the push failed: ${oneLine(push.stderr)}`, d.log);
      const pr = await ghLandPr(w, g, d.exec, { repo, key, base, head: `${fork.split("/")[0]}:${row.fix_branch}`, title: row.fix_title, body }, { by: "model", kind: "pull request", model: "opus" });
      url = pr.stdout.trim().split("\n").pop() ?? "";
      number = prNumber(url, slugOf(repo));
      if (pr.code !== 0 || number === null) return await back(db, repo, n, `the pull request was not opened: ${oneLine(pr.stderr || pr.stdout)}`, d.log);
    }
    await advance(db, repo, n, ["landing"], "landing", { fix_pr: number, fork: null, note: null });
    await auditAs(db, "security-land-opened", key, { pr: number });
    d.log(`${repo} finding ${n}: opened pull request ${number}`);
    return `finding ${n}: pull request ${number} opened`;
  } catch (e) {
    await back(db, repo, n, `landing failed: ${(e as Error).message}`, d.log);
    throw e;
  }
}

/** The version in a Cargo.toml: `[package]` version, or the workspace's when the package inherits it. */
function cargoVersion(toml: string, workspace: boolean): string | null {
  let section = "";
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    const h = /^\[([^\]]+)\]$/.exec(line);
    if (h) { section = h[1]!.trim(); continue; }
    if (section !== (workspace ? "workspace.package" : "package")) continue;
    const v = /^version\s*=\s*"([^"]+)"/.exec(line);
    if (v) return v[1]!;
    if (!workspace && /^version\.workspace\s*=\s*true|^version\s*=\s*\{\s*workspace\s*=\s*true/.test(line)) return "workspace";
  }
  return null;
}

/**
 * The affected-version range GitHub needs to publish an advisory: `<= <version>` of the crate holding the finding's
 * sink at the scan's pinned commit, else `<= <short commit>`.
 */
async function advisoryRange(db: Db, row: FindingRow, d: Pick<LandDeps, "exec" | "root">): Promise<string> {
  const sha = (await scanRow(db, row.scan_id))?.commit_sha ?? "";
  const fallback = `<= ${sha.slice(0, 12) || "unknown"}`;
  try {
    if (!/^[0-9a-f]{40}$/.test(sha)) return fallback;
    const git = new Git(d.exec, d.root, row.repo);
    const path = (JSON.parse(row.refs) as { path: string }[])[0]?.path ?? "";
    const crates = cachedCratesOf(row.repo, sha);
    const read = async (p: string): Promise<string | null> => { const f = await git.file(sha, p); return f.ok ? f.content : null; };
    const known = crates ? crateOf(crates.crates, path)?.dir : null;
    // Without a cached crate list, the nearest Cargo.toml above the file that declares a package.
    let manifest: string | null = null;
    for (let dir = known ?? path.split("/").slice(0, -1).join("/"); manifest === null; dir = dir.split("/").slice(0, -1).join("/")) {
      const m = await read(dir && dir !== "." ? `${dir}/Cargo.toml` : "Cargo.toml");
      if (m && (known !== undefined && known !== null || /^\[package\]/m.test(m))) manifest = m;
      else if (!dir || known) break;
    }
    let v = manifest ? cargoVersion(manifest, false) : null;
    if (v === "workspace") { const root = await read("Cargo.toml"); v = root ? cargoVersion(root, true) : null; }
    return v ? `<= ${v}` : fallback;
  } catch { return fallback; }
}

/** Advisory text: private until it is published. */
function advisoryText(row: FindingRow): string {
  const refs = (JSON.parse(row.refs) as { path: string; line: number }[]).map((r) => `- \`${r.path}:${r.line}\``).join("\n");
  return `${row.impact}\n\n### How it is reached\n\n${row.reach}\n\n### Affected code\n\n${refs}\n`;
}

const ADMIN = {
  advisory: "A repository admin must allow security advisories for the box account (the security manager role) and press Advisory again.",
  fork: "A repository admin must start a temporary private fork on the advisory page, add the box account to it, and press Advisory again.",
  push: "A repository admin must add the box account to the advisory's private fork, then press Advisory again.",
  pr: "A repository admin must open a pull request from the fix branch in the advisory's private fork.",
  merge: "A repository admin merges the fix pull request on the advisory page.",
};

/**
 * The advisory route: draft advisory, its private fork, the fix pushed there with the box user's token, and the pull
 * request inside the fork. A refusal (403 or 404) at any step leaves the finding `awaiting-admin` with a note of what the
 * admin must do; the steps already done are kept and not repeated when the operator presses Advisory again.
 */
export async function runAdvisory(db: Db, repo: string, n: number, by: By, d: LandDeps): Promise<string> {
  const row = await rawFinding(db, repo, n);
  if (!row || row.state !== "landing") return `finding ${n}: not landing`;
  const key = findingKey(repo, n);
  const w: Writer = { db, login: ACTOR };
  const wait = async (note: string, set: Record<string, string | number | null> = {}): Promise<string> => {
    await advance(db, repo, n, ["landing"], "awaiting-admin", { ...set, note });
    d.log(`${repo} finding ${n}: awaiting an admin: ${note}`);
    return `finding ${n}: awaiting an admin`;
  };
  // A refusal waits for an admin; any other failure returns the finding to ready, with what was done kept.
  const failed = async (r: ExecResult, step: keyof typeof ADMIN, set: Record<string, string | number | null>): Promise<string> => {
    const status = httpStatus(r);
    return status === 403 || status === 404 ? await wait(ADMIN[step], set) : await back(db, repo, n, `${step} step failed: ${oneLine(r.stderr || r.stdout)}`, d.log, set);
  };
  try {
    if (!row.fix_commit || !row.fix_title || !row.fix_summary || !row.fix_branch) return await back(db, repo, n, "the finding has no fix to land", d.log);
    const git = new Git(d.exec, d.root, repo);
    if (!(await haveCommit(git, row))) return await back(db, repo, n, "the fix commit is gone from the local cache; write the fix again", d.log);
    const g = await guardRepo(db, repo, "security", by);
    if ("refused" in g) return await back(db, repo, n, g.refused, d.log);
    const set: Record<string, string | number | null> = {};
    let ghsa = row.ghsa_id;
    if (!ghsa) {
      const a = await ghAdvisoryCreate(w, g, d.exec, { repo, key, summary: row.title, description: advisoryText(row), severity: row.severity, range: await advisoryRange(db, row, d) });
      if (!a.ghsa) return await failed(a.result, "advisory", set);
      ghsa = a.ghsa;
      set.ghsa_id = ghsa;
      await advance(db, repo, n, ["landing"], "landing", { ghsa_id: ghsa });
    }
    let fork = row.fork;
    if (!fork) {
      const f = await ghAdvisoryFork(w, g, d.exec, { repo, key, ghsa });
      if (!f.fork) return await failed(f.result, "fork", set);
      fork = f.fork;
      set.fork = fork;
      await advance(db, repo, n, ["landing"], "landing", { fork });
      // GitHub creates the fork in the background; a push right after the request can hit a repository that does not exist yet.
      const sleep = d.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
      for (let i = 0; i < 6; i++) {
        if ((await d.exec("gh", ["api", `repos/${fork}`, "--jq", ".full_name"])).code === 0) break;
        await sleep(5000);
      }
    }
    // A press after an interrupted run finds the pull request already in the fork.
    let fixPr = row.fix_pr;
    if (fixPr === null) {
      const open = await d.exec("gh", ["pr", "list", "--repo", fork, "--head", row.fix_branch, "--state", "open", "--json", "number", "--jq", ".[0].number"]);
      const found = Number(open.stdout.trim());
      if (open.code === 0 && Number.isInteger(found) && found > 0) { fixPr = found; set.fix_pr = found; }
    }
    if (fixPr === null) {
      const push = await ghAdvisoryPush(w, g, git, { repo, fork, branch: row.fix_branch, sha: row.fix_commit, key });
      if (push.code !== 0) return await failed(push, "push", set);
      const pr = await ghAdvisoryPr(w, g, d.exec, { repo, key, fork, base: await branchOf(db, repo), head: row.fix_branch, title: row.fix_title, body: landBody(row.fix_summary) });
      const made = prNumber(pr.stdout, fork);
      if (pr.code !== 0 || made === null) return await failed(pr, "pr", set);
      set.fix_pr = made;
      await advance(db, repo, n, ["landing"], "landing", { fix_pr: set.fix_pr });
    }
    await auditAs(db, "security-advisory-ready", key, { ghsa, fork });
    return await wait(ADMIN.merge, set) + ` (${ghsa})`;
  } catch (e) {
    await back(db, repo, n, `the advisory route failed: ${(e as Error).message}`, d.log);
    throw e;
  }
}

/** Creates the finding's draft advisory (private) and stores its id. A finding landed by a quiet pull request has none until its fix merges. */
async function draftAdvisory(db: Db, row: FindingRow, w: Writer, g: Parameters<typeof ghAdvisoryCreate>[1], d: Pick<LandDeps, "exec" | "root">): ReturnType<typeof ghAdvisoryCreate> {
  const key = findingKey(row.repo, row.number);
  // One draft per finding: the empty id claims the creation, so the merge poll and a Publish press never both create one. A claim older than ten minutes is a crashed attempt.
  const claimed = await sec.claimAdvisoryId(db, sec.findingKey(row.repo, row.number));
  if (!claimed) return { ghsa: null, result: { code: 1, stdout: "", stderr: "the advisory is being created" } };
  const text = `${advisoryText(row)}${row.fix_pr ? `\n### Fix\n\nFixed in ${slugOf(row.repo)}#${row.fix_pr}.\n` : ""}`;
  const a = await ghAdvisoryCreate(w, g, d.exec, { repo: row.repo, key, summary: row.title, description: text, severity: row.severity, range: await advisoryRange(db, row, d) });
  await sec.setAdvisoryId(db, sec.findingKey(row.repo, row.number), a.ghsa ?? null);
  return a;
}

/**
 * Publishes the finding's advisory after a release. A finding landed by a quiet pull request has no advisory yet: a draft
 * is created first. An optional CVE request follows (public repositories only; its failure is noted, not fatal).
 */
export async function runPublish(db: Db, repo: string, n: number, by: By, cve: boolean, d: LandDeps): Promise<string> {
  const row = await rawFinding(db, repo, n);
  if (!row || (row.state !== "landed" && row.state !== "advisory")) return `finding ${n}: nothing to publish`;
  const key = findingKey(repo, n);
  const w: Writer = { db, login: ACTOR };
  const note = async (why: string): Promise<string> => { await sec.setFindingNote(db, sec.findingKey(repo, n), oneLine(why, 400)); return `finding ${n}: ${oneLine(why, 120)}`; };
  const g = await guardRepo(db, repo, "security", by);
  if ("refused" in g) return await note(g.refused);
  let ghsa = row.ghsa_id;
  if (!ghsa) {
    const a = await draftAdvisory(db, row, w, g, d);
    if (!a.ghsa) return await note(`the advisory could not be created: ${oneLine(a.result.stderr || a.result.stdout)}`);
    ghsa = a.ghsa;
  }
  const r = await ghAdvisoryRange(w, g, d.exec, { repo, key, ghsa, range: () => advisoryRange(db, row, d) });
  if (r && r.code !== 0) return await note(`the advisory was not published: ${oneLine(r.stderr || r.stdout)}`);
  const p = await ghAdvisoryPublish(w, g, d.exec, { repo, key, ghsa });
  if (p.code !== 0) return await note(`the advisory was not published: ${oneLine(p.stderr || p.stdout)}`);
  let tail = "";
  if (cve) {
    const c = await ghAdvisoryCve(w, g, d.exec, { repo, key, ghsa });
    tail = c.code === 0 ? "; CVE requested" : `; CVE request failed: ${oneLine(c.stderr || c.stdout, 100)}`;
  }
  await advance(db, repo, n, ["landed", "advisory"], "published", { note: cve && tail.startsWith("; CVE request failed") ? tail.slice(2) : null });
  await auditAs(db, "security-published", key, { ghsa, cve });
  return `finding ${n}: published ${ghsa}${tail}`;
}

// ---- merge detection --------------------------------------------------------------

/** Patch ids (`git patch-id --stable`) of the last commits on `head`. */
async function patchIds(git: Git, head: string, limit: number): Promise<Set<string>> {
  const log = await git.git(["log", "-p", "--no-renames", "--no-merges", "--no-ext-diff", "--no-textconv", `-n${limit}`, head]);
  if (log.code !== 0 || !log.stdout) return new Set();
  const ids = await git.git(["patch-id", "--stable"], { input: log.stdout });
  return new Set(ids.stdout.split("\n").map((l) => l.split(" ")[0]!).filter(Boolean));
}

/** True when the fix commit is part of `head`, or main has a commit with the same patch. */
export async function fixOnMain(git: Git, fixCommit: string, head: string): Promise<boolean> {
  if ((await git.git(["merge-base", "--is-ancestor", fixCommit, head])).code === 0) return true;
  const mine = await git.git(["diff-tree", "-p", "-r", "--no-renames", "--no-ext-diff", "--no-textconv", `${fixCommit}^`, fixCommit]);
  if (mine.code !== 0) return false;
  const own = (await git.git(["patch-id", "--stable"], { input: mine.stdout })).stdout.split(" ")[0] ?? "";
  return !!own && (await patchIds(git, head, 300)).has(own);
}

type PrFacts = { item: Pick<ItemOf<"pr">, "state" | "is_draft" | "mergeable" | "ci_state"> | undefined; last: { outcome: string; reason: string | null } | undefined };

/** Why a quiet pull request is still open, from its mirror row and its last merge attempt. */
function stallText({ item, last }: PrFacts): string {
  if (!item) return "The pull request is open; waiting for the pipeline to read it.";
  if (item.is_draft) return "The pull request is a draft.";
  if (item.mergeable === "CONFLICTING") return "The pull request has merge conflicts.";
  if (item.ci_state === "FAILURE" || item.ci_state === "ERROR") return "The pull request's checks failed.";
  if (item.ci_state === "PENDING" || item.ci_state === "EXPECTED") return "Waiting for the pull request's checks.";
  if (last?.outcome === "refused" && last.reason) return `The merge was refused: ${oneLine(last.reason, 200)}`;
  return "The pull request is open; waiting for the merge step.";
}

/** The mirror row and last merge attempt of each pull request. Two statements in one wave. */
async function loadPrFacts(db: Db, prs: { repo: string; number: number }[]): Promise<Map<string, PrFacts>> {
  const out = new Map<string, PrFacts>();
  if (!prs.length) return out;
  const [items, merges] = await db.together(() => Promise.all([loadItems(db, prs, "pr"), listMerges(db, { refs: prs })]));
  for (const p of prs) {
    const k = `${p.repo}#${p.number}`;
    out.set(k, { item: items.get(k), last: merges.find((m) => m.repo === p.repo && m.number === p.number) });
  }
  return out;
}

/**
 * Why the quiet pull request is still open, from the mirror: shown on the finding page. The text avoids naming the finding
 * so it is safe wherever the note is shown.
 */
export async function stallReason(db: Db, repo: string, number: number): Promise<string> {
  return stallText((await loadPrFacts(db, [{ repo, number }])).get(`${repo}#${number}`)!);
}

/**
 * Moves findings on when their fix lands: a quiet pull request that merged (read from the mirror) becomes `landed`, one that
 * closed unmerged returns the finding to `ready`; a fix on the advisory route that appears on the default branch becomes
 * `advisory`. External wait: it reads GitHub state and never sleeps on a timer. Returns the number of findings moved.
 */
export async function pollLanding(db: Db, d: Pick<LandDeps, "exec" | "root" | "log">): Promise<number> {
  at("watch");
  const { quiet, waiting } = await sec.loadLandingWatch(db);
  let moved = 0;
  at(`facts of ${quiet.length} quiet, ${waiting.length} waiting`);
  const facts = await loadPrFacts(db, quiet.map((f) => ({ repo: f.repo, number: f.fix_pr })));
  const stateOf = (f: (typeof quiet)[number]) => facts.get(`${f.repo}#${f.fix_pr}`)?.item?.state;
  const merged = quiet.filter((f) => stateOf(f) === "MERGED");
  const closed = quiet.filter((f) => stateOf(f) === "CLOSED");
  const open = quiet.filter((f) => stateOf(f) === "OPEN");
  at("write");
  const landed = await db.write(async () => {
    const landedKeys = await sec.advanceFindings(db, merged.map((f) => ({ repo: f.repo, number: f.number, from: ["landing"], to: "landed", set: { note: null } })));
    await addAudit(db, merged.filter((f) => landedKeys.has(sec.findingKey(f.repo, f.number))).map((f) => ({ login: ACTOR, action: "security-landed", target: findingKey(f.repo, f.number), details: { pr: f.fix_pr } })));
    await sec.addQuietPrs(db, closed.map((f) => ({ repo: f.repo, pr: f.fix_pr, finding: f.number })));
    const reopened = await sec.advanceFindings(db, closed.map((f) => ({ repo: f.repo, number: f.number, from: ["landing"], to: "ready", set: { fix_pr: null, note: "The pull request was closed without merging." } })));
    await sec.setNotes(db, open.map((f) => ({ repo: f.repo, number: f.number, note: stallText(facts.get(`${f.repo}#${f.fix_pr}`)!) })));
    moved += landedKeys.size + reopened.size;
    return merged.filter((f) => landedKeys.has(sec.findingKey(f.repo, f.number)));
  });
  // The draft advisory records the issue once the fix is public. Best effort: Publish creates it when this could not.
  at("landed findings");
  const rows = await sec.loadFindings(db, landed.map((f) => sec.findingKey(f.repo, f.number)), { internal: true });
  for (const f of landed) {
    at(`draft advisory ${f.repo}#${f.number}`);
    try {
      const row = rows.get(sec.findingKey(f.repo, f.number)) as FindingRow | undefined;
      const g = !row || row.ghsa_id ? null : await guardRepo(db, f.repo, "security", "pipeline");
      if (row && g && !("refused" in g)) await draftAdvisory(db, row, { db, login: ACTOR }, g, d);
    } catch (e) {
      d.log(`security: ${f.repo}: draft advisory not created: ${oneLine(String((e as Error).message ?? e), 160)}`);
    }
  }
  const advisory = async (fs: typeof waiting): Promise<void> => {
    if (!fs.length) return;
    at("advisory write");
    const keys = await db.write(async () => {
      const hit = await sec.advanceFindings(db, fs.map((f) => ({ repo: f.repo, number: f.number, from: ["awaiting-admin"], to: "advisory", set: { note: null } })));
      await addAudit(db, fs.filter((f) => hit.has(sec.findingKey(f.repo, f.number))).map((f) => ({ login: ACTOR, action: "security-landed", target: findingKey(f.repo, f.number), details: { route: "advisory" } })));
      return hit;
    });
    moved += keys.size;
    for (const f of fs) done.add(sec.findingKey(f.repo, f.number));
  };
  const done = new Set<string>();
  // The admin may merge the pull request in the advisory's fork; the fork exists until the advisory is published.
  const viaFork: typeof waiting = [];
  for (const f of waiting) {
    if (!f.fork || f.fix_pr === null) continue;
    at(`gh pr view ${f.fork}#${f.fix_pr}`);
    const view = await d.exec("gh", ["pr", "view", String(f.fix_pr), "--repo", f.fork, "--json", "state", "--jq", ".state"]);
    if (view.code === 0 && view.stdout.trim() === "MERGED") viaFork.push(f);
  }
  await advisory(viaFork);
  for (const repo of new Set(waiting.map((f) => f.repo))) {
    try {
      at(`fetch ${repo}`);
      const git = new Git(d.exec, d.root, repo);
      const head = await git.fetchBase(ownerOf(repo), repo, await branchOf(db, repo));
      const onMain: typeof waiting = [];
      for (const f of waiting.filter((x) => x.repo === repo && !done.has(sec.findingKey(x.repo, x.number)))) {
        at(`fix on main ${repo}#${f.number}`);
        if (await fixOnMain(git, f.fix_commit, head)) onMain.push(f);
      }
      await advisory(onMain);
    } catch (e) {
      d.log(`security: ${repo}: ${oneLine(String((e as Error).message ?? e), 160)}`);
    }
  }
  at("done");
  return moved;
}

let stage = "";
const at = (s: string): void => { stage = s; };
/** Where the running landing poll is, for the sync run's report of a poll that does not end. */
export const landingStage = (): string => stage;

/** Runs `pollLanding` when the last poll is older than a couple of minutes; the sync run calls it. */
export async function pollLandingIfDue(db: Db, d: Pick<LandDeps, "exec" | "root" | "log">, now = Date.now()): Promise<number> {
  if (!await claimMark(db, "security-poll", now, 115_000)) return 0;
  return pollLanding(db, d);
}
