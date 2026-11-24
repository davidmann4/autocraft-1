// The issue panel: one pinned bot message per support channel with Report a bug, Request a feature and Find an existing
// issue, for people who do not use the slash commands. The bug and feature buttons open the new-issue form
// (issue-new.ts) with the channel's default repo preselected and set the kind; the find button opens the search form
// (search-commands.ts) and replies with matches only. An operator posts it with
// `autocraft-server discord panel post <channel id>`; posting again edits the stored message in place.
import type { Interactions } from "./interactions.ts";
import type { IssueNew } from "./issue-new.ts";
import type { MessageBody } from "./rest.ts";
import { fileRepoUrl } from "./reply.ts";
import { showSearchForm } from "./search-commands.ts";
import type { Db } from "../db/index.ts";

export const PANEL_TEXT = "**Found a problem or have an idea?**\nAutoCraft looks for an existing issue first, then helps you write a new one.";

const button = (label: string, custom_id: string, style: 1 | 2) => ({ type: 2, style, label, custom_id });

export function panelMessage(): MessageBody {
  return {
    content: PANEL_TEXT,
    allowed_mentions: { parse: [] },
    components: [{ type: 1, components: [button("Report a bug", "panel:bug", 1), button("Request a feature", "panel:feature", 1), button("Find an existing issue", "panel:find", 2)] }],
  };
}

/** What posting needs from Discord; the REST client, or a fake in tests. */
export type PanelRest = {
  createMessage(channelId: string, body: MessageBody): Promise<{ id: string }>;
  editMessage(channelId: string, messageId: string, body: MessageBody): Promise<void>;
  pinMessage(channelId: string, messageId: string): Promise<void>;
};

/** `pinError`: a new panel could not be pinned (it is posted all the same). */
export type PostResult = { messageId: string; created: boolean; pinError?: string };

/**
 * Posts the panel in a channel the bot has reported, or edits the panel posted there before. A stored message that is
 * gone (deleted in Discord) is replaced by a new one. A new panel is pinned; a failed pin keeps the panel and says why.
 */
export async function postPanel(db: Db, rest: PanelRest, channelId: string): Promise<PostResult | null> {
  const row = await db.get(db.k.selectFrom("discord_channels").select("panel_message").where("channel_id", "=", channelId));
  if (!row) return null;
  const body = panelMessage();
  if (row.panel_message) {
    try {
      await rest.editMessage(channelId, row.panel_message, body);
      return { messageId: row.panel_message, created: false };
    } catch (e) {
      if ((e as { status?: number }).status !== 404) throw e;
    }
  }
  const { id } = await rest.createMessage(channelId, body);
  await db.run(db.k.updateTable("discord_channels").set({ panel_message: id }).where("channel_id", "=", channelId));
  try {
    await rest.pinMessage(channelId, id);
    return { messageId: id, created: true };
  } catch (e) {
    return { messageId: id, created: true, pinError: (e as Error).message };
  }
}

export function installPanel(ix: Interactions, db: Db, flow: IssueNew): void {
  ix.component("panel", async (call) => {
    const which = (call.interaction.data?.custom_id ?? "").split(":")[1];
    if (which === "find") return void (await showSearchForm(call));
    const repo = (await fileRepoUrl(db, call.interaction.channel_id, []))?.split("/").pop() ?? null;
    await flow.open(call, repo, "", which === "feature" ? "feature" : "bug");
  }, { immediate: true });
}
