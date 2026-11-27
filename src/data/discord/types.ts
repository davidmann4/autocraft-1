import type { RefKey } from "../mirror/types.ts";

export type Ref = RefKey;
export const EVENT_KINDS = ["started", "junk", "filed", "link", "limits"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export type EventCounts = Record<EventKind, { day: number; week: number }>;

export type ChannelReport = {
  channelId: string; guildId: string; guildName: string | null; name: string | null; parentId?: string | null; position?: number | null;
  categoryId?: string | null; viewable?: boolean;
};
export type ChannelRow = { channelId: string; guildId: string; guildName: string | null; name: string | null; watched: boolean; defaultRepo: string | null; category: string | null };
export type ChannelBrief = { channelId: string; guildName: string | null; name: string | null; watched: boolean };
export type CategoryRow = { categoryId: string; guildId: string; name: string; position: number };
export type StatusRow = { state: string; detail: string | null; at: string };

/** One (message, item) row; `sealed` stays opaque to the module, callers open it with the Discord keys. */
export type MentionRow = { msgHash: string; channelHash: string; repo: string; number: number; sealed: string; signal: boolean };
export type MentionChange = { msgHash: string; channelHash: string; remove: Ref[]; add: { repo: string; number: number; sealed: string }[] };
export type ReplyRow = { pingHash: string; quotedHash: string | null; sealed: string };
/** One (target, item) row of what a thread or command reply follows; `sealed` stays opaque to the module. */
export type FollowRow = { targetHash: string; repo: string; number: number; kind: "thread" | "reply"; channelHash: string; sealed: string; command: string; login: string; at: string };
/** What the bot last posted about one followed (target, item): hashes of the status line, result and link, the result's key, and its message id sealed. */
export type FollowPost = { targetHash: string; repo: string; number: number; statusHash: string; resultKey: string; resultHash: string; linkHash: string; sealed: string; at: string };

export type Alerter = { userHash: string; sealed: string; createdAt: string; login: string };
export type SentAlert = { userHash: string; workflowId: number; recAt: string; sentAt: string };

export type FilingRepo = { owner: string; name: string; addedBy: string; addedAt: string };
export type FilingCounts = { byLogin: number; byReporter: number; byRepo: number };
export type FilingReservation = { repo: string; login: string; reporter: string; atIso: string; sinceIso: string; by: "login" | "reporter"; perLogin: number; perRepo: number };
export type BotRepo = { owner: string; name: string; filingOnly: boolean };
export type FilingFacts = {
  offered: boolean; identityIsApp: boolean; byReporter: number; perReporter: number; byRepo: number; perRepo: number; reservedByRequest: number; dailyWrites: number; dailyLimit: number;
};
export type FiledRow = { repo: string; number: number; login: string; at: string };

export type DiscordSetupData = {
  status: StatusRow | null; channels: ChannelRow[]; filing: FilingRepo[]; hidden: Set<string>; recentFiled: FiledRow[]; eventCounts: EventCounts;
};
