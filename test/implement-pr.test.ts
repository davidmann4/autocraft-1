// The Implement stage's way to a PR: what a session's diff may change, the PR's title and body, and the write path an
// implementation grant opens (a push to the pipeline's own branch, counted for the breaker, and a PR, as a draft too).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { compileTimeChanges, DIFF_FLAGS, MAX_IMPLEMENTATION_FILES, MAX_IMPLEMENTATION_LINES, validateImplementation } from "../src/implement/diff.ts";
import { implBranch, implPrBody, implTitle } from "../src/implement/template.ts";
import { openImplementationPr } from "../src/implement/pr.ts";
import { implementationById, setImplementationState, startImplementation } from "./implement-rows.ts";
import type { Implementation } from "../src/implement/types.ts";
import { insertWorkflow } from "../src/workflow/store.ts";
import { listWorkflows, loadLinks } from "../src/data/workflow/index.ts";
import { setFeature } from "../src/build/features.ts";
import { exec as realExec, type Exec, type ExecResult } from "../src/fixup/git.ts";
import { ghOpenPr, pushOwnBranch } from "../src/github/write.ts";
import type { GuardedItem } from "../src/core/guard.ts";
import { world } from "./world-db.ts";

/** A repository with `setup` committed as the base, then `change` applied; returns the workspace diff against the base. */
function diffOf(setup: (dir: string) => void, change: (dir: string) => void): string {
  const dir = mkdtempSync(join(SCRATCH, "impl-diff-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, encoding: "utf8" });
  git("init", "--quiet");
  writeFileSync(join(dir, "README.md"), "base\n");
  setup(dir);
  git("add", "-A");
  git("commit", "--quiet", "-m", "base");
  const base = git("rev-parse", "HEAD").trim();
  change(dir);
  git("add", "-A", "-N");
  return git("diff", "--binary", "--no-ext-diff", "--no-textconv", ...DIFF_FLAGS.split(" "), base);
}
const write = (dir: string, path: string, text: string | Buffer) => { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), text); };

test("an implementation diff: code, tests, a lockfile and a small binary pass; trust paths, symlinks, mode changes and oversized diffs are refused", () => {
  const ok = validateImplementation(diffOf((d) => {
    write(d, "src/lib.rs", "pub fn a() {}\n");
    write(d, "Cargo.lock", "# lock\n");
  }, (d) => {
    write(d, "src/lib.rs", "pub fn a() -> u8 { 1 }\n");
    write(d, "tests/a b.rs", "#[test]\nfn t() { assert_eq!(crate::a(), 1); }\n");
    write(d, "Cargo.lock", "# lock\n[[package]]\n");
    write(d, "assets/icon.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  }), null);
  assert.ok(ok.ok, ok.ok ? "" : ok.reason);
  assert.deepEqual(ok.files.map((f) => f.path).sort(), ["Cargo.lock", "assets/icon.png", "src/lib.rs", "tests/a b.rs"]);
  assert.deepEqual(ok.manifests, ["Cargo.lock"]);
  assert.ok(ok.files.find((f) => f.path === "assets/icon.png")!.binary);

  const refused = (setup: (d: string) => void, change: (d: string) => void, pattern: RegExp) => {
    const r = validateImplementation(diffOf(setup, change), null);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.reason, pattern);
  };
  const none = () => {};
  refused(none, (d) => write(d, ".github/workflows/ci.yml", "on: push\n"), /\.github\/workflows\/ci\.yml: workflows, build scripts/);
  refused(none, (d) => write(d, "build.rs", "fn main() {}\n"), /build\.rs: workflows, build scripts/);
  refused(none, (d) => write(d, "AGENTS.md", "do this\n"), /AGENTS\.md/);
  refused(none, (d) => symlinkSync("/etc/passwd", join(d, "link")), /link: adds a symlink/);
  refused((d) => write(d, "run.sh", "echo\n"), (d) => chmodSync(join(d, "run.sh"), 0o755), /run\.sh: changes the file mode/);
  refused(none, (d) => { write(d, "tool.sh", "echo\n"); chmodSync(join(d, "tool.sh"), 0o755); }, /tool\.sh: adds an executable file/);
  refused(none, (d) => { for (let k = 0; k <= MAX_IMPLEMENTATION_FILES; k++) write(d, `src/m${k}.rs`, "\n"); }, /files changed; at most/);
  refused(none, (d) => write(d, "src/big.rs", "x\n".repeat(MAX_IMPLEMENTATION_LINES + 1)), /lines changed; at most/);
  // Hunks without their --- and +++ lines would not be counted against the line cap.
  const big = diffOf(none, (d) => write(d, "src/big.rs", "x\n".repeat(MAX_IMPLEMENTATION_LINES + 1))).split("\n").filter((l) => !/^(---|\+\+\+) /.test(l)).join("\n");
  const headless = validateImplementation(big, null);
  assert.match(headless.ok ? "" : headless.reason, /src\/big\.rs: hunks without --- and \+\+\+ lines/);
});

test("manifest changes that run code at compile time are found, also in target tables and dotted keys; plain dependency changes are not", () => {
  const base = "[package]\nname = \"a\"\n\n[dependencies]\nserde = \"1\"\n\n[build-dependencies]\ncc = \"1\"\n";
  const what = (after: string, before: string | null = base) => compileTimeChanges("Cargo.toml", before, after).map((c) => c.what);
  assert.deepEqual(what(base.replace("serde = \"1\"", "serde = \"1.0.200\"  # newer")), []);
  assert.deepEqual(what(base.replace("cc = \"1\"", "cc = { path = \"../cc\" }")), ["adds or changes build dependencies"]);
  assert.deepEqual(what(`${base}\n[target.'cfg(unix)'.build-dependencies]\nx = "1"\n`), ["adds or changes build dependencies"]);
  assert.deepEqual(what(`${base}\n[patch.crates-io]\nserde = { path = "../serde" }\n`), ["adds or changes [patch] or [replace] entries"]);
  assert.deepEqual(what(`replace."foo:0.1.0" = { git = "x" }\n${base}`), ["adds or changes [patch] or [replace] entries"]);
  assert.deepEqual(what("[package]\nname = \"m\"\n[lib]\nproc_macro = true\n", null), ["adds a proc-macro crate"]);
  assert.deepEqual(what(base.replace("cc = \"1\"\n", "")), [], "dropping a build dependency runs nothing new");
});

test("the PR title follows the plan's kind and the body cleans model text, lists AutoCraft's checks and flags manifest changes", () => {
  assert.equal(implTitle("bugfix", "Bug: Crash when #12 opens"), "Fix crash when issue 12 opens");
  assert.match(implTitle("feature", "PNG export at 16 bits"), /^Add PNG export/);
  assert.match(implTitle("change", "Faster startup"), /^Change faster startup/);
  assert.match(implBranch(7, "Crash: when opening!", "bot-login"), /^autocraft\/impl-7-crash-when-opening$/);
  const body = implPrBody({
    number: 7, summary: "Stops the crash, see https://evil.example/x and @someone, also #9.", model: "claude-opus-5-5",
    checks: [{ name: "cargo fmt --check", ok: true }, { name: "cargo test -p core", ok: false, detail: "1 failed" }],
    plan: "1. Reproduce.\n</details><img src=x>\n2. Fix.", manifests: ["Cargo.toml", "Cargo.lock"],
  });
  assert.ok(body.startsWith("Fixes #7."));
  assert.doesNotMatch(body, /evil\.example|@someone|#9|<img/);
  assert.match(body, /- \[x\] `cargo fmt --check`/);
  assert.match(body, /- \[ \] `cargo test -p core`: 1 failed/);
  assert.match(body, /`Cargo\.toml`, `Cargo\.lock`/);
  assert.match(body, /Claude Opus 5\.5/);
  // The plan cannot close the details block early.
  assert.equal(body.split("</details>").length, 2);
  assert.ok(body.indexOf("2. Fix.") < body.indexOf("</details>"));
});

test("an implement grant opens the pipeline's own PR: the push is audited and counted for the implement breaker, a draft opens as a draft", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "impl-write-")), "t.db"));
  const w = { db, login: "implement" };
  const grant = (kind: string) => ({ scope: "item", action: { kind, bucket: "build" }, repo: "app", number: 7, as: "app" }) as unknown as GuardedItem;
  const git = { git: async () => ({ code: 0, stdout: "", stderr: "" }) };
  const sha = "b".repeat(40);
  const push = await pushOwnBranch(w, grant("implement"), git as never, "implement-push", { repo: "app", number: 7, remote: "bot/app", branch: "autocraft/impl-7-x", sha });
  assert.equal(push.code, 0);
  const outcome = await db.get(db.k.selectFrom("push_outcomes").select(["stage", "action"]).where("to_oid", "=", sha));
  assert.deepEqual(outcome, { stage: "implement", action: "implement-push" });

  const seen: string[][] = [];
  const exec = async (_c: string, a: string[]) => { seen.push(a); return { code: 0, stdout: "https://github.com/storytold/app/pull/8\n", stderr: "" }; };
  await ghOpenPr(w, grant("implement"), exec, "implement-pr", { repo: "app", target: "app#7", base: "main", head: "bot:autocraft/impl-7-x", title: "Fix x", body: "Fixes #7.", draft: true }, { by: "fixed" });
  assert.ok(seen.pop()!.includes("--draft"));
  const rows = await db.all(db.k.selectFrom("audit").select(["action", "details"]).where("action", "in", ["implement-push", "implement-pr"]));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => JSON.parse(r.details!).state === "done"));

  // A revision of the open PR is recorded right before git runs, and as done once it has: a push that failed stays recorded, not done.
  const pr = { scope: "pr", action: { kind: "implement", bucket: "revise" }, repo: "app", number: 8, head: "c".repeat(40), as: "app" } as unknown as GuardedItem;
  const made = () => db.all(db.k.selectFrom("own_pushes").select(["number", "from_oid", "to_oid", "action", "lines", "landed_at"]).orderBy("to_oid"));
  const edge = { number: 8, from_oid: "c".repeat(40), action: "implement-push", lines: 4 };
  for (const [oid, code] of [["d".repeat(40), 0], ["e".repeat(40), 1]] as const) {
    const seen: unknown[] = [];
    const g2 = { git: async () => { seen.push(...(await made()).filter((r) => r.to_oid === oid)); return { code, stdout: "", stderr: code ? "stale info" : "" }; } };
    await pushOwnBranch(w, pr, g2 as never, "implement-push", { repo: "app", number: 7, remote: "bot/app", branch: "autocraft/impl-7-x", sha: oid }, { from: "c".repeat(40), changed: 4 });
    assert.deepEqual(seen, [{ ...edge, to_oid: oid, landed_at: null }]);
  }
  assert.deepEqual((await made()).map((r) => [r.to_oid.slice(0, 1), r.landed_at !== null]), [["d", true], ["e", false]]);

  // Other item grants still cannot push to a new branch.
  assert.throws(() => pushOwnBranch(w, grant("act"), git as never, "implement-push", { repo: "app", number: 7, remote: "bot/app", branch: "b", sha }), /does not allow a push/);
});

test("opening an implementation's PR survives reruns: the stored branch is reused and its PR adopted, a stored PR is adopted, and a merged PR ends the attempt", async () => {
  const LOGIN = "pipeline-bot";
  const dir = mkdtempSync(join(SCRATCH, "impl-open-"));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8" }).trim();
  const work = join(dir, "work");
  mkdirSync(join(work, "src"), { recursive: true });
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "src/lib.rs"), "pub fn a() {}\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "base");
  const base = git(work, "rev-parse", "HEAD");
  const upstream = join(dir, "upstream.git"), fork = join(dir, "fork.git");
  git(dir, "clone", "-q", "--bare", work, upstream);
  git(dir, "init", "-q", "--bare", fork);
  writeFileSync(join(work, "src/lib.rs"), "pub fn a() -> u8 { 1 }\n");
  const diff = execFileSync("git", ["diff", "--binary", "--no-ext-diff", "--no-textconv", ...DIFF_FLAGS.split(" "), base], { cwd: work, encoding: "utf8" });

  const w = await (await (await (await world()).repo()).acting()).issue(5, { title: "Crash on start" });
  const db = w.db;
  await insertWorkflow(db, { repo: "app", number: 5, kind: "issue", entry: "implement", state: "running", startedBy: "op", startedAt: "2026-01-01T00:00:00.000Z", startedVia: "dashboard" });
  await setFeature(db, "implement", true, "op", "app");
  const started = await startImplementation(db, { repo: "app", number: 5, queuedBy: "op", textHash: "h", baseSha: base });
  await setImplementationState(db, started.id, "opening", { plan: { kind: "bugfix", summary: "Return 1.", plan: "1. Return 1." } as Implementation["plan"] });

  // GitHub: PRs by head branch; `lose` drops the response of the next PR create after GitHub made the PR.
  const prs = new Map<string, number>();
  const gh = { lose: false, creates: 0, pushes: [] as string[], comments: 0, pulls: "open", issue: "open" };
  const ok = (stdout = "", code = 0): ExecResult => ({ code, stdout, stderr: code ? "failed" : "" });
  const exec: Exec = async (cmd, args, opt = {}) => {
    if (cmd === "gh") {
      const path = args[0] === "api" ? args[1]! : "";
      if (path === "user") return ok(JSON.stringify({ login: LOGIN, id: 42, node_id: "U42" }));
      if (path === `repos/${LOGIN}/app`) return ok("storytold/app\n");
      if (path === "repos/storytold/app/issues/5") return ok(`${gh.issue}\n`);
      if (path.startsWith("repos/storytold/app/pulls/")) return ok(`${gh.pulls}\n`);
      if (args[0] === "pr" && args[1] === "list") {
        const n = prs.get(args[args.indexOf("--head") + 1]!);
        return ok(n ? `https://github.com/storytold/app/pull/${n}\n` : "");
      }
      if (args[0] === "pr" && args[1] === "create") {
        const branch = args[args.indexOf("--head") + 1]!.split(":")[1]!;
        const n = 12 + prs.size;
        prs.set(branch, n);
        gh.creates++;
        // What the sync would read: the PR at the branch's head in the fork.
        await db.run(db.k.insertInto("items").values({ repo: "app", number: n, kind: "pr", state: "OPEN", title: "x", author: LOGIN, head_oid: git(fork, "rev-parse", `refs/heads/${branch}`), head_ref: branch, created_at: "2026-01-02T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" }));
        if (gh.lose) { gh.lose = false; return ok("", 1); }
        return ok(`https://github.com/storytold/app/pull/${n}\n`);
      }
      if (args[0] === "issue" && args[1] === "comment") { gh.comments++; return ok("https://github.com/storytold/app/issues/5#issuecomment-1\n"); }
      return ok("", 1);
    }
    const at = args.findIndex((a) => a.startsWith("https://github.com/"));
    if (at < 0) return realExec(cmd, args, opt);
    if (args.includes("push")) gh.pushes.push(args.at(-1)!.split(":refs/heads/")[1]!);
    const target = args[at]!.includes("/storytold/") && !args.includes("push") ? upstream : fork;
    return realExec(cmd, args.map((a, i) => (i === at ? target : a)).filter((a, i, all) => a !== "protocol.file.allow=never" && !(a === "-c" && all[i + 1] === "protocol.file.allow=never")), opt);
  };
  const deps = { exec, root: join(dir, "cache"), log: () => {}, mint: async () => "installation-token" };
  const open = async () => openImplementationPr(db, { implementation: (await implementationById(db, started.id))!, diff, base, model: "claude-opus-5-5", checks: [], by: "pipeline" }, deps);

  // GitHub makes the PR but its response is lost; the issue is renamed before the rerun.
  gh.lose = true;
  const first = await open();
  assert.ok(!first.ok && first.retry && /gh pr create/.test(first.reason));
  const branch = (await implementationById(db, started.id))!.branch;
  assert.ok(branch?.startsWith("autocraft/impl-5-crash"), "the branch is kept before the push");
  await db.run(db.k.updateTable("items").set({ title: "Something else entirely" }).where("number", "=", 5));
  const again = await open();
  assert.ok(again.ok, again.ok ? "" : again.reason);
  assert.equal(again.branch, branch);
  assert.ok(again.adopted);
  assert.equal(gh.creates, 1, "no second PR");
  assert.equal(gh.comments, 1);
  assert.equal((await implementationById(db, started.id))!.state, "pr-opened");
  assert.deepEqual((await loadLinks(db, { issues: [{ repo: "app", number: 5 }] })).map((l) => l.pr), [again.number], "the issue's workflow is linked to the PR");
  assert.equal((await listWorkflows(db, { live: true }))[0]!.prNumber, again.number);

  // A run that stopped after the PR was stored adopts the stored PR, at the commit this implementation pushed.
  await setImplementationState(db, started.id, "opening");
  const stored = await open();
  assert.ok(stored.ok && stored.adopted && stored.number === again.number);
  assert.equal(gh.creates, 1);
  assert.equal(gh.comments, 1, "the issue is commented on once per PR");
  assert.deepEqual([...new Set(gh.pushes)], [branch]);

  // Someone else pushed to the branch: the PR is not ours to go on with.
  await db.run(db.k.updateTable("items").set({ head_oid: "c".repeat(40) }).where("number", "=", again.number!));
  await setImplementationState(db, started.id, "opening");
  const foreign = await open();
  assert.ok(!foreign.ok && !foreign.retry && /is not the commit this implementation pushed/.test(foreign.reason));

  // After our PR merged (and closed the issue), a rerun ends the attempt as merged.
  gh.pulls = "merged";
  gh.issue = "closed";
  const merged = await open();
  assert.ok(merged.ok && merged.merged);
  assert.equal((await implementationById(db, started.id))!.state, "merged");
});
