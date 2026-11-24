// Whether the bot can view a channel, from role permissions and channel overwrites.
import assert from "node:assert/strict";
import { test } from "node:test";
import { GuildPerms } from "../src/discord/perms.ts";

const VIEW = String(1 << 10);
const G = "g1", BOT = "bot", MODS = "mods";

function perms(opts: { everyone?: string; botRole?: string; overwrites?: Record<string, { id: string; type: number; allow?: string; deny?: string }[]> }): GuildPerms {
  const p = new GuildPerms();
  p.botId = BOT;
  const channels = Object.entries(opts.overwrites ?? {}).map(([id, permission_overwrites]) => ({ id, permission_overwrites }));
  p.setGuild(G, [{ id: G, permissions: opts.everyone ?? VIEW }, { id: MODS, permissions: opts.botRole ?? "0" }], [{ user: { id: BOT }, roles: [MODS] }], channels);
  return p;
}

test("bot role allow beats an @everyone deny on the channel", () => {
  const p = perms({ overwrites: { c: [{ id: G, type: 0, deny: VIEW }, { id: MODS, type: 0, allow: VIEW }] } });
  assert.equal(p.viewable(G, "c"), true);
});

test("a deny in the overwrites the payload gives a category-synced channel hides it", () => {
  const p = perms({ overwrites: { synced: [{ id: G, type: 0, deny: VIEW }], open: [] } });
  assert.equal(p.viewable(G, "synced"), false);
  assert.equal(p.viewable(G, "open"), true);
});

test("administrator sees every channel, and a missing bot member hides nothing", () => {
  const admin = perms({ everyone: "0", botRole: String(1 << 3), overwrites: { c: [{ id: G, type: 0, deny: VIEW }] } });
  assert.equal(admin.viewable(G, "c"), true);
  const unknown = new GuildPerms();
  unknown.botId = BOT;
  unknown.setGuild(G, [{ id: G, permissions: "0" }], [], [{ id: "c" }]);
  assert.equal(unknown.viewable(G, "c"), true);
});
