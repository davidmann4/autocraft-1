// The pod side of a build pod that starts warm (src/build/warm-mount.ts builds its spec):
//   changedSince   in the source pod: the checkout's files whose content differs from the warm commit's tree, written to
//                  the task's volume (CHANGED_FILE)
//   warmCopyPhase  `worker pod warm-copy`, before the steps of an offline step pod: verifies the node's warm version,
//                  copies its target and CARGO_HOME, and sets the checkout's mtimes
// cargo decides freshness by mtime: a source file older than the dep-info of the unit that read it counts as unchanged.
// So every checkout file is set to OLD_MTIME (before any warm build), and only the files that changed since the warm
// commit are set to now. That is sound only when every unit in the warm target was checked by the build at the warm commit,
// which the manifest's `trimmed` says; without it, or without the list, every file is set to now: correct, but every
// workspace crate rebuilds.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, lutimesSync, linkSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { slugOf } from "../owners.ts";
import { CHANGED_FILE, COPY_MARK_FILE } from "../build/warm-mount.ts";
import { readToolchain, toolchainRefusal } from "../warm/toolchain.ts";
import { clearDir, decodeManifest, removeCargoLocks, loadEd25519, parseLatest, verifyLatest } from "../warm/manifest.ts";

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
  for (const d of changed.dirs ?? []) if (d === "" || safeRel(d)) if (isDir(join(src, d))) lutimesSync(join(src, d), now, now);
  return `${touch.size} source files changed since ${commit.slice(0, 12)}`;
}

/**
 * Sets every file of the gate's extra checkouts (`<work>/ext/*`, mounted read-only in the steps, so set here while the
 * volume is writable) to OLD_MTIME. Cargo's fingerprints of path dependencies there (e.g. a font manifest) compare against
 * the warm build's dep-info; fresh mtimes make it rebuild every crate that reads them. Returns the file count.
 */
export function setExtMtimes(work: string): number {
  const ext = join(work, "ext");
  if (!isDir(ext)) return 0;
  const files = walk(ext);
  for (const p of files) lutimesSync(join(ext, p), OLD_MTIME_SEC, OLD_MTIME_SEC);
  return files.length;
}

/**
 * Moves every entry of `from` into `to` with renames (same file system), then removes `from`. What `to` already holds is
 * kept: an earlier step fetched it for this checkout (a newer index cache, a newly pinned crate). Each file lands whole, so
 * a CARGO_HOME never holds a half-copied file.
 */
function mergeInto(from: string, to: string): void {
  if (!existsSync(to)) {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    return;
  }
  for (const n of readdirSync(from)) {
    const a = join(from, n), b = join(to, n);
    const sb = lstatSync(b, { throwIfNoEntry: false });
    if (sb?.isDirectory() && lstatSync(a).isDirectory()) mergeInto(a, b);
    else if (!sb) renameSync(a, b);
  }
  rmSync(from, { recursive: true, force: true });
}

/** The summary of a failed cp: files the pod's uid cannot read get their own wording and count, so an operator sees why. */
export function copyFailure(stderr: string): string {
  const lines = stderr.trim().split("\n");
  const denied = lines.filter((l) => /cannot open .* for reading: Permission denied/.test(l)).length;
  if (denied) return `unreadable files in the warm version (${denied}${lines.length >= denied && denied === lines.length ? "" : "+"} reported; first: ${lines.find((l) => l.includes("Permission denied"))!.slice(0, 160)})`;
  return `cp: ${lines.slice(-2).join(" ")}`;
}

/** Copies run at once, directory levels below the root that are split into separate copies, and entries per `cp` call. */
export const COPY_PARALLEL = 8;
const COPY_SPLIT_DEPTH = 4;
const COPY_BATCH = 64;

function cpRun(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("cp", args, { timeout: 30 * 60_000, maxBuffer: 1024 * 1024 }, (err, _o, stderr) =>
      err ? reject(new Error(copyFailure(stderr || err.message))) : resolve());
  });
}

/** `<inode>\t<path>` NUL-terminated, for the regular files under `dir` that have more than one link. */
function listLinked(dir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("find", [dir, "-type", "f", "-links", "+1", "-printf", "%i\\t%p\\0"], { maxBuffer: 1 << 28 }, (err, out) => (err ? reject(new Error(`find: ${err.message}`)) : resolve(out)));
  });
}

function attrs(from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("chmod", [`--reference=${from}`, "--", to], (e1) => {
      if (e1) return reject(e1);
      execFile("touch", ["-r", from, "--", to], (e2) => (e2 ? reject(e2) : resolve()));
    });
  });
}

/**
 * Like `cp -a from/. to/` (modes, mtimes, symlinks), with COPY_PARALLEL `cp` processes at once: the top COPY_SPLIT_DEPTH
 * directory levels are created here and their entries copied in batches, and deeper trees are copied whole. Directory
 * modes and mtimes are set after their contents. The first failure rejects once the running copies end.
 */
export async function copyTree(from: string, to: string): Promise<void> {
  // Files with several links (cargo uplifts binaries as hard links): the first path of each inode is copied, the others
  // are linked to its copy afterwards, so the copy shares inodes like the source does. A dir that holds a later path is
  // split too, so that path can be left out of the batches.
  const firstOf = new Map<string, string>();
  const later = new Map<string, string>();
  for (const rec of (await listLinked(from)).split("\0")) {
    const t = rec.indexOf("\t");
    if (t < 0) continue;
    const ino = rec.slice(0, t), path = rec.slice(t + 1);
    const first = firstOf.get(ino);
    if (first === undefined) firstOf.set(ino, path);
    else later.set(path, first);
  }
  const withLater = new Set<string>();
  for (const path of later.keys()) for (let d = dirname(path); d.length >= from.length && !withLater.has(d); d = dirname(d)) withLater.add(d);
  const dirs: { from: string; to: string }[] = [];
  const jobs: string[][] = [];
  const split = (a: string, b: string, depth: number) => {
    dirs.push({ from: a, to: b });
    let batch: string[] = [];
    const flush = () => {
      if (batch.length) jobs.push(["-a", "-t", b, "--", ...batch]);
      batch = [];
    };
    for (const e of readdirSync(a, { withFileTypes: true })) {
      if (later.has(join(a, e.name))) continue;
      if (e.isDirectory() && (depth + 1 < COPY_SPLIT_DEPTH || withLater.has(join(a, e.name)))) {
        mkdirSync(join(b, e.name));
        split(join(a, e.name), join(b, e.name), depth + 1);
        continue;
      }
      batch.push(join(a, e.name));
      if (batch.length >= COPY_BATCH) flush();
    }
    flush();
  };
  mkdirSync(to, { recursive: true });
  split(from, to, 0);
  let next = 0;
  let failure: Error | null = null;
  const worker = async () => {
    while (!failure && next < jobs.length) {
      try {
        await cpRun(jobs[next++]);
      } catch (e) {
        failure ??= e as Error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(COPY_PARALLEL, jobs.length) }, worker));
  if (failure) throw failure;
  for (const [path, first] of later) linkSync(join(to, relative(from, first)), join(to, relative(from, path)));
  // Deepest first: setting a directory's mtime after its children keeps it.
  for (const d of dirs.reverse()) await attrs(d.from, d.to);
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
  const cargoTmp = `${cargoHome}.warm-copy`;
  rmSync(cargoTmp, { recursive: true, force: true });
  // A volume-backed target that a finished copy (or an earlier step pod) filled is kept, and so is a cold start's; a
  // half-done copy is redone.
  const state = volume && existsSync(mark) ? (JSON.parse(readFileSync(mark, "utf8")) as Partial<CopyMark>).state : undefined;
  const write = (m: CopyMark) => writeFileSync(mark, JSON.stringify(m));
  if (state === "cold") {
    log("warm copy: an earlier step pod of this task started cold; kept cold");
    return 0;
  }
  if (!isEmpty(target)) {
    if (state !== "copying") {
      log(`warm copy: the target already holds ${state === "done" ? "the warm copy" : "a build"}; kept`);
      return 0;
    }
    clearDir(target);
  }
  const cold = (why: string) => {
    rmSync(cargoTmp, { recursive: true, force: true });
    if (!isEmpty(target)) clearDir(target);
    write({ state: "cold", commit, why });
    log(`warm copy: ${why}; cold start`);
    return 0;
  };
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
  if (env.AUTOCRAFT_WARM_SAME_LOCK === "1") {
    const lock = env.AUTOCRAFT_WARM_CARGO_LOCK || cargoLockOf(join(work, "src"));
    if (!header.cargoLock || header.cargoLock !== lock) return cold(`${at} was built from another Cargo.lock`);
  }
  const t0 = performance.now();
  try {
    if (volume) write({ state: "copying", commit });
    await copyTree(join(cur, "target"), target);
    // cp -a keeps hard links, and cargo deadlocks on flocks of lock files that share an inode.
    await removeCargoLocks(target);
    mkdirSync(cargoTmp, { recursive: true });
    await copyTree(join(cur, "cargo"), cargoTmp);
  } catch (e) {
    return cold(`copying ${at} failed (${(e as Error).message})`);
  }
  // CARGO_HOME may already hold what an earlier step fetched: the copy goes in beside it and then moves in with renames.
  try {
    mergeInto(cargoTmp, cargoHome);
  } catch (e) {
    return cold(`moving ${at}'s CARGO_HOME into place failed (${(e as Error).message})`);
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
