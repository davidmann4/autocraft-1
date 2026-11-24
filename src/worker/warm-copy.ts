// The pod side of a build pod that starts warm (src/build/warm-mount.ts builds its spec):
//   changedSince   in the source pod: the checkout's files whose content differs from the warm commit's tree, written to
//                  the task's volume (CHANGED_FILE)
//   warmCopyPhase  `worker pod warm-copy`, before the steps of an offline step pod: verifies the node's warm version,
//                  copies its target and CARGO_HOME, and sets the checkout's mtimes; before the fetch of a network step pod
//                  (PART=cargo): copies only CARGO_HOME, so the fetch downloads only what the version lacks
// cargo decides freshness by mtime: a source file older than the dep-info of the unit that read it counts as unchanged.
// So every checkout file is set to OLD_MTIME (before any warm build), and only the files that changed since the warm
// commit are set to now. That is sound only when every unit in the warm target was checked by the build at the warm commit,
// which the manifest's `trimmed` says; without it, or without the list, every file is set to now: correct, but every
// workspace crate rebuilds.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, lutimesSync, linkSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { slugOf } from "../owners.ts";
import { CHANGED_FILE, COPY_MARK_FILE } from "../build/warm-mount.ts";
import { readToolchain, toolchainRefusal } from "../warm/toolchain.ts";
import { clearDir, decodeManifest, isCargoLock, loadEd25519, parseLatest, verifyLatest } from "../warm/manifest.ts";

/** 2001-01-01, as CI's restore-mtimes step uses: older than any warm build. */
export const OLD_MTIME_SEC = 978307200;
/** Above this many changed files every file counts as changed. */
export const MAX_CHANGED = 5000;
const COMMIT = /^[0-9a-f]{40}$/;

type Log = (s: string) => void;
/** `files`: checkout files to count as changed; `dirs`: checkout dirs that lost a file since the commit. */
export type Changed = { commit: string; files: string[] | null; dirs?: string[] };

/** sha256 of `dir`/Cargo.lock, or null when there is none. */
export function cargoLockOf(dir: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(join(dir, "Cargo.lock"))).digest("hex");
  } catch {
    return null;
  }
}

/** Regular files and symlinks under `root`, as paths relative to it. */
function walk(root: string): string[] {
  const out: string[] = [];
  const go = (rel: string) => {
    for (const n of readdirSync(join(root, rel))) {
      const p = rel ? `${rel}/${n}` : n;
      const st = lstatSync(join(root, p));
      if (st.isDirectory()) go(p);
      else if (st.isFile() || st.isSymbolicLink()) out.push(p);
    }
  };
  go("");
  return out;
}

/** Every directory under `root` (relative, `""` for the root itself), symlinks not followed. */
function walkDirs(root: string): string[] {
  const out: string[] = [""];
  const go = (rel: string) => {
    for (const n of readdirSync(join(root, rel))) {
      const p = rel ? `${rel}/${n}` : n;
      if (lstatSync(join(root, p)).isDirectory()) { out.push(p); go(p); }
    }
  };
  go("");
  return out;
}

/** git's blob id of a file (or a symlink's target), as `git ls-tree` prints it. */
function blobId(abs: string): string {
  const st = lstatSync(abs);
  const body = st.isSymbolicLink() ? Buffer.from(readlinkSync(abs)) : readFileSync(abs);
  return createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
}

function git(args: string[], cwd: string, maxBuffer = 8 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd, timeout: 180_000, maxBuffer, encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    }, (err, stdout, stderr) => (err ? reject(new Error(`git ${args[0]}: ${(stderr || err.message).trim().split("\n").pop()}`)) : resolve(stdout)));
  });
}

/**
 * The files of `src` (the checkout as built: head plus patch) whose content is not the warm commit's, from a tree-only
 * fetch of that commit into `scratch`. A unit whose dep-info names a deleted file rebuilds, but a deletion can also matter
 * to a unit that never read the file (a build script watching a dir, a crate's file list), so for each file of the commit
 * missing from the checkout the nearest Cargo.toml above it counts as changed and its nearest existing dir is listed in
 * `dirs`. null files: more than MAX_CHANGED.
 */
export async function changedSince(repo: string, commit: string, src: string, scratch: string): Promise<Changed> {
  if (!COMMIT.test(commit)) throw new Error("the warm commit is not a commit id");
  const dir = join(scratch, "warm-git");
  mkdirSync(dir, { recursive: true });
  await git(["init", "-q"], dir);
  await git(["fetch", "-q", "--depth=1", "--filter=blob:none", "--no-tags", `https://github.com/${slugOf(repo)}.git`, commit], dir);
  const tree = parseLsTree(await git(["ls-tree", "-r", "-z", "--full-tree", commit], dir, 256 * 1024 * 1024));
  const present = new Map(walk(src).map((p) => [p, blobId(join(src, p))]));
  return { commit, ...changedFrom(tree, present, (d) => isDir(join(src, d))) };
}

/** `git ls-tree -r -z` output as path → blob id. */
export function parseLsTree(out: string): Map<string, string> {
  const tree = new Map<string, string>();
  for (const rec of out.split("\0")) {
    const m = /^\d+ blob ([0-9a-f]{40})\t(.+)$/s.exec(rec);
    if (m) tree.set(m[2]!, m[1]!);
  }
  return tree;
}

/**
 * The files of `present` (path → blob id of the checkout as built) whose content is not `tree`'s (the warm commit's), plus,
 * for each file of `tree` the checkout lacks, the nearest Cargo.toml above it; `dirs` are the nearest existing dirs of those
 * files ("" for the root). `isDir` says whether a checkout path is a dir. null files: more than MAX_CHANGED.
 */
export function changedFrom(tree: Map<string, string>, present: Map<string, string>, isDirOf: (p: string) => boolean): { files: string[] | null; dirs?: string[] } {
  const files = new Set([...present].filter(([p, id]) => tree.get(p) !== id).map(([p]) => p));
  const dirs = new Set<string>();
  for (const p of tree.keys()) {
    if (present.has(p) || !safeRel(p)) continue;
    let d = dirname(p);
    while (d !== "." && !isDirOf(d)) d = dirname(d);
    dirs.add(d === "." ? "" : d);
    for (let m = d; ; m = dirname(m)) {
      const toml = m === "." || m === "" ? "Cargo.toml" : `${m}/Cargo.toml`;
      if (present.has(toml)) {
        files.add(toml);
        break;
      }
      if (m === "." || m === "") break;
    }
  }
  return files.size > MAX_CHANGED ? { files: null } : { files: [...files], dirs: [...dirs] };
}

const safeRel = (p: string) => p !== "" && !p.startsWith("/") && !p.split("/").some((x) => x === ".." || x === "." || x === "");
const isDir = (p: string) => lstatSync(p, { throwIfNoEntry: false })?.isDirectory() === true;

/** In the source pod: writes the changed list for `commit`, or logs why there is none (warm-copy then touches every file). */
export async function writeChanged(work: string, repo: string, commit: string, log: Log): Promise<void> {
  try {
    const c = await changedSince(repo, commit, join(work, "src"), join(work, "scratch"));
    writeFileSync(join(work, CHANGED_FILE), JSON.stringify(c));
    log(`warm: ${c.files ? `${c.files.length} files differ` : `more than ${MAX_CHANGED} files differ`} from ${commit.slice(0, 12)}`);
  } catch (e) {
    log(`warm: no list of files changed since ${commit.slice(0, 12)} (${(e as Error).message}); a warm start rebuilds every workspace crate`);
  }
}

/**
 * Sets the checkout's mtimes for a build on `commit`'s warm target; returns what it did. `trimmed`: the version's manifest
 * says every unit it holds was checked by the build at `commit`; without it every file counts as changed.
 */
export function setMtimes(work: string, commit: string, trimmed: boolean): string {
  const src = join(work, "src");
  const strs = (x: unknown) => Array.isArray(x) && x.every((f) => typeof f === "string");
  let changed: Changed | null = null;
  try {
    const c = JSON.parse(readFileSync(join(work, CHANGED_FILE), "utf8")) as Changed;
    if (c.commit === commit && (c.files === null || strs(c.files)) && (c.dirs === undefined || strs(c.dirs))) changed = c;
  } catch {
    // No list: every file counts as changed.
  }
  const now = Date.now() / 1000;
  const all = walk(src);
  if (!trimmed || !changed?.files) {
    for (const p of all) lutimesSync(join(src, p), now, now);
    const why = !trimmed ? `the version of ${commit.slice(0, 12)} may hold units its build did not check`
      : changed ? `more than ${MAX_CHANGED} files changed since ${commit.slice(0, 12)}` : `no list of files changed since ${commit.slice(0, 12)}`;
    return `${why}: every source file counts as changed`;
  }
  const touch = new Set(changed.files);
  for (const p of all) lutimesSync(join(src, p), touch.has(p) ? now : OLD_MTIME_SEC, touch.has(p) ? now : OLD_MTIME_SEC);
  // Directories too: cargo's rerun-if-changed on a directory compares the newest mtime under it, directories included.
  const touchDirs = new Set((changed.dirs ?? []).filter((d) => d === "" || safeRel(d)));
  for (const d of walkDirs(src)) lutimesSync(join(src, d), touchDirs.has(d) ? now : OLD_MTIME_SEC, touchDirs.has(d) ? now : OLD_MTIME_SEC);
  return `${touch.size} source files changed since ${commit.slice(0, 12)}`;
}

/**
 * Sets every file and directory of the gate's extra checkouts (`<work>/ext/*`, mounted read-only in the steps, so set here while the
 * volume is writable) to OLD_MTIME. Cargo's fingerprints of path dependencies there (e.g. a font manifest) compare against
 * the warm build's dep-info; fresh mtimes make it rebuild every crate that reads them. Returns the file count.
 */
export function setExtMtimes(work: string): number {
  const ext = join(work, "ext");
  if (!isDir(ext)) return 0;
  const files = walk(ext);
  for (const p of files) lutimesSync(join(ext, p), OLD_MTIME_SEC, OLD_MTIME_SEC);
  // After the files, so nothing changes a directory's mtime again; cargo's rerun-if-changed on a directory counts directory mtimes.
  for (const d of walkDirs(ext)) lutimesSync(join(ext, d), OLD_MTIME_SEC, OLD_MTIME_SEC);
  return files.length;
}

/** The summary of a failed cp: files the pod's uid cannot read get their own wording and count, so an operator sees why. */
export function copyFailure(stderr: string): string {
  const lines = stderr.trim().split("\n");
  const denied = lines.filter((l) => /cannot open .* for reading: Permission denied/.test(l)).length;
  if (denied) return `unreadable files in the warm version (${denied}${lines.length >= denied && denied === lines.length ? "" : "+"} reported; first: ${lines.find((l) => l.includes("Permission denied"))!.slice(0, 160)})`;
  return `cp: ${lines.slice(-2).join(" ")}`;
}

/** `cp` processes run at once. */
export const COPY_PARALLEL = 8;
/**
 * A planned copy weighs one per entry plus one per WEIGHT_BYTES of file data: on reflink storage a file costs about the same
 * whatever its size, on other storage the data dominates, and this weight balances the copies well enough for both.
 */
const WEIGHT_BYTES = 100_000;
/** No `cp` call is planned lighter than this (about 5,000 small files), so a small tree is one call. */
const MIN_CHUNK = 5000;
/** Bytes of paths per `cp` call, well under the kernel's argument limit. */
const MAX_ARG_BYTES = 128 * 1024;
/** No `cp` call is split off for less data than this. */
const MIN_CALL_BYTES = 64 << 20;
/**
 * Hard links between files this large (cargo's uplifted binaries) are kept across `cp` calls, which matters for a memory-backed
 * target. Smaller linked files (warm-sync links equal content within a version) get their own inode unless one `cp` call
 * copies both paths: keeping those would split every dir that holds one.
 */
const LINK_MIN_BYTES = 1 << 20;
/** The file in the work dir that names what the CARGO_HOME copy adds while it runs. */
const CARGO_JOURNAL = "warm-copy-cargo.json";
/** The file in the work dir that names the version (manifest sha256) whose CARGO_HOME a finished copy put there: a later copy of it skips CARGO_HOME. */
export const CARGO_MARK_FILE = "warm-cargo.json";

export type CopyStats = { files: number; bytes: number; calls: number; kept: number; listSecs: number; copySecs: number };

type Listing = {
  weight: Map<string, number>; bytesOf: Map<string, number>; total: number; files: number; bytes: number; later: Map<string, string>; locks: Set<string>;
};

/**
 * One `find` over `dir`: each entry's weight and file bytes (a dir's include everything below it), the later paths of each
 * large multi-link inode (path → its first path) and cargo's lock files, all relative to `dir`. `files` and `bytes` count
 * every path, as cp -a would copy them without links. Holds every path in memory (a few hundred bytes each).
 */
function listTree(dir: string): Promise<Listing> {
  return new Promise((resolve, reject) => {
    execFile("find", [dir, "-mindepth", "1", "-printf", "%y\\t%n\\t%i\\t%s\\t%P\\0"], { maxBuffer: 1 << 28, timeout: 10 * 60_000, encoding: "utf8" }, (err, out, stderr) => {
      if (err) return reject(new Error(`find: ${(stderr || err.message).trim().split("\n").slice(-2).join(" ").replace(/^find: /, "")}`));
      const weight = new Map<string, number>(), bytesOf = new Map<string, number>();
      const firstOf = new Map<string, string>(), later = new Map<string, string>(), locks = new Set<string>();
      let total = 0, files = 0, bytes = 0;
      for (const rec of out.split("\0")) {
        const t1 = rec.indexOf("\t"), t2 = rec.indexOf("\t", t1 + 1), t3 = rec.indexOf("\t", t2 + 1), t4 = rec.indexOf("\t", t3 + 1);
        if (t1 < 0 || t4 < 0) continue;
        const type = rec.slice(0, t1), size = type === "f" ? Number(rec.slice(t3 + 1, t4)) : 0, rel = rec.slice(t4 + 1);
        if (type === "f" && isCargoLock(rel)) {
          locks.add(rel);
          continue;
        }
        if (type !== "d") files++;
        bytes += size;
        if (size >= LINK_MIN_BYTES && rec.slice(t1 + 1, t2) !== "1") {
          const ino = rec.slice(t2 + 1, t3), first = firstOf.get(ino);
          if (first !== undefined) {
            later.set(rel, first);
            continue;
          }
          firstOf.set(ino, rel);
        }
        const w = 1 + size / WEIGHT_BYTES;
        total += w;
        for (let p = rel; ;) {
          weight.set(p, (weight.get(p) ?? 0) + w);
          if (size) bytesOf.set(p, (bytesOf.get(p) ?? 0) + size);
          const i = p.lastIndexOf("/");
          if (i < 0) break;
          p = p.slice(0, i);
        }
      }
      resolve({ weight, bytesOf, total, files, bytes, later, locks });
    });
  });
}

function cpRun(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("cp", args, { timeout: 30 * 60_000, maxBuffer: 1024 * 1024 }, (err, _o, stderr) =>
      err ? reject(new Error(copyFailure(stderr || err.message))) : resolve());
  });
}

async function attrs(from: string, to: string): Promise<void> {
  chmodSync(to, lstatSync(from).mode & 0o7777);
  await new Promise<void>((resolve, reject) => execFile("touch", ["-r", from, "--", to], (e) => (e ? reject(e) : resolve())));
}

/** Runs `fn` over `items`, `n` at once; the first failure rejects once the running calls end, and no new call starts. */
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: Error | null = null;
  const worker = async () => {
    while (!failure && next < items.length) {
      try {
        await fn(items[next++]!);
      } catch (e) {
        failure ??= e as Error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  if (failure) throw failure;
}

function removeTree(p: string): void {
  const st = lstatSync(p, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isDirectory()) {
    chmodSync(p, 0o700);
    clearDir(p);
  }
  rmSync(p, { recursive: true, force: true });
}

/**
 * A new entry is copied under a temp name in its own dir (`.<name>.warm-copy-tmp`), or a group of new entries into a staging
 * dir there (`.warm-copy-tmp-<n>`), and renamed into place once whole: pods that never run warm-copy share CARGO_HOME, and
 * cargo trusts a crate dir whose `.cargo-ok` exists. Cargo reads neither name.
 */
const TEMP_NAME = /^\.(?:.+\.warm-copy-tmp|warm-copy-tmp-[0-9]+)$/;
const tempOf = (dir: string, name: string) => join(dir, `.${name}.warm-copy-tmp`);

/**
 * Removes the temp entries an interrupted copy into `to` left, as its journal names, then the journal. The journal is on a
 * volume the steps can write, so only temp names inside `to` (or `to`'s own temp name) whose dir has no symlink on the way
 * are removed.
 */
function undoJournal(journal: string, to: string): void {
  if (!existsSync(journal)) return;
  let paths: unknown = [];
  try {
    paths = JSON.parse(readFileSync(journal, "utf8"));
  } catch {
    // Cut short while it was written, which is before the copy starts: nothing to undo.
  }
  for (const p of Array.isArray(paths) ? paths : []) {
    if (typeof p !== "string" || resolve(p) !== p || !TEMP_NAME.test(basename(p))) continue;
    if (!p.startsWith(`${to}/`) && p !== tempOf(dirname(to), basename(to))) continue;
    if (!existsSync(dirname(p)) || realpathSync(dirname(p)) !== dirname(p)) continue;
    removeTree(p);
  }
  rmSync(journal, { force: true });
}

/** Renames a dir entry to another dir; a dir without its owner's write bit gets it for the move (the move rewrites its `..`). */
function moveInto(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (e) {
    const st = lstatSync(from);
    if ((e as NodeJS.ErrnoException).code !== "EACCES" || !st.isDirectory()) throw e;
    chmodSync(from, (st.mode & 0o7777) | 0o200);
    renameSync(from, to);
    chmodSync(to, st.mode & 0o7777);
  }
}

/**
 * Copies `from` into `to` like `cp -a from/. to/` (modes, mtimes, symlinks) with at most COPY_PARALLEL `cp -a --reflink=auto`
 * processes at once, each over one large subtree or a group of entries of one dir: a dir is split only when it weighs more
 * than a share of the tree or holds more than an eighth of its bytes, or holds a path left out. What `to` already holds is
 * kept (an earlier step fetched it). Every entry new to a dir that existed before lands whole, through a temp name. Cargo's
 * lock files are left out. Nothing in `to` is ever a link to `from`. `journal` names, while the copy runs, the temp entries
 * it made; one left by an interrupted copy is undone first. A failed copy removes its temp entries and rejects with the
 * first failure. `minChunk` is the lightest planned call (tests set it low to split a small tree).
 */
export async function copyTree(from: string, to: string, opts: { journal?: string; minChunk?: number } = {}): Promise<CopyStats> {
  const t0 = performance.now();
  if (opts.journal) undoJournal(opts.journal, to);
  const list = await listTree(from);
  const listSecs = (performance.now() - t0) / 1000;
  const rootMade = !existsSync(to);
  const rootFresh = rootMade || readdirSync(to).length === 0;
  // Into a dir that already holds files a first path may be one that is kept, so links are kept only into a fresh one.
  const keepLinks = rootFresh;
  const mustSplit = new Set<string>();
  for (const p of [...list.locks, ...(keepLinks ? list.later.keys() : [])]) {
    for (let i = p.lastIndexOf("/"); i > 0; i = p.lastIndexOf("/", i - 1)) mustSplit.add(p.slice(0, i));
  }
  const chunk = Math.max(list.total / (2 * COPY_PARALLEL), opts.minChunk ?? MIN_CHUNK);
  // Where data is copied, a data-heavy tree of few files keeps its parallelism.
  const byteCap = Math.max(list.bytes / COPY_PARALLEL, MIN_CALL_BYTES);
  // `into`: the dir a staged call's entries move into once it succeeds.
  const calls: { dir: string; srcs: string[]; weight: number; into?: string }[] = [];
  const made: { rel: string; at: string }[] = [];
  const renames: { tmp: string; final: string }[] = [];
  const links: { path: string; first: string }[] = [];
  const root = rootMade ? tempOf(dirname(to), basename(to)) : to;
  const added: string[] = rootMade ? [root] : [];
  let kept = 0;
  // `b`: where `rel` is built; `fresh`: it holds nothing yet; `track`: it existed before, so new entries go in by temp names.
  const plan = (rel: string, b: string, fresh: boolean, track: boolean) => {
    const a = rel ? join(from, rel) : from;
    let srcs: string[] = [], w = 0, bytes = 0, len = 0;
    const flush = () => {
      if (srcs.length) {
        const dir = track ? join(b, `.warm-copy-tmp-${calls.length}`) : b;
        if (track) added.push(dir);
        calls.push({ dir, srcs, weight: w, ...(track ? { into: b } : {}) });
      }
      srcs = [];
      w = bytes = len = 0;
    };
    for (const e of readdirSync(a, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (list.locks.has(r)) continue;
      const dest = join(b, e.name);
      const there = fresh ? undefined : lstatSync(dest, { throwIfNoEntry: false });
      if (there) {
        if (there.isDirectory() && e.isDirectory()) plan(r, dest, false, true);
        else kept++;
        continue;
      }
      const first = keepLinks ? list.later.get(r) : undefined;
      if (first !== undefined) {
        links.push({ path: r, first });
        continue;
      }
      const ew = list.weight.get(r) ?? 1, eb = list.bytesOf.get(r) ?? 0;
      if (e.isDirectory() && (ew > chunk || eb > byteCap || mustSplit.has(r))) {
        const at = track ? tempOf(b, e.name) : dest;
        if (track) {
          added.push(at);
          renames.push({ tmp: at, final: dest });
        }
        made.push({ rel: r, at });
        plan(r, at, true, false);
        continue;
      }
      srcs.push(join(a, e.name));
      w += ew;
      bytes += eb;
      len += a.length + e.name.length + 2;
      if (w >= chunk || bytes >= byteCap || len >= MAX_ARG_BYTES) flush();
    }
    flush();
  };
  plan("", root, rootFresh, !rootMade);
  if (opts.journal) writeFileSync(opts.journal, JSON.stringify(added));
  try {
    if (rootMade) mkdirSync(root, { recursive: true });
    for (const m of made) mkdirSync(m.at);
    for (const c of calls) if (c.into) mkdirSync(c.dir);
    calls.sort((x, y) => y.weight - x.weight);
    await pool(calls, COPY_PARALLEL, async (c) => {
      await cpRun(["-a", "--reflink=auto", "-t", c.dir, "--", ...c.srcs]);
      if (!c.into) return;
      for (const s of c.srcs) moveInto(join(c.dir, basename(s)), join(c.into, basename(s)));
      rmdirSync(c.dir);
    });
    for (const r of renames) renameSync(r.tmp, r.final);
    if (rootMade) renameSync(root, to);
    for (const l of links) linkSync(join(to, l.first), join(to, l.path));
    // After everything is created in them: a later entry would change a dir's mtime, and a read-only dir is filled first.
    await pool([...(rootFresh ? [""] : []), ...made.map((m) => m.rel)], COPY_PARALLEL, (r) => attrs(r ? join(from, r) : from, r ? join(to, r) : to));
  } catch (e) {
    try {
      for (const p of added) removeTree(p);
      if (opts.journal) rmSync(opts.journal, { force: true });
    } catch {
      // The journal stays, and the next copy undoes it.
    }
    throw e;
  }
  if (opts.journal) rmSync(opts.journal, { force: true });
  return { files: list.files, bytes: list.bytes, calls: calls.length, kept, listSecs, copySecs: (performance.now() - t0) / 1000 - listSecs };
}

const isEmpty = (d: string) => !existsSync(d) || readdirSync(d).length === 0;
/** The names warm-sync gives a version of `commit` (src/warm/sync-agent.ts). */
const genOf = (commit: string) => new RegExp(`^gen-${commit.slice(0, 12)}(-[0-9]+)?$`);

/** What warm-copy leaves in COPY_MARK_FILE: the copy's state and, once it is done or refused, what the runner shows of it. */
export type CopyMark = { state: "copying" | "done" | "cold"; commit: string; trimmed?: boolean; bytes?: number; secs?: number; why?: string };

/**
 * AUTOCRAFT_WARM_* of warm-copy: KEY, COMMIT (the version the runner chose), SOURCE (the key's dir on the node), VERIFY_KEYS,
 * TARGET, CARGO_HOME, CHECKOUT, IMAGE, TOOLCHAIN_DIR (what the pod's toolchain-id container wrote: a version of another image
 * is taken when its rustc and toolchain key match, src/warm/toolchain.ts), ENV_HASH, MODE (tmpfs | pvc), SAME_LOCK (1: the version's Cargo.lock must be the
 * checkout's), CARGO_LOCK (that Cargo.lock's sha256, for a pod whose checkout arrives after the copy) and MTIMES (`later`:
 * the checkout arrives after the copy, and the runner sets its mtimes then). A version that does not verify or match is a
 * cold start (exit 0); a missing setting fails the pod.
 *
 * PART `cargo` (a network step pod before the fetch): the same checks except the Cargo.lock, since the fetch adds what the
 * checkout's lock needs; copies only CARGO_HOME and records the version in CARGO_MARK_FILE, so the offline pod's copy of
 * the same version skips CARGO_HOME. It never touches the target, the copy mark or the mtimes, and a refusal leaves CARGO_HOME to the fetch.
 */
export async function warmCopyPhase(work: string, env: NodeJS.ProcessEnv, log: Log): Promise<number> {
  const need = (n: string) => env[`AUTOCRAFT_WARM_${n}`] || (() => {
    throw new Error(`AUTOCRAFT_WARM_${n} is required`);
  })();
  const key = need("KEY"), commit = need("COMMIT"), target = need("TARGET"), cargoHome = need("CARGO_HOME");
  const source = need("SOURCE");
  if (!COMMIT.test(commit)) throw new Error("AUTOCRAFT_WARM_COMMIT is not a commit id");
  const mark = join(work, COPY_MARK_FILE);
  const keyFiles = need("VERIFY_KEYS").split(",").map((f) => f.trim()).filter(Boolean);
  const volume = need("MODE") === "pvc";
  const journal = join(work, CARGO_JOURNAL);
  const cargoOnly = env.AUTOCRAFT_WARM_PART === "cargo";
  const cargoMark = join(work, CARGO_MARK_FILE);
  // A volume-backed target that a finished copy (or an earlier step pod) filled is kept, and so is a cold start's; a
  // half-done copy is redone.
  const state = volume && existsSync(mark) ? (JSON.parse(readFileSync(mark, "utf8")) as Partial<CopyMark>).state : undefined;
  const write = (m: CopyMark) => writeFileSync(mark, JSON.stringify(m));
  const cold = (why: string) => {
    if (cargoOnly) {
      log(`warm copy: ${why}; the fetch fills CARGO_HOME`);
      return 0;
    }
    if (!isEmpty(target)) clearDir(target);
    write({ state: "cold", commit, why });
    log(`warm copy: ${why}; cold start`);
    return 0;
  };
  // The temp entries of a CARGO_HOME copy that a killed pod left are removed, cold start or not.
  try {
    undoJournal(journal, cargoHome);
  } catch (e) {
    return cold(`removing what an interrupted copy left in CARGO_HOME failed (${(e as Error).message})`);
  }
  if (state === "cold" && !cargoOnly) {
    log("warm copy: an earlier step pod of this task started cold; kept cold");
    return 0;
  }
  if (!cargoOnly && !isEmpty(target)) {
    if (state !== "copying") {
      log(`warm copy: the target already holds ${state === "done" ? "the warm copy" : "a build"}; kept`);
      return 0;
    }
    clearDir(target);
  }
  const at = `${key}@${commit.slice(0, 12)}`;
  // The sync agent swaps `current` with a rename while it runs: resolve it once and read everything from that version's
  // dir, which stays on disk for the grace period after it stops being current.
  let gen: string;
  try {
    gen = readlinkSync(join(source, "current"));
  } catch (e) {
    return cold(`the node holds no current version of ${key} (${(e as Error).message})`);
  }
  if (!genOf(commit).test(gen)) return cold(`the node's current version of ${key} is ${gen.slice(0, 64)}, not one of ${commit.slice(0, 12)}`);
  const cur = join(source, gen);
  let keys;
  try {
    keys = keyFiles.map((f) => loadEd25519(readFileSync(f), "public"));
  } catch (e) {
    return cold(`no verify key (${(e as Error).message})`);
  }
  let l, header;
  try {
    l = parseLatest(key, readFileSync(join(cur, "latest.json"), "utf8"));
    if (!l) return cold(`the node's version of ${key} has no valid signed record`);
    if (!verifyLatest(l, keys)) return cold(`the node's version of ${key} is not signed by a known key`);
    if (l.commit !== commit) return cold(`the node holds ${key}@${l.commit.slice(0, 12)}, not ${commit.slice(0, 12)}`);
    const buf = readFileSync(join(cur, "manifest.zst"));
    if (createHash("sha256").update(buf).digest("hex") !== l.sha256) return cold(`the manifest of ${at} does not match its signed record`);
    header = decodeManifest(buf).header;
  } catch (e) {
    return cold(`the node's version of ${key} cannot be read (${(e as Error).message})`);
  }
  if (header.commit !== commit || header.key !== key) return cold(`the manifest of ${at} names another version`);
  if (header.checkout !== need("CHECKOUT") || header.targetDir !== target || header.cargoHome !== cargoHome) return cold(`${at} was built at other paths`);
  const refused = toolchainRefusal({ image: header.image, rustc: header.rustc, toolchain: header.toolchain ?? null }, { image: need("IMAGE"), ...readToolchain(env.AUTOCRAFT_WARM_TOOLCHAIN_DIR) });
  if (refused) return cold(`${at} ${refused}`);
  if (header.envHash !== need("ENV_HASH")) return cold(`${at} was built with another CI env`);
  if (env.AUTOCRAFT_WARM_SAME_LOCK === "1" && !cargoOnly) {
    const lock = env.AUTOCRAFT_WARM_CARGO_LOCK || cargoLockOf(join(work, "src"));
    if (!header.cargoLock || header.cargoLock !== lock) return cold(`${at} was built from another Cargo.lock`);
  }
  // A commit can have several versions (a republish of the same head): the mark names the version by its manifest's sha256.
  let cargoDone = false;
  try {
    cargoDone = existsSync(cargoMark) && (JSON.parse(readFileSync(cargoMark, "utf8")) as { manifest?: unknown }).manifest === l.sha256;
  } catch {
    // An unreadable mark copies CARGO_HOME again, which keeps what is there.
  }
  const kept = "warm copy: CARGO_HOME already holds this version's copy (an earlier step pod made it); kept";
  if (cargoOnly && cargoDone) {
    log(kept);
    return 0;
  }
  const t0 = performance.now();
  const logTree = (name: string, s: CopyStats) => log(`warm copy: ${name} ${s.files} files, ${(s.bytes / 1e9).toFixed(1)} GB in ${(s.listSecs + s.copySecs).toFixed(1)} s (list ${s.listSecs.toFixed(1)} s, ${s.calls} cp${s.kept ? `, ${s.kept} entries already there kept` : ""})`);
  try {
    if (!cargoOnly) {
      if (volume) write({ state: "copying", commit });
      logTree("target", await copyTree(join(cur, "target"), target));
    }
    if (cargoDone) log(kept);
    else {
      // CARGO_HOME may already hold what an earlier step fetched: that is kept.
      logTree("CARGO_HOME", await copyTree(join(cur, "cargo"), cargoHome, { journal }));
      writeFileSync(cargoMark, JSON.stringify({ commit, manifest: l.sha256 }));
    }
  } catch (e) {
    return cold(`copying ${at} failed (${(e as Error).message})`);
  }
  if (cargoOnly) {
    log(`warm copy: CARGO_HOME of ${at} in ${((performance.now() - t0) / 1000).toFixed(1)} s, before the fetch`);
    return 0;
  }
  const secs = (performance.now() - t0) / 1000;
  const trimmed = header.trimmed === true;
  const mtimes = env.AUTOCRAFT_WARM_MTIMES === "later" ? "the checkout's mtimes are set once it arrives" : setMtimes(work, commit, trimmed);
  // A version that is not `trimmed` may hold units built against other checkouts (the producer's restore does not check the env hash), so only a trimmed one gets old ext mtimes; its env hash covers the craft-fonts and craft-i18n commits, so the checkouts here are the ones it was built with.
  const ext = env.AUTOCRAFT_WARM_MTIMES === "later" || !trimmed ? 0 : setExtMtimes(work);
  write({ state: "done", commit, trimmed, bytes: header.bytes, secs: Math.round(secs * 10) / 10 });
  log(`warm copy ${(header.bytes / 1e9).toFixed(1)} GB in ${secs.toFixed(1)} s: ${at} into ${volume ? "the volume" : "memory"}; ${mtimes}${ext ? `; ${ext} files of the gate's checkouts set to 2001-01-01` : ""}`);
  return 0;
}
