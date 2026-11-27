// Mention rows (`discord_mentions`).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import type { MentionChange, MentionRow, Ref } from "./types.ts";

const TUPLE = ["text", "text", "bigint"] as const;

type Row = { msg_hash: string; channel_hash: string; repo: string; number: number; sealed: string; signal: number };
const rowOf = (r: Row): MentionRow => ({ msgHash: r.msg_hash, channelHash: r.channel_hash, repo: r.repo, number: Number(r.number), sealed: r.sealed, signal: Number(r.signal) === 1 });
const COLS = ["msg_hash", "channel_hash", "repo", "number", "sealed", "signal"] as const;

/** The rows of each message; a message with no rows is absent. */
export async function loadMessageMentions(db: Db, msgHashes: string[]): Promise<Map<string, MentionRow[]>> {
  const q = queryDb(db);
  const out = new Map<string, MentionRow[]>();
  for (const hashes of kx.chunks([...new Set(msgHashes)])) {
    for (const r of await q.all(q.k.selectFrom("main.discord_mentions").select(COLS).where(kx.inList(db, "msg_hash", hashes)), { label: "discord.loadMessageMentions" })) {
      const m = rowOf(r);
      const list = out.get(m.msgHash);
      if (list) list.push(m); else out.set(m.msgHash, [m]);
    }
  }
  return out;
}

/** The rows of a channel's messages that name an item numbered one of `numbers`. */
export async function loadChannelMentions(db: Db, channelHash: string, numbers: number[]): Promise<MentionRow[]> {
  if (!numbers.length) return [];
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.discord_mentions").select(COLS).where("channel_hash", "=", channelHash).where(kx.inList(db, "number", numbers, "bigint")), { label: "discord.loadChannelMentions" });
  return rows.map(rowOf);
}

/** Rows per item, unordered (callers sort by the opened time); an item with no rows is absent. */
export async function loadMentionsOfItems(db: Db, refs: Ref[]): Promise<Map<Ref, MentionRow[]>> {
  const q = queryDb(db);
  const out = new Map<Ref, MentionRow[]>();
  if (!refs.length) return out;
  const rows = await q.all(q.k.selectFrom("main.discord_mentions as m").select(COLS.map((c) => `m.${c}` as const)).where(kx.refIn(db, "m", refs)), { label: "discord.loadMentionsOfItems" });
  for (const r of rows) {
    const m = rowOf(r);
    const key = `${m.repo}#${m.number}`;
    const list = out.get(key);
    if (list) list.push(m); else out.set(key, [m]);
  }
  return out;
}

/** The item page and list read the same rows; counts and signal links derive from them. */
export async function loadItemDiscord(db: Db, refs: Ref[]): Promise<Map<Ref, MentionRow[]>> {
  return await loadMentionsOfItems(db, refs);
}

/** Mention and signal counts per item, in one grouped statement; an item with no rows is absent. */
export async function loadMentionCounts(db: Db, refs: Ref[]): Promise<Map<Ref, { count: number; signals: number }>> {
  const q = queryDb(db);
  const out = new Map<Ref, { count: number; signals: number }>();
  if (!refs.length) return out;
  const rows = await q.all(q.k.selectFrom("main.discord_mentions as m")
    .select((eb) => ["m.repo", "m.number", eb.fn.countAll<number>().as("n"), eb.fn.sum<number>("m.signal").as("s")])
    .where(kx.refIn(db, "m", refs)).groupBy(["m.repo", "m.number"]), { label: "discord.loadMentionCounts" });
  for (const r of rows) out.set(`${r.repo}#${r.number}`, { count: Number(r.n), signals: Number(r.s ?? 0) });
  return out;
}

/**
 * Deletes the named (message, item) rows, then inserts the rest multi-row, `ON CONFLICT DO NOTHING`, in one transaction. Idempotent: a lost race
 * between two events for one message converges on the later event's set. Returns the rows newly added.
 */
export async function saveMessageMentions(db: Db, changes: MentionChange[]): Promise<number> {
  const q = queryDb(db);
  const removed: [string, string, number][] = [];
  const added = new Map<string, { msg_hash: string; channel_hash: string; repo: string; number: number; sealed: string }>();
  for (const c of changes) {
    for (const r of c.remove) {
      const i = r.lastIndexOf("#");
      removed.push([c.msgHash, r.slice(0, i), Number(r.slice(i + 1))]);
    }
    for (const a of c.add) added.set(`${c.msgHash}\0${a.repo}\0${a.number}`, { msg_hash: c.msgHash, channel_hash: c.channelHash, repo: a.repo, number: a.number, sealed: a.sealed });
  }
  if (!removed.length && !added.size) return 0;
  return await db.write(async () => {
    for (const part of kx.chunks(removed)) await q.run(q.k.deleteFrom("main.discord_mentions").where(kx.tupleIn(db, ["msg_hash", "repo", "number"], part, TUPLE)));
    let n = 0;
    for (const part of kx.batches([...added.values()])) n += Number((await q.run(q.k.insertInto("main.discord_mentions").values(part).onConflict((oc) => oc.doNothing()))).changes);
    return n;
  });
}

/** Sets the signal flag; a row deleted meanwhile is simply not updated. Returns the rows changed. */
export async function setSignals(db: Db, rows: { msgHash: string; repo: string; number: number; signal: boolean }[]): Promise<number> {
  if (!rows.length) return 0;
  const set = [...new Map(rows.map((r) => [`${r.msgHash}\0${r.repo}\0${r.number}`, { msg_hash: r.msgHash, repo: r.repo, number: r.number, signal: r.signal ? 1 : 0 }])).values()];
  return await db.write(() => kx.updateFrom(db, "discord_mentions", ["msg_hash", "repo", "number"], set, ["signal"]));
}

/** Deletes the mention rows of messages. */
export async function removeMentionsOfMessages(db: Db, msgHashes: string[]): Promise<number> {
  const q = queryDb(db);
  let n = 0;
  for (const part of kx.chunks([...new Set(msgHashes)])) n += Number((await q.run(q.k.deleteFrom("main.discord_mentions").where(kx.inList(db, "msg_hash", part)))).changes);
  return n;
}

/** Deletes replies, mentions and follows of the channel hashes (a thread's follows by the thread too) in one transaction. */
export async function forgetChannels(db: Db, channelHashes: string[]): Promise<{ replies: number; mentions: number; follows: number }> {
  const hashes = [...new Set(channelHashes)];
  if (!hashes.length) return { replies: 0, mentions: 0, follows: 0 };
  const q = queryDb(db);
  return await db.write(async () => {
    let replies = 0, mentions = 0, follows = 0;
    for (const part of kx.chunks(hashes)) {
      replies += Number((await q.run(q.k.deleteFrom("main.discord_replies").where(kx.inList(db, "channel_hash", part)))).changes);
      mentions += Number((await q.run(q.k.deleteFrom("main.discord_mentions").where(kx.inList(db, "channel_hash", part)))).changes);
      follows += Number((await q.run(q.k.deleteFrom("main.discord_follows").where((eb) => eb.or([kx.inList(db, "target_hash", part), kx.inList(db, "channel_hash", part)])))).changes);
    }
    return { replies, mentions, follows };
  });
}

/** Every row, for the deletion request `forgetAuthor` (the author is sealed in the row); read on its own, never fused. */
export async function loadSealedMentions(db: Db): Promise<{ msgHash: string; repo: string; number: number; sealed: string }[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.discord_mentions").select(["msg_hash", "repo", "number", "sealed"]), { alone: true, label: "discord.loadSealedMentions" });
  return rows.map((r) => ({ msgHash: r.msg_hash, repo: r.repo, number: Number(r.number), sealed: r.sealed }));
}

/** Deletes rows by (message, item); 1 statement per 10,000 rows. */
export async function removeMentionRows(db: Db, rows: { msgHash: string; repo: string; number: number }[]): Promise<number> {
  const q = queryDb(db);
  let n = 0;
  for (const part of kx.chunks(rows.map((r): [string, string, number] => [r.msgHash, r.repo, r.number]))) {
    n += Number((await q.run(q.k.deleteFrom("main.discord_mentions").where(kx.tupleIn(db, ["msg_hash", "repo", "number"], part, TUPLE)))).changes);
  }
  return n;
}
