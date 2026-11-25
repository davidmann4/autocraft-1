// Discord issue search: ping replies from the embeddings alone, deleting a reply with its
// ping, the commands, and that no message text reaches the database.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Embedder } from "../src/embed/model.ts";
import { toBlob } from "../src/embed/store.ts";
import { VectorIndex } from "../src/embed/vectors.ts";
import { dispatcher } from "../src/discord/index.ts";
import { Interactions } from "../src/discord/interactions.ts";
import { DiscordKeys } from "../src/discord/keys.ts";
import { installAccountCommands } from "../src/discord/commands.ts";
import { createLinkCode, loginOf } from "../src/discord/links.ts";
import { Pings } from "../src/discord/pings.ts";
import { RestClient, RestError, callbackPayload, type CommandDef, type DiscordRest, type EditBody, type MessageBody } from "../src/discord/rest.ts";
import { deliver, renderMatches } from "../src/discord/reply.ts";
import { Search } from "../src/discord/search.ts";
import { installSearchCommands } from "../src/discord/search-commands.ts";
import { useTestAccount } from "./accounts-fixture.ts";
import { SCRATCH } from "./scratch.ts";
import { mapSeq } from "../src/async-seq.ts";
import { connectDb } from "../src/db/open.ts";
import { excluded } from "../src/db/kx.ts";
import { sqliteOnly } from "./test-db.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "discord-search-"));
const db = await connectDb(join(dir, "d.db"));
const keys = new DiscordKeys("k".repeat(40));
await useTestAccount(db);
after(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

const VOCAB = ["webp", "export", "quality", "dark", "mode", "layers", "crash"];
const embedder: Embedder = {
  id: "fake", dim: VOCAB.length,
  async embed(texts) {
    return texts.map((t) => {
      const v = new Float32Array(VOCAB.length);
      VOCAB.forEach((w, i) => { if (t.toLowerCase().includes(w)) v[i] = 1; });
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  },
};

class FakeRest implements DiscordRest {
  sent: { channelId: string; body: MessageBody; id: string }[] = [];
  deleted: string[] = [];
  callbacks: { type: number; ephemeral?: boolean; choices?: unknown[] }[] = [];
  edits: EditBody[] = [];
  commands: { guildId: string; commands: CommandDef[] }[] = [];
  async createMessage(channelId: string, body: MessageBody) { const id = `r${this.sent.length + 1}`; this.sent.push({ channelId, body, id }); return { id }; }
  async editMessage() {}
  async deleteMessage(_c: string, id: string) { this.deleted.push(id); }
  async interactionCallback(_i: string, _t: string, type: 4 | 5 | 8, data?: { ephemeral?: boolean; choices?: unknown[] }) { this.callbacks.push({ type, ephemeral: data?.ephemeral, choices: data?.choices }); }
  async editInteractionResponse(_a: string, _t: string, body: EditBody) { this.edits.push(body); }
  async overwriteGuildCommands(_a: string, guildId: string, commands: CommandDef[]) { this.commands.push({ guildId, commands }); }
}


const rest = new FakeRest();
/** Waits until `ok` holds: replies are asynchronous, and on Postgres slower than on SQLite. */
const until = async (ok: () => boolean): Promise<void> => {
  for (let k = 0; k < 1000 && !ok(); k++) await new Promise((r) => setTimeout(r, 5));
};
/** The reply edit that follows the first `seen` edits. */
const editAfter = async (seen: number): Promise<EditBody> => {
  await until(() => rest.edits.length > seen);
  return rest.edits.at(-1)!;
};
const search = new Search({ db, embedder, index: new VectorIndex(embedder), log: () => {} });
const pings = new Pings({ db, keys, rest, search, log: (l) => assert.fail(l) });
// The handler startDiscord gives the gateway: mention rows first, then pings, so a delete finds our reply.
const dispatch = dispatcher(db, keys, new Interactions(rest, (l) => assert.fail(l)), pings);

const QUESTION = "zebra-unique webp export quality is ignored";
const msg = (id: string, over: Record<string, unknown> = {}) => ({
  id, channel_id: "c1", guild_id: "g1", content: "<@bot1> is this known?", type: 19, author: { id: "u1" }, mentions: [{ id: "bot1" }],
  message_reference: { message_id: "q1" }, referenced_message: { content: QUESTION }, ...over,
});

const emb = async (repo: string, number: number, vec: Uint8Array, at: string) =>
  await db.run(db.k.insertInto("item_embeddings").values({ repo, number, model: "fake", hash: "h", vec, at }));

before(async () => {
  await db.run(db.k.insertInto("tracked_repos").values([{ name: "photocraft" }, { name: "secret" }]).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.insertInto("repos").values([{ name: "photocraft", owner: "storytold", visibility: "public" }, { name: "secret", owner: "storytold", visibility: "private" }])
    .onConflict((oc) => oc.column("name").doUpdateSet(excluded(["visibility"]))));
  await db.run(db.k.insertInto("discord_channels").values([
    { channel_id: "c1", guild_id: "g1", guild_name: "G", name: "dev", watched: 1, default_repo: "photocraft" },
    { channel_id: "c2", guild_id: "g1", guild_name: "G", name: "off", watched: 0, default_repo: null },
  ]));
  const recent = new Date(Date.now() - 5 * 86_400_000).toISOString();
  const rows: [string, number, string, string, string | null, string | null, string][] = [
    ["photocraft", 1, "issue", "OPEN", null, null, "Export to WebP ignores the quality setting"],
    ["photocraft", 2, "issue", "OPEN", null, null, "Dark mode for the layers panel"],
    ["photocraft", 3, "issue", "CLOSED", "COMPLETED", recent, "Add WebP export"],
    ["photocraft", 4, "pr", "OPEN", null, null, "WebP export quality fix"],
    ["photocraft", 5, "issue", "CLOSED", "NOT_PLANNED", recent, "WebP export quality in another format"],
    ["secret", 1, "issue", "OPEN", null, null, "WebP export quality in a private repo"],
  ];
  for (const [repo, n, kind, state, reason, closed, title] of rows) {
    await db.run(db.k.insertInto("items").values({ repo, number: n, kind, state, state_reason: reason, closed_at: closed, title, body: "", url: `https://github.com/storytold/${repo}/${kind === "pr" ? "pull" : "issues"}/${n}` }));
    await emb(repo, n, toBlob((await embedder.embed([title], "item"))[0]!), recent);
  }
  // A security-labelled issue of a public repo is never a candidate, however close it is.
  await db.run(db.k.insertInto("items").values({ repo: "photocraft", number: 6, kind: "issue", state: "OPEN", title: "WebP export quality hole", body: "", url: "https://github.com/storytold/photocraft/issues/6", labels: '["Security"]' }));
  await emb("photocraft", 6, toBlob((await embedder.embed(["WebP export quality hole"], "item"))[0]!), recent);
  await pings.dispatch("READY", { user: { id: "bot1" } });
});

type V2 = { type: number; content?: string; components?: V2[]; accessory?: V2; label?: string; url?: string; custom_id?: string; style?: number };
/** The text of a Components V2 body, one line block per TextDisplay. */
const v2text = (b: { components?: unknown[] }): string => ((b.components ?? []) as V2[]).flatMap((c) => (c.type === 9 ? c.components! : [c])).filter((c) => c.type === 10).map((c) => c.content).join("\n");
/** Every button of a Components V2 body in order: section accessories, then the action row. */
const v2buttons = (b: { components?: unknown[] }): V2[] => ((b.components ?? []) as V2[]).flatMap((c) => (c.type === 9 ? [c.accessory!] : c.type === 1 ? c.components! : []));

describe("ping replies", () => {
  test("a reply-ping searches the quoted text and replies once, publicly, with link buttons and no mentions", async () => {
    await pings.dispatch("MESSAGE_CREATE", msg("p1"));
    await pings.dispatch("MESSAGE_CREATE", msg("p1"));
    await pings.idle();
    assert.equal(rest.sent.length, 1);
    const { body } = rest.sent[0]!;
    assert.deepEqual(body.allowed_mentions, { parse: [] });
    assert.deepEqual(body.message_reference, { message_id: "p1", fail_if_not_exists: false });
    assert.match(v2text(body), /photocraft#1 Export to WebP ignores the quality setting$/m);
    assert.match(v2text(body), /photocraft#3 Add WebP export \(closed\)/);
    const buttons = v2buttons(body) as { style: number; label: string; url?: string; custom_id?: string }[];
    // Each link button is the accessory of the section holding its result's text.
    const sections = body.components!.filter((c) => (c as V2).type === 9) as V2[];
    assert.equal(sections.length, 3);
    for (const sec of sections) assert.ok(sec.components![0]!.content!.startsWith(sec.accessory!.label!));
    assert.deepEqual(buttons.map((b) => b.label), ["photocraft#1", "photocraft#4", "photocraft#3", "File a new issue"]);
    assert.ok(buttons.slice(0, 3).every((b) => b.style === 5));
    assert.match(buttons[3]!.custom_id!, /^inewi:open:photocraft:/);
    // The reply comes from the embeddings alone: no model call is recorded.
    assert.equal((await db.get(db.k.selectFrom("agent_runs").select((eb) => eb.fn.countAll<number>().as("n"))))!.n, 0);
    assert.equal((await db.get(db.k.selectFrom("remote_calls").select((eb) => eb.fn.countAll<number>().as("n"))))!.n, 0);
  });

  test("bots, unwatched channels and edits get no reply", async () => {
    const before = rest.sent.length;
    await pings.dispatch("MESSAGE_CREATE", msg("p2", { author: { id: "b", bot: true } }));
    await pings.dispatch("MESSAGE_CREATE", msg("p3", { channel_id: "c2" }));
    await pings.dispatch("MESSAGE_UPDATE", msg("p1"));
    // Discord lists the author of a replied-to message in `mentions`: without the bot in the text it is not a ping.
    await pings.dispatch("MESSAGE_CREATE", msg("p4", { content: "thanks, will check", mentions: [{ id: "bot1" }] }));
    // A reply to one of the bot's own messages is not a ping either, even with the bot named.
    await pings.dispatch("MESSAGE_CREATE", msg("p4b", { referenced_message: { content: "bot answer", author: { id: "bot1" } } }));
    await pings.idle();
    assert.equal(rest.sent.length, before);
  });

  test("matches are shown open first, then by comments plus reactions", async () => {
    const set = (comments_count: number, reactions_count: number | null, number: number) => db.run(db.k.updateTable("items").set({ comments_count, reactions_count }).where("repo", "=", "photocraft").where("number", "=", number));
    await set(40, 10, 3); // closed, most active
    await set(1, null, 1); // open, little activity (no reactions stored)
    await set(2, 5, 2); // open, more activity
    try {
      const found = await search.find("webp export quality dark mode layers");
      assert.deepEqual(found.matches.map((m) => m.number), [2, 1, 4, 3]);
    } finally {
      await db.run(db.k.updateTable("items").set({ comments_count: null, reactions_count: null }).where("repo", "=", "photocraft"));
    }
  });

  test("deleting the ping, or the quoted message, deletes our reply through the combined dispatch", async () => {
    await pings.dispatch("MESSAGE_CREATE", msg("p7", { message_reference: { message_id: "q7" }, referenced_message: { content: "webp export quality" } }));
    await pings.dispatch("MESSAGE_CREATE", msg("p8", { message_reference: { message_id: "q8" }, referenced_message: { content: "webp export quality" }, author: { id: "u2" } }));
    await pings.idle();
    const idOf = (i: number) => rest.sent[i]!.id;
    const n = rest.sent.length;
    await dispatch("MESSAGE_DELETE", { id: "p7" });
    await dispatch("MESSAGE_DELETE", { id: "q8" });
    await pings.idle();
    assert.deepEqual(rest.deleted.sort(), [idOf(n - 2), idOf(n - 1)].sort());
    assert.equal((await db.get(db.k.selectFrom("discord_replies").select((eb) => eb.fn.countAll<number>().as("n")).where("ping_hash", "in", [keys.hash("message", "p7"), keys.hash("message", "p8")])))!.n, 0);
  });

  test("no question text is stored in any table", { skip: sqliteOnly("reads sqlite_master") }, async () => {
    const dump = (await mapSeq((await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]), async (t) => JSON.stringify((await db.prepare(`SELECT * FROM "${t.name}"`).all() as object[]).map((r) => Object.values(r).map((v) => (v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v))))))
      .join("\n");
    for (const needle of ["zebra-unique", "is this known", "crash in layers"]) assert.ok(!dump.includes(needle), needle);
  });
});

describe("commands", () => {
  test("the message command is deferred as ephemeral, then edited with the result; guild commands register once", async () => {
    const ix = new Interactions(rest, (l) => assert.fail(l));
    installSearchCommands(ix, { db, keys, search });
    ix.dispatch("READY", { application: { id: "app1" } });
    ix.dispatch("GUILD_CREATE", { id: "g1" });
    ix.dispatch("GUILD_CREATE", { id: "g1" });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(rest.commands.length, 1);
    assert.deepEqual(rest.commands[0]!.commands.map((c) => [c.name, c.type]), [["autocraft", 1], ["Find issue", 3]]);
    const seen = rest.edits.length;
    ix.dispatch("INTERACTION_CREATE", { id: "i1", token: "t", type: 2, application_id: "app1", channel_id: "c1", member: { user: { id: "u9" } }, data: { name: "Find issue", type: 3, target_id: "m1", resolved: { messages: { m1: { content: "dark mode layers" } } } } });
    const edit = await editAfter(seen);
    assert.deepEqual(rest.callbacks.at(-1), { type: 5, ephemeral: true, choices: undefined });
    assert.match(v2text(edit), /photocraft#2 Dark mode for the layers panel/);
  });

  test("/autocraft link, status, and stats: a code links the caller, hidden items are not found, repo choices are public repos", async () => {
    const ix = new Interactions(rest, (l) => assert.fail(l));
    installAccountCommands(ix, { db, keys });
    let seen = 0;
    const call = (id: string, sub: string, options: unknown[], user = "u50") => {
      seen = rest.edits.length;
      ix.dispatch("INTERACTION_CREATE", { id, token: "t", type: 2, application_id: "app1", channel_id: "c1", member: { user: { id: user } }, data: { name: "autocraft", type: 1, options: [{ name: sub, type: 1, options }] } });
    };
    const settle = () => editAfter(seen);
    const { code } = await createLinkCode(db, keys, "mira");
    call("i2", "link", [{ name: "code", type: 3, value: code }]);
    await settle();
    assert.equal(rest.edits.at(-1)!.content, "Linked to mira");
    assert.equal(await loginOf(db, keys, "u50"), "mira");
    call("i3", "status", [{ name: "item", type: 3, value: "photocraft#6" }]);
    await settle();
    assert.match(rest.edits.at(-1)!.content!, /No item found/);
    call("i4", "status", [{ name: "item", type: 3, value: "photocraft#2" }]);
    await settle();
    assert.match(rest.edits.at(-1)!.content!, /photocraft#2 Dark mode for the layers panel\nNew/);
    ix.dispatch("INTERACTION_CREATE", { id: "i5", token: "t", type: 4, application_id: "app1", data: { name: "autocraft", options: [{ name: "stats", type: 1, options: [{ name: "repo", type: 3, value: "ph", focused: true }] }] } });
    await until(() => rest.callbacks.at(-1)?.type === 8);
    assert.deepEqual(rest.callbacks.at(-1), { type: 8, ephemeral: undefined, choices: [{ name: "photocraft", value: "photocraft" }] });
    call("i6", "unlink", []);
    await settle();
    assert.equal(await loginOf(db, keys, "u50"), null);
  });
});

describe("/autocraft do", () => {
  test("an unlinked user, a linked user without write access and a repo not switched on are refused; write access runs it", async () => {
    const ix = new Interactions(rest, (l) => assert.fail(l));
    installAccountCommands(ix, { db, keys });
    const run = async (id: string, user: string, text: string) => {
      const seen = rest.edits.length;
      ix.dispatch("INTERACTION_CREATE", { id, token: "t", type: 2, application_id: "app1", channel_id: "c1", member: { user: { id: user } }, data: { name: "autocraft", type: 1, options: [{ name: "do", type: 1, options: [{ name: "text", type: 3, value: text }] }] } });
      return (await editAfter(seen)).content!;
    };
    const workflows = async () => Number((await db.get(db.k.selectFrom("main.item_workflows").select((eb) => eb.fn.countAll<number>().as("n"))))!.n);
    assert.match(await run("d1", "u70", "review: photocraft#4"), /Link your account/);
    const { code } = await createLinkCode(db, keys, "nora");
    const linked = rest.edits.length;
    ix.dispatch("INTERACTION_CREATE", { id: "d2", token: "t", type: 2, application_id: "app1", channel_id: "c1", member: { user: { id: "u70" } }, data: { name: "autocraft", type: 1, options: [{ name: "link", type: 1, options: [{ name: "code", type: 3, value: code }] }] } });
    await editAfter(linked);
    await db.run(db.k.insertInto("main.access").values({ login: "nora", role: "maintainer" }).onConflict((oc) => oc.doNothing()));
    assert.match(await run("d3", "u70", "review: photocraft#4"), /not switched on/);
    await db.run(db.k.updateTable("main.tracked_repos").set({ workflow: "new" }).where("name", "=", "photocraft"));
    await db.run(db.k.insertInto("main.settings").values({ key: "github_identity", value: "app" }).onConflict((oc) => oc.column("key").doUpdateSet({ value: "app" })));
    assert.match(await run("d4", "u70", "review: photocraft#4"), /no write access/);
    assert.equal(await workflows(), 0);
    await db.run(db.k.insertInto("main.repo_permissions").values({ login: "nora", repo: "photocraft", permission: "write", checked_at: new Date().toISOString() }));
    await run("d5", "u70", "review: photocraft#4");
    assert.equal(await workflows(), 1);
  });
});

describe("account command limits", () => {
  test("stats and status allow 10 a minute per person; the window slides", async () => {
    let now = 1_000_000;
    const ix = new Interactions(rest, (l) => assert.fail(l));
    installAccountCommands(ix, { db, keys, now: () => now });
    let seen = 0;
    const status = (id: string, user: string) => {
      seen = rest.edits.length;
      ix.dispatch("INTERACTION_CREATE", { id, token: "t", type: 2, application_id: "app1", channel_id: "c1", member: { user: { id: user } }, data: { name: "autocraft", type: 1, options: [{ name: "status", type: 1, options: [{ name: "item", type: 3, value: "photocraft#2" }] }] } });
    };
    const settle = () => editAfter(seen);
    for (let i = 0; i < 10; i++) { status(`s${i}`, "u60"); await settle(); assert.match(rest.edits.at(-1)!.content!, /photocraft#2/); }
    status("s10", "u60"); await settle();
    assert.match(rest.edits.at(-1)!.content!, /Too many requests/);
    status("s11", "u61"); await settle();
    assert.match(rest.edits.at(-1)!.content!, /photocraft#2/);
    now += 61_000;
    status("s12", "u60"); await settle();
    assert.match(rest.edits.at(-1)!.content!, /photocraft#2/);
  });
});

describe("rest", () => {
  test("a used-up bucket delays only its own channel; autocomplete results carry only choices", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const seen: string[] = [];
    const fetcher = (async (url: string) => {
      seen.push(url);
      return new Response("{}", { status: 200, headers: { "x-ratelimit-bucket": "b1", "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "5" } });
    }) as unknown as typeof fetch;
    const client = new RestClient({ token: "t", fetch: fetcher, now: () => now, sleep: async (ms) => { sleeps.push(ms); } });
    await client.createMessage("111", { content: "a", allowed_mentions: { parse: [] } });
    await client.createMessage("222", { content: "b", allowed_mentions: { parse: [] } });
    assert.deepEqual(sleeps, []);
    await client.createMessage("111", { content: "c", allowed_mentions: { parse: [] } });
    assert.deepEqual(sleeps, [5000]);
    assert.deepEqual(callbackPayload(8, { choices: [{ name: "a", value: "a" }], content: "x", components: [] }, false), { type: 8, data: { choices: [{ name: "a", value: "a" }] } });
    assert.deepEqual(callbackPayload(5, {}, true), { type: 5, data: { flags: 64 } });
    assert.deepEqual(callbackPayload(4, { content: "hi" }, true), { type: 4, data: { content: "hi", allowed_mentions: { parse: [] }, flags: 64 } });
  });
});

describe("repo named in the question", () => {
  before(async () => {
    await db.run(db.k.insertInto("tracked_repos").values({ name: "vectorcraft" }).onConflict((oc) => oc.doNothing()));
    await db.run(db.k.insertInto("repos").values({ name: "vectorcraft", owner: "storytold", visibility: "public" }).onConflict((oc) => oc.column("name").doUpdateSet(excluded(["visibility"]))));
    const title = "Crash in layers";
    await db.run(db.k.insertInto("items").values({ repo: "vectorcraft", number: 1, kind: "issue", state: "OPEN", title, body: "", url: "https://github.com/storytold/vectorcraft/issues/1" }));
    await db.run(db.k.insertInto("item_embeddings").values({ repo: "vectorcraft", number: 1, model: "fake", hash: "h", vec: toBlob((await embedder.embed([title], "item"))[0]!), at: new Date().toISOString() }));
  });
  const repos = async (q: string, repo?: string) => [...new Set((await new Search({ db, embedder, index: new VectorIndex(embedder), log: () => {} }).candidates(q, repo)).map((c) => c.repo))].sort();

  test("a named repo restricts the search, an explicit repo wins, two named repos search everything", async () => {
    assert.deepEqual(await repos("crash in layers"), ["photocraft", "vectorcraft"]);
    assert.deepEqual(await repos("PhotoCraft crash in layers"), ["photocraft"]);
    assert.deepEqual(await repos("photocraft crash in layers", "vectorcraft"), ["vectorcraft"]);
    assert.deepEqual(await repos("photocraft or vectorcraft crash in layers"), ["photocraft", "vectorcraft"]);
    assert.deepEqual(await repos("crash in layers", "secret"), ["photocraft", "vectorcraft"]);
  });
});

describe("pull requests", () => {
  test("open and recently merged pull requests are candidates and labelled; a closed unmerged one is not", async () => {
    const at = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
    const vec = toBlob((await embedder.embed(["WebP export quality merged change"], "item"))[0]!);
    for (const [n, state, merged] of [[7, "MERGED", at], [8, "CLOSED", null], [9, "MERGED", old]] as const) {
      await db.run(db.k.insertInto("items").values({ repo: "photocraft", number: n, kind: "pr", state, closed_at: merged ?? at, merged_at: merged, title: "WebP export quality merged change", body: "", url: `https://github.com/storytold/photocraft/pull/${n}` }));
      await emb("photocraft", n, vec, at);
    }
    const fresh = new Search({ db, embedder, index: new VectorIndex(embedder), log: () => {} });
    const found = { matches: await fresh.candidates("zebra-unique webp export quality") };
    const by = (n: number) => found.matches.find((m) => m.number === n);
    assert.equal(by(4)?.pr, true);
    assert.deepEqual([by(7)?.pr, by(7)?.merged], [true, true]);
    assert.equal(by(8), undefined);
    assert.equal(by(9), undefined, "merged more than 7 days ago");
    const { score: _s, body: _b, activity: _a, updatedAt: _u, ...m7 } = by(7)!;
    const rendered = await renderMatches(db, [m7], "q", undefined);
    assert.match(v2text(rendered), /photocraft#7 .* \(PR\) \(merged\)/);
  });

  test("a rejected V2 reply is sent again with numbered lines and numbered buttons, and logged", async () => {
    const m = { repo: "photocraft", number: 7, title: "WebP", url: "https://github.com/storytold/photocraft/issues/7", pr: false, merged: false, closed: false, reason: "" } as unknown as Parameters<typeof renderMatches>[1][number];
    const r = await renderMatches(db, [m, { ...m, number: 8, url: "https://github.com/storytold/photocraft/issues/8" }], "q", undefined);
    const bodies: { content?: string; components: unknown[]; flags?: number }[] = [];
    const logs: string[] = [];
    await deliver(r, async (b) => { bodies.push(b); if (b.flags) throw new RestError(400, "invalid flag"); }, (l) => logs.push(l));
    assert.equal(bodies.length, 2);
    assert.match(bodies[1]!.content!, /^1\. photocraft#7 WebP\n2\. photocraft#8 WebP/);
    assert.deepEqual(v2buttons(bodies[1]!).slice(0, 2).map((b) => b.label), ["1 · photocraft#7", "2 · photocraft#8"]);
    assert.equal(logs.length, 1);
  });
});
