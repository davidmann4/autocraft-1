// Runs the test suite: `pnpm test` on SQLite, `pnpm test:pg:suite` (scripts/pg-test.sh suite, which starts the server) on
// Postgres.
//
//   node scripts/test.ts [--concurrency N] [--slowest N] [--file-timeout MIN] [test files...]
//
// Without files it runs every test/**/*.test.ts, the longest of the last run first, so the last ones to finish are short; on
// Postgres without those of test/no-database.txt. Over `node --test` it saves what every test process would do again: the
// migrated SQLite database that new ones are copies of is built once, and the compiled modules are kept in .test-cache.
// Prints the totals, the failures per file and the slowest files and tests; the spec output goes to a log file. A test file
// whose process still runs after --file-timeout minutes (default 10, 0 for none) is killed with the processes it started and
// fails, so a hung file is named and the run goes on: node:test's own timeout fails a hung test but waits for its process.
import { createWriteStream, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, homedir, loadavg, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { run } from "node:test";
import { spec } from "node:test/reporters";
import { parseArgs, promisify } from "node:util";
import { buildTemplate } from "../test/db-template.ts";
import { noDatabaseFiles } from "../test/no-database.ts";
import { report } from "./test-report.ts";

const ROOT = resolve(import.meta.dirname, "..");
process.chdir(ROOT);

const pg = !!process.env.AUTOCRAFT_TEST_PG_URL;
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { concurrency: { type: "string" }, slowest: { type: "string" }, "file-timeout": { type: "string" } },
});
const concurrency = Number(values.concurrency ?? process.env.AUTOCRAFT_TEST_CONCURRENCY ?? Math.max(1, availableParallelism() - 2));
if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency needs a number of test files to run at once");
const slowest = Number(values.slowest ?? 15);
const fileTimeoutMin = Number(values["file-timeout"] ?? process.env.AUTOCRAFT_TEST_FILE_TIMEOUT ?? 10);
if (!(fileTimeoutMin >= 0)) throw new Error("--file-timeout needs a number of minutes (0 for none)");

const CACHE = join(ROOT, ".test-cache");
mkdirSync(CACHE, { recursive: true });
const TIMES = join(CACHE, `times-${pg ? "postgres" : "sqlite"}.json`);

/** Seconds per file of the last runs on this backend. */
function lastTimes(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(TIMES, "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

const times = lastTimes();
const listed = new Set(noDatabaseFiles());
const files = positionals.length
  ? positionals.map((f) => relative(ROOT, resolve(f)))
  : globSync("test/**/*.test.ts").filter((f) => !pg || !listed.has(f));
const left = !positionals.length && pg ? listed.size : 0;
// A file that has not been timed goes by its size: it may be long.
const weight = new Map(files.map((f) => [f, times[f] ?? statSync(f).size / 1000]));
files.sort((a, b) => weight.get(b)! - weight.get(a)!);

const scratch = join(homedir(), ".cache/autocraft-scratch");
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(join(scratch, "suite-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(1));

const template = join(dir, "template.db");
buildTemplate(template);
process.env.AUTOCRAFT_TEST_DB_TEMPLATE = template;
process.env.NODE_COMPILE_CACHE ??= join(CACHE, "compile");
const preload = `--import=${join(ROOT, "test/suite-preload.ts")}`;
// NODE_OPTIONS on Postgres: processes the tests spawn (the CLI, workers' children) redirect too.
if (pg) process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, preload].filter(Boolean).join(" ");

const log = join(mkdtempSync(join(tmpdir(), "autocraft-test-")), "spec.log");
console.error(`${files.length} test files on ${pg ? "Postgres" : "SQLite"}, ${concurrency} at once (load ${loadavg()[0]!.toFixed(0)} on ${availableParallelism()} CPUs)${left ? `, ${left} files without a database left to the SQLite suite` : ""}; spec output in ${log}`);

const events = run({ files, concurrency, execArgv: ["--no-warnings", ...(pg ? [] : [preload])] });
const fails = (): void => void (process.exitCode = 1);
events.on("test:fail", (d) => {
  if (d.todo === undefined || d.todo === false) fails();
});
events.compose(spec).pipe(createWriteStream(log));

const seconds: Record<string, number> = {};
let done = 0;
events.on("test:summary", (d) => {
  if (!d.file) return;
  seconds[relative(ROOT, d.file)] = d.duration_ms / 1000;
  if (++done % 25 === 0) console.error(`  ${done} of ${files.length} files done`);
});

const killed = fileTimeoutMin > 0 ? watchFiles(fileTimeoutMin) : null;
const why = (file: string) => killed?.files.includes(file) ? `killed: still running after ${fileTimeoutMin} min` : undefined;
for await (const text of events.compose(report(slowest, why))) process.stdout.write(text as string);
killed?.stop();
writeFileSync(TIMES, JSON.stringify({ ...times, ...seconds }, null, 1));

/**
 * Kills each test file process (a child of this one, `node ... <file>`) that has run longer than `min`, with every process
 * under it (the job processes a test starts are detached into groups of their own), and names its file. Polls `ps`.
 */
function watchFiles(min: number): { files: string[]; stop: () => void } {
  const ms = min * 60_000;
  const byArg = new Map(files.flatMap((f) => [[resolve(f), f], [f, f]] as const));
  const seen = new Map<number, number>();
  const killedFiles: string[] = [];
  const done = new Set<number>();
  let busy = false;
  const check = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const { stdout } = await promisify(execFile)("ps", ["-A", "-ww", "-o", "pid=,ppid=,args="], { maxBuffer: 64 << 20 });
      const procs = stdout.split("\n").flatMap((l) => {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
        return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), args: m[3]! }] : [];
      });
      const now = Date.now();
      const live = new Set<number>();
      for (const p of procs) {
        if (p.ppid !== process.pid) continue;
        const file = byArg.get(p.args.slice(p.args.lastIndexOf(" ") + 1));
        if (!file || done.has(p.pid)) continue;
        live.add(p.pid);
        if (!seen.has(p.pid)) seen.set(p.pid, now);
        if (now - seen.get(p.pid)! < ms) continue;
        const tree = [p.pid];
        for (let i = 0; i < tree.length; i++) for (const c of procs) if (c.ppid === tree[i]) tree.push(c.pid);
        for (const pid of tree) {
          try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
        }
        done.add(p.pid);
        killedFiles.push(file);
        process.exitCode = 1;
        console.error(`  ${file}: still running after ${min} min, killed`);
      }
      for (const pid of seen.keys()) if (!live.has(pid)) seen.delete(pid);
    } catch (e) {
      console.error(`  file timeout: cannot list processes: ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void check(), Math.min(10_000, ms / 4));
  timer.unref();
  return { files: killedFiles, stop: () => clearInterval(timer) };
}
