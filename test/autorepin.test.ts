// Autorepin: `@<app> autorepin <pull request>` on a PR, and the commit that repins its Cargo dependencies once that pull request is merged.
import { loadOwnPushes } from "../src/data/views/own-pushes.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { storeArtifact, tempPath } from "../src/build/artifacts.ts";
import { safeEqual } from "../src/dash/server/crypto.ts";
import { exec, type Exec, type ExecResult } from "../src/fixup/git.ts";
import { drainCommands } from "../src/github/commands.ts";
import { handleDelivery, signatureOf } from "../src/github/webhooks.ts";
import type { Querier } from "../src/mirror.ts";
import { advancePreapprovals, preapprovalOf } from "../src/preapproval/index.ts";
import { anyRepinDue } from "../src/repin/due.ts";
import { drainRepins, MAX_TRIES, requestRepin, type RepinDeps } from "../src/repin/index.ts";
import { lockRefusal, parseBranch, parsePrRef, repinManifest } from "../src/repin/manifest.ts";
import { runCommand } from "../src/workflow/apply.ts";
import { parse, parseComment } from "../src/workflow/parse.ts";
import { validating } from "./gql.ts";
import { SCRATCH } from "./scratch.ts";
import { OPERATOR, world, type World } from "./world-db.ts";

process.env.AUTOCRAFT_ARTIFACT_DIR = join(SCRATCH, "artifacts");

const SLUG = "autocraft-bot";
const OLD = "1".repeat(40);
/**
 * The dependency's repository as GitHub has it: `main` holds the merge commit SHA; STRAY is a commit no branch of it holds any
 * more. NEXT_OLD is a commit of another line of work; SYNC merges SHA into it (first parent NEXT_OLD) and NEXT_NEW follows SYNC.
 * The tests that use `next` point it at one of them.
 */
const LIBS_GIT = join(SCRATCH, "libs.git");
const [SHA, STRAY, NEXT_OLD, SYNC, NEXT_NEW] = (() => {
  const work = mkdtempSync(join(SCRATCH, "libs-work-"));
  git(work, "init", "-q", "-b", "main");
  git(work, "commit", "-q", "--allow-empty", "-m", "the merge of #12");
  const sha = git(work, "rev-parse", "HEAD");
  git(work, "clone", "-q", "--bare", work, LIBS_GIT);
  git(work, "commit", "-q", "--allow-empty", "-m", "dropped from main since");
  const stray = git(work, "rev-parse", "HEAD");
  git(work, "push", "-q", LIBS_GIT, `${stray}:refs/heads/elsewhere`);
  git(work, "checkout", "-q", "--orphan", "next");
  git(work, "commit", "-q", "--allow-empty", "-m", "next work");
  const old = git(work, "rev-parse", "HEAD");
  git(work, "merge", "-q", "--no-ff", "--allow-unrelated-histories", "-m", "sync main into next", sha);
  const sync = git(work, "rev-parse", "HEAD");
  git(work, "commit", "-q", "--allow-empty", "-m", "more next work");
  const after = git(work, "rev-parse", "HEAD");
  git(work, "push", "-q", LIBS_GIT, `${after}:refs/heads/kept`);
  return [sha, stray, old, sync, after];
})();
/** Points the dependency's `next` at `sha`. */
const nextAt = (sha: string): void => { git(LIBS_GIT, "update-ref", "refs/heads/next", sha); };
const LIBS = "https://github.com/storytold/libs";
const MANIFEST = `[workspace]\nmembers = ["app"]\n\n[workspace.dependencies]\ncraft-ui = { git = "${LIBS}", rev = "${OLD}" }\nserde = "1"\n`;
const CRATES = 'source = "registry+https://github.com/rust-lang/crates.io-index"';
const lockOf = (rev: string, extra = ""): string =>
  `version = 4\n\n[[package]]\nname = "app"\nversion = "0.1.0"\n\n[[package]]\nname = "craft-ui"\nversion = "0.1.0"\nsource = "git+${LIBS}?rev=${rev}#${rev}"\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\n${CRATES}\nchecksum = "aa"\n${extra}`;

describe("the autorepin command", () => {
  /** What the comment's autorepin command names: the pull request and branch its argument reads as, or the parse result when it is no command. */
  const read = (body: string) => {
    const p = parseComment(body, SLUG, { repo: "app" });
    if (p?.kind !== "commands" || p.parts.length !== 1 || p.parts[0]!.word !== "autorepin") return p;
    const args = (p.parts[0] as { args: string }).args;
    const m = /^(\S+)(?:\s+via\s+(\S+))?$/i.exec(args)!;
    return { ref: m[1]!.toLowerCase() === "off" ? null : parsePrRef(m[1]!), branch: m[2] === undefined ? null : parseBranch(m[2]) };
  };
  test("names the pull request by slug, bare repo name or URL; off drops it", () => {
    const ref = { owner: "storytold", name: "libs", number: 12 };
    assert.deepEqual(read(`@${SLUG} autorepin storytold/libs#12`), { ref, branch: null });
    assert.deepEqual(read(`thanks!\n@${SLUG} auto-repin ${LIBS}/pull/12`), { ref, branch: null });
    assert.deepEqual(read(`@${SLUG} autorepin libs#12`), { ref: { ...ref, owner: null }, branch: null });
    assert.deepEqual(read(`@${SLUG} autorepin OFF`), { ref: null, branch: null });
    assert.deepEqual(read(`@${SLUG} autorepin libs#12 via release/next-1.2`), { ref: { ...ref, owner: null }, branch: "release/next-1.2" });
  });
  // A sentence-final period is not part of a branch name, so `via a.` names `a`.
  test("a branch git would refuse, or one that reads as an option or a ref path, runs nothing", () => {
    for (const b of ["-x", "..", "a..b", "a.lock", "a/", "/a", "a//b", ".hidden", "HEAD", "refs/heads/x", "a~1", "a^", "a:b", "@{1}", "x".repeat(101)]) {
      assert.equal(parseComment(`@${SLUG} autorepin libs#12 via ${b}`, SLUG, { repo: "app" })?.kind, "ambiguous", b);
    }
    assert.equal(parseComment(`@${SLUG} autorepin off via next`, SLUG, { repo: "app" })?.kind, "ambiguous");
  });
  test("a number alone, a missing target or a quoted line runs nothing", () => {
    for (const body of [`@${SLUG} autorepin 12`, `@${SLUG} autorepin #12`, `@${SLUG} autorepin`, `@${SLUG} autorepin libs#12 please`]) assert.equal(parseComment(body, SLUG, { repo: "app" })?.kind, "ambiguous", body);
    assert.equal(parseComment(`> @${SLUG} autorepin libs#12`, SLUG, { repo: "app" }), null);
  });
});

describe("repinManifest", () => {
  test("moves every rev on the repository, in inline and section tables, and nothing else", () => {
    const text = `[dependencies]\ncraft-ui = { git = "${LIBS}.git", rev = "${OLD}" } # ui\nother = { git = "https://github.com/storytold/elsewhere", rev = "2222222" }\n\n[dev-dependencies.craft-test]\ngit = "${LIBS}"\nrev = '${OLD}'\n`;
    const r = repinManifest(text, "storytold/libs", SHA);
    assert.ok(r.ok);
    assert.deepEqual(r.from, [OLD]);
    assert.equal(r.text, text.replace(`"${OLD}"`, `"${SHA}"`).replace(`'${OLD}'`, `"${SHA}"`));
  });
  test("a manifest already at the commit, or with no rev on the repository, comes back unchanged", () => {
    const at = MANIFEST.replace(OLD, SHA);
    const same = repinManifest(at, "storytold/libs", SHA);
    assert.ok(same.ok && same.text === at && same.from.length === 0 && same.pinned === 1);
    const branch = repinManifest(`[dependencies]\ncraft-ui = { git = "${LIBS}", branch = "wip" }\n`, "storytold/libs", SHA);
    assert.ok(branch.ok && branch.from.length === 0 && branch.pinned === 0 && branch.unpinned === 1);
  });
  test("a git and rev outside the dependency tables are not a dependency", () => {
    const text = `[package]
name = "app"

[package.metadata.release]
git = "${LIBS}"
rev = "${OLD}"

[target.'cfg(unix)'.dependencies]
craft-ui = { git = "${LIBS}", rev = "${OLD}" }

[patch.crates-io]
craft-io = { git = "${LIBS}", rev = "${OLD}" }
`;
    const r = repinManifest(text, "storytold/libs", SHA);
    // Refused, not rewritten: the metadata's rev is the same text, so the edit cannot leave it alone.
    assert.ok(!r.ok);
    const apart = repinManifest(text.replace(`rev = "${OLD}"`, 'rev = "2222222"'), "storytold/libs", SHA);
    assert.ok(apart.ok && apart.pinned === 2 && apart.text.includes('rev = "2222222"') && !apart.text.includes(OLD));
  });
  test("is refused when the rewrite would also change another repository's rev", () => {
    const r = repinManifest(`[dependencies]\ncraft-ui = { git = "${LIBS}", rev = "${OLD}" }\nother = { git = "https://github.com/else/where", rev = "${OLD}" }\n`, "storytold/libs", SHA);
    assert.ok(!r.ok);
  });
});

describe("lockRefusal", () => {
  const ok = (after: string) => lockRefusal(lockOf(OLD), after, "storytold/libs", SHA);
  test("accepts the dependency at the commit, with new crates.io packages", () => {
    assert.equal(ok(lockOf(SHA, `\n[[package]]\nname = "itoa"\nversion = "1.0.0"\n${CRATES}\nchecksum = "bb"\n`)), null);
  });
  test("refuses another source, the dependency at another commit, and a changed checksum", () => {
    assert.ok(ok(lockOf(SHA, `\n[[package]]\nname = "evil"\nversion = "1.0.0"\nsource = "git+https://github.com/else/where?rev=abc#abc"\n`)));
    assert.ok(ok(lockOf(OLD)));
    assert.ok(ok(lockOf(SHA).replace('"aa"', '"zz"')));
  });
  test("refuses a new version of a package the old lockfile has from the same source, a downgrade included", () => {
    assert.ok(ok(lockOf(SHA).replace('version = "1.0.0"', 'version = "0.9.0"')));
    assert.ok(ok(lockOf(SHA, `\n[[package]]\nname = "serde"\nversion = "2.0.0"\n${CRATES}\nchecksum = "cc"\n`)));
  });
  test("reads the lockfile as TOML: a source written another way than Cargo writes it still counts", () => {
    const app = 'name = "app"\nversion = "0.1.0"\n';
    assert.ok(ok(lockOf(SHA).replace(app, `${app}source = "git+https://example.org/foreign#abc" # source\n`)));
    assert.ok(ok(`${lockOf(SHA)}\n[[package]]\nname = 1\n`));
  });
});

// ---- the whole flow against real git, with GitHub replaced ---------------------

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

type Setup = { w: World; fork: string; head: string; comments: string[]; pushes: number; live: { head: string; state: string; ref: string; base: string; sha: string; mergedAt: string }; deps: RepinDeps; noBranch: string | null; branch: () => string; at: (path: string) => string };
let current: World | null = null;
afterEach(() => current?.close());

/** The bare fork contrib/app of each kind of setup, built once and copied for every test. */
const forks = new Map<boolean, { dir: string; head: string }>();
function forkTemplate(lock: boolean): { dir: string; head: string } {
  let made = forks.get(lock);
  if (!made) {
    const root = mkdtempSync(join(SCRATCH, "repin-fork-"));
    const work = join(root, "work");
    mkdirSync(work);
    git(work, "init", "-q", "-b", "fix");
    writeFileSync(join(work, "Cargo.toml"), MANIFEST);
    if (lock) writeFileSync(join(work, "Cargo.lock"), lockOf(OLD));
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "contributor");
    const head = git(work, "rev-parse", "HEAD");
    const dir = join(root, "fork.git");
    git(root, "clone", "-q", "--bare", work, dir);
    git(dir, "update-ref", "refs/pull/1/head", head);
    forks.set(lock, made = { dir, head });
  }
  return made;
}

/** app#1 from the fork contrib/app (branch `fix`), pinned to libs at OLD; libs#12 is open in the mirror. */
async function setup(o: { lock?: boolean; off?: Parameters<World["repo"]>[0] } = {}): Promise<Setup> {
  const root = mkdtempSync(join(SCRATCH, "repin-"));
  const { dir, head } = forkTemplate(o.lock !== false);
  const fork = join(root, "fork.git");
  cpSync(dir, fork, { recursive: true });

  const w = (current = await (await (await world()).repo(o.off)).pr(1, { head }));
  await w.db.run(w.db.k.updateTable("access").set({ github_id: 101 }).where("login", "=", OPERATOR));
  await w.db.run(w.db.k.updateTable("main.tracked_repos").set({ workflow: "new" }).where("name", "=", "app"));
  await w.db.run(w.db.k.insertInto("main.settings").values({ key: "github_identity", value: "app" }).onConflict((oc) => oc.column("key").doUpdateSet({ value: "app" })));
  await w.db.run(w.db.k.insertInto("tracked_repos").values({ name: "libs", added_by: OPERATOR, added_at: "2026-01-01T00:00:00Z" }));
  await w.db.run(w.db.k.insertInto("repos").values({ name: "libs", visibility: "public", default_branch: "main" }));
  await w.db.run(w.db.k.insertInto("items").values({ repo: "libs", number: 12, kind: "pr", state: "OPEN", title: "lib change", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }));

  const s: Setup = {
    w, fork, head, comments: [], pushes: 0, live: { head, state: "OPEN", ref: "MERGED", base: "main", sha: SHA, mergedAt: new Date().toISOString() },
    deps: null as never, noBranch: null,
    branch: () => git(fork, "rev-parse", "refs/heads/fix"),
    at: (path) => git(fork, "show", `refs/heads/fix:${path}`),
  };
  const querier: Querier = validating({
    spent: 0, remaining: 5000,
    async query(q: string, v: { ref?: string }) {
      if (q.includes("qualifiedName")) return { repository: { ref: s.noBranch === v.ref?.replace("refs/heads/", "") ? null : { name: "next" } } };
      if (q.includes("mergeCommit")) return { repository: { defaultBranchRef: { name: "main" }, pullRequest: { state: s.live.ref, baseRefName: s.live.base, mergedAt: s.live.ref === "MERGED" ? s.live.mergedAt : null, mergeCommit: s.live.ref === "MERGED" ? { oid: s.live.sha } : null } } };
      return { repository: { pullRequest: { state: s.live.state, headRefOid: s.live.head, headRefName: "fix", maintainerCanModify: true, headRepository: { nameWithOwner: "contrib/app" }, headRef: null } } };
    },
  });
  const run: Exec = async (cmd, args, opts = {}): Promise<ExecResult> => {
    if (cmd === "gh") {
      if (args[0] === "api") return { code: 0, stdout: JSON.stringify({ login: "pipeline-bot", id: 42, node_id: "U42" }), stderr: "" };
      s.comments.push(String(opts.input ?? ""));
      return { code: 0, stdout: "https://github.com/storytold/app/pull/1#issuecomment-9", stderr: "" };
    }
    if (args.includes("push")) s.pushes++;
    const net = args.some((a) => a.startsWith("https://github.com/"));
    const local = args.map((a) => (a.startsWith("https://github.com/storytold/libs") ? LIBS_GIT : a.startsWith("https://github.com/") ? fork : a)).filter((a, i, all) => !(a === "-c" && all[i + 1] === "protocol.file.allow=never") && a !== "protocol.file.allow=never");
    return exec("git", net ? local : args, { ...opts });
  };
  s.deps = { querier, exec: run, root: join(root, "cache"), permission: async () => "ok", mint: async () => "installation-token" };
  return s;
}

const set = (s: Setup, branch: string | null = null) => requestRepin(s.w.db, { login: OPERATOR, githubId: 101, role: "operator", canWrite: true, repo: "app", number: 1, pr: true, ref: { owner: "storytold", name: "libs", number: 12 }, branch });
const merged = async (s: Setup, state = "MERGED") => await s.w.db.run(s.w.db.k.updateTable("items").set({ state }).where("repo", "=", "libs").where("number", "=", 12));
const row = async (s: Setup) => ({ ...await s.w.db.get(s.w.db.k.selectFrom("autorepins").select(["state", "tries", "to_head", "result", "notice"])) });
const task = async (s: Setup) => await s.w.db.get(s.w.db.k.selectFrom("build_tasks").select(["id", "patch", "plan", "head_sha"]).where("step", "=", "autorepin").orderBy("id", "desc").limit(1));
/** The lockfile task ended with `lock` as its Cargo.lock. */
async function locked(s: Setup, lock: string | null, state = "done"): Promise<void> {
  const id = (await task(s))!.id;
  await s.w.db.run(s.w.db.k.updateTable("build_tasks").set({ state, ended_at: "2026-01-03T00:00:00Z" }).where("id", "=", id));
  if (lock === null) return;
  const tmp = tempPath(id);
  writeFileSync(tmp, lock);
  await storeArtifact(s.w.db, id, "Cargo.lock", tmp);
}

/** Delivers a comment on app#1 holding `body` and carries it out; `now`: the comment's text when the runner reads it again. */
async function comment(s: Setup, body: string, now = body): Promise<void> {
  const raw = Buffer.from(JSON.stringify({
    action: "created", repository: { full_name: "storytold/app", name: "app" }, issue: { number: 1, pull_request: { url: "x" } },
    comment: { id: 5000, body, created_at: new Date().toISOString(), user: { login: OPERATOR, id: 101, type: "User" } },
  }));
  await handleDelivery(s.w.db, "secret", { event: "issue_comment", signature: signatureOf("secret", raw) }, raw, safeEqual, SLUG);
  await drainCommands(s.w.db, {
    querier: s.deps.querier, exec: s.deps.exec, slug: SLUG, mint: s.deps.mint,
    permission: async () => ({ kind: "ok", permission: "write" }),
    comment: async () => ({ kind: "ok", authorId: 101, body: now }),
  });
}

describe("autorepin", () => {
  test("a comment sets it, and nothing happens while the dependency's pull request is open", async () => {
    const s = await setup();
    await comment(s, `@${SLUG} autorepin storytold/libs#12`);
    assert.equal(s.comments.length, 1);
    assert.match(s.comments[0]!, new RegExp(`@${OPERATOR} Repinning the Cargo dependencies of storytold/libs#12 when this merges`));
    assert.equal((await row(s)).state, "waiting");
    assert.equal(await anyRepinDue(s.w.db), false);
    assert.equal(await drainRepins(s.w.db, s.deps), 0);
    assert.equal(await task(s), undefined);
  });

  test("after the merge the lockfile task gets the repinned manifest, and its lockfile is pushed with it on top of the head", async () => {
    const s = await setup();
    await set(s);
    await merged(s);
    await drainRepins(s.w.db, s.deps);
    const t = (await task(s))!;
    assert.equal((await row(s)).state, "locking");
    assert.equal(t.head_sha, s.head);
    const patch = t.patch ?? "";
    assert.ok(patch.includes(`+craft-ui = { git = "${LIBS}", rev = "${SHA}" }`) && !patch.includes("Cargo.lock"), patch);
    assert.equal((JSON.parse(t.plan) as { network: string }[])[0]!.network, "fetch");
    assert.equal(s.pushes, 0, "nothing is pushed before the lockfile is back");
    assert.equal(await anyRepinDue(s.w.db), false, "it waits for the task");

    await locked(s, lockOf(SHA));
    assert.equal(await drainRepins(s.w.db, s.deps), 1);
    const r = await row(s);
    assert.equal(r.state, "pushed");
    assert.equal(s.branch(), r.to_head);
    assert.equal(git(s.fork, "rev-parse", `${r.to_head}^`), s.head, "one commit on the head");
    assert.equal(s.at("Cargo.toml"), MANIFEST.replace(OLD, SHA).trim());
    assert.equal(s.at("Cargo.lock"), lockOf(SHA).trim());
    assert.deepEqual(git(s.fork, "diff-tree", "-r", "--name-only", s.head, r.to_head!).split("\n").sort(), ["Cargo.lock", "Cargo.toml"]);
    assert.equal(s.comments.length, 1);
    assert.ok(s.comments[0]!.includes(`@${OPERATOR} Repinned storytold/libs`), s.comments[0]);
    assert.equal(await drainRepins(s.w.db, s.deps), 0, "done once");
    assert.equal(s.pushes, 1);
  });

  test("a merge pre-approved at the old head goes on at the repinned head, to be reviewed again", async () => {
    const s = await setup({ lock: false });
    await s.w.acting();
    const started = await runCommand(s.w.db, { login: OPERATOR, canWrite: async () => true }, "dashboard", { parsed: parse("review and merge"), items: [{ repo: "app", number: 1 }] });
    assert.equal(started.items[0]!.outcome, "run", started.lines.join("\n"));
    await set(s);
    await merged(s);
    await drainRepins(s.w.db, s.deps);
    const to = (await row(s)).to_head!;
    await s.w.synced(1, to);
    await advancePreapprovals(s.w.db);
    const p = (await preapprovalOf(s.w.db, "app", 1))!;
    assert.deepEqual([p.state, p.head], ["review", to]);
    // Asked for again for the same dependency, which clears its row: the push made stays known.
    await set(s);
    assert.equal((await row(s)).to_head, null);
    const known = (await loadOwnPushes(s.w.db, [{ repo: "app", number: 1 }])).get("app#1") ?? [];
    assert.deepEqual(known.map((x) => [x.from, x.to, x.what, x.landed, x.small]), [[s.head, to, "autorepin", true, true]]);
  });

  test("without a lockfile the manifest is pushed at once", async () => {
    const s = await setup({ lock: false });
    await set(s);
    await merged(s);
    await drainRepins(s.w.db, s.deps);
    assert.equal((await row(s)).state, "pushed");
    assert.equal(await task(s), undefined);
    assert.equal(s.at("Cargo.toml"), MANIFEST.replace(OLD, SHA).trim());
  });

  test("a lockfile that names another source is not pushed, and the comment says why", async () => {
    const s = await setup();
    await set(s);
    await merged(s);
    await drainRepins(s.w.db, s.deps);
    await locked(s, lockOf(SHA, `\n[[package]]\nname = "evil"\nversion = "1.0.0"\nsource = "git+https://github.com/else/where?rev=abc#abc"\n`));
    await drainRepins(s.w.db, s.deps);
    assert.equal((await row(s)).state, "failed");
    assert.equal(s.pushes, 0);
    assert.equal(s.branch(), s.head);
    assert.match(s.comments[0]!, /Autorepin of storytold\/libs failed: .*evil/);
  });

  test("a head that moved while the lockfile was written starts over instead of pushing", async () => {
    const s = await setup();
    await set(s);
    await merged(s);
    await drainRepins(s.w.db, s.deps);
    await locked(s, lockOf(SHA));
    s.live.head = "d".repeat(40);
    await drainRepins(s.w.db, s.deps);
    assert.deepEqual([(await row(s)).state, (await row(s)).tries, s.pushes], ["waiting", 1, 0]);
    assert.equal(await anyRepinDue(s.w.db), false, "not again within the minute");
    assert.equal(await anyRepinDue(s.w.db, new Date(Date.now() + 120_000)), true);
  });

  test("a lockfile task that keeps failing ends it with a comment", async () => {
    const s = await setup();
    await set(s);
    await merged(s);
    for (let i = 0; i < MAX_TRIES; i++) {
      const later = () => new Date(Date.now() + (i + 1) * 120_000);
      await drainRepins(s.w.db, { ...s.deps, now: later });
      await locked(s, null, "failed");
      await drainRepins(s.w.db, { ...s.deps, now: later });
    }
    assert.equal((await row(s)).state, "failed");
    assert.equal(s.pushes, 0);
    assert.equal(s.comments.length, 1);
  });

  test("a dependency pull request closed without merging drops it and says so", async () => {
    const s = await setup();
    await set(s);
    await merged(s, "CLOSED");
    await drainRepins(s.w.db, s.deps);
    assert.equal((await row(s)).state, "cancelled");
    assert.equal(s.pushes, 0);
    assert.match(s.comments[0]!, /closed without merging/);
  });

  test("a merge into another branch than the default one is not repinned to", async () => {
    const s = await setup();
    await set(s);
    await merged(s);
    s.live.base = "release-1";
    await drainRepins(s.w.db, s.deps);
    assert.equal((await row(s)).state, "failed");
    assert.equal(await task(s), undefined);
  });

  test("a merge commit the default branch no longer holds is not repinned to", async () => {
    const s = await setup();
    await set(s);
    await merged(s);
    s.live.sha = STRAY;
    await drainRepins(s.w.db, s.deps);
    assert.equal((await row(s)).state, "failed");
    assert.equal(await task(s), undefined);
    assert.match(s.comments[0]!, /no longer on/);
  });

  test("via a branch: waits, without counting tries, while the merge is only on the default branch, then pins to the commit that brought it in", async () => {
    const s = await setup();
    nextAt(NEXT_OLD);
    await comment(s, `@${SLUG} autorepin storytold/libs#12 via next`);
    assert.match(s.comments[0]!, /storytold\/libs#12 via next when this merges/);
    s.comments.length = 0;
    await merged(s);
    const t0 = Date.now();
    for (let i = 0; i < MAX_TRIES + 1; i++) await drainRepins(s.w.db, { ...s.deps, now: () => new Date(t0 + i * 20 * 60_000) });
    assert.deepEqual([(await row(s)).state, (await row(s)).tries, await task(s), s.comments.length], ["waiting", 0, undefined, 0]);
    // A failed fetch between waits is one try; the next wait clears it, so scattered failures never add up to MAX_TRIES.
    const blip = t0 + (MAX_TRIES + 1) * 20 * 60_000;
    git(LIBS_GIT, "update-ref", "-d", "refs/heads/next");
    await drainRepins(s.w.db, { ...s.deps, now: () => new Date(blip) });
    assert.equal((await row(s)).tries, 1);
    nextAt(NEXT_OLD);
    await drainRepins(s.w.db, { ...s.deps, now: () => new Date(blip + 20 * 60_000) });
    assert.deepEqual([(await row(s)).state, (await row(s)).tries], ["waiting", 0]);
    const last = blip + 20 * 60_000;
    assert.equal(await anyRepinDue(s.w.db, new Date(last + 60_000)), false, "not looked for again within minutes");
    assert.equal(await anyRepinDue(s.w.db, new Date(last + 20 * 60_000)), true);

    nextAt(NEXT_NEW);
    const later = { ...s.deps, now: () => new Date(last + 20 * 60_000) };
    await drainRepins(s.w.db, later);
    const t = (await task(s))!;
    const patch = t.patch ?? "";
    assert.ok(patch.includes(`rev = "${SYNC}"`), patch);
    await locked(s, lockOf(SYNC));
    await drainRepins(s.w.db, later);
    assert.equal((await row(s)).state, "pushed");
    assert.equal(s.at("Cargo.toml"), MANIFEST.replace(OLD, SYNC).trim());
    assert.match(s.comments[0]!, /the first next commit that contains storytold\/libs#12/);
  });

  test("via a branch that does not exist is refused and nothing is stored", async () => {
    const s = await setup();
    s.noBranch = "nope";
    await assert.rejects(requestRepin(s.w.db, { login: OPERATOR, githubId: 101, role: "operator", canWrite: true, repo: "app", number: 1, pr: true, ref: { owner: "storytold", name: "libs", number: 12 }, branch: "nope", querier: s.deps.querier }), /storytold\/libs has no branch nope/);
    assert.equal((await s.w.db.get(s.w.db.k.selectFrom("autorepins").select((eb) => eb.fn.countAll<number>().as("n"))))!.n, 0);
  });

  test("via a branch the merge never reaches fails once the wait runs out", async () => {
    const s = await setup();
    nextAt(NEXT_OLD);
    await set(s, "next");
    await merged(s);
    s.live.mergedAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
    await drainRepins(s.w.db, s.deps);
    assert.equal((await row(s)).state, "failed");
    assert.equal(await task(s), undefined);
    assert.match(s.comments[0]!, /has not reached storytold\/libs's next/);
  });

  test("via a branch, a pull request merged straight into it is pinned to its own merge commit", async () => {
    const s = await setup({ lock: false });
    nextAt(NEXT_NEW);
    await set(s, "next");
    await merged(s);
    s.live.base = "next";
    s.live.sha = NEXT_OLD;
    await drainRepins(s.w.db, s.deps);
    assert.equal((await row(s)).state, "pushed");
    assert.equal(s.at("Cargo.toml"), MANIFEST.replace(OLD, NEXT_OLD).trim());
  });

  test("an off given while a try waits on git is not undone by that try: no wait, no lockfile task, no push", async () => {
    const off = (s: Setup) => requestRepin(s.w.db, { login: OPERATOR, githubId: 101, role: "operator", canWrite: true, repo: "app", number: 1, pr: true, ref: null, at: new Date(Date.now() + 1000) });
    /** Gives `off` while the git fetch that `match` picks out runs. */
    const offDuring = (s: Setup, match: (args: string[]) => boolean): RepinDeps => {
      let done = false;
      return { ...s.deps, exec: async (cmd, args, opts) => {
        if (!done && args.includes("fetch") && match(args)) { done = true; await off(s); }
        return s.deps.exec!(cmd, args, opts);
      } };
    };
    // Waiting for `next`: the off comes during the fetch of `next`.
    const a = await setup();
    nextAt(NEXT_OLD);
    await set(a, "next");
    await merged(a);
    await drainRepins(a.w.db, offDuring(a, (x) => x.some((y) => y.includes("refs/heads/next"))));
    assert.equal((await row(a)).state, "cancelled");
    assert.equal(await anyRepinDue(a.w.db, new Date(Date.now() + 3600_000)), false);
    a.w.close();
    // Merged: the off comes during the fetch of the pull request's head, before the lockfile task.
    const b = await setup();
    await set(b);
    await merged(b);
    await drainRepins(b.w.db, offDuring(b, (x) => x.some((y) => y.includes("refs/pull/"))));
    assert.deepEqual([(await row(b)).state, await task(b), b.pushes, b.comments.length], ["cancelled", undefined, 0, 0]);
  });

  test("whoever asked must still have write access when the merge comes", async () => {
    const s = await setup();
    await set(s);
    await merged(s);
    await drainRepins(s.w.db, { ...s.deps, permission: async () => "no" });
    assert.equal((await row(s)).state, "failed");
    assert.equal(await task(s), undefined);
  });

  test("is refused on an issue, for a repo that is not tracked, and where pushes are not approved", async () => {
    const s = await setup({ off: ["push"] });
    const ask = (o: Partial<Parameters<typeof requestRepin>[1]>) => requestRepin(s.w.db, { login: OPERATOR, githubId: 101, role: "operator", canWrite: true, repo: "app", number: 1, pr: true, ref: { owner: null, name: "libs", number: 12 }, ...o });
    await assert.rejects(ask({ pr: false }), /pull requests/);
    await assert.rejects(ask({ ref: { owner: null, name: "nowhere", number: 1 } }), /not a repository AutoCraft tracks/);
    await assert.rejects(ask({ ref: { owner: "someone-else", name: "libs", number: 12 } }), /not a repository AutoCraft tracks/);
    await assert.rejects(ask({ canWrite: false }), /write access/);
    await assert.rejects(ask({}), /not approved/);
    assert.equal((await s.w.db.get(s.w.db.k.selectFrom("autorepins").select((eb) => eb.fn.countAll<number>().as("n"))))!.n, 0);
  });

  test("is refused while the repo is outside the pipeline's scope and the pull request is not fast-tracked, since no worker would take its task", async () => {
    const s = await setup();
    await s.w.db.run(s.w.db.k.updateTable("tracked_repos").set({ pipeline: 0 }).where("name", "=", "app"));
    await assert.rejects(set(s), /pipeline is off for storytold\/app/);
    assert.equal((await s.w.db.get(s.w.db.k.selectFrom("autorepins").select((eb) => eb.fn.countAll<number>().as("n"))))!.n, 0);
  });

  test("an autorepin command carried out after a later off does not set it again", async () => {
    const s = await setup();
    const ask = (ref: Parameters<typeof requestRepin>[1]["ref"], at: string) => requestRepin(s.w.db, { login: OPERATOR, githubId: 101, role: "operator", canWrite: true, repo: "app", number: 1, pr: true, ref, at: new Date(at) });
    const libs = { owner: null, name: "libs", number: 12 };
    await ask(libs, "2026-02-01T10:00:00Z");
    await ask(null, "2026-02-01T10:10:00Z");
    // The command of 10:05, whose permission read GitHub settled only now.
    await assert.rejects(ask(libs, "2026-02-01T10:05:00Z"), /later autorepin/);
    assert.equal((await row(s)).state, "cancelled");
    await ask(libs, "2026-02-01T10:20:00Z");
    assert.equal((await row(s)).state, "waiting");
  });

  test("off drops a waiting autorepin", async () => {
    const s = await setup();
    await set(s);
    await requestRepin(s.w.db, { login: OPERATOR, githubId: 101, role: "operator", canWrite: true, repo: "app", number: 1, pr: true, ref: null });
    await merged(s);
    assert.equal(await drainRepins(s.w.db, s.deps), 0);
    assert.equal((await row(s)).state, "cancelled");
    assert.equal(s.comments.length, 0);
  });

  test("an off given before any autorepin was set still stops an older command carried out later", async () => {
    const s = await setup();
    const ask = (ref: Parameters<typeof requestRepin>[1]["ref"], at: string) => requestRepin(s.w.db, { login: OPERATOR, githubId: 101, role: "operator", canWrite: true, repo: "app", number: 1, pr: true, ref, at: new Date(at) });
    const libs = { owner: null, name: "libs", number: 12 };
    await ask(null, "2026-02-01T10:10:00Z");
    await assert.rejects(ask(libs, "2026-02-01T10:05:00Z"), /later autorepin off/);
    assert.equal((await s.w.db.get(s.w.db.k.selectFrom("autorepins").select((eb) => eb.fn.countAll<number>().as("n"))))!.n, 0);
    await ask(libs, "2026-02-01T10:20:00Z");
    assert.equal((await row(s)).state, "waiting");
  });

  test("a comment edited to name another pull request before it is carried out sets nothing", async () => {
    const s = await setup();
    await s.w.db.run(s.w.db.k.insertInto("items").values({ repo: "libs", number: 13, kind: "pr", state: "OPEN", title: "other change", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }));
    await comment(s, `@${SLUG} autorepin storytold/libs#12`, `@${SLUG} autorepin storytold/libs#13`);
    assert.equal((await s.w.db.get(s.w.db.k.selectFrom("autorepins").select((eb) => eb.fn.countAll<number>().as("n"))))!.n, 0);
    assert.equal((await s.w.db.get(s.w.db.k.selectFrom("github_commands").select("state")))!.state, "ignored");
  });
});
