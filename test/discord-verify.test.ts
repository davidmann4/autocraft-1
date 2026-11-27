// The public /verify flow: Discord and GitHub sign-ins in one browser leave one role request for a member with a merged pull
// request, the runner side gives the role, and a spent or expired OAuth state is refused. The link it leaves runs no command
// until a dashboard link code replaces it, and never replaces such a link itself.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { FakeProvider } from "../src/dash/server/provider.ts";
import { verifyRoute, type DiscordOAuth, type VerifyDeps } from "../src/dash/server/verify.ts";
import { installAccountCommands } from "../src/discord/commands.ts";
import { Interactions } from "../src/discord/interactions.ts";
import { DiscordKeys } from "../src/discord/keys.ts";
import type { DiscordRest, EditBody } from "../src/discord/rest.ts";
import { createLinkCode, loginOf } from "../src/discord/links.ts";
import { runRoleGrants, setRoleConfig, type RoleRest } from "../src/discord/role-panel.ts";
import { saveChannels } from "../src/data/discord/index.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "discord-verify-"));
const db = await connectDb(join(dir, "d.db"));
const keys = new DiscordKeys("k".repeat(40));
after(async () => { await db.close(); rmSync(dir, { recursive: true, force: true }); });

const GUILD = "100000000000000001", CHANNEL = "100000000000000002", ROLE = "100000000000000003", USER = "200000000000000001";
await saveChannels(db, [{ channelId: CHANNEL, guildId: GUILD, guildName: "Server", name: "contributor-role" }]);
await setRoleConfig(db, "test", { channelId: CHANNEL, roleId: ROLE });

const discord: DiscordOAuth = {
  authorizeUrl: (state, redirectUri) => `https://discord.invalid/authorize?${new URLSearchParams({ state, redirect_uri: redirectUri })}`,
  userId: async (code) => (code === "dcode" ? USER : null),
};
const github = new FakeProvider(null);
let now = Date.parse("2026-01-01T00:00:00Z");
const deps: VerifyDeps = {
  db, baseUrl: "https://dash.invalid", discord: () => discord, github: () => github, keys: () => keys, now: () => now,
  check: async (_db, who) => ({ merged: who.login === "merger", via: "search" }),
};
const granted: { guild: string; user: string; role: string }[] = [];
const rest: RoleRest = {
  async createMessage() { return { id: "m" }; }, async editMessage() {}, async deleteMessage() {}, async pinMessage() {},
  async addMemberRole(guild, user, role) { granted.push({ guild, user, role }); },
  async memberRoles() { return []; },
  async guildRole() { return { permissions: "0", managed: false }; },
};

const go = async (method: string, path: string, cookie = "", sameOrigin = true) =>
  await verifyRoute(deps, { method, url: new URL(path, "https://dash.invalid"), cookies: new Map(cookie ? [["__Host-craft_verify", cookie]] : []), nonce: "n", sameOrigin, contact: async () => "" });
const param = (url: string | undefined, k: string): string => new URL(url ?? "", "https://dash.invalid").searchParams.get(k) ?? "";

/** Starts a flow and passes the Discord step; returns the flow cookie and the GitHub authorization URL. */
async function throughDiscord(): Promise<{ cookie: string; githubUrl: string }> {
  const start = await go("POST", "/verify/discord");
  const cookie = /^__Host-craft_verify=([^;]+);/.exec(start.cookies?.[0] ?? "")?.[1] ?? "";
  const back = await go("GET", `/verify/discord/callback?code=dcode&state=${param(start.r.redirect, "state")}`, cookie);
  return { cookie, githubUrl: back.r.redirect ?? "" };
}

test("a completed flow with a merged pull request leaves one role request that the runner grants; spent and expired states are refused", async () => {
  const { cookie, githubUrl } = await throughDiscord();
  const code = github.issueCode("merger", param(githubUrl, "code_challenge"), param(githubUrl, "redirect_uri"));
  const callback = `/verify/callback?code=${code}&state=${param(githubUrl, "state")}`;
  assert.equal((await go("GET", callback, cookie)).r.redirect, "/verify/done");
  assert.equal((await go("GET", callback, cookie)).r.status, 400, "a spent state is refused");
  assert.equal(await loginOf(db, keys, USER), "merger");

  assert.equal(await runRoleGrants(db, keys, rest, (l) => assert.fail(l), () => now), 1);
  assert.deepEqual(granted, [{ guild: GUILD, user: USER, role: ROLE }]);
  assert.equal(await runRoleGrants(db, keys, rest, (l) => assert.fail(l), () => now), 0, "a request is carried out once");
  assert.deepEqual((await go("GET", "/verify/status", cookie)).r.json, { result: "granted" });
  assert.match(String((await go("GET", "/verify/done", cookie)).r.html), /you have the contributor role/);

  // Another browser's cookie does not fit the flow, and a flow past its 15 minutes is refused.
  const late = await throughDiscord();
  const lateCode = github.issueCode("merger", param(late.githubUrl, "code_challenge"), param(late.githubUrl, "redirect_uri"));
  assert.equal((await go("GET", `/verify/callback?code=${lateCode}&state=${param(late.githubUrl, "state")}`, cookie)).r.status, 400);
  now += 16 * 60_000;
  assert.equal((await go("GET", `/verify/callback?code=${lateCode}&state=${param(late.githubUrl, "state")}`, late.cookie)).r.status, 400);
  assert.equal(await runRoleGrants(db, keys, rest, (l) => assert.fail(l), () => now), 0);
});

/** Runs a whole flow for USER as GitHub `login`; returns the cookie. */
async function flowAs(login: string): Promise<string> {
  const { cookie, githubUrl } = await throughDiscord();
  const code = github.issueCode(login, param(githubUrl, "code_challenge"), param(githubUrl, "redirect_uri"));
  assert.equal((await go("GET", `/verify/callback?code=${code}&state=${param(githubUrl, "state")}`, cookie)).r.redirect, "/verify/done");
  return cookie;
}

test("a link made on /verify runs no command; a dashboard link code makes it command-capable, and /verify never replaces that link", async () => {
  assert.equal(await loginOf(db, keys, USER), "merger");
  const edits: EditBody[] = [];
  const ixRest: DiscordRest = {
    async createMessage() { return { id: "m" }; }, async editMessage() {}, async deleteMessage() {},
    async interactionCallback() {}, async editInteractionResponse(_a, _t, body) { edits.push(body); }, async overwriteGuildCommands() {},
  };
  const ix = new Interactions(ixRest, (l) => assert.fail(l));
  installAccountCommands(ix, { db, keys });
  let n = 0;
  const run = async (name: string, option: string, value: string): Promise<string> => {
    const seen = edits.length;
    ix.dispatch("INTERACTION_CREATE", { id: `c${++n}`, token: "t", type: 2, application_id: "app1", channel_id: "c1", member: { user: { id: USER } }, data: { name: "autocraft", type: 1, options: [name === "link"
      ? { name: "account", type: 1, options: [{ name: "action", type: 3, value: "link" }, { name: option, type: 3, value }] }
      : { name, type: 1, options: [{ name: option, type: 3, value }] }] } });
    for (let k = 0; k < 1000 && edits.length === seen; k++) await new Promise((r) => setTimeout(r, 5));
    return String(edits[seen]?.content ?? "");
  };
  const command = async () => await run("do", "text", "review: photocraft#4");
  await db.run(db.k.insertInto("main.access").values({ login: "merger", role: "maintainer" }));
  assert.match(await command(), /need an AutoCraft login/, "a verify link with an access row still runs nothing");

  const { code } = await createLinkCode(db, keys, "merger");
  await run("link", "code", code);
  assert.doesNotMatch(await command(), /need an AutoCraft login/);

  await flowAs("someone");
  assert.equal(await loginOf(db, keys, USER), "merger", "the dashboard link stays");
  assert.doesNotMatch(await command(), /need an AutoCraft login/);
});

test("a start posted from another site is refused", async () => {
  const r = await go("POST", "/verify/discord", "", false);
  assert.equal(r.r.status, 403);
  assert.equal(r.cookies, undefined);
});

test("every open request is carried out, not only the first page", async () => {
  granted.length = 0;
  const at = new Date(now).toISOString();
  for (let i = 0; i < 25; i++) {
    const id = `g${i}`, user = String(300000000000000000n + BigInt(i));
    await db.run(db.k.insertInto("main.discord_role_grants").values({ id, user_sealed: keys.sealText(user, `discord_role_grants:${id}`), user_hash: keys.hash("author", user), login: "merger", requested_at: at }));
  }
  assert.equal(await runRoleGrants(db, keys, rest, (l) => assert.fail(l), () => now), 25);
  assert.equal(granted.length, 25);
});
