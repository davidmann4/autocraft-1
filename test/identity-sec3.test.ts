// A whitelist tier belongs to a GitHub account and the pipeline's own tier to heads it pushed; removing an operator ends what acts as them.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { addLogin, removeLogin, setRole } from "../src/access.ts";
import { backfillAuthorIds } from "../src/author-ids.ts";
import { loadPrFact } from "../src/core/facts.ts";
import { createLink, openLinks } from "../src/dash/server/github-setup.ts";
import { writeItemNode } from "../src/mirror.ts";
import { contributors, isWhitelisted, setOverride, tierKey, tiersOf } from "../src/whitelist.ts";
import { SCRATCH } from "./scratch.ts";
import { T0, world, type World } from "./world-db.ts";
import { connectDb } from "./helpers/raw-db.ts";

let current: World | null = null;
afterEach(() => current?.close());

const fresh = async () => {
  mkdirSync(SCRATCH, { recursive: true });
  return await connectDb(join(mkdtempSync(join(SCRATCH, "identity-")), "m.db"));
};
const issue = (number: number, login: string, id: number) => ({
  __typename: "Issue", number, state: "OPEN", title: "t", body: "", url: `https://github.com/storytold/r/issues/${number}`,
  author: { __typename: "User", login, databaseId: id }, authorAssociation: "NONE", createdAt: T0, updatedAt: T0, closedAt: null, stateReason: null, repository: { name: "r", owner: { login: "storytold" } },
});

test("history and an allow count only for their own account, and the pipeline's own PR only at a head it pushed", async () => {
  const db = await fresh();
  const tier = async (login: string, id: number | null) => (await tiersOf(db, [{ login, id }])).get(tierKey({ login, id }));
  for (let i = 1; i <= 6; i++) await db.run(db.k.insertInto("items").values({ repo: "r", number: i, kind: "pr", state: "MERGED", title: "t", author: "old-dev", created_at: "2026-01-01T00:00:00Z", merged_at: "2026-01-02T00:00:00Z" }));
  // A new holder of the login writes an issue before the history is bound: no binding, and no tier for anyone while unbound.
  await writeItemNode(db, "r", issue(50, "old-dev", 999));
  assert.deepEqual(await db.all(db.k.selectFrom("author_ids").select("id").where("login", "=", "old-dev")), []);
  assert.equal(await tier("old-dev", 999), "not");
  const client = { spent: 0, remaining: null, async query() { return { p0: { pullRequest: { author: { __typename: "User", databaseId: 42 } } } }; } };
  await backfillAuthorIds(db, client);
  assert.equal(await tier("old-dev", 42), "whitelisted");
  assert.equal(await tier("old-dev", 999), "not");
  assert.equal((await isWhitelisted(db, "old-dev", 999)).ok, false);
  // An allow given to account 42 under "alice" does not pass to account 999 under the same login; a deny holds in any letter case.
  await setOverride(db, "alice", "allow", null, "op", 42);
  await writeItemNode(db, "r", issue(51, "alice", 999));
  assert.equal(await tier("alice", 999), "not");
  assert.equal(await tier("alice", 42), "allow");
  assert.equal((await isWhitelisted(db, "alice", 999)).ok, false);
  const shown = (await contributors(db, { login: "alice" }))[0]!;
  assert.deepEqual([shown.override, shown.override_in_effect, shown.tier], ["allow", false, "not"]);
  await setOverride(db, "Old-Dev", "deny", null, "op", 42);
  assert.equal(await tier("old-dev", 42), "deny");

  const w = (current = await (await world()).repo());
  await w.db.run(w.db.k.insertInto("settings").values({ key: "pipeline_login", value: "pipeline-bot" }));
  await (await w.pr(9, { author: "pipeline-bot", head: "a".repeat(40) })).review(9, { verdict: "take", head: "a".repeat(40) });
  await w.db.run(w.db.k.insertInto("main_fixes").values({ repo: "app", head_sha: "m", check: "ci", verdict: "broken", state: "pr-opened", pr_number: 9, created_at: T0, updated_at: T0 }));
  const prTier = async () => (await loadPrFact(w.db, "app", 9))?.tier;
  assert.equal(await prTier(), "not", "no record that the pipeline pushed this head");
  await w.db.run(w.db.k.insertInto("own_commits").values({ repo: "app", sha: "a".repeat(40), action: "fixissue-push", at: T0 }));
  assert.equal(await prTier(), "whitelisted");
  await w.synced(9, "b".repeat(40));
  assert.equal(await prTier(), "not", "someone else pushed to the branch");
  await w.db.run(w.db.k.insertInto("fixups").values({ repo: "app", number: 9, from_head: "a".repeat(40), to_head: "c".repeat(40), state: "pushed", attempt: 1, created_at: T0 }));
  await w.synced(9, "c".repeat(40));
  assert.equal(await prTier(), "whitelisted", "our own fix-up of our commit");
});

test("the contributors list gives each author's repos and open count, and an override of a login with no PR only without a repo filter", async () => {
  const db = await fresh();
  const pr = (number: number, repo: string, author: string, state: string) => ({ repo, number, kind: "pr", state, title: "t", author, created_at: "2026-01-01T00:00:00Z" });
  await db.run(db.k.insertInto("items").values([pr(1, "b", "ann", "OPEN"), pr(2, "a", "ann", "OPEN"), pr(3, "a", "bob", "OPEN")]));
  await setOverride(db, "zed", "deny", null, "op");
  const byLogin = async (opts: { repo?: string; login?: string }) => Object.fromEntries((await contributors(db, opts)).map((c) => [c.login, [c.repos, c.open, c.override]]));
  assert.deepEqual(await byLogin({}), { ann: ["a,b", 2, null], bob: ["a", 1, null], zed: ["", 0, "deny"] });
  assert.deepEqual(await byLogin({ repo: "b" }), { ann: ["b", 2, null] });
  assert.deepEqual(await byLogin({ login: "zed" }), { zed: ["", 0, "deny"] });
});

test("removing or demoting an operator in any letter case ends their Discord link and their org setup links", async () => {
  const db = await fresh();
  await addLogin(db, "cli", "Owner", "operator", null);
  await addLogin(db, "cli", "Bob", "operator", null);
  await addLogin(db, "cli", "Ann", "operator", null);
  await db.run(db.k.insertInto("discord_links").values({ user_hash: "u1", login: "Bob", linked_at: T0 }));
  await db.run(db.k.insertInto("discord_link_codes").values({ code_hash: "c1", login: "Bob", expires_at: "2099-01-01T00:00:00Z" }));
  await createLink(db, "Bob", "real-org");
  await createLink(db, "Ann", "real-org");
  await createLink(db, "Owner", "real-org");
  assert.equal((await openLinks(db)).length, 3);
  await removeLogin(db, "cli", "bob");
  await setRole(db, "cli", "ann", "viewer");
  assert.equal((await db.get(db.k.selectFrom("discord_links").select((eb) => eb.fn.countAll<number>().as("n"))))!.n, 0);
  assert.equal((await db.get(db.k.selectFrom("discord_link_codes").select((eb) => eb.fn.countAll<number>().as("n"))))!.n, 0);
  assert.deepEqual((await openLinks(db)).map((l) => l.createdBy), ["Owner"]);
  // A link whose creator lost the role by any other path stops working too.
  await db.run(db.k.updateTable("access").set({ role: "maintainer" }).where("login", "=", "Owner"));
  assert.deepEqual(await openLinks(db), []);
});
