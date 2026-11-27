// A read-only copy of a commit's regular files for a sandboxed model call,
// built from the bare cached clone without a working tree. Only regular files
// are written, one by one, under validated paths: no symlinks, submodules,
// devices or `.git` entries exist in the copy, and nothing in it is executed.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { GIT_ENV, HARDENING, gitDirEnv } from "../fixup/git.ts";
import { envVar } from "../env.ts";
import { limiter } from "../async-seq.ts";
import { isInstructionPath } from "./instruction-paths.ts";

export { isInstructionPath };

export type CheckoutCaps = { maxFiles: number; maxBytes: number; maxFileBytes: number };
export const DEFAULT_CAPS: CheckoutCaps = { maxFiles: 20_000, maxBytes: 150 * 1024 * 1024, maxFileBytes: 2 * 1024 * 1024 };

export function checkoutRoot(): string {
  return envVar("CHECKOUT_DIR") ?? join(homedir(), ".cache/autocraft/checkouts-v2");
}

/** Lists the tree of `sha`, killing git as soon as the listing alone shows more than `maxFiles` records or `maxBytes` of file sizes. */
function lsTree(gitDir: string, sha: string, caps: CheckoutCaps): Promise<{ code: number; stdout: string; tooLarge: string | null }> {
  return new Promise((resolve, reject) => {
    const p = spawn("git", [...HARDENING, "ls-tree", "-r", "-z", "-l", "--full-tree", sha], { cwd: gitDir, env: { ...process.env, ...GIT_ENV, ...gitDirEnv(gitDir) }, stdio: ["ignore", "pipe", "ignore"], timeout: 300_000 });
    let text = "";
    let rest = "";
    let files = 0;
    let bytes = 0;
    let tooLarge: string | null = null;
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (d: string) => {
      if (tooLarge) return;
      text += d;
      const recs = (rest + d).split("\0");
      rest = recs.pop() ?? "";
      for (const r of recs) {
        files++;
        bytes += Number(/ +(\d+)\t/.exec(r)?.[1] ?? 0);
      }
      if (files > caps.maxFiles || bytes > caps.maxBytes) {
        tooLarge = `tree too large (over ${files} files, ${bytes} bytes)`;
        text = "";
        p.kill("SIGKILL");
      }
    });
    p.on("error", reject);
    p.on("close", (code) => resolve({ code: code ?? 1, stdout: text, tooLarge }));
  });
}

/** True for a path that is safe to create under the checkout root. */
export function safePath(p: string): boolean {
  if (!p || p.length > 500 || p.includes("\0") || p.includes("\\") || p.startsWith("/")) return false;
  return p.split("/").every((c) => c !== "" && c !== "." && c !== ".." && c.toLowerCase() !== ".git");
}

type Entry = { oid: string; size: number; path: string };

/** The regular files (modes 100644 and 100755) of `sha`; symlinks, submodules, unsafe paths and instruction files are left out. */
export function parseTree(listing: string, caps: CheckoutCaps): Entry[] {
  const out: Entry[] = [];
  for (const rec of listing.split("\0")) {
    const m = /^(\d+) (\w+) ([0-9a-f]{40,64}) +(\d+|-)\t(.*)$/s.exec(rec);
    if (!m || m[2] !== "blob" || (m[1] !== "100644" && m[1] !== "100755")) continue;
    const size = Number(m[4]);
    if (size > caps.maxFileBytes || !safePath(m[5]!) || isInstructionPath(m[5]!)) continue;
    out.push({ oid: m[3]!, size, path: m[5]! });
  }
  return out;
}

/**
 * Splits `git cat-file --batch` output, as it arrives, into blobs in request order and hands each one to `write`. Holds
 * at most one blob (each is under the per-file cap) and the chunk being read. `end` is false when the output stopped early
 * or did not have the expected form.
 */
export class BatchReader {
  private buf: Buffer = Buffer.alloc(0);
  private want = -1;
  private n = 0;
  private bad = false;
  private readonly count: number;
  private readonly write: (i: number, blob: Buffer) => void;
  constructor(count: number, write: (i: number, blob: Buffer) => void) {
    this.count = count;
    this.write = write;
  }
  push(chunk: Buffer): void {
    if (this.bad) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.want < 0) {
        const nl = this.buf.indexOf(10);
        if (nl < 0) return;
        const m = /^[0-9a-f]+ blob (\d+)$/.exec(this.buf.toString("latin1", 0, nl));
        if (!m || this.n >= this.count) { this.bad = true; return; }
        this.want = Number(m[1]);
        this.buf = this.buf.subarray(nl + 1);
      }
      if (this.buf.length < this.want + 1) return;
      this.write(this.n++, Buffer.from(this.buf.subarray(0, this.want)));
      this.buf = this.buf.subarray(this.want + 1);
      this.want = -1;
    }
  }
  end(): boolean { return !this.bad && this.n === this.count && this.want < 0 && this.buf.length === 0; }
}

/** Writes the blobs of `entries` from `git cat-file --batch` into `dir` as they arrive; false when git failed or the output was not complete. */
function writeBlobs(gitDir: string, entries: Entry[], dir: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const p = spawn("git", [...HARDENING, "cat-file", "--batch"], { cwd: gitDir, env: { ...process.env, ...GIT_ENV, ...gitDirEnv(gitDir) }, stdio: ["pipe", "pipe", "ignore"], timeout: 300_000 });
    let failed: Error | null = null;
    const reader = new BatchReader(entries.length, (i, blob) => {
      const f = join(dir, entries[i]!.path);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, blob, { mode: 0o644, flag: "wx" });
    });
    p.stdout.on("data", (d: Buffer) => {
      if (failed) return;
      try { reader.push(d); } catch (e) { failed = e as Error; p.kill("SIGKILL"); }
    });
    p.on("error", reject);
    p.on("close", (code) => (failed ? reject(failed) : resolve(code === 0 && reader.end())));
    p.stdin.on("error", () => {});
    p.stdin.end(entries.map((e) => `${e.oid}\n`).join(""));
  });
}

export type CheckoutResult = { ok: true; dir: string; files: number; bytes: number } | { ok: false; reason: string };

/** Most checkouts built at once: each holds a tree listing and a blob in memory and writes up to the size cap to disk. */
const oneBuild = limiter(2);
const inflight = new Map<string, Promise<CheckoutResult>>();

/**
 * Writes the regular files of commit `sha` from the bare repository `gitDir`
 * into `dest`, or reports why not (too large, unreadable). An existing `dest`
 * is a finished checkout of the same commit and is reused.
 */
export async function buildCheckout(gitDir: string, sha: string, dest: string, caps: CheckoutCaps = DEFAULT_CAPS): Promise<CheckoutResult> {
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return { ok: false, reason: "not a commit id" };
  if (existsSync(dest)) {
    touch(dest);
    return { ok: true, dir: dest, files: 0, bytes: 0 };
  }
  // A second call for the same commit shares the first one's build: both would write the same temporary directory.
  const key = resolve(dest);
  const running = inflight.get(key);
  if (running) return running;
  const build = oneBuild(async (): Promise<CheckoutResult> => {
    if (existsSync(dest)) {
      touch(dest);
      return { ok: true, dir: dest, files: 0, bytes: 0 };
    }
    const ls = await lsTree(gitDir, sha, caps);
    if (ls.tooLarge) return { ok: false, reason: ls.tooLarge };
    if (ls.code !== 0) return { ok: false, reason: "could not list the commit's files" };
    const entries = parseTree(ls.stdout, caps);
    const bytes = entries.reduce((a, e) => a + e.size, 0);
    if (entries.length > caps.maxFiles || bytes > caps.maxBytes) return { ok: false, reason: `tree too large (${entries.length} files, ${bytes} bytes)` };
    const tmp = `${dest}.tmp-${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    try {
      if (!(await writeBlobs(gitDir, entries, tmp))) {
        rmSync(tmp, { recursive: true, force: true });
        return { ok: false, reason: "could not read the commit's files" };
      }
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(tmp, dest);
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      if (existsSync(dest)) return { ok: true, dir: dest, files: entries.length, bytes };
      return { ok: false, reason: `could not write the checkout: ${(e as Error).message}`.slice(0, 200) };
    }
    sizes.set(key, bytes);
    return { ok: true, dir: dest, files: entries.length, bytes };
  }).finally(() => inflight.delete(key));
  inflight.set(key, build);
  return build;
}

const held = new Map<string, number>();

/** Marks checkouts as in use by a running call, so pruning and sweeping skip them; the returned function releases them. */
export function holdCheckouts(dirs: string[]): () => void {
  const list = dirs.map((d) => resolve(d));
  for (const d of list) { held.set(d, (held.get(d) ?? 0) + 1); touchCheckout(d); }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const d of list) {
      const n = (held.get(d) ?? 1) - 1;
      if (n > 0) held.set(d, n); else held.delete(d);
      touchCheckout(d);
    }
  };
}

export const checkoutHeld = (dir: string): boolean => held.has(resolve(dir));

export function touchCheckout(dir: string): void { touch(dir); }

function touch(dir: string): void {
  try { const t = new Date(); utimesSync(dir, t, t); } catch { /* pruning then sees an older time */ }
}

/** Bytes of the files of finished checkouts, by resolved path: written once and never changed, so measured once per process. */
const sizes = new Map<string, number>();

function dirBytes(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) n += dirBytes(p);
    else if (e.isFile()) n += statSync(p).size;
  }
  return n;
}

function sizeOf(dir: string): number {
  const key = resolve(dir);
  let n = sizes.get(key);
  if (n === undefined) {
    try { n = dirBytes(dir); } catch { n = 0; }
    sizes.set(key, n);
  }
  return n;
}

/** Most bytes the finished checkouts under one root keep (AUTOCRAFT_CHECKOUT_MAX_GB, default 10); the least recently used go first. */
export function checkoutCapBytes(): number {
  const gb = Number(envVar("CHECKOUT_MAX_GB"));
  return (Number.isFinite(gb) && gb > 0 ? gb : 10) * 1024 ** 3;
}

/**
 * Removes checkouts under `root/<repo>/<sha>` not used for `maxAgeMs`, and unfinished ones; then, while the rest hold more
 * than `maxBytes`, the least recently used. Checkouts held with `holdCheckouts` (by a running scan, for example) stay.
 */
export function pruneCheckouts(root: string, maxAgeMs: number, now = Date.now(), maxBytes = checkoutCapBytes()): number {
  let n = 0;
  if (!existsSync(root)) return 0;
  const kept: { p: string; at: number }[] = [];
  const remove = (p: string): void => { rmSync(p, { recursive: true, force: true }); sizes.delete(resolve(p)); n++; };
  for (const repo of readdirSync(root)) {
    const rd = join(root, repo);
    for (const d of readdirSync(rd)) {
      const p = join(rd, d);
      let at: number;
      try { at = statSync(p).mtimeMs; } catch { continue; }
      const unfinished = d.includes(".tmp-");
      if (now - at > (unfinished ? 3600_000 : maxAgeMs)) { if (!checkoutHeld(p)) remove(p); continue; }
      if (!unfinished) kept.push({ p, at });
    }
  }
  let total = kept.reduce((a, k) => a + sizeOf(k.p), 0);
  for (const k of kept.sort((x, y) => x.at - y.at)) {
    if (total <= maxBytes) break;
    if (checkoutHeld(k.p)) continue;
    total -= sizeOf(k.p);
    remove(k.p);
  }
  return n;
}
