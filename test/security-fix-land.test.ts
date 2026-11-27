// The private fix, the quiet landing, the advisory route and publishing, with a fake gh and git: the states a finding moves
// through, and that nothing a landing writes names the problem.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { before, describe, test } from "node:test";
import type { Exec } from "../src/fixup/git.ts";
import { GITHUB_ACTIONS } from "../src/github/actions.ts";
import { createEnv, hello } from "../src/build/envs.ts";
import { claim, createTask } from "../src/build/tasks.ts";
import { PIPELINE_LOGIN_KEY } from "../src/core/rules.ts";
import { ownFixPrs } from "../src/core/facts.ts";
import { fixOnMain, pollLanding, runAdvisory, stallReason, runLand, runPublish, type LandDeps } from "../src/security/land.ts";
import { runFix, type FixDeps } from "../src/security/fix.ts";
import { fixBranch, giveaway, parseFixReply, patchGiveaway, quietProblem } from "../src/security/rules.ts";
import { loadQuiet } from "../src/data/security/index.ts";

const isQuiet = async (db: Parameters<typeof loadQuiet>[0], repo: string, n: number): Promise<boolean> => (await loadQuiet(db, [`${repo}#${n}`])).has(`${repo}#${n}`);
import { rawFinding } from "../src/security/store.ts";
import { Git } from "../src/fixup/git.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

import { excluded, like } from "../src/db/kx.ts";

mkdirSync(SCRATCH, { recursive: true });
const db = await connectDb(join(mkdtempSync(join(SCRATCH, "sec-fix-")), "dash.db"));
// A confidential build environment that has reported: private fixes and their builds can run.
await db.prepare("INSERT INTO build_envs (id, label, kind, slots, key_hash, confidential, confidential_since, confidential_online_at, created_at) VALUES ('vault', 'vault', 'remote', 1, 'x', 1, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run();
const BY = { operator: "boss" };
const SHA = "b".repeat(40);

type Call = { cmd: string; args: string[]; input?: string };
/** A fake gh and git: `gh` answers by the endpoint; every call is kept for the wording check. */
function fake(answers: { fork?: { code: number; stderr: string }; pr?: string } = {}): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, input: opts?.input });
    const a = args.join(" ");
    if (cmd === "git" && a.includes("ls-tree")) return { code: 0, stdout: a.includes("crates/psd/Cargo.toml") ? "100644 blob abc123\tcrates/psd/Cargo.toml\n" : "", stderr: "" };
    if (cmd === "git" && a.includes("cat-file blob") && a.includes("crates/psd/Cargo.toml")) return { code: 0, stdout: '[package]\nname = "psd"\nversion = "0.3.2"\n', stderr: "" };
    if (cmd === "git") return { code: 0, stdout: a.includes("rev-parse") ? `${SHA}\n` : "", stderr: "" };
    if (a.includes("--jq .parent.full_name")) return { code: 0, stdout: "storytold/photocraft\n", stderr: "" };
    if (a.startsWith("pr list")) return { code: 0, stdout: "", stderr: "" };
    if (a.startsWith("pr create")) return { code: 0, stdout: `${answers.pr ?? "https://github.com/storytold/photocraft/pull/77"}\n`, stderr: "" };
    if (a.includes("security-advisories/GHSA") && a.includes("/forks")) return { code: answers.fork?.code ?? 0, stdout: answers.fork?.code ? "" : "storytold/photocraft-ghsa-aaaa\n", stderr: answers.fork?.stderr ?? "" };
    if (a.includes("security-advisories") && a.includes("POST") && !a.includes("GHSA")) return { code: 0, stdout: "GHSA-aaaa-bbbb-cccc\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}
const deps = (exec: Exec): LandDeps => ({ exec, root: SCRATCH, who: async () => ({ login: "pipeline-bot" }), log: () => {} });

let seq = 0;
/** A finding in `state` with a fix, as the fix step leaves it. */
async function finding(state: string, extra: Record<string, string | number | null> = {}): Promise<number> {
  const n = ++seq;
  const at = "2026-11-05T00:00:00Z";
  await db.run(db.k.insertInto("security_findings").values({
    repo: "photocraft", number: n, scan_id: 1, area: "psd", title: "Layer length trusted", severity: "high", urgent: 0, state, refs: '[{"path":"crates/psd/src/layer.rs","line":118,"claim":""}]',
    reach: "open file", impact: "writes outside", fingerprint: `fp${n}`, fix_commit: SHA, fix_title: "Check layer length before copying",
    fix_summary: "The reader compares the length with the remaining data and returns an error.", fix_branch: `fix-check-layer-length-${n}`,
    fix_files: JSON.stringify(["crates/psd/src/layer.rs", "crates/psd/tests/autocraft_regression_1.rs"]), created_at: at, updated_at: at,
  }));
  for (const [k, v] of Object.entries(extra)) await db.run(db.k.updateTable("security_findings").set({ [k]: v }).where("repo", "=", "photocraft").where("number", "=", n));
  return n;
}
const stateOf = async (n: number) => (await rawFinding(db, "photocraft", n))!;

before(async () => {
  await db.run(db.k.insertInto("security_scans").values({ id: 1, repo: "photocraft", state: "done", started_by: "boss", started_at: "2026-11-05T00:00:00Z", commit_sha: SHA }));
});

describe("private fix and landing", () => {
  test("the fix reply must follow the form, and wording that names the problem is found", () => {
    const ok = parseFixReply("TITLE: Check layer length\nSUMMARY: Compare with the remaining data.\n---PATCH---\ndiff --git a/x.rs b/x.rs\n--- a/x.rs\n+++ b/x.rs\n");
    assert.equal(ok?.title, "Check layer length");
    assert.equal(parseFixReply("diff --git a/x b/x"), null);
    assert.match(quietProblem("Fix buffer overflow in PSD reader", "x") ?? "", /overflow/);
    assert.equal(quietProblem("Check layer length", "Compare the length with the remaining data."), null);
    assert.equal(patchGiveaway("diff --git a/x.rs b/x.rs\n+    // block the attacker\n"), "attacker");
    assert.equal(patchGiveaway("diff --git a/x.rs b/x.rs\n+    return Err(Error::Overflow);\n-    // security\n"), null, "only added lines count, and ordinary identifiers do not");
    assert.equal(giveaway("Validate chunk sizes"), null);
    // Comments, test names and file names use the full list; other code tokens only the narrow one.
    assert.equal(patchGiveaway("diff --git a/x.rs b/x.rs\n+    // reject path traversal\n"), "traversal");
    assert.equal(patchGiveaway("diff --git a/x.rs b/x.rs\n+fn rejects_crafted_input() {}\n"), "crafted");
    assert.equal(patchGiveaway("diff --git a/src/sanitize_names.rs b/src/sanitize_names.rs\nnew file mode 100644\n--- /dev/null\n+++ b/src/sanitize_names.rs\n"), "sanitize", "a new file's name counts");
    assert.equal(patchGiveaway("diff --git a/src/sanitize.rs b/src/sanitize.rs\n--- a/src/sanitize.rs\n+++ b/src/sanitize.rs\n"), null, "an existing file's name does not");
    assert.equal(patchGiveaway("diff --git a/x.rs b/x.rs\n@@ -1,1 +1,2 @@\n let y = 1;\n+    * crafted\n"), null, "a star line outside a block comment is code");
    assert.equal(patchGiveaway("diff --git a/x.rs b/x.rs\n@@ -1,2 +1,3 @@\n /*\n+ * crafted input\n */\n"), "crafted", "inside a block comment it is a comment");
    // L1: the branch has the shape of the other pipeline branches and no finding number.
    assert.match(fixBranch("Check layer length", "a1b2c3"), /^autocraft\/fix-check-layer-length-a1b2c3$/);
  });

  test("a fix that cannot start returns the finding to new with a note", async () => {
    const n = await finding("fixing");
    await db.run(db.k.updateTable("security_scans").set({ commit_sha: null }).where("id", "=", 1));
    await runFix(db, "photocraft", n, { log: () => {} } as unknown as FixDeps);
    await db.run(db.k.updateTable("security_scans").set({ commit_sha: SHA }).where("id", "=", 1));
    assert.equal((await stateOf(n)).state, "new");
    assert.match((await stateOf(n)).note ?? "", /no pinned commit/);
  });

  /** Runs a fix whose every reply is unusable, so each round fails before the build; `resumable` is whether the fake ask can continue a session. */
  async function failingRounds(resumable: boolean) {
    const n = await finding("fixing");
    const seen: { resume?: { id: string; message: string }; previous: unknown }[] = [];
    const stores: string[] = [];
    const deps: FixDeps = {
      exec: fake().exec, root: SCRATCH, log: () => {}, cancelled: async () => false,
      fetchCrates: async () => ({ ok: true, rust: true, crates: [{ name: "psd", dir: "crates/psd" }] }) as never,
      checkout: async () => "/checkout",
      who: async () => ({ login: "pipeline-bot", email: "bot@example.com" }),
      ask: async (_id, input, o) => {
        const r = o.session?.resume;
        seen.push({ ...(r && { resume: { id: r.session.id, message: r.message } }), previous: (input as { previous?: unknown }).previous });
        const dir = mkdtempSync(join(SCRATCH, "sess-"));
        stores.push(dir);
        return { text: "no diff here", cost: 1, resumed: r !== undefined && resumable, kept: { id: `s${seen.length}`, dir, account: "a", checkout: "/checkout" } };
      },
    };
    await runFix(db, "photocraft", n, deps);
    const flags = (await db.all(db.k.selectFrom("security_calls").select("resumed").where("kind", "=", "fix").where("finding_number", "=", n).orderBy("id"))).map((r) => r.resumed);
    return { seen, stores, flags };
  }

  test("a fix round after a failed round continues that round's session with the failure as the message", async () => {
    const { seen, stores, flags } = await failingRounds(true);
    assert.equal(seen.length, 3);
    assert.equal(seen[0]!.resume, undefined);
    assert.equal(seen[1]!.resume?.id, "s1");
    assert.equal(seen[2]!.resume?.id, "s2");
    assert.match(seen[1]!.resume!.message, /did not follow the form/);
    assert.ok(seen[1]!.resume!.message.length < 600, "the message does not repeat the prompt");
    assert.deepEqual(flags, [0, 1, 1]);
    assert.ok(stores.every((d) => !existsSync(d)), "the kept sessions are deleted when the job ends");
  });

  test("a fix round that cannot continue the session is a new call that carries the earlier diff and the failure", async () => {
    const { seen, flags } = await failingRounds(false);
    assert.equal(seen.length, 3);
    assert.ok(seen[1]!.previous && (seen[1]!.previous as { failure: string }).failure.includes("did not follow the form"));
    assert.deepEqual(flags, [0, 0, 0]);
  });

  test("quiet landing: a plain pull request, then landed when it merges, then published", async () => {
    const f = fake();
    const n = await finding("landing");
    await runLand(db, "photocraft", n, BY, deps(f.exec));
    assert.equal((await stateOf(n)).state, "landing");
    assert.equal((await stateOf(n)).fix_pr, 77);
    // Everything sent to GitHub for the landing: arguments and bodies.
    const sent = f.calls.map((c) => `${c.args.join(" ")} ${c.input ?? ""}`).join("\n");
    assert.equal(giveaway(sent), null, `a landing write names the problem: ${giveaway(sent)}`);
    assert.match(sent, /refs\/heads\/fix-check-layer-length/);
    const pr = f.calls.find((c) => c.args[0] === "pr" && c.args[1] === "create")!;
    assert.ok(pr.args.includes("Check layer length before copying"));

    assert.equal(await pollLanding(db, deps(f.exec)), 0, "the pull request is still open");
    await db.run(db.k.insertInto("items").values({ repo: "photocraft", number: 77, kind: "pr", state: "MERGED" }));
    assert.equal(await pollLanding(db, deps(f.exec)), 1);
    assert.equal((await stateOf(n)).state, "landed");

    await runPublish(db, "photocraft", n, BY, true, deps(f.exec));
    assert.equal((await stateOf(n)).state, "published");
    assert.equal((await stateOf(n)).ghsa_id, "GHSA-aaaa-bbbb-cccc", "a draft advisory is made first for a quiet landing");
    const created = f.calls.find((c) => c.args.includes("POST") && c.args.some((x) => x.endsWith("/security-advisories")))!;
    assert.equal(JSON.parse(created.input!).vulnerabilities[0].vulnerable_version_range, "<= 0.3.2", "the draft names the crate's version as affected");
    const wrote = f.calls.filter((c) => c.args.join(" ").includes("security-advisories")).map((c) => c.args.join(" "));
    assert.ok(wrote.some((w) => w.includes("PATCH")) && wrote.some((w) => w.endsWith("/cve")));
  });

  test("no public branch exists unless every public text passed the wording guard", async () => {
    // Title, summary (body), file list and commit message are all checked before the first push.
    for (const extra of [{ fix_title: "Fix path traversal in the importer" }, { fix_summary: "Stops a crafted file from escaping." }] as Record<string, string>[]) {
      const f = fake();
      const n = await finding("landing", extra);
      await runLand(db, "photocraft", n, BY, deps(f.exec));
      assert.equal((await stateOf(n)).state, "ready", JSON.stringify(extra));
      assert.equal(f.calls.some((c) => (c.args[0] === "pr" && c.args[1] === "create") || c.args.includes("push")), false, JSON.stringify(extra));
    }
    // The commit message is read from the commit and refused when it names the problem.
    const f = fake();
    const bad: Exec = async (cmd, args, opts) => (cmd === "git" && args.includes("--format=%B") ? { code: 0, stdout: "Check length\n\nBlocks a path traversal.\n", stderr: "" } : f.exec(cmd, args, opts));
    const n = await finding("landing");
    await assert.rejects(runLand(db, "photocraft", n, BY, deps(bad)), /may not mention/);
    assert.equal(f.calls.some((c) => c.args.includes("push")), false);
  });

  test("a refused git push is an admin wait on the advisory route", async () => {
    const f = fake({ fork: { code: 0, stderr: "" } });
    const denied: Exec = async (cmd, args, opts) => (cmd === "git" && args.includes("push") ? { code: 128, stdout: "", stderr: "remote: Permission to storytold/x denied to bot.\nfatal: unable to access: The requested URL returned error: 403" } : f.exec(cmd, args, opts));
    const n = await finding("landing", { urgent: 1 });
    await runAdvisory(db, "photocraft", n, BY, deps(denied));
    assert.equal((await stateOf(n)).state, "awaiting-admin");
  });

  test("the quiet pull request is the pipeline's own: counted as an own fix PR; a stalled one shows why", async () => {
    await db.run(db.k.insertInto("settings").values({ key: PIPELINE_LOGIN_KEY, value: "pipeline-bot" }).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
    await db.run(db.k.insertInto("tracked_repos").values({ name: "photocraft", pipeline: 1 }).onConflict((oc) => oc.column("name").doUpdateSet({ pipeline: 1 })));
    const n = await finding("landing", { fix_pr: 91 });
    assert.ok((await ownFixPrs(db, "photocraft")).prs.has("photocraft#91"), "counted as an own fix PR");
    assert.ok((await ownFixPrs(db, "photocraft")).quiet.has("photocraft#91"));
    await db.run(db.k.updateTable("security_findings").set({ state: "landed" }).where("number", "=", n));
    assert.ok((await ownFixPrs(db, "photocraft")).quiet.has("photocraft#91"), "still quiet after the merge, until published");
    await db.run(db.k.updateTable("security_findings").set({ state: "landing" }).where("number", "=", n));
    await db.run(db.k.insertInto("items").values({ repo: "photocraft", number: 5, kind: "issue", state: "OPEN" }));
    // The finding page shows why a stalled pull request waits.
    await db.run(db.k.insertInto("items").values({ repo: "photocraft", number: 91, kind: "pr", state: "OPEN", ci_state: "FAILURE" }));
    assert.match(await stallReason(db, "photocraft", 91), /checks failed/);
    assert.equal(giveaway(await stallReason(db, "photocraft", 91)), null);
    assert.equal((await stateOf(n)).state, "landing");
  });

  test("a security fix's build tasks run for a repo outside the pipeline scope", async () => {
    const id = "fixenv";
    await createEnv(db, { id, label: id, kind: "local-sandbox", slots: 2, confidential: true }, "op");
    await hello(db, id, { version: "1.0", capabilities: { os: "linux", arch: "x86_64", cpus: 8, memGb: 32, diskGb: 200, display: false, gpu: false, toolchains: ["rust-stable"] }, slots: 8 });
    const plan = [{ name: "t", cmd: ["true"], network: "none" as const, timeoutSec: 10 }];
    await db.run(db.k.deleteFrom("tracked_repos"));
    const other = await createTask(db, { step: "verify", repo: "photocraft", headSha: SHA, plan });
    const fix = await createTask(db, { step: "fix-check", repo: "photocraft", headSha: SHA, plan });
    const got = (await claim(db, id, 2)).tasks.map((t) => t.id);
    assert.deepEqual(got, [fix]);
    assert.ok(!got.includes(other));
  });

  test("a pull request closed without merging returns the fix to ready", async () => {
    const n = await finding("landing", { fix_pr: 78 });
    await db.run(db.k.insertInto("items").values({ repo: "photocraft", number: 78, kind: "pr", state: "CLOSED" }));
    await pollLanding(db, deps(fake().exec));
    assert.equal((await stateOf(n)).state, "ready");
    assert.equal((await stateOf(n)).fix_pr, null);
    assert.ok(await isQuiet(db, "photocraft", 78), "a closed quiet pull request stays quiet if it is reopened");
    await db.run(db.k.updateTable("security_findings").set({ state: "published" }).where("number", "=", n));
    assert.ok(!await isQuiet(db, "photocraft", 78), "and is not quiet once the advisory is published");
  });

  test("advisory route: the fork steps, an admin wait on a refusal, and the merge seen on main", async () => {
    const refused = fake({ fork: { code: 1, stderr: "gh: Not Found (HTTP 404)" } });
    const n = await finding("landing", { urgent: 1 });
    await runAdvisory(db, "photocraft", n, BY, deps(refused.exec));
    assert.equal((await stateOf(n)).state, "awaiting-admin");
    assert.equal((await stateOf(n)).ghsa_id, "GHSA-aaaa-bbbb-cccc");
    assert.match((await stateOf(n)).note ?? "", /admin must/);
    assert.equal(refused.calls.some((c) => c.args.includes("push")), false, "nothing is pushed before the fork exists");

    // Pressing Advisory again resumes after the steps that are done.
    await db.run(db.k.updateTable("security_findings").set({ state: "landing" }).where("number", "=", n));
    const ok = fake({ pr: "https://github.com/storytold/photocraft-ghsa-aaaa/pull/3" });
    await runAdvisory(db, "photocraft", n, BY, deps(ok.exec));
    const row = await stateOf(n);
    assert.equal(row.state, "awaiting-admin");
    assert.equal(row.fork, "storytold/photocraft-ghsa-aaaa");
    assert.equal(row.fix_pr, 3);
    assert.ok(ok.calls.some((c) => c.cmd === "git" && c.args.some((a) => a.includes("storytold/photocraft-ghsa-aaaa.git"))), "the fix is pushed to the private fork");
    assert.ok(!ok.calls.some((c) => c.args.includes("POST") && c.args.some((a) => a.endsWith("/security-advisories"))), "the advisory is not created twice");

    // The merge shows as the fix commit being part of the default branch (the fake git answers yes to the ancestor check).
    assert.equal(await fixOnMain(new Git(ok.exec, SCRATCH, "photocraft"), SHA, SHA), true);
    assert.equal(await pollLanding(db, deps(ok.exec)), 1);
    assert.equal((await stateOf(n)).state, "advisory");
  });

  test("the merge of the fix is also seen when main has a commit with the same patch", async () => {
    const answer = (): Exec => async (cmd, args) => {
      const a = args.join(" ");
      if (a.includes("--is-ancestor")) return { code: 1, stdout: "", stderr: "" };
      if (args.includes("diff-tree")) return { code: 0, stdout: "diff of the fix", stderr: "" };
      if (args.includes("log")) return { code: 0, stdout: "log of main", stderr: "" };
      if (args.includes("patch-id")) return { code: 0, stdout: "abc123 0000\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    assert.equal(await fixOnMain(new Git(answer(), SCRATCH, "photocraft"), SHA, "c".repeat(40)), true);
    const other: Exec = async (cmd, args, opts) => (args.includes("patch-id") && opts?.input === "log of main" ? { code: 0, stdout: "def456 0000\n", stderr: "" } : answer()(cmd, args, opts));
    assert.equal(await fixOnMain(new Git(other, SCRATCH, "photocraft"), SHA, "c".repeat(40)), false);
  });

  test("security audit actions are not GitHub feed rows", async () => {
    const actions = (await db.all(db.k.selectFrom("audit").select("action").distinct().where((eb) => like(db, "action", eb.val("security-%"))))).map((a) => a.action);
    assert.ok(actions.length > 0);
    for (const a of actions) assert.equal(a in GITHUB_ACTIONS, false, a);
  });
});
