// Discord mention counting: the reference parser, the gateway event handler against a real database, and the public privacy page.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { loadConfig } from "../src/dash/server/config.ts";
import { defaultRoutes, startServer } from "../src/dash/server/index.ts";
import { FakeProvider } from "../src/dash/server/provider.ts";
import { DiscordKeys } from "../src/discord/keys.ts";
import { parseRefs } from "../src/discord/refs.ts";
import { handleMeta } from "../src/discord/index.ts";
import { setup } from "../src/dash/api/discord.ts";
import { countOf, forgetAuthor, handleDispatch, linksOf } from "../src/discord/store.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { cols, excluded } from "../src/db/kx.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "discord-test-"));
const db = await connectDb(join(dir, "d.db"));
const keys = new DiscordKeys("k".repeat(40));
const repos = [{ owner: "storytold", name: "photocraft" }, { owner: "storytold", name: "pdfcraft" }];

after(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("reference parser", () => {
  test("counts item URLs and repo#n of tracked repos, each item once", () => {
    const text = "see https://github.com/storytold/photocraft/pull/12#issuecomment-5 and photocraft#12, also pdfcraft#7 and storytold/pdfcraft#8";
    assert.deepEqual(parseRefs(text, repos).map((r) => `${r.repo}#${r.number}`), ["photocraft#12", "pdfcraft#7", "pdfcraft#8"]);
  });
  test("ignores untracked repos, other owners and look-alikes", () => {
    const text = "https://github.com/other/photocraft/issues/3 elsewhere#4 other/pdfcraft#5 xphotocraft#6 photocraft#x";
    assert.deepEqual(parseRefs(text, repos), []);
  });
});

describe("event handler", () => {
  before(async () => {
    await db.run(db.k.insertInto("tracked_repos").values({ name: "photocraft" }).onConflict((oc) => oc.doNothing()));
    await db.run(db.k.insertInto("discord_channels").values([
      { channel_id: "c1", guild_id: "g1", guild_name: "Guild", name: "dev", watched: 1 },
      { channel_id: "c2", guild_id: "g1", guild_name: "Guild", name: "off", watched: 0 },
    ]));
  });
  const msg = (id: string, content: string, channel = "c1") => ({ id, channel_id: channel, guild_id: "g1", content, timestamp: "2026-11-01T10:00:00.000Z", author: { id: "u1" } });

  test("a forwarded message counts the items its snapshot names", async () => {
    const fwd = { ...msg("mf1", ""), content: "", message_reference: { type: 1 }, message_snapshots: [{ message: { content: "see https://github.com/storytold/photocraft/issues/77" } }] };
    await handleDispatch(db, keys, "MESSAGE_CREATE", fwd);
    assert.equal(await countOf(db, "photocraft", 77), 1);
    await handleDispatch(db, keys, "MESSAGE_DELETE", { id: "mf1", channel_id: "c1" });
  });

  test("create, edit and delete keep counts right and rows encrypted", async () => {
    await handleDispatch(db, keys, "MESSAGE_CREATE", msg("m1", "look at photocraft#1 and photocraft#2"));
    await handleDispatch(db, keys, "MESSAGE_CREATE", msg("m2", "photocraft#1 again"));
    await handleDispatch(db, keys, "MESSAGE_CREATE", msg("m3", "photocraft#1", "c2"));
    assert.equal(await countOf(db, "photocraft", 1), 2);
    assert.equal(await countOf(db, "photocraft", 2), 1);
    const raw = JSON.stringify(await db.all(db.k.selectFrom("discord_mentions").select(cols("discord_mentions"))));
    for (const plain of ["m1", "u1", "c1", "g1", "photocraft#1 again"]) assert.ok(!raw.includes(`"${plain}"`) && !raw.includes(`/${plain}`), `${plain} is stored in the clear`);
    const links = await linksOf(db, keys, "photocraft", 2);
    assert.deepEqual(links.map((l) => l.url), ["https://discord.com/channels/g1/c1/m1"]);

    await handleDispatch(db, keys, "MESSAGE_UPDATE", msg("m1", "now only photocraft#2"));
    assert.equal(await countOf(db, "photocraft", 1), 1);
    assert.equal(await countOf(db, "photocraft", 2), 1);
    await handleDispatch(db, keys, "MESSAGE_UPDATE", { id: "m2", channel_id: "c1", guild_id: "g1" });  // embed-only update: no content, no change
    assert.equal(await countOf(db, "photocraft", 1), 1);

    await handleDispatch(db, keys, "MESSAGE_DELETE", { id: "m2", channel_id: "c1" });
    assert.equal(await countOf(db, "photocraft", 1), 0);
    await handleDispatch(db, keys, "MESSAGE_DELETE_BULK", { ids: ["m1"], channel_id: "c1" });
    assert.equal((await db.get(db.k.selectFrom("discord_mentions").select((eb) => eb.fn.countAll<number>().as("n"))))!.n, 0);
  });

  test("a deletion request by user id removes that author's rows, also after an edit without an author", async () => {
    const columns = (await db.k.introspection.getTables()).filter((t) => t.name === "discord_mentions").flatMap((t) => t.columns.map((c) => c.name));
    assert.ok(!columns.some((c) => /author|user/.test(c)), "no per-person plain column");
    await handleDispatch(db, keys, "MESSAGE_CREATE", msg("m4", "photocraft#5"));
    await handleDispatch(db, keys, "MESSAGE_CREATE", { ...msg("m5", "photocraft#5"), author: { id: "u2" } });
    await handleDispatch(db, keys, "MESSAGE_UPDATE", { id: "m4", channel_id: "c1", guild_id: "g1", content: "photocraft#5 edited" });
    assert.equal(await forgetAuthor(db, keys, "u1"), 1);
    assert.equal(await countOf(db, "photocraft", 5), 1);
  });

  test("a delete applies in an unwatched channel, and a deleted channel takes its rows", async () => {
    await handleDispatch(db, keys, "MESSAGE_CREATE", msg("m6", "photocraft#6"));
    await handleDispatch(db, keys, "MESSAGE_CREATE", msg("m7", "photocraft#6"));
    await db.run(db.k.updateTable("discord_channels").set({ watched: 0 }).where("channel_id", "=", "c1"));
    await handleDispatch(db, keys, "MESSAGE_DELETE", { id: "m6", channel_id: "c1" });
    assert.equal(await countOf(db, "photocraft", 6), 1);
    await handleDispatch(db, keys, "CHANNEL_DELETE", { id: "c1" });
    assert.equal(await countOf(db, "photocraft", 6), 0);
    await db.run(db.k.updateTable("discord_channels").set({ watched: 1 }).where("channel_id", "=", "c1"));
  });

  test("a thread message counts under its watched parent", async () => {
    await handleMeta(db, "THREAD_CREATE", { id: "t1", guild_id: "g1", parent_id: "c1", name: "topic" });
    await handleDispatch(db, keys, "MESSAGE_CREATE", msg("m8", "photocraft#8", "t1"));
    assert.equal(await countOf(db, "photocraft", 8), 1);
    await handleMeta(db, "THREAD_CREATE", { id: "t2", guild_id: "g1", parent_id: "c2", name: "other" });
    await handleDispatch(db, keys, "MESSAGE_CREATE", msg("m9", "photocraft#9", "t2"));
    assert.equal(await countOf(db, "photocraft", 9), 0);
  });

  test("a message naming over 20 items records none; a flooding author stops being recorded, another is not", async () => {
    await db.run(db.k.insertInto("discord_channels").values({ channel_id: "c3", guild_id: "g1", guild_name: "Guild", name: "flood", watched: 1 }));
    const from = (author: string, id: string, nums: number[]) => ({ ...msg(id, nums.map((n) => `photocraft#${n}`).join(" "), "c3"), author: { id: author } });
    const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
    await handleDispatch(db, keys, "MESSAGE_CREATE", from("flood-a", "f0", range(1000, 1021)));
    assert.equal(await countOf(db, "photocraft", 1000), 0);
    for (let i = 0; i < 5; i++) await handleDispatch(db, keys, "MESSAGE_CREATE", from("flood-a", `f${i + 1}`, range(2000 + i * 10, 2010 + i * 10)));
    assert.equal(await countOf(db, "photocraft", 2000), 1);
    assert.equal(await countOf(db, "photocraft", 2040), 0);
    await handleDispatch(db, keys, "MESSAGE_CREATE", from("flood-b", "g1x", [3000]));
    assert.equal(await countOf(db, "photocraft", 3000), 1);
    await db.run(db.k.deleteFrom("discord_mentions").where("number", ">=", 2000));
    await db.run(db.k.deleteFrom("discord_mentions").where("number", "=", 3000));
  });
});

describe("admin API", () => {
  test("the Discord page's data is for operators only", async () => {
    const route = (await defaultRoutes()).find((r) => r.method === "GET" && r.pattern === "/api/admin/discord");
    assert.equal(route?.operator, true);
    const viewer = { user: { login: "v", role: "viewer" } } as never;
    const res = await route!.handler(db, viewer);
    assert.equal(res.status, 403);
  });
});

describe("privacy page", () => {
  let close: () => Promise<void>;
  let base = "";
  before(async () => {
    const perms = join(dir, "perms.json");
    writeFileSync(perms, "{}");
    chmodSync(perms, 0o600);
    await db.run(db.k.insertInto("settings").values({ key: "discord_contact", value: "ask-us@example.org" }).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
    const config = loadConfig({ AUTOCRAFT_DEV_AUTH: "1", AUTOCRAFT_LISTEN: "127.0.0.1:0", AUTOCRAFT_DB: join(dir, "d.db"), AUTOCRAFT_DEV_PERMS: perms, AUTOCRAFT_WEB_DIST: dir });
    const s = await startServer({ config, db, provider: new FakeProvider(perms), routes: await defaultRoutes() });
    base = s.url;
    close = s.close;
  });
  after(() => close());

  test("is readable without a session and names the contact; other pages still need one", async () => {
    const r = await fetch(`${base}/privacy`, { headers: { accept: "text/html" } });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /ask-us@example\.org/);
    const terms = await fetch(`${base}/terms`, { headers: { accept: "text/html" } });
    assert.equal(terms.status, 200);
    assert.match(await terms.text(), /terms of use[\s\S]*ask-us@example\.org/i);
    const other = await fetch(`${base}/items`, { headers: { accept: "text/html" }, redirect: "manual" });
    assert.match(await other.text(), /http-equiv="refresh" content="0;url=\/auth\/signin/);
  });
});

describe("channel list order", () => {
  const op = { user: { role: "operator" } } as never;
  const names = async () => (await setup(db, op)).channels.filter((c) => c.guildId === "gs").map((c) => `${c.category ?? "-"}/${c.name}`);
  test("lists channels like Discord's sidebar, and follows a channel moved to another category", async () => {
    const ch = (id: string, name: string, position: number, parent_id: string | null) => ({ id, name, type: 0, position, parent_id });
    await handleMeta(db, "GUILD_CREATE", { id: "gs", name: "Sidebar", channels: [
      ch("s5", "late", 1, "k2"), { id: "k2", name: "Second", type: 4, position: 2 }, ch("s1", "b-free", 1, null), ch("s2", "a-free", 0, null),
      { id: "k1", name: "First", type: 4, position: 1 }, ch("s3", "zed", 0, "k1"), ch("s4", "alpha", 1, "k1"), ch("s6", "early", 0, "k2"),
    ] });
    assert.deepEqual(await names(), ["-/a-free", "-/b-free", "First/zed", "First/alpha", "Second/early", "Second/late"]);
    await handleMeta(db, "CHANNEL_UPDATE", { id: "s3", guild_id: "gs", name: "zed", type: 0, position: 0, parent_id: "k2" });
    await handleMeta(db, "CHANNEL_UPDATE", { id: "k1", guild_id: "gs", name: "First", type: 4, position: 3 });
    assert.deepEqual(await names(), ["-/a-free", "-/b-free", "Second/zed", "Second/early", "Second/late", "First/alpha"]);
  });
});
