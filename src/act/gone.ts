// The closes people asked for whose item closed or merged by itself: nothing is left to do.
import { loadActionsDue, saveActions, type ActionKind } from "../data/workflow/index.ts";
import type { Db } from "../db/index.ts";

/** The person actions the Act step carries out. */
export const CLOSE_KINDS: ActionKind[] = ["close", "comment-close"];

/** Ends the closes whose item closed or merged without them (seen by the sync). Returns the number ended. */
export async function endGoneCloses(db: Db, now: Date = new Date()): Promise<number> {
  const gone = (await loadActionsDue(db, { kinds: CLOSE_KINDS })).filter((a) => a.itemState !== null && a.itemState !== "OPEN");
  await saveActions(db, gone.map((a) => ({ id: a.id, state: "done", reason: `already ${a.itemState!.toLowerCase()} on GitHub`, at: now.toISOString() })), { from: ["pending"] });
  return gone.length;
}
