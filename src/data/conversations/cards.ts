// Action cards and the Act queue (M12 conversations).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import * as control from "../control/index.ts";
import { rankLevel } from "../triage/fragments.ts";
import type { ActRoom, CardPatch, CardRow, CardState, Queue, QueuedCard, RunningCard } from "./types.ts";

/** The columns of a card as `CardRow` has them (the retired `choice_id` and dispute columns are never read). */
export const CARD_COLS = ["id", "turn_id", "repo", "number", "kind", "params", "text", "description", "state", "result", "result_url", "error", "acted_by", "acted_at", "edited_by", "edited_at", "seen", "queued_at", "queue_args"] as const;

/** A card that runs now and has not made its GitHub writes yet reserves them for this long after the press. */
export const RUNNING_RESERVE_MS = 10 * 60_000;

const cardOf = (r: Record<string, unknown>): CardRow => ({ ...r, id: Number(r.id), turn_id: Number(r.turn_id), number: Number(r.number) }) as unknown as CardRow;
const selectCards = (db: Db) => queryDb(db).k.selectFrom("main.conversation_cards as c").select(CARD_COLS.map((c) => `c.${c}` as const));

/** Cards by id. 1 statement. */
export async function loadCards(db: Db, ids: number[]): Promise<Map<number, CardRow>> {
  const out = new Map<number, CardRow>();
  if (!ids.length) return out;
  for (const r of await queryDb(db).all(selectCards(db).where(kx.inList(db, "c.id", [...new Set(ids)], "bigint")))) out.set(Number(r.id), cardOf(r));
  return out;
}

/**
 * Queued cards ordered by rank level (`triage.fragments.rankLevel`), `queued_at` (earlier first, none first), id. Unless `all`, rows of repos Act
 * cannot run for (`control.loadActBlocked`) are left out and `place` counts the rows that remain; with `all` every row stays, no blocked
 * read is made (`blocked` is empty) and `place` counts all rows. 2 statements.
 */
export async function loadQueue(db: Db, o?: { all?: boolean }): Promise<Queue> {
  const q = queryDb(db);
  const rows = (await q.all(selectCards(db).where("c.state", "=", "queued").orderBy((eb) => rankLevel(eb, "c.repo", "c.number"), "desc")
    .orderBy("c.queued_at", (ob) => ob.asc().nullsFirst()).orderBy("c.id"))).map(cardOf);
  const blocked = new Set<string>();
  if (!o?.all && rows.length) for (const [repo, why] of await control.loadActBlocked(db, [...new Set(rows.map((r) => r.repo))])) if (why !== null) blocked.add(repo);
  const run = rows.filter((r) => !blocked.has(r.repo));
  return { rows: run.map((r, i): QueuedCard => ({ ...r, place: i + 1 })), blocked };
}

/** Cards running since `sinceIso` (the reserve). */
export async function loadRunningCards(db: Db, sinceIso: string): Promise<CardRow[]> {
  return (await queryDb(db).all(selectCards(db).where("c.state", "=", "running").where("c.acted_at", ">", sinceIso).orderBy("c.id"))).map(cardOf);
}

/**
 * What the Act step's daily room is made of: the limit, the count used since the later of the UTC day start and the operator's reset, and
 * the cards running now with the GitHub writes each has already made. 5 statements in two waves, whatever the number of running cards.
 */
export async function loadActRoom(db: Db, now: Date): Promise<ActRoom> {
  const day = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const [limit, used, running] = await db.together(() => Promise.all([
    control.loadActLimit(db), control.loadActUsage(db, day), loadRunningCards(db, new Date(now.getTime() - RUNNING_RESERVE_MS).toISOString()),
  ]));
  const written = await control.countCardWrites(db, running.map((r) => ({ id: r.id, since: r.acted_at ?? undefined })));
  return { limit, used, running: running.map((r): RunningCard => ({ id: r.id, kind: r.kind, params: r.params, text: r.text, queue_args: r.queue_args, written: written.get(r.id) ?? 0 })) };
}

/** Compare-and-set on `state IN from`; true when the card moved. Keys of `set` that are undefined are left alone. */
export async function markCard(db: Db, id: number, from: CardState[], set: CardPatch): Promise<boolean> {
  const patch = Object.fromEntries(Object.entries(set).filter(([, v]) => v !== undefined));
  if (!from.length || !Object.keys(patch).length) return false;
  const q = queryDb(db);
  return Number((await db.write(async () => await q.run(q.k.updateTable("main.conversation_cards").set(patch).where("id", "=", id).where("state", "in", from)))).changes) === 1;
}

/** Fails queued (or `from`) cards that cannot run; returns how many moved. 1 statement. */
export async function failCards(db: Db, ids: number[], error: string, at: string, from: CardState): Promise<number> {
  if (!ids.length) return 0;
  const q = queryDb(db);
  return await db.write(async () => {
    let n = 0;
    for (const part of kx.chunks(ids)) n += Number((await q.run(q.k.updateTable("main.conversation_cards").set({ state: "failed", error, acted_at: at }).where("state", "=", from).where(kx.inList(db, "id", part, "bigint")))).changes);
    return n;
  });
}

/** A card left `running` by a crashed process is marked failed: what it did on GitHub is unknown. */
export async function sweepRunningCards(db: Db, cutoffIso: string): Promise<number> {
  const q = queryDb(db);
  return Number((await q.run(q.k.updateTable("main.conversation_cards").set({ state: "failed", error: "outcome unknown; see the GitHub activity page" }).where("state", "=", "running").where("acted_at", "<", cutoffIso))).changes);
}
