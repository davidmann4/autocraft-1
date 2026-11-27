// What AutoCraft writes into an item's chat (src/data/chat) about a workflow: each recommendation it comes back with, and the line it
// ends with. Also the words of a command whose text was never kept (commands given before the chat existed), rebuilt from its parse.
import { t, tk } from "../i18n/index.ts";
import { askedLogins, asksNobody } from "./asked.ts";
import { describe } from "./parse.ts";
import { ruleStopLine } from "./status.ts";
import { type Entry, type ItemWorkflow, type Parsed, type PlanPart, type Recommendation } from "./types.ts";
import { ENTRY_LABEL, weightWord } from "./vocab.ts";

/** The author and surface of AutoCraft's own messages. */
export const CHAT_AUTHOR = "autocraft";

/** The title of a conversation started before its item had a workflow. */
export const UNTITLED = tk("Conversation");

/** A conversation's title: the entry of the item's first workflow. */
export const conversationTitle = (entry: Entry | null | undefined): string => (entry ? ENTRY_LABEL[entry] : UNTITLED);

/** `asked`: who the question goes to (askedLogins); empty, with `rule`, for a row the automatic merge rule started. */
export type RecommendedPayload = { workflowId: number; rec: Recommendation; parts: PlanPart[]; asked: string[]; rule?: true };

/** The body is the recommendation's sentence; a rule row's, which asks nobody, is its state line: why it stopped and what AutoCraft would do. */
export function recommendedMessage(w: Pick<ItemWorkflow, "id" | "startedBy" | "approvedBy" | "plan"> & { takenBy?: string | null }, rec: Recommendation): { body: string; payload: RecommendedPayload } {
  const rule = asksNobody(w);
  return { body: rule ? ruleStopLine(rec) : rec.text, payload: { workflowId: w.id, rec, parts: w.plan, asked: askedLogins(w), ...(rule ? { rule: true as const } : {}) } };
}

/** `merged`: the pull request the workflow worked on merged; `base`: the branch it merged into. */
export type FinishedPayload = { workflowId: number; state: "done" | "closed"; merged: boolean; base: string | null };

export function finishedMessage(workflowId: number, state: "done" | "closed", pr: { merged: boolean; base: string | null }): { body: string; payload: FinishedPayload } {
  const body = state === "closed" ? t("Closed.") : !pr.merged ? t("Done.") : pr.base ? t("Merged into {base}.", { base: pr.base }) : t("Merged.");
  return { body, payload: { workflowId, state, merged: pr.merged, base: pr.base } };
}

/** The canonical words of a parsed command (`fix 1, merge`, `yes, urgent`); `fallback` when there is no parse. */
export function parsedText(p: Parsed | null, fallback: string): string {
  if (!p) return fallback;
  const refs = (items: readonly { repo: string; number: number }[] | undefined): string => (items?.length ? `: ${items.map((i) => `${i.repo}#${i.number}`).join(" ")}` : "");
  switch (p.kind) {
    case "yes": return `${["yes", weightWord(p.weight)].filter(Boolean).join(", ")}${refs(p.items)}`;
    case "commands": { const text = describe(p.parts, p.items); return p.yes ? `yes, ${text}` : text || fallback; }
    case "ambiguous": return p.understood || p.rest || fallback;
  }
}
