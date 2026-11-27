// GitHub App registration through the dashboard, with a fake GitHub for the
// manifest conversion: the keys are stored sealed in the database and
// nowhere else, the state nonce works once, only operators reach the page's
// API, and app sign-in keeps the user's token sealed in user_tokens.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { addLogin } from "../src/access.ts";
import { loadConfig } from "../src/dash/server/config.ts";
import { sha256hex, TokenBox } from "../src/dash/server/crypto.ts";
import { AppKeys } from "../src/github/app-keys.ts";
import { startServer } from "../src/dash/server/index.ts";
import { FakeProvider } from "../src/dash/server/provider.ts";
import type { Route } from "../src/dash/types.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";
import * as kx from "../src/db/kx.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "github-app-test-"));
const dbFile = join(dir, "dash.db");
const permsFile = join(dir, "perms.json");
const secretsFile = join(dir, "secrets.json");
writeFileSync(permsFile, "{}");
const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const CLIENT_SECRET = "client-secret-for-the-test";
const WEBHOOK_SECRET = "webhook-secret-for-the-test";

const db = await connectDb(dbFile);
let github: Server;
let converted: string[] = [];
let onConvert: () => void = () => {};
// The org setup link's fake GitHub: bearer tokens seen on the visitor's calls, what organization-roles answers, and the PUTs it got.
const visitorTokens = new Set<string>();
let rolesAnswer: 404 | 403 | 200 = 404;
const rolePuts: string[] = [];
const closers: Array<() => Promise<void>> = [];
let base = "";

before(async () => {
  github = createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = req.url ?? "";
    if (req.method === "POST" && url.startsWith("/app-manifests/")) {
      const code = decodeURIComponent(url.split("/")[2]!);
      converted.push(code);
      onConvert();
      return code === "good-code"
        ? send(201, { id: 4242, slug: "autocraft-test", name: "AutoCraft", owner: { login: "glasswing", type: "Organization" }, client_id: "Iv1.test", client_secret: CLIENT_SECRET, webhook_secret: WEBHOOK_SECRET, pem: PEM })
        : send(404, { message: "Not Found" });
    }
    if (!(req.headers.authorization ?? "").startsWith("Bearer ")) return send(401, {});
    const bearer = (req.headers.authorization ?? "").slice(7);
    if (url.startsWith("/user/memberships/orgs/")) {
      visitorTokens.add(bearer);
      return url.endsWith("/glasswing") ? send(200, { state: "active", role: "admin" }) : send(200, { state: "active", role: "member" });
    }
    if (url === "/orgs/glasswing/organization-roles") {
      visitorTokens.add(bearer);
      return rolesAnswer !== 200 ? send(rolesAnswer, {}) : send(200, { total_count: 2, roles: [{ id: 1, name: "all_repo_read" }, { id: 8140, name: "GitHub App Manager" }] });
    }
    if (req.method === "PUT" && url.startsWith("/orgs/glasswing/organization-roles/users/")) {
      visitorTokens.add(bearer);
      rolePuts.push(url);
      res.writeHead(204);
      return void res.end();
    }
    if (url === "/app/installations/99") return send(200, { id: 99, account: { login: "Glasswing" } });
    if (url === "/app/installations/98") return send(200, { id: 98, account: { login: "elsewhere" } });
    if (url === "/app") return send(200, { name: "AutoCraft" });
    if (url.startsWith("/app/installations?")) return send(200, [{ id: 7, account: { login: "glasswing" }, repository_selection: "selected" }]);
    if (req.method === "POST" && url === "/app/installations/7/access_tokens") return send(201, { token: "ghs_installation" });
    if (url.startsWith("/installation/repositories")) return send(200, { repositories: [{ full_name: "glasswing/photocraft" }] });
    send(404, {});
  });
  await new Promise<void>((r) => github.listen(0, "127.0.0.1", r));
  const githubApi = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
  await addLogin(db, "cli", "boss", "operator", null);
  await addLogin(db, "cli", "viewer1", "viewer", null);
  await addLogin(db, "cli", "maint", "maintainer", null);
  const env = { AUTOCRAFT_DEV_AUTH: "1", AUTOCRAFT_LISTEN: "127.0.0.1:0", AUTOCRAFT_DB: dbFile, AUTOCRAFT_DEV_PERMS: permsFile, AUTOCRAFT_SECRETS_FILE: secretsFile };
  const s = await startServer({ config: loadConfig(env), db, provider: new FakeProvider(permsFile), routes: [], githubApi });
  base = s.url;
  closers.push(s.close);
});
after(async () => {
  for (const c of closers) await c();
  await new Promise((r) => github.close(r));
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

class Client {
  jar = new Map<string, string>();
  origin: string;
  constructor(origin: string) {
    this.origin = origin;
  }
  async req(path: string): Promise<Response> {
    const r = await fetch(new URL(path, this.origin), { headers: { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "), accept: "application/json" }, redirect: "manual" });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const k = kv!.slice(0, kv!.indexOf("=")), v = kv!.slice(kv!.indexOf("=") + 1);
      if (/Max-Age=0/.test(c)) this.jar.delete(k);
      else this.jar.set(k, v);
    }
    return r;
  }
  async csrf(): Promise<string> {
    return (await this.req("/api/me")).headers.get("x-csrf-token")!;
  }
  async post(path: string, form: Record<string, string>): Promise<Response> {
    const r = await fetch(new URL(path, this.origin), {
      method: "POST", body: new URLSearchParams(form), redirect: "manual",
      headers: { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ") },
    });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(";");
      this.jar.set(kv!.slice(0, kv!.indexOf("=")), kv!.slice(kv!.indexOf("=") + 1));
    }
    return r;
  }
  async json(path: string, body: unknown): Promise<Response> {
    return fetch(new URL(path, this.origin), {
      method: "POST", body: JSON.stringify(body),
      headers: { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "), "content-type": "application/json", "x-csrf-token": await this.csrf() },
    });
  }
}

/** Forgets the stored app, so the next server imports its own secrets file. */
async function resetApp(): Promise<void> {
  await db.run(db.k.deleteFrom("github_app"));
}

async function signedIn(login: string, origin = base): Promise<Client> {
  const c = new Client(origin);
  const start = await c.req("/auth/signin?return_to=/");
  const auth = await c.req(`${start.headers.get("location")}&login=${login}`);
  assert.equal((await c.req(auth.headers.get("location")!)).status, 303, `sign-in of ${login}`);
  return c;
}

describe("github app registration", () => {
  afterEach(async () => { await db.prepare("DELETE FROM settings WHERE key = 'github_identity'").run(); });

  test("only operators reach the page's API and the registration start", async () => {
    for (const login of ["viewer1", "maint"]) {
      const c = await signedIn(login);
      assert.equal((await c.req("/api/admin/github-app")).status, 403);
      assert.equal((await c.post("/auth/github-app/start", { csrf: await c.csrf() })).status, 403);
    }
  });

  test("registration stores the keys sealed in the database, returns none of them, and the state works once", async () => {
    const boss = await signedIn("boss");
    const before = (await (await boss.req("/api/admin/github-app")).json()) as { configured: boolean };
    assert.equal(before.configured, false);

    assert.equal((await boss.post("/auth/github-app/start", { name: "AutoCraft", csrf: "wrong" })).status, 403);
    const page = await (await boss.post("/auth/github-app/start", { name: "AutoCraft", csrf: await boss.csrf() })).text();
    const state = /settings\/apps\/new\?state=([A-Za-z0-9_-]+)/.exec(page)?.[1];
    assert.ok(state, "the start page posts to GitHub with a state");
    assert.match(page, /&#34;active&#34;:false/);
    assert.match(page, /&#34;callback_urls&#34;:\[&#34;http:\/\/127\.0\.0\.1:\d+\/auth\/callback&#34;,&#34;http:\/\/127\.0\.0\.1:\d+\/discord\/github\/callback&#34;\]/);

    const done = await boss.req(`/auth/github-app/callback?code=good-code&state=${state}`);
    assert.equal(done.status, 303);
    assert.equal(done.headers.get("location"), "/admin/github-app");
    assert.ok(!existsSync(secretsFile), "registration writes no file");
    const row = (await db.get(db.k.selectFrom("github_app").select(["slug", "keys_enc"])))!;
    assert.equal(row.slug, "autocraft-test");
    for (const secret of [PEM.slice(40, 80), CLIENT_SECRET, WEBHOOK_SECRET]) assert.ok(!row.keys_enc!.includes(secret));

    const replay = await boss.req(`/auth/github-app/callback?code=good-code&state=${state}`);
    assert.equal(replay.status, 400);
    assert.deepEqual(converted, ["good-code"]);

    const text = await (await boss.req("/api/admin/github-app")).text();
    const status = JSON.parse(text) as { configured: boolean; app: { slug: string; installUrl: string; transferUrl: string }; installations: { owner: string; repos: string[] }[] };
    assert.equal(status.configured, true);
    assert.equal(status.app.slug, "autocraft-test");
    assert.equal(status.app.installUrl, "https://github.com/apps/autocraft-test/installations/new");
    assert.equal(status.app.transferUrl, "https://github.com/organizations/glasswing/settings/apps/autocraft-test/advanced");
    assert.deepEqual(status.installations, [{ id: 7, owner: "glasswing", type: null, selection: "selected", repos: ["glasswing/photocraft"], createdAt: null, allowed: false, protected: true }]);
    const audit = JSON.stringify(await db.all(db.k.selectFrom("audit").select(kx.cols("audit"))));
    for (const secret of [PEM.slice(40, 80), CLIENT_SECRET, WEBHOOK_SECRET, "ghs_installation"]) {
      assert.ok(!text.includes(secret) && !page.includes(secret) && !audit.includes(secret));
    }
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'github-app-register' AND target = 'autocraft-test'").get() as { n: number }).n, 1);
  });

  test("app sign-in keeps the user's token sealed in user_tokens", async () => {
    await db.prepare("INSERT INTO settings (key, value) VALUES ('github_identity', 'app') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();
    const env = { AUTOCRAFT_DEV_AUTH: "1", AUTOCRAFT_LISTEN: "127.0.0.1:0", AUTOCRAFT_DB: dbFile, AUTOCRAFT_DEV_PERMS: permsFile, AUTOCRAFT_SECRETS_FILE: secretsFile };
    const s = await startServer({ config: loadConfig(env), db, provider: new FakeProvider(permsFile), routes: [] });
    closers.push(s.close);
    await signedIn("maint", s.url);
    const row = (await db.get(db.k.selectFrom("user_tokens").select(["token_enc", "version", "status"]).where("login", "=", "maint")))!;
    assert.equal(row.status, "ok");
    assert.ok(row.token_enc && !row.token_enc.includes("dev_"));
    await signedIn("maint", s.url);
    assert.equal((await db.get(db.k.selectFrom("user_tokens").select("version").where("login", "=", "maint")))!.version, 2);
  });

  test("a secrets file's app keys are imported once, other processes see the stored keys, and a removed app stays removed", async () => {
    const file = join(dir, "import-secrets.json");
    writeFileSync(file, JSON.stringify({ github_app_id: "9", github_app_slug: "file-app", github_app_private_key: PEM, github_app_client_id: "Iv1.file", github_app_client_secret: CLIENT_SECRET, github_app_owner: { login: "glasswing", type: "Organization" } }), { mode: 0o600 });
    const env = { AUTOCRAFT_DEV_AUTH: "1", AUTOCRAFT_LISTEN: "127.0.0.1:0", AUTOCRAFT_DB: dbFile, AUTOCRAFT_DEV_PERMS: permsFile, AUTOCRAFT_SECRETS_FILE: file };
    await resetApp();
    const githubApi = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
    const one = await startServer({ config: loadConfig(env), db, provider: new FakeProvider(permsFile), routes: [], githubApi });
    closers.push(one.close);
    const status = async (url: string) => (await (await (await signedIn("boss", url)).req("/api/admin/github-app")).json()) as { configured: boolean; app: { slug: string } | null };
    assert.equal((await status(one.url)).app?.slug, "file-app");
    assert.ok(!(await db.get(db.k.selectFrom("github_app").select("keys_enc")))!.keys_enc!.includes(CLIENT_SECRET));

    // A second dashboard (another replica) whose secrets file has no app keys reads them from the database.
    const bare = join(dir, "import-bare.json");
    writeFileSync(bare, "{}", { mode: 0o600 });
    const two = await startServer({ config: loadConfig({ ...env, AUTOCRAFT_SECRETS_FILE: bare }), db, provider: new FakeProvider(permsFile), routes: [], githubApi });
    closers.push(two.close);
    assert.equal((await status(two.url)).app?.slug, "file-app");

    // Under another session_key the stored keys are unreadable, said so, and a new registration replaces them only when confirmed.
    const other = await new AppKeys(db, new TokenBox("o".repeat(40)), null).load();
    assert.equal(other.current(), null);
    assert.equal(other.unreadable(), true);
    const replaced = { id: "77", slug: "other-app", privateKey: PEM, clientId: "Iv1.o", clientSecret: "o", webhookSecret: null, owner: null };
    await assert.rejects(other.save(replaced), { code: "EUNREADABLE" });
    await other.save(replaced, true);
    assert.equal((await new AppKeys(db, new TokenBox("o".repeat(40)), null).load()).current()?.slug, "other-app");
    await assert.rejects(other.save(replaced), /another app/);

    // Removed through one dashboard, the app is not imported again from the file at the next start.
    assert.equal((await (await signedIn("boss", one.url)).json("/api/admin/github-app/remove", {})).status, 200);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).github_app_slug, "file-app");
    const three = await startServer({ config: loadConfig(env), db, provider: new FakeProvider(permsFile), routes: [], githubApi });
    closers.push(three.close);
    assert.equal((await status(three.url)).configured, false);
  });

  test("the identity route refuses with the uncovered repos listed, and a switch ends every session", async () => {
    const file = join(dir, "identity-secrets.json");
    writeFileSync(file, JSON.stringify({ github_app_id: "4242", github_app_slug: "autocraft-test", github_app_private_key: PEM, github_app_client_id: "Iv1.test", github_app_client_secret: CLIENT_SECRET }), { mode: 0o600 });
    const env = { AUTOCRAFT_DEV_AUTH: "1", AUTOCRAFT_LISTEN: "127.0.0.1:0", AUTOCRAFT_DB: dbFile, AUTOCRAFT_DEV_PERMS: permsFile, AUTOCRAFT_SECRETS_FILE: file };
    await resetApp();
    const s = await startServer({ config: loadConfig(env), db, provider: new FakeProvider(permsFile), routes: [] });
    closers.push(s.close);
    const boss = await signedIn("boss", s.url);
    assert.equal((await (await signedIn("maint", s.url)).json("/api/admin/github-app/identity", { identity: "app" })).status, 403);
    await db.prepare("DELETE FROM tracked_repos").run();
    await db.prepare("INSERT INTO tracked_repos (name) VALUES ('photocraft')").run();
    // No installation can be looked up here, so the tracked repo is not covered.
    const refused = await boss.json("/api/admin/github-app/identity", { identity: "app" });
    assert.equal(refused.status, 409);
    assert.deepEqual(((await refused.json()) as { repos: string[] }).repos, ["photocraft"]);
    assert.equal((await boss.req("/api/admin/github-app")).status, 200);
    await db.prepare("DELETE FROM tracked_repos WHERE name = 'photocraft'").run();
    const done = await boss.json("/api/admin/github-app/identity", { identity: "app" });
    assert.equal(done.status, 200);
    assert.deepEqual(await done.json(), { identity: "app", signIn: "/auth/signin" });
    assert.equal((await boss.req("/api/admin/github-app")).status, 401);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'github-identity' AND target = 'app'").get() as { n: number }).n, 1);
  });

  test("a refreshed app sign-in token reaches user_tokens", async () => {
    await db.prepare("INSERT INTO settings (key, value) VALUES ('github_identity', 'app') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();
    const env = { AUTOCRAFT_DEV_AUTH: "1", AUTOCRAFT_LISTEN: "127.0.0.1:0", AUTOCRAFT_DB: dbFile, AUTOCRAFT_DEV_PERMS: permsFile, AUTOCRAFT_SECRETS_FILE: secretsFile };
    const provider = new FakeProvider(permsFile, 300);
    const routes: Route[] = [{ method: "GET", pattern: "/api/test/can/:repo", handler: async (_db, r) => ({ json: { can: await r.user.canWrite(r.params.repo!) } }) }];
    const s = await startServer({ config: loadConfig(env), db, provider, routes });
    closers.push(s.close);
    const c = await signedIn("viewer1", s.url);
    const row = async () => (await db.get(db.k.selectFrom("user_tokens").select(["token_enc", "version"]).where("login", "=", "viewer1")))!;
    const before = await row();
    await new Promise((r) => setTimeout(r, 350));
    await c.req("/api/test/can/photocraft");
    assert.equal(provider.refreshes, 1);
    const after = await row();
    assert.equal(after.version, before.version + 1);
    assert.notEqual(after.token_enc, before.token_enc);
  });

  test("org setup link: owners only, single use, the owner's token is kept nowhere, the role list 404 falls back to the settings link", async () => {
    const file = join(dir, "setup-secrets.json");
    writeFileSync(file, "{}", { mode: 0o600 });
    const env = { AUTOCRAFT_DEV_AUTH: "1", AUTOCRAFT_LISTEN: "127.0.0.1:0", AUTOCRAFT_DB: dbFile, AUTOCRAFT_DEV_PERMS: permsFile, AUTOCRAFT_SECRETS_FILE: file };
    await resetApp();
    const s = await startServer({ config: loadConfig(env), db, provider: new FakeProvider(permsFile), routes: [], githubApi: `http://127.0.0.1:${(github.address() as AddressInfo).port}` });
    closers.push(s.close);
    const boss = await signedIn("boss", s.url);
    const mint = async (org: string) => ((await (await boss.json("/api/admin/github-app/links", { org })).json()) as { url: string }).url;
    const pages: string[] = [];
    const get = async (c: Client, path: string) => {
      const r = await c.req(path);
      const t = await r.text();
      pages.push(t);
      return { r, t };
    };
    /** Opens the link and signs in as `login` through the fake GitHub; returns the response of the OAuth callback. */
    const signIn = async (c: Client, path: string, login: string, manager = true) => {
      const start = await c.post(`${path}/signin`, manager ? { manager: "1" } : {});
      assert.equal(start.status, 303);
      const authorize = start.headers.get("location")!;
      assert.equal(new URL(authorize, s.url).searchParams.get("scope"), manager ? "read:org admin:org" : "read:org");
      const back = await c.req(`${authorize}&login=${login}`);
      return c.req(back.headers.get("location")!);
    };

    // The list shows open links; the database keeps only the hash.
    const path = await mint("glasswing");
    const secret = path.split("/").pop()!;
    assert.ok(!JSON.stringify(await db.all(db.k.selectFrom("github_setup_links").select(kx.cols("github_setup_links")))).includes(secret));
    const status = (await (await boss.req("/api/admin/github-app")).json()) as { links: { org: string }[] };
    assert.deepEqual(status.links.map((l) => l.org), ["glasswing"]);

    // A signed-in dashboard user who is not an org owner is refused, and the link stays open.
    const stranger = new Client(s.url);
    const other = await mint("otherorg");
    const refused = await signIn(stranger, other, "carol");
    assert.equal(refused.status, 403);
    assert.match(await refused.text(), /not an owner of otherorg/);
    assert.equal((await get(new Client(s.url), other)).r.status, 200);

    // The owner: the landing page has the app-manager box ticked, then Create posts the manifest to the org.
    const owner = new Client(s.url);
    const landing = await get(owner, path);
    assert.match(landing.t, /Make boss an app manager/);
    assert.match(landing.t, /type="checkbox" name="manager" value="1" checked/);
    assert.equal((await signIn(owner, path, "alice")).status, 303);
    const create = await get(owner, "/auth/setup");
    const state = /organizations\/glasswing\/settings\/apps\/new\?state=([A-Za-z0-9_-]+)/.exec(create.t)?.[1];
    assert.ok(state, "the manifest goes to the org");
    assert.match(create.t, /&#34;setup_url&#34;:&#34;http:\/\/127\.0\.0\.1:\d+\/auth\/github-app\/setup&#34;/);
    assert.equal((await owner.req(`/auth/github-app/callback?code=good-code&state=${state}`)).status, 303);
    assert.equal((await db.get(db.k.selectFrom("github_app").select("slug")))!.slug, "autocraft-test");

    // Organization roles answer 404 (Free plan): the page offers the settings link instead.
    const manage = await owner.post("/auth/setup/manager", {});
    assert.equal(manage.status, 303);
    const fallback = await get(owner, "/auth/setup");
    assert.match(fallback.t, /href="https:\/\/github\.com\/organizations\/glasswing\/settings\/apps\/autocraft-test"[^>]*>App managers &rarr; Grant boss/);
    assert.deepEqual(rolePuts, []);

    // Install: GitHub returns to the setup URL; the link is then used up.
    const installState = /installations\/new\?state=([A-Za-z0-9_-]+)/.exec(fallback.t)?.[1];
    assert.ok(installState);
    const done = await get(owner, `/auth/github-app/setup?installation_id=99&setup_action=install&state=${installState}`);
    assert.match(done.t, />Done</);
    assert.equal((await get(new Client(s.url), path)).r.status, 410);
    assert.match((await get(owner, `/auth/github-app/setup?installation_id=99&state=${installState}`)).t, />Installed</);
    assert.equal((await new Client(s.url).post(`${path}/signin`, { manager: "1" })).status, 410);
    const used = await db.get(db.k.selectFrom("github_setup_links").select(["used_by", "installation_id"]).where("hash", "is not", null).where("org", "=", "glasswing"));
    assert.deepEqual({ ...used }, { used_by: "alice", installation_id: 99 });

    // With the role available the PUT is made with the owner's token and audited without it; a revoked link is dead.
    rolesAnswer = 200;
    const second = new Client(s.url);
    const path2 = await mint("glasswing");
    assert.equal((await signIn(second, path2, "alice")).status, 303);
    assert.equal((await second.post("/auth/setup/manager", {})).status, 303);
    assert.deepEqual(rolePuts, ["/orgs/glasswing/organization-roles/users/boss/8140"]);
    const row = await db.prepare("SELECT details FROM audit WHERE action = 'github-app-manager'").get() as { details: string };
    assert.deepEqual(JSON.parse(row.details), { user: "boss", role: "GitHub App Manager", roleId: 8140, identity: "user:alice", state: "done" });
    const id = (await db.get(db.k.selectFrom("github_setup_links").select("id").where("hash", "=", sha256hex(path2.split("/").pop()!))))!.id;
    assert.equal((await boss.json("/api/admin/github-app/links/revoke", { id })).status, 200);
    assert.equal((await get(new Client(s.url), path2)).r.status, 410);

    assert.ok(visitorTokens.size >= 1 && ![...visitorTokens].includes(""));
    const everything = JSON.stringify([await db.all(db.k.selectFrom("audit").select(kx.cols("audit"))), await db.all(db.k.selectFrom("github_setup_links").select(kx.cols("github_setup_links"))), await db.all(db.k.selectFrom("github_app_states").select(kx.cols("github_app_states"))), await db.all(db.k.selectFrom("oauth_states").select(kx.cols("oauth_states"))), await db.all(db.k.selectFrom("sessions").select(kx.cols("sessions")))]) + readFileSync(file, "utf8") + pages.join("");
    for (const t of visitorTokens) assert.ok(!everything.includes(t), "the owner's token is kept nowhere");
    for (const a of ["github-app-link-create", "github-app-link-use", "github-app-link-revoke"]) assert.ok(await db.prepare("SELECT 1 FROM audit WHERE action = ?").get(a), a);
  });

  test("org setup link: unticked manager keeps no token, flows are bound to their cookie and link, a 403 on roles falls back, a foreign installation is refused", async () => {
    const file = join(dir, "setup2-secrets.json");
    writeFileSync(file, "{}", { mode: 0o600 });
    const env = { AUTOCRAFT_DEV_AUTH: "1", AUTOCRAFT_LISTEN: "127.0.0.1:0", AUTOCRAFT_DB: dbFile, AUTOCRAFT_DEV_PERMS: permsFile, AUTOCRAFT_SECRETS_FILE: file };
    await resetApp();
    const provider = new FakeProvider(permsFile);
    const s = await startServer({ config: loadConfig(env), db, provider, routes: [], githubApi: `http://127.0.0.1:${(github.address() as AddressInfo).port}` });
    closers.push(s.close);
    const boss = await signedIn("boss", s.url);
    const mint = async () => ((await (await boss.json("/api/admin/github-app/links", { org: "glasswing" })).json()) as { url: string }).url;
    const signIn = async (c: Client, path: string, login: string, manager: boolean) => {
      const start = await c.post(`${path}/signin`, manager ? { manager: "1" } : {});
      const authorize = start.headers.get("location")!;
      assert.equal(new URL(authorize, s.url).searchParams.get("scope"), manager ? "read:org admin:org" : "read:org");
      const back = await c.req(`${authorize}&login=${login}`);
      return c.req(back.headers.get("location")!);
    };
    const text = async (c: Client, path: string) => (await c.req(path)).text();
    const revokedBefore = provider.revoked.length;

    // Unticked: read:org only, no manager step, and the token is revoked at once.
    const a = new Client(s.url), pathA = await mint();
    assert.equal((await signIn(a, pathA, "alice", false)).status, 303);
    assert.equal(provider.revoked.length, revokedBefore + 1);
    const pageA = await text(a, "/auth/setup");
    assert.ok(!/app manager/i.test(pageA));
    const stateA = /apps\/new\?state=([A-Za-z0-9_-]+)/.exec(pageA)![1]!;

    // Without the setup cookie, or with another flow's cookie, nothing opens and the state survives.
    const bare = new Client(s.url);
    const noCookie = await bare.req("/auth/setup");
    assert.equal(noCookie.status, 400);
    assert.match(await noCookie.text(), /Open the link again/);
    assert.equal((await bare.req(`/auth/github-app/callback?code=good-code&state=${stateA}`)).status, 400);
    const b = new Client(s.url), pathB = await mint();
    assert.equal((await signIn(b, pathB, "alice", true)).status, 303);
    assert.equal((await b.req("/auth/setup")).status, 200);
    assert.equal((await b.req(`/auth/github-app/callback?code=good-code&state=${stateA}`)).status, 400, "a state of another link");
    const crossed = new Client(s.url);
    const cookieName = [...a.jar.keys()].find((k) => k.includes("setup"))!;
    crossed.jar.set(cookieName, a.jar.get(cookieName)!);
    // Rendering the page again issues a fresh state for the same flow and retires the old one.
    const stateA2 = /apps\/new\?state=([A-Za-z0-9_-]+)/.exec(await text(crossed, "/auth/setup"))![1]!;
    assert.notEqual(stateA2, stateA);
    const stranger = new Client(s.url), pathC = await mint();
    const start = await stranger.post(`${pathC}/signin`, { manager: "1" });
    stranger.jar.set(cookieName, a.jar.get(cookieName)!);
    const back = await stranger.req(`${start.headers.get("location")}&login=alice`);
    assert.equal((await stranger.req(back.headers.get("location")!)).status, 410, "another flow's cookie cannot finish a sign-in");

    // The owner's flow still works: create, then a 403 on the role list leaves the settings link and the Install step.
    assert.equal((await a.req(`/auth/github-app/callback?code=good-code&state=${stateA2}`)).status, 303);
    assert.equal((await db.get(db.k.selectFrom("github_app").select("slug")))!.slug, "autocraft-test");
    const pageB = await text(b, "/auth/setup");
    assert.match(pageB, /Make boss an app manager/);
    rolesAnswer = 403;
    assert.equal((await b.post("/auth/setup/manager", {})).status, 303);
    const fallback = await text(b, "/auth/setup");
    assert.match(fallback, /App managers &rarr; Grant boss/);
    const installState = /installations\/new\?state=([A-Za-z0-9_-]+)/.exec(fallback)![1]!;
    assert.ok(provider.revoked.length >= revokedBefore + 2, "the manager step revokes the token");

    // An installation on another account leaves the link open; the right one finishes it.
    assert.equal((await b.req(`/auth/github-app/setup?installation_id=98&state=${installState}`)).status, 409);
    assert.equal((await new Client(s.url).req(pathB)).status, 200);
    const again = /installations\/new\?state=([A-Za-z0-9_-]+)/.exec(await text(b, "/auth/setup"))![1]!;
    assert.match(await text(b, `/auth/github-app/setup?installation_id=99&state=${again}`), />Done</);
    assert.equal((await new Client(s.url).req(pathB)).status, 410);
    // An install started elsewhere lands on a neutral page.
    assert.match(await text(new Client(s.url), "/auth/github-app/setup?installation_id=5"), />Installed</);
    assert.equal((await boss.req("/auth/github-app/setup?installation_id=5")).headers.get("location"), "/admin/github-app");
  });

  test("remove clears the app's keys from the database and memory, and is refused while the GitHub identity is the app", async () => {
    const file = join(dir, "remove-secrets.json");
    writeFileSync(file, JSON.stringify({ other_key: "kept", github_app_id: "4242", github_app_slug: "autocraft-test", github_app_private_key: PEM, github_app_client_id: "Iv1.test", github_app_client_secret: CLIENT_SECRET, github_app_webhook_secret: "", github_app_owner: { login: "glasswing", type: "Organization" } }), { mode: 0o600 });
    const env = { AUTOCRAFT_DEV_AUTH: "1", AUTOCRAFT_LISTEN: "127.0.0.1:0", AUTOCRAFT_DB: dbFile, AUTOCRAFT_DEV_PERMS: permsFile, AUTOCRAFT_SECRETS_FILE: file };
    await resetApp();
    const githubApi = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
    await db.prepare("INSERT INTO settings (key, value) VALUES ('github_identity', 'app') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();
    const appMode = await startServer({ config: loadConfig(env), db, provider: new FakeProvider(permsFile), routes: [], githubApi });
    closers.push(appMode.close);
    const locked = await signedIn("boss", appMode.url);
    assert.equal((await locked.json("/api/admin/github-app/remove", {})).status, 409);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).github_app_slug, "autocraft-test");
    await db.prepare("DELETE FROM settings WHERE key = 'github_identity'").run();

    const s = await startServer({ config: loadConfig(env), db, provider: new FakeProvider(permsFile), routes: [], githubApi });
    closers.push(s.close);
    assert.equal((await (await signedIn("maint", s.url)).json("/api/admin/github-app/remove", {})).status, 403);
    const boss = await signedIn("boss", s.url);
    await db.run(db.k.insertInto("github_app_states").values({ state: "open", login: "boss", session_hash: "h", created_at: new Date().toISOString() }));
    const res = await boss.json("/api/admin/github-app/remove", {});
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { settingsUrl: "https://github.com/organizations/glasswing/settings/apps/autocraft-test" });
    assert.equal((await db.get(db.k.selectFrom("github_app").select("keys_enc")))!.keys_enc, null);
    assert.equal((await (await boss.req("/api/admin/github-app")).json() as { configured: boolean }).configured, false);
    assert.equal((await db.get(db.k.selectFrom("github_app_states").select((eb) => eb.fn.countAll<number>().as("n"))))!.n, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'github-app-remove' AND target = 'autocraft-test'").get() as { n: number }).n, 1);
    assert.ok(!JSON.stringify(await db.all(db.k.selectFrom("audit").select(kx.cols("audit")))).includes(CLIENT_SECRET));
    assert.equal((await boss.json("/api/admin/github-app/remove", {})).status, 409);
  });
});
