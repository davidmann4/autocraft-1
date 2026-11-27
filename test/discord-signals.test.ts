// Discord attention signals: Jev's bands, Haiku between them, a deleted message losing its flag, and the Items filter.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { setJevEnabled } from "../src/agents/jev.ts";
import { DiscordKeys } from "../src/discord/keys.ts";
import { SIGNAL_CAP_KEY, Signals, signalCountOf, signalLinks, type Judge } from "../src/discord/signals.ts";
import { handleDispatch } from "../src/discord/store.ts";
import type { Req } from "../src/dash/types.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { excluded } from "../src/db/kx.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "discord-signals-"));
const db = await connectDb(join(dir, "d.db"));
const keys = new DiscordKeys("k".repeat(40));
after(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

let jevP: number | null = 0.5, haikuSays: boolean | null = true;
const calls = { jev: 0, haiku: 0 };
const judge: Judge = {
  jev: async () => (calls.jev++, jevP),
  haiku: async () => (calls.haiku++, haikuSays),
};
const signals = new Signals({ db, keys, log: () => {}, judge });
const msg = (id: string, content: string) => ({ id, channel_id: "c1", guild_id: "g1", content, timestamp: "2026-11-01T10:00:00.000Z", author: { id: "u1" } });
// The dispatcher's order: mention rows first, then the signal check.
async function send(type: string, m: object): Promise<void> {
  await handleDispatch(db, keys, type, m);
  await signals.dispatch(type, m);
  await signals.idle();
}
const asked = async (n: number) => await signalCountOf(db, "photocraft", n);
const signalled = () => db.k.selectFrom("discord_mentions").select((eb) => eb.fn.countAll<number>().as("n")).where("signal", "=", 1);

describe("attention signals", () => {
  before(async () => {
    await db.run(db.k.insertInto("tracked_repos").values({ name: "photocraft" }).onConflict((oc) => oc.doNothing()));
    await db.run(db.k.insertInto("repos").values({ name: "photocraft", owner: "storytold" }).onConflict((oc) => oc.doNothing()));
    await db.run(db.k.insertInto("discord_channels").values({ channel_id: "c1", guild_id: "g1", guild_name: "Guild", name: "dev", watched: 1 }));
    for (const n of [1, 2, 3, 4]) await db.run(db.k.insertInto("items").values({ repo: "photocraft", number: n, kind: "issue", state: "OPEN", title: `Item ${n}`, updated_at: "2026-01-01" }));
  });

  test("Jev decides from 0.8 up and below 0.3; Haiku decides in between and when Jev is off", async () => {
    jevP = 0.85; await send("MESSAGE_CREATE", msg("m1", "can someone review photocraft#1?"));
    assert.equal(await asked(1), 1);
    assert.equal(calls.haiku, 0);
    jevP = 0.1; haikuSays = true; await send("MESSAGE_CREATE", msg("m2", "photocraft#2 is the fix for the crash"));
    assert.equal(await asked(2), 0);
    assert.equal(calls.haiku, 0);
    jevP = 0.5; haikuSays = true; await send("MESSAGE_CREATE", msg("m3", "any news on photocraft#3"));
    assert.equal(await asked(3), 1);
    assert.equal(calls.haiku, 1);
    jevP = 0.5; haikuSays = false; await send("MESSAGE_CREATE", msg("m4", "photocraft#4 exists"));
    assert.equal(await asked(4), 0);
    await setJevEnabled(db, false, "test");
    const jevCalls = calls.jev;
    haikuSays = true; await send("MESSAGE_CREATE", msg("m5", "please look at photocraft#4"));
    assert.equal(calls.jev, jevCalls);
    assert.equal(await asked(4), 1);
    await setJevEnabled(db, true, "test");
  });

  test("an edit asks again, a link preview does not, and a delete removes the flag; no text is kept", async () => {
    const before = calls.jev;
    jevP = 0.1;
    await send("MESSAGE_UPDATE", { ...msg("m1", "can someone review photocraft#1?") });
    assert.equal(calls.jev, before, "an update without an edit time is not asked");
    assert.equal(await asked(1), 1);
    await send("MESSAGE_UPDATE", { ...msg("m1", "photocraft#1 solved, thanks"), edited_timestamp: "2026-11-01T11:00:00.000Z" });
    assert.equal(await asked(1), 0, "the edit cleared the flag");
    jevP = 0.9;
    await send("MESSAGE_UPDATE", { ...msg("m1", "photocraft#1 still needs a review"), edited_timestamp: "2026-11-01T12:00:00.000Z" });
    assert.equal(await asked(1), 1);
    assert.deepEqual((await signalLinks(db, keys, "photocraft", 1)).map((l) => l.url), ["https://discord.com/channels/g1/c1/m1"]);
    await send("MESSAGE_DELETE", { id: "m1", channel_id: "c1" });
    assert.equal(await asked(1), 0);
    assert.equal((await signalLinks(db, keys, "photocraft", 1)).length, 0);
    assert.equal((await db.get(db.k.selectFrom("agent_run_texts").select((eb) => eb.fn.countAll<number>().as("n"))))!.n, 0);
  });

  test("limits per author and channel, two calls at a time, and a message naming many items is skipped", async () => {
    let now = 1_000_000, live = 0, peak = 0;
    const slow: Judge = { jev: async () => { peak = Math.max(peak, ++live); await new Promise((r) => setTimeout(r, 10)); live--; return 0.9; }, haiku: async () => true };
    const s = new Signals({ db, keys, log: () => {}, judge: slow, now: () => now });
    const from = (id: string, user: string, content: string) => ({ ...msg(id, content), author: { id: user } });
    await db.run(db.k.updateTable("discord_mentions").set({ signal: 0 }));
    const run = async (m: ReturnType<typeof from>) => { await handleDispatch(db, keys, "MESSAGE_CREATE", m); await s.dispatch("MESSAGE_CREATE", m); };
    for (let i = 0; i < 12; i++) await run(from(`a${i}`, "u9", "review photocraft#1 please"));
    await s.idle();
    const rows = (await db.get(signalled()))!;
    assert.equal(rows.n, 10, "10 per author per minute; the other two stay plain mentions");
    assert.ok(peak <= 2, `peak concurrent calls ${peak}`);
    // Messages that name nothing, or too many items, use up no limit.
    now += 61_000;
    for (let i = 0; i < 40; i++) await run(from(`n${i}`, "u7", "just chatting"));
    for (let i = 0; i < 40; i++) await run(from(`x${i}`, "u7", "photocraft#1 photocraft#2 photocraft#3 photocraft#4 photocraft#5 photocraft#6"));
    await run(from("b0", "u9", "review photocraft#1"));
    await s.idle();
    assert.equal((await db.get(signalled()))!.n, 11, "the window slides");
    await run(from("c0", "u8", "photocraft#1 photocraft#2 photocraft#3 photocraft#4 photocraft#5 photocraft#6 review"));
    await s.idle();
    assert.equal((await db.get(signalled()))!.n, 11, "six items: not checked");
  });

  test("a daily cap of 0 makes no Jev or Haiku call", async () => {
    await db.run(db.k.insertInto("settings").values({ key: SIGNAL_CAP_KEY, value: "0" }).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
    try {
      const jev = calls.jev, haiku = calls.haiku;
      jevP = 0.9; await send("MESSAGE_CREATE", msg("cap1", "please review photocraft#3"));
      assert.equal(calls.jev, jev);
      assert.equal(calls.haiku, haiku);
    } finally {
      await db.run(db.k.deleteFrom("settings").where("key", "=", SIGNAL_CAP_KEY));
    }
  });
});
