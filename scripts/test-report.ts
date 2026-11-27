// The node:test reporter of scripts/test.ts: the totals, each test file with failures (its failure count and first distinct
// error, sorted by file), then the slowest files and tests. With TEST_REPORT_JSON set it also writes { totals, files } there as
// JSON.
import { writeFileSync } from "node:fs";
import { relative } from "node:path";

interface Ev {
  type: string;
  data: {
    name?: string;
    file?: string;
    skip?: unknown;
    todo?: unknown;
    nesting?: number;
    duration_ms?: number;
    details?: { type?: string; duration_ms?: number; error?: { failureType?: string; message?: string; cause?: unknown } };
    message?: string;
    counts?: { tests: number; passed: number; failed: number; skipped: number; todo: number; cancelled: number };
  };
}

interface FileFails {
  fails: number;
  first?: string;
  firstTest?: string;
}

const firstLine = (s: string): string => s.split("\n").map((l) => l.trim()).find((l) => l) ?? "";

function message(err: NonNullable<NonNullable<Ev["data"]["details"]>["error"]>): string {
  const cause = err.cause as { message?: string; code?: string } | string | undefined;
  const m = typeof cause === "string" ? cause : cause?.message ?? err.message ?? "";
  const code = typeof cause === "object" && cause?.code && !String(cause.code).startsWith("ERR_ASSERTION") ? ` [${cause.code}]` : "";
  return (firstLine(m) + code).slice(0, 300);
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1).padStart(6)} s`;

/** A reporter that lists the `slowest` longest files and tests. `why` gives a file's failure as its runner saw it (killed). */
export const report = (slowest: number, why?: (file: string) => string | undefined) => async function* (source: AsyncIterable<Ev>): AsyncGenerator<string> {
  const files = new Map<string, FileFails>();
  // A file whose process failed outside any test reports only "test failed"; its error is in the file's stderr.
  const stderrError = new Map<string, string>();
  let totals: Ev["data"]["counts"];
  let wall = 0;
  const fileMs: { name: string; ms: number }[] = [];
  const testMs: { name: string; ms: number }[] = [];
  for await (const ev of source) {
    const d = ev.data;
    const file = d.file ? relative(process.cwd(), d.file) : "(unknown file)";
    if (ev.type === "test:summary") {
      if (d.file) fileMs.push({ name: file, ms: d.duration_ms ?? 0 });
      else [totals, wall] = [d.counts, d.duration_ms ?? 0];
    }
    if ((ev.type === "test:pass" || ev.type === "test:fail") && d.details?.type !== "suite" && d.name !== undefined) testMs.push({ name: `${file}: ${d.name}`, ms: d.details?.duration_ms ?? 0 });
    if (ev.type === "test:stderr" && !stderrError.has(file)) {
      const line = (d.message ?? "").split("\n").find((l) => /^(\w*Error\b|error:)/.test(l.trim()));
      if (line) stderrError.set(file, line.trim().slice(0, 300));
    }
    if (ev.type !== "test:fail") continue;
    const err = d.details?.error;
    // A parent whose subtests failed is not a failure of its own.
    if (err?.failureType === "subtestsFailed") continue;
    const f = files.get(file) ?? { fails: 0 };
    files.set(file, f);
    // A suite is not counted as a test, but its failing before/after hook is often the first real error.
    if (d.details?.type !== "suite") f.fails++;
    if (err && err.failureType !== "cancelledByParent" && f.first === undefined) {
      const m = message(err);
      f.first = m === "test failed" ? stderrError.get(file) ?? m : m;
      f.firstTest = d.name;
    }
  }
  for (const [file, f] of files) if (f.first === undefined || f.first === "test failed") f.first = stderrError.get(file) ?? f.first;
  for (const [file, f] of files) f.first = why?.(file) ?? f.first;
  const sorted = [...files].sort(([a], [b]) => a.localeCompare(b));
  const t = totals ?? { tests: 0, passed: 0, failed: 0, skipped: 0, todo: 0, cancelled: 0 };
  yield `tests ${t.tests}  pass ${t.passed}  fail ${t.failed}  skipped ${t.skipped}  cancelled ${t.cancelled}  in ${(wall / 1000).toFixed(0)} s\n`;
  if (sorted.length) yield `\nfailures by file (${sorted.length} files):\n`;
  for (const [file, f] of sorted) yield `${String(f.fails).padStart(5)}  ${file}${f.first ? `  -- ${f.first}` : ""}\n`;
  const all = fileMs.reduce((n, f) => n + f.ms, 0);
  for (const [what, list] of [[`files (${fileMs.length} files, ${(all / 1000).toFixed(0)} s together)`, fileMs], ["tests", testMs]] as const) {
    if (!slowest || !list.length) continue;
    yield `\nslowest ${what}:\n`;
    for (const { name, ms } of list.sort((a, b) => b.ms - a.ms).slice(0, slowest)) yield `${secs(ms)}  ${name}\n`;
  }
  if (process.env.TEST_REPORT_JSON) writeFileSync(process.env.TEST_REPORT_JSON, JSON.stringify({ totals: t, files: Object.fromEntries(sorted) }, null, 1));
};
