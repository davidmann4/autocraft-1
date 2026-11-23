import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { applyManifest, clearDir, decodeManifest, ManifestError, MTIME_SLACK_NS, removeCargoLocks, signLatest, WARM_BASE_MARK, walkTree, type Entry } from "../src/warm/manifest.ts";
import { WarmStore } from "../src/warm/store-client.ts";
import { podPhase } from "../src/worker/pod.ts";

/** In-memory WebDAV: PUT needs an existing parent collection (as many servers do), writes need Basic auth. */
function fakeDav(): Promise<{ server: Server; url: string; files: Map<string, { body: Buffer; modified: number }>; puts: string[]; refusedMoves: () => number }> {
  const files = new Map<string, { body: Buffer; modified: number }>();
  const dirs = new Set<string>([""]);
  const puts: string[] = [];
  let refused = 0;
  const auth = `Basic ${Buffer.from("w:secret").toString("base64")}`;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const path = decodeURIComponent(new URL(req.url!, "http://x").pathname).replace(/^\/+/, "").replace(/\/+$/, "");
    const parent = path.split("/").slice(0, -1).join("/");
    const send = (code: number, body = "", headers: Record<string, string> = {}) => res.writeHead(code, headers).end(body);
    if (["PUT", "DELETE", "MKCOL", "MOVE"].includes(req.method!) && req.headers.authorization !== auth) return send(401);
    if (req.method === "GET" || req.method === "HEAD") {
      const f = files.get(path);
      if (!f) return send(404);
      res.writeHead(200, { "content-length": String(f.body.length), "last-modified": new Date(f.modified).toUTCString() });
      return res.end(req.method === "GET" ? f.body : undefined);
    }
    if (req.method === "PUT") {
      if (!dirs.has(parent)) return send(409);
      // Uploads take a while, so two publishers of one blob overlap.
      if (path.includes(".tmp-")) await new Promise((r) => setTimeout(r, 30));
      files.set(path, { body: Buffer.concat(chunks), modified: Date.now() });
      puts.push(path);
      return send(201);
    }
    if (req.method === "MOVE") {
      const to = decodeURIComponent(new URL(String(req.headers.destination)).pathname).replace(/^\/+/, "");
      const f = files.get(path);
      if (!f) return send(404);
      if (files.has(to) && req.headers.overwrite === "F") return (refused++, send(412));
      files.delete(path);
      files.set(to, { ...f, modified: Date.now() });
      return send(201);
    }
    if (req.method === "MKCOL") {
      if (dirs.has(path)) return send(405);
      if (!dirs.has(parent)) return send(409);
      dirs.add(path);
      return send(201);
    }
    if (req.method === "DELETE") return send(files.delete(path) ? 204 : 404);
    if (req.method === "PROPFIND") {
      if (!dirs.has(path)) return send(404);
      const under = (p: string) => (path ? p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes("/") : !p.includes("/"));
      const rows = [`<D:response><D:href>/${path}/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>`];
      for (const d of dirs) if (d && under(d)) rows.push(`<D:response><D:href>/${d}/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>`);
      for (const [p, f] of files) if (under(p)) rows.push(`<D:response><D:href>/${p}</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>${f.body.length}</D:getcontentlength><D:getlastmodified>${new Date(f.modified).toUTCString()}</D:getlastmodified></D:prop></D:propstat></D:response>`);
      return send(207, `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${rows.join("")}</D:multistatus>`, { "content-type": "application/xml" });
    }
    send(405);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, files, puts, refusedMoves: () => refused })));
}

/** Sets an exact nanosecond mtime, which Node's utimes cannot. */
const touchNs = (p: string, ns: string) => execFileSync("touch", ["-h", "-d", `@${ns.slice(0, -9)}.${ns.slice(-9)}`, p]);

function makeTree(root: string) {
  const t = join(root, "target"), c = join(root, "cargo");
  for (const d of ["debug/deps", "debug/.fingerprint/a-1", "debug/incremental/a-x", "debug/build/b-2/out"]) mkdirSync(join(t, d), { recursive: true });
  for (const d of ["registry/src/index.crates.io-0000/foo-1.0.0/src", "registry/cache/index.crates.io-0000", "bin"]) mkdirSync(join(c, d), { recursive: true });
  writeFileSync(join(t, "debug/deps/liba-1.rlib"), "rlib bytes ".repeat(1000));
  linkSync(join(t, "debug/deps/liba-1.rlib"), join(t, "debug/liba.rlib"));
  writeFileSync(join(t, "debug/deps/a-1.d"), "deps");
  writeFileSync(join(t, "debug/.fingerprint/a-1/lib-a"), "fp");
  writeFileSync(join(t, "debug/incremental/a-x/s"), "session");
  writeFileSync(join(t, "debug/build/b-2/out/gen.rs"), "pub fn f() {}");
  writeFileSync(join(t, "debug/build/b-2/build-script-build"), "#!/bin/sh\n", { mode: 0o755 });
  symlinkSync("deps/a-1.d", join(t, "debug/a.d"));
  writeFileSync(join(c, "registry/src/index.crates.io-0000/foo-1.0.0/src/lib.rs"), "pub fn foo() {}");
  writeFileSync(join(c, "registry/cache/index.crates.io-0000/foo-1.0.0.crate"), "crate");
  writeFileSync(join(c, "bin/cargo-tool"), "binary");
  touchNs(join(t, "debug/deps/liba-1.rlib"), "1763800000123456789");
  touchNs(join(t, "debug/deps/a-1.d"), "1763800000123456790");
  touchNs(join(t, "debug/a.d"), "1763800001000000007");
  touchNs(join(c, "registry/src/index.crates.io-0000/foo-1.0.0/src/lib.rs"), "1700000000000000000");
  touchNs(join(t, "debug/build/b-2/out"), "1763800002999999999");
  return { target: t, cargoHome: c };
}

/** Trees match: same entries and contents; mtimes exact for whole seconds, else within MTIME_SLACK_NS. */
function sameTree(got: Entry[], want: Entry[]) {
  const plain = (es: Entry[]) => es.map((e) => ({ ...e, mtimeNs: 0n }));
  assert.deepEqual(plain(got), plain(want));
  for (const [i, w] of want.entries()) {
    const d = got[i].mtimeNs - w.mtimeNs;
    if (w.mtimeNs % 1_000_000_000n === 0n) assert.equal(d, 0n, `${w.path} mtime is exact`);
    else assert.ok(d < MTIME_SLACK_NS && -d < MTIME_SLACK_NS, `${w.path} mtime within slack`);
  }
}

test("warm store: publish, restore, delta publish, hard-linked restore, gc and refusals", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "warm-manifest-"));
  const dav = await fakeDav();
  t.after(() => {
    dav.server.close();
    rmSync(tmp, { recursive: true, force: true });
  });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const other = generateKeyPairSync("ed25519");
  writeFileSync(join(tmp, "sign.pem"), privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(join(tmp, "verify.pem"), publicKey.export({ type: "spki", format: "pem" }));
  const src = makeTree(join(tmp, "src"));
  const store = new WarmStore({ readUrl: dav.url, writeUrl: dav.url, auth: { user: "w", password: "secret" } });
  const blobPuts = () => dav.puts.filter((p) => p.includes("/blobs/")).length;
  const msg = join(tmp, "message");
  const env = (extra: Record<string, string>) => ({
    AUTOCRAFT_POD_MESSAGE: msg, AUTOCRAFT_WARM_KEY: "deckcraft", AUTOCRAFT_WARM_STORE_URL: dav.url, AUTOCRAFT_WARM_STORE_WRITE_URL: dav.url,
    AUTOCRAFT_WARM_STORE_USER: "w", AUTOCRAFT_WARM_STORE_PASSWORD: "secret", AUTOCRAFT_WARM_VERIFY_KEYS: join(tmp, "verify.pem"), AUTOCRAFT_WARM_SIGNING_KEY: join(tmp, "sign.pem"), ...extra,
  });

  // Round trip through the pod phases.
  assert.equal(await podPhase("warm-publish", env({ AUTOCRAFT_WARM_TARGET: src.target, AUTOCRAFT_WARM_CARGO_HOME: src.cargoHome, AUTOCRAFT_WARM_REPO: "storytold/deckcraft", AUTOCRAFT_WARM_COMMIT: "a".repeat(40) })), 0);
  const first = blobPuts();
  assert.ok(first > 0);
  const r1 = { target: join(tmp, "r1/target"), cargoHome: join(tmp, "r1/cargo") };
  assert.equal(await podPhase("warm-restore", env({ AUTOCRAFT_WARM_TARGET: r1.target, AUTOCRAFT_WARM_CARGO_HOME: r1.cargoHome })), 0);
  assert.equal(JSON.parse(readFileSync(msg, "utf8")).warm.commit, "a".repeat(40));
  const want = await walkTree(src);
  sameTree(await walkTree(r1), want);
  assert.ok(want.some((e) => e.path === "target/debug/a.d" && e.type === "symlink"));
  assert.ok(!want.some((e) => e.path.includes("incremental") || e.path.startsWith("cargo/bin")), "exclusions and the CARGO_HOME subset hold");

  // Republishing the same tree uploads no blob.
  const pub = (commit: string) => store.publish({ key: "deckcraft", repo: "storytold/deckcraft", commit, image: null, rustc: null, envHash: null, checkout: null, source: src, signKey: privateKey });
  assert.equal((await pub("a".repeat(40))).uploaded, 0);
  assert.equal(blobPuts(), first);

  // One changed file uploads one blob; a restore against the previous tree fetches only it and links the rest.
  writeFileSync(join(src.target, "debug/deps/a-1.d"), "deps changed");
  assert.equal((await pub("b".repeat(40))).uploaded, 1);
  const latestA = { manifest: decodeManifest(dav.files.get(`warm/v1/deckcraft/${"a".repeat(40)}.manifest.zst`)!.body), roots: { target: r1.target, cargo: r1.cargoHome } };
  const r2 = { target: join(tmp, "r2/target"), cargo: join(tmp, "r2/cargo") };
  const res = await store.restore("deckcraft", r2, [publicKey], latestA);
  assert.ok(res);
  assert.equal(res.stats.fetched, 1);
  assert.equal(res.stats.linked + res.stats.copied + res.stats.fetched, res.stats.files);
  assert.equal(statSync(join(r2.target, "debug/deps/liba-1.rlib")).ino, statSync(join(r1.target, "debug/deps/liba-1.rlib")).ino);
  sameTree(await walkTree({ target: r2.target, cargoHome: r2.cargo }), await walkTree(src));

  // A stored blob close to gc's age limit is uploaded again, which renews its time.
  const refresh = await store.publish({ key: "deckcraft", repo: "storytold/deckcraft", commit: "b".repeat(40), image: null, rustc: null, envHash: null, checkout: null, source: src, signKey: privateKey, minBlobAgeMs: 1 });
  assert.equal(refresh.uploaded, refresh.blobs);

  // gc keeps the newest three manifests and drops blobs only the older ones use, once they are old enough.
  for (const [i, c] of ["c", "d", "e"].entries()) {
    writeFileSync(join(src.target, "debug/deps/a-1.d"), `deps ${i}`);
    await pub(c.repeat(40));
  }
  const blobs = () => [...dav.files.keys()].filter((p) => p.includes("/blobs/")).length;
  const before = blobs();
  const gc = await store.gc({ verifyKeys: [publicKey], now: Date.now() + 48 * 3600_000 });
  assert.equal(gc.manifestsKept, 3);
  assert.equal(gc.manifestsDeleted, 2);
  assert.ok(blobs() < before);
  const r3 = { target: join(tmp, "r3/target"), cargo: join(tmp, "r3/cargo") };
  assert.equal((await store.restore("deckcraft", r3, [publicKey]))?.latest.commit, "e".repeat(40), "the newest version still restores after gc");

  // A latest.json not signed by a trusted key is refused.
  const latestPath = "warm/v1/deckcraft/latest.json";
  const good = dav.files.get(latestPath)!.body;
  const l = JSON.parse(good.toString());
  dav.files.get(latestPath)!.body = Buffer.from(JSON.stringify({ ...l, bytes: l.bytes + 1 }));
  await assert.rejects(store.restore("deckcraft", { target: join(tmp, "r4/target") }, [publicKey]), /signature/);
  assert.equal(await podPhase("warm-restore", env({ AUTOCRAFT_WARM_TARGET: join(tmp, "r5/target") })), 0, "a refused version is a cold start");
  assert.equal(JSON.parse(readFileSync(msg, "utf8")).warm, null);
  dav.files.get(latestPath)!.body = Buffer.from(JSON.stringify(signLatest("deckcraft", l, other.privateKey)));
  await assert.rejects(store.restore("deckcraft", { target: join(tmp, "r6/target") }, [publicKey]), /signature/);
  dav.files.get(latestPath)!.body = good;

  // A blob whose content does not match its name is refused.
  const m = decodeManifest(dav.files.get(`warm/v1/deckcraft/${"e".repeat(40)}.manifest.zst`)!.body);
  const rlib = m.entries.find((e) => e.path === "target/debug/deps/liba-1.rlib")!;
  assert.equal(rlib.type, "file");
  const blobPath = `warm/v1/blobs/${(rlib as { sha256: string }).sha256.slice(0, 2)}/${(rlib as { sha256: string }).sha256}.zst`;
  dav.files.get(blobPath)!.body = zstdCompressSync(Buffer.from("RLIB bytes ".repeat(1000)));
  await assert.rejects(store.restore("deckcraft", { target: join(tmp, "r7/target") }, [publicKey]), /sha256/);

  // The restore phase reports it, leaves its roots empty, and a publish told to recheck it repairs it.
  const r8 = { target: join(tmp, "r8/target"), cargo: join(tmp, "r8/cargo") };
  assert.equal(await podPhase("warm-restore", env({ AUTOCRAFT_WARM_TARGET: r8.target, AUTOCRAFT_WARM_CARGO_HOME: r8.cargo })), 0);
  const report = JSON.parse(readFileSync(msg, "utf8"));
  assert.deepEqual([report.warm, report.badBlobs], [null, [(rlib as { sha256: string }).sha256]]);
  assert.deepEqual([readdirSync(r8.target), readdirSync(r8.cargo)], [[], []]);
  const fixed = await store.publish({ key: "deckcraft", repo: "storytold/deckcraft", commit: "e".repeat(40), image: null, rustc: null, envHash: null, checkout: null, source: src, signKey: privateKey, recheck: report.badBlobs });
  assert.equal(fixed.repaired, 1);
  assert.ok(await store.restore("deckcraft", { target: join(tmp, "r9/target") }, [publicKey]));

  // A configuration error, such as a verify key that is not Ed25519, fails the phase instead of starting cold.
  writeFileSync(join(tmp, "ec.pem"), generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "pem" }));
  assert.equal(await podPhase("warm-restore", env({ AUTOCRAFT_WARM_TARGET: join(tmp, "r10"), AUTOCRAFT_WARM_VERIFY_KEYS: join(tmp, "ec.pem") })), 1);
});

test("warm store: two publishers of the same blob both succeed and the blob survives", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "warm-race-"));
  const dav = await fakeDav();
  t.after(() => {
    dav.server.close();
    rmSync(tmp, { recursive: true, force: true });
  });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const src = makeTree(join(tmp, "src"));
  const store = () => new WarmStore({ readUrl: dav.url, writeUrl: dav.url, auth: { user: "w", password: "secret" } });
  const pub = (key: string) => store().publish({ key, repo: "storytold/deckcraft", commit: "a".repeat(40), image: null, rustc: null, envHash: null, checkout: null, source: src, signKey: privateKey });
  const [a, b] = await Promise.all([pub("one"), pub("two")]);
  assert.ok(a.uploaded > 0 && b.uploaded > 0, "both found the blobs missing");
  assert.ok(dav.refusedMoves() > 0, "the later move kept the stored blob");
  assert.ok(![...dav.files.keys()].some((p) => p.includes(".tmp-")), "no temporary upload is left");
  for (const key of ["one", "two"]) assert.ok(await store().restore(key, { target: join(tmp, key, "target"), cargo: join(tmp, key, "cargo") }, [publicKey]));
});

test("clearDir empties a tree with read-only directories and files", () => {
  const tmp = mkdtempSync(join(tmpdir(), "warm-clear-"));
  try {
    mkdirSync(join(tmp, "a/b"), { recursive: true });
    writeFileSync(join(tmp, "a/b/f"), "x", { mode: 0o444 });
    chmodSync(join(tmp, "a/b"), 0o555);
    chmodSync(join(tmp, "a"), 0o500);
    clearDir(tmp);
    assert.deepEqual(readdirSync(tmp), []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("warm manifest: path traversal, absolute paths, escaping links and entries under a link are refused", () => {
  const head = { format: "autocraft-warm-manifest", version: 1, key: "k", repo: "o/r", commit: "a".repeat(40), stored: 1, image: null, rustc: null, env_hash: null, checkout: null, target_dir: "/t", cargo_home: "/c", bytes: 1, files: 1 };
  const file = (path: string) => ({ path, mode: 0o644, size: 1, mtime_ns: "1", sha256: "0".repeat(64) });
  const enc = (...entries: object[]) => zstdCompressSync(Buffer.from([head, ...entries].map((x) => JSON.stringify(x)).join("\n")));
  const dir = (path: string) => ({ path, type: "dir", mode: 0o755, mtime_ns: "1" });
  assert.equal(decodeManifest(enc(dir("target/a"), file("target/a/x"))).entries.length, 2);
  for (const bad of [
    enc(file("target/../../etc/passwd")),
    enc(file("/etc/passwd")),
    enc(file("other/x")),
    enc(dir("target/a"), { path: "target/a/l", type: "symlink", target: "../../../etc", mtime_ns: "1" }, file("target/x")),
    enc(dir("target/a"), { path: "target/a/l", type: "symlink", target: "/etc", mtime_ns: "1" }, file("target/x")),
    enc({ path: "target/l", type: "symlink", target: ".", mtime_ns: "1" }, file("target/l/x")),
  ]) assert.throws(() => decodeManifest(bad), ManifestError);
});

test("warm restore onto a non-empty target: one built with this image and Cargo.lock is kept, any other is cleared; the marker stays in the target and never travels", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "warm-reuse-"));
  const dav = await fakeDav();
  t.after(() => {
    dav.server.close();
    chmodSync(join(tmp, "checkout"), 0o755);
    rmSync(tmp, { recursive: true, force: true });
  });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(join(tmp, "verify.pem"), publicKey.export({ type: "spki", format: "pem" }));
  const msg = join(tmp, "message");
  const work = join(tmp, "work");
  mkdirSync(join(work, "src"), { recursive: true });
  writeFileSync(join(work, "src/Cargo.lock"), "# lock a");
  // A marker in the published tree must not be listed, so a restored version never arrives with one.
  const src = makeTree(join(tmp, "src"));
  writeFileSync(join(src.target, WARM_BASE_MARK), "{}");
  assert.ok(!(await walkTree(src)).some((e) => e.path.endsWith(WARM_BASE_MARK)));
  await new WarmStore({ readUrl: dav.url, writeUrl: dav.url, auth: { user: "w", password: "secret" } })
    .publish({ key: "photocraft", repo: "storytold/photocraft", commit: "a".repeat(40), image: "rust:1", rustc: null, envHash: null, checkout: null, source: src, signKey: privateKey });
  // The checkout is read-only, as in the build pod; the target dir is the writable volume inside it.
  const target = join(tmp, "checkout/target");
  mkdirSync(join(tmp, "checkout"));
  const env = (extra: Record<string, string> = {}) => ({
    AUTOCRAFT_POD_WORK: work, AUTOCRAFT_POD_MESSAGE: msg, AUTOCRAFT_WARM_KEY: "photocraft", AUTOCRAFT_WARM_STORE_URL: dav.url, AUTOCRAFT_WARM_VERIFY_KEYS: join(tmp, "verify.pem"),
    AUTOCRAFT_WARM_TARGET: target, AUTOCRAFT_WARM_IMAGE: "rust:1", ...extra,
  });
  const mark = join(target, WARM_BASE_MARK);
  mkdirSync(target);
  chmodSync(join(tmp, "checkout"), 0o555);
  assert.equal(await podPhase("warm-restore", env()), 0);
  assert.ok(JSON.parse(readFileSync(msg, "utf8")).warm, "restored from the store");
  assert.ok(existsSync(mark), "the marker is written inside the target after a successful restore, though its parent is read-only");
  writeFileSync(join(target, "leftover.o"), "x");
  assert.equal(await podPhase("warm-restore", env()), 0);
  assert.match(JSON.parse(readFileSync(msg, "utf8")).summary, /reusing the target/);
  assert.ok(existsSync(join(target, "leftover.o")), "the same image and Cargo.lock keeps the target");
  assert.equal(await podPhase("warm-restore", env({ AUTOCRAFT_WARM_IMAGE: "rust:2" })), 0);
  assert.deepEqual(readdirSync(target), [], "another image clears it, marker included");
  // A restore that fails half-way leaves no marker on the partial dir.
  dav.files.clear();
  assert.equal(await podPhase("warm-restore", env()), 0);
  assert.ok(!existsSync(mark));
});

test("warm restore: applied files are readable to other uids, and a hard-linked inode with missing bits is fixed", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "warm-modes-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const body = Buffer.from("rlib bytes");
  const sha256 = createHash("sha256").update(body).digest("hex");
  const mtimeNs = 1_700_000_000_000_000_000n;
  const mk = (mode: number): any => ({
    header: {},
    entries: [
      { path: "target/d", type: "dir", mode: 0o750, mtimeNs },
      { path: "target/d/lib.rlib", type: "file", mode, size: body.length, mtimeNs, sha256 },
    ],
  });
  const fetch = async () => (async function* () { yield zstdCompressSync(body); })();
  const mode = (p: string) => statSync(p).mode & 0o777;

  const prevRoot = join(tmp, "prev");
  await applyManifest(mk(0o640), { target: prevRoot }, fetch);
  assert.equal(mode(join(prevRoot, "d/lib.rlib")), 0o644);
  assert.equal(mode(join(prevRoot, "d")) & 0o055, 0o055);

  // A previous version built before normalization: the inode is 0640 and the manifest entry says so.
  chmodSync(join(prevRoot, "d/lib.rlib"), 0o640);
  const next = join(tmp, "next");
  const stats = await applyManifest(mk(0o640), { target: next }, fetch, { previous: { manifest: mk(0o640), roots: { target: prevRoot } } });
  assert.equal(stats.linked, 1);
  assert.equal(mode(join(next, "d/lib.rlib")), 0o644);
  assert.equal(mode(join(prevRoot, "d/lib.rlib")), 0o644);
});

test("warm cargo locks: never published, empty files get their own inodes, and a restore drops planted locks", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "warm-locks-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const src = join(tmp, "src");
  mkdirSync(join(src, "debug"), { recursive: true });
  for (const n of ["a", "b", "c", ".cargo-lock", "debug/.cargo-build-lock", "debug/.cargo-artifact-lock"]) writeFileSync(join(src, n), "");
  const entries = await walkTree({ target: src, cargoHome: join(tmp, "nohome") });
  assert.deepEqual(entries.filter((e) => e.type === "file").map((e) => e.path), ["target/a", "target/b", "target/c"]);

  // A manifest published before the fix lists the locks; they are skipped on apply too.
  const old = entries.concat([{ path: "target/.cargo-lock", type: "file", mode: 0o644, size: 0, mtimeNs: 1n, sha256: createHash("sha256").update("").digest("hex") }]);
  const dest = join(tmp, "dest");
  await applyManifest({ header: {} as any, entries: old }, { target: dest }, async () => { throw new Error("no fetch for empty files"); });
  assert.equal(existsSync(join(dest, ".cargo-lock")), false);
  const sts = ["a", "b", "c"].map((n) => statSync(join(dest, n)));
  assert.equal(new Set(sts.map((s) => s.ino)).size, 3);
  assert.ok(sts.every((s) => s.nlink === 1));

  linkSync(join(dest, "a"), join(dest, ".cargo-lock"));
  await removeCargoLocks(dest);
  assert.equal(existsSync(join(dest, ".cargo-lock")), false);
  assert.equal(existsSync(join(dest, "a")), true);
});

test("warm link reuse: a group-writable or foreign-group file is fetched again, a clean one with a new ctime is linked", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "warm-reuse-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const mtimeNs = 1_700_000_000_000_000_000n;
  const bodies = ["clean", "gwrite", "foreign"].map((n) => Buffer.from(`content of ${n}`));
  const shas = bodies.map((b) => createHash("sha256").update(b).digest("hex"));
  const manifest: any = {
    header: {},
    entries: [
      { path: "target/d", type: "dir", mode: 0o755, mtimeNs },
      ...bodies.map((b, i) => ({ path: `target/d/f${i}`, type: "file", mode: 0o644, size: b.length, mtimeNs, sha256: shas[i] })),
    ],
  };
  const fetch = async (sha: string) => (async function* () { yield zstdCompressSync(bodies[shas.indexOf(sha)]); })();
  const prevRoot = join(tmp, "prev");
  await applyManifest(manifest, { target: prevRoot }, fetch);
  chmodSync(join(prevRoot, "d/f1"), 0o664);
  // The agent's own unlink of another version sharing the inode bumps its ctime; that must not matter.
  chmodSync(join(prevRoot, "d/f0"), 0o644);
  const prev = { manifest, roots: { target: prevRoot } };
  const next = join(tmp, "next");
  const stats = await applyManifest(manifest, { target: next }, fetch, { previous: { ...prev, gid: process.getgid!() + 1 } });
  assert.equal(stats.linked, 0, "a file of another group is never a link source");
  const next2 = join(tmp, "next2");
  const s2 = await applyManifest(manifest, { target: next2 }, fetch, { previous: prev });
  assert.equal(s2.linked, 2, "g+w is refused, the other files are linked");
  assert.equal(statSync(join(next2, "d/f0")).ino, statSync(join(prevRoot, "d/f0")).ino);
  assert.notEqual(statSync(join(next2, "d/f1")).ino, statSync(join(prevRoot, "d/f1")).ino);
});
