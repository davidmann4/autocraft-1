import { SAMPLE_CIFIX_PRS } from "../src/cifix/types.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { askClaude } from "../src/classify/run.ts";
import { claudeArgs, claudeParts } from "../src/prompts/index.ts";
import { SAMPLE_OPUS_PRS } from "../src/prompts/samples.ts";
import { SAMPLE_FIXUP_CHECK } from "../src/patchcheck/types.ts";
import { SAMPLE_FIXUP_PRS } from "../src/prompts/samples.ts";
import { SAMPLE_VERIFY_PLAN } from "../src/verify/types.ts";
import { BatchReader, buildCheckout, holdCheckouts, pruneCheckouts, safePath } from "../src/sandbox/checkout.ts";
import { REPO_PATH, sandboxCommand } from "../src/sandbox/command.ts";
import type { SessionAsk } from "../src/prepush/resume.ts";
import { fakeTaskRunner } from "./fake-runner.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { rowid } from "../src/db/kx.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "sandbox-test-"));

const spec = { claudeBin: "/h/claude-bin", checkout: "/h/checkout", credentials: "/h/acct/.credentials.json", claudeArgs: ["-p", "--tools", "Read"] };
const pairs = (args: string[], flag: string) => args.flatMap((a, i) => (a === flag ? [args.slice(i + 1, i + 3).join(" ")] : []));

describe("sandbox command", () => {
  const { cmd, args } = sandboxCommand(spec);

  test("binds only claude, the system, the checkout read-only and one credentials file; nothing of the host home", () => {
    assert.equal(cmd, "/usr/bin/bwrap");
    assert.deepEqual(pairs(args, "--ro-bind"), ["/usr /usr", "/etc/ssl /etc/ssl", "/etc/resolv.conf /etc/resolv.conf", "/h/acct/.credentials.json /home/sandbox/.claude/.credentials.json", "/h/claude-bin /opt/claude/claude", `/h/checkout ${REPO_PATH}`]);
    assert.deepEqual(pairs(args, "--bind"), [], "nothing is writable");
    assert.equal(REPO_PATH, "/repo");
    assert.deepEqual(pairs(args, "--tmpfs").map((t) => t.split(" ")[0]), ["/tmp", "/home/sandbox", "/home/sandbox/.claude", "/work"]);
    assert.ok(!args.some((a) => a === "--dev-bind" || a === "--bind-try" || a === homedir() || a.startsWith(`${homedir()}/`)));
  });

  test("the workspace is mounted read-only: /repos/<name>, the agents file and extra mounts", () => {
    const c = sandboxCommand({ ...spec, shared: [{ name: "craft-libs", dir: "/h/libs" }], agentsFile: "/h/agents.json", extraMounts: [{ host: "/h/items", path: "/items" }] });
    const ro = pairs(c.args, "--ro-bind");
    for (const m of ["/h/libs /repos/craft-libs", "/h/agents.json /agents.json", "/h/items /items"]) assert.ok(ro.includes(m), m);
    assert.deepEqual(pairs(c.args, "--bind"), []);
    assert.ok(pairs(c.args, "--dir").some((d) => d.startsWith("/repos")));
    assert.ok(!sandboxCommand(spec).args.includes("/repos"), "no workspace, no /repos");
    assert.throws(() => sandboxCommand({ ...spec, shared: [{ name: "../x", dir: "/h" }] }));
    assert.throws(() => sandboxCommand({ ...spec, extraMounts: [{ host: "/h", path: "/a/../etc" }] }));
  });



  test("new namespaces except the network, dies with the parent, clean environment", () => {
    for (const f of ["--unshare-all", "--share-net", "--die-with-parent", "--new-session"]) assert.ok(args.includes(f), f);
    assert.ok(!args.includes("--setenv") && !args.includes("--clearenv"));
    assert.deepEqual(sandboxCommand(spec).env, { CLAUDE_CONFIG_DIR: "/home/sandbox/.claude", DISABLE_AUTOUPDATER: "1", HOME: "/home/sandbox", LANG: "C.UTF-8", PATH: "/usr/bin" });
    assert.deepEqual(args.slice(args.indexOf("--chdir"), args.indexOf("--chdir") + 2), ["--chdir", "/work"]);
    assert.ok(!args.some((a) => a.startsWith("/work/")), "the checkout is not under the working directory");
  });




});

describe("sandbox adoption", () => {
  const cases = [
    ["fixup.patch", SAMPLE_FIXUP_PRS, 20], ["cifix.patch", SAMPLE_CIFIX_PRS, 20], ["verify.plan", SAMPLE_VERIFY_PLAN, 20],
    ["fixup.check", SAMPLE_FIXUP_CHECK, 20],
  ] as const;
  for (const [id, sample, turns] of cases) {
  }

});

describe("instruction files", () => {
});

describe("checkout", () => {
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
  const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: gitEnv, encoding: "utf8" }).trim();
  const work = join(dir, "work");
  mkdirSync(join(work, "src"), { recursive: true });
  g(work, "init", "-q");
  writeFileSync(join(work, "src/lib.rs"), "fn main() {}\n");
  writeFileSync(join(work, "run.sh"), "#!/bin/sh\n");
  execFileSync("chmod", ["+x", join(work, "run.sh")]);
  writeFileSync(join(work, "big.bin"), Buffer.alloc(3 * 1024 * 1024));
  symlinkSync("/etc/passwd", join(work, "link"));
  g(work, "add", "-A");
  g(work, "update-index", "--add", "--cacheinfo", "160000,1111111111111111111111111111111111111111,sub");
  g(work, "commit", "-qm", "c");
  const sha = g(work, "rev-parse", "HEAD");
  const bare = join(dir, "bare.git");
  g(dir, "clone", "-q", "--bare", work, bare);

  test("only regular small files are copied: no symlink, submodule or oversized file; modes drop to plain files", async () => {
    const dest = join(dir, "out", "app", sha);
    const r = await buildCheckout(bare, sha, dest);
    assert.ok(r.ok);
    assert.equal(readFileSync(join(dest, "src/lib.rs"), "utf8"), "fn main() {}\n");
    assert.ok(existsSync(join(dest, "run.sh")));
    assert.equal(lstatSync(join(dest, "run.sh")).mode & 0o111, 0);
    for (const gone of ["link", "big.bin", "sub"]) assert.equal(existsSync(join(dest, gone)), false, gone);
    assert.equal((await buildCheckout(bare, sha, dest)).ok, true, "reused");
  });

  test("cat-file output split at any byte gives the same blobs; a cut-off stream is not complete", () => {
    const out = Buffer.from("aa blob 3\nabc\nbb blob 0\n\ncc blob 2\n\n\n\n");
    const got: string[] = [];
    const r = new BatchReader(3, (i, b) => got.push(`${i}:${b.toString()}`));
    for (let i = 0; i < out.length; i++) r.push(out.subarray(i, i + 1));
    assert.deepEqual(got, ["0:abc", "1:", "2:\n\n"]);
    assert.equal(r.end(), true);
    const cut = new BatchReader(3, () => {});
    cut.push(out.subarray(0, 20));
    assert.equal(cut.end(), false);
  });

  test("over the size cap, the least recently used checkouts go first and a held one stays", () => {
    const root = join(dir, "lru");
    const now = Date.now();
    const make = (name: string, minutesAgo: number): string => {
      const d = join(root, "app", name);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "f"), Buffer.alloc(1000));
      const t = new Date(now - minutesAgo * 60_000);
      utimesSync(d, t, t);
      return d;
    };
    const oldest = make("a", 30), held = make("b", 20), mid = make("c", 10), newest = make("d", 1);
    const release = holdCheckouts([held]);
    const t = new Date(now - 20 * 60_000);
    utimesSync(held, t, t);
    assert.equal(pruneCheckouts(root, 24 * 3600_000, now, 2500), 2);
    release();
    assert.deepEqual([oldest, held, mid, newest].map(existsSync), [false, true, false, true]);
  });



  test("unsafe paths are rejected", () => {
    for (const p of ["../x", "a/../b", "/abs", ".git/config", "a/.GIT/x", "a//b", ""]) assert.equal(safePath(p), false, p);
    assert.equal(safePath("src/.github/ci.yml"), true);
  });


});

const bwrapOk = existsSync("/usr/bin/bwrap") && spawnSync("/usr/bin/bwrap", ["--unshare-all", "--ro-bind", "/usr", "/usr", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "/usr/bin/true"]).status === 0;

describe("bubblewrap (no model)", { skip: !bwrapOk && "bwrap unavailable" }, () => {
  const checkout = join(dir, "co");
  mkdirSync(checkout, { recursive: true });
  writeFileSync(join(checkout, "a.txt"), "in repo\n");
  const secret = join(dir, "secret.txt");
  writeFileSync(secret, "host secret\n");
  const creds = join(dir, "credentials.json");
  writeFileSync(creds, "{}");
  const sh = (script: string) => {
    const c = sandboxCommand({ claudeBin: "/usr/bin/sh", checkout, credentials: creds, claudeArgs: ["-c", script] });
    return spawnSync(c.cmd, c.args, { encoding: "utf8", env: c.env });
  };

  test("sees the checkout read-only and nothing else of the host", () => {
    assert.equal(sh(`cat ${REPO_PATH}/a.txt`).stdout, "in repo\n");
    assert.notEqual(sh(`echo x > ${REPO_PATH}/b.txt`).status, 0);
    assert.notEqual(sh(`cat ${secret}`).status, 0);
    assert.notEqual(sh(`ls ${homedir()}`).status, 0);
    assert.equal(sh("ls /home").stdout.trim(), "sandbox");
    assert.equal(sh("ls -A /home/sandbox/.claude").stdout.trim(), ".credentials.json");
    assert.equal(sh("env | grep -c HOME").stdout.trim(), "1");
  });
});

describe("askClaude in tool mode", async () => {
  const db = await connectDb(join(dir, "t.db"));
  process.env.AUTOCRAFT_CHECKOUT_DIR = join(dir, "checkouts");
  const checkout = join(dir, "checkouts", "photocraft", "b".repeat(40));
  test("a sandboxed call hands the Task Runner the checkout and the sandbox arguments, records turns, removes token-like text", async () => {
    const leak = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4";
    const runner = await fakeTaskRunner(db, () => ({ text: `{"ref":"x","reason":"${leak}"}`, turns: 4 }));
    try {
      const r = await askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db, { checkout });
      const [call] = runner.calls;
      assert.ok(call!.mounts.some((m) => m.path === REPO_PATH && "sha" in m && m.sha === "b".repeat(40)), "the checkout is mounted at the repo path");
      assert.ok(call!.hints.claude!.args.includes("--allowedTools") && call!.hints.claude!.args.includes("--no-session-persistence"), "tools on, and no session kept");
      assert.equal(r!.turns, 4);
      assert.ok(!r!.text.includes(leak));
      const run = await db.get(db.k.selectFrom("agent_runs").select("summary").orderBy(rowid("agent_runs"), "desc").limit(1));
      assert.match(run?.summary ?? "", /4 turns/);
      // Without a checkout the same prompt runs tool-free.
      await askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db);
      assert.deepEqual(runner.calls[1]!.mounts, []);
      assert.deepEqual(runner.calls[1]!.hints.claude!.args, claudeArgs("review.opus", "opus", false, undefined, claudeParts("review.opus", SAMPLE_OPUS_PRS, false).system));
    } finally {
      await runner.stop();
    }
  });

  test("the reply is parsed before scrubbing, so token-like review text keeps the JSON valid", async () => {
    const reply = '{"ref":"x","reason":"token: aB3dE9fG2hJ5kL8mN4pQ and password=Zx9Yw8Vu7Ts6Rq5Po4 in the text"}';
    const runner = await fakeTaskRunner(db, () => ({ text: reply, turns: 2 }));
    try {
      const r = await askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db, { checkout });
      assert.ok(r, "parsed");
      assert.ok(!r!.text.includes("aB3dE9") && !r!.text.includes("Zx9Yw8"), r!.text);
      assert.doesNotThrow(() => JSON.parse(r!.text));
    } finally {
      await runner.stop();
    }
  });

  test("a call that asks to keep its session reports it, and a resume continues the session of that call", async () => {
    const runner = await fakeTaskRunner(db, (c) => ({ text: c.resume ? "second" : "first", sessionId: "s1", turns: 1 }));
    try {
      const session: SessionAsk = {};
      assert.equal((await askClaude("fixup.patch", "sonnet", SAMPLE_FIXUP_PRS, db, { checkout, session }))!.text, "first");
      const kept = session.kept!;
      assert.equal(kept.checkout, checkout);
      assert.ok(!runner.calls[0]!.hints.claude!.args.includes("--no-session-persistence"), "the session is kept");
      const again: SessionAsk = { resume: { session: kept, message: "fix it" } };
      assert.equal((await askClaude("fixup.patch", "sonnet", SAMPLE_FIXUP_PRS, db, { checkout, session: again }))!.text, "second");
      assert.equal(runner.calls[1]!.resume?.parentCallId, runner.calls[0]!.callId);
      assert.match(runner.calls[1]!.stdin, /fix it/);
    } finally {
      await runner.stop();
    }
  });
});
