// Mention rows: which tracked items a Discord message refers to. A row holds the item (plain, for counting) and the
// message's guild, channel, id and time sealed with the key file. No text and no author id is kept; an author is
// kept only as a keyed hash that serves a deletion request.
import type { DiscordKeys } from "./keys.ts";
import { DEFAULT_OWNER } from "../owners.ts";
import { parseRefs, type TrackedRepo } from "./refs.ts";
import type { Db } from "../db/index.ts";
import { excluded } from "../db/kx.ts";

export type DiscordMessage = {
  id: string; channel_id: string; guild_id?: string; content?: string; timestamp?: string;
  author?: { id: string; bot?: boolean };
};

export const trackedRepos = async (db: Db): Promise<TrackedRepo[]> =>
  await db.all(db.k.selectFrom("main.tracked_repos as t").leftJoin("main.repos as r", "r.name", "t.name")
    .select((eb) => ["t.name as name", eb.fn.coalesce("r.owner", eb.val(DEFAULT_OWNER)).as("owner")]));

/** A channel is watched when the operators chose it, or it is a thread or forum post of a watched channel. */
export const isWatched = async (db: Db, channelId: string): Promise<boolean> =>
  !!await db.get(db.k.selectFrom("discord_channels as c").select((eb) => eb.lit(1).as("one"))
    .where("c.channel_id", "=", channelId)
    .where((eb) => eb.or([
      eb("c.watched", "=", 1),
      eb.exists(eb.selectFrom("discord_channels as p").select(eb.lit(1).as("one")).whereRef("p.channel_id", "=", "c.parent_id").where("p.watched", "=", 1)),
    ])));

/** Sets a message's rows to exactly the items its text names. Returns the number of rows newly recorded (0 for a repeat), or -1 when the event carries no text. */
export async function recordMessage(db: Db, keys: DiscordKeys, m: DiscordMessage, guildId: string | undefined): Promise<number> {
  if (m.content === undefined || !guildId) return -1;
  const msgHash = keys.hash("message", m.id);
  const refs = m.author?.bot ? [] : parseRefs(m.content, await trackedRepos(db));
  const have = await db.all(db.k.selectFrom("discord_mentions").select(["repo", "number", "sealed"]).where("msg_hash", "=", msgHash));
  const want = new Set(refs.map((r) => `${r.repo}#${r.number}`));
  // An edit event may carry no author: keep the one sealed with the existing rows.
  const author = m.author?.id ? keys.hash("author", m.author.id) : have.map((h) => keys.open(h.sealed, msgHash)?.author).find((a) => a);
  const sealed = keys.seal({ guildId, channelId: m.channel_id, messageId: m.id, at: m.timestamp ?? new Date().toISOString(), ...(author && { author }) }, msgHash);
  let added = 0;
  await db.write(async () => {
    for (const h of have) if (!want.has(`${h.repo}#${h.number}`)) await db.run(db.k.deleteFrom("discord_mentions").where("msg_hash", "=", msgHash).where("repo", "=", h.repo).where("number", "=", h.number));
    for (const r of refs) added += Number((await db.run(db.k.insertInto("discord_mentions")
      .values({ msg_hash: msgHash, channel_hash: keys.hash("channel", m.channel_id), repo: r.repo, number: r.number, sealed })
      .onConflict((oc) => oc.doNothing()))).changes);
  });
  return added;
}

/** Mention rows only: our replies live in Discord and are deleted with it (src/discord/replies.ts). */
export async function forgetMessages(db: Db, keys: DiscordKeys, ids: string[]): Promise<number> {
  let n = 0;
  for (const id of ids) n += Number((await db.run(db.k.deleteFrom("discord_mentions").where("msg_hash", "=", keys.hash("message", id)))).changes);
  return n;
}

/** For a channel that is gone (deleted, or its server removed the bot): its replies went with it, so only the rows are removed. */
export async function forgetChannel(db: Db, keys: DiscordKeys, channelId: string): Promise<number> {
  const h = keys.hash("channel", channelId);
  await db.run(db.k.deleteFrom("discord_replies").where("channel_hash", "=", h));
  return Number((await db.run(db.k.deleteFrom("discord_mentions").where("channel_hash", "=", h))).changes);
}

/** Opens every row to find the author's: slow, and rare enough (a deletion request) not to need a column that would name a person. */
export async function forgetAuthor(db: Db, keys: DiscordKeys, userId: string): Promise<number> {
  const want = keys.hash("author", userId);
  let n = 0;
  for (const r of await db.all(db.k.selectFrom("discord_mentions").select(["msg_hash", "repo", "number", "sealed"])))
    if (keys.open(r.sealed, r.msg_hash)?.author === want) n += Number((await db.run(db.k.deleteFrom("discord_mentions").where("msg_hash", "=", r.msg_hash).where("repo", "=", r.repo).where("number", "=", r.number))).changes);
  return n;
}

/** Gateway events that change mention rows. Reads and edits happen in watched channels only; a delete always applies. Returns the message when this event newly recorded it against items, else null. */
export async function handleDispatch(db: Db, keys: DiscordKeys, type: string, d: unknown): Promise<{ channelId: string; messageId: string; guildId?: string } | null> {
  const x = d as Record<string, unknown> & Partial<DiscordMessage> & { ids?: unknown; unavailable?: boolean };
  if (type === "MESSAGE_CREATE" || type === "MESSAGE_UPDATE") {
    if (typeof x.id !== "string" || typeof x.channel_id !== "string" || !await isWatched(db, x.channel_id)) return null;
    const guildId = typeof x.guild_id === "string" ? x.guild_id : await channelGuild(db, x.channel_id);
    const added = await recordMessage(db, keys, x as DiscordMessage, guildId);
    return added > 0 ? { channelId: x.channel_id, messageId: x.id, guildId } : null;
  } else if (type === "MESSAGE_DELETE") {
    if (typeof x.id === "string") await forgetMessages(db, keys, [x.id]);
  } else if (type === "MESSAGE_DELETE_BULK") {
    if (Array.isArray(x.ids)) await forgetMessages(db, keys, x.ids.filter((i): i is string => typeof i === "string"));
  } else if ((type === "CHANNEL_DELETE" || type === "THREAD_DELETE") && typeof x.id === "string") {
    await forgetChannel(db, keys, x.id);
    for (const c of await db.all(db.k.selectFrom("discord_channels").select("channel_id").where("parent_id", "=", x.id))) await forgetChannel(db, keys, c.channel_id);
  } else if (type === "GUILD_DELETE" && typeof x.id === "string" && !x.unavailable) {
    for (const c of await db.all(db.k.selectFrom("discord_channels").select("channel_id").where("guild_id", "=", x.id))) await forgetChannel(db, keys, c.channel_id);
  }
  return null;
}

const channelGuild = async (db: Db, channelId: string): Promise<string | undefined> =>
  (await db.get(db.k.selectFrom("discord_channels").select("guild_id").where("channel_id", "=", channelId)))?.guild_id;

export type DiscordLink = { url: string; at: string };

/** Message links of an item, newest first. Empty when the key is missing or a row does not open. */
export async function linksOf(db: Db, keys: DiscordKeys | null, repo: string, number: number): Promise<DiscordLink[]> {
  if (!keys) return [];
  const rows = await db.all(db.k.selectFrom("discord_mentions").select(["msg_hash", "sealed"]).where("repo", "=", repo).where("number", "=", number));
  return rows.flatMap((r) => {
    const v = keys.open(r.sealed, r.msg_hash);
    return v ? [{ url: `https://discord.com/channels/${v.guildId}/${v.channelId}/${v.messageId}`, at: v.at }] : [];
  }).sort((a, b) => b.at.localeCompare(a.at));
}

export const countOf = async (db: Db, repo: string, number: number): Promise<number> =>
  (await db.get(db.k.selectFrom("discord_mentions").select((eb) => eb.fn.countAll<number>().as("n")).where("repo", "=", repo).where("number", "=", number)))!.n;

/** What the bot reports about a guild and its channels, for the admin page. The watched flag is kept across updates. */
export async function upsertChannel(db: Db, c: { channelId: string; guildId: string; guildName: string | null; name: string | null; parentId?: string | null; position?: number | null; categoryId?: string | null; viewable?: boolean }): Promise<void> {
  await db.run(db.k.insertInto("discord_channels")
    .values({ channel_id: c.channelId, guild_id: c.guildId, guild_name: c.guildName, name: c.name, parent_id: c.parentId ?? null, position: c.position ?? null, category_id: c.categoryId ?? null, viewable: c.viewable === false ? 0 : 1 })
    .onConflict((oc) => oc.column("channel_id").doUpdateSet((eb) => ({
      guild_id: eb.ref("excluded.guild_id"), guild_name: eb.fn.coalesce("excluded.guild_name", "discord_channels.guild_name"),
      name: eb.fn.coalesce("excluded.name", "discord_channels.name"), parent_id: eb.ref("excluded.parent_id"),
      position: eb.ref("excluded.position"), category_id: eb.ref("excluded.category_id"),
      ...(c.viewable === undefined ? {} : { viewable: eb.ref("excluded.viewable") }),
    }))));
}

export async function upsertCategory(db: Db, c: { categoryId: string; guildId: string; name: string | null; position: number | null }): Promise<void> {
  await db.run(db.k.insertInto("discord_categories").values({ category_id: c.categoryId, guild_id: c.guildId, name: c.name, position: c.position })
    .onConflict((oc) => oc.column("category_id").doUpdateSet(excluded(["guild_id", "name", "position"]))));
}

export async function setStatus(db: Db, state: string, detail: string | null): Promise<void> {
  await db.run(db.k.insertInto("discord_status").values({ id: 1, state, detail, at: new Date().toISOString() })
    .onConflict((oc) => oc.column("id").doUpdateSet(excluded(["state", "detail", "at"]))));
}
