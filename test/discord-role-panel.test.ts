// The contributor role panel's Verify button: a linked member with a merged pull request gets the role call, a member
// with no linked GitHub account gets the link steps, and a linked member without a merge gets no role call.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { Interactions } from "../src/discord/interactions.ts";
import { DiscordKeys } from "../src/discord/keys.ts";
import { createLinkCode, redeemLinkCode } from "../src/discord/links.ts";
import { installRolePanel, setRoleConfig } from "../src/discord/role-panel.ts";
import type { CallbackData, CommandDef, DiscordRest, EditBody, MessageBody } from "../src/discord/rest.ts";
import { saveChannels } from "../src/data/discord/index.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "discord-role-"));
const db = await connectDb(join(dir, "d.db"));
const keys = new DiscordKeys("k".repeat(40));
after(async () => { await db.close(); rmSync(dir, { recursive: true, force: true }); });

class FakeRest implements DiscordRest {
  edits: EditBody[] = [];
  roles: { guild: string; user: string; role: string }[] = [];
  async createMessage(_c: string, _b: MessageBody) { return { id: "m" }; }
  async editMessage() {}
  async deleteMessage() {}
  async pinMessage() {}
  async addMemberRole(guild: string, user: string, role: string) { this.roles.push({ guild, user, role }); }
  async memberRoles() { return [] as string[]; }
  async guildRole() { return { permissions: "0", managed: false }; }
  async interactionCallback(_i: string, _t: string, _type: number, _data?: CallbackData) {}
  async editInteractionResponse(_a: string, _t: string, body: EditBody) { this.edits.push(body); }
  async overwriteGuildCommands(_a: string, _g: string, _c: CommandDef[]) {}
}

const rest = new FakeRest();
const ix = new Interactions(rest, (l) => assert.fail(l));
installRolePanel(ix, { db, keys, rest, log: (l) => assert.fail(l), check: async (_db, who) => ({ merged: who.login === "merger", via: "search" }) });

const GUILD = "100000000000000001", CHANNEL = "100000000000000002", ROLE = "100000000000000003";
await saveChannels(db, [{ channelId: CHANNEL, guildId: GUILD, guildName: "Server", name: "contributor-role" }]);
await setRoleConfig(db, "test", { channelId: CHANNEL, roleId: ROLE });
for (const [user, login] of [["200000000000000001", "merger"], ["200000000000000002", "newcomer"]] as const) {
  const { code } = await createLinkCode(db, keys, login);
  assert.equal(await redeemLinkCode(db, keys, code, user), login);
}

let n = 0;
const press = async (user: string): Promise<string> => {
  rest.edits.length = 0;
  ix.dispatch("INTERACTION_CREATE", { id: `i${++n}`, token: "t", type: 3, application_id: "app1", guild_id: GUILD, channel_id: CHANNEL, member: { user: { id: user }, roles: [] }, data: { custom_id: "rolecheck:verify" } });
  for (let k = 0; k < 1000 && !rest.edits.length; k++) await new Promise((r) => setTimeout(r, 5));
  return String(rest.edits[0]?.content ?? "");
};

test("Verify gives the role only to a linked member with a merged pull request", async () => {
  assert.match(await press("200000000000000001"), /contributor role/);
  assert.deepEqual(rest.roles, [{ guild: GUILD, user: "200000000000000001", role: ROLE }]);

  assert.match(await press("200000000000000009"), /\/autocraft account action:link/);
  assert.match(await press("200000000000000002"), /No merged pull request by newcomer/);
  assert.equal(rest.roles.length, 1);
});
