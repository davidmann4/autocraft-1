// access module part b: user-token compare-and-set writers, sealed-store reseal, token limits, and statement counts of the set writers
// (SQLite; Postgres when AUTOCRAFT_TEST_PG_URL is set).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db, Dialect } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import { TEST_PG_URL, testDatabase } from "../test-db.ts";
import { expectFlat } from "../helpers/query-count.ts";
import * as access from "../../src/data/access/index.ts";
import type { Sealed } from "../../src/data/access/index.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T00:00:00.000Z";
const FAR = "2099-01-01T00:00:00.000Z";
const sealed = (s: string) => s as Sealed;

async function withDb(dialect: Dialect, fn: (db: Db) => Promise<unknown>): Promise<unknown> {
  const t = await testDatabase("", dialect);
  try { return await fn(await t.open({ app: true })); } finally { await t.close(); }
}

function both(name: string, fn: (db: Db) => Promise<unknown>): void {
  test(name, async () => {
    const lite = await withDb("sqlite", fn);
    if (TEST_PG_URL) assert.deepEqual(await withDb("postgres", fn), lite);
  });
}

async function seedAccess(db: Db, logins: string[]): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.insertInto("access").values(logins.map((login) => ({ login, role: "maintainer", added_by: "t", added_at: T0 }))));
}

both("user token writers: a swap or failure from a stale version changes nothing; a new sign-in heals a failed row", async (db) => {
  const q = queryDb(db);
  await access.saveUserToken(db, { login: "Alice", githubId: 1, sealed: sealed("s1"), now: T0 });
  const v1 = (await access.loadUserTokenSealed(db, "alice"))!;
  assert.equal(v1.status, "ok");
  assert.ok(await access.swapUserToken(db, "alice", v1.version, sealed("s2"), T1));
  assert.ok(!await access.swapUserToken(db, "alice", v1.version, sealed("lost"), T1), "the old version lost");
  const v2 = (await access.loadUserTokenSealed(db, "alice"))!;
  assert.equal(v2.sealed, "s2");
  assert.ok(v2.version > v1.version);

  assert.ok(!await access.failUserToken(db, "alice", v1.version, T1, "bad_refresh_token"), "stale failure changes nothing");
  assert.ok(await access.failUserToken(db, "alice", v2.version, T1, "bad_refresh_token: used"));
  const failed = (await access.loadUserTokenSealed(db, "alice"))!;
  assert.equal(failed.status, "refresh-failed");
  assert.equal((await q.get(q.k.selectFrom("user_tokens").select("refresh_error").where("login", "=", "alice")))!.refresh_error, "bad_refresh_token: used");
  assert.ok(!await access.failUserToken(db, "alice", failed.version, T1, "again"), "a failed row is not failed twice");
  assert.equal((await access.loadUserTokenStatus(db, ["ALICE", "nobody"])).get("alice"), "refresh-failed");

  // a swap heals a failed row and clears the error; a sign-in does too
  assert.ok(await access.swapUserToken(db, "alice", failed.version, sealed("s3"), T1));
  assert.equal((await access.loadUserTokenSealed(db, "alice"))!.status, "ok");
  assert.equal((await q.get(q.k.selectFrom("user_tokens").select("refresh_error").where("login", "=", "alice")))!.refresh_error, null);

  const v3 = (await access.loadUserTokenSealed(db, "alice"))!;
  await access.deleteUserTokenIf(db, "alice", v3.version - 1);
  assert.ok(await access.loadUserTokenSealed(db, "alice"), "a row at another version stays");
  await access.deleteUserTokenIf(db, "alice", v3.version);
  assert.equal(await access.loadUserTokenSealed(db, "alice"), null);
});

both("session token swap changes only rows still holding the old value", async (db) => {
  await seedAccess(db, ["alice"]);
  for (const id of ["a", "b", "c"]) await access.addSession(db, { idHash: id, login: "alice", csrf: "x", sealedTokens: sealed(`old-${id}`), now: T0, expiresAt: FAR, userAgent: null });
  const changed = await db.write(() => access.swapSessionTokens(db, [
    { idHash: "a", old: sealed("old-a"), sealed: sealed("new-a") },
    { idHash: "b", old: sealed("stale"), sealed: sealed("new-b") },
    { idHash: "c", old: sealed("old-c"), sealed: sealed("new-c") },
  ]));
  assert.equal(changed, 2);
  const now = Object.fromEntries((await access.loadSessionSealedOf(db, "alice")).map((s) => [s.idHash, s.sealed]));
  assert.deepEqual(now, { a: "new-a", b: "old-b", c: "new-c" });
});

both("reseal: all four stores list and swap by compare-and-set", async (db) => {
  await seedAccess(db, ["alice"]);
  await access.addSession(db, { idHash: "s", login: "alice", csrf: "x", sealedTokens: sealed("o-s"), now: T0, expiresAt: FAR, userAgent: null });
  await access.saveUserToken(db, { login: "alice", githubId: 1, sealed: sealed("o-u"), now: T0 });
  await access.queueSessionTokenRevocation(db, [{ login: "alice", sealed: sealed("o-r"), aad: "s", now: T0 }]);
  await access.saveReporter(db, { reporter: "rep", githubId: 2, login: "bob", sealed: sealed("o-p"), now: T0 });
  const rows = await access.listSealedRows(db);
  assert.deepEqual(rows.map((r) => r.store).sort(), ["reporter_tokens", "sessions", "user_token_revocations", "user_tokens"]);
  const counts = await access.swapSealedRows(db, [
    ...rows.map((r) => ({ store: r.store, id: r.id, old: r.sealed, sealed: sealed(`n-${r.store}`) })),
    { store: "sessions" as const, id: "s", old: sealed("stale"), sealed: sealed("x") },
  ]);
  assert.deepEqual(counts, { sessions: 1, user_tokens: 1, user_token_revocations: 1, reporter_tokens: 1 });
  assert.ok((await access.listSealedRows(db)).every((r) => r.sealed === `n-${r.store}`));
});

both("a login holds at most five live tokens per kind; runner login approval inserts the token once", async (db) => {
  await seedAccess(db, ["alice"]);
  const add = (kind: string, hash: string) => access.addToken(db, { login: "alice", hash, label: null, kind, scopes: { canAnswer: false, canAgent: true }, expiresAt: FAR });
  for (let i = 0; i < 5; i++) assert.ok(await add("runner", `h${i}`));
  assert.equal(await add("runner", "h5"), null);
  assert.ok(await add("connector", "c0"), "another kind has its own limit");
  assert.equal((await access.listTokens(db, "Alice", "runner")).length, 5);
  await access.revokeToken(db, "alice", (await access.listTokens(db, "alice", "runner"))[0]!.id, "runner");
  assert.ok(await add("runner", "h6"));

  await access.addRunnerLogin(db, { user_code: "ABCDEFGH", secret_hash: "sec", label: "box", machine: null, ip: "1.2.3.4", helper_version: "1", created_at: 1000, expires_at: 2_000_000, want_agent: 1, want_answer: 0 });
  assert.equal(await access.addRunnerLogin(db, { user_code: "ABCDEFGH", secret_hash: "sec2", label: null, machine: null, ip: null, helper_version: null, created_at: 1000, expires_at: 2_000_000, want_agent: 1, want_answer: 0 }), "code-taken");
  await assert.rejects(access.approveRunnerLogin(db, "alice", "ABCDEFGH", { label: null, scopes: { canAgent: true }, nowMs: 1500, checkAddress: () => {} }), access.TokenLimitError);
  await access.revokeToken(db, "alice", (await access.listTokens(db, "alice", "runner"))[0]!.id, "runner");
  const ok = await access.approveRunnerLogin(db, "alice", "ABCDEFGH", { label: null, scopes: { canAgent: true }, nowMs: 1500, checkAddress: () => {} });
  assert.equal(ok?.token.label, "box");
  assert.equal(await access.approveRunnerLogin(db, "alice", "ABCDEFGH", { label: null, scopes: {}, nowMs: 1500, checkAddress: () => {} }), null, "single use");
  assert.deepEqual(await access.pollRunnerLogin(db, "sec", 1600), { state: "approved" });
});

// The set writers issue the same statements whatever the number of rows.
test("set writers: statements do not grow with the number of rows", async () => {
  const unit = (run: (db: Db, n: number) => Promise<unknown>, seed: (db: Db, n: number) => Promise<void>) => async (n: number) => {
    const t = await testDatabase("", "sqlite");
    const db = await t.open({ app: true });
    await seed(db, n);
    return { db, run: () => run(db, n), close: () => t.close() };
  };
  const ids = (n: number) => Array.from({ length: n }, (_, i) => i);
  const seedAll = async (db: Db, n: number) => {
    await seedAccess(db, ids(n).map((i) => `u${i}`));
    const q = queryDb(db);
    for (const b of [ids(n)]) {
      await q.run(q.k.insertInto("sessions").values(b.map((i) => ({ id_hash: `s${i}`, login: `u${i}`, csrf: "c", token_enc: `old${i}`, created_at: T0, last_seen: T0, expires_at: FAR, user_agent: null }))));
      await q.run(q.k.insertInto("user_tokens").values(b.map((i) => ({ login: `u${i}`, github_id: i, token_enc: `u${i}`, updated_at: T0 }))));
      await q.run(q.k.insertInto("mcp_tokens").values(b.map((i) => ({ login: `u${i}`, token_hash: `h${i}`, created_at: T0, expires_at: FAR }))));
    }
  };
  await expectFlat(unit((db, n) => db.write(() => access.swapSessionTokens(db, ids(n).map((i) => ({ idHash: `s${i}`, old: sealed(`old${i}`), sealed: sealed(`new${i}`) })))), seedAll), 3, 40);
  await expectFlat(unit(async (db, n) => { await access.listSealedRows(db); await access.swapSealedRows(db, ids(n).map((i) => ({ store: "sessions" as const, id: `s${i}`, old: sealed(`old${i}`), sealed: sealed(`new${i}`) }))); }, seedAll), 3, 40);
  await expectFlat(unit((db, n) => access.dropUserTokens(db, ids(n).map((i) => `u${i}`)), seedAll), 3, 40);
  await expectFlat(unit((db, n) => access.endTokens(db, ids(n).map((i) => `u${i}`)), seedAll), 3, 40);
  await expectFlat(unit(async (db, n) => { await access.loadUserTokenStatus(db, ids(n).map((i) => `u${i}`)); }, seedAll), 3, 40);
  await expectFlat(unit(async (db, n) => { await access.addAllowedOwners(db, ids(n).map((i) => ({ login: `o${i}` })), "t"); }, async () => {}), 3, 40);
  await expectFlat(unit(async (db, n) => { await access.setAllowedOwnerAccounts(db, ids(n).map((i) => ({ login: `o${i}`, accountId: i + 1 }))); }, async (db, n) => { await access.addAllowedOwners(db, ids(n).map((i) => ({ login: `o${i}` })), "t"); }), 3, 40);
});

both("allowed owners: ids fill only where none is set; setup links end when revoked", async (db) => {
  await access.addAllowedOwners(db, [{ login: "Acme" }, { login: "beta", accountId: 7 }], "op");
  assert.equal((await access.addAllowedOwners(db, [{ login: "ACME" }, { login: "gamma" }], "op")).inserted.map((r) => r.login).join(), "gamma");
  await access.setAllowedOwnerAccounts(db, [{ login: "acme", accountId: 5 }, { login: "beta", accountId: 99 }]);
  const byLogin = Object.fromEntries((await access.listAllowedOwners(db)).map((r) => [r.login, r.account_id]));
  assert.deepEqual(byLogin, { Acme: 5, beta: 7, gamma: null });

  await seedAccess(db, ["op"]);
  const q = queryDb(db);
  await q.run(q.k.updateTable("access").set({ role: "operator" }).where("login", "=", "op"));
  await access.createSetupLink(db, { id: "l1", org: "acme", created_by: "op", hash: "hh", created_at: T0, expires_at: FAR });
  assert.equal((await access.listOpenSetupLinks(db, T1)).length, 1);
  assert.equal((await access.loadOpenSetupLink(db, { hash: "hh" }, T1))?.id, "l1");
  assert.equal(await access.endSetupLinksOf(db, "OP", T1), 1);
  assert.equal(await access.loadOpenSetupLink(db, { id: "l1" }, T1), null);
  assert.equal(await access.revokeSetupLink(db, "l1"), null, "already revoked");
});

both("sessions: the live role comes from access, an over-age session is deleted, an OAuth state is taken once only with the cookie", async (db) => {
  await seedAccess(db, ["alice"]);
  const now = Date.parse("2026-02-01T00:00:00.000Z");
  const at = (ms: number) => new Date(ms).toISOString();
  await access.addSession(db, { idHash: "fresh", login: "alice", csrf: "x", sealedTokens: null, now: at(now - 120_000), expiresAt: at(now + 1e9), userAgent: "ua" });
  await access.addSession(db, { idHash: "old", login: "alice", csrf: "x", sealedTokens: null, now: at(now - 40 * 86_400_000), expiresAt: at(now + 1e9), userAgent: null });
  const s = (await access.loadSession(db, "fresh", { now }))!;
  assert.equal(s.role, "maintainer");
  assert.equal(await access.loadSession(db, "old", { now }), null);
  assert.equal(await access.loadSession(db, "old", { now }), null);
  assert.ok((await access.listSessions(db, now)).every((x) => x.id_hash !== "old"));
  assert.ok(Date.parse((await access.loadSession(db, "fresh", { now }))!.last_seen) >= now, "last_seen moved forward");
  assert.ok((await access.endSessionById(db, s.rowid))?.idHash === "fresh");
  assert.equal(await access.loadSession(db, "fresh", { now }), null);

  await access.addOauthState(db, { state: "st", verifier: "v", returnTo: "/", identity: "app", createdAt: at(now) });
  assert.ok(await access.takeOauthState(db, "st", { cookieMatches: false }));
  assert.ok(await access.takeOauthState(db, "st", { cookieMatches: true }), "a mismatched cookie leaves the state");
  assert.equal(await access.takeOauthState(db, "st", { cookieMatches: true }), null);
});
