// The user-token vault: refresh races (two vaults, a session and the vault), healing from a session, a final refresh failure, and removal.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { addLogin, removeLogin } from "../src/access.ts";
import { pkceChallenge, sha256hex, TokenBox } from "../src/dash/server/crypto.ts";
import { FakeProvider, type Tokens } from "../src/dash/server/provider.ts";
import { accessToken, createSession, openTokens, sealTokens } from "../src/dash/server/sessions.ts";
import { dropSessionTokens, readUserTokens, saveUserTokens } from "../src/dash/server/user-tokens.ts";
import { Vault } from "../src/github/vault.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

const REDIRECT = "http://localhost/cb";

async function setup(name: string) {
  mkdirSync(SCRATCH, { recursive: true });
  const db = await connectDb(join(SCRATCH, `${name}-${process.pid}.db`));
  const box = new TokenBox("test-session-key-test-session-key-0");
  const provider = new FakeProvider(null);
  const signIn = async (login: string, ttlMs: number): Promise<Tokens> => {
    provider.tokenTtlMs = ttlMs;
    const t = (await provider.exchange(provider.issueCode(login, pkceChallenge("v"), REDIRECT), "v", REDIRECT))!;
    provider.tokenTtlMs = 8 * 3_600_000;
    await saveUserTokens(db, box, login, 1, t);
    return t;
  };
  return { db, box, provider, signIn };
}

test("two vaults refreshing one expired token end with one refresh and the same pair, and the session keeps running", async () => {
  const { db, box, provider, signIn } = await setup("vault-race");
  const old = await signIn("example-user", -1000);
  const sid = await createSession(db, box, "example-user", old, undefined);
  const a = new Vault(db, box, provider);
  const b = new Vault(db, box, provider);
  const [ra, rb] = await Promise.all([a.userToken("example-user"), b.userToken("example-user")]);
  assert.ok(ra.ok && rb.ok);
  assert.equal(provider.refreshes, 1);
  assert.equal(ra.access, rb.access);
  assert.notEqual(ra.access, old.access);
  // The session held the same refresh token, so it took the new pair instead of being left with a dead one.
  const s = (await db.get(db.k.selectFrom("sessions").select(["id_hash", "token_enc"])))!;
  assert.equal(openTokens(box, s.token_enc!, s.id_hash)?.access, ra.access);
  assert.ok(sid);
});

// Under the app identity the sessions hold tokens of the same app as the row.
const useApp = (db: Awaited<ReturnType<typeof setup>>["db"]) => db.run(db.k.insertInto("settings").values({ key: "github_identity", value: "app" }));

test("a session and the vault refreshing one login at once make one endpoint call and share the new pair", async () => {
  const { db, box, provider, signIn } = await setup("vault-session-race");
  await useApp(db);
  const old = await signIn("example-user", -1000);
  const idHash = sha256hex(await createSession(db, box, "example-user", old, undefined));
  // Slow enough that both callers are past their first read before either refresh returns.
  provider.refreshDelayMs = 50;
  // The endpoint call runs outside any transaction, so it holds no writer lock: an unrelated write finishes while the
  // endpoint has not answered yet.
  let inTransaction = false;
  provider.duringRefresh = () => (inTransaction ||= db.inTransaction(), Promise.race([
    db.run(db.k.insertInto("settings").values({ key: "unrelated", value: "1" })).then(() => undefined),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error("a write waited for the refresh")), 3000)),
  ]));
  const [fromVault, fromSession] = await Promise.all([new Vault(db, box, provider).userToken("example-user"), accessToken(db, box, provider, idHash, true)]);
  assert.equal(provider.refreshCalls, 1);
  assert.ok(fromVault.ok);
  assert.equal(inTransaction, false);
  assert.ok(await db.get(db.k.selectFrom("settings").select("value").where("key", "=", "unrelated")));
  assert.notEqual(fromVault.access, old.access);
  assert.equal(fromSession, fromVault.access);
  const row = (await readUserTokens(db, box, "example-user"))!;
  assert.equal(row.status, "ok");
  assert.equal(row.tokens?.access, fromVault.access);
});

test("a refused refresh heals the row from a session holding a newer token set instead of failing", async () => {
  const { db, box, provider, signIn } = await setup("vault-heal");
  await useApp(db);
  const old = await signIn("example-user", -1000);
  const idHash = sha256hex(await createSession(db, box, "example-user", old, undefined));
  // A refresh that stored the new pair in the session only: the row keeps the refresh token GitHub has already used.
  const next = (await provider.refresh(old.refresh!)) as Tokens;
  await db.run(db.k.updateTable("sessions").set({ token_enc: sealTokens(box, next, idHash) }).where("id_hash", "=", idHash));
  const r = await new Vault(db, box, provider).userToken("example-user");
  assert.deepEqual(r, { ok: true, access: next.access });
  const row = (await readUserTokens(db, box, "example-user"))!;
  assert.equal(row.status, "ok");
  assert.equal(row.tokens?.refresh, next.refresh);
});

test("a refresh GitHub rejects marks the row and answers needs-sign-in, never another identity", async () => {
  const { db, box, provider, signIn } = await setup("vault-fail");
  await signIn("example-user", -1000);
  provider.rejectRefresh = true;
  const v = new Vault(db, box, provider);
  assert.deepEqual(await v.userToken("example-user"), { ok: false, needsSignIn: true, why: "refresh-failed" });
  const failed = (await db.get(db.k.selectFrom("user_tokens").select(["status", "refresh_error"])))!;
  assert.equal(failed.status, "refresh-failed");
  assert.match(failed.refresh_error ?? "", /^bad_refresh_token: /);
  provider.rejectRefresh = false;
  assert.equal((await v.userToken("example-user")).ok, false);
  assert.equal(provider.refreshes, 0);
  assert.deepEqual(await v.userToken("nobody"), { ok: false, needsSignIn: true, why: "no-token" });
  // Signing in again makes the token usable.
  await signIn("example-user", 8 * 3_600_000);
  assert.equal((await v.userToken("example-user")).ok, true);
});

test("removing a login deletes its token row and the sweep revokes the grant at the provider", async () => {
  const { db, box, provider, signIn } = await setup("vault-remove");
  await addLogin(db, "op", "example-user", "viewer", null);
  const t = await signIn("example-user", 8 * 3_600_000);
  await removeLogin(db, "op", "example-user");
  assert.equal(await db.get(db.k.selectFrom("user_tokens").select((eb) => eb.lit(1).as("one"))), undefined);
  const v = new Vault(db, box, provider);
  assert.equal(await v.sweepRevocations(), 1);
  assert.deepEqual(provider.revokedGrants, [t.access]);
  assert.equal(await db.get(db.k.selectFrom("user_token_revocations").select((eb) => eb.lit(1).as("one"))), undefined);
});

test("revoking one session revokes only its token and keeps the login's newer sign-in", async () => {
  const { db, box, provider, signIn } = await setup("vault-session");
  await addLogin(db, "op", "example-user", "viewer", null);
  // The older session's token set expired; the sweep refreshes it once before revoking.
  const a = await signIn("example-user", -1000);
  await createSession(db, box, "example-user", a, undefined);
  const s = (await db.get(db.k.selectFrom("sessions").select(["id_hash", "token_enc"])))!;
  const b = await signIn("example-user", 8 * 3_600_000);
  assert.ok(await dropSessionTokens(db, "example-user", s.id_hash, s.token_enc!));
  const v = new Vault(db, box, provider);
  assert.equal(await v.sweepRevocations(), 1);
  assert.deepEqual(provider.revokedGrants, []);
  assert.equal(provider.revoked.length, 1);
  assert.notEqual(provider.revoked[0], a.access);
  assert.equal((await v.userToken("example-user")).ok, true);
  assert.equal(openTokens(box, (await db.get(db.k.selectFrom("user_tokens").select("token_enc")))!.token_enc, "user_tokens:example-user")?.access, b.access);
  assert.equal(await db.get(db.k.selectFrom("user_token_revocations").select((eb) => eb.lit(1).as("one"))), undefined);
});
