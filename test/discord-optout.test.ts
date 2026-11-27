// `/autocraft optout`: the caller's messages stop being recorded and their earlier rows go, while what they send to the bot
// still runs; `/autocraft optin` records them again.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AtCommands } from "../src/discord/at-commands.ts";
import { installAccountCommands } from "../src/discord/commands.ts";
import { dispatcher } from "../src/discord/index.ts";
import { Interactions } from "../src/discord/interactions.ts";
import { DiscordKeys } from "../src/discord/keys.ts";
import { createLinkCode, redeemLinkCode } from "../src/discord/links.ts";
import { Pings } from "../src/discord/pings.ts";
import type { CommandDef, DiscordRest, EditBody, MessageBody } from "../src/discord/rest.ts";
import type { Search } from "../src/discord/search.ts";
import { countOf } from "../src/discord/store.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "discord-optout-"));
const db = await connectDb(join(dir, "d.db"));
const keys = new DiscordKeys("k".repeat(40));
after(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

class FakeRest implements DiscordRest {
  edits: EditBody[] = [];
  threads = 0;
  async createMessage(_c: string, _b: MessageBody) { return { id: `r${Math.random()}` }; }
  async startThread() { return { id: `t${++this.threads}` }; }
  async editMessage() {}
  async deleteMessage() {}
  async interactionCallback() {}
  async editInteractionResponse(_a: string, _t: string, body: EditBody) { this.edits.push(body); }
  async overwriteGuildCommands(_a: string, _g: string, _c: CommandDef[]) {}
}

const rest = new FakeRest();
const ix = new Interactions(rest, (l) => assert.fail(l));
installAccountCommands(ix, { db, keys, baseUrl: null });
const pings = new Pings({ db, keys, rest, search: {} as Search, log: (l) => assert.fail(l), commands: new AtCommands({ db, keys, rest, log: (l) => assert.fail(l) }) });
const dispatch = dispatcher(db, keys, ix, pings);
const say = async (id: string, user: string, content: string) => {
  await dispatch("MESSAGE_CREATE", { id, channel_id: "c1", guild_id: "g1", content, type: 0, author: { id: user } });
  await pings.idle();
};
const slash = async (id: string, sub: string, user: string): Promise<string> => {
  const seen = rest.edits.length;
  await dispatch("INTERACTION_CREATE", { id, token: "t", type: 2, application_id: "app1", channel_id: "c1", member: { user: { id: user } }, data: { name: "autocraft", type: 1, options: [{ name: "account", type: 1, options: [{ name: "action", type: 3, value: sub }] }] } });
  for (let k = 0; k < 1000 && rest.edits.length === seen; k++) await new Promise((r) => setTimeout(r, 5));
  return rest.edits.at(-1)!.content ?? "";
};
const started = async (): Promise<string[]> =>
  (await db.all(db.k.selectFrom("main.item_workflows").select(["repo", "number"]))).map((r) => `${r.repo}#${r.number}`).sort();

before(async () => {
  await db.run(db.k.insertInto("tracked_repos").values([{ name: "photocraft" }]).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.insertInto("repos").values([{ name: "photocraft", owner: "storytold", visibility: "public" }]).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.insertInto("discord_channels").values([{ channel_id: "c1", guild_id: "g1", guild_name: "G", name: "dev", watched: 1 }]));
  for (const n of [4, 7]) {
    await db.run(db.k.insertInto("items").values({ repo: "photocraft", number: n, kind: "pr", state: "OPEN", title: `Fix ${n}`, body: "", url: `https://github.com/storytold/photocraft/pull/${n}` }));
  }
  await db.run(db.k.insertInto("main.access").values({ login: "nora", role: "maintainer" }).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.insertInto("main.settings").values({ key: "github_identity", value: "app" }).onConflict((oc) => oc.column("key").doUpdateSet({ value: "app" })));
  await db.run(db.k.insertInto("main.repo_permissions").values({ login: "nora", repo: "photocraft", permission: "write", checked_at: new Date().toISOString() }));
  const { code } = await createLinkCode(db, keys, "nora");
  assert.equal(await redeemLinkCode(db, keys, code, "u70"), "nora");
  await dispatch("READY", { user: { id: "100" }, application: { id: "app1" } });
});

test("an opted-out user's messages record no mention and their earlier rows go, their @AutoCraft command still runs, and optin records again", async () => {
  await say("m1", "u70", "see https://github.com/storytold/photocraft/pull/4");
  await say("m2", "u2", "and photocraft#4 too");
  assert.equal(await countOf(db, "photocraft", 4), 2);

  assert.match(await slash("i1", "optout", "u70"), /opted out[\s\S]*Deleted the record of 1 message/);
  assert.equal(await countOf(db, "photocraft", 4), 1, "only the other user's row is left");

  await say("m3", "u70", "https://github.com/storytold/photocraft/pull/7 is ready");
  await say("m4", "u70", "<@100> review photocraft#7");
  assert.equal(await countOf(db, "photocraft", 7), 0);
  assert.deepEqual(await started(), ["photocraft#7"], "a command the user sends still runs");

  assert.match(await slash("i2", "optin", "u70"), /opted in/);
  await say("m5", "u70", "photocraft#7 again");
  assert.equal(await countOf(db, "photocraft", 7), 1);
});
