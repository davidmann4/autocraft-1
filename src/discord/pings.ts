// Answers @-mentions of the bot in watched channels with one public reply: the items the quoted message links to or names, then the
// issues closest to the question. The
// question is the quoted message, or the ping's own text without mentions. The question is searched and dropped; the
// only record of a reply is a keyed hash of the ping and of the quoted message with the sealed id of our reply, kept so
// the reply can be deleted when either message is deleted. A message addressed to the bot whose text is a command goes to the
// command handler instead (at-commands.ts). See docs/pipeline.md.
import type { AtCommands } from "./at-commands.ts";
import type { DiscordKeys } from "./keys.ts";
import { deleteRepliesOf } from "./replies.ts";
import { deliver, renderMatches } from "./reply.ts";
import type { DiscordRest } from "./rest.ts";
import { QUESTION_CHARS, linkedMatches, type Search } from "./search.ts";
import { isWatched, messageItems } from "./store.ts";
import type { Db } from "../db/index.ts";
import { loadReplyPings, saveReplies } from "../data/discord/index.ts";

type Mentionable = { id: string };
export type PingMessage = {
  id: string; channel_id: string; guild_id?: string; content?: string; type?: number; webhook_id?: string;
  author?: { id: string; bot?: boolean };
  mentions?: Mentionable[]; mention_roles?: string[];
  message_reference?: { message_id?: string; type?: number };
  referenced_message?: { content?: string | null; message_snapshots?: { message?: { content?: string | null } }[]; author?: { id?: string } } | null;
};
type Role = { id: string; tags?: { bot_id?: string } };

/** Matches in a public ping reply. */
const PING_MATCHES = 3;
const MENTION = /<@[!&]?\d+>/g;
const strip = (s: string): string => s.replace(MENTION, " ").replace(/\s+/g, " ").trim();

export type PingDeps = { db: Db; keys: DiscordKeys; rest: DiscordRest; search: Search; log: (line: string) => void; commands?: AtCommands };

export class Pings {
  #d: PingDeps;
  #botId: string | null = null;
  #roles = new Set<string>();
  #inflight = new Set<string>();
  #deletedMeanwhile = new Set<string>();
  #jobs = new Set<Promise<void>>();

  constructor(deps: PingDeps) {
    this.#d = deps;
  }

  /** Resolves when the work started so far has finished; for tests. */
  async idle(): Promise<void> {
    while (this.#jobs.size) await Promise.all([...this.#jobs]);
  }

  /** Gateway events. Returns at once; the work runs on its own and never throws. */
  async dispatch(type: string, d: unknown): Promise<void> {
    const x = d as Record<string, unknown>;
    if (type === "READY") {
      this.#botId = (x.user as Mentionable | undefined)?.id ?? null;
    } else if (type === "GUILD_CREATE") {
      for (const r of (x.roles as Role[] | undefined) ?? []) this.#role(r);
    } else if (type === "GUILD_ROLE_CREATE" || type === "GUILD_ROLE_UPDATE") {
      if (x.role) this.#role(x.role as Role);
    } else if (type === "MESSAGE_CREATE") {
      const m = d as PingMessage;
      const to = await this.#addressed(m);
      if (!to) return;
      let command: (() => Promise<void>) | null = null;
      try {
        command = this.#d.commands ? await this.#d.commands.take(m, { botId: this.#botId!, mentioned: to.mentioned }) : null;
      } catch (e) {
        this.#d.log(`discord: reading a message as a command failed: ${(e as Error).message}`);
      }
      if (command) this.#run(command);
      else if (to.ping) this.#run(() => this.#ping(m));
    } else if (type === "MESSAGE_DELETE") {
      if (typeof x.id === "string") this.#run(() => this.#deleted([x.id as string]));
    } else if (type === "MESSAGE_DELETE_BULK") {
      if (Array.isArray(x.ids)) { const ids = (x.ids as unknown[]).filter((i): i is string => typeof i === "string"); this.#run(() => this.#deleted(ids)); }
    }
  }

  #run(job: () => Promise<void>): void {
    const p: Promise<void> = job().catch((e: Error) => this.#d.log(`discord: ping handling failed: ${e.message}`)).finally(() => this.#jobs.delete(p));
    this.#jobs.add(p);
  }

  #role(r: Role): void {
    if (this.#botId && r.tags?.bot_id === this.#botId) this.#roles.add(r.id);
  }

  /**
   * A person's new message in a watched channel that names the bot in its text (`<@id>`, `<@!id>` or the bot's role), or replies
   * to one of the bot's messages; null for any other. Discord also lists the author of a replied-to message in `mentions`, so that
   * list does not count. `ping`: it may be a ping, which a reply to one of the bot's own messages never is. Bots, webhooks, edits
   * and system messages are neither.
   */
  async #addressed(m: PingMessage): Promise<{ mentioned: boolean; ping: boolean } | null> {
    if (!this.#botId || typeof m.id !== "string" || typeof m.channel_id !== "string") return null;
    if (!m.author?.id || m.author.bot || m.webhook_id) return null;
    if (m.type !== undefined && m.type !== 0 && m.type !== 19) return null;
    const toBot = m.referenced_message?.author?.id === this.#botId;
    const text = m.content ?? "";
    const mentioned = text.includes(`<@${this.#botId}>`) || text.includes(`<@!${this.#botId}>`) || [...this.#roles].some((r) => text.includes(`<@&${r}>`));
    if (!mentioned && !toBot) return null;
    return await isWatched(this.#d.db, m.channel_id) ? { mentioned, ping: mentioned && !toBot } : null;
  }

  async #ping(m: PingMessage): Promise<void> {
    const { db, keys, rest, search } = this.#d;
    const pingHash = keys.hash("message", m.id);
    if (this.#inflight.has(pingHash) || (await loadReplyPings(db, [pingHash])).has(pingHash)) return;
    // A forward (type 1) is not a reply: its text is not a quoted message.
    const isReply = !m.message_reference?.type;
    const quotedId = isReply ? m.message_reference?.message_id : undefined;
    const question = (quotedId ? strip(m.referenced_message?.content ?? "") : "") || strip(m.content ?? "");
    if (!question) return;
    if (!search.allow(keys.hash("author", m.author!.id), keys.hash("channel", m.channel_id))) return;
    this.#inflight.add(pingHash);
    try {
      const found = await search.find(question.slice(0, QUESTION_CHARS));
      // The items the quoted message links to or names come first, then the closest matches.
      const linked = quotedId ? await linkedMatches(db, await messageItems(db, keys, quotedId, m.referenced_message)) : [];
      const isLinked = new Set(linked.map((x) => `${x.repo}#${x.number}`));
      const matches = [...linked, ...found.matches.filter((x) => !isLinked.has(`${x.repo}#${x.number}`))];
      // A ping reply is public in the channel: the best few only.
      const r = await renderMatches(db, matches.slice(0, PING_MATCHES), question, m.channel_id);
      const quoted = quotedId ? keys.hash("message", quotedId) : null;
      // Deleted while the search ran: nothing to reply to.
      if (this.#deletedMeanwhile.has(pingHash) || (quoted && this.#deletedMeanwhile.has(quoted))) return;
      let sent: { id: string } | undefined;
      await deliver(r, async (b) => { sent = await rest.createMessage(m.channel_id, { ...b, allowed_mentions: { parse: [] }, message_reference: { message_id: m.id, fail_if_not_exists: false } }); });
      const sealed = keys.seal({ guildId: m.guild_id ?? "", channelId: m.channel_id, messageId: sent!.id, at: new Date().toISOString() }, pingHash);
      await saveReplies(db, [{ pingHash, quotedHash: quoted, channelHash: keys.hash("channel", m.channel_id), sealed }]);
      // Deleted while the reply was being sent.
      if (this.#deletedMeanwhile.has(pingHash) || (quoted && this.#deletedMeanwhile.has(quoted))) await this.#deleted([m.id, ...(quotedId ? [quotedId] : [])]);
    } finally {
      this.#inflight.delete(pingHash);
      if (!this.#inflight.size) this.#deletedMeanwhile.clear();
    }
  }

  async #deleted(ids: string[]): Promise<void> {
    const { db, keys, rest, log } = this.#d;
    if (this.#inflight.size) for (const id of ids) this.#deletedMeanwhile.add(keys.hash("message", id));
    await deleteRepliesOf(db, keys, rest, ids, log);
  }
}
