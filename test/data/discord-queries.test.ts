// Discord module: statement counts of the loaders and batched writers, and the writers whose logic changed shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { queryDb } from "../../src/db/query-db.ts";
import type { Db } from "../../src/db/index.ts";
import {
  addSentAlerts, countEvents, addEvents, listChannelRows, loadAlertState, loadChannelDefaults, loadDiscordSetup, loadMentionCounts, loadMentionsOfItems,
  loadMessageMentions, loadWatchedChannels, offeredRepos, releaseFiling, reserveFiling, saveChannels, saveMessageMentions, setFiledNumber, setSignals,
  setViewable, filingRefusal, loadFilingCounts, listRecentFiled,
} from "../../src/data/discord/index.ts";
import { expectFlat } from "../helpers/query-count.ts";
import { TEST_PG_URL } from "../test-db.ts";
import { both, openApp } from "./planner-helpers.ts";

const AT = "2026-01-01T00:00:00.000Z";
const SINCE = "2025-12-31T00:00:00.000Z";
const ids = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`);

for (const dialect of ["sqlite" as const, ...(TEST_PG_URL ? ["postgres" as const] : [])]) {
  const flat = (name: string, prepare: (db: Db, n: number) => Promise<() => Promise<unknown>>): void => {
    test(`${name}: statements do not grow with the key count (${dialect})`, async () => {
      await expectFlat(async (n) => {
        const o = await openApp(dialect);
        return { db: o.db, close: () => o.t.close(), run: await prepare(o.db, n) };
      }, 2, 40);
    });
  };

  flat("mention loaders and counts", async (db, n) => {
    const q = queryDb(db);
    const hashes = ids(n, "m");
    await q.run(q.k.insertInto("main.discord_mentions").values(hashes.map((h, i) => ({ msg_hash: h, channel_hash: "c", repo: "r", number: i + 1, sealed: "s" }))));
    const refs = hashes.map((_, i) => `r#${i + 1}`);
    return async () => { await loadMessageMentions(db, hashes); await loadMentionsOfItems(db, refs); await loadMentionCounts(db, refs); };
  });

  flat("channel loaders, writers and the admin page read model", async (db, n) => {
    const reports = ids(n, "ch").map((id) => ({ channelId: id, guildId: "g", guildName: "G", name: id, viewable: true }));
    return async () => {
      await saveChannels(db, reports);
      await setViewable(db, reports.map((r) => ({ channelId: r.channelId, viewable: false })));
      await loadWatchedChannels(db, reports.map((r) => r.channelId));
      await loadChannelDefaults(db, reports.map((r) => r.channelId));
      await loadDiscordSetup(db, { nowMs: Date.parse(AT) });
    };
  });

  flat("mention writes", async (db, n) => {
    const changes = ids(n, "w").map((h, i) => ({ msgHash: h, channelHash: "c", remove: [`r#${i + 100}`], add: [{ repo: "r", number: i + 1, sealed: "s" }] }));
    return async () => { await saveMessageMentions(db, changes); await setSignals(db, changes.map((c, i) => ({ msgHash: c.msgHash, repo: "r", number: i + 1, signal: true }))); };
  });

  flat("alert state and sent alerts", async (db, n) => {
    const q = queryDb(db);
    const users = ids(n, "u");
    await q.run(q.k.insertInto("main.discord_links").values(users.map((u) => ({ user_hash: u, login: `login-${u}`, linked_at: AT }))));
    await q.run(q.k.insertInto("main.discord_alerts").values(users.map((u) => ({ user_hash: u, sealed: "s", created_at: AT }))));
    return async () => {
      await loadAlertState(db, { sinceIso: SINCE });
      await addSentAlerts(db, users.map((u, i) => ({ userHash: u, workflowId: i + 1, recAt: AT, sentAt: AT })));
    };
  });
}

both("saveChannels keeps watched, default repo and panel message, and changes viewable only for rows that carry it", async ({ db }) => {
  const q = queryDb(db);
  await saveChannels(db, [{ channelId: "a", guildId: "g", guildName: "G", name: "one" }, { channelId: "b", guildId: "g", guildName: "G", name: "two" }]);
  await q.run(q.k.updateTable("main.discord_channels").set({ watched: 1, default_repo: "repo", panel_message: "p" }));
  await saveChannels(db, [{ channelId: "a", guildId: "g", guildName: null, name: null, viewable: false }, { channelId: "b", guildId: "g", guildName: "G", name: "renamed" }]);
  const rows = await q.all(q.k.selectFrom("main.discord_channels").select(["channel_id", "name", "guild_name", "watched", "default_repo", "panel_message", "viewable"]).orderBy("channel_id"));
  assert.deepEqual(rows.map((r) => [r.channel_id, r.name, r.guild_name, Number(r.watched), r.default_repo, r.panel_message, Number(r.viewable)]), [
    ["a", "one", "G", 1, "repo", "p", 0],
    ["b", "renamed", "G", 1, "repo", "p", 1],
  ]);
  assert.equal((await listChannelRows(db)).map((c) => c.channelId).join(), "a,b");
  await q.run(q.k.updateTable("main.discord_channels").set({ watched: 0 }).where("channel_id", "=", "a"));
  assert.equal((await listChannelRows(db)).map((c) => c.channelId).join(), "b", "a channel the bot cannot view stays listed only while watched");
});

both("saveMessageMentions removes the named rows, adds the new ones and counts only rows newly added", async ({ db }) => {
  const add = (repo: string, number: number) => ({ repo, number, sealed: "s" });
  assert.equal(await saveMessageMentions(db, [{ msgHash: "m1", channelHash: "c", remove: [], add: [add("r", 1), add("r", 2)] }]), 2);
  assert.equal(await saveMessageMentions(db, [{ msgHash: "m1", channelHash: "c", remove: ["r#1"], add: [add("r", 2), add("r", 3)] }]), 1);
  const rows = (await loadMessageMentions(db, ["m1"])).get("m1")!;
  assert.deepEqual(rows.map((r) => r.number).sort(), [2, 3]);
  await setSignals(db, [{ msgHash: "m1", repo: "r", number: 3, signal: true }, { msgHash: "gone", repo: "r", number: 9, signal: true }]);
  assert.deepEqual([...(await loadMentionCounts(db, ["r#2", "r#3", "r#4"]))].sort(), [["r#2", { count: 1, signals: 0 }], ["r#3", { count: 1, signals: 1 }]]);
});

both("reserveFiling refuses once the person's or the repo's daily limit is reached, and a released slot frees it", async ({ db }) => {
  const req = { repo: "o/r", login: "Alice", reporter: "rep1", atIso: AT, sinceIso: SINCE, by: "login" as const, perLogin: 2, perRepo: 3 };
  const first = await reserveFiling(db, req);
  assert.ok("slot" in first);
  assert.ok("slot" in await reserveFiling(db, { ...req, login: "ALICE" }), "the login is matched without case");
  assert.deepEqual(await reserveFiling(db, req), { refused: "login" });
  assert.ok("slot" in await reserveFiling(db, { ...req, login: "bob" }));
  assert.deepEqual(await reserveFiling(db, { ...req, login: "carol" }), { refused: "repo" });
  await releaseFiling(db, (first as { slot: number }).slot);
  assert.ok("slot" in await reserveFiling(db, req));
  const counts = await loadFilingCounts(db, { sinceIso: SINCE, login: "alice", reporter: "rep1", repo: "o/r" });
  assert.deepEqual(counts, { byLogin: 2, byReporter: 3, byRepo: 3 });
  assert.deepEqual(await listRecentFiled(db, 5), [], "reserved slots (number 0) are not filed issues");
  const slot = await reserveFiling(db, { ...req, repo: "o/other", login: "dave", by: "reporter", reporter: "rep9" });
  assert.ok("slot" in slot);
  await setFiledNumber(db, slot.slot, 42);
  assert.deepEqual((await listRecentFiled(db, 5)).map((r) => r.number), [42]);
});

both("reserveFiling prunes rows older than the window before it counts", async ({ db }) => {
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.discord_filed").values({ repo: "o/r", number: 1, login: "a", reporter: "x", at: "2025-01-01T00:00:00.000Z" }));
  const out = await reserveFiling(db, { repo: "o/r", login: "a", reporter: "x", atIso: AT, sinceIso: SINCE, by: "reporter", perLogin: 1, perRepo: 1 });
  assert.ok("slot" in out);
});

both("event counts split the day from the week and cover every kind", async ({ db }) => {
  const now = Date.parse(AT);
  const iso = (agoH: number) => new Date(now - agoH * 3_600_000).toISOString();
  await addEvents(db, [{ kind: "filed", atIso: iso(1) }, { kind: "filed", atIso: iso(50) }, { kind: "junk", atIso: iso(24 * 9) }]);
  const c = await countEvents(db, now);
  assert.deepEqual(c.filed, { day: 1, week: 2 });
  assert.deepEqual(c.junk, { day: 0, week: 0 });
  assert.deepEqual(c.started, { day: 0, week: 0 });
});

both("alert state reads rows an older process wrote and keeps them in the hourly count", async ({ db }) => {
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.discord_links").values({ user_hash: "u", login: "ann", linked_at: AT }));
  await q.run(q.k.insertInto("main.discord_alerts").values({ user_hash: "u", sealed: "s", created_at: AT }));
  await q.run(q.k.insertInto("main.discord_alert_msgs").values([
    { decision_id: "wf:7:2026-01-01T00:00:00.000Z", user_hash: "u", sent_at: AT },
    { decision_id: "summary:1", user_hash: "u", sent_at: AT },
  ]));
  await addSentAlerts(db, [{ userHash: "u", workflowId: 8, recAt: AT, sentAt: AT }, { userHash: "u", workflowId: 8, recAt: AT, sentAt: AT }]);
  const { alerters, sent } = await loadAlertState(db, { sinceIso: SINCE });
  assert.deepEqual(alerters.map((a) => a.login), ["ann"]);
  assert.deepEqual(sent.map((s) => s.workflowId).sort(), [0, 7, 8]);
});

test("offeredRepos lets a tracked repo win over a filing-only name, drops hidden ones and sorts; filingRefusal keeps its order", () => {
  const filing = [{ owner: "x", name: "Beta", addedBy: "a", addedAt: AT }, { owner: "x", name: "zeta", addedBy: "a", addedAt: AT }];
  const list = offeredRepos({ tracked: [{ name: "beta", owner: "o" }, { name: "alpha", owner: "o" }, { name: "secret", owner: "o" }], publicNames: ["beta", "alpha", "secret"], hidden: new Set(["secret"]), filing });
  assert.deepEqual(list.map((r) => [r.name, r.filingOnly]), [["alpha", false], ["beta", false], ["zeta", true]]);
  const facts = { offered: true, identityIsApp: true, byReporter: 5, perReporter: 5, byRepo: 9, perRepo: 5, reservedByRequest: 0, dailyWrites: 99, dailyLimit: 10 };
  assert.match(filingRefusal({ ...facts, offered: false })!, /not open/);
  assert.match(filingRefusal({ ...facts, identityIsApp: false })!, /not set up/);
  assert.match(filingRefusal(facts)!, /You have filed/);
  assert.match(filingRefusal({ ...facts, byReporter: 0 })!, /This repo/);
  assert.match(filingRefusal({ ...facts, byReporter: 0, byRepo: 0 })!, /daily limit/);
  assert.equal(filingRefusal({ ...facts, byReporter: 0, byRepo: 0, dailyWrites: 0 }), null);
  assert.equal(filingRefusal({ ...facts, byReporter: 5, perReporter: 5, reservedByRequest: 1, byRepo: 0, dailyWrites: 0 }), null, "a reserved row of this request is not counted against it");
});
