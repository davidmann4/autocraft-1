// The shared warm snapshot store: upload from one worker, download into another, key checks, interrupted upload.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseWorkerConfig } from "../src/worker/config.ts";
import { createStore, parseStoreConfig } from "../src/worker/store.ts";
import { generateSigningKeys } from "../src/worker/store.ts";
import { copyWarm, storeWarm } from "../src/worker/warm.ts";
import { byteCap, downloadWarm, signedText, uploadWarm } from "../src/worker/warm-sync.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const root = mkdtempSync(join(SCRATCH, "warm-store-"));
after(() => rmSync(root, { recursive: true, force: true }));

const READ = "r".repeat(20);
const WRITE = "w".repeat(20);

test("a main build's target dir reaches another worker; bad keys and interrupted uploads change nothing", async () => {
  const store = createStore(parseStoreConfig({ dir: join(root, "store"), readKey: READ, writeKey: WRITE }));
  await new Promise<void>((r) => store.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(store.address() as AddressInfo).port}`;
  mkdirSync(join(root, "keys"));
  const k = (n: string) => join(root, "keys", n);
  generateSigningKeys(k("a.key"), k("a.pub"));
  generateSigningKeys(k("other.key"), k("other.pub"));
  const worker = (name: string, warmStore: object) =>
    parseWorkerConfig({ coordinatorUrl: "http://x.internal", keyFile: "/k", workDir: join(root, name, "w"), warmDir: join(root, name, "warm"), limits: { minFreeDiskGb: 0 }, warmStore });
  const a = worker("a", { url, readKey: READ, writeKey: WRITE, signKeyFile: k("a.key"), verifyKeyFiles: [k("a.pub")] });
  const b = worker("b", { url, readKey: READ, verifyKeyFiles: [k("a.pub")] });
  const bad = worker("c", { url, readKey: "x".repeat(20), verifyKeyFiles: [k("a.pub")] });
  const wrongPub = worker("d", { url, readKey: READ, verifyKeyFiles: [k("other.pub")] });
  const say = (m: string) => log.push(m);
  const log: string[] = [];
  try {
    const target = join(root, "a", "target");
    mkdirSync(join(target, "debug"), { recursive: true });
    writeFileSync(join(target, "debug", "lib.rlib"), "built");
    const sha1 = "a".repeat(40);
    await storeWarm(a, "repo", sha1, target);
    await uploadWarm(a, "repo", sha1, say);

    // A wrong read key gets nothing and the task is not failed.
    await downloadWarm(bad, "repo", say);
    assert.equal(await copyWarm(bad, "repo", join(root, "c-out")), false);
    assert.match(log.join("\n"), /lookup answered 401/);
    // A read key cannot write.
    const put = await fetch(`${url}/store/repo?commit=${sha1}`, { method: "PUT", headers: { authorization: `Bearer ${READ}` }, body: "x" });
    assert.equal(put.status, 401);

    // A crafted request line does not crash the server.
    await new Promise<void>((resolve) => {
      const sock = connect({ port: Number(new URL(url).port), host: "127.0.0.1" }, () => sock.write("GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n"));
      sock.on("data", () => {}).on("close", () => resolve()).on("error", () => resolve());
      setTimeout(() => sock.destroy(), 300);
    });
    assert.equal((await fetch(`${url}/store/repo`, { headers: { authorization: `Bearer ${READ}` } })).status, 200);

    // A snapshot that does not verify against the worker's public keys is refused.
    log.length = 0;
    await downloadWarm(wrongPub, "repo", say);
    assert.match(log.join("\n"), /unsigned or its signature is wrong/);
    assert.equal(await copyWarm(wrongPub, "repo", join(root, "d-out")), false);

    // Another worker downloads, unpacks and copies it.
    await downloadWarm(b, "repo", say);
    const out = join(root, "b-out");
    mkdirSync(out);
    assert.equal(await copyWarm(b, "repo", out), true);
    assert.equal(readFileSync(join(out, "debug", "lib.rlib"), "utf8"), "built");

    // An older remote snapshot does not replace a newer local one.
    const newer = join(root, "b", "target2");
    mkdirSync(newer);
    writeFileSync(join(newer, "new"), "local");
    await storeWarm(b, "repo", "c".repeat(40), newer, { stored: Date.now() + 60_000 });
    await downloadWarm(b, "repo", say);
    const out2 = join(root, "b-out2");
    mkdirSync(out2);
    await copyWarm(b, "repo", out2);
    assert.deepEqual(readdirSync(out2), ["new"]);

    // An upload cut off mid-body leaves the previous snapshot in place.
    const before = await (await fetch(`${url}/store/repo`, { headers: { authorization: `Bearer ${READ}` } })).json();
    await new Promise<void>((resolve) => {
      const req = request(`${url}/store/repo?commit=${"b".repeat(40)}`, { method: "PUT", headers: { authorization: `Bearer ${WRITE}`, "content-length": "1000" } });
      req.on("error", () => {});
      req.write("partial");
      setTimeout(() => {
        req.destroy();
        setTimeout(resolve, 100);
      }, 50);
    });
    const after2 = await (await fetch(`${url}/store/repo`, { headers: { authorization: `Bearer ${READ}` } })).json();
    assert.deepEqual(after2, before);
    assert.equal(readdirSync(join(root, "store")).filter((f) => f.startsWith(".up-") && f.endsWith(".tmp")).length, 0);
  } finally {
    // close() alone waits for every open connection, including the cut-off upload's.
    store.closeAllConnections();
    await new Promise((r) => store.close(r));
  }
});

test("a snapshot whose archive runs on past its end marker downloads", { timeout: 60_000 }, async () => {
  const store = createStore(parseStoreConfig({ dir: join(root, "pad-store"), readKey: READ, writeKey: WRITE }));
  await new Promise<void>((r) => store.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(store.address() as AddressInfo).port}`;
  try {
    const k = (n: string) => join(root, "pad-keys", n);
    mkdirSync(join(root, "pad-keys"));
    generateSigningKeys(k("a.key"), k("a.pub"));
    const worker = parseWorkerConfig({ coordinatorUrl: "http://x.internal", keyFile: "/k", workDir: join(root, "pad", "w"), warmDir: join(root, "pad", "warm"), limits: { minFreeDiskGb: 0 }, warmStore: { url, readKey: READ, signKeyFile: k("a.key"), verifyKeyFiles: [k("a.pub")] } });
    const src = join(root, "pad-src");
    mkdirSync(src);
    writeFileSync(join(src, "lib.rlib"), "built");
    // Zero blocks past the end marker, more than a pipe holds: zstd exits only once all of its output has been read.
    const tar = Buffer.concat([execFileSync("tar", ["-C", src, "-cf", "-", "."]), Buffer.alloc(4 << 20)]);
    const blob = execFileSync("zstd", ["-q", "-c"], { input: tar });
    const meta = { commit: "e".repeat(40), sha256: createHash("sha256").update(blob).digest("hex"), stored: Date.now(), bytes: tar.length };
    const signature = sign(null, signedText("pad", meta), worker.warmStore!.signKey!).toString("base64");
    const q = new URLSearchParams({ ...Object.fromEntries(Object.entries(meta).map(([n, v]) => [n, String(v)])), signature });
    const put = await fetch(`${url}/store/pad?${q}`, { method: "PUT", headers: { authorization: `Bearer ${WRITE}`, "content-type": "application/zstd" }, body: blob });
    assert.equal(put.status, 200, await put.text());
    const log: string[] = [];
    await downloadWarm(worker, "pad", (m) => log.push(m));
    const out = join(root, "pad-out");
    mkdirSync(out);
    assert.equal(await copyWarm(worker, "pad", out), true, log.join("\n"));
    assert.equal(readFileSync(join(out, "lib.rlib"), "utf8"), "built");
  } finally {
    store.closeAllConnections();
    await new Promise((r) => store.close(r));
  }
});

test("a blob stream past its recorded size fails", async () => {
  const { Readable } = await import("node:stream");
  const { pipeline } = await import("node:stream/promises");
  const sink = new (await import("node:stream")).Writable({ write(_c, _e, cb) { cb(); } });
  await pipeline(Readable.from([Buffer.alloc(10)]), byteCap(10), sink);
  await assert.rejects(pipeline(Readable.from([Buffer.alloc(6), Buffer.alloc(6)]), byteCap(10), new (await import("node:stream")).Writable({ write(_c, _e, cb) { cb(); } })), /larger than its record/);
});
