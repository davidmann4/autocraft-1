// A Discord command that does not name its items in full acts on what the conversation is about: a bare number resolves to the item
// of that number posted in the channel (or asks which, when two are), and a yes in a thread with several items answers only the item
// with the open question.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { saveFollowPosts } from "../src/data/discord/index.ts";
import { AtCommands } from "../src/discord/at-commands.ts";
import { DiscordKeys } from "../src/discord/keys.ts";
import { createLinkCode, redeemLinkCode } from "../src/discord/links.ts";
import { Pings } from "../src/discord/pings.ts";
import type { CommandDef, DiscordRest, EditBody, MessageBody } from "../src/discord/rest.ts";
import type { Search } from "../src/discord/search.ts";
import { handleDispatch } from "../src/discord/store.ts";
import { follow, resultAad, threadTarget } from "../src/discord/threads.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "discord-context-"));
const db = await connectDb(join(dir, "d.db"));
const keys = new DiscordKeys("k".repeat(40));
after(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

class FakeRest implements DiscordRest {
  sent: { channelId: string; body: MessageBody }[] = [];
  async createMessage(channelId: string, body: MessageBody) { this.sent.push({ channelId, body }); return { id: `r${this.sent.length}` }; }
  async startThread() { return { id: "unused" }; }
  async editMessage() {}
  async deleteMessage() {}
  async interactionCallback() {}
  async editInteractionResponse(_a: string, _t: string, _b: EditBody) {}
  async overwriteGuildCommands(_a: string, _g: string, _c: CommandDef[]) {}
}

const rest = new FakeRest();
const commands = new AtCommands({ db, keys, rest, log: (l) => assert.fail(l), read: { translate: async () => null }, permission: async () => ({ kind: "ok", permission: "write" }) });
const pings = new Pings({ db, keys, rest, search: {} as Search, log: (l) => assert.fail(l), commands });
type Reply = { id: string; author: string; content?: string };
/** Sends a message and returns what the bot posted in answer. */
const say = async (id: string, user: string, content: string, o: { channel?: string; repliesTo?: Reply } = {}): Promise<string> => {
  const r = o.repliesTo;
  const m = {
    id, channel_id: o.channel ?? "c1", guild_id: "g1", content, type: r ? 19 : 0, author: { id: user }, timestamp: new Date().toISOString(),
    ...(r ? { message_reference: { message_id: r.id }, referenced_message: { author: { id: r.author }, content: r.content ?? "" } } : {}),
  };
  const sent = rest.sent.length;
  await handleDispatch(db, keys, "MESSAGE_CREATE", m);
  await pings.dispatch("MESSAGE_CREATE", m);
  await pings.idle();
  return rest.sent.slice(sent).map((s) => s.body.content ?? "").join("\n");
};
const started = async (): Promise<string[]> =>
  (await db.all(db.k.selectFrom("main.item_workflows").select(["repo", "number"]))).map((r) => `${r.repo}#${r.number}`).sort();
const workflow = async (repo: string, number: number, state: string, rec: object | null): Promise<void> => {
  const at = new Date().toISOString();
  await db.run(db.k.deleteFrom("main.item_workflows").where("repo", "=", repo).where("number", "=", number));
  await db.run(db.k.insertInto("item_workflows").values({ repo, number, kind: "pr", entry: "review", weight: 5, state, started_by: "nora", started_at: at, started_via: "discord", plan: "[]", rec: rec && JSON.stringify(rec), rec_at: rec && at, rec_head: rec && `sha${number}`, updated_at: at } as never));
};

before(async () => {
  for (const name of ["texturecraft", "photocraft"]) {
    await db.run(db.k.insertInto("tracked_repos").values([{ name }]).onConflict((oc) => oc.doNothing()));
    await db.run(db.k.insertInto("repos").values([{ name, owner: "storytold", visibility: "public" }]).onConflict((oc) => oc.doNothing()));
    await db.run(db.k.insertInto("main.repo_permissions").values({ login: "nora", repo: name, permission: "write", checked_at: new Date().toISOString() }));
  }
  for (const [repo, n] of [["texturecraft", 850], ["texturecraft", 854], ["photocraft", 12], ["photocraft", 850]] as const) {
    await db.run(db.k.insertInto("items").values({ repo, number: n, kind: "pr", state: "OPEN", title: `Change ${n}`, body: "", head_oid: `sha${n}`, url: `https://github.com/storytold/${repo}/pull/${n}` }));
  }
  await db.run(db.k.insertInto("discord_channels").values([{ channel_id: "c1", guild_id: "g1", guild_name: "G", name: "dev", watched: 1 }, { channel_id: "c2", guild_id: "g1", guild_name: "G", name: "art", watched: 1 }]));
  await db.run(db.k.insertInto("discord_channels").values({ channel_id: "th1", guild_id: "g1", guild_name: "G", name: "work", watched: 0, parent_id: "c2" } as never));
  await db.run(db.k.insertInto("main.access").values({ login: "nora", role: "maintainer" }).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.insertInto("main.settings").values({ key: "github_identity", value: "app" }).onConflict((oc) => oc.column("key").doUpdateSet({ value: "app" })));
  const { code } = await createLinkCode(db, keys, "nora");
  assert.equal(await redeemLinkCode(db, keys, code, "u70"), "nora");
  await pings.dispatch("READY", { user: { id: "100" } });
});

test("a bare number takes the item of that number posted in the channel, and asks which when two are", async () => {
  await say("m1", "u2", "texturecraft#850 is ready for review");
  await say("m2", "u3", "photocraft#12 too");
  const reply = await say("c-1", "u70", "<@100> merge 850");
  assert.deepEqual(await started(), ["texturecraft#850"]);
  assert.ok(reply.includes("texturecraft#850"), reply);

  await say("m3", "u3", "and photocraft#850 needs a look");
  const ask = await say("c-2", "u70", "<@100> merge 850");
  assert.match(ask, /Which one/);
  assert.ok(ask.includes("texturecraft#850") && ask.includes("photocraft#850"), ask);
  assert.deepEqual(await started(), ["texturecraft#850"]);
});

test("a yes in a thread with two items answers only the item whose question it is", async () => {
  const at = new Date(Date.now() - 60_000).toISOString();
  const targetHash = threadTarget(keys, "th1");
  const items = [{ repo: "texturecraft", number: 850 }, { repo: "texturecraft", number: 854 }];
  await follow(db, keys, { targetHash, channelHash: keys.hash("channel", "c2"), target: { kind: "thread", guildId: "g1", channelId: "th1", messageId: "cmd" }, author: keys.hash("author", "u70"), items, command: "review", login: "nora", at });
  const rec = { text: "Fix 1 and 2, then merge.", parts: { fix: [1, 2], drop: [] }, merges: true };
  const post = { targetHash, repo: "texturecraft", number: 854 };
  await saveFollowPosts(db, [{ ...post, statusHash: "s", resultKey: "k", resultHash: "h", linkHash: "l", sealed: keys.seal({ guildId: "g1", channelId: "th1", messageId: "bot-854", at }, resultAad(post)), at }]);
  const blocker = { id: "bot-854", author: "100", content: "**texturecraft#854** Stopped at a blocker. Reply yes to fix 1 and 2, then merge." };
  const about850 = async () => (await db.all(db.k.selectFrom("main.workflow_events").select("kind").where("repo", "=", "texturecraft").where("number", "=", 850).where("kind", "=", "answered"))).length;

  // A reply to the blocker post, and a yes to the bot that replies to nothing, each answer #854 and say nothing of #850.
  for (const [id, text, repliesTo] of [["y-1", "Yes", blocker], ["y-2", "<@100> yes", undefined]] as const) {
    await workflow("texturecraft", 850, "running", null);
    await workflow("texturecraft", 854, "recommending", rec);
    const reply = await say(id, "u70", text, { channel: "th1", ...(repliesTo ? { repliesTo } : {}) });
    assert.ok(reply.includes("texturecraft#854"), reply);
    assert.ok(!reply.includes("#850"), reply);
    assert.doesNotMatch(reply, /no open recommendation/);
    assert.equal(await about850(), 0);
  }
});
