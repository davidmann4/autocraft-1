import assert from "node:assert/strict";
import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { TokenBox } from "../src/dash/server/crypto.ts";
import { resealLegacyValues } from "../src/dash/server/reseal.ts";
import { addLogin, checkGithubId } from "../src/access.ts";
import { setGithubIdentity } from "../src/github/identity.ts";
import { parseWorkerConfig } from "../src/worker/config.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

const KEY = "hardening-session-key-hardening-0";

function sealLegacy(plain: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", Buffer.from(hkdfSync("sha256", KEY, "craft-automation", "github-token", 32)), iv);
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
}

test("legacy-sealed values are re-sealed at startup, then open; open alone refuses them", async () => {
  mkdirSync(SCRATCH, { recursive: true });
  const db = await connectDb(join(SCRATCH, `hardening-a-${process.pid}.db`));
  const box = new TokenBox(KEY);
  const legacy = sealLegacy("{}", "user_tokens:alice");
  assert.equal(box.open(legacy, "user_tokens:alice"), null);
  await db.run(db.k.insertInto("user_tokens").values({ login: "Alice", github_id: 1, token_enc: legacy, version: 1, updated_at: "x", status: "ok" }));
  assert.deepEqual(await resealLegacyValues(db, box), { user_tokens: 1 });
  const now = (await db.get(db.k.selectFrom("user_tokens").select("token_enc")))!.token_enc;
  assert.equal(box.open(now, "user_tokens:alice"), "{}");
  assert.deepEqual(await resealLegacyValues(db, box), {});
  await db.close();
});

test("switching the identity queues revocation of stored user tokens", async () => {
  mkdirSync(SCRATCH, { recursive: true });
  const db = await connectDb(join(SCRATCH, `hardening-b-${process.pid}.db`));
  await db.run(db.k.insertInto("user_tokens").values({ login: "bob", github_id: 2, token_enc: "enc", version: 1, updated_at: "x", status: "ok" }));
  assert.equal(await setGithubIdentity(db, "op", "app"), true);
  assert.equal((await db.get(db.k.selectFrom("user_tokens").select((eb) => eb.fn.countAll<number>().as("n"))))!.n, 0);
  assert.equal((await db.get(db.k.selectFrom("user_token_revocations").select((eb) => eb.fn.countAll<number>().as("n")).where("login", "=", "bob")))!.n, 1);
  await db.close();
});

test("an access entry added with a GitHub id rejects another id at sign-in", async () => {
  mkdirSync(SCRATCH, { recursive: true });
  const db = await connectDb(join(SCRATCH, `hardening-c-${process.pid}.db`));
  await addLogin(db, "op", "carol", "viewer", null, 7);
  assert.equal(await checkGithubId(db, "carol", 8), "mismatch");
  assert.equal(await checkGithubId(db, "carol", 7), "ok");
  await db.close();
});

test("coordinatorUrl: plain http only for loopback, private and cluster-internal hosts", () => {
  const cfg = (coordinatorUrl: string) => parseWorkerConfig({ coordinatorUrl, keyFile: "/k", workDir: "/w" });
  for (const u of ["http://127.0.0.1:8981", "http://localhost:1", "http://[::1]:1", "http://10.1.2.3", "http://172.20.0.1", "http://192.168.1.5", "http://100.64.0.9", "http://runner.svc", "http://a.b.cluster.local", "http://x.internal", "https://example.com"]) {
    assert.doesNotThrow(() => cfg(u), u);
  }
  for (const u of ["http://example.com", "http://8.8.8.8", "http://172.32.0.1", "http://100.128.0.1", "http://coordinator.invalid", "http://coord"]) {
    assert.throws(() => cfg(u), /plain http/, u);
  }
});
