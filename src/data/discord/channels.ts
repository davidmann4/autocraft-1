// Channels, categories and gateway status (`discord_channels`, `discord_categories`, `discord_status`).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import type { CategoryRow, ChannelBrief, ChannelReport, ChannelRow, StatusRow } from "./types.ts";

const lastBy = <T>(rows: readonly T[], key: (r: T) => string): T[] => [...new Map(rows.map((r) => [key(r), r] as const)).values()];

/** Watched channels (a channel is watched when it or its parent is), with the parent of a thread or forum post; absent otherwise. 1 statement per 10,000 ids. */
export async function loadWatchedChannels(db: Db, channelIds: string[]): Promise<Map<string, { guildId: string; parentId: string | null }>> {
  const q = queryDb(db);
  const out = new Map<string, { guildId: string; parentId: string | null }>();
  for (const ids of kx.chunks([...new Set(channelIds)])) {
    const rows = await q.all(q.k.selectFrom("main.discord_channels as c").select(["c.channel_id", "c.guild_id", "c.parent_id"])
      .where(kx.inList(db, "c.channel_id", ids))
      .where((eb) => eb.or([
        eb("c.watched", "=", 1),
        eb.exists(eb.selectFrom("main.discord_channels as p").select(eb.lit(1).as("one")).whereRef("p.channel_id", "=", "c.parent_id").where("p.watched", "=", 1)),
      ])), { label: "discord.loadWatchedChannels" });
    for (const r of rows) out.set(r.channel_id, { guildId: r.guild_id, parentId: r.parent_id });
  }
  return out;
}

/** Each channel's name as the bot last reported it (null when it reported none). A channel the bot has not reported is absent. */
export async function loadChannelNames(db: Db, channelIds: string[]): Promise<Map<string, string | null>> {
  const q = queryDb(db);
  const out = new Map<string, string | null>();
  for (const ids of kx.chunks([...new Set(channelIds)])) {
    const rows = await q.all(q.k.selectFrom("main.discord_channels").select(["channel_id", "name"]).where(kx.inList(db, "channel_id", ids)), { label: "discord.loadChannelNames" });
    for (const r of rows) out.set(r.channel_id, r.name);
  }
  return out;
}

/** Ids of channels under the parents or in the guild. */
export async function loadChannelTree(db: Db, f: { parentIds?: string[]; guildId?: string }): Promise<string[]> {
  const parents = [...new Set(f.parentIds ?? [])];
  if (!parents.length && f.guildId === undefined) return [];
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.discord_channels").select("channel_id").where((eb) => eb.or([
    ...(parents.length ? [kx.inList(db, "parent_id", parents)] : []),
    ...(f.guildId === undefined ? [] : [eb("guild_id", "=", f.guildId)]),
  ])), { label: "discord.loadChannelTree" });
  return rows.map((r) => r.channel_id);
}

/** Top-level channels joined to their categories, viewable or watched, in the order of the admin page. */
export async function listChannelRows(db: Db): Promise<ChannelRow[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.discord_channels as c")
    .leftJoin("main.discord_categories as k", (j) => j.onRef("k.category_id", "=", "c.category_id").onRef("k.guild_id", "=", "c.guild_id"))
    .select(["c.channel_id as channelId", "c.guild_id as guildId", "c.guild_name as guildName", "c.name", "c.watched", "c.default_repo as defaultRepo", "k.name as category"])
    .where("c.parent_id", "is", null)
    // Channels the bot cannot view stay listed only while watched, so they can be switched off.
    .where((eb) => eb.or([eb("c.viewable", "=", 1), eb("c.watched", "=", 1)]))
    .orderBy("c.guild_name", (o) => o.asc().nullsFirst()).orderBy("c.guild_id")
    .orderBy((eb) => eb("k.category_id", "is not", null)).orderBy((eb) => eb("k.position", "is", null))
    .orderBy("k.position", (o) => o.asc().nullsFirst()).orderBy("k.category_id", (o) => o.asc().nullsFirst())
    .orderBy((eb) => eb("c.position", "is", null)).orderBy("c.position", (o) => o.asc().nullsFirst()).orderBy("c.channel_id"), { label: "discord.listChannelRows" });
  return rows.map((r) => ({ ...r, watched: Number(r.watched) === 1 }));
}

/** Channel list for the CLI. */
export async function listChannelBriefs(db: Db): Promise<ChannelBrief[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.discord_channels").select(["channel_id", "guild_name", "name", "watched"])
    .orderBy("guild_name", (o) => o.asc().nullsFirst()).orderBy("name", (o) => o.asc().nullsFirst()), { label: "discord.listChannelBriefs" });
  return rows.map((r) => ({ channelId: r.channel_id, guildName: r.guild_name, name: r.name, watched: Number(r.watched) === 1 }));
}

/** Each channel's default repo: its own, else its parent's. A channel the bot has not reported is absent. */
export async function loadChannelDefaults(db: Db, channelIds: string[]): Promise<Map<string, { defaultRepo: string | null }>> {
  const q = queryDb(db);
  const out = new Map<string, { defaultRepo: string | null }>();
  for (const ids of kx.chunks([...new Set(channelIds)])) {
    const rows = await q.all(q.k.selectFrom("main.discord_channels as c").leftJoin("main.discord_channels as p", "p.channel_id", "c.parent_id")
      .select((eb) => ["c.channel_id as channelId", eb.fn.coalesce("c.default_repo", "p.default_repo").as("defaultRepo")])
      .where(kx.inList(db, "c.channel_id", ids)), { label: "discord.loadChannelDefaults" });
    for (const r of rows) out.set(r.channelId, { defaultRepo: r.defaultRepo });
  }
  return out;
}

/** The guild and name of each channel the bot has reported. */
export async function loadChannelGuilds(db: Db, channelIds: string[]): Promise<Map<string, { guildId: string; name: string | null }>> {
  const q = queryDb(db);
  const out = new Map<string, { guildId: string; name: string | null }>();
  for (const ids of kx.chunks([...new Set(channelIds)])) {
    const rows = await q.all(q.k.selectFrom("main.discord_channels").select(["channel_id", "guild_id", "name"]).where(kx.inList(db, "channel_id", ids)), { label: "discord.loadChannelGuilds" });
    for (const r of rows) out.set(r.channel_id, { guildId: r.guild_id, name: r.name });
  }
  return out;
}

/** The panel message id per channel. */
export async function loadPanelMessages(db: Db, channelIds: string[]): Promise<Map<string, { panelMessage: string | null }>> {
  const q = queryDb(db);
  const out = new Map<string, { panelMessage: string | null }>();
  for (const ids of kx.chunks([...new Set(channelIds)])) {
    const rows = await q.all(q.k.selectFrom("main.discord_channels").select(["channel_id", "panel_message"]).where(kx.inList(db, "channel_id", ids)), { label: "discord.loadPanelMessages" });
    for (const r of rows) out.set(r.channel_id, { panelMessage: r.panel_message });
  }
  return out;
}

/**
 * Upserts channels; `watched`, `default_repo` and `panel_message` are never overwritten, `name` and `guild_name` keep the old value when the
 * new one is null, and `viewable` changes only for rows that carry it (two statement shapes). A channel named twice takes its last report.
 */
export async function saveChannels(db: Db, rows: ChannelReport[]): Promise<void> {
  if (!rows.length) return;
  const q = queryDb(db);
  const values = (r: ChannelReport) => ({
    channel_id: r.channelId, guild_id: r.guildId, guild_name: r.guildName, name: r.name, parent_id: r.parentId ?? null, position: r.position ?? null,
    category_id: r.categoryId ?? null, viewable: r.viewable === false ? 0 : 1,
  });
  const unique = lastBy(rows, (r) => r.channelId);
  await db.write(async () => {
    for (const withViewable of [true, false]) {
      for (const part of kx.batches(unique.filter((r) => (r.viewable !== undefined) === withViewable))) {
        await q.run(q.k.insertInto("main.discord_channels").values(part.map(values)).onConflict((oc) => oc.column("channel_id").doUpdateSet((eb) => ({
          guild_id: eb.ref("excluded.guild_id"),
          guild_name: eb.fn.coalesce("excluded.guild_name", "main.discord_channels.guild_name"),
          name: eb.fn.coalesce("excluded.name", "main.discord_channels.name"),
          parent_id: eb.ref("excluded.parent_id"), position: eb.ref("excluded.position"), category_id: eb.ref("excluded.category_id"),
          ...(withViewable ? { viewable: eb.ref("excluded.viewable") } : {}),
        }))));
      }
    }
  });
}

/** Upserts categories; joins the caller's transaction. */
export async function saveCategories(db: Db, rows: CategoryRow[]): Promise<void> {
  const q = queryDb(db);
  for (const part of kx.batches(lastBy(rows, (r) => r.categoryId))) {
    await q.run(q.k.insertInto("main.discord_categories").values(part.map((r) => ({ category_id: r.categoryId, guild_id: r.guildId, name: r.name, position: r.position })))
      .onConflict((oc) => oc.column("category_id").doUpdateSet(kx.excluded(["guild_id", "name", "position"]))));
  }
}

/** Sets `viewable` on the named channels in one statement per 10,000 rows. */
export async function setViewable(db: Db, rows: { channelId: string; viewable: boolean }[]): Promise<number> {
  if (!rows.length) return 0;
  const set = lastBy(rows, (r) => r.channelId).map((r) => ({ channel_id: r.channelId, viewable: r.viewable ? 1 : 0 }));
  return await db.write(() => kx.updateFrom(db, "discord_channels", ["channel_id"], set, ["viewable"]));
}

/** Watches or unwatches a channel; 0 rows changed means an unknown channel. */
export async function markWatched(db: Db, channelId: string, watched: boolean): Promise<number> {
  const q = queryDb(db);
  return Number((await q.run(q.k.updateTable("main.discord_channels").set({ watched: watched ? 1 : 0 }).where("channel_id", "=", channelId))).changes);
}

/** Sets or clears a channel's default repo. */
export async function setDefaultRepo(db: Db, channelId: string, repo: string | null): Promise<number> {
  const q = queryDb(db);
  return Number((await q.run(q.k.updateTable("main.discord_channels").set({ default_repo: repo }).where("channel_id", "=", channelId))).changes);
}

/** Stores the panel message id. */
export async function setPanelMessage(db: Db, channelId: string, messageId: string): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.updateTable("main.discord_channels").set({ panel_message: messageId }).where("channel_id", "=", channelId));
}

/** Deletes the channels and categories of a channel tree (the channel, its children and its category) or of a guild. */
export async function removeChannelTree(db: Db, f: { channelOrParentId: string } | { guildId: string }): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    if ("guildId" in f) {
      await q.run(q.k.deleteFrom("main.discord_channels").where("guild_id", "=", f.guildId));
      await q.run(q.k.deleteFrom("main.discord_categories").where("guild_id", "=", f.guildId));
    } else {
      await q.run(q.k.deleteFrom("main.discord_channels").where((eb) => eb.or([eb("channel_id", "=", f.channelOrParentId), eb("parent_id", "=", f.channelOrParentId)])));
      await q.run(q.k.deleteFrom("main.discord_categories").where("category_id", "=", f.channelOrParentId));
    }
  });
}

/** Stores the gateway status. */
export async function saveStatus(db: Db, state: string, detail: string | null, at: string): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.discord_status").values({ id: 1, state, detail, at }).onConflict((oc) => oc.column("id").doUpdateSet(kx.excluded(["state", "detail", "at"]))));
}

/** The gateway status. */
export async function loadStatus(db: Db): Promise<StatusRow | null> {
  const q = queryDb(db);
  return (await q.get(q.k.selectFrom("main.discord_status").select(["state", "detail", "at"]).where("id", "=", 1), { label: "discord.loadStatus" })) ?? null;
}
