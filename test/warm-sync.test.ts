// The warm-sync agent against an in-process WebDAV store and a fake ConfigMap API: versions, hard links, grace,
// refusals, the node cap, and the runner's reading of the status.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { KubeError, type KConfigMap } from "../src/build/kube-api.ts";
import { STATUS_STALE_MS, WarmStatus } from "../src/build/warm-status.ts";
import { WarmStore } from "../src/warm/store-client.ts";
import { addReadBits, SyncAgent, type Assign, type NodeStatus } from "../src/warm/sync-agent.ts";
import { SCRATCH } from "./scratch.ts";

function fakeDav() {
  const files = new Map<string, Buffer>();
  const gets: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const path = decodeURIComponent(new URL(req.url!, "http://x").pathname).replace(/^\/+/, "").replace(/\/+$/, "");
    if (req.method === "MKCOL") return res.writeHead(201).end();
    if (req.method === "PUT") return (files.set(path, Buffer.concat(chunks)), res.writeHead(201).end());
    if (req.method === "DELETE") return res.writeHead(files.delete(path) ? 204 : 404).end();
    if (req.method === "MOVE") {
      const to = decodeURIComponent(new URL(String(req.headers.destination)).pathname).replace(/^\/+/, "");
      if (!files.has(path)) return res.writeHead(404).end();
      if (files.has(to) && req.headers.overwrite === "F") return res.writeHead(412).end();
      files.set(to, files.get(path)!);
      files.delete(path);
      return res.writeHead(201).end();
    }
    const f = files.get(path);
    if (!f) return res.writeHead(404).end();
    if (req.method === "GET") gets.push(path);
    res.writeHead(200, { "content-length": String(f.length) }).end(req.method === "GET" ? f : undefined);
  });
  return new Promise<{ url: string; files: typeof files; gets: string[]; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, files, gets, close: () => server.close() })));
}

class FakeConfigMaps {
  maps = new Map<string, KConfigMap>();
  async createConfigMap(_ns: string, cm: object) { const c = structuredClone(cm) as KConfigMap; this.maps.set(c.metadata.name, c); }
  async patchConfigMap(_ns: string, name: string, patch: { data?: Record<string, string> }) {
    const c = this.maps.get(name);
    if (!c) throw new KubeError(404, "not found");
    c.data = { ...c.data, ...patch.data };
  }
  async listConfigMaps() { return [...this.maps.values()]; }
  status(node: string): NodeStatus { return JSON.parse(this.maps.get(`warm-status-${node}`)!.data!["status.json"]!) as NodeStatus; }
}

test("warm sync: versions with hard links, grace, refused versions, the node cap and the runner's view", async (t) => {
  const root = join(SCRATCH, "warm-sync");
  const dav = await fakeDav();
  t.after(dav.close);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const other = generateKeyPairSync("ed25519").privateKey;
  const store = new WarmStore({ readUrl: dav.url, writeUrl: dav.url, auth: { user: "w", password: "p" } });

  const tree = (key: string) => ({ target: join(root, "src", key, "target"), cargoHome: join(root, "src", key, "cargo") });
  const write = (key: string, files: Record<string, string>) => {
    for (const [p, body] of Object.entries(files)) {
      const abs = join(p.startsWith("target/") ? tree(key).target : tree(key).cargoHome, p.slice(p.indexOf("/") + 1));
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, body);
      chmodSync(abs, 0o644);
    }
  };
  let stored = Date.now();
  const publish = (key: string, commit: string, o: { signKey?: typeof privateKey; at?: number } = {}) =>
    store.publish({ key, repo: `org/${key}`, commit, image: "img@sha256:1", rustc: null, envHash: "e1", checkout: "/w/src", source: tree(key), signKey: o.signKey ?? privateKey, stored: o.at ?? (stored += 1000) });

  let clock = Date.now();
  let assign: Assign = { keys: ["deckcraft", "photocraft"], maxBytes: 1024 ** 3 };
  const kube = new FakeConfigMaps();
  const dir = join(root, "node");
  const agent = new SyncAgent({
    dir, node: "k3s-1", namespace: "craft-cache", kube, store, log: () => {}, verifyKeys: () => [publicKey], assign: () => assign,
    writeBytesPerSec: 0, graceMs: 3600_000, now: () => clock, diskUse: () => ({ sizeBytes: 1e9, usedBytes: 1e8, availBytes: 9e8 }),
  });
  const cur = (key: string) => readlinkSync(join(dir, key, "current"));
  const inode = (key: string, gen: string, p: string) => statSync(join(dir, key, gen, p)).ino;

  // First sync: a version dir and `current` per key, and a status the runner reads.
  write("deckcraft", { "target/debug/libbig.rlib": "big ".repeat(5000), "target/debug/app": "v1", "cargo/registry/cache/x.crate": "crate" });
  write("photocraft", { "target/debug/libp.rlib": "p ".repeat(2000) });
  await publish("deckcraft", "a".repeat(40));
  await publish("photocraft", "b".repeat(40));
  await agent.cycle();
  assert.equal(cur("deckcraft"), `gen-${"a".repeat(12)}`);
  assert.equal(readFileSync(join(dir, "deckcraft", cur("deckcraft"), "target/debug/app"), "utf8"), "v1");
  assert.equal(statSync(join(dir, "deckcraft", cur("deckcraft"))).mode & 0o777, 0o755);
  const runner = new WarmStatus(kube, { now: () => clock });
  await runner.refresh(true);
  assert.deepEqual(runner.warmNodesFor("deckcraft").map((n) => [n.node, n.commit]), [["k3s-1", "a".repeat(40)]]);
  assert.deepEqual(runner.summary().map((w) => w.key), ["deckcraft", "photocraft"]);

  // A second version downloads only what changed; unchanged files are hard links into the first.
  write("deckcraft", { "target/debug/app": "v2" });
  await publish("deckcraft", "c".repeat(40));
  dav.gets.length = 0;
  await agent.cycle();
  const g1 = `gen-${"a".repeat(12)}`, g2 = `gen-${"c".repeat(12)}`;
  assert.equal(cur("deckcraft"), g2);
  assert.equal(inode("deckcraft", g2, "target/debug/libbig.rlib"), inode("deckcraft", g1, "target/debug/libbig.rlib"));
  assert.notEqual(inode("deckcraft", g2, "target/debug/app"), inode("deckcraft", g1, "target/debug/app"));
  assert.equal(dav.gets.filter((p) => p.includes("/blobs/")).length, 1);
  assert.equal(kube.status("k3s-1").keys.deckcraft!.commit, "c".repeat(40));

  // A restart with an old mode mark and a group-writable file clears the bit and keeps `current`.
  const big = join(dir, "deckcraft", g2, "target/debug/libbig.rlib");
  chmodSync(big, 0o664);
  rmSync(join(dir, "deckcraft", g2, ".modes-ok2"));
  await new SyncAgent({
    dir, node: "k3s-1", namespace: "craft-cache", kube, store, log: () => {}, verifyKeys: () => [publicKey], assign: () => assign,
    writeBytesPerSec: 0, graceMs: 3600_000, now: () => clock, diskUse: () => ({ sizeBytes: 1e9, usedBytes: 1e8, availBytes: 9e8 }),
  }).cycle();
  assert.equal(cur("deckcraft"), g2);
  assert.equal(statSync(big).mode & 0o022, 0);

  // The replaced version stays through the grace period, then goes.
  clock += 30 * 60_000;
  await agent.cycle();
  assert.ok(existsSync(join(dir, "deckcraft", g1)));
  clock += 31 * 60_000;
  await agent.cycle();
  assert.ok(!existsSync(join(dir, "deckcraft", g1)));
  assert.ok(existsSync(join(dir, "deckcraft", g2)));

  // A latest.json signed by another key, an older one, and one with a bad blob leave `current` alone.
  const latestPath = WarmStore.latestPath("deckcraft");
  const good = dav.files.get(latestPath)!;
  write("deckcraft", { "target/debug/app": "v3" });
  await publish("deckcraft", "d".repeat(40), { signKey: other });
  await agent.cycle();
  assert.equal(cur("deckcraft"), g2);
  assert.match(kube.status("k3s-1").pending.deckcraft!, /signature/);
  await publish("deckcraft", "d".repeat(40), { at: 1 });
  await agent.cycle();
  assert.equal(cur("deckcraft"), g2);
  assert.match(kube.status("k3s-1").pending.deckcraft!, /older than the version held/);
  await publish("deckcraft", "d".repeat(40));
  const bad = createHash("sha256").update("v3").digest("hex");
  dav.files.set(WarmStore.blobPath(bad), Buffer.from("not zstd"));
  await agent.cycle();
  assert.equal(cur("deckcraft"), g2);
  assert.deepEqual(kube.status("k3s-1").badBlobs.deckcraft, [bad]);
  await runner.refresh(true);
  assert.deepEqual(runner.badBlobsFor("deckcraft"), [bad]);
  dav.files.set(latestPath, good);

  // Over the cap, the lower-priority key stops being current and is deleted after the grace period.
  const statusBefore = kube.status("k3s-1").updated;
  assign = { keys: ["deckcraft", "photocraft"], maxBytes: kube.status("k3s-1").keys.deckcraft!.bytes + 10 };
  await agent.cycle();
  assert.ok(!existsSync(join(dir, "photocraft", "current")));
  assert.equal(cur("deckcraft"), g2);
  const st = kube.status("k3s-1");
  assert.equal(st.keys.photocraft, undefined);
  assert.match(st.pending.photocraft!, /cap/);
  assert.ok(st.updated >= statusBefore);
  clock += 61 * 60_000;
  await agent.cycle();
  assert.ok(!existsSync(join(dir, "photocraft")));

  // A status not rewritten for 15 minutes no longer counts.
  await runner.refresh(true);
  assert.equal(runner.warmNodesFor("deckcraft").length, 1);
  const later = new WarmStatus(kube, { now: () => clock + STATUS_STALE_MS + 60_000 });
  await later.refresh(true);
  assert.equal(later.warmNodesFor("deckcraft").length, 0);
});

test("warm sync: a third publish of one commit keeps the version in its grace period; an older latest.json is refused after a retire", async (t) => {
  const root = join(SCRATCH, "warm-sync-names");
  const dav = await fakeDav();
  t.after(dav.close);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const store = new WarmStore({ readUrl: dav.url, writeUrl: dav.url, auth: { user: "w", password: "p" } });
  const src = { target: join(root, "src", "target"), cargoHome: join(root, "src", "cargo") };
  const put = (body: string) => {
    mkdirSync(join(src.target, "debug"), { recursive: true });
    mkdirSync(src.cargoHome, { recursive: true });
    writeFileSync(join(src.target, "debug", "app"), body);
  };
  let stored = Date.now();
  const publish = (commit: string, at?: number) =>
    store.publish({ key: "deckcraft", repo: "org/deckcraft", commit, image: null, rustc: null, envHash: null, checkout: "/w/src", source: src, signKey: privateKey, stored: at ?? (stored += 1000) });
  let clock = Date.now();
  let assign: Assign = { keys: ["deckcraft"], maxBytes: 1024 ** 3 };
  const dir = join(root, "node");
  const agent = new SyncAgent({
    dir, node: "n1", namespace: "ns", kube: null, store, log: () => {}, verifyKeys: () => [publicKey], assign: () => assign,
    writeBytesPerSec: 0, graceMs: 3600_000, now: () => clock, diskUse: () => ({ sizeBytes: 1e9, usedBytes: 1e8, availBytes: 9e8 }),
  });
  const cur = () => readlinkSync(join(dir, "deckcraft", "current"));
  const a = `gen-${"a".repeat(12)}`;

  // The same commit published three times with different content: the version replaced twice ago is still in its grace period.
  put("1");
  await publish("a".repeat(40));
  await agent.cycle();
  assert.equal(cur(), a);
  put("2");
  await publish("a".repeat(40));
  await agent.cycle();
  assert.equal(cur(), `${a}-2`);
  put("3");
  await publish("a".repeat(40));
  await agent.cycle();
  assert.equal(cur(), `${a}-3`);
  assert.equal(readFileSync(join(dir, "deckcraft", a, "target/debug/app"), "utf8"), "1");
  assert.equal(readFileSync(join(dir, "deckcraft", cur(), "target/debug/app"), "utf8"), "3");

  // After the key is retired and deleted, an older latest.json is still refused.
  const newest = (await store.latest("deckcraft", [publicKey]))!.stored;
  assign = { keys: [], maxBytes: 1024 ** 3 };
  await agent.cycle();
  clock += 61 * 60_000;
  await agent.cycle();
  assert.ok(!existsSync(join(dir, "deckcraft")));
  assign = { keys: ["deckcraft"], maxBytes: 1024 ** 3 };
  await publish("b".repeat(40), newest - 5000);
  await agent.cycle();
  assert.ok(!existsSync(join(dir, "deckcraft", "current")));
  assert.match(agent.status().pending.deckcraft!, /older than the newest version accepted/);
});

test("warm sync: a new version that fits the cap only after a grace version expires is deferred, then fetched", async (t) => {
  const root = join(SCRATCH, "warm-sync-grace-cap");
  const dav = await fakeDav();
  t.after(dav.close);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const store = new WarmStore({ readUrl: dav.url, writeUrl: dav.url, auth: { user: "w", password: "p" } });
  const src = { target: join(root, "src", "target"), cargoHome: join(root, "src", "cargo") };
  mkdirSync(join(src.target, "debug"), { recursive: true });
  mkdirSync(src.cargoHome, { recursive: true });
  let stored = Date.now();
  const publish = async (commit: string, body: string) => {
    writeFileSync(join(src.target, "debug", "app"), body);
    await store.publish({ key: "deckcraft", repo: "org/deckcraft", commit, image: null, rustc: null, envHash: null, checkout: "/w/src", source: src, signKey: privateKey, stored: (stored += 1000) });
  };
  let clock = Date.now();
  let assign: Assign = { keys: ["deckcraft"], maxBytes: 1024 ** 3 };
  const dir = join(root, "node");
  const agent = new SyncAgent({
    dir, node: "n1", namespace: "ns", kube: null, store, log: () => {}, verifyKeys: () => [publicKey], assign: () => assign,
    writeBytesPerSec: 0, graceMs: 3600_000, now: () => clock, diskUse: () => ({ sizeBytes: 1e9, usedBytes: 1e8, availBytes: 9e8 }),
  });
  const cur = () => readlinkSync(join(dir, "deckcraft", "current"));
  const a = `gen-${"a".repeat(12)}`, b = `gen-${"b".repeat(12)}`, c = `gen-${"c".repeat(12)}`;

  await publish("a".repeat(40), "x".repeat(1000));
  await agent.cycle();
  const one = agent.status().keys.deckcraft!.bytes;
  assign = { keys: ["deckcraft"], maxBytes: Math.floor(one * 1.5) };
  await publish("b".repeat(40), "y".repeat(1000));
  await agent.cycle();
  assert.equal(cur(), b);
  assert.ok(agent.status().warmBytes.grace >= one);

  // a is in its grace period: c would bring the node over the cap, so it waits.
  await publish("c".repeat(40), "z".repeat(1000));
  await agent.cycle();
  assert.equal(cur(), b);
  assert.ok(existsSync(join(dir, "deckcraft", a)));
  assert.match(agent.status().pending.deckcraft!, /retired versions to expire/);

  clock += 61 * 60_000;
  await agent.cycle();
  assert.equal(cur(), c);
  assert.ok(!existsSync(join(dir, "deckcraft", a)));
  assert.equal(agent.status().pending.deckcraft, undefined);

  // The stored manifest is the fetched bytes, so its sha256 is the one latest.json names.
  const stored1 = readFileSync(join(dir, "deckcraft", c, "manifest.zst"));
  assert.equal(createHash("sha256").update(stored1).digest("hex"), JSON.parse(readFileSync(join(dir, "deckcraft", c, "latest.json"), "utf8")).sha256);
});

test("warm sync: a key bigger than half the cap updates when nothing is in grace", async (t) => {
  const root = join(SCRATCH, "warm-sync-big-key");
  const dav = await fakeDav();
  t.after(dav.close);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const store = new WarmStore({ readUrl: dav.url, writeUrl: dav.url, auth: { user: "w", password: "p" } });
  const src = { target: join(root, "src", "target"), cargoHome: join(root, "src", "cargo") };
  mkdirSync(join(src.target, "debug"), { recursive: true });
  mkdirSync(src.cargoHome, { recursive: true });
  let stored = Date.now();
  const publish = async (commit: string, body: string) => {
    writeFileSync(join(src.target, "debug", "app"), body);
    await store.publish({ key: "deckcraft", repo: "org/deckcraft", commit, image: null, rustc: null, envHash: null, checkout: "/w/src", source: src, signKey: privateKey, stored: (stored += 1000) });
  };
  let assign: Assign = { keys: ["deckcraft"], maxBytes: 1024 ** 3 };
  const dir = join(root, "node");
  const agent = new SyncAgent({
    dir, node: "n1", namespace: "ns", kube: null, store, log: () => {}, verifyKeys: () => [publicKey], assign: () => assign,
    writeBytesPerSec: 0, graceMs: 3600_000, now: () => Date.now(), diskUse: () => ({ sizeBytes: 1e9, usedBytes: 1e8, availBytes: 9e8 }),
  });
  await publish("a".repeat(40), "x".repeat(1000));
  await agent.cycle();
  const one = agent.status().keys.deckcraft!.bytes;
  assign = { keys: ["deckcraft"], maxBytes: Math.floor(one * 1.5) };
  await publish("b".repeat(40), "y".repeat(1000));
  await agent.cycle();
  assert.equal(readlinkSync(join(dir, "deckcraft", "current")), `gen-${"b".repeat(12)}`);
});

test("warm sync: while a version downloads the status lists it as pending with progress, and drops it when done", async (t) => {
  const root = join(SCRATCH, "warm-sync-progress");
  const dav = await fakeDav();
  t.after(dav.close);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const store = new WarmStore({ readUrl: dav.url, writeUrl: dav.url, auth: { user: "w", password: "p" } });
  const src = { target: join(root, "src", "target"), cargoHome: join(root, "src", "cargo") };
  mkdirSync(join(src.target, "debug"), { recursive: true });
  mkdirSync(src.cargoHome, { recursive: true });
  writeFileSync(join(src.target, "debug", "app"), "x".repeat(1000));
  await store.publish({ key: "deckcraft", repo: "org/deckcraft", commit: "a".repeat(40), image: null, rustc: null, envHash: null, checkout: "/w/src", source: src, signKey: privateKey });
  const kube = new FakeConfigMaps();
  const lines: string[] = [];
  const realBlobs = store.blobs.bind(store);
  store.blobs = () => { const f = realBlobs(); return async (sha, size) => { await new Promise((r) => setTimeout(r, 400)); return f(sha, size); }; };
  const agent = new SyncAgent({
    dir: join(root, "node"), node: "n1", namespace: "ns", kube: kube as never, store, log: (l) => lines.push(l), verifyKeys: () => [publicKey],
    assign: () => ({ keys: ["deckcraft"], maxBytes: 1024 ** 3 }), writeBytesPerSec: 0, progressEveryMs: 50,
    diskUse: () => ({ sizeBytes: 1e9, usedBytes: 1e8, availBytes: 9e8 }),
  });
  const done = agent.cycle();
  await new Promise((r) => setTimeout(r, 200));
  assert.match(kube.status("n1").pending.deckcraft!, /^downloading aaaaaaaaaaaa: .* of .* GiB$/);
  await done;
  assert.equal(kube.status("n1").pending.deckcraft, undefined);
  assert.ok(lines.some((l) => /download starts/.test(l)) && lines.some((l) => /download ok after/.test(l)));
});

test("warm sync: the startup fix-up adds read bits to files and directories of an older version", async (t) => {
  const dir = join(SCRATCH, `modes-${process.pid}`);
  mkdirSync(join(dir, "target/sub"), { recursive: true });
  writeFileSync(join(dir, "target/sub/f"), "x", { mode: 0o750 });
  writeFileSync(join(dir, "target/g"), "y");
  chmodSync(join(dir, "target/g"), 0o640);
  chmodSync(join(dir, "target/sub"), 0o700);
  chmodSync(dir, 0o755);
  chmodSync(join(dir, "target"), 0o755);
  t.after(() => { chmodSync(join(dir, "target/sub"), 0o755); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(addReadBits(dir), 3);
  assert.equal(statSync(join(dir, "target/g")).mode & 0o777, 0o644);
  assert.equal(statSync(join(dir, "target/sub/f")).mode & 0o777, 0o754);
  assert.equal(statSync(join(dir, "target/sub")).mode & 0o555, 0o555);
  assert.equal(addReadBits(dir), 0);
});
