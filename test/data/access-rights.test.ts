// The access module's roles, permissions, act rule, Discord links and overrides (M03): behaviour of the writers that changed
// shape, and statement counts of the set loaders.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import * as access from "../../src/data/access/index.ts";
import { expectFlat } from "../helpers/query-count.ts";
import { both, openApp } from "./planner-helpers.ts";

const AT = "2026-01-01T00:00:00.000Z";
const names = (n: number): string[] => Array.from({ length: n }, (_, i) => `User${i}`);

async function seedAccess(db: Db, logins: string[], role = "maintainer"): Promise<void> {
  const q = queryDb(db);
  if (logins.length) await q.run(q.k.insertInto("main.access").values(logins.map((login) => ({ login, role, added_by: "t", added_at: AT }))));
}

/** A fresh database per size, so both sizes start from the same state. */
function unit(run: (db: Db, n: number) => Promise<unknown>, seed?: (db: Db, n: number) => Promise<void>) {
  return async (n: number) => {
    const o = await openApp("sqlite");
    await seed?.(o.db, n);
    return { db: o.db, run: () => run(o.db, n), close: () => o.t.close() };
  };
}

both("bindGithubId binds once and then compares, whatever the letter case of the login", async ({ db }) => {
  await seedAccess(db, ["Alice"]);
  assert.equal(await access.bindGithubId(db, "alice", 7), "bound");
  assert.equal(await access.bindGithubId(db, "ALICE", 7), "ok");
  assert.equal(await access.bindGithubId(db, "Alice", 8), "mismatch");
  assert.equal(await access.bindGithubId(db, "nobody", 7), "mismatch");
  assert.equal((await access.actorOf(db, "alice", 7))?.login, "Alice");
  assert.equal(await access.actorOf(db, "alice", 8), null);
});

both("loadAccess and loginsWithRole answer for logins in any letter case", async ({ db }) => {
  await seedAccess(db, ["Alice"], "operator");
  await seedAccess(db, ["Bob"], "viewer");
  const m = await access.loadAccess(db, ["ALICE", "bob", "zed"]);
  assert.deepEqual([...m.keys()].sort(), ["alice", "bob"]);
  assert.deepEqual(await access.loginsWithRole(db, ["operator"]), ["Alice"]);
  assert.equal(await access.countOperators(db), 1);
});

both("savePermissions upserts in one batch and keeps the last of a repeated pair", async ({ db }) => {
  await access.savePermissions(db, [
    { login: "Alice", repo: "app", permission: "read", checkedAt: AT },
    { login: "alice", repo: "app", permission: "write", checkedAt: AT },
    { login: "Bob", repo: "app", permission: "admin", checkedAt: AT },
  ]);
  await access.savePermissions(db, [{ login: "bob", repo: "app", permission: "none", checkedAt: "2026-02-01T00:00:00.000Z" }]);
  const m = await access.loadPermissions(db, [{ login: "ALICE", repo: "app" }, { login: "Bob", repo: "app" }, { login: "bob", repo: "lib" }]);
  assert.equal(m.get(access.permKey("alice", "app"))?.permission, "write");
  assert.equal(m.get(access.permKey("bob", "app"))?.permission, "none");
  assert.equal(m.size, 2);
  assert.equal(await access.endPermissions(db, ["ALICE"]), 1);
});

both("canActMany: an operator needs a write permission too, a maintainer's stale one is read again", async ({ db }) => {
  await seedAccess(db, ["Op"], "operator");
  await seedAccess(db, ["Mia"]);
  await seedAccess(db, ["Vic"], "viewer");
  const now = Date.parse(AT) + 5 * 60_000;
  await access.savePermissions(db, [
    { login: "Mia", repo: "app", permission: "write", checkedAt: AT },
    { login: "Vic", repo: "app", permission: "admin", checkedAt: AT },
    { login: "Op", repo: "ro", permission: "read", checkedAt: AT },
  ]);
  const pairs = [{ login: "op", repo: "app" }, { login: "mia", repo: "app" }, { login: "vic", repo: "app" }, { login: "op", repo: "ro" }, { login: null, repo: "app" }, { login: "ghost", repo: "app" }];
  const run = (o: { maxAgeMs: number }) => access.canActMany(db, pairs, { identity: "app", mode: "cached", now, ...o });
  const v = await run({ maxAgeMs: 10 * 60_000 });
  const why = (login: string, repo: string) => { const x = v.get(access.permKey(login, repo))!; return x.ok ? "ok" : x.why; };
  assert.deepEqual([why("op", "app"), why("mia", "app"), why("vic", "app"), why("op", "ro"), why("", "app"), why("ghost", "app")], ["stale", "ok", "no-role", "no-write", "no-login", "no-login"]);
  const old = await run({ maxAgeMs: 60_000 });
  assert.equal(old.get(access.permKey("mia", "app")) && (old.get(access.permKey("mia", "app")) as { ok: boolean; why?: string }).why, "stale");
  const box = await access.canActMany(db, pairs, { identity: "box", mode: "cached", now, maxAgeMs: 10 * 60_000 });
  assert.deepEqual(box.get(access.permKey("mia", "app")), { ok: false, why: "box-identity" });
});

both("an earlier approval ends only on the role or GitHub's own answer; unread or stale access is unknown", async ({ db }) => {
  await seedAccess(db, ["Op"], "operator");
  await seedAccess(db, ["Mia"]);
  await seedAccess(db, ["Vic"], "viewer");
  const now = Date.parse(AT) + 30 * 60_000;
  const at = (min: number) => new Date(now - min * 60_000).toISOString();
  await access.savePermissions(db, [
    { login: "Mia", repo: "app", permission: "write", checkedAt: at(50) }, { login: "Mia", repo: "old", permission: "write", checkedAt: at(70) },
    { login: "Mia", repo: "no", permission: "read", checkedAt: at(5) }, { login: "Mia", repo: "was", permission: "read", checkedAt: at(15) },
    { login: "Vic", repo: "app", permission: "admin", checkedAt: at(1) }, { login: "Op", repo: "no", permission: "none", checkedAt: at(1) },
  ]);
  const pairs = [["Mia", "app"], ["Mia", "old"], ["Mia", "no"], ["Mia", "was"], ["Mia", "unread"], ["Vic", "app"], ["Op", "no"], ["Op", "app"], ["ghost", "app"]].map(([login, repo]) => ({ login: login!, repo: repo! }));
  const v = await access.standings(db, pairs, { identity: "app", now });
  assert.deepEqual(pairs.map((p) => v.get(access.permKey(p.login, p.repo))), ["yes", "unknown", "no", "unknown", "unknown", "no", "no", "unknown", "no"]);
  const box = await access.standings(db, pairs, { identity: "box", now });
  assert.deepEqual([box.get(access.permKey("Mia", "app")), box.get(access.permKey("Vic", "app"))], ["unknown", "no"]);
});

both("canAct refuses in the order login, role, live write, identity", async ({ db }) => {
  await seedAccess(db, ["Mia"]);
  await seedAccess(db, ["Vic"], "viewer");
  let asked = 0;
  const actor = (login: string | null, write: boolean) => ({ login, canWrite: async () => { asked++; return write; } });
  assert.equal(await access.canAct(db, actor(null, true), "app", { identity: "box" }), "no-login");
  assert.equal(await access.canAct(db, actor("ghost", true), "app", { identity: "box" }), "no-login");
  assert.equal(await access.canAct(db, actor("vic", true), "app", { identity: "box" }), "no-role");
  assert.equal(asked, 0);
  assert.equal(await access.canAct(db, actor("mia", false), "app", { identity: "box" }), "no-write");
  assert.equal(await access.canAct(db, actor("mia", true), "app", { identity: "box" }), "box-identity");
  assert.equal(await access.canAct(db, actor("mia", true), "app", { identity: "app" }), null);
});

both("a link code is spent once, expires, and replaces an earlier link of the Discord account", async ({ db }) => {
  await access.makeLinkCode(db, { codeHash: "c1", login: "Mia", expiresAt: "2026-01-01T00:10:00.000Z" }, AT);
  await access.makeLinkCode(db, { codeHash: "c2", login: "Mia", expiresAt: "2026-01-01T00:10:00.000Z" }, AT);
  assert.equal(await access.redeemLinkCode(db, "c1", "u1", AT), null);
  assert.equal(await access.redeemLinkCode(db, "c2", "u1", AT), "Mia");
  assert.equal(await access.redeemLinkCode(db, "c2", "u1", AT), null);
  await access.makeLinkCode(db, { codeHash: "c3", login: "Cy", expiresAt: "2026-01-01T00:10:00.000Z" }, AT);
  assert.equal(await access.redeemLinkCode(db, "c3", "u1", AT), "Cy");
  assert.equal((await access.loginsOfLinks(db, ["u1", "u2"])).get("u1"), "Cy");
  await access.makeLinkCode(db, { codeHash: "c4", login: "Cy", expiresAt: "2026-01-01T00:00:00.000Z" }, AT);
  assert.equal(await access.redeemLinkCode(db, "c4", "u2", "2026-01-01T00:00:01.000Z"), null);
  assert.equal((await access.linkedSince(db, ["cy"])).get("cy"), AT);
  assert.equal(await access.unlinkRow(db, "u1"), "Cy");
  assert.equal(await access.unlinkRow(db, "u1"), null);
});

both("overrides load by login without letter case", async ({ db }) => {
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.whitelist_overrides").values([{ login: "Zoe", status: "deny", by: "t", at: AT }, { login: "Kim", status: "allow", github_id: 5, by: "t", at: AT }]));
  assert.deepEqual([...(await access.loadOverrides(db, ["zoe", "KIM", "x"])).keys()].sort(), ["kim", "zoe"]);
  assert.equal((await access.loadOverrides(db, ["kim"])).get("kim")?.githubId, 5);
  assert.equal((await access.loadOverrides(db, "all")).size, 2);
  assert.equal((await access.listOverrides(db)).length, 2);
});

test("set loaders issue the same statements for a few keys and for many", async () => {
  await expectFlat(unit((db, n) => access.loadAccess(db, names(n)), (db, n) => seedAccess(db, names(n))), 3, 300);
  await expectFlat(unit((db, n) => access.loadPermissions(db, names(n).map((login) => ({ login, repo: "app" })))), 3, 300);
  await expectFlat(unit((db, n) => access.loadPermissionsOfLogins(db, names(n))), 3, 300);
  await expectFlat(unit((db, n) => access.loadPermissionsForRepos(db, "Mia", names(n))), 3, 300);
  await expectFlat(unit((db, n) => access.loadActFacts(db, names(n).map((login) => ({ login, repo: "app" })))), 3, 300);
  await expectFlat(unit((db, n) => access.canActMany(db, names(n).map((login) => ({ login, repo: "app" })), { identity: "app", mode: "cached", maxAgeMs: 1000 })), 3, 300);
  await expectFlat(unit((db, n) => access.loadPermissionDenials(db, names(n), Date.now())), 3, 300);
  await expectFlat(unit((db, n) => access.savePermissions(db, names(n).map((login) => ({ login, repo: "app", permission: "write", checkedAt: AT })))), 3, 300);
  await expectFlat(unit((db, n) => access.endPermissions(db, names(n))), 3, 300);
  await expectFlat(unit((db, n) => access.loginsOfLinks(db, names(n))), 3, 300);
  await expectFlat(unit((db, n) => access.linkedSince(db, names(n))), 3, 300);
  await expectFlat(unit((db, n) => access.unlinkLogins(db, names(n))), 3, 300);
  await expectFlat(unit((db, n) => access.forgetLinks(db, names(n))), 3, 300);
  await expectFlat(unit((db, n) => access.loadOverrides(db, names(n))), 3, 300);
});
