import type { RefKey } from "../mirror/types.ts";

export type Ref = RefKey;

export type ChatVia = "dashboard" | "github" | "discord" | "agent" | "cli" | "autocraft";
export type ChatKind = "said" | "recommended" | "finished";

/** A conversation; `repo` and `number` are null for one about no item. `main`: the item's main conversation. */
export type ConversationRow = { id: number; repo: string | null; number: number | null; title: string; main: boolean; createdAt: string; createdBy: string };

/**
 * One message. `payload` is the parsed JSON of the row (src/workflow/chat.ts RecommendedPayload, FinishedPayload; said: `{url?, reconstructed?}`),
 * null when there is none. `workflowId`: the workflow a recommendation or end line is about; `githubCommentId`: the GitHub comment a said message copies.
 */
export type ChatMessageRow = {
  id: number; conversationId: number; author: string; via: ChatVia; kind: ChatKind; body: string; payload: unknown;
  workflowEventId: number | null; turnId: number | null; workflowId: number | null; githubCommentId: number | null; at: string;
};

/** A message to store; the item's main conversation is made when it has none. `at` defaults to now. */
export type NewChatMessage = {
  repo: string; number: number; author: string; via: ChatVia; kind: ChatKind; body: string; payload?: unknown;
  workflowEventId?: number | null; turnId?: number | null; workflowId?: number | null; githubCommentId?: number | null; at?: string;
};
