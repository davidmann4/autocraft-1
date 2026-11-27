// What the bot's threads and command replies follow. An @-command that runs on items (src/discord/at-commands.ts) answers in a
// public thread started on the command message, or in a plain reply where the bot cannot start one. Either becomes a follow target:
// later commands in the thread, and replies to the bot's command reply, take their items from it (followOf), and the results of the
// work on those items belong there (followersOf, sendToFollow).
//
// Storage (`discord_follows`): one row per target and item. The target is a keyed hash (the thread's channel id, or the bot's reply's
// message id); the guild, channel and message ids and a keyed hash of the sender are sealed with the row (keys.ts). No message text.
// Rows go with their thread, the channel the command was sent in, the bot's reply, a deletion request by user id, or once no command
// has named the item there for FOLLOW_KEEP_DAYS.
//
// The status changes and results of the followed items are posted by src/discord/results.ts, through sendToFollow.
import * as dc from "../data/discord/index.ts";
import type { FollowRow } from "../data/discord/index.ts";
import type { Db } from "../db/index.ts";
import type { ItemRef } from "../workflow/types.ts";
import type { DiscordKeys } from "./keys.ts";
import type { DiscordRest, MessageBody } from "./rest.ts";

/** Days a target keeps following an item that no command named there since. */
export const FOLLOW_KEEP_DAYS = 30;

/** Where results go: a thread (`channelId` is the thread, `messageId` its first message), or as a reply to the bot's message in a channel. */
export type FollowTarget = { kind: "thread" | "reply"; guildId: string; channelId: string; messageId: string };
/** A target with the items it follows; `command` and `login` are of the latest command, `channelHash` the channel it was sent in. */
export type Follow = { targetHash: string; channelHash: string; target: FollowTarget; items: ItemRef[]; command: string; login: string; at: string };

export const threadTarget = (keys: DiscordKeys, threadId: string): string => keys.hash("channel", threadId);
export const replyTarget = (keys: DiscordKeys, messageId: string): string => keys.hash("message", messageId);
/** What a result post's seal is bound to (results.ts): its target and item. */
export const resultAad = (p: { targetHash: string; repo: string; number: number }): string => `result:${p.targetHash}:${p.repo}#${p.number}`;

/** Groups rows by target; a target whose seal does not open is left out. */
export function followsOf(keys: DiscordKeys, rows: readonly FollowRow[]): Follow[] {
  const by = new Map<string, FollowRow[]>();
  for (const r of rows) by.set(r.targetHash, [...(by.get(r.targetHash) ?? []), r]);
  return [...by.values()].flatMap((list) => {
    const latest = list.reduce((a, b) => (b.at > a.at ? b : a));
    const ref = keys.open(latest.sealed, latest.targetHash);
    if (!ref) return [];
    return [{
      targetHash: latest.targetHash, channelHash: latest.channelHash, command: latest.command, login: latest.login, at: latest.at,
      target: { kind: latest.kind, guildId: ref.guildId, channelId: ref.channelId, messageId: ref.messageId },
      items: list.map((r) => ({ repo: r.repo, number: r.number })),
    }];
  });
}

/** What a target (threadTarget or replyTarget) follows, or null. */
export async function followOf(db: Db, keys: DiscordKeys, targetHash: string): Promise<Follow | null> {
  return followsOf(keys, (await dc.loadFollows(db, [targetHash])).get(targetHash) ?? [])[0] ?? null;
}

/** The targets that follow each item, by `repo#number` (short repo name); an item nobody follows is absent. */
export async function followersOf(db: Db, keys: DiscordKeys, items: readonly ItemRef[]): Promise<Map<string, Follow[]>> {
  const byItem = await dc.loadFollowsOfItems(db, items.map((i) => `${i.repo.split("/").pop()!}#${i.number}`));
  const targets = await dc.loadFollows(db, [...byItem.values()].flatMap((rows) => rows.map((r) => r.targetHash)));
  const all = new Map(followsOf(keys, [...targets.values()].flat()).map((f) => [f.targetHash, f]));
  return new Map([...byItem].map(([key, rows]) => [key, rows.flatMap((r) => all.get(r.targetHash) ?? [])]));
}

/** Makes `target` follow `items` as well, under the latest command; items it followed already stay. */
export async function follow(db: Db, keys: DiscordKeys, o: {
  targetHash: string; channelHash: string; target: FollowTarget; author: string; items: readonly ItemRef[]; command: string; login: string; at: string;
}): Promise<void> {
  if (!o.items.length) return;
  const sealed = keys.seal({ guildId: o.target.guildId, channelId: o.target.channelId, messageId: o.target.messageId, at: o.at, author: o.author }, o.targetHash);
  const before = new Date(Date.parse(o.at) - FOLLOW_KEEP_DAYS * 86_400_000).toISOString();
  await dc.saveFollows(db, o.items.map((i) => ({
    targetHash: o.targetHash, repo: i.repo.split("/").pop()!, number: i.number, kind: o.target.kind, channelHash: o.channelHash, sealed, command: o.command, login: o.login, at: o.at,
  })), before);
}

/** Posts in the target: in its thread, or as a reply to the bot's message. Never mentions anyone. */
export async function sendToFollow(rest: Pick<DiscordRest, "createMessage">, target: FollowTarget, body: Omit<MessageBody, "allowed_mentions" | "message_reference">): Promise<{ id: string }> {
  return await rest.createMessage(target.channelId, {
    ...body, allowed_mentions: { parse: [] },
    ...(target.kind === "reply" ? { message_reference: { message_id: target.messageId, fail_if_not_exists: false } } : {}),
  });
}

/** Part of a deletion request by Discord user id: opens every row to find the sender's. */
export async function forgetFollowsOf(db: Db, keys: DiscordKeys, userId: string): Promise<number> {
  const want = keys.hash("author", userId);
  return await dc.removeSealedFollows(db, (await dc.loadSealedFollows(db)).filter((r) => keys.open(r.sealed, r.targetHash)?.author === want));
}
