// The bot's replies to pings (`discord_replies`).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import type { ReplyRow } from "./types.ts";

/** Replies whose ping or quoted message is any of the hashes (`ping_hash` is the key, so each reply is once). */
export async function loadRepliesOf(db: Db, msgHashes: string[]): Promise<ReplyRow[]> {
  const hashes = [...new Set(msgHashes)];
  if (!hashes.length) return [];
  const q = queryDb(db);
  const out = new Map<string, ReplyRow>();
  for (const part of kx.chunks(hashes)) {
    const rows = await q.all(q.k.selectFrom("main.discord_replies").select(["ping_hash", "quoted_hash", "sealed"])
      .where((eb) => eb.or([kx.inList(db, "ping_hash", part), kx.inList(db, "quoted_hash", part)])), { label: "discord.loadRepliesOf" });
    for (const r of rows) out.set(r.ping_hash, { pingHash: r.ping_hash, quotedHash: r.quoted_hash, sealed: r.sealed });
  }
  return [...out.values()];
}

/** Which pings already have a reply. */
export async function loadReplyPings(db: Db, pingHashes: string[]): Promise<Set<string>> {
  const q = queryDb(db);
  const out = new Set<string>();
  for (const part of kx.chunks([...new Set(pingHashes)])) {
    for (const r of await q.all(q.k.selectFrom("main.discord_replies").select("ping_hash").where(kx.inList(db, "ping_hash", part)), { label: "discord.loadReplyPings" })) out.add(r.ping_hash);
  }
  return out;
}

/** Upserts replies by ping; a ping named twice takes its last row. */
export async function saveReplies(db: Db, rows: (ReplyRow & { channelHash: string })[]): Promise<void> {
  const q = queryDb(db);
  const unique = [...new Map(rows.map((r) => [r.pingHash, r])).values()];
  for (const part of kx.batches(unique)) {
    await q.run(q.k.insertInto("main.discord_replies").values(part.map((r) => ({ ping_hash: r.pingHash, quoted_hash: r.quotedHash, channel_hash: r.channelHash, sealed: r.sealed })))
      .onConflict((oc) => oc.column("ping_hash").doUpdateSet(kx.excluded(["quoted_hash", "channel_hash", "sealed"]))));
  }
}

/** Deletes the replies to pings. */
export async function removeReplies(db: Db, pingHashes: string[]): Promise<number> {
  const q = queryDb(db);
  let n = 0;
  for (const part of kx.chunks([...new Set(pingHashes)])) n += Number((await q.run(q.k.deleteFrom("main.discord_replies").where(kx.inList(db, "ping_hash", part)))).changes);
  return n;
}
