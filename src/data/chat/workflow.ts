// AutoCraft's own messages about a workflow, written by the workflow save path (src/data/workflow/rows.ts saveWorkflows) in the write
// that changes the row: a recommendation each time the row comes back with a new one, and an end line when it ends done or closed.
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { CHAT_AUTHOR, conversationTitle, finishedMessage, recommendedMessage, UNTITLED } from "../../workflow/chat.ts";
import { ASKING_STATES, type Entry, type PlanPart, type Recommendation, type WorkflowState } from "../../workflow/types.ts";
import type { WorkflowPatch } from "../workflow/types.ts";
import { recordMessages } from "./messages.ts";
import type { NewChatMessage } from "./types.ts";

const ASKING: readonly string[] = ASKING_STATES;
const ENDS: readonly string[] = ["done", "closed"] satisfies WorkflowState[];

/** A patch that may give its row a new recommendation or end it. */
export const patchTalks = (p: WorkflowPatch): boolean => p.rec != null || (p.state !== undefined && (ASKING.includes(p.state) || ENDS.includes(p.state)));

/** The rows as they were before a save: what a new question or an end is told from. A question is new when the row starts asking or its `rec_at` moves (as Discord alerts count them). */
export type ChatBefore = Map<number, { state: string; recAt: string | null }>;

export async function loadChatBefore(db: Db, ids: number[]): Promise<ChatBefore> {
  const q = queryDb(db);
  const out: ChatBefore = new Map();
  for (const part of kx.chunks([...new Set(ids)])) {
    const rows = await q.all(q.k.selectFrom("main.item_workflows").select(["id", "state", "rec_at"]).where(kx.inList(db, "id", part, "bigint")), { label: "chat.loadChatBefore" });
    for (const r of rows) out.set(Number(r.id), { state: r.state, recAt: r.rec_at });
  }
  return out;
}

const json = <T>(text: string | null, or: T): T => {
  try {
    return text === null ? or : (JSON.parse(text) as T) ?? or;
  } catch {
    return or;
  }
};

/**
 * After a save: a recommended message for each row that now asks a new question, and a finished
 * message for each row that has just ended. Returns how many it wrote. Joins the caller's `db.write`.
 */
export async function recordWorkflowMessages(db: Db, before: ChatBefore): Promise<number> {
  if (!before.size) return 0;
  const q = queryDb(db);
  const out: NewChatMessage[] = [];
  for (const part of kx.chunks([...before.keys()])) {
    const rows = await q.all((q.k as any).selectFrom("main.item_workflows as w")
      .leftJoin("main.items as i", (j: any) => j.onRef("i.repo", "=", "w.repo").on((eb: any) => eb("i.number", "=", eb.fn.coalesce("w.pr_number", "w.number"))))
      .select(["w.id", "w.repo", "w.number", "w.state", "w.rec", "w.rec_at", "w.plan", "w.started_by", "w.approved_by", "w.taken_by", "w.updated_at", "i.state as item_state", "i.base_ref"])
      .where(kx.inList(db, "w.id", part, "bigint")), { label: "chat.recordWorkflowMessages" }) as {
        id: number | string; repo: string; number: number | string; state: string; rec: string | null; rec_at: string | null; plan: string; started_by: string; approved_by: string | null; taken_by: string | null;
        updated_at: string; item_state: string | null; base_ref: string | null;
      }[];
    for (const r of rows) {
      const id = Number(r.id), was = before.get(id)!, number = Number(r.number);
      const item = { repo: r.repo, number, author: CHAT_AUTHOR, via: "autocraft" as const, workflowId: id };
      if (ASKING.includes(r.state) && r.rec !== null && (!ASKING.includes(was.state) || was.recAt !== r.rec_at)) {
        const rec = json<Recommendation | null>(r.rec, null);
        if (rec) {
          const m = recommendedMessage({ id, startedBy: r.started_by, approvedBy: r.approved_by, takenBy: r.taken_by, plan: json<PlanPart[]>(r.plan, []) }, rec);
          out.push({ ...item, kind: "recommended", ...m, at: r.rec_at ?? r.updated_at });
        }
      }
      if (ENDS.includes(r.state) && !ENDS.includes(was.state)) {
        const m = finishedMessage(id, r.state as "done" | "closed", { merged: r.item_state === "MERGED", base: r.base_ref });
        out.push({ ...item, kind: "finished", ...m, at: r.updated_at });
      }
    }
  }
  await recordMessages(db, out);
  return out.length;
}

/**
 * Started workflows title the main conversations their items got before they had one (a message that came before the start). One
 * statement per entry. Joins the caller's `db.write`.
 */
export async function retitleConversations(db: Db, started: readonly { repo: string; number: number; entry: Entry }[]): Promise<void> {
  if (!started.length) return;
  const q = queryDb(db);
  const byEntry = new Map<Entry, string[]>();
  for (const w of started) byEntry.set(w.entry, [...(byEntry.get(w.entry) ?? []), `${w.repo}#${w.number}`]);
  await db.write(async () => {
    for (const [entry, refs] of byEntry) {
      await q.run(q.k.updateTable("main.chat_conversations").set({ title: conversationTitle(entry) }).where("is_main", "=", 1).where("title", "=", UNTITLED)
        .where(kx.refIn(db, "main.chat_conversations", refs)));
    }
  });
}
