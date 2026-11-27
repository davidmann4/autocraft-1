// Mention rows: which tracked items a Discord message refers to. A row holds the item (plain, for counting) and the
// message's guild, channel, id and time sealed with the key file. No text and no author id is kept; an author is
// kept only as a keyed hash that serves a deletion request.
import type { DiscordKeys, MessageRef } from "./keys.ts";
import { DEFAULT_OWNER } from "../owners.ts";
import { messageText, parseRefs, type ItemKey, type TextMessage, type TrackedRepo } from "./refs.ts";
import type { Db } from "../db/index.ts";
import { loadTrackedRepos } from "../data/control/index.ts";
import * as dc from "../data/discord/index.ts";
import { loadRepos } from "../data/mirror/index.ts";
import { MENTION_AUTHOR_ROWS, MENTION_CHANNEL_ROWS, MENTION_MAX_ITEMS, MENTION_WINDOW_MS } from "./limits.ts";
import { WindowLimits } from "./window-limit.ts";

const mentionLimits = new WindowLimits();
/** When each author or channel hash was last logged as over its limit, so a flood logs once per window. */
const loggedOver = new Map<string, number>();

export type DiscordMessage = {
  id: string; channel_id: string; guild_id?: string; content?: string; message_snapshots?: { message?: { content?: string } }[]; timestamp?: string;
  author?: { id: string; bot?: boolean };
};

export const trackedRepos = async (db: Db): Promise<TrackedRepo[]> => {
  const [tracked, repos] = await db.together(() => Promise.all([loadTrackedRepos(db), loadRepos(db, { all: true })]));
  return [...tracked.keys()].map((name) => ({ name, owner: repos.get(name)?.owner ?? DEFAULT_OWNER }));
};

/** A channel is watched when the operators chose it, or it is a thread or forum post of a watched channel. */
export const isWatched = async (db: Db, channelId: string): Promise<boolean> =>
  (await dc.loadWatchedChannels(db, [channelId])).has(channelId);

/** Sets a message's rows to exactly the items its text names. Returns the number of rows newly recorded (0 for a repeat), or -1 when the event carries no text. */
export async function recordMessage(db: Db, keys: DiscordKeys, m: DiscordMessage, guildId: string | undefined): Promise<number> {
  if ((m.content === undefined && !m.message_snapshots?.length) || !guildId) return -1;
  const msgHash = keys.hash("message", m.id);
  let refs = m.author?.bot ? [] : parseRefs(messageText(m), await trackedRepos(db));
  if (refs.length > MENTION_MAX_ITEMS) refs = [];
  const have = (await dc.loadMessageMentions(db, [msgHash])).get(msgHash) ?? [];
  // An edit event may carry no author: keep the one sealed with the existing rows.
  const author = m.author?.id ? keys.hash("author", m.author.id) : have.map((h) => keys.open(h.sealed, msgHash)?.author).find((a) => a);
  // With no author the opt-out cannot be checked, so such an event records nothing new.
  if (!author) refs = refs.filter((r) => have.some((h) => h.repo === r.repo && h.number === r.number));
  const sealed = keys.seal({ guildId, channelId: m.channel_id, messageId: m.id, at: m.timestamp ?? new Date().toISOString(), ...(author && { author }) }, msgHash);
  const fresh = refs.filter((r) => !have.some((h) => h.repo === r.repo && h.number === r.number)).length;
  if (fresh && !mentionLimits.allow(Date.now(), [
    ...(author ? [{ key: `a:${author}`, n: MENTION_AUTHOR_ROWS, ms: MENTION_WINDOW_MS }] : []),
    { key: `c:${keys.hash("channel", m.channel_id)}`, n: MENTION_CHANNEL_ROWS, ms: MENTION_WINDOW_MS },
  ], fresh, (r) => {
    const now = Date.now();
    if (now - (loggedOver.get(r.key) ?? -Infinity) < MENTION_WINDOW_MS) return;
    for (const [k, t] of loggedOver) if (now - t >= MENTION_WINDOW_MS) loggedOver.delete(k);
    loggedOver.set(r.key, now);
    console.log(`discord: mentions over the ${r.key.startsWith("a:") ? "author" : "channel"} limit, not recorded (${r.key.startsWith("a:") ? "author" : "channel"} ${r.key.slice(2, 10)}…)`);
  })) refs = refs.filter((r) => have.some((h) => h.repo === r.repo && h.number === r.number));
  const want = new Set(refs.map((r) => `${r.repo}#${r.number}`));
  return await dc.saveMessageMentions(db, [{
    msgHash, channelHash: keys.hash("channel", m.channel_id),
    remove: have.filter((h) => !want.has(`${h.repo}#${h.number}`)).map((h) => `${h.repo}#${h.number}`),
    add: refs.map((r) => ({ repo: r.repo, number: r.number, sealed })),
  }]);
}

/**
 * The items a message names, each once: its mention rows, then the items its text names (`text`: the message as an event carries it,
 * which also covers a message recorded before its channel was watched, by an opted-out author, or over a limit).
 */
export async function messageItems(db: Db, keys: DiscordKeys, messageId: string, text: TextMessage | null | undefined): Promise<ItemKey[]> {
  const h = keys.hash("message", messageId);
  const rows = ((await dc.loadMessageMentions(db, [h])).get(h) ?? []).map((r) => ({ repo: r.repo, number: r.number }));
  const named = text ? parseRefs(messageText(text), await trackedRepos(db)) : [];
  const out = new Map<string, ItemKey>();
  for (const r of [...rows, ...named]) if (!out.has(`${r.repo}#${r.number}`)) out.set(`${r.repo}#${r.number}`, r);
  return [...out.values()];
}

/** Mention rows, and what a deleted command reply of the bot followed. Returns the mention rows removed; our ping replies live in Discord and are deleted with it (src/discord/replies.ts). */
export async function forgetMessages(db: Db, keys: DiscordKeys, ids: string[]): Promise<number> {
  const hashes = ids.map((id) => keys.hash("message", id));
  await dc.removeFollows(db, hashes);
  return await dc.removeMentionsOfMessages(db, hashes);
}

/** For channels that are gone (deleted, or their server removed the bot): their replies went with them, so only the rows are removed. */
export async function forgetChannels(db: Db, keys: DiscordKeys, channelIds: string[]): Promise<number> {
  if (!channelIds.length) return 0;
  return (await dc.forgetChannels(db, channelIds.map((id) => keys.hash("channel", id)))).mentions;
}

/** Opens every row to find the author's: slow, and rare enough (a deletion request) not to need a column that would name a person. */
export async function forgetAuthor(db: Db, keys: DiscordKeys, userId: string): Promise<number> {
  const want = keys.hash("author", userId);
  const mine = (await dc.loadSealedMentions(db)).filter((r) => keys.open(r.sealed, r.msgHash)?.author === want);
  return await dc.removeMentionRows(db, mine);
}

/** `/autocraft account action:optout`: the user's messages stop being recorded and their mention rows go. Returns whether the user was opted in, and the rows removed. */
export async function optOut(db: Db, keys: DiscordKeys, userId: string): Promise<{ changed: boolean; rows: number }> {
  const changed = await dc.setOptedOut(db, keys.hash("author", userId), true, new Date().toISOString());
  return { changed, rows: await forgetAuthor(db, keys, userId) };
}

/** `/autocraft account action:optin`: the user's new messages are recorded again. Returns whether the user was opted out. */
export const optIn = async (db: Db, keys: DiscordKeys, userId: string): Promise<boolean> =>
  await dc.setOptedOut(db, keys.hash("author", userId), false, new Date().toISOString());

/** Gateway events that change mention rows. Reads and edits happen in watched channels only; a delete always applies. Returns the message when this event newly recorded it against items, else null. */
export async function handleDispatch(db: Db, keys: DiscordKeys, type: string, d: unknown): Promise<{ channelId: string; messageId: string; guildId?: string } | null> {
  const x = d as Record<string, unknown> & Partial<DiscordMessage> & { ids?: unknown; unavailable?: boolean };
  if (type === "MESSAGE_CREATE" || type === "MESSAGE_UPDATE") {
    if (typeof x.id !== "string" || typeof x.channel_id !== "string" || !await isWatched(db, x.channel_id)) return null;
    // An opted-out author's message is not recorded, so it is not flagged or reacted to either; what it asks the bot still runs (pings.ts).
    if (x.author?.id && await dc.isOptedOut(db, keys.hash("author", x.author.id))) return null;
    const guildId = typeof x.guild_id === "string" ? x.guild_id : await channelGuild(db, x.channel_id);
    const added = await recordMessage(db, keys, x as DiscordMessage, guildId);
    return added > 0 ? { channelId: x.channel_id, messageId: x.id, guildId } : null;
  } else if (type === "MESSAGE_DELETE") {
    if (typeof x.id === "string") await forgetMessages(db, keys, [x.id]);
  } else if (type === "MESSAGE_DELETE_BULK") {
    if (Array.isArray(x.ids)) await forgetMessages(db, keys, x.ids.filter((i): i is string => typeof i === "string"));
  } else if ((type === "CHANNEL_DELETE" || type === "THREAD_DELETE") && typeof x.id === "string") {
    await forgetChannels(db, keys, [x.id, ...await dc.loadChannelTree(db, { parentIds: [x.id] })]);
  } else if (type === "GUILD_DELETE" && typeof x.id === "string" && !x.unavailable) {
    await forgetChannels(db, keys, await dc.loadChannelTree(db, { guildId: x.id }));
  }
  return null;
}

const channelGuild = async (db: Db, channelId: string): Promise<string | undefined> =>
  (await dc.loadWatchedChannels(db, [channelId])).get(channelId)?.guildId;

export type DiscordLink = { url: string; at: string };

/** Message links of an item, newest first. Empty when the key is missing or a row does not open. */
export async function linksOf(db: Db, keys: DiscordKeys | null, repo: string, number: number): Promise<DiscordLink[]> {
  if (!keys) return [];
  return mentionLinks(keys, (await dc.loadMentionsOfItems(db, [`${repo}#${number}`])).get(`${repo}#${number}`) ?? []);
}

/** The link that opens a message in Discord. */
export const messageUrl = (v: Pick<MessageRef, "guildId" | "channelId" | "messageId">): string => `https://discord.com/channels/${v.guildId}/${v.channelId}/${v.messageId}`;

/** The message links of stored mention rows, newest first; rows the key cannot open are left out. */
export function mentionLinks(keys: DiscordKeys | null, rows: readonly { sealed: string; msgHash: string }[]): DiscordLink[] {
  if (!keys) return [];
  return rows.flatMap((r) => {
    const v = keys.open(r.sealed, r.msgHash);
    return v ? [{ url: messageUrl(v), at: v.at }] : [];
  }).sort((a, b) => b.at.localeCompare(a.at));
}

export const countOf = async (db: Db, repo: string, number: number): Promise<number> =>
  (await dc.loadMentionCounts(db, [`${repo}#${number}`])).get(`${repo}#${number}`)?.count ?? 0;

export const setStatus = async (db: Db, state: string, detail: string | null): Promise<void> =>
  await dc.saveStatus(db, state, detail, new Date().toISOString());
