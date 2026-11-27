// Sorts a CI failure by what would fix it, from the log text alone. No model: anything unclear is "code", where
// the patch check (Opus) stands between the model's patch and the branch.
import type { CiFailure } from "./types.ts";

export type Triage =
  | { kind: "format"; why: string }
  | { kind: "infra"; why: string }
  | { kind: "code"; why: string }
  /** A cancelled run says nothing about the code or the runner: no fix, no try. */
  | { kind: "skip"; why: string }
  /** Nothing readable: no failed step log to act on. */
  | { kind: "unreadable"; why: string };

/** The run itself broke, whatever the PR contains. */
const INFRA_CONCLUSION = new Set(["timed_out", "startup_failure", "stale"]);
const INFRA_LOG = /could not resolve host|temporary failure in name resolution|connection (reset|timed out|refused)|network is unreachable|tls handshake|failed to download|unable to access 'https|spurious network error|\b50[234] (bad gateway|service unavailable|gateway time-?out)|rate limit exceeded|runner has received a shutdown signal|lost communication with the server|no space left on device|ETIMEDOUT|ECONNRESET|failed to fetch|error: failed to get `|couldn't connect to server/i;
/** A compiler, clippy or test failure in the PR's code (case sensitive: `Error: Process completed` is the runner's line). */
const CODE_MARK = /^\s*error(\[E\d+\])?: |test result: FAILED|panicked at|^failures:$|could not compile|assertion `|-D warnings/m;
/** The gate runner's own summary line (`error: ci failed at \`fmt\``): it names the failed stage and says nothing about the code. */
const GATE_SUMMARY = /^\s*error: ci failed at .*$/gm;
const FORMAT_STEP = /\b(fmt|format(ting)?)\b/i;
const FORMAT_DIFF = /^Diff in \S+:\d+/m;
const FORMAT_DIFF_PATH = /^Diff in (\S+?):\d+/gm;

/** Paths the formatter's `Diff in <path>:<line>` lines name, as printed (CI prints absolute paths). */
export function formatDiffPaths(f: CiFailure): string[] {
  return [...new Set(f.checks.flatMap((c) => c.steps).flatMap((s) => [...s.tail.matchAll(FORMAT_DIFF_PATH)].map((m) => m[1]!)))];
}

/** The PR's files (repo-relative) that a printed path names: equal, or a longer path ending in `/<file>`. */
export function matchPrFiles(printed: string[], prFiles: string[]): string[] {
  const norm = printed.map((p) => p.replace(/^\.\//, ""));
  return prFiles.filter((f) => norm.some((p) => p === f || p.endsWith(`/${f}`)));
}

export function triage(f: CiFailure): Triage {
  // Cancelled runs are set aside; with nothing else failed there is nothing to act on.
  const checks = f.checks.filter((c) => c.conclusion !== "cancelled");
  if (f.checks.length && !checks.length) return { kind: "skip", why: "the run was cancelled" };
  if (checks.length && checks.every((c) => INFRA_CONCLUSION.has(c.conclusion))) return { kind: "infra", why: `the run was ${checks[0]!.conclusion.replace("_", " ")}` };
  const steps = checks.flatMap((c) => c.steps);
  if (!steps.length) return { kind: "unreadable", why: "no failed step log to read (the failed checks are not GitHub Actions jobs)" };
  const text = steps.map((s) => s.tail).join("\n").replace(GATE_SUMMARY, "");
  if (INFRA_LOG.test(text) && !CODE_MARK.test(text)) return { kind: "infra", why: "the log shows a network or runner error and no error in the code" };
  const formatStep = (s: { step: string; tail: string }) => FORMAT_STEP.test(s.step) || FORMAT_DIFF.test(s.tail);
  // The formatter's own output does not carry compiler markers, so any marker means something besides formatting failed.
  // A step name alone proves nothing: the log must hold the formatter's own `Diff in <path>:<line>` lines.
  if (FORMAT_DIFF.test(text) && steps.every(formatStep) && !CODE_MARK.test(text)) return { kind: "format", why: "only the formatter check failed" };
  return { kind: "code", why: "a build, lint or test step failed" };
}

/** A build, compile or lint error: anything of these means the failure is no flaky test. */
const BUILD_MARK = /^\s*error(\[E\d+\])?: (?!test failed, to rerun pass|process didn't exit successfully)|could not compile|-D warnings/m;
/** Failed test names: `test <name> ... FAILED` lines and the names under the second `failures:` heading. */
const TEST_FAILED = /^test (\S+) \.\.\. FAILED$/gm;
const FAILURE_NAME = /^failures:\n((?: {4}\S+\n?)+)/gm;
/** Source locations in panics and backtraces: `panicked at <path>:<line>`, `at <path>:<line>`. */
const LOCATION = /(?:^|\s)(?:panicked at |at )(\S+\.rs):\d+/gm;

/** The names of the tests the log says failed. */
export function failedTests(f: CiFailure): string[] {
  const text = f.checks.flatMap((c) => c.steps).map((s) => s.tail).join("\n");
  const names = new Set<string>();
  for (const m of text.matchAll(TEST_FAILED)) names.add(m[1]!);
  for (const m of text.matchAll(FAILURE_NAME)) for (const n of m[1]!.split("\n")) if (n.trim()) names.add(n.trim());
  return [...names];
}

/** Whether `printed` (a path as a log prints it, absolute or crate-relative) and the repo-relative `file` can name the same file. */
const samePath = (printed: string, file: string): boolean => {
  const p = printed.replace(/^\.\//, "");
  return p === file || p.endsWith(`/${file}`) || file.endsWith(`/${p}`);
};

/**
 * The failure is tests only, and nothing in the log ties them to the PR's files: no build or lint error, at least one failed test named,
 * no failed test whose module path is a changed file's, and no panic or backtrace location in a changed file. Such a failure gets one
 * rerun of the failed jobs before a code fix: a flaky test fails again only rarely. `prFiles`: the PR's changed files, repo-relative.
 */
export function unrelatedTests(f: CiFailure, prFiles: readonly string[]): string[] | null {
  const steps = f.checks.filter((c) => c.conclusion !== "cancelled").flatMap((c) => c.steps);
  const text = steps.map((s) => s.tail).join("\n").replace(GATE_SUMMARY, "");
  if (!prFiles.length || !/test result: FAILED|panicked at/.test(text) || BUILD_MARK.test(text)) return null;
  const tests = failedTests(f);
  if (!tests.length) return null;
  // `a::b::tests::c` lives in `a/b.rs` or `a/b/mod.rs` (or in a file of an integration test named `a`).
  const modules = prFiles.map((p) => p.replace(/\.rs$/, "").replace(/\/mod$/, ""));
  const tied = tests.some((n) => {
    const path = n.split("::").filter((x) => x !== "tests").slice(0, -1).join("/");
    return !!path && modules.some((m) => m === path || m.endsWith(`/${path}`));
  });
  if (tied) return null;
  for (const m of text.matchAll(LOCATION)) if (prFiles.some((p) => samePath(m[1]!, p))) return null;
  return tests;
}
