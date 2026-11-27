// Shared setup of test/journeys.test.ts and test/journeys-work.test.ts.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach } from "node:test";
import { exec, type Exec, type ExecResult } from "../src/fixup/git.ts";
import { type CifixDeps } from "../src/cifix/index.ts";
import { type FixupDeps } from "../src/fixup/index.ts";
import type { Querier } from "../src/mirror.ts";
import { storeArtifact, tempPath } from "../src/build/artifacts.ts";
import { type PremergeDeps } from "../src/premerge/review.ts";
import { appLane } from "./acting.ts";
import { CHECK, T1, tmpdir, world, type World } from "./world-db.ts";

process.env.AUTOCRAFT_DIFF_CACHE = join(tmpdir("diffs"), "cache");

export const quiet = () => {};
let current: World | null = null;
/** Closes `w` after the test. */
export const keep = (w: World): World => (current = w);
export const fresh = async (): Promise<World> => keep(await (await world()).repo());
afterEach(() => current?.close());

export const DIFF = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,1 +1,1 @@\n-let a = 1;\n+let a = 2;\n";
export const premergeDeps: PremergeDeps = { fetchDiff: async () => ({ ok: true, text: DIFF }), model: "opus", maxChars: 120_000 };
export const premergeReply = (n: number) => JSON.stringify({ ref: `app#${n}`, findings: [], searched: "callers" });
export const merged = async (w: World) => await w.db.all(w.db.k.selectFrom("merges").select(["number", "head_oid", "outcome"]).orderBy("number"));

/** The sandbox finished a lint task: the formatter's diff (if it changed anything) and clippy's JSON lines come back as artifacts. */
async function putLint(w: World, id: number, o: { format?: string; diagnostics?: { line: number }[]; file?: string } = {}): Promise<void> {
  const put = async (name: string, text: string) => { const tmp = tempPath(id); writeFileSync(tmp, text); await storeArtifact(w.db, id, name, tmp); };
  const diag = (line: number) => JSON.stringify({ reason: "compiler-message", message: { level: "warning", message: "needless", code: { code: "clippy::needless_return" }, spans: [{ file_name: o.file ?? "src/lib.rs", line_start: line, line_end: line, is_primary: true }], rendered: `warning: needless at line ${line}\n` } });
  await put("clippy.txt", [...(o.diagnostics ?? []).map((d) => diag(d.line)), JSON.stringify({ reason: "build-finished", success: !o.diagnostics?.length })].join("\n") + "\n");
  if (o.format) await put("format.txt", o.format);
}

export async function endLint(w: World, id: number, o: Parameters<typeof putLint>[2] = {}): Promise<void> {
  await putLint(w, id, o);
  await w.db.run(w.db.k.updateTable("build_tasks").set({ state: "done", results: "[]", ended_at: T1 }).where("id", "=", id));
}

export const sh = (cwd: string, ...args: string[]): string => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A contributor's fork on disk (branch fix-<n>) that stands in for both GitHub URLs; git runs for real, gh is faked. */
export function gitWorld(n: number, lib = "fn a() {}\nfn main() { a(); }\n", conflict = false) {
  const root = tmpdir("git");
  const work = join(root, "work");
  mkdirSync(join(work, "src"), { recursive: true });
  sh(work, "init", "-q", "-b", conflict ? "main" : `fix-${n}`);
  writeFileSync(join(work, "src/lib.rs"), lib);
  sh(work, "add", "-A");
  sh(work, "commit", "-q", "-m", "contributor");
  if (conflict) {
    // The PR and the default branch both change line 2 of the file.
    sh(work, "checkout", "-q", "-b", `fix-${n}`);
    writeFileSync(join(work, "src/lib.rs"), lib.replace("main() { a(); }", "main() { a(); a(); }"));
    sh(work, "commit", "-q", "-am", "contributor change");
    sh(work, "checkout", "-q", "main");
    writeFileSync(join(work, "src/lib.rs"), lib.replace("main() { a(); }", "main() { a(); b(); }"));
    sh(work, "commit", "-q", "-am", "base change");
    sh(work, "checkout", "-q", `fix-${n}`);
  }
  const head = sh(work, "rev-parse", "HEAD");
  const fork = join(root, "fork.git");
  sh(root, "clone", "-q", "--bare", work, fork);
  sh(fork, "update-ref", `refs/pull/${n}/head`, head);
  const pushes: { lease: string; to: string }[] = [];
  const edit = (from: string, to: string) => `diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,2 +1,2 @@\n${from}${to}`;
  const patch = lib.includes("main() { a(); }")
    ? edit("-fn a() {}\n-fn main() { a(); }\n", "+fn b() {}\n+fn main() { b(); }\n")
    : edit("-fn a() {}\n-fn main() { b(); }\n", "+fn b() {}\n+fn main() { b(); }\n");
  return {
    head, pushes, fork, patch,
    branchHead: () => sh(fork, "rev-parse", `refs/heads/fix-${n}`),
    deps(w: World): FixupDeps {
      const querier: Querier = {
        ...w.gh.querier,
        query: async (query: string, vars: object) => query.includes("headRefName")
          ? { repository: { pullRequest: { id: `P${n}`, state: "OPEN", isDraft: false, headRefOid: head, headRefName: `fix-${n}`, maintainerCanModify: true, mergeable: conflict ? "CONFLICTING" : "MERGEABLE", headRepository: { nameWithOwner: "contrib/app" }, assignees: { nodes: [] } } } }
          : w.gh.querier.query(query, vars),
      } as Querier;
      const run: Exec = async (cmd, args, o = {}): Promise<ExecResult> => {
        if (cmd === "gh") {
          if (args[0] === "api") return { code: 0, stdout: JSON.stringify({ login: "pipeline-bot", id: 42, node_id: "U42" }), stderr: "" };
          w.gh.writes.push({ kind: "comment", number: n, detail: o.input });
          return { code: 0, stdout: "", stderr: "" };
        }
        // GitHub's URLs point at the fork on disk, which needs the file protocol.
        const toFork = args.map((a) => (a.startsWith("https://github.com/") ? fork : a));
        const local = toFork.filter((a, i) => a !== "protocol.file.allow=never" && !(a === "-c" && toFork[i + 1] === "protocol.file.allow=never"));
        if (args.includes("push")) {
          const lease = args.find((a) => a.startsWith("--force-with-lease="))!.split(":")[1]!;
          const to = args.find((a) => /^[0-9a-f]{40}:/.test(a))!.split(":")[0]!;
          pushes.push({ lease, to });
          w.gh.writes.push({ kind: "push", number: n, head: to });
        }
        return exec("git", local, { ...o });
      };
      return {
        querier, exec: run, now: () => new Date(T1), root: join(root, "cache"),
        fetchDiff: async () => ({ ok: true, text: "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-x\n+fn a() {}\n" }),
        ask: async () => patch,
        check: async () => JSON.stringify({ verdict: "approve", reasons: "matches the listed fix", problems: [] }),
        lane: appLane(querier),
      };
    },
    /** The CI fix step's deps: the failed check's log names src/lib.rs. */
    cifixDeps(w: World): CifixDeps {
      const base = this.deps(w);
      const log = "test\tcargo test\t2026-01-01T00:00:00Z error[E0425]: cannot find value `b` in this scope\ntest\tcargo test\t2026-01-01T00:00:01Z  --> src/lib.rs:2:20\n";
      return {
        ...base,
        ask: base.ask as unknown as CifixDeps["ask"],
        gh: async (args) => {
          if (args[0] === "api" && args[1]!.includes("/pulls/")) return `${"b".repeat(40)}\n`;
          if (args[0] === "api") return JSON.stringify({ check_runs: [{ name: CHECK, status: "completed", conclusion: "failure", completed_at: "2026-01-03T12:00:00Z", details_url: "https://github.com/storytold/app/actions/runs/11/job/5" }] });
          return log;
        },
        check: async () => JSON.stringify({ verdict: "approve", reasons: "fixes the compile error only", problems: [] }),
      };
    },
  };
}
