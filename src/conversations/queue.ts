// The queue of card presses that wait for room under the daily GitHub write limit. A press that finds no room is not refused:
// the card stays with the presser's note and skipped steps, and the Act step runs
// queued cards in order (item priority level, then the time of the press) once room returns, which is 00:00 UTC or an operator's
// raise of the limit. Waiting for room is the registered "Daily limit" wait (src/stages/registry.ts); no timer runs.
// Card writes and Act's closes share one count (src/conversations/usage.ts), held to the Act limit.
import { isRegistry, readParams, type CardParams } from "./cards.ts";
import { loadActRoom, loadQueue, type ActRoom } from "../data/conversations/index.ts";
import type { Db } from "../db/index.ts";

/** What a queued card needs to run later as the press would have run: the presser's choices at the time. */
export type QueueArgs = { note?: string; noteStaysOut?: boolean; role?: string };

/**
 * The GitHub writes a card makes when pressed: one for a comment, a label or an action without a command. A command writes nothing
 * here: it runs through the workflow, whose steps and person actions keep their own counts; an issue a merging command holds is
 * counted when it is filed (src/conversations/held.ts).
 */
export function cardWriteCount(params: CardParams | null): number {
  return params && (params.kind !== "command" || !isRegistry(params.command)) ? 1 : 0;
}

/** Writes the queued card still makes. */
export function needOf(c: { kind: string; params: string }): number {
  return cardWriteCount(readParams(c.kind, c.params));
}

/**
 * Whether `room` (the limit, the count used and the cards running now) leaves space for `need` more card writes. Cards that run now and have not
 * made their writes yet count as used, so two presses at once cannot both take the last room. A card larger than the whole limit runs on an empty
 * day instead of waiting for ever.
 */
export function roomFor(room: ActRoom, need: number): boolean {
  if (room.limit === null || need === 0) return true;
  const used = room.used + room.running.reduce((n, r) => { try { return n + Math.max(0, needOf(r) - r.written); } catch { return n; } }, 0);
  return used + need <= room.limit || (used === 0 && need > room.limit && room.limit > 0);
}

/** Room under the daily limit for `need` more card writes. Call it inside the transaction that claims the card, so the check and the claim are one step. */
export async function actRoom(db: Db, need: number, ms: number = Date.now()): Promise<boolean> {
  return roomFor(await loadActRoom(db, new Date(ms)), need);
}

export type QueuedRow = { id: number; repo: string; number: number; queued_at: string; acted_by: string | null; place: number };

/**
 * Queued cards in the order they run: higher item priority level first (security raised), then the earlier press. One wave.
 * Cards whose repo the pipeline cannot run Act for now are left out, so they hold no place and block nobody; the drain asks for them with `all`.
 */
export async function queuedCards(db: Db, o: { all?: boolean } = {}): Promise<QueuedRow[]> {
  return (await loadQueue(db, o)).rows.map((r) => ({ id: r.id, repo: r.repo, number: r.number, queued_at: r.queued_at ?? "", acted_by: r.acted_by, place: r.place }));
}

/** Places (from 1) of the queued cards that will run. Read once per request. */
export async function queuePlaces(db: Db, rows?: QueuedRow[]): Promise<Map<number, number>> {
  return new Map((rows ?? await queuedCards(db)).map((r) => [r.id, r.place]));
}

/** 1-based place of the card in the queue, or null when it is not queued. */
export const queuePlace = async (db: Db, cardId: number): Promise<number | null> => (await queuePlaces(db)).get(cardId) ?? null;

/** The shown reason of a queued press. The place is read when shown, never stored. */
export const queueReason = (place: number | null): string => (place === null ? "daily GitHub write limit" : `daily GitHub write limit, #${place} in line`);

/** Whether any card other than `except` waits in the loaded queue. */
export const queuedAhead = (queue: { rows: { id: number }[] }, except?: number): boolean => queue.rows.some((r) => r.id !== except);

/** The first queued card and what it needs, for the planner: it proposes the drain only when the head fits. */
export async function queueHead(db: Db): Promise<{ repo: string; fits: boolean } | null> {
  const [queue, room] = await db.together(() => Promise.all([loadQueue(db), loadActRoom(db, new Date())]));
  const head = queue.rows[0];
  if (!head) return null;
  try { return { repo: head.repo, fits: roomFor(room, needOf(head)) }; } catch { return { repo: head.repo, fits: true }; }
}
