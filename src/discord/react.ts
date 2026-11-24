// Adds the bot's reaction to a message it has just recorded against items, so people see it was picked up: the guild's
// custom emoji of the configured name (default `bot`) when it has one, a configured Unicode emoji as is, else 🤖. The emoji come from GUILD_CREATE and GUILD_EMOJIS_UPDATE.
// The gateway handler stays free of network calls: it hands the message here and this fires the request without waiting.
import { RestError, type RestClient } from "./rest.ts";
import type { Db } from "../db/index.ts";

type ReactRest = Pick<RestClient, "addReaction">;

export const REACTION = "🤖";

export const DEFAULT_REACT_EMOJI = "bot";
const CUSTOM_NAME = /^[A-Za-z0-9_]{2,32}$/;
const UNICODE_EMOJI = /^\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic})*$/u;

/** A reaction setting is a custom emoji name (resolved per server) or one Unicode emoji. */
export const validReactEmoji = (v: string): boolean => CUSTOM_NAME.test(v) || UNICODE_EMOJI.test(v);

/** The configured reaction emoji: a custom emoji name or a Unicode emoji. */
export const reactEmoji = async (db: Db): Promise<string> => {
  const v = (await db.get(db.k.selectFrom("settings").select("value").where("key", "=", "discord_react_emoji")))?.value;
  return v && validReactEmoji(v) ? v : DEFAULT_REACT_EMOJI;
};

export async function setReactEmoji(db: Db, value: string): Promise<void> {
  await db.run(db.k.insertInto("settings").values({ key: "discord_react_emoji", value }).onConflict((oc) => oc.column("key").doUpdateSet({ value })));
}

/** The operators' switch on the Discord page; on unless switched off. */
export const reactOn = async (db: Db): Promise<boolean> =>
  (await db.get(db.k.selectFrom("settings").select("value").where("key", "=", "discord_react")))?.value !== "off";

export class Reactor {
  #d: { db: Db; rest: ReactRest; log: (l: string) => void };
  #logged = new Set<string>();
  #emoji = new Map<string, Map<string, string>>();

  constructor(d: { db: Db; rest: ReactRest; log: (l: string) => void }) {
    this.#d = d;
  }

  /** Tracks each guild's usable custom emoji by name per guild (a custom emoji reacts as `name:id`). */
  observe(type: string, d: unknown): void {
    const x = d as { id?: string; guild_id?: string; unavailable?: boolean; emojis?: { id?: string | null; name?: string | null; available?: boolean }[] };
    if (type === "GUILD_DELETE") {
      if (x.id && !x.unavailable) this.#emoji.delete(x.id);
      return;
    }
    const guild = type === "GUILD_CREATE" ? x.id : type === "GUILD_EMOJIS_UPDATE" ? x.guild_id : undefined;
    if (!guild || !Array.isArray(x.emojis)) return;
    this.#emoji.set(guild, new Map(x.emojis.flatMap((e) => e.id && e.name && e.available !== false ? [[e.name, `${e.name}:${e.id}`] as [string, string]] : [])));
  }

  /** Fire and forget. A refusal is logged once per channel and status and never retried. */
  async recorded(channelId: string, messageId: string, guildId?: string): Promise<void> {
    if (!await reactOn(this.#d.db)) return;
    const want = await reactEmoji(this.#d.db);
    const emoji = CUSTOM_NAME.test(want) ? (guildId && this.#emoji.get(guildId)?.get(want)) || REACTION : want;
    void this.#d.rest.addReaction(channelId, messageId, emoji).catch((e: unknown) => {
      const status = e instanceof RestError ? e.status : 0;
      const kind = status === 403 ? "missing the Add Reactions permission" : status === 404 ? "message no longer exists" : (e as Error).message;
      const key = `${channelId}|${status || kind}`;
      if (this.#logged.has(key)) return;
      this.#logged.add(key);
      this.#d.log(`runner: Discord reaction in channel ${channelId} failed: ${kind}`);
    });
  }
}
