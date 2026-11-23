// Client for the warm store on the shared WebDAV cache. Layout under `warm/v1/` of the server root:
//   blobs/<aa>/<sha256>.zst            file contents, content-addressed (aa = first two hex digits)
//   <key>/<commit>.manifest.zst        one manifest per published commit (src/warm/manifest.ts)
//   <key>/latest.json                  the newest manifest, signed
// Reads go to the read-only base URL (no credentials); writes, and the reads of a publish or gc, to the read-write one.
import { createHash, randomBytes, type KeyObject } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline, Readable, Transform } from "node:stream";
import { pipeline as pipelineAsync } from "node:stream/promises";
import { constants as zc, createZstdCompress, createZstdDecompress } from "node:zlib";
import { WARM_KEY } from "../worker/warm.ts";
import {
  applyManifest, decodeManifest, encodeManifest, makeHeader, mapLimit, ManifestError, parseLatest, signLatest, verifyLatest, walkTree,
  type ApplyStats, type BlobSource, type Latest, type Manifest, type Previous, type Roots, type WalkSource,
} from "./manifest.ts";

export const WARM_ROOT = "warm/v1";

export class StoreError extends Error {
  /** "missing": the path does not exist; "oversize": the body is larger than allowed. Both mean the stored copy is bad. */
  readonly kind: "missing" | "oversize" | undefined;
  constructor(msg: string, kind?: "missing" | "oversize") {
    super(msg);
    this.kind = kind;
  }
}

export type DavAuth = { user: string; password: string };
export type DavItem = { name: string; collection: boolean; size: number | null; modified: number | null };
type DavOptions = { timeoutMs: number; transferTimeoutMs: number; fetchImpl: typeof fetch };

/** The WebDAV verbs the store uses, against one base URL. Paths are relative to the base and `/`-separated. */
export class WebDav {
  private readonly base: string;
  private readonly made = new Set<string>();
  private readonly auth: DavAuth | undefined;
  private readonly o: DavOptions;
  constructor(base: string, auth: DavAuth | undefined, o: DavOptions) {
    this.base = base.replace(/\/+$/, "");
    this.auth = auth;
    this.o = o;
  }

  url(path: string): string {
    return `${this.base}/${path.split("/").map((s) => (s ? encodeURIComponent(s) : s)).join("/")}`;
  }

  private async req(method: string, path: string, init: { body?: BodyInit | null; headers?: Record<string, string>; transfer?: boolean } = {}): Promise<Response> {
    const headers: Record<string, string> = { ...init.headers };
    if (this.auth) headers.authorization = `Basic ${Buffer.from(`${this.auth.user}:${this.auth.password}`).toString("base64")}`;
    const signal = AbortSignal.timeout(init.transfer ? this.o.transferTimeoutMs : this.o.timeoutMs);
    try {
      return await this.o.fetchImpl(this.url(path), { method, headers, body: init.body, redirect: "error", signal, ...(init.body && !(init.body instanceof Uint8Array) ? { duplex: "half" } : {}) } as RequestInit);
    } catch (e) {
      throw new StoreError(`${method} ${path}: ${signal.aborted ? "timed out" : (e as Error).message}`);
    }
  }

  /** null when the path does not exist. */
  async head(path: string): Promise<{ size: number | null; modified: number | null } | null> {
    const r = await this.req("HEAD", path);
    if (r.status === 404) return null;
    if (!r.ok) throw new StoreError(`HEAD ${path} answered ${r.status}`);
    const len = r.headers.get("content-length");
    const mod = r.headers.get("last-modified");
    return { size: len === null ? null : Number(len), modified: mod ? Date.parse(mod) : null };
  }

  /** Whole body, at most `max` bytes; null when the path does not exist. `transfer` applies the transfer timeout. */
  async get(path: string, max: number, transfer = false): Promise<Buffer | null> {
    const r = await this.req("GET", path, { transfer });
    if (r.status === 404) return null;
    if (!r.ok || !r.body) throw new StoreError(`GET ${path} answered ${r.status}`);
    return readCapped(r, max, `GET ${path}`);
  }

  /** The body as a stream that fails past `max` bytes; throws when the path does not exist. */
  async stream(path: string, max: number): Promise<AsyncIterable<Uint8Array>> {
    const r = await this.req("GET", path, { transfer: true });
    if (!r.ok || !r.body) throw new StoreError(`GET ${path} answered ${r.status}`, r.status === 404 ? "missing" : undefined);
    let n = 0;
    const cap = new Transform({ transform(chunk: Buffer, _e, cb) { n += chunk.length; cb(n > max ? new StoreError(`GET ${path}: larger than ${max} bytes`, "oversize") : null, chunk); } });
    // pipeline passes a failure of the body (a dropped connection, the timeout) on to the returned stream.
    return pipeline(Readable.fromWeb(r.body as never), cap, () => {});
  }

  /** Creates the parent collections first (MKCOL; an existing one answers 405). */
  async put(path: string, body: Uint8Array | AsyncIterable<Uint8Array>, contentType: string): Promise<void> {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) await this.mkcol(parts.slice(0, i).join("/"));
    const streamed = !(body instanceof Uint8Array);
    const r = await this.req("PUT", path, { body: streamed ? (Readable.toWeb(Readable.from(body)) as never) : (body as BodyInit), headers: { "content-type": contentType }, transfer: streamed });
    if (!r.ok) throw new StoreError(`PUT ${path} answered ${r.status}`);
    await r.body?.cancel();
  }

  async mkcol(path: string): Promise<void> {
    if (this.made.has(path)) return;
    const r = await this.req("MKCOL", `${path}/`);
    await r.body?.cancel();
    if (!r.ok && r.status !== 405) throw new StoreError(`MKCOL ${path} answered ${r.status}`);
    this.made.add(path);
  }

  /**
   * Renames `from` to `to`. Without `overwrite` an existing `to` stays and the answer is false (412); true when moved.
   */
  async move(from: string, to: string, overwrite: boolean): Promise<boolean> {
    const r = await this.req("MOVE", from, { headers: { destination: this.url(to), overwrite: overwrite ? "T" : "F" } });
    await r.body?.cancel();
    if (r.status === 412) return false;
    if (!r.ok) throw new StoreError(`MOVE ${from} answered ${r.status}`);
    return true;
  }

  /** true when something was deleted. */
  async delete(path: string): Promise<boolean> {
    const r = await this.req("DELETE", path);
    await r.body?.cancel();
    if (r.status === 404) return false;
    if (!r.ok) throw new StoreError(`DELETE ${path} answered ${r.status}`);
    return true;
  }

  /** The members of a collection (Depth 1, without the collection itself); null when it does not exist. */
  async propfind(path: string): Promise<DavItem[] | null> {
    const dir = path.replace(/\/*$/, "/");
    const body = `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:getcontentlength/><D:getlastmodified/></D:prop></D:propfind>`;
    const r = await this.req("PROPFIND", dir, { body: Buffer.from(body), headers: { depth: "1", "content-type": "application/xml" } });
    if (r.status === 404) return null;
    if (r.status !== 207) throw new StoreError(`PROPFIND ${path} answered ${r.status}`);
    return parseMultistatus((await readCapped(r, PROPFIND_MAX, `PROPFIND ${path}`)).toString("utf8"), new URL(this.url(dir)).pathname);
  }
}

/** A listing this large means something is wrong with the store; 16 MiB holds about 50,000 entries. */
const PROPFIND_MAX = 16 * 1024 ** 2;

async function readCapped(r: Response, max: number, what: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const chunk of (r.body ?? []) as AsyncIterable<Uint8Array>) {
    n += chunk.length;
    if (n > max) throw new StoreError(`${what}: larger than ${max} bytes`);
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

const tag = (name: string) => `<(?:[A-Za-z][\\w.-]*:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z][\\w.-]*:)?${name}>`;
const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d))).replace(/&amp;/g, "&");

/** Reads a Depth-1 PROPFIND answer; `self` is the requested collection's path, left out of the result. */
export function parseMultistatus(xml: string, self: string): DavItem[] {
  const out: DavItem[] = [];
  const norm = (p: string) => p.replace(/\/+$/, "");
  for (const m of xml.matchAll(new RegExp(tag("response"), "g"))) {
    const href = new RegExp(tag("href")).exec(m[1])?.[1];
    if (!href) continue;
    let path: string;
    try {
      path = decodeURIComponent(new URL(unescape(href.trim()), "http://x").pathname);
    } catch {
      continue;
    }
    if (norm(path) === norm(decodeURIComponent(self))) continue;
    const len = new RegExp(tag("getcontentlength")).exec(m[1])?.[1];
    const mod = new RegExp(tag("getlastmodified")).exec(m[1])?.[1];
    const type = new RegExp(tag("resourcetype")).exec(m[1])?.[1] ?? "";
    out.push({
      name: norm(path).split("/").at(-1) ?? "",
      collection: /<(?:[A-Za-z][\w.-]*:)?collection\b/.test(type),
      size: len === undefined || len.trim() === "" ? null : Number(len.trim()),
      modified: mod ? Date.parse(mod.trim()) || null : null,
    });
  }
  return out;
}

export type StoreConfig = {
  /** WebDAV server root for reads, e.g. the cache's anonymous read-only port. */
  readUrl: string;
  /** WebDAV server root for writes; publish and gc need it. */
  writeUrl?: string;
  auth?: DavAuth;
  timeoutMs?: number;
  /** Per blob or manifest transfer. */
  transferTimeoutMs?: number;
  concurrency?: number;
  fetchImpl?: typeof fetch;
};

export type PublishInput = {
  key: string; repo: string; commit: string;
  image: string | null; rustc: string | null; envHash: string | null; checkout: string | null;
  /** The toolchain image's toolchain key (src/warm/toolchain.ts). */
  toolchain?: string | null;
  /** sha256 of the built checkout's Cargo.lock: consumers that need the same lock compare it. */
  cargoLock?: string | null;
  /** The target holds only units the build at `commit` read (ManifestHeader.trimmed). */
  trimmed?: boolean;
  source: WalkSource; exclude?: string[]; omit?: ReadonlySet<string>; signKey: KeyObject; stored?: number; log?: (s: string) => void;
  /**
   * Blobs a restore found bad (its badBlobs): each is fetched and hashed, and re-uploaded from this tree when wrong,
   * or deleted when this tree does not hold it.
   */
  recheck?: string[];
  /** gc's minimum blob age: a stored blob older than half of it is uploaded again, so a running gc cannot take it. */
  minBlobAgeMs?: number;
};
export type PublishStats = { files: number; bytes: number; blobs: number; uploaded: number; uploadedBytes: number; manifestBytes: number; repaired: number; latest: Latest };
export type RestoreResult = { latest: Latest; manifest: Manifest; stats: ApplyStats };
export type GcOptions = { verifyKeys: KeyObject[]; keep?: number; minBlobAgeMs?: number; capBytes?: number; now?: number; log?: (s: string) => void };
export type GcStats = { keys: number; manifestsKept: number; manifestsDeleted: number; blobsKept: number; blobsDeleted: number; bytesKept: number; bytesDeleted: number; overCap: boolean };

const MANIFEST_NAME = /^([0-9a-f]{7,64})\.manifest\.zst$/;
const BLOB_NAME = /^([0-9a-f]{64})\.zst$/;
const TEMP_NAME = /^[0-9a-f]{64}\.zst\.tmp-[0-9a-f]{16}$/;
const DAY = 24 * 3600_000;
/** zstd frames add a little to incompressible data. */
const blobCap = (size: number) => size + Math.ceil(size / 64) + 65_536;

export class WarmStore {
  readonly read: WebDav;
  readonly write?: WebDav;
  private readonly concurrency: number;

  constructor(c: StoreConfig) {
    const o: DavOptions = { timeoutMs: c.timeoutMs ?? 30_000, transferTimeoutMs: c.transferTimeoutMs ?? 600_000, fetchImpl: c.fetchImpl ?? fetch };
    this.read = new WebDav(c.readUrl, undefined, o);
    if (c.writeUrl) this.write = new WebDav(c.writeUrl, c.auth, o);
    this.concurrency = c.concurrency ?? 8;
  }

  static blobPath = (sha: string) => `${WARM_ROOT}/blobs/${sha.slice(0, 2)}/${sha}.zst`;
  static manifestPath = (key: string, commit: string) => `${WARM_ROOT}/${checkKey(key)}/${commit}.manifest.zst`;
  static latestPath = (key: string) => `${WARM_ROOT}/${checkKey(key)}/latest.json`;

  private rw(): WebDav {
    if (!this.write) throw new StoreError("the warm store has no write URL");
    return this.write;
  }

  /** The verified latest.json of `key`; null when the key has none. Throws when it is malformed or not signed by `keys`. */
  async latest(key: string, keys: KeyObject[], dav: WebDav = this.read): Promise<Latest | null> {
    const buf = await dav.get(WarmStore.latestPath(key), 64 * 1024);
    if (!buf) return null;
    const l = parseLatest(key, buf.toString("utf8"));
    if (!l) throw new StoreError(`latest.json of ${key} is malformed`);
    if (!verifyLatest(l, keys)) throw new StoreError(`latest.json of ${key} is unsigned or its signature is wrong`);
    return l;
  }

  /** The manifest latest.json names, checked against its sha256, key and commit. */
  async manifest(l: Latest, dav: WebDav = this.read): Promise<Manifest> {
    return (await this.manifestWithBytes(l, dav)).manifest;
  }

  /** Like `manifest`, with the verified bytes as stored, for copies that must keep the sha256 latest.json names. */
  async manifestWithBytes(l: Latest, dav: WebDav = this.read): Promise<{ manifest: Manifest; raw: Buffer }> {
    const buf = await dav.get(WarmStore.manifestPath(l.key, l.commit), l.size, true);
    if (!buf) throw new StoreError(`manifest ${l.key}/${l.commit.slice(0, 12)} is missing`);
    if (buf.length !== l.size || createHash("sha256").update(buf).digest("hex") !== l.sha256) throw new StoreError(`manifest ${l.key}/${l.commit.slice(0, 12)} does not match latest.json`);
    const m = decodeManifest(buf);
    if (m.header.key !== l.key || m.header.commit !== l.commit || m.header.bytes !== l.bytes) throw new StoreError(`manifest ${l.key}/${l.commit.slice(0, 12)} is for another version`);
    return { manifest: m, raw: buf };
  }

  blobs(dav: WebDav = this.read): BlobSource {
    return (sha, size) => dav.stream(WarmStore.blobPath(sha), blobCap(size));
  }

  /**
   * Restores the newest version of `key` into `roots` (missing or empty dirs), hard-linking what `previous` already
   * holds. null when the key has no version. Throws on a bad signature, a bad blob or a refused entry.
   */
  async restore(key: string, roots: Partial<Roots>, keys: KeyObject[], previous?: Previous): Promise<RestoreResult | null> {
    const latest = await this.latest(key, keys);
    if (!latest) return null;
    const manifest = await this.manifest(latest);
    const stats = await applyManifest(manifest, roots, this.blobs(), { previous, concurrency: this.concurrency });
    return { latest, manifest, stats };
  }

  /** Walks the tree, uploads the blobs the store lacks, then the manifest, then the signed latest.json. */
  async publish(p: PublishInput): Promise<PublishStats> {
    const dav = this.rw();
    const entries = await walkTree(p.source, { exclude: p.exclude, omit: p.omit, concurrency: this.concurrency, log: p.log });
    const header = makeHeader({ key: checkKey(p.key), repo: p.repo, commit: p.commit, stored: p.stored ?? Date.now(), image: p.image, rustc: p.rustc, toolchain: p.toolchain ?? null, envHash: p.envHash, checkout: p.checkout, cargoLock: p.cargoLock ?? null, trimmed: p.trimmed === true, targetDir: p.source.target, cargoHome: p.source.cargoHome }, entries);
    const manifest = encodeManifest({ header, entries });
    const firstPath = new Map<string, string>();
    const abs = (path: string) => (path.startsWith("target/") ? `${p.source.target}/${path.slice(7)}` : `${p.source.cargoHome}/${path.slice(6)}`);
    for (const e of entries) if (e.type === "file" && !firstPath.has(e.sha256)) firstPath.set(e.sha256, abs(e.path));
    let uploaded = 0, uploadedBytes = 0, repaired = 0;
    const recheck = new Set(p.recheck ?? []);
    for (const sha of recheck) {
      if (await this.blobIntact(dav, sha)) continue;
      const file = firstPath.get(sha);
      if (file) {
        uploadedBytes += await this.uploadBlob(dav, sha, file, true);
        uploaded++;
      } else await dav.delete(WarmStore.blobPath(sha));
      repaired++;
      p.log?.(`warm store: blob ${sha.slice(0, 12)} was bad, ${file ? "uploaded again" : "deleted"}`);
    }
    const stale = Date.now() - (p.minBlobAgeMs ?? DAY) / 2;
    await mapLimit([...firstPath].filter(([sha]) => !recheck.has(sha)), this.concurrency, async ([sha, file]) => {
      const st = await dav.head(WarmStore.blobPath(sha));
      if (st && st.modified !== null && st.modified >= stale) return;
      const n = await this.uploadBlob(dav, sha, file, st !== null);
      uploadedBytes += n;
      uploaded++;
    });
    await dav.put(WarmStore.manifestPath(p.key, p.commit), manifest, "application/zstd");
    const latest = signLatest(p.key, { commit: p.commit, sha256: createHash("sha256").update(manifest).digest("hex"), size: manifest.length, stored: header.stored, bytes: header.bytes }, p.signKey);
    await dav.put(WarmStore.latestPath(p.key), Buffer.from(JSON.stringify(latest)), "application/json");
    p.log?.(`warm store: published ${p.key}@${p.commit.slice(0, 12)}: ${header.files} files, ${firstPath.size} blobs, ${uploaded} uploaded (${uploadedBytes} bytes compressed)`);
    return { files: header.files, bytes: header.bytes, blobs: firstPath.size, uploaded, uploadedBytes, manifestBytes: manifest.length, repaired, latest };
  }

  /** Whether the stored blob exists and decompresses to content with this sha256. */
  private async blobIntact(dav: WebDav, sha: string): Promise<boolean> {
    try {
      const h = createHash("sha256");
      await pipelineAsync(await dav.stream(WarmStore.blobPath(sha), 64 * 1024 ** 3), createZstdDecompress(), h);
      return h.digest("hex") === sha;
    } catch {
      return false;
    }
  }

  /**
   * Compresses and uploads one file to a temporary name, checks it, then moves it into place: a reader never sees a
   * partial blob. The stream fails before its end when the content no longer has `sha`. Without `replace`, a blob
   * another publisher stored meanwhile wins (same content). Returns the compressed bytes sent.
   */
  private async uploadBlob(dav: WebDav, sha: string, file: string, replace = false): Promise<number> {
    const h = createHash("sha256");
    let sent = 0;
    const check = new Transform({
      transform(chunk: Buffer, _e, cb) { h.update(chunk); cb(null, chunk); },
      flush(cb) { cb(h.digest("hex") === sha ? null : new ManifestError(`${file} changed after it was hashed`)); },
    });
    const count = new Transform({ transform(chunk: Buffer, _e, cb) { sent += chunk.length; cb(null, chunk); } });
    const final = WarmStore.blobPath(sha);
    const temp = `${final}.tmp-${randomBytes(8).toString("hex")}`;
    const body = pipeline(createReadStream(file), check, createZstdCompress({ params: { [zc.ZSTD_c_compressionLevel]: 3 } }), count, () => {});
    try {
      await dav.put(temp, body, "application/zstd");
      const st = await dav.head(temp);
      if (!st || (st.size !== null && st.size !== sent)) throw new StoreError(`blob ${sha.slice(0, 12)} was stored incompletely`);
      if (!(await dav.move(temp, final, replace))) await dav.delete(temp);
    } catch (e) {
      await dav.delete(temp).catch(() => {});
      throw e;
    }
    return sent;
  }

  /**
   * Keeps the newest `keep` manifests of each key (and the one latest.json names), deletes the others, then deletes
   * blobs no kept manifest references that are older than `minBlobAgeMs`. Over `capBytes`, it runs again keeping fewer
   * manifests, down to one per key. Deletes no blob when any kept manifest cannot be read.
   */
  async gc(o: GcOptions): Promise<GcStats> {
    let keep = Math.max(1, o.keep ?? 3);
    for (;;) {
      const s = await this.gcPass(keep, o);
      if (!s.overCap || keep === 1) {
        if (s.overCap) o.log?.(`warm gc: ${s.bytesKept} bytes kept, over the cap of ${o.capBytes} bytes with one manifest per key`);
        return s;
      }
      keep--;
      o.log?.(`warm gc: over the cap, keeping ${keep} manifest${keep === 1 ? "" : "s"} per key`);
    }
  }

  private async gcPass(keep: number, o: GcOptions): Promise<GcStats> {
    const dav = this.rw();
    const now = o.now ?? Date.now();
    const minAge = o.minBlobAgeMs ?? DAY;
    const top = (await dav.propfind(WARM_ROOT)) ?? [];
    const keys = top.filter((i) => i.collection && i.name !== "blobs" && WARM_KEY.test(i.name)).map((i) => i.name);
    const stats: GcStats = { keys: keys.length, manifestsKept: 0, manifestsDeleted: 0, blobsKept: 0, blobsDeleted: 0, bytesKept: 0, bytesDeleted: 0, overCap: false };
    const referenced = new Set<string>();
    const seen = new Set<string>();
    const reference = async (key: string, commit: string) => {
      const buf = await dav.get(WarmStore.manifestPath(key, commit), 1024 ** 3);
      if (!buf) return;
      for (const e of decodeManifest(buf).entries) if (e.type === "file") referenced.add(e.sha256);
    };
    const manifestsOf = async (key: string) => ((await dav.propfind(`${WARM_ROOT}/${key}`)) ?? []).flatMap((i) => {
      const m = !i.collection ? MANIFEST_NAME.exec(i.name) : null;
      return m ? [{ commit: m[1], modified: i.modified ?? 0 }] : [];
    });
    await mapLimit(keys, 4, async (key) => {
      const current = (await this.latest(key, o.verifyKeys, dav).catch(() => null))?.commit;
      // Newest first; on a tie (listings carry whole seconds) the one latest.json names ranks first.
      const list = (await manifestsOf(key)).sort((a, b) => b.modified - a.modified || Number(b.commit === current) - Number(a.commit === current));
      const kept = list.filter((m, i) => i < keep || m.commit === current);
      for (const m of list) seen.add(`${key}/${m.commit}`);
      for (const m of kept) await reference(key, m.commit);
      for (const m of list) {
        if (kept.includes(m)) continue;
        if (await dav.delete(WarmStore.manifestPath(key, m.commit))) stats.manifestsDeleted++;
      }
      stats.manifestsKept += kept.length;
    });
    const shards = ((await dav.propfind(`${WARM_ROOT}/blobs`)) ?? []).filter((i) => i.collection && /^[0-9a-f]{2}$/.test(i.name));
    const temps: string[] = [];
    const blobs = (await mapLimit(shards, this.concurrency, async (s) => ((await dav.propfind(`${WARM_ROOT}/blobs/${s.name}`)) ?? []).flatMap((i) => {
      if (!i.collection && TEMP_NAME.test(i.name) && now - (i.modified ?? now) > DAY) temps.push(`${WARM_ROOT}/blobs/${s.name}/${i.name}`);
      const m = !i.collection ? BLOB_NAME.exec(i.name) : null;
      return m ? [{ sha: m[1], size: i.size ?? 0, modified: i.modified ?? now }] : [];
    }))).flat();
    // Uploads that never reached their move.
    await mapLimit(temps, this.concurrency, (t) => dav.delete(t));
    // A publish that finished meanwhile references blobs the first listing did not know about.
    await mapLimit(keys, 4, async (key) => {
      for (const m of await manifestsOf(key)) if (!seen.has(`${key}/${m.commit}`)) await reference(key, m.commit);
    });
    const doomed = blobs.filter((b) => !referenced.has(b.sha) && now - b.modified > minAge);
    await mapLimit(doomed, this.concurrency, async (b) => {
      if (await dav.delete(WarmStore.blobPath(b.sha))) {
        stats.blobsDeleted++;
        stats.bytesDeleted += b.size;
      }
    });
    const gone = new Set(doomed.map((b) => b.sha));
    for (const b of blobs) if (!gone.has(b.sha)) (stats.blobsKept++, (stats.bytesKept += b.size));
    stats.overCap = o.capBytes !== undefined && stats.bytesKept > o.capBytes;
    o.log?.(`warm gc: ${stats.keys} keys, ${stats.manifestsKept} manifests kept, ${stats.manifestsDeleted} deleted; ${stats.blobsKept} blobs kept (${stats.bytesKept} bytes), ${stats.blobsDeleted} deleted (${stats.bytesDeleted} bytes)`);
    return stats;
  }
}

function checkKey(key: string): string {
  if (!WARM_KEY.test(key) || key === "blobs") throw new StoreError(`warm key refused: ${key}`);
  return key;
}
