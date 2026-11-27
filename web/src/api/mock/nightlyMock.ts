// Nightly checks on fake data: three repos, 14 nights, a failing Miri streak with its issue, a failing Windows streak without one, a warn, a skipped check and a slowing benchmark.
import type { Api } from "../client";
import type { NightlyCell, NightlyCheckRow, NightlyGrid, NightlyRepo, NightlySeries, NightlyState, User } from "../types";
import { NOW } from "./fixtures";
import { mayRunMock } from "./adminMock";

const wait = <T>(v: T, ms = 60) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));
const DAY = 86_400_000;
const NIGHTS = 14;

const cell = (state: NightlyState, taskId: number | null, summary: string | null = null, issueNumber: number | null = null): NightlyCell => ({ state, taskId, summary, issueNumber });
const steady = (state: NightlyState, base: number, mixed: Record<number, NightlyCell> = {}) =>
  Array.from({ length: NIGHTS }, (_, i) => mixed[i] ?? cell(state, base + i));

const series = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));

/** The issue of the check's failing streak, or whether one may be opened. */
function streakOf(c: { cells: (NightlyCell | null)[]; experimental: boolean }, may: boolean): Pick<NightlyCheckRow, "issue" | "canOpenIssue"> {
  const end = c.cells.findIndex((x) => x?.state !== "fail");
  const streak = end < 0 ? c.cells : c.cells.slice(0, end);
  const issue = streak.find((x) => x?.issueNumber)?.issueNumber ?? null;
  return { issue, canOpenIssue: may && !c.experimental && streak.length >= 2 && issue === null };
}

function build(me: User): NightlyRepo[] {
  const nights = (repo: string) => Array.from({ length: NIGHTS }, (_, i) => ({ runId: 900 - i, startedAt: new Date(NOW - (i * DAY + 5 * 3_600_000)).toISOString(), sha: `${repo.charCodeAt(0)}e1c${(97 - i).toString(16)}0b44aa21` }));
  const base = { experimental: false, needs: null, crates: [] as string[], targets: [] as string[] };
  return [
    {
      repo: "bundle-rs",  canSelect: mayRunMock(me, "bundle-rs"), on: true, nights: nights("b"), benches: [
        { name: "parse::small", unit: "ns/iter", latest: 1180, deltaPct: 14.4, at: new Date(NOW - 5 * 3_600_000).toISOString(), points: series(30, (i) => 1000 + (i % 4) * 12 + (i > 26 ? (i - 26) * 45 : 0)) },
        { name: "parse::large", unit: "ns/iter", latest: 48200, deltaPct: -1.2, at: new Date(NOW - 5 * 3_600_000).toISOString(), points: series(30, (i) => 48000 + ((i * 37) % 9) * 120) },
        { name: "encode::roundtrip", unit: "ns/iter", latest: 9300, deltaPct: 0.4, at: new Date(NOW - 5 * 3_600_000).toISOString(), points: series(30, (i) => 9250 + ((i * 11) % 5) * 15) },
      ],
      checks: [
        { ...base, id: "audit", label: "Dependency audit", enabled: true, takes: null, cells: steady("pass", 5000, { 0: cell("warn", 5000, "1 advisory: RUSTSEC-2026-0012 (unmaintained)"), 1: cell("warn", 5001, "1 advisory: RUSTSEC-2026-0012 (unmaintained)") }) },
        { ...base, id: "wasm", label: "WebAssembly build", enabled: true, takes: "crates", crates: ["bundle-core"], cells: steady("pass", 5100) },
        { ...base, id: "windows", label: "Windows build", enabled: true, takes: "crates", cells: steady("pass", 5200, { 0: cell("fail", 5200, "linking with x86_64-w64-mingw32-gcc failed"), 1: cell("fail", 5201, "linking with x86_64-w64-mingw32-gcc failed"), 2: cell("fail", 5202, "linking with x86_64-w64-mingw32-gcc failed"), 6: cell("fail", 5206, "linking with x86_64-w64-mingw32-gcc failed") }) },
        { ...base, id: "miri", label: "Miri", enabled: true, takes: "crates", crates: ["bundle-core", "bundle-ffi"], cells: steady("pass", 5300, { 0: cell("fail", 5300, "Undefined Behavior: out-of-bounds pointer use", 31), 1: cell("fail", 5301, "Undefined Behavior: out-of-bounds pointer use", 31), 2: cell("pass", 5302) }) },
        { ...base, id: "bench", label: "Benchmarks", enabled: true, takes: "crates", needs: "benches", cells: steady("pass", 5400, { 0: cell("warn", 5400, "parse::small 14% slower than the last 7 nights") }) },
        { ...base, id: "fuzz", label: "Fuzzing (5 min per target)", enabled: false, takes: "targets", experimental: true, needs: "fuzz-dir", cells: Array(NIGHTS).fill(null) },
        { ...base, id: "asan", label: "AddressSanitizer tests", enabled: false, takes: "crates", experimental: true, cells: Array(NIGHTS).fill(null) },
      ],
    },
    {
      repo: "pdfcraft",  canSelect: mayRunMock(me, "pdfcraft"), on: true, nights: nights("p").slice(0, 9), benches: [],
      checks: [
        { ...base, id: "audit", label: "Dependency audit", enabled: true, takes: null, cells: steady("pass", 6000).slice(0, 9) },
        { ...base, id: "wasm", label: "WebAssembly build", enabled: false, takes: "crates", cells: Array(9).fill(null) },
        { ...base, id: "windows", label: "Windows build", enabled: true, takes: "crates", cells: steady("skipped", 6200).slice(0, 9).map((c) => ({ ...c, taskId: null, summary: "skipped: no toolchain" })) },
        { ...base, id: "miri", label: "Miri", enabled: false, takes: "crates", cells: Array(9).fill(null) },
        { ...base, id: "bench", label: "Benchmarks", enabled: false, takes: "crates", needs: "benches", cells: Array(9).fill(null) },
        { ...base, id: "fuzz", label: "Fuzzing (5 min per target)", enabled: false, takes: "targets", experimental: true, needs: "fuzz-dir", cells: Array(9).fill(null) },
        { ...base, id: "asan", label: "AddressSanitizer tests", enabled: false, takes: "crates", experimental: true, cells: Array(9).fill(null) },
      ],
    },
    {
      repo: "photocraft",  canSelect: mayRunMock(me, "photocraft"), on: false, nights: [], benches: [],
      checks: ["audit", "wasm", "windows", "miri", "bench", "fuzz", "asan"].map((id) => ({
        ...base, id, label: id, enabled: false, takes: id === "audit" ? null : id === "fuzz" ? "targets" : "crates", cells: [],
      })),
    },
  ].map((r) => ({ ...r, checks: r.checks.map((c) => ({ ...c, ...streakOf(c, r.canSelect), label: c.label === c.id ? ({ audit: "Dependency audit", wasm: "WebAssembly build", windows: "Windows build", miri: "Miri", bench: "Benchmarks", fuzz: "Fuzzing (5 min per target)", asan: "AddressSanitizer tests" } as Record<string, string>)[c.id]! : c.label })) })) as NightlyRepo[];
}

export function createNightlyMock(me: User, changed: () => void): Pick<Api, "nightly"> {
  const repos = build(me);
  const grid = (): NightlyGrid => ({ repos });
  return {
    nightly: {
      grid: () => wait(grid()),
      series(repo, bench): Promise<NightlySeries> {
        const b = repos.find((r) => r.repo === repo)?.benches.find((x) => x.name === bench);
        if (!b) return Promise.reject(new Error("no such benchmark"));
        return wait({ repo, bench, unit: b.unit, points: b.points.map((value, i) => ({ sha: `sha${i}`, at: new Date(NOW - (b.points.length - i) * DAY).toISOString(), value })) });
      },
      async select(input) {
        if (!mayRunMock(me, input.repo)) throw new Error("only an operator, or a maintainer with write access to the repo, selects its nightly checks");
        const c = repos.find((r) => r.repo === input.repo)?.checks.find((x) => x.id === input.check);
        if (!c) throw new Error("unknown check");
        c.enabled = input.enabled;
        if (input.crates) c.crates = input.crates;
        if (input.targets) c.targets = input.targets;
        changed();
        return wait(grid());
      },
      async openIssue(input) {
        if (!mayRunMock(me, input.repo)) throw new Error("only an operator, or a maintainer with write access to the repo, opens an issue for its nightly checks");
        const c = repos.find((r) => r.repo === input.repo)?.checks.find((x) => x.id === input.check);
        if (!c?.canOpenIssue) throw new Error("the check is not failing 2 nights in a row");
        c.issue = 412;
        c.canOpenIssue = false;
        changed();
        return wait(grid(), 600);
      },
    },
  };
}
