// Warm store format (v1 layout, v2 signatures): a manifest lists every file of a warm tree (a cargo target dir plus
// the dependency part of CARGO_HOME) by content hash; file contents live once each as content-addressed blobs.
// Manifest paths start with one of two roots, `target/` and `cargo/`, so a restore can place them anywhere.
//
// The store is not trusted for content: latest.json is signed (Ed25519), it names the manifest's sha256, and the
// manifest names every blob's sha256, so whatever is fetched is checked before it is kept.
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, createReadStream, createWriteStream, linkSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { chmod, lutimes } from "node:fs/promises";
import { isAbsolute, join, posix } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants as zc, createZstdDecompress, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { WARM_KEY } from "../worker/warm.ts";

export const MANIFEST_FORMAT = "autocraft-warm-manifest";
export const ROOTS = ["target", "cargo"] as const;
export type RootName = (typeof ROOTS)[number];
/** Where each root lives on disk. */
export type Roots = Record<RootName, string>;

/** The part of CARGO_HOME a warm tree carries: downloaded sources, never binaries, config or credentials. */
export const CARGO_SUBSET = ["registry/index", "registry/cache", "registry/src", "git/db", "git/checkouts"];
/** Paths a walk leaves out unless the exclusions setting says otherwise: incremental state is per-session and large. */
export const DEFAULT_EXCLUDES = ["target/*/incremental", "target/*/*/incremental"];

/** Written by a restore into the target dir to record what it was built with; a walk never lists it, so it never travels. */
export const WARM_BASE_MARK = ".autocraft-warm-base.json";

export const MAX_ENTRIES = 2_000_000;
export const MAX_MANIFEST_BYTES = 1024 ** 3;
const SHA = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{7,64}$/;
const NS = /^(0|[1-9][0-9]{0,20})$/;

/** Warm data holds no secrets and every pod reads it as another uid: files keep their exec bits and gain read for all and lose group/other write. */
export const readableFileMode = (mode: number): number => (mode | 0o444) & ~0o022;
/** Directories gain read and search for all. */
export const readableDirMode = (mode: number): number => (mode | 0o555) & ~0o022;

export type FileEntry = { path: string; type: "file"; mode: number; size: number; mtimeNs: bigint; sha256: string };
export type DirEntry = { path: string; type: "dir"; mode: number; mtimeNs: bigint };
export type LinkEntry = { path: string; type: "symlink"; target: string; mtimeNs: bigint };
export type Entry = FileEntry | DirEntry | LinkEntry;

export type ManifestHeader = {
  key: string;
  repo: string;
  commit: string;
  /** ms since the epoch; when the producer published it. */
  stored: number;
  /** Toolchain image digest the tree was built with. */
  image: string | null;
  /** `rustc -vV` output. */
  rustc: string | null;
  /** The image's toolchain key (src/warm/toolchain.ts); null or absent when the image declares none or the publisher did not record it. */
  toolchain?: string | null;
  /** Hash of the build env (gate env, flags) the tree was built with. */
  envHash: string | null;
  /** Paths the build used: cargo fingerprints hold absolute paths, so a consumer must build at the same ones. */
  checkout: string | null;
  targetDir: string;
  cargoHome: string;
  /** sha256 of the checkout's Cargo.lock; null or absent when it had none or the publisher did not record it. */
  cargoLock?: string | null;
  /**
   * Every unit the target keeps was read by the build at `commit` (the publish's trim ran and attributed every kept unit),
   * so a consumer may set unchanged sources to an old mtime. Absent or false: a consumer counts every source as changed.
   */
  trimmed?: boolean;
  /** Sum of file sizes. */
  bytes: number;
  files: number;
};
export type Manifest = { header: ManifestHeader; entries: Entry[] };

export class ManifestError extends Error {}

// ---------------------------------------------------------------------------------------------------------------
// Paths

/** A manifest path: relative, `/`-separated, no empty, `.` or `..` segment, under one of the roots. */
export function validPath(p: string): boolean {
  if (typeof p !== "string" || !p || p.length > 4096 || p.includes("\0") || p.includes("\\")) return false;
  const parts = p.split("/");
  if (parts.length < 2 || !(ROOTS as readonly string[]).includes(parts[0])) return false;
  return parts.every((s) => s !== "" && s !== "." && s !== "..");
}

/**
 * A symlink target the restore may create: relative and already normal, so `..` segments come only first and walk up
 * through real directories (every ancestor of an entry is a dir entry), and the result stays under the link's root.
 */
export function validLinkTarget(path: string, target: string): boolean {
  if (typeof target !== "string" || !target || target.length > 4096 || target.includes("\0") || isAbsolute(target) || target.endsWith("/")) return false;
  if (posix.normalize(target) !== target || target === ".") return false;
  const root = path.split("/")[0];
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  return resolved === root || resolved.startsWith(`${root}/`);
}

/**
 * Checks a whole entry list: valid paths and fields, no duplicates, every ancestor below a root listed as a dir.
 * That last rule means no entry lies under a file or a symlink, so a restore never writes through a link.
 */
export function validateEntries(entries: Entry[]): void {
  if (entries.length > MAX_ENTRIES) throw new ManifestError(`manifest lists more than ${MAX_ENTRIES} entries`);
  const kinds = new Map<string, Entry["type"]>();
  for (const e of entries) {
    if (!validPath(e.path)) throw new ManifestError(`manifest path refused: ${JSON.stringify(e.path).slice(0, 200)}`);
    if (kinds.has(e.path)) throw new ManifestError(`manifest lists ${e.path} twice`);
    if (typeof e.mtimeNs !== "bigint" || e.mtimeNs < 0n) throw new ManifestError(`manifest mtime refused for ${e.path}`);
    if (e.type === "file") {
      if (!SHA.test(e.sha256) || !Number.isSafeInteger(e.size) || e.size < 0 || !validMode(e.mode)) throw new ManifestError(`manifest file entry refused: ${e.path}`);
    } else if (e.type === "dir") {
      if (!validMode(e.mode)) throw new ManifestError(`manifest dir entry refused: ${e.path}`);
    } else if (e.type === "symlink") {
      if (!validLinkTarget(e.path, e.target)) throw new ManifestError(`manifest symlink refused: ${e.path} -> ${JSON.stringify(e.target).slice(0, 200)}`);
    } else throw new ManifestError(`manifest entry type refused: ${(e as Entry).path}`);
    kinds.set(e.path, e.type);
  }
  for (const e of entries) {
    const parts = e.path.split("/");
    for (let i = 2; i < parts.length; i++) {
      const anc = parts.slice(0, i).join("/");
      if (kinds.get(anc) !== "dir") throw new ManifestError(`manifest entry ${e.path} is not under a listed directory (${anc})`);
    }
  }
}

const validMode = (m: unknown) => Number.isInteger(m) && (m as number) >= 0 && (m as number) <= 0o777;

// ---------------------------------------------------------------------------------------------------------------
// Walk

/** Compiles exclusion patterns over manifest paths: `*` matches within a segment, `**` any number of segments. */
/**
 * Cargo's lock files (`.cargo-lock`, `.cargo-build-lock`, `.cargo-artifact-lock`) are never published or applied. Cargo
 * takes flocks on them, and when two names share one inode (empty files de-duplicate to one) it deadlocks on itself.
 * Cargo recreates them.
 */
export const isCargoLock = (path: string): boolean => /^\.cargo-.*lock$/.test(path.slice(path.lastIndexOf("/") + 1));

/** Deletes every cargo lock file under `dir`, so a tree copied from a version that holds linked ones cannot deadlock cargo. */
export function removeCargoLocks(dir: string): Promise<void> {
  return new Promise((resolve) => {
    // Best effort: a failure leaves the files, which only matters for a version published with linked locks.
    execFile("find", [dir, "-name", ".cargo-*lock", "-type", "f", "-delete"], { timeout: 10 * 60_000 }, () => resolve());
  });
}

export function excluder(patterns: string[]): (path: string) => boolean {
  const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const res = patterns.filter(Boolean).map((p) => new RegExp(`^${p.split("/").map((seg) => (seg === "**" ? "(?:/[^/]+)*" : `/${seg.split("*").map(esc).join("[^/]*")}`)).join("")}$`));
  return (path) => res.some((r) => r.test(`/${path}`));
}

/** Streams a file through sha256; returns the digest and the byte count. */
export async function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  const h = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    h.update(chunk);
    size += chunk.length;
  }
  return { sha256: h.digest("hex"), size };
}

/** Runs `fn` over `items` with at most `n` running at once; the first failure rejects after the running ones settle. */
export async function mapLimit<T, R>(items: readonly T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failed: unknown;
  const worker = async () => {
    while (failed === undefined && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        failed ??= e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  if (failed !== undefined) throw failed;
  return out;
}

export type WalkSource = { target: string; cargoHome: string };
export type WalkOptions = {
  exclude?: string[];
  /** Manifest paths left out with everything under them (src/warm/trim.ts). */
  omit?: ReadonlySet<string>;
  concurrency?: number; log?: (s: string) => void;
};

/**
 * Lists the warm tree: all of `target` and the CARGO_SUBSET of `cargoHome`, without following links, each file hashed.
 * Sockets, fifos and devices are skipped. Throws on a file name that is not UTF-8 or a file that changes while hashed.
 */
export async function walkTree(src: WalkSource, opts: WalkOptions = {}): Promise<Entry[]> {
  const excluded = excluder(opts.exclude ?? DEFAULT_EXCLUDES);
  const skip = (path: string) => path === `target/${WARM_BASE_MARK}` || isCargoLock(path) || !!opts.omit?.has(path) || excluded(path);
  const entries: Entry[] = [];
  const files: { entry: FileEntry; abs: string }[] = [];
  let odd = 0;
  const add = (abs: string, path: string): boolean => {
    if (skip(path)) return false;
    const st = lstatSync(abs, { bigint: true });
    const mode = Number(st.mode & 0o777n);
    if (st.isDirectory()) entries.push({ path, type: "dir", mode: readableDirMode(mode), mtimeNs: st.mtimeNs });
    else if (st.isFile()) {
      const entry: FileEntry = { path, type: "file", mode: readableFileMode(mode), size: Number(st.size), mtimeNs: st.mtimeNs, sha256: "" };
      entries.push(entry);
      files.push({ entry, abs });
    } else if (st.isSymbolicLink()) {
      entries.push({ path, type: "symlink", target: readlinkSync(abs), mtimeNs: st.mtimeNs });
    } else odd++;
    return st.isDirectory();
  };
  const walk = (abs: string, path: string) => {
    for (const raw of readdirSync(abs, { encoding: "buffer" })) {
      const name = raw.toString("utf8");
      if (!Buffer.from(name, "utf8").equals(raw)) throw new ManifestError(`file name is not UTF-8 under ${path}`);
      const a = join(abs, name), p = `${path}/${name}`;
      if (add(a, p)) walk(a, p);
    }
  };
  if (isDir(src.target)) walk(src.target, "target");
  for (const sub of CARGO_SUBSET) {
    const abs = join(src.cargoHome, sub);
    if (!isDir(abs)) continue;
    const [top] = sub.split("/");
    if (!entries.some((e) => e.path === `cargo/${top}`) && !add(join(src.cargoHome, top), `cargo/${top}`)) continue;
    if (add(abs, `cargo/${sub}`)) walk(abs, `cargo/${sub}`);
  }
  if (odd) opts.log?.(`skipped ${odd} special file${odd === 1 ? "" : "s"}`);
  await mapLimit(files, opts.concurrency ?? 8, async ({ entry, abs }) => {
    const h = await hashFile(abs);
    const st = lstatSync(abs, { bigint: true });
    if (h.size !== entry.size || st.mtimeNs !== entry.mtimeNs) throw new ManifestError(`${entry.path} changed while it was read`);
    entry.sha256 = h.sha256;
  });
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  validateEntries(entries);
  return entries;
}

function isDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}


// ---------------------------------------------------------------------------------------------------------------
// Encoding: zstd of JSON lines, the header first, then one entry per line in path order.

type HeaderLine = { format: string; version: 1; key: string; repo: string; commit: string; stored: number; image: string | null; rustc: string | null; toolchain: string | null; env_hash: string | null; checkout: string | null; target_dir: string; cargo_home: string; cargo_lock: string | null; trimmed: boolean; bytes: number; files: number };

export function makeHeader(h: Omit<ManifestHeader, "bytes" | "files">, entries: Entry[]): ManifestHeader {
  let bytes = 0, files = 0;
  for (const e of entries) if (e.type === "file") (bytes += e.size), files++;
  return { ...h, bytes, files };
}

export function encodeManifest(m: Manifest): Buffer {
  validateHeader(m.header);
  validateEntries(m.entries);
  const h = m.header;
  const head: HeaderLine = { format: MANIFEST_FORMAT, version: 1, key: h.key, repo: h.repo, commit: h.commit, stored: h.stored, image: h.image, rustc: h.rustc, toolchain: h.toolchain ?? null, env_hash: h.envHash, checkout: h.checkout, target_dir: h.targetDir, cargo_home: h.cargoHome, cargo_lock: h.cargoLock ?? null, trimmed: h.trimmed === true, bytes: h.bytes, files: h.files };
  const lines = [JSON.stringify(head)];
  for (const e of m.entries) {
    const ns = e.mtimeNs.toString();
    if (e.type === "file") lines.push(JSON.stringify({ path: e.path, mode: e.mode, size: e.size, mtime_ns: ns, sha256: e.sha256 }));
    else if (e.type === "dir") lines.push(JSON.stringify({ path: e.path, type: "dir", mode: e.mode, mtime_ns: ns }));
    else lines.push(JSON.stringify({ path: e.path, type: "symlink", target: e.target, mtime_ns: ns }));
  }
  return zstdCompressSync(Buffer.from(`${lines.join("\n")}\n`), { params: { [zc.ZSTD_c_compressionLevel]: 6 } });
}

function validateHeader(h: ManifestHeader): void {
  const optStr = (v: unknown) => v === null || (typeof v === "string" && v.length <= 65536);
  const ok = WARM_KEY.test(h.key) && typeof h.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(h.repo) && COMMIT.test(h.commit) && Number.isSafeInteger(h.stored) && h.stored > 0
    && optStr(h.image) && optStr(h.rustc) && (h.toolchain == null || /^[0-9a-f]{64}$/.test(h.toolchain)) && (h.cargoLock == null || /^[0-9a-f]{64}$/.test(h.cargoLock)) && optStr(h.envHash) && optStr(h.checkout) && typeof h.targetDir === "string" && typeof h.cargoHome === "string"
    && Number.isSafeInteger(h.bytes) && h.bytes >= 0 && Number.isSafeInteger(h.files) && h.files >= 0;
  if (!ok) throw new ManifestError("manifest header refused");
}

/** Parses and checks a compressed manifest. Throws ManifestError on anything malformed. */
export function decodeManifest(buf: Buffer): Manifest {
  let text: string;
  try {
    text = zstdDecompressSync(buf, { maxOutputLength: MAX_MANIFEST_BYTES }).toString("utf8");
  } catch (e) {
    throw new ManifestError(`manifest does not decompress: ${(e as Error).message}`);
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const parse = (l: string, i: number) => {
    try {
      return JSON.parse(l) as Record<string, unknown>;
    } catch {
      throw new ManifestError(`manifest line ${i + 1} is not JSON`);
    }
  };
  const h = parse(lines[0] ?? "", 0);
  if (h.format !== MANIFEST_FORMAT || h.version !== 1) throw new ManifestError("not a v1 warm manifest");
  const header: ManifestHeader = {
    key: h.key as string, repo: h.repo as string, commit: h.commit as string, stored: h.stored as number, image: (h.image ?? null) as string | null, rustc: (h.rustc ?? null) as string | null, toolchain: (h.toolchain ?? null) as string | null,
    envHash: (h.env_hash ?? null) as string | null, checkout: (h.checkout ?? null) as string | null, targetDir: h.target_dir as string, cargoHome: h.cargo_home as string, cargoLock: (h.cargo_lock ?? null) as string | null, trimmed: h.trimmed === true, bytes: h.bytes as number, files: h.files as number,
  };
  validateHeader(header);
  if (lines.length - 1 > MAX_ENTRIES) throw new ManifestError(`manifest lists more than ${MAX_ENTRIES} entries`);
  const entries: Entry[] = [];
  let bytes = 0, files = 0;
  for (let i = 1; i < lines.length; i++) {
    const o = parse(lines[i], i);
    if (typeof o.mtime_ns !== "string" || !NS.test(o.mtime_ns)) throw new ManifestError(`manifest line ${i + 1}: mtime_ns refused`);
    const mtimeNs = BigInt(o.mtime_ns), path = o.path as string;
    if (o.type === "dir") entries.push({ path, type: "dir", mode: o.mode as number, mtimeNs });
    else if (o.type === "symlink") entries.push({ path, type: "symlink", target: o.target as string, mtimeNs });
    else if (o.type === undefined) {
      entries.push({ path, type: "file", mode: o.mode as number, size: o.size as number, mtimeNs, sha256: o.sha256 as string });
      bytes += o.size as number;
      files++;
    } else throw new ManifestError(`manifest line ${i + 1}: unknown entry type`);
  }
  validateEntries(entries);
  if (bytes !== header.bytes || files !== header.files) throw new ManifestError("manifest totals do not match its entries");
  return { header, entries };
}

// ---------------------------------------------------------------------------------------------------------------
// latest.json and its signature

/** latest.json: the newest manifest for a key. `sha256` and `size` are those of the compressed manifest file. */
export type Latest = { version: 2; key: string; commit: string; sha256: string; size: number; stored: number; bytes: number; signature: string };

/**
 * The v2 signed statement. It has the shape of the v1 snapshot statement (signedText in src/worker/warm-sync.ts) with
 * the manifest's sha256 in place of the tarball's; the distinct first line keeps a v1 signature from passing as v2.
 */
export const signedTextV2 = (key: string, r: Pick<Latest, "commit" | "sha256" | "stored" | "bytes">) => Buffer.from(`autocraft-warm-v2\n${key}\n${r.commit}\n${r.sha256}\n${r.stored}\n${r.bytes}`);

/** Loads a PEM key for latest.json; throws unless it is an Ed25519 key of the asked kind. */
export function loadEd25519(pem: Buffer | string, kind: "public" | "private"): KeyObject {
  const k = kind === "public" ? createPublicKey(pem) : createPrivateKey(pem);
  if (k.asymmetricKeyType !== "ed25519") throw new ManifestError(`not an Ed25519 ${kind} key (${k.asymmetricKeyType ?? "unknown type"})`);
  return k;
}

export function signLatest(key: string, r: Omit<Latest, "version" | "key" | "signature">, signKey: KeyObject): Latest {
  return { version: 2, key, ...r, signature: sign(null, signedTextV2(key, r), signKey).toString("base64") };
}

/** Parses latest.json for `key`; null when it is malformed or for another key. */
export function parseLatest(key: string, text: string): Latest | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const pos = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
  if (typeof o !== "object" || o === null || o.version !== 2 || o.key !== key || typeof o.commit !== "string" || !COMMIT.test(o.commit) || typeof o.sha256 !== "string" || !SHA.test(o.sha256)) return null;
  if (!pos(o.size) || (o.size as number) > MAX_MANIFEST_BYTES || !pos(o.stored) || !(Number.isSafeInteger(o.bytes) && (o.bytes as number) >= 0) || typeof o.signature !== "string") return null;
  return { version: 2, key, commit: o.commit, sha256: o.sha256, size: o.size as number, stored: o.stored as number, bytes: o.bytes as number, signature: o.signature };
}

export function verifyLatest(l: Latest, keys: KeyObject[]): boolean {
  for (const k of keys) {
    try {
      if (verify(null, signedTextV2(l.key, l), k, Buffer.from(l.signature, "base64"))) return true;
    } catch {
      // A malformed signature or a key of another type counts as no match.
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Apply

/** Returns a blob's compressed bytes. The caller caps how much it reads; apply checks size and hash after decompressing. */
export type BlobSource = (sha256: string, size: number) => Promise<AsyncIterable<Uint8Array>>;
/** `uid` and `gid` are the owner the agent wrote the previous tree as (default: this process's). */
export type Previous = { manifest: Manifest; roots: Partial<Roots>; uid?: number; gid?: number };

/**
 * Whether a file of the previous tree is still as the agent left it: owned by the agent's uid and gid and not writable
 * by group or others. A kubelet fsGroup relabel changes the group and adds g+rw; a write in place needs write access
 * the agent's own read-only files deny to other users. ctime is no test: the agent's own unlinks and chmods of other
 * versions sharing the inode change it.
 */
export function reusableFile(st: { mode: bigint; uid: bigint; gid: bigint }, uid: number, gid: number): boolean {
  return (st.mode & 0o022n) === 0n && Number(st.uid) === uid && Number(st.gid) === gid;
}

export type ApplyStats = { files: number; dirs: number; symlinks: number; linked: number; copied: number; fetched: number; fetchedBytes: number; bytes: number };

/**
 * `pace` is awaited before each chunk of file content is written (fetched or copied, not hard-linked) with its size in
 * bytes; a rate limiter there throttles the restore's disk writes.
 */
export type ApplyOptions = {
  previous?: Previous;
  concurrency?: number;
  pace?: (bytes: number) => Promise<void>;
  /** Called once with the live counters, which the restore keeps updating (`bytes` counts the files started so far). */
  onStats?: (stats: ApplyStats) => void;
};

/** Fails once more than `max` bytes have passed. */
function capped(max: number, what: string): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _e, cb) {
      seen += chunk.length;
      cb(seen > max ? new ManifestError(`${what} is larger than the manifest says`) : null, chunk);
    },
  });
}

/** A blob that is missing, too large or does not match its sha256: the store copy is bad (see PublishInput.recheck). */
export class BadBlobError extends ManifestError {
  readonly sha256: string;
  constructor(sha256: string, msg: string) {
    super(msg);
    this.sha256 = sha256;
  }
}

/**
 * How far a restored mtime may be from the manifest's: Node sets times from a double, which holds today's times to a
 * few hundred nanoseconds (see setMtimes).
 */
export const MTIME_SLACK_NS = 1000n;

/**
 * Builds the tree a manifest describes under `roots`, which must be missing or empty directories; entries under a root
 * that `roots` leaves out are skipped. A file whose sha256 and mode match a file of `previous`, with an mtime within
 * MTIME_SLACK_NS, is hard-linked from it; files that share content within the manifest are written once and linked or
 * copied; the rest come from `fetch`. Modes are restored exactly, mtimes as setMtimes describes. Throws on the first
 * failure (BadBlobError for a bad blob) and leaves the partial tree for the caller to remove (clearDir).
 *
 * A file is linked only if reusableFile holds, so a relabelled or group-writable file is fetched again.
 *
 * `previous` must be a tree only the sync agent writes and consumers mount read-only: a linked file shares its inode,
 * so anything that can write the previous tree can change the new one. Pass no `previous` otherwise.
 */
export async function applyManifest(full: Manifest, roots: Partial<Roots>, fetch: BlobSource, opts: ApplyOptions = {}): Promise<ApplyStats> {
  validateEntries(full.entries);
  const given = ROOTS.filter((r) => roots[r] !== undefined);
  if (!given.length) throw new ManifestError("restore names no root");
  for (const r of given) {
    mkdirSync(roots[r]!, { recursive: true, mode: 0o700 });
    if (!lstatSync(roots[r]!).isDirectory() || readdirSync(roots[r]!).length) throw new ManifestError(`restore root ${r} is not an empty directory`);
  }
  const rootOf = (p: string) => p.slice(0, p.indexOf("/")) as RootName;
  // Manifests from before modes were normalized may hold 0640 files: every applied entry is readable to all.
  const readable = (e: Entry): Entry => (e.type === "file" ? { ...e, mode: readableFileMode(e.mode) } : e.type === "dir" ? { ...e, mode: readableDirMode(e.mode) } : e);
  const m = { ...full, entries: full.entries.filter((e) => roots[rootOf(e.path)] !== undefined && !isCargoLock(e.path)).map(readable) };
  const abs = (rs: Partial<Roots>, p: string) => join(rs[rootOf(p)]!, p.slice(p.indexOf("/") + 1));
  const stats: ApplyStats = { files: 0, dirs: 0, symlinks: 0, linked: 0, copied: 0, fetched: 0, fetchedBytes: 0, bytes: 0 };
  opts.onStats?.(stats);
  const prev = new Map<string, { abs: string; mtimeNs: bigint }[]>();
  if (opts.previous) {
    validateEntries(opts.previous.manifest.entries);
    const pr = opts.previous.roots;
    for (const e of opts.previous.manifest.entries) {
      if (e.type !== "file" || pr[rootOf(e.path)] === undefined) continue;
      const k = `${e.sha256}:${readableFileMode(e.mode)}`, v = { abs: abs(pr, e.path), mtimeNs: e.mtimeNs };
      prev.get(k)?.push(v) ?? prev.set(k, [v]);
    }
  }
  const near = (a: bigint, b: bigint) => (a > b ? a - b : b - a) < MTIME_SLACK_NS;
  const dirs = m.entries.filter((e): e is DirEntry => e.type === "dir");
  for (const d of dirs) mkdirSync(abs(roots, d.path), { mode: 0o700 });
  stats.dirs = dirs.length;

  const groups = new Map<string, FileEntry[]>();
  for (const e of m.entries) if (e.type === "file") groups.get(e.sha256)?.push(e) ?? groups.set(e.sha256, [e]);
  const times: { abs: string; ns: bigint }[] = [];
  /** Links `dest` to a previous file with the same content and mode whose mtime, on disk too, is near the entry's. */
  const linkFromPrev = (e: FileEntry, dest: string): boolean => {
    for (const c of prev.get(`${e.sha256}:${e.mode}`) ?? []) {
      if (!near(c.mtimeNs, e.mtimeNs)) continue;
      try {
        const st = lstatSync(c.abs, { bigint: true });
        if (!st.isFile() || Number(st.size) !== e.size || !near(st.mtimeNs, e.mtimeNs) || readableFileMode(Number(st.mode & 0o777n)) !== e.mode) continue;
        if (!reusableFile(st, opts.previous!.uid ?? process.getuid!(), opts.previous!.gid ?? process.getgid!())) continue;
        // The shared inode may predate the normalization: make it readable for both versions.
        if ((Number(st.mode & 0o777n) & 0o444) !== 0o444) chmodSync(c.abs, e.mode);
        linkSync(c.abs, dest);
        return true;
      } catch {
        // Gone or unreadable: try the next candidate, else fetch.
      }
    }
    return false;
  };
  await mapLimit([...groups.values()], opts.concurrency ?? 8, async (group) => {
    let local: FileEntry | undefined;
    for (const e of group) {
      const dest = abs(roots, e.path);
      stats.files++;
      stats.bytes += e.size;
      if (e.size === 0) {
        // Every empty file is its own inode: a shared one makes flock-based lock files deadlock.
        writeFileSync(dest, "", { flag: "wx" });
        await chmod(dest, e.mode);
        await setMtimes([{ abs: dest, ns: e.mtimeNs }]);
        stats.copied++;
        continue;
      }
      if (linkFromPrev(e, dest)) {
        stats.linked++;
        local ??= e;
        continue;
      }
      if (local && local.mode === e.mode && local.mtimeNs === e.mtimeNs) {
        linkSync(abs(roots, local.path), dest);
        stats.copied++;
        continue;
      }
      if (local) {
        await opts.pace?.(e.size);
        copyFileSync(abs(roots, local.path), dest);
        stats.copied++;
      } else {
        await fetchOne(e, dest, fetch, opts.pace);
        stats.fetched++;
        stats.fetchedBytes += e.size;
        local = e;
      }
      await chmod(dest, e.mode);
      // File times are set at once, so only directories and symlinks wait in `times` (a tree has millions of files).
      await setMtimes([{ abs: dest, ns: e.mtimeNs }]);
    }
  });
  for (const e of m.entries) {
    if (e.type !== "symlink") continue;
    const dest = abs(roots, e.path);
    symlinkSync(e.target, dest);
    times.push({ abs: dest, ns: e.mtimeNs });
    stats.symlinks++;
  }
  // Directory times after all entries exist (creating one changes its directory's mtime); directory modes last, since
  // a read-only directory blocks writes and chmod leaves mtimes alone.
  for (const d of dirs) times.push({ abs: abs(roots, d.path), ns: d.mtimeNs });
  await setMtimes(times);
  for (const d of dirs) await chmod(abs(roots, d.path), d.mode);
  return stats;
}

async function fetchOne(e: FileEntry, dest: string, fetch: BlobSource, pace?: (bytes: number) => Promise<void>): Promise<void> {
  const h = createHash("sha256");
  let n = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _e, cb) {
      h.update(chunk);
      n += chunk.length;
      if (!pace) return cb(null, chunk);
      void pace(chunk.length).then(() => cb(null, chunk), cb);
    },
  });
  try {
    await pipeline(await fetch(e.sha256, e.size), createZstdDecompress(), capped(e.size, `blob ${e.sha256.slice(0, 12)}`), tap, createWriteStream(dest, { mode: 0o600, flags: "wx" }));
  } catch (err) {
    const msg = `blob ${e.sha256.slice(0, 12)} for ${e.path}: ${(err as Error).message}`;
    // Only a copy that is missing, too large or not valid zstd is bad; timeouts, 5xx, dropped connections and a full disk say nothing about the store.
    const code = (err as { code?: unknown }).code;
    const bad = err instanceof ManifestError || (err as { kind?: string }).kind !== undefined || (typeof code === "string" && code.startsWith("ZSTD_"));
    throw bad ? new BadBlobError(e.sha256, msg) : new Error(msg, { cause: err });
  }
  if (n !== e.size || h.digest("hex") !== e.sha256) throw new BadBlobError(e.sha256, `blob ${e.sha256.slice(0, 12)} for ${e.path} does not match its sha256`);
}

/**
 * Sets mtimes (and atimes) without following links. Node takes seconds as a double, which at today's epoch holds a
 * time to a few hundred nanoseconds: whole seconds (registry sources, the OLD stamp of checkouts) come back exactly,
 * others within MTIME_SLACK_NS. The rounding is monotone, so every "not newer than" relation cargo's freshness checks
 * use still holds.
 */
export async function setMtimes(items: { abs: string; ns: bigint }[]): Promise<void> {
  await mapLimit(items, 32, async ({ abs, ns }) => {
    const t = Number(ns / 1_000_000_000n) + Number(ns % 1_000_000_000n) / 1e9;
    await lutimes(abs, t, t);
  });
}

/** Removes everything inside `dir` (not `dir` itself, which is often a mount point), read-only directories included. */
export function clearDir(dir: string): void {
  const open = (d: string) => {
    chmodSync(d, 0o700);
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (lstatSync(p).isDirectory()) open(p);
    }
  };
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (lstatSync(p).isDirectory()) open(p);
    rmSync(p, { recursive: true, force: true });
  }
}
