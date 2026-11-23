// The identity map: which identity a grant carries, what the audit row records per repo setting, and that no write
// function in src/github/write.ts records a row without one.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AppError } from "../src/github/app.ts";
import { RepoNotInInstallationError } from "../src/github/install-token.ts";
import { commitIdentity, identityFor, identityOfDecision, githubIdentity, IdentityRefused, setGithubIdentity, setGithubIdentityChecked } from "../src/github/identity.ts";
import { closeItem } from "../src/github/write.ts";
import type { GuardedItem } from "../src/core/guard.ts";
import type { Querier } from "../src/mirror.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "../src/db/open.ts";
import * as kx from "../src/db/kx.ts";

const grant = (as: string): GuardedItem => ({ scope: "item", action: { kind: "act" }, repo: "app", number: 7, as }) as unknown as GuardedItem;
const q: Querier = { query: async () => ({}) } as unknown as Querier;

test("a decision answered by someone maps to that login, anything else to the app", async () => {
  mkdirSync(SCRATCH, { recursive: true });
  const db = await connectDb(join(SCRATCH, `identity-${process.pid}.db`));
  const ins = (id: string, answer: string | null) => db.run(db.k.insertInto("decisions")
    .values({ id, kind: "close", question: "q", options: "[]", asked_at: "t", answer, answered_by: "example-user" }));
  await ins("d1", "yes");
  await ins("d2", null);
  assert.equal(await identityOfDecision(db, "d1"), "user:example-user");
  assert.equal(await identityOfDecision(db, "d2"), "app");
  assert.equal(await identityOfDecision(db, "missing"), "app");
  assert.equal(await identityOfDecision(db, undefined), "app");
  assert.equal(identityFor(grant("user:example-user"), "close"), "user:example-user");
  assert.equal(identityFor(grant("user:example-user"), "merge"), "user:example-user");
  assert.equal(identityFor(grant("user:example-user")), "app", "any other write is the app's");
});

test("the audit row records legacy until the identity is switched, then the grant's identity", async () => {
  mkdirSync(SCRATCH, { recursive: true });
  const db = await connectDb(join(SCRATCH, `identity-audit-${process.pid}.db`));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app" }).onConflict((oc) => oc.doNothing()));
  const w = { db, login: "act", mint: async () => "ghs_test", appClient: () => q };
  const item = { repo: "app", number: 7, id: "I_1", pr: false };
  const last = async () => JSON.parse((await db.get(db.k.selectFrom("audit").select("details").where("action", "=", "act-close").orderBy(kx.rowid("audit"), "desc").limit(1)))!.details!) as { identity: string };
  assert.equal(await githubIdentity(db), "box");
  await closeItem(w, grant("user:example-user"), q, item);
  assert.equal((await last()).identity, "legacy");
  assert.equal(await setGithubIdentity(db, "op", "app"), true);
  await closeItem(w, grant("user:example-user"), q, item);
  assert.equal((await last()).identity, "user:example-user");
  await closeItem(w, grant("app"), q, item);
  assert.equal((await last()).identity, "app");
  await assert.rejects(async () => await setGithubIdentity(db, "op", "bot"));
  assert.equal(await setGithubIdentity(db, "op", "box"), true);
  assert.equal(await githubIdentity(db), "box");
});

test("every audited write in write.ts takes its identity from a grant", () => {
  const src = readFileSync(new URL("../src/github/write.ts", import.meta.url), "utf8");
  const calls = src.split("\n").filter((l) => /\b(recorded|viaGh)\(w, /.test(l) && !/function /.test(l));
  assert.ok(calls.length >= 25, `found ${calls.length} audited calls`);
  for (const l of calls) assert.match(l, /\b(recorded|viaGh)\(w, (await idOf\(w, g(, "close")?\)|identity|"legacy"|`user:\$\{w\.login\}`), /, l.trim().slice(0, 80));
  // The rows started with begin() directly (labels, merge, command-line merge) carry the identity in their details.
  const begins = src.split("\n").filter((l) => /\bbegin\(w, /.test(l) && !/function /.test(l));
  assert.equal(begins.length, 4);
  for (const l of begins) assert.match(l, /begin\(w, (action, target, details(, owner)?|"labels-apply", .*det\(it\)(, undefined, unsent)?|"merge", target, base|"merge", .*details(, splitSlug\(repoSlug\)\.owner)?)\)/);
  assert.match(src, /identity: await idOf\(w, it\.g\)/);
  assert.match(src, /base = \{ \.\.\.details, method, identity: await idOf\(w, g, "merge"\)(, \.\.\.jobOf\(\))? \}/);
  assert.match(src, /identity: "legacy"/);
});

test("commits are authored by the app's bot user on an app-lane repo and by the box account on a legacy one", async () => {
  mkdirSync(SCRATCH, { recursive: true });
  const db = await connectDb(join(SCRATCH, `identity-commit-${process.pid}.db`));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app" }));
  const box = async () => ({ login: "box", email: "1+box@users.noreply.github.com" });
  const deps = { slug: () => "demo-app", botId: async () => 42 };
  assert.deepEqual(await commitIdentity(db, "app", box, deps), { name: "box", login: "box", email: "1+box@users.noreply.github.com" });
  await setGithubIdentity(db, "t", "app");
  assert.deepEqual(await commitIdentity(db, "app", box, deps), { name: "demo-app[bot]", login: "demo-app[bot]", email: "42+demo-app[bot]@users.noreply.github.com" });
});

test("switching to the app is refused with the uncovered repos listed, and a switch ends the sessions", async () => {
  mkdirSync(SCRATCH, { recursive: true });
  const db = await connectDb(join(SCRATCH, `identity-switch-${process.pid}.db`));
  await db.run(db.k.insertInto("tracked_repos").values([{ name: "covered" }, { name: "outside" }]));
  const mint = async (_owner: string, repo: string) => { if (repo === "outside") throw new RepoNotInInstallationError("o", repo); return "t"; };
  await assert.rejects(setGithubIdentityChecked(db, "op", "app", { registered: () => false, mint }), (e: unknown) => e instanceof IdentityRefused && e.repos.length === 0);
  await assert.rejects(setGithubIdentityChecked(db, "op", "app", { registered: () => true, mint }), (e: unknown) => e instanceof IdentityRefused && e.repos.join() === "outside" && /outside/.test(e.message));
  assert.equal(await githubIdentity(db), "box");
  // A GitHub failure is "could not confirm", not "not covered".
  const flaky = async () => { throw Object.assign(new AppError("GET /x: HTTP 502"), { status: 502 }); };
  await assert.rejects(setGithubIdentityChecked(db, "op", "app", { registered: () => true, mint: flaky }), (e: unknown) => e instanceof IdentityRefused && e.transient);
  await db.run(db.k.deleteFrom("tracked_repos").where("name", "=", "outside"));
  await db.run(db.k.insertInto("sessions").values({ id_hash: "h", login: "op", csrf: "c", created_at: new Date().toISOString(), last_seen: new Date().toISOString(), expires_at: new Date(Date.now() + 1e6).toISOString() }));
  assert.equal(await setGithubIdentityChecked(db, "op", "app", { registered: () => true, mint }), true);
  assert.equal((await db.get(db.k.selectFrom("sessions").select((eb) => eb.fn.countAll<number>().as("n"))))!.n, 0);
});
