// Filing from Discord under the person's GitHub account: no token gives a stored-hashed sign-in state, the callback stores
// the token, a signed-in report is created with the footer and audited, junk and the per-login limit refuse, and
// forgetting removes the token and queues its revoke. "Submit for me" files as the GitHub App only, credits the reporter
// and stops at the per-person limit. No network: the provider, `gh` and the junk judges are fakes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { botRefusal, creditName, fileAsBot, fileIssue, forgetReporter, type FileHooks } from "../src/discord/file-issue.ts";
import { setGithubIdentity } from "../src/github/identity.ts";
import { readReporter } from "../src/discord/reporter.ts";
import { TokenBox } from "../src/dash/server/crypto.ts";
import type { Provider, Tokens } from "../src/dash/server/provider.ts";
import { reporterSignIn } from "../src/dash/server/reporter-signin.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "../src/db/open.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "discord-file-"));
const db = await connectDb(join(dir, "d.db"));
after(async () => { await db.close(); rmSync(dir, { recursive: true, force: true }); });
await db.run(db.k.insertInto("repos").values({ name: "photocraft", visibility: "public" }));
await db.run(db.k.insertInto("tracked_repos").values({ name: "photocraft" }).onConflict((oc) => oc.doNothing()));

const box = new TokenBox("s".repeat(40));
const tokens: Tokens = { access: "ghu_access", expiresAt: Date.now() + 3_600_000, refresh: "ghr_refresh", refreshExpiresAt: Date.now() + 86_400_000 };
const provider = {
  authorizeUrl: (state: string) => `https://github.example/authorize?state=${state}`,
  exchange: async (code: string) => (code === "good" ? tokens : null),
  identity: async () => ({ login: "octo", id: 7 }),
} as unknown as Provider;

const calls: { args: string[]; input?: string }[] = [];
let junk = false;
const hooks: FileHooks = {
  box, provider, baseUrl: "https://craft.example",
  exec: async (_cmd, args, opts) => { calls.push({ args, input: opts?.input }); return { code: 0, stdout: args[1] === "create" ? "https://github.com/storytold/photocraft/issues/41\n" : "", stderr: "" }; },
  judge: { jev: async () => (junk ? 0.95 : 0.05), haiku: async () => junk },
};
const deps = { db, log: () => {} };
const req = { reporter: "rep1", repo: "photocraft", title: "Export ignores quality", body: "Quality 40 gives the same size as 100.", kind: "bug" as const };

describe("filing from Discord", () => {
  test("no token: a sign-in link whose state is stored hashed; the callback stores the token", async () => {
    const r = await fileIssue(deps, req, hooks);
    assert.equal(r.status, "sign-in");
    const state = new URL((r as { url: string }).url).searchParams.get("state")!;
    assert.match((r as { url: string }).url, /^https:\/\/craft\.example\/discord\/github\/start\?state=/);
    const stored = (await db.get(db.k.selectFrom("reporter_states").select(["state_hash", "reporter"])))!;
    assert.equal(stored.state_hash, createHash("sha256").update(state).digest("hex"));
    assert.equal(stored.reporter, "rep1");

    const d = { db, box, provider, baseUrl: "https://craft.example" };
    const start = await reporterSignIn(d, new URL(`http://x/discord/github/start?state=${state}`), new Map(), "n");
    assert.match(start!.r.redirect!, /^https:\/\/github\.example\/authorize/);
    const cb = new URL(`http://x/discord/github/callback?state=${state}&code=good`);
    assert.equal((await reporterSignIn(d, cb, new Map(), "n"))!.r.status, 400, "needs the browser's cookie");
    const ok = await reporterSignIn(d, new URL(`http://x/discord/github/callback?state=${state}&code=good`), new Map([["__Host-craft_reporter", state]]), "n");
    assert.match(ok!.r.html!, /Signed in as octo\. Go back to Discord and press File it\./);
    assert.equal((await readReporter(db, box, "rep1"))!.tokens!.access, "ghu_access");
    assert.equal((await reporterSignIn(d, cb, new Map([["__Host-craft_reporter", state]]), "n"))!.r.status, 400, "the state is single use");
  });

  test("signed in: junk is refused, then the issue is created with the footer and audited", async () => {
    junk = true;
    assert.deepEqual(await fileIssue(deps, req, hooks), { status: "refused", reason: "That does not look like a bug report or a feature request." });
    assert.equal(calls.length, 0);
    junk = false;
    const r = await fileIssue(deps, req, hooks);
    assert.deepEqual(r, { status: "filed", number: 41, url: "https://github.com/storytold/photocraft/issues/41", login: "octo" });
    assert.equal(calls[0]!.input, "Quality 40 gives the same size as 100.\n\nFiled from Discord with AutoCraft.");
    assert.ok(calls[1]!.args.includes("bug"), "labelled");
    const a = (await db.get(db.k.selectFrom("audit").select(["login", "target", "details"]).where("action", "=", "discord-issue-open")))!;
    const det = JSON.parse(a.details!);
    assert.deepEqual([a.login, a.target, det.state, det.number, det.url], ["octo", "photocraft", "done", 41, "https://github.com/storytold/photocraft/issues/41"]);
    assert.ok(!a.details!.includes("Quality 40"), "the text is not kept in the audit row");
    assert.equal((await db.get(db.k.selectFrom("audit").select((eb) => eb.fn.countAll<number>().as("c")).where("action", "=", "discord-issue-label")))!.c, 1);
  });

  test("a fourth issue in 24 hours by the same login is refused", async () => {
    await fileIssue(deps, req, hooks);
    await fileIssue(deps, req, hooks);
    const r = await fileIssue(deps, req, hooks);
    assert.equal(r.status, "refused");
  });

  test("a refused filing gives its slot back", async () => {
    const filedCount = async () => (await db.get(db.k.selectFrom("discord_filed").select((eb) => eb.fn.countAll<number>().as("c"))))!.c;
    const before = await filedCount();
    junk = true;
    await fileIssue(deps, req, hooks);
    junk = false;
    assert.equal(await filedCount(), before);
  });

  test("forgetReporter removes the token and queues its revoke", async () => {
    assert.equal(await forgetReporter(db, "rep1"), true);
    assert.equal((await db.get(db.k.selectFrom("discord_filed").select((eb) => eb.fn.countAll<number>().as("c")).where("reporter", "=", "rep1")))!.c, 0);
    assert.equal(await readReporter(db, box, "rep1"), null);
    const q = (await db.get(db.k.selectFrom("user_token_revocations").select(["login", "kind", "aad"])))!;
    assert.deepEqual({ ...q }, { login: "octo", kind: "token", aad: "reporter_tokens:rep1" });
    assert.equal(await forgetReporter(db, "rep1"), false);
  });
});

describe("Submit for me", () => {
  test("the GitHub App files with the reporter credited, never as the box account, up to the per-person limit", async () => {
    const ran: { args: string[]; input?: string; token?: string }[] = [];
    const bot = {
      judge: hooks.judge, mint: async () => "ghs_install",
      exec: (async (_cmd, args, opts) => { ran.push({ args, input: opts?.input, token: opts?.env?.GH_TOKEN }); return { code: 0, stdout: args[1] === "create" ? "https://github.com/storytold/photocraft/issues/77\n" : "", stderr: "" }; }) as NonNullable<FileHooks["exec"]>,
    };
    const ask = { ...req, reporter: "rep2", reporterName: "@ana_1", drafted: true };
    assert.equal((await fileAsBot(deps, ask, bot)).status, "refused", "the box account never files for Discord");
    assert.equal(ran.length, 0);

    await setGithubIdentity(db, "test", "app");
    assert.equal(await botRefusal(db, "rep2", "photocraft"), null);
    assert.deepEqual(await fileAsBot(deps, ask, bot), { status: "filed", number: 77, url: "https://github.com/storytold/photocraft/issues/77" });
    assert.equal(ran[0]!.token, "ghs_install");
    assert.match(ran[0]!.input!, /\n\nReported on Discord by `@ana_1`\. Filed by AutoCraft on their behalf\.$/);
    assert.equal(creditName("Ana @everyone [x](https://evil.example)"), "Ana everyone x", "a free-form name carries no mention or link");
    const a = (await db.get(db.k.selectFrom("audit").select(["details"]).where("action", "=", "discord-issue-bot")))!;
    assert.equal(JSON.parse(a.details!).identity, "app");

    await fileAsBot(deps, ask, bot);
    await fileAsBot(deps, ask, bot);
    assert.notEqual(await botRefusal(db, "rep2", "photocraft"), null, "past the limit the draft offers only the GitHub link");
    assert.equal((await fileAsBot(deps, ask, bot)).status, "refused");
    assert.equal(ran.filter((r) => r.args[1] === "create").length, 3);
  });
});
