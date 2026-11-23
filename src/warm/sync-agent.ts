// The warm-sync agent. One runs on every node (a DaemonSet) and keeps the newest signed version of each assigned warm
// key in a node directory that build and workspace pods mount read-only:
//   <dir>/<key>/gen-<sha12>/{target,cargo,meta.json,manifest.zst}   one version of the key
//   <dir>/<key>/gen-<sha12>/latest.json                            its signed record, which consumers verify
//   <dir>/<key>/current -> gen-<sha12>                             the version consumers start from
// A new version is built as `gen-<sha12>.tmp` with the current one as `previous`, so files that did not change are hard
// links and only the rest is downloaded (writes paced to a byte rate). The finished dir is renamed into place and
// `current` is swapped with a rename. A version that stopped being current keeps its files for `graceMs`, so copies (and
// builds that run directly from the read-only mount) that started from it can finish; its dir mtime records when it
// stopped. The grace period must exceed the longest build deadline plus 30 minutes: the default is 3.5 h, for the
// 3 h default deadline of a build pod. The agent writes what it holds to the ConfigMap
// `warm-status-<node>`, which the runner reads (src/build/warm-status.ts).
import type { KeyObject } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statfsSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ConfigMapApi } from "../build/kube-api.ts";
import { KubeError } from "../build/kube-api.ts";
import { WARM_KEY } from "../worker/warm.ts";
import { applyManifest, type ApplyStats, BadBlobError, clearDir, decodeManifest, type Latest, type Manifest, type Previous } from "./manifest.ts";
import type { WarmStore } from "./store-client.ts";

export const STATUS_PREFIX = "warm-status-";
export const STATUS_DATA_KEY = "status.json";
export const STATUS_LABEL = "craft.build/warm-status";
/** Written into a version dir once every entry in it is readable to all uids. */
const MODES_MARK = ".modes-ok2";
const GEN = /^gen-[0-9a-f]{7,12}(-[0-9]+)?$/;
const NODE_NAME = /^[a-z0-9]([-a-z0-9.]{0,230}[a-z0-9])?$/;
const MAX_BAD_BLOBS = 32;
/** Longest build deadline (3 h by default) plus 30 minutes. */
export const DEFAULT_GRACE_MS = 3.5 * 3600_000;

/** Removes a tree the agent made, read-only directories inside it included. */
function removeTree(p: string): void {
  const st = lstatSync(p, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isDirectory()) clearDir(p);
  rmSync(p, { recursive: true, force: true });
}

/** What `warm-status-<node>` holds (data key `status.json`). */
export type NodeStatus = {
  version: 1;
  node: string;
  /** ms since the epoch, by the node's clock. */
  updated: number;
  fs: { sizeBytes: number; usedBytes: number; usedPct: number };
  /** Warm bytes on the node: current versions, and retired versions still in their grace period. Both count against the node cap. */
  warmBytes: { current: number; grace: number };
  /** The version each key's `current` names. */
  keys: Record<string, KeyStatus>;
  /** Assigned keys that are not held at their newest version, and why. */
  pending: Record<string, string>;
  /** Per key, blobs a sync found missing or not matching their sha256, for the producer's next publish to recheck. */
  badBlobs: Record<string, string[]>;
  /** Why the agent cannot work at all (the assignment cannot be read); absent when it can. */
  error?: string;
};
/** `rustc` and `toolchain`: what the version was built with besides its image (src/warm/toolchain.ts); absent from older agents. */
export type KeyStatus = { commit: string; stored: number; bytes: number; image: string | null; rustc?: string | null; toolchain?: string | null; envHash: string | null; synced: number; cargoLock?: string | null };

/** meta.json of a version. Consumers build at `checkout`, `targetDir` and `cargoHome`: cargo fingerprints hold absolute paths. */
export type GenMeta = {
  key: string; repo: string; commit: string; stored: number; bytes: number; files: number;
  image: string | null; rustc: string | null; toolchain?: string | null; envHash: string | null; checkout: string | null; targetDir: string; cargoHome: string; cargoLock?: string | null;
  manifestSha256: string; synced: number;
};

/** The ConfigMap `warm-assign`: keys in priority order and the node cap. */
export type Assign = { keys: string[]; maxBytes: number };

export type DiskUse = { sizeBytes: number; usedBytes: number; availBytes: number };

export type SyncConfig = {
  dir: string;
  node: string;
  store: WarmStore;
  /** Read each cycle, so a rotated key takes effect without a restart. */
  verifyKeys: () => KeyObject[];
  /** Read each cycle; throws when the assignment cannot be read. */
  assign: () => Assign;
  /** null: no status is written (outside a cluster). */
  kube: Pick<ConfigMapApi, "createConfigMap" | "patchConfigMap"> | null;
  namespace: string;
  log: (line: string) => void;
  /** 0 for no limit. */
  writeBytesPerSec?: number;
  graceMs?: number;
  /** No new versions while the node's filesystem is at least this full. */
  maxFsPct?: number;
  statusEveryMs?: number;
  /** How often a running download rewrites its progress into the status (default 15 s). */
  progressEveryMs?: number;
  /** Wait before trying the same commit again after it failed. */
  retryMs?: number;
  concurrency?: number;
  now?: () => number;
  diskUse?: (dir: string) => DiskUse;
};

export function statfsUse(dir: string): DiskUse {
  const s = statfsSync(dir);
  return { sizeBytes: s.blocks * s.bsize, usedBytes: (s.blocks - s.bfree) * s.bsize, availBytes: s.bavail * s.bsize };
}

/** Used share as `df` counts it: used against used plus what unprivileged writers may still use. */
function usedPct(d: DiskUse): number {
  const denom = d.usedBytes + d.availBytes;
  return denom > 0 ? Math.round((d.usedBytes / denom) * 1000) / 10 : 0;
}

/** Spreads `take(n)` calls over time so they add up to at most `bytesPerSec`, with up to `burstMs` of credit. */
export class Pacer {
  private next = 0;
  private readonly bytesPerSec: number;
  private readonly burstMs: number;
  constructor(bytesPerSec: number, burstMs = 250) {
    this.bytesPerSec = bytesPerSec;
    this.burstMs = burstMs;
  }
  async take(n: number): Promise<void> {
    if (this.bytesPerSec <= 0 || n <= 0) return;
    const t = performance.now();
    this.next = Math.max(this.next, t - this.burstMs) + (n / this.bytesPerSec) * 1000;
    const wait = this.next - t;
    if (wait >= 1) await sleep(wait);
  }
}

/** Reads the assignment from a mounted `warm-assign` ConfigMap: `repos` (one key per line, `#` comments) and `maxGbPerNode` (GiB). */
export function readAssignDir(dir: string): Assign {
  const keys: string[] = [];
  for (const raw of readFileSync(join(dir, "repos"), "utf8").split("\n")) {
    const k = raw.replace(/#.*/, "").trim();
    if (!k) continue;
    if (!WARM_KEY.test(k) || k === "blobs") throw new Error(`warm-assign: repos lists a malformed key: ${k.slice(0, 80)}`);
    if (!keys.includes(k)) keys.push(k);
  }
  const gb = Number(readFileSync(join(dir, "maxGbPerNode"), "utf8").trim());
  if (!Number.isFinite(gb) || gb <= 0) throw new Error("warm-assign: maxGbPerNode must be a positive number");
  return { keys, maxBytes: Math.floor(gb * 1024 ** 3) };
}

type Held = { gen: string; meta: GenMeta };
const gb = (n: number) => (n / 1024 ** 3).toFixed(2);

const PROGRESS_LOG_MS = 60_000;

type Progress = { stats: ApplyStats | undefined; written: number; end: (error: string | null) => void };

export class SyncAgent {
  private readonly c: Required<Omit<SyncConfig, "kube">> & Pick<SyncConfig, "kube">;
  private readonly pacer: Pacer;
  private readonly failed = new Map<string, { sha256: string; at: number; why: string }>();
  private pending: Record<string, string> = {};
  private readonly badBlobs = new Map<string, Set<string>>();
  private written: { sig: string; at: number } | null = null;
  private assignError: string | undefined;
  private writing: Promise<void> = Promise.resolve();
  private diskCheckedAt = 0;

  constructor(c: SyncConfig) {
    if (!NODE_NAME.test(c.node)) throw new Error(`warm sync: node name refused: ${c.node.slice(0, 80)}`);
    this.c = {
      writeBytesPerSec: 150e6, graceMs: DEFAULT_GRACE_MS, maxFsPct: 80, statusEveryMs: 5 * 60_000, progressEveryMs: 15_000, retryMs: 10 * 60_000, concurrency: 8,
      now: Date.now, diskUse: statfsUse, ...c,
    };
    this.pacer = new Pacer(this.c.writeBytesPerSec);
  }

  /** Polls every `pollMs` until `signal` aborts. */
  async run(signal: AbortSignal, pollMs = 60_000): Promise<void> {
    // A sync can take longer than the runner's staleness limit, so the status is rewritten from a timer, not between syncs.
    const beat = setInterval(() => void this.report(true), this.c.statusEveryMs);
    beat.unref();
    try {
      while (!signal.aborted) {
        try {
          await this.cycle();
        } catch (e) {
          this.c.log(`warm sync: ${(e as Error).stack ?? e}`);
        }
        await sleep(pollMs, undefined, { signal }).catch(() => {});
      }
    } finally {
      clearInterval(beat);
    }
  }

  /** One pass: read the assignment and every key's latest.json, retire what does not fit, sync, clean up, report. */
  async cycle(): Promise<void> {
    const { dir, log } = this.c;
    mkdirSync(dir, { recursive: true });
    this.removeLeftovers();
    this.fixModes();
    let assign: Assign;
    try {
      assign = this.c.assign();
    } catch (e) {
      // Holding on to what is there beats dropping every key over a mount that cannot be read.
      this.assignError = `assignment unreadable: ${(e as Error).message}`.slice(0, 200);
      log(`warm sync: ${(e as Error).message}; nothing changes this cycle`);
      this.cleanup();
      return await this.report();
    }
    this.assignError = undefined;
    const pending: Record<string, string> = {};
    let keys: KeyObject[] = [];
    try {
      keys = this.c.verifyKeys();
    } catch (e) {
      for (const k of assign.keys) pending[k] = `verify keys: ${(e as Error).message}`.slice(0, 200);
    }
    const latest = new Map<string, Latest>();
    if (keys.length) {
      for (const k of assign.keys) {
        try {
          const l = await this.c.store.latest(k, keys);
          const h = this.held(k);
          if (h) this.raiseFloor(k, h.meta.stored);
          if (!l) pending[k] = "the store has no version";
          // A validly signed but older latest.json is a replay or a rollback of the store: keep the newer version.
          else if (h && l.stored < h.meta.stored) pending[k] = `latest.json names ${l.commit.slice(0, 12)}, older than the version held (${h.meta.commit.slice(0, 12)})`;
          else if (l.stored < this.floor(k)) pending[k] = `latest.json names ${l.commit.slice(0, 12)}, older than the newest version accepted before`;
          else latest.set(k, l);
        } catch (e) {
          pending[k] = `store: ${(e as Error).message}`.slice(0, 200);
        }
      }
    }

    // Keys in priority order; a key that does not fit under the cap after the keys above it is left out. A key counts
    // with the bytes of the version it holds until its newer version is current, so lower keys stay until then.
    const fit = new Set<string>();
    let planned = 0;
    for (const k of assign.keys) {
      const h = this.held(k);
      const l = latest.get(k);
      const bytes = h && l && !(h.meta.commit === l.commit && h.meta.manifestSha256 === l.sha256) ? h.meta.bytes : (l?.bytes ?? h?.meta.bytes);
      if (bytes === undefined) continue;
      if (planned + bytes > assign.maxBytes) {
        pending[k] = `over the node cap (${gb(planned + bytes)} of ${gb(assign.maxBytes)} GiB)`;
        continue;
      }
      planned += bytes;
      fit.add(k);
    }
    for (const k of this.keyDirs()) if (!fit.has(k) && this.held(k)) this.retire(k, assign.keys.includes(k) ? "over the node cap" : "no longer assigned");

    this.pending = pending;
    for (const k of assign.keys) {
      const l = latest.get(k);
      if (!fit.has(k) || !l) continue;
      const h = this.held(k);
      if (h && h.meta.commit === l.commit && h.meta.manifestSha256 === l.sha256) continue;
      const why = await this.sync(k, l, h, assign.maxBytes);
      if (why) pending[k] = why;
      else delete pending[k];
      this.pending = pending;
      await this.report();
    }
    this.cleanup();
    await this.report();
  }

  // ---- disk ------------------------------------------------------------------------------------------------------

  private keyDirs(): string[] {
    return readdirSync(this.c.dir).filter((n) => WARM_KEY.test(n) && n !== "blobs" && lstatSync(join(this.c.dir, n)).isDirectory());
  }

  /** The version `current` names, or null when there is none or its meta.json cannot be read. */
  held(key: string): Held | null {
    try {
      const gen = readlinkSync(join(this.c.dir, key, "current"));
      if (!GEN.test(gen)) return null;
      const meta = JSON.parse(readFileSync(join(this.c.dir, key, gen, "meta.json"), "utf8")) as GenMeta;
      return meta.key === key && typeof meta.commit === "string" ? { gen, meta } : null;
    } catch {
      return null;
    }
  }

  /**
   * The highest `stored` of any version accepted for `key`, kept in `<dir>/<key>.floor` so it survives a retire and the
   * deletion of the key dir. A latest.json below it is refused. An operator resets it by deleting the file.
   */
  private floor(key: string): number {
    try {
      const n = Number(readFileSync(join(this.c.dir, `${key}.floor`), "utf8").trim());
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }

  private raiseFloor(key: string, stored: number): void {
    if (stored <= this.floor(key)) return;
    const f = join(this.c.dir, `${key}.floor`);
    writeFileSync(`${f}.tmp`, `${stored}\n`, { mode: 0o644 });
    renameSync(`${f}.tmp`, f);
  }

  /**
   * Versions built before modes were normalized may hold files other uids cannot read or that group and others can
   * write. Adds the read bits (search for directories) and clears group/other write on every entry of a version that
   * has no MODES_MARK yet, then writes the mark. Nothing is deleted here: a file another uid or gid owns is only
   * refused as a link source, so the next version fetches it. Hard links make this
   * fix older versions that share an inode too. A failure leaves no mark, so the next cycle retries.
   */
  private fixModes(): void {
    for (const k of this.keyDirs()) {
      for (const n of readdirSync(join(this.c.dir, k))) {
        const gen = join(this.c.dir, k, n);
        if (!GEN.test(n) || existsSync(join(gen, MODES_MARK))) continue;
        try {
          const fixed = addReadBits(gen);
          writeFileSync(join(gen, MODES_MARK), "", { mode: 0o644 });
          if (fixed) this.c.log(`warm sync: ${k}/${n}: made ${fixed} entries readable to all`);
        } catch (e) {
          this.c.log(`warm sync: ${k}/${n}: making files readable failed: ${(e as Error).message}`.slice(0, 300));
        }
      }
    }
  }

  /** Builds dirs of an interrupted sync and a half-made `current` link. */
  private removeLeftovers(): void {
    for (const k of this.keyDirs()) {
      for (const n of readdirSync(join(this.c.dir, k))) {
        if (n.endsWith(".tmp")) removeTree(join(this.c.dir, k, n));
      }
    }
    for (const n of readdirSync(this.c.dir)) if (n.endsWith(".floor.tmp")) rmSync(join(this.c.dir, n), { force: true });
  }

  /** Marks a version as no longer current: its dir mtime starts the grace period. */
  private touch(path: string): void {
    const t = this.c.now() / 1000;
    try {
      utimesSync(path, t, t);
    } catch { /* gone already */ }
  }

  private retire(key: string, why: string): void {
    const h = this.held(key);
    unlinkSync(join(this.c.dir, key, "current"));
    if (h) {
      this.touch(join(this.c.dir, key, h.gen));
      this.c.log(`warm sync: ${key}@${h.meta.commit.slice(0, 12)} is no longer current: ${why}`);
    }
  }

  /** Deletes versions that stopped being current more than `graceMs` ago, and key dirs left empty. */
  private cleanup(): void {
    const now = this.c.now();
    for (const k of this.keyDirs()) {
      const kd = join(this.c.dir, k);
      const cur = this.held(k)?.gen;
      for (const n of readdirSync(kd)) {
        if (!GEN.test(n) || n === cur) continue;
        const p = join(kd, n);
        if (now - lstatSync(p).mtimeMs < this.c.graceMs) continue;
        removeTree(p);
        this.c.log(`warm sync: deleted ${k}/${n}`);
      }
      // A `current` that names no readable version is no use to consumers.
      if (cur === undefined && lstatSync(join(kd, "current"), { throwIfNoEntry: false })) unlinkSync(join(kd, "current"));
      if (!readdirSync(kd).length) removeTree(kd);
    }
  }

  private fsUse(): NodeStatus["fs"] {
    const d = this.c.diskUse(this.c.dir);
    return { sizeBytes: d.sizeBytes, usedBytes: d.usedBytes, usedPct: usedPct(d) };
  }

  // ---- sync ------------------------------------------------------------------------------------------------------

  /** Makes `l` the key's current version; returns why not, or null when it is. */
  private async sync(key: string, l: Latest, h: Held | null, maxBytes: number): Promise<string | null> {
    const { dir, log } = this.c;
    const kd = join(dir, key);
    mkdirSync(kd, { recursive: true, mode: 0o755 });
    const base = `gen-${l.commit.slice(0, 12)}`;
    // A retired version of the same commit and manifest comes back without a download.
    const back = existsSync(join(kd, base)) && base !== h?.gen ? this.metaOf(join(kd, base)) : null;
    if (back && back.commit === l.commit && back.manifestSha256 === l.sha256) {
      this.swap(key, base, h);
      log(`warm sync: ${key}@${l.commit.slice(0, 12)} is current again`);
      return null;
    }
    // Retired versions stay on disk for the grace period, so they count: the new version waits until they expire.
    // The held version of this key moves into grace after the swap, so it is not counted twice.
    const wb = this.warmBytes();
    const others = wb.current - (h ? this.metaOf(join(kd, h.gen))?.bytes ?? 0 : 0);
    if (others + wb.grace + l.bytes > maxBytes) {
      const why = wb.grace > 0 ? "waiting for retired versions to expire" : "over the node cap";
      return `${why}: ${gb(l.bytes)} GiB more on top of ${gb(others)} GiB current (other keys) and ${gb(wb.grace)} GiB in grace would pass the node cap of ${gb(maxBytes)} GiB`;
    }
    const fs = this.fsUse();
    if (fs.usedPct >= this.c.maxFsPct) return `node disk ${fs.usedPct} % full (new versions wait below ${this.c.maxFsPct} %)`;
    // The version's whole size is the bound: files that turn out to be hard links from the held version cost nothing.
    const d = this.c.diskUse(dir);
    const after = Math.round(((d.usedBytes + l.bytes) / Math.max(1, d.usedBytes + d.availBytes)) * 1000) / 10;
    if (after >= this.c.maxFsPct) return `not enough disk: ${gb(l.bytes)} GiB would take the node to ${after} % (limit ${this.c.maxFsPct} %)`;
    const f = this.failed.get(key);
    if (f && f.sha256 === l.sha256 && this.c.now() - f.at < this.c.retryMs) return f.why;

    // A name that is free on disk: a version of the same commit may still be in its grace period.
    let gen = base;
    for (let i = 2; existsSync(join(kd, gen)) || gen === h?.gen; i++) gen = `${base}-${i}`;
    const final = join(kd, gen), tmp = `${final}.tmp`;
    const t0 = performance.now();
    let progress: Progress | undefined;
    try {
      const { manifest, raw } = await this.c.store.manifestWithBytes(l);
      progress = this.startProgress(key, l, manifest.header.bytes, manifest.header.files, t0);
      const previous = h ? this.previousOf(join(kd, h.gen)) : undefined;
      removeTree(tmp);
      mkdirSync(tmp, { mode: 0o755 });
      const roots = { target: join(tmp, "target"), cargo: join(tmp, "cargo") };
      const s = await applyManifest(manifest, roots, this.c.store.blobs(), {
        previous, concurrency: this.c.concurrency, onStats: (st) => { progress!.stats = st; },
        pace: async (n) => { await this.pacer.take(n); progress!.written += n; this.checkDisk(); },
      });
      // Consumers run as another uid: the roots applyManifest made must be readable to them.
      for (const p of [tmp, roots.target, roots.cargo]) chmodSync(p, 0o755);
      const hd = manifest.header;
      const meta: GenMeta = {
        key, repo: hd.repo, commit: hd.commit, stored: hd.stored, bytes: hd.bytes, files: hd.files, image: hd.image, rustc: hd.rustc, toolchain: hd.toolchain ?? null,
        envHash: hd.envHash, checkout: hd.checkout, targetDir: hd.targetDir, cargoHome: hd.cargoHome, cargoLock: hd.cargoLock ?? null, manifestSha256: l.sha256, synced: this.c.now(),
      };
      writeFileSync(join(tmp, "manifest.zst"), raw, { mode: 0o644 });
      writeFileSync(join(tmp, "meta.json"), `${JSON.stringify(meta)}\n`, { mode: 0o644 });
      writeFileSync(join(tmp, "latest.json"), `${JSON.stringify(l)}\n`, { mode: 0o644 });
      writeFileSync(join(tmp, MODES_MARK), "", { mode: 0o644 });
      renameSync(tmp, final);
      this.swap(key, gen, h);
      this.failed.delete(key);
      this.badBlobs.delete(key);
      progress.end(null);
      log(`warm sync: ${key}@${l.commit.slice(0, 12)} current: ${s.files} files (${gb(s.bytes)} GiB), ${s.linked} linked from the previous version, ${s.fetched} fetched (${gb(s.fetchedBytes)} GiB), ${s.copied} copied, in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      return null;
    } catch (e) {
      progress?.end(`failed: ${(e as Error).message}`.slice(0, 200));
      removeTree(tmp);
      if (e instanceof BadBlobError) {
        const bad = this.badBlobs.get(key) ?? new Set<string>();
        if (bad.size < MAX_BAD_BLOBS) bad.add(e.sha256);
        this.badBlobs.set(key, bad);
      }
      const why = `sync of ${l.commit.slice(0, 12)} failed: ${(e as Error).message}`.slice(0, 200);
      this.failed.set(key, { sha256: l.sha256, at: this.c.now(), why });
      log(`warm sync: ${key}: ${why}`);
      return why;
    }
  }

  /**
   * While a version downloads: `pending[key]` carries the progress (rewritten to the status ConfigMap every
   * PROGRESS_STATUS_MS) and the log gets a start line, a line a minute, and an end line.
   */
  private startProgress(key: string, l: Latest, totalBytes: number, totalFiles: number, t0: number): Progress {
    const commit = l.commit.slice(0, 12), now = () => performance.now();
    const p: Progress = {
      stats: undefined, written: 0,
      end: (err) => {
        clearInterval(timer);
        this.c.log(`warm sync: ${key}@${commit} download ${err ?? "ok"} after ${((now() - t0) / 1000).toFixed(1)} s`);
      },
    };
    const amount = () => `${gb(p.stats?.bytes ?? 0)} of ${gb(totalBytes)} GiB`;
    const reason = () => `downloading ${commit}: ${amount()}`;
    let logged = { at: now(), written: 0 };
    this.c.log(`warm sync: ${key}@${commit} download starts: ${gb(totalBytes)} GiB in ${totalFiles} files`);
    this.pending[key] = reason();
    void this.report();
    const timer = setInterval(() => {
      this.pending[key] = reason();
      void this.report();
      const t = now();
      if (t - logged.at >= PROGRESS_LOG_MS) {
        this.c.log(`warm sync: ${key}@${commit} ${amount()}, ${p.stats?.files ?? 0} of ${totalFiles} files, ${(((p.written - logged.written) / (t - logged.at)) / 1000).toFixed(1)} MB/s`);
        logged = { at: t, written: p.written };
      }
    }, this.c.progressEveryMs);
    timer.unref();
    return p;
  }

  /** Aborts a running download once the node's disk use reaches the limit (looked at most once a second). */
  private checkDisk(): void {
    const t = performance.now();
    if (t - this.diskCheckedAt < 1000) return;
    this.diskCheckedAt = t;
    const u = this.fsUse();
    if (u.usedPct >= this.c.maxFsPct) throw new Error(`node disk ${u.usedPct} % full during the download (limit ${this.c.maxFsPct} %)`);
  }

  private metaOf(genDir: string): GenMeta | null {
    try {
      return JSON.parse(readFileSync(join(genDir, "meta.json"), "utf8")) as GenMeta;
    } catch {
      return null;
    }
  }

  /** Bytes of the versions `current` names, and of retired versions whose grace period has not ended. */
  private warmBytes(): { current: number; grace: number } {
    const now = this.c.now();
    let current = 0, grace = 0;
    for (const k of this.keyDirs()) {
      const kd = join(this.c.dir, k);
      const cur = this.held(k)?.gen;
      for (const n of readdirSync(kd)) {
        if (!GEN.test(n)) continue;
        const bytes = this.metaOf(join(kd, n))?.bytes ?? 0;
        if (n === cur) current += bytes;
        else if (now - lstatSync(join(kd, n)).mtimeMs < this.c.graceMs) grace += bytes;
      }
    }
    return { current, grace };
  }

  /** The current version as hard-link source; none when its manifest cannot be read (everything is fetched then). */
  private previousOf(genDir: string): Previous | undefined {
    try {
      const manifest: Manifest = decodeManifest(readFileSync(join(genDir, "manifest.zst")));
      return { manifest, roots: { target: join(genDir, "target"), cargo: join(genDir, "cargo") } };
    } catch (e) {
      this.c.log(`warm sync: ${genDir}: the previous manifest cannot be read (${(e as Error).message}); fetching every file`);
      return undefined;
    }
  }

  /** Points `current` at `gen` with one rename; the version it named before starts its grace period. */
  private swap(key: string, gen: string, h: Held | null): void {
    const kd = join(this.c.dir, key);
    const link = join(kd, "current.tmp");
    rmSync(link, { force: true });
    symlinkSync(gen, link);
    renameSync(link, join(kd, "current"));
    if (h && h.gen !== gen) this.touch(join(kd, h.gen));
    const stored = this.metaOf(join(kd, gen))?.stored;
    if (stored !== undefined) this.raiseFloor(key, stored);
  }

  // ---- status ----------------------------------------------------------------------------------------------------

  status(): NodeStatus {
    const keys: Record<string, KeyStatus> = {};
    for (const k of this.keyDirs()) {
      const h = this.held(k);
      if (h) keys[k] = { commit: h.meta.commit, stored: h.meta.stored, bytes: h.meta.bytes, image: h.meta.image, rustc: h.meta.rustc ?? null, toolchain: h.meta.toolchain ?? null, envHash: h.meta.envHash, synced: h.meta.synced, cargoLock: h.meta.cargoLock ?? null };
    }
    const badBlobs = Object.fromEntries([...this.badBlobs].map(([k, v]) => [k, [...v].sort()]));
    return { version: 1, node: this.c.node, updated: this.c.now(), fs: this.fsUse(), warmBytes: this.warmBytes(), keys, pending: this.pending, badBlobs, ...(this.assignError ? { error: this.assignError } : {}) };
  }

  /** Writes the status ConfigMap when what it says changed, and every `statusEveryMs` so readers see the node is alive. */
  report(force = false): Promise<void> {
    // One write at a time: the heartbeat timer and the sync loop both call this.
    const run = this.writing.then(() => this.write(force));
    this.writing = run.catch(() => {});
    return run;
  }

  private async write(force: boolean): Promise<void> {
    if (!this.c.kube) return;
    const st = this.status();
    const sig = JSON.stringify({ keys: st.keys, pending: st.pending, badBlobs: st.badBlobs, error: st.error, full: st.fs.usedPct >= this.c.maxFsPct });
    if (!force && this.written && this.written.sig === sig && this.c.now() - this.written.at < this.c.statusEveryMs) return;
    const name = `${STATUS_PREFIX}${this.c.node}`;
    const data = { [STATUS_DATA_KEY]: JSON.stringify(st) };
    try {
      try {
        await this.c.kube.patchConfigMap(this.c.namespace, name, { metadata: { labels: { [STATUS_LABEL]: "node" } }, data });
      } catch (e) {
        if (!(e instanceof KubeError && e.status === 404)) throw e;
        await this.c.kube.createConfigMap(this.c.namespace, {
          apiVersion: "v1", kind: "ConfigMap", metadata: { name, namespace: this.c.namespace, labels: { [STATUS_LABEL]: "node" } }, data,
        });
      }
      this.written = { sig, at: this.c.now() };
    } catch (e) {
      this.c.log(`warm sync: writing ${name}: ${(e as Error).message}`);
    }
  }
}

/** Adds read bits to files and read+search bits to directories under `dir`, and clears group/other write (not following links); returns how many changed. */
export function addReadBits(dir: string): number {
  let n = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) continue;
      const st = lstatSync(p), mode = st.mode & 0o777;
      if (e.isDirectory()) {
        if ((mode & 0o555) !== 0o555 || mode & 0o022) { chmodSync(p, (mode | 0o555) & ~0o022); n++; }
        walk(p);
      } else if (e.isFile() && ((mode & 0o444) !== 0o444 || mode & 0o022)) {
        chmodSync(p, (mode | 0o444) & ~0o022);
        n++;
      }
    }
  };
  walk(dir);
  return n;
}
